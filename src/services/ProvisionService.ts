import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/core';
import { signJwt } from '../auth/jwtUtils.js';
import { REGISTRY_SCOPES } from '../auth/registryScopes.js';
import { RUNTIME_JWT_SECRET } from '../auth/secrets.js';
import { RegistryService } from './RegistryService.js';
import { Deployment } from '../domain/entities/Deployment.js';
import { Tenant } from '../domain/entities/Tenant.js';
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
