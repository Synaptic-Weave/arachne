import { createHash } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { registryAuth } from '../middleware/registryAuth.js';
import { RegistryService } from '../services/RegistryService.js';
import { ProvisionService } from '../services/ProvisionService.js';
import { Tenant } from '../domain/entities/Tenant.js';

const REGISTRY_JWT_SECRET =
  process.env.REGISTRY_JWT_SECRET ??
  process.env.PORTAL_JWT_SECRET ??
  'unsafe-registry-secret-change-in-production';

export function registerRegistryRoutes(fastify: FastifyInstance): void {
  fastify.register(multipart);

  const registryService = new RegistryService();
  const provisionService = new ProvisionService(registryService);

  // ── POST /v1/registry/push ─────────────────────────────────────────────────
  fastify.post('/v1/registry/push', {
    preHandler: registryAuth('registry:push', REGISTRY_JWT_SECRET),
  }, async (request, reply) => {
    const parts = request.parts();

    let bundleBuffer: Buffer | null = null;
    let name: string | undefined;
    let tag = 'latest';
    let kind: string | undefined;
    let sha256Provided: string | undefined;
    let chunkCount: number | undefined;

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'bundle') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        bundleBuffer = Buffer.concat(chunks);
      } else if (part.type === 'field') {
        switch (part.fieldname) {
          case 'name':        name = part.value as string; break;
          case 'tag':         tag = (part.value as string) || 'latest'; break;
          case 'kind':        kind = part.value as string; break;
          case 'sha256':      sha256Provided = part.value as string; break;
          case 'chunkCount':  chunkCount = parseInt(part.value as string, 10) || undefined; break;
        }
      }
    }

    if (!bundleBuffer) return reply.code(400).send({ error: 'Missing bundle file' });
    if (!name)         return reply.code(400).send({ error: 'Missing name field' });
    if (!kind)         return reply.code(400).send({ error: 'Missing kind field' });

    // Compute sha256 from bundle data
    const computedSha256 = createHash('sha256').update(bundleBuffer).digest('hex');

    if (sha256Provided && sha256Provided !== computedSha256) {
      return reply.code(400).send({ error: 'sha256 mismatch', expected: sha256Provided, computed: computedSha256 });
    }

    const registryUser = (request as any).registryUser;
    const em = request.em;

    // Validate JWT orgSlug matches tenant in DB
    const tenant = await em.findOne(Tenant, { id: registryUser.tenantId });
    if (!tenant || tenant.orgSlug !== registryUser.orgSlug) {
      return reply.code(403).send({ error: 'Token orgSlug does not match tenant. Please re-login.' });
    }

    const result = await registryService.push(
      {
        tenantId: registryUser.tenantId,
        org: tenant.orgSlug,
        name,
        tag,
        kind,
        bundleData: bundleBuffer,
        sha256: computedSha256,
        chunkCount,
      },
      em,
    );

    return reply.code(201).send(result);
  });

  // ── GET /v1/registry/list ──────────────────────────────────────────────────
  fastify.get<{ Querystring: { org?: string } }>('/v1/registry/list', {
    preHandler: registryAuth('artifact:read', REGISTRY_JWT_SECRET),
  }, async (request, reply) => {
    const registryUser = (request as any).registryUser;
    const org = (request.query as any).org ?? registryUser.orgSlug;
    // orgSlug guaranteed non-null by registryAuth middleware
    const em = request.em;

    const artifacts = await registryService.list(registryUser.tenantId, org, em);
    return reply.send(artifacts);
  });

  // ── GET /v1/registry/pull/:org/:name/:tag ──────────────────────────────────
  fastify.get<{ Params: { org: string; name: string; tag: string } }>(
    '/v1/registry/pull/:org/:name/:tag',
    { preHandler: registryAuth('artifact:read', REGISTRY_JWT_SECRET) },
    async (request, reply) => {
      const registryUser = (request as any).registryUser;
      const { org, name, tag } = request.params;
      const em = request.em;

      const buffer = await registryService.pull({ org, name, tag }, registryUser.tenantId, em);

      if (!buffer) {
        return reply.code(404).send({ error: 'Artifact not found' });
      }

      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${name}-${tag}.orb"`)
        .send(buffer);
    },
  );

  // ── DELETE /v1/registry/:org/:name/:tag ────────────────────────────────────
  fastify.delete<{ Params: { org: string; name: string; tag: string } }>(
    '/v1/registry/:org/:name/:tag',
    { preHandler: registryAuth('registry:push', REGISTRY_JWT_SECRET) },
    async (request, reply) => {
      const registryUser = (request as any).registryUser;
      const { org, name, tag } = request.params;
      const em = request.em;

      const deleted = await registryService.delete({ org, name, tag }, registryUser.tenantId, em);

      if (!deleted) {
        return reply.code(404).send({ error: 'Artifact not found' });
      }

      return reply.send({ deleted: true });
    },
  );

  // ── POST /v1/registry/deployments/:org/:name/:tag ──────────────────────────
  fastify.post<{
    Params: { org: string; name: string; tag: string };
    Querystring: { environment?: string; name?: string };
  }>('/v1/registry/deployments/:org/:name/:tag', {
    preHandler: registryAuth('deploy:write', REGISTRY_JWT_SECRET),
  }, async (request, reply) => {
    const registryUser = (request as any).registryUser;
    const { org, name, tag } = request.params;
    const { environment, name: deploymentName } = request.query;

    const em = request.em;

    const result = await provisionService.deploy(
      {
        tenantId: registryUser.tenantId,
        artifactRef: { org, name, tag },
        environment: environment ?? 'production',
        requestingUserId: registryUser.sub ?? registryUser.tenantId,
        name: deploymentName,
      },
      em,
    );

    return reply.code(result.status === 'READY' ? 201 : 200).send(result);
  });

  // ── GET /v1/registry/deployments ──────────────────────────────────────────
  fastify.get('/v1/registry/deployments', {
    preHandler: registryAuth('artifact:read', REGISTRY_JWT_SECRET),
  }, async (request, reply) => {
    const registryUser = (request as any).registryUser;
    const em = request.em;

    const deployments = await provisionService.listDeployments(registryUser.tenantId, em);
    return reply.send(deployments);
  });

  // ── GET /v1/registry/deployments/by-name/:name ───────────────────────
  fastify.get<{ Params: { name: string } }>(
    '/v1/registry/deployments/by-name/:name',
    { preHandler: registryAuth('artifact:read', REGISTRY_JWT_SECRET) },
    async (request, reply) => {
      const registryUser = (request as any).registryUser;
      const { name } = request.params;
      const em = request.em;

      const deployment = await provisionService.findByName(name, registryUser.tenantId, em);

      if (!deployment) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      return reply.send(deployment);
    },
  );

  // ── POST /v1/registry/deployments/:id/rotate-token ───────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/v1/registry/deployments/:id/rotate-token',
    { preHandler: registryAuth('deploy:write', REGISTRY_JWT_SECRET) },
    async (request, reply) => {
      const registryUser = (request as any).registryUser;
      const { id } = request.params;
      const em = request.em;

      const result = await provisionService.rotateToken(id, registryUser.tenantId, em);

      if (!result) {
        return reply.code(404).send({ error: 'Deployment not found or not in READY state' });
      }

      return reply.send(result);
    },
  );

  // ── DELETE /v1/registry/deployments/:id ───────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/v1/registry/deployments/:id',
    { preHandler: registryAuth('deploy:write', REGISTRY_JWT_SECRET) },
    async (request, reply) => {
      const registryUser = (request as any).registryUser;
      const { id } = request.params;
      const em = request.em;

      const success = await provisionService.unprovision(id, registryUser.tenantId, em);

      if (!success) {
        return reply.code(404).send({ error: 'Deployment not found' });
      }

      return reply.send({ success: true });
    },
  );
}
