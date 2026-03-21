/**
 * Unit tests for WeaveService, RegistryService, and ProvisionService.
 * Follows the pattern established in tests/application-services.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import type { EntityManager } from '@mikro-orm/core';
import { WeaveService } from '../src/services/WeaveService.js';
import { RegistryService } from '../src/services/RegistryService.js';
import { ProvisionService } from '../src/services/ProvisionService.js';
import { Artifact } from '../src/domain/entities/Artifact.js';
import { Tenant } from '../src/domain/entities/Tenant.js';
import { Deployment } from '../src/domain/entities/Deployment.js';
import { verifyJwt } from '../src/auth/jwtUtils.js';

// Mock node:fs/promises so parseSpec tests don't need real files on disk
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn() };
});

// ── Shared helpers ───────────────────────────────────────────────────────────

function buildMockEm(overrides: Partial<Record<string, unknown>> = {}): EntityManager {
  return {
    findOne: vi.fn().mockResolvedValue(null),
    findOneOrFail: vi.fn(),
    find: vi.fn().mockResolvedValue([]),
    persist: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    removeAndFlush: vi.fn().mockResolvedValue(undefined),
    persistAndFlush: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    remove: vi.fn(),
    ...overrides,
  } as unknown as EntityManager;
}

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return Object.assign(Object.create(Tenant.prototype) as Tenant, {
    id: 'tenant-1',
    name: 'Test Tenant',
    parentId: null,
    providerConfig: null,
    systemPrompt: null,
    skills: null,
    mcpEndpoints: null,
    status: 'active',
    availableModels: null,
    updatedAt: null,
    createdAt: new Date(),
    agents: [],
    members: [],
    invites: [],
    ...overrides,
  });
}

function makeArtifact(tenant: Tenant, overrides: Partial<Artifact> = {}): Artifact {
  return Object.assign(Object.create(Artifact.prototype) as Artifact, {
    id: 'artifact-1',
    tenant,
    org: 'test-org',
    name: 'my-kb',
    version: 'v1',
    kind: 'KnowledgeBase',
    sha256: 'deadbeef1234',
    bundleData: Buffer.alloc(0),
    vectorSpace: null,
    chunkCount: 5,
    metadata: {},
    createdAt: new Date(),
    chunks: [],
    deployments: [],
    tags: [],
    ...overrides,
  });
}

/**
 * Build a gzipped tar buffer from an array of files (for test bundles).
 */
function buildTestBundle(files: Array<{ path: string; data: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    header.write(file.path.slice(0, 99), 0, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(file.data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
    header.fill(0x20, 148, 156);
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i]!;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(header);
    const padded = Buffer.alloc(Math.ceil(file.data.length / 512) * 512);
    file.data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// ── WeaveService ─────────────────────────────────────────────────────────────

describe('WeaveService', () => {
  let svc: WeaveService;

  beforeEach(async () => {
    svc = new WeaveService();
    vi.clearAllMocks();
  });

  describe('parseSpec', () => {
    it('returns correct kind + metadata for a KnowledgeBase YAML', async () => {
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValue(`
apiVersion: arachne-ai.com/v0
kind: KnowledgeBase
metadata:
  name: my-docs
spec:
  docsPath: ./docs
` as unknown as Buffer);

      const spec = await svc.parseSpec('/fake/kb.yaml');
      expect(spec.kind).toBe('KnowledgeBase');
      expect(spec.metadata.name).toBe('my-docs');
      expect(spec.apiVersion).toBe('arachne-ai.com/v0');
    });

    it('returns correct kind + metadata for an Agent YAML', async () => {
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValue(`
apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: my-agent
spec:
  model: gpt-4
  systemPrompt: You are helpful.
` as unknown as Buffer);

      const spec = await svc.parseSpec('/fake/agent.yaml');
      expect(spec.kind).toBe('Agent');
      expect(spec.metadata.name).toBe('my-agent');
    });

    it('throws on unknown apiVersion', async () => {
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValue(`
apiVersion: unknown/v99
kind: KnowledgeBase
metadata:
  name: bad
spec:
  docsPath: ./docs
` as unknown as Buffer);

      await expect(svc.parseSpec('/fake/bad.yaml')).rejects.toThrow('Invalid apiVersion');
    });
  });

  describe('computePreprocessingHash', () => {
    it('returns a consistent 64-char hex string for the same config', () => {
      const config = { provider: 'openai', model: 'text-embedding-3-small', tokenSize: 512, overlap: 64 };
      const h1 = svc.computePreprocessingHash(config);
      const h2 = svc.computePreprocessingHash(config);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns different hashes for different configs', () => {
      const h1 = svc.computePreprocessingHash({ provider: 'openai', model: 'model-a', tokenSize: 512, overlap: 64 });
      const h2 = svc.computePreprocessingHash({ provider: 'openai', model: 'model-b', tokenSize: 512, overlap: 64 });
      expect(h1).not.toBe(h2);
    });
  });

  describe('chunkText', () => {
    it('respects tokenSize and overlap — produces multiple chunks for long text', () => {
      // 500 words × 5 chars ≈ 2500 chars; tokenSize=200 → charSize=800, step=720
      const text = 'hello '.repeat(500);
      const chunks = svc.chunkText(text, 200, 20);
      expect(chunks.length).toBeGreaterThan(1);
      // Each chunk should be within a char window (with word-boundary tolerance)
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(850);
      }
    });

    it('returns at least 1 chunk for non-empty text', () => {
      const chunks = svc.chunkText('Hello world, this is a test.', 512, 64);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('returns a single chunk when text fits within tokenSize', () => {
      const short = 'Short text that fits easily.';
      const chunks = svc.chunkText(short, 512, 64);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(short);
    });

    it('returns empty array for blank/empty text', () => {
      expect(svc.chunkText('', 512, 64)).toEqual([]);
      expect(svc.chunkText('   ', 512, 64)).toEqual([]);
    });
  });
});

// ── RegistryService ──────────────────────────────────────────────────────────

describe('RegistryService', () => {
  let svc: RegistryService;
  const tenantId = 'tenant-1';

  beforeEach(() => {
    svc = new RegistryService();
    vi.clearAllMocks();
  });

  describe('push', () => {
    it('stores artifact and returns artifactId + ref (sha256)', async () => {
      const tenant = makeTenant({ id: tenantId });
      const em = buildMockEm({
        findOne: vi.fn().mockResolvedValue(null),       // idempotency miss + _upsertTag miss
        findOneOrFail: vi.fn().mockResolvedValue(tenant),
      });

      const result = await svc.push(
        {
          tenantId,
          org: 'myorg',
          name: 'my-kb',
          tag: 'latest',
          kind: 'KnowledgeBase',
          bundleData: Buffer.from('bundle'),
          sha256: 'abc123sha256',
        },
        em,
      );

      expect(result.ref).toBe('myorg/my-kb:latest');
      expect(result.artifactId).toBeTruthy();
      expect(em.persist).toHaveBeenCalled();
      expect(em.flush).toHaveBeenCalled();
    });

    it('is idempotent — returns existing artifact when sha256 already exists', async () => {
      const tenant = makeTenant({ id: tenantId });
      const existingArtifact = makeArtifact(tenant, {
        id: 'existing-artifact-id',
        org: 'myorg',
        name: 'my-kb',
        sha256: 'abc123sha256',
        tenant,
      });

      const em = buildMockEm({
        findOne: vi.fn()
          .mockResolvedValueOnce(existingArtifact) // idempotency check hits
          .mockResolvedValueOnce(null),             // _upsertTag check
      });

      const result = await svc.push(
        {
          tenantId,
          org: 'myorg',
          name: 'my-kb',
          tag: 'latest',
          kind: 'KnowledgeBase',
          bundleData: Buffer.from('bundle'),
          sha256: 'abc123sha256',
        },
        em,
      );

      expect(result.artifactId).toBe('existing-artifact-id');
      expect(result.ref).toBe('myorg/my-kb:latest');
    });
  });

  describe('list', () => {
    it('queries artifacts by tenant and org, groups by name', async () => {
      const tenant = makeTenant({ id: tenantId });
      const artifact = makeArtifact(tenant, { tags: [{ tag: 'latest' } as any] });
      const em = buildMockEm({
        find: vi.fn().mockResolvedValue([artifact]),
      });

      const results = await svc.list(tenantId, 'test-org', em);

      expect(em.find).toHaveBeenCalledWith(
        expect.anything(),
        { tenant: tenantId, org: 'test-org' },
        expect.objectContaining({ populate: ['tags'] }),
      );
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('my-kb');
      expect(results[0].kind).toBe('KnowledgeBase');
    });

    it('returns empty array when no artifacts exist', async () => {
      const em = buildMockEm({ find: vi.fn().mockResolvedValue([]) });
      const results = await svc.list(tenantId, 'myorg', em);
      expect(results).toEqual([]);
    });
  });

  describe('resolve', () => {
    it('finds and returns artifact by org/name/tag', async () => {
      const tenant = makeTenant({ id: tenantId });
      const artifact = makeArtifact(tenant);
      const artifactTag = { tag: 'latest', artifact };
      const em = buildMockEm({
        findOne: vi.fn().mockResolvedValue(artifactTag),
      });

      const result = await svc.resolve(
        { org: 'test-org', name: 'my-kb', tag: 'latest' },
        tenantId,
        em,
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe('artifact-1');
    });

    it('returns null if artifact tag not found', async () => {
      const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(null) });

      const result = await svc.resolve(
        { org: 'test-org', name: 'missing', tag: 'latest' },
        tenantId,
        em,
      );

      expect(result).toBeNull();
    });
  });
});

// ── ProvisionService ─────────────────────────────────────────────────────────

describe('ProvisionService', () => {
  const tenantId = 'tenant-1';
  const RUNTIME_JWT_SECRET =
    process.env.RUNTIME_JWT_SECRET ??
    process.env.PORTAL_JWT_SECRET ??
    'unsafe-runtime-secret-change-in-production';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('deploy', () => {
    it('creates deployment record and mints a runtime JWT with expected claims', async () => {
      const tenant = makeTenant({ id: tenantId });
      const artifact = makeArtifact(tenant, { kind: 'Agent' });

      const mockRegistrySvc = {
        resolve: vi.fn().mockResolvedValue(artifact),
      } as unknown as RegistryService;
      const svc = new ProvisionService(mockRegistrySvc);

      const em = buildMockEm({
        findOneOrFail: vi.fn().mockResolvedValue(tenant),
      });

      const result = await svc.deploy(
        {
          tenantId,
          artifactRef: { org: 'myorg', name: 'my-agent', tag: 'latest' },
          environment: 'production',
          requestingUserId: 'user-1',
        },
        em,
      );

      expect(result.status).toBe('READY');
      expect(result.runtimeToken).toBeTruthy();

      const claims = verifyJwt<{
        tenantId: string;
        artifactId: string;
        deploymentId: string;
        scopes: string[];
      }>(result.runtimeToken!, RUNTIME_JWT_SECRET);

      expect(claims.tenantId).toBe(tenantId);
      expect(claims.artifactId).toBe(artifact.id);
      expect(claims.deploymentId).toBe(result.deploymentId);
      expect(claims.scopes).toContain('runtime:access');
    });

    it('returns FAILED (no deployment row) when artifact not found', async () => {
      const mockRegistrySvc = {
        resolve: vi.fn().mockResolvedValue(null),
      } as unknown as RegistryService;
      const svc = new ProvisionService(mockRegistrySvc);
      const em = buildMockEm();

      const result = await svc.deploy(
        {
          tenantId,
          artifactRef: { org: 'myorg', name: 'missing', tag: 'latest' },
          environment: 'production',
          requestingUserId: 'user-1',
        },
        em,
      );

      expect(result.status).toBe('FAILED');
      expect(result.errorMessage).toBe('Artifact not found');
    });

    it('extracts agent metadata from spec.json in bundle at deploy time', async () => {
      const tenant = makeTenant({ id: tenantId });
      const specJson = {
        apiVersion: 'arachne-ai.com/v0',
        kind: 'Agent',
        metadata: { name: 'test-agent' },
        spec: {
          model: 'gpt-4.1-mini',
          systemPrompt: 'You are a helpful assistant.',
          knowledgeBaseRef: 'my-kb',
          conversationsEnabled: true,
          conversationTokenLimit: 8000,
        },
      };
      const bundleData = buildTestBundle([
        { path: 'manifest.json', data: Buffer.from(JSON.stringify({ kind: 'Agent', name: 'test-agent' })) },
        { path: 'spec.json', data: Buffer.from(JSON.stringify(specJson)) },
      ]);
      const artifact = makeArtifact(tenant, { kind: 'Agent', bundleData, metadata: {} });

      const mockRegistrySvc = {
        resolve: vi.fn().mockResolvedValue(artifact),
      } as unknown as RegistryService;
      const svc = new ProvisionService(mockRegistrySvc);

      const em = buildMockEm({
        findOneOrFail: vi.fn().mockResolvedValue(tenant),
      });

      const result = await svc.deploy(
        {
          tenantId,
          artifactRef: { org: 'myorg', name: 'test-agent', tag: 'latest' },
          environment: 'production',
          requestingUserId: 'user-1',
        },
        em,
      );

      expect(result.status).toBe('READY');
      expect(artifact.metadata.systemPrompt).toBe('You are a helpful assistant.');
      expect(artifact.metadata.model).toBe('gpt-4.1-mini');
      expect(artifact.metadata.knowledgeBaseRef).toBe('my-kb');
      expect(artifact.metadata.conversations_enabled).toBe(true);
      expect(artifact.metadata.conversation_token_limit).toBe(8000);
    });

    it('extracts agent metadata from spec.yaml fallback', async () => {
      const tenant = makeTenant({ id: tenantId });
      const specYaml = `apiVersion: arachne-ai.com/v0
kind: Agent
metadata:
  name: yaml-agent
spec:
  model: gpt-4.1-mini
  systemPrompt: |
    You are a YAML-based assistant.
  knowledgeBaseRef: my-kb
`;
      const bundleData = buildTestBundle([
        { path: 'manifest.json', data: Buffer.from(JSON.stringify({ kind: 'Agent', name: 'yaml-agent' })) },
        { path: 'spec.yaml', data: Buffer.from(specYaml) },
      ]);
      const artifact = makeArtifact(tenant, { kind: 'Agent', bundleData, metadata: {} });

      const mockRegistrySvc = {
        resolve: vi.fn().mockResolvedValue(artifact),
      } as unknown as RegistryService;
      const svc = new ProvisionService(mockRegistrySvc);

      const em = buildMockEm({
        findOneOrFail: vi.fn().mockResolvedValue(tenant),
      });

      const result = await svc.deploy(
        {
          tenantId,
          artifactRef: { org: 'myorg', name: 'yaml-agent', tag: 'latest' },
          environment: 'production',
          requestingUserId: 'user-1',
        },
        em,
      );

      expect(result.status).toBe('READY');
      expect(artifact.metadata.systemPrompt).toBe('You are a YAML-based assistant.');
      expect(artifact.metadata.model).toBe('gpt-4.1-mini');
      expect(artifact.metadata.knowledgeBaseRef).toBe('my-kb');
    });

    it('skips metadata extraction for KnowledgeBase artifacts', async () => {
      const tenant = makeTenant({ id: tenantId });
      const artifact = makeArtifact(tenant, { kind: 'KnowledgeBase', metadata: {} });

      const mockRegistrySvc = {
        resolve: vi.fn().mockResolvedValue(artifact),
      } as unknown as RegistryService;
      const svc = new ProvisionService(mockRegistrySvc);

      const em = buildMockEm({
        findOneOrFail: vi.fn().mockResolvedValue(tenant),
        count: vi.fn().mockResolvedValue(5),
      });

      await svc.deploy(
        {
          tenantId,
          artifactRef: { org: 'myorg', name: 'my-kb', tag: 'latest' },
          environment: 'production',
          requestingUserId: 'user-1',
        },
        em,
      );

      expect(Object.keys(artifact.metadata)).toHaveLength(0);
    });

    it('deploy succeeds even if bundle extraction fails', async () => {
      const tenant = makeTenant({ id: tenantId });
      const artifact = makeArtifact(tenant, {
        kind: 'Agent',
        bundleData: Buffer.from('not-a-valid-gzip-bundle'),
        metadata: {},
      });

      const mockRegistrySvc = {
        resolve: vi.fn().mockResolvedValue(artifact),
      } as unknown as RegistryService;
      const svc = new ProvisionService(mockRegistrySvc);

      const em = buildMockEm({
        findOneOrFail: vi.fn().mockResolvedValue(tenant),
      });

      const result = await svc.deploy(
        {
          tenantId,
          artifactRef: { org: 'myorg', name: 'bad-agent', tag: 'latest' },
          environment: 'production',
          requestingUserId: 'user-1',
        },
        em,
      );

      expect(result.status).toBe('READY');
      expect(Object.keys(artifact.metadata)).toHaveLength(0);
    });

    it('returns FAILED when KnowledgeBase artifact has 0 chunks', async () => {
      const tenant = makeTenant({ id: tenantId });
      const artifact = makeArtifact(tenant, { kind: 'KnowledgeBase' });

      const mockRegistrySvc = {
        resolve: vi.fn().mockResolvedValue(artifact),
      } as unknown as RegistryService;
      const svc = new ProvisionService(mockRegistrySvc);

      const em = buildMockEm({
        findOneOrFail: vi.fn().mockResolvedValue(tenant),
        count: vi.fn().mockResolvedValue(0),
      });

      const result = await svc.deploy(
        {
          tenantId,
          artifactRef: { org: 'myorg', name: 'my-kb', tag: 'latest' },
          environment: 'production',
          requestingUserId: 'user-1',
        },
        em,
      );

      expect(result.status).toBe('FAILED');
      expect(result.errorMessage).toContain('no chunks');
    });
  });

  describe('listDeployments', () => {
    it('returns deployments for the given tenant', async () => {
      const svc = new ProvisionService({} as unknown as RegistryService);
      const tenant = makeTenant({ id: tenantId });
      const artifact = makeArtifact(tenant);
      const deployment = new Deployment(tenant, artifact, 'production');
      const em = buildMockEm({
        find: vi.fn().mockResolvedValue([deployment]),
      });

      const results = await svc.listDeployments(tenantId, em);

      expect(results).toHaveLength(1);
      expect(em.find).toHaveBeenCalledWith(
        expect.anything(),
        { tenant: tenantId },
        expect.objectContaining({ populate: ['artifact'] }),
      );
    });

    it('returns empty array when no deployments exist', async () => {
      const svc = new ProvisionService({} as unknown as RegistryService);
      const em = buildMockEm({ find: vi.fn().mockResolvedValue([]) });

      const results = await svc.listDeployments(tenantId, em);
      expect(results).toEqual([]);
    });
  });

  describe('rotateToken', () => {
    it('generates a new JWT, updates deployment, and returns it', async () => {
      const svc = new ProvisionService({} as unknown as RegistryService);
      const tenant = makeTenant({ id: tenantId });
      const artifact = makeArtifact(tenant);
      const deployment = new Deployment(tenant, artifact, 'production');
      deployment.markReady('old-runtime-token');
      const oldToken = deployment.runtimeToken;

      const em = buildMockEm({
        findOne: vi.fn().mockResolvedValue(deployment),
      });

      const result = await svc.rotateToken(deployment.id, tenantId, em);

      expect(result).not.toBeNull();
      expect(result!.runtimeToken).toBeTruthy();
      expect(result!.runtimeToken).not.toBe(oldToken);
      expect(deployment.runtimeToken).toBe(result!.runtimeToken);
      expect(em.flush).toHaveBeenCalled();

      // Verify the new token has the correct claims
      const claims = verifyJwt<{
        tenantId: string;
        artifactId: string;
        deploymentId: string;
        scopes: string[];
      }>(result!.runtimeToken, RUNTIME_JWT_SECRET);

      expect(claims.tenantId).toBe(tenantId);
      expect(claims.artifactId).toBe(artifact.id);
      expect(claims.deploymentId).toBe(deployment.id);
      expect(claims.scopes).toContain('runtime:access');
    });

    it('returns null when deployment is not found', async () => {
      const svc = new ProvisionService({} as unknown as RegistryService);
      const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(null) });

      const result = await svc.rotateToken('nonexistent-id', tenantId, em);
      expect(result).toBeNull();
    });

    it('returns null when deployment is not in READY state', async () => {
      const svc = new ProvisionService({} as unknown as RegistryService);
      const tenant = makeTenant({ id: tenantId });
      const artifact = makeArtifact(tenant);
      const deployment = new Deployment(tenant, artifact, 'production');
      deployment.markFailed('some error');

      const em = buildMockEm({
        findOne: vi.fn().mockResolvedValue(deployment),
      });

      const result = await svc.rotateToken(deployment.id, tenantId, em);
      expect(result).toBeNull();
    });
  });

  describe('unprovision', () => {
    it('marks deployment failed, clears runtime token, returns true', async () => {
      const svc = new ProvisionService({} as unknown as RegistryService);
      const tenant = makeTenant({ id: tenantId });
      const artifact = makeArtifact(tenant);
      const deployment = new Deployment(tenant, artifact, 'production');
      deployment.runtimeToken = 'old-token';

      const em = buildMockEm({
        findOne: vi.fn().mockResolvedValue(deployment),
      });

      const ok = await svc.unprovision(deployment.id, tenantId, em);

      expect(ok).toBe(true);
      expect(deployment.runtimeToken).toBeNull();
      expect(em.flush).toHaveBeenCalled();
    });

    it('returns false when deployment not found', async () => {
      const svc = new ProvisionService({} as unknown as RegistryService);
      const em = buildMockEm({ findOne: vi.fn().mockResolvedValue(null) });

      const ok = await svc.unprovision('nonexistent-id', tenantId, em);
      expect(ok).toBe(false);
    });
  });
});
