import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { EntityManager } from '@mikro-orm/core';
import { signJwt } from '../auth/jwtUtils.js';
import { REGISTRY_SCOPES } from '../auth/registryScopes.js';
import { RUNTIME_JWT_SECRET } from '../auth/secrets.js';
import { RegistryService } from './RegistryService.js';
import { extractFileFromTar } from '../lib/tar.js';
import { parseSimpleYaml } from '../lib/yaml.js';
import { Deployment } from '../domain/entities/Deployment.js';
import { Tenant } from '../domain/entities/Tenant.js';
import { Artifact } from '../domain/entities/Artifact.js';
import { KbChunk } from '../domain/entities/KbChunk.js';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface DeployInput {
  tenantId: string;
  artifactRef: { org: string; name: string; tag: string };
  environment: string;    // default: 'production'
  requestingUserId: string;
  name?: string;
}

export interface DeployResult {
  deploymentId: string;
  name?: string;
  status: 'READY' | 'FAILED';
  runtimeToken?: string;  // scoped JWT for runtime access (READY only)
  errorMessage?: string;
}

export class ProvisionService {
  constructor(
    private readonly registryService: RegistryService = new RegistryService(),
  ) {}

  async deploy(input: DeployInput, em: EntityManager): Promise<DeployResult> {
    // 1. Resolve the artifact via RegistryService
    const artifact = await this.registryService.resolve(
      input.artifactRef,
      input.tenantId,
      em,
    );

    // 2. Artifact not found → early FAILED (no deployment row created)
    if (!artifact) {
      return {
        deploymentId: randomUUID(),
        status: 'FAILED',
        errorMessage: 'Artifact not found',
      };
    }

    // 2b. Hydrate artifact metadata from bundle if not already populated
    if (
      (artifact.kind === 'Agent' || artifact.kind === 'EmbeddingAgent') &&
      Object.keys(artifact.metadata ?? {}).length === 0
    ) {
      try {
        const extracted = extractAgentMetadata(artifact);
        if (extracted) {
          artifact.metadata = extracted;
          // flush later with the deployment persist
        }
      } catch (err) {
        console.warn('[provision] failed to extract metadata from bundle:', err);
      }
    }

    // 3. Create Deployment entity with status PENDING
    const tenant = await em.findOneOrFail(Tenant, { id: input.tenantId });
    const deployment = new Deployment(
      tenant,
      artifact,
      input.environment ?? 'production',
      input.name,
    );
    em.persist(deployment);
    await em.flush();

    // 4. Validate KB readiness: KnowledgeBase artifacts must have chunks loaded
    if (artifact.kind === 'KnowledgeBase') {
      const chunkCount = await em.count(KbChunk, { artifact: artifact.id });
      if (chunkCount === 0) {
        deployment.markFailed('Knowledge base has no chunks loaded');
        await em.flush();
        return {
          deploymentId: deployment.id,
          name: deployment.name,
          status: 'FAILED',
          errorMessage: deployment.errorMessage!,
        };
      }
    }

    // 5. Mint scoped runtime token (1-year expiry)
    const runtimeToken = signJwt(
      {
        tenantId: input.tenantId,
        artifactId: artifact.id,
        deploymentId: deployment.id,
        scopes: [REGISTRY_SCOPES.RUNTIME_ACCESS],
      },
      RUNTIME_JWT_SECRET,
      ONE_YEAR_MS,
    );

    // 6. Mark Deployment READY
    deployment.markReady(runtimeToken);
    await em.flush();

    // 7. Return success result
    return {
      deploymentId: deployment.id,
      name: deployment.name,
      status: 'READY',
      runtimeToken,
    };
  }

  async unprovision(
    deploymentId: string,
    tenantId: string,
    em: EntityManager,
  ): Promise<boolean> {
    const deployment = await em.findOne(Deployment, {
      id: deploymentId,
      tenant: tenantId,
    });

    if (!deployment) return false;

    deployment.markFailed('Unprovisioned');
    deployment.runtimeToken = null;
    await em.flush();
    return true;
  }

  async getDeployment(
    deploymentId: string,
    tenantId: string,
    em: EntityManager,
  ): Promise<Deployment | null> {
    return em.findOne(Deployment, { id: deploymentId, tenant: tenantId });
  }

  async findByName(
    name: string,
    tenantId: string,
    em: EntityManager,
  ): Promise<Deployment | null> {
    return em.findOne(
      Deployment,
      { name, tenant: tenantId },
      { populate: ['artifact'] },
    );
  }

  async listDeployments(
    tenantId: string,
    em: EntityManager,
  ): Promise<Deployment[]> {
    return em.find(
      Deployment,
      { tenant: tenantId },
      { populate: ['artifact'], orderBy: { createdAt: 'DESC' } },
    );
  }
}

// ---------------------------------------------------------------------------
// Bundle metadata extraction
// ---------------------------------------------------------------------------

/**
 * Extract agent metadata from the artifact's .orb bundle.
 *
 * Tries `spec.json` first (server-side WeaveService format), then falls back
 * to `spec.yaml` (CLI weave format). Returns null if neither is found or
 * the spec doesn't contain relevant metadata.
 */
export function extractAgentMetadata(
  artifact: Artifact,
): Record<string, unknown> | null {
  if (!artifact.bundleData || artifact.bundleData.length === 0) return null;

  // Cap decompressed size at 50 MB to prevent OOM from crafted bundles
  const MAX_DECOMPRESSED_SIZE = 50 * 1024 * 1024;
  const tarBuf = gunzipSync(artifact.bundleData, { maxOutputLength: MAX_DECOMPRESSED_SIZE });

  // Try spec.json first (structured JSON from server-side weave)
  const specJsonBuf = extractFileFromTar(tarBuf, 'spec.json');
  if (specJsonBuf) {
    const parsed = JSON.parse(specJsonBuf.toString('utf8'));
    const spec = parsed.spec ?? parsed;
    return buildMetadata(spec);
  }

  // Fall back to spec.yaml (CLI weave format)
  const specYamlBuf = extractFileFromTar(tarBuf, 'spec.yaml');
  if (specYamlBuf) {
    const parsed = parseSimpleYaml(specYamlBuf.toString('utf8'));
    const spec = (parsed.spec ?? parsed) as Record<string, unknown>;

    // parseSimpleYaml can't handle YAML block scalars (|), so extract
    // systemPrompt via targeted regex if the parser only captured "|"
    if (spec.systemPrompt === '|' || spec.systemPrompt === undefined) {
      const yamlText = specYamlBuf.toString('utf8');
      const blockPrompt = extractYamlBlockScalar(yamlText, 'systemPrompt');
      if (blockPrompt) {
        spec.systemPrompt = blockPrompt;
      }
    }

    return buildMetadata(spec);
  }

  return null;
}

function buildMetadata(spec: Record<string, unknown>): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};

  if (spec.systemPrompt != null) meta.systemPrompt = spec.systemPrompt;
  if (spec.model != null) meta.model = spec.model;
  if (spec.knowledgeBaseRef != null) meta.knowledgeBaseRef = spec.knowledgeBaseRef;
  if (spec.conversationsEnabled != null) meta.conversations_enabled = spec.conversationsEnabled;
  if (spec.conversations_enabled != null) meta.conversations_enabled = spec.conversations_enabled;
  if (spec.conversationTokenLimit != null) meta.conversation_token_limit = spec.conversationTokenLimit;
  if (spec.conversation_token_limit != null) meta.conversation_token_limit = spec.conversation_token_limit;
  if (spec.temperature != null) meta.temperature = spec.temperature;
  if (spec.maxTokens != null) meta.maxTokens = spec.maxTokens;

  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Extract a YAML block scalar value (lines after `key: |` that are indented
 * deeper than the key). Returns null if not found.
 */
function extractYamlBlockScalar(yaml: string, key: string): string | null {
  const lines = yaml.split(/\r?\n/);
  const pattern = new RegExp(`^(\\s*)${key}:\\s*\\|\\s*$`);
  let collecting = false;
  let baseIndent = 0;
  const collected: string[] = [];

  for (const line of lines) {
    if (!collecting) {
      const match = line.match(pattern);
      if (match) {
        collecting = true;
        baseIndent = match[1].length;
      }
      continue;
    }

    // Empty lines are preserved in block scalars
    if (line.trim() === '') {
      collected.push('');
      continue;
    }

    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= baseIndent) break; // Dedented: end of block

    collected.push(line);
  }

  if (collected.length === 0) return null;

  // Strip common indentation (preserve relative indentation within block)
  let minIndent = Infinity;
  for (const line of collected) {
    if (line === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent < minIndent) minIndent = indent;
  }
  if (!isFinite(minIndent)) minIndent = 0;

  const normalized = collected.map((line) =>
    line === '' ? '' : line.slice(minIndent),
  );

  // Trim trailing empty lines
  while (normalized.length > 0 && normalized[normalized.length - 1] === '') {
    normalized.pop();
  }

  return normalized.join('\n');
}
