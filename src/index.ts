import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { ProxyRequest } from './types/openai.js';
import { registerAuthMiddleware } from './auth.js';
import { createSSEProxy } from './streaming.js';
import { traceRecorder } from './tracing.js';
import { getProviderForTenant } from './providers/registry.js';
import { applyAgentToRequest, handleMcpRoundTrip, injectRagContext } from './agent.js';
import { ConversationManagementService } from './application/services/ConversationManagementService.js';
import { PortalService } from './application/services/PortalService.js';
import { AdminService } from './application/services/AdminService.js';
import { UserManagementService } from './application/services/UserManagementService.js';
import { TenantManagementService } from './application/services/TenantManagementService.js';
import { DashboardService } from './application/services/DashboardService.js';
import { randomUUID } from 'node:crypto';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerRegistryRoutes } from './routes/registry.js';
import { registerBetaRoutes } from './routes/beta.js';
import { initOrm } from './orm.js';
import { EmbeddingAgentService } from './services/EmbeddingAgentService.js';

// Startup warning: check critical env vars
if (!process.env.ENCRYPTION_MASTER_KEY) {
  console.warn('⚠️  WARNING: ENCRYPTION_MASTER_KEY is not set. Trace recording will fail silently. Set this env var in .env before starting the gateway.');
}

if (!process.env.ADMIN_JWT_SECRET) {
  console.warn('⚠️  WARNING: ADMIN_JWT_SECRET is not set. Admin authentication will fail. Set this env var in .env before starting the gateway.');
}

if (!process.env.PORTAL_JWT_SECRET) {
  console.warn('⚠️  WARNING: PORTAL_JWT_SECRET is not set. Portal authentication will fail. Set this env var in .env.');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const start = async () => {
  try {
    const orm = await initOrm();
    const em = orm.em.fork();

    // Bootstrap system-embedder agent for all tenants if configured
    if (process.env.SYSTEM_EMBEDDER_PROVIDER && process.env.SYSTEM_EMBEDDER_MODEL) {
      const embeddingAgentService = new EmbeddingAgentService();
      await embeddingAgentService.bootstrapAllTenants(orm.em.fork());
      console.log('[startup] System embedder bootstrapped for all tenants');
    }

    const fastify = Fastify({
      logger: true
    });

    traceRecorder.init(em);

    const conversationSvc = new ConversationManagementService(em);
    const portalSvc = new PortalService(em);
    const adminSvc = new AdminService(em);
    const dashboardSvc = new DashboardService(em);
    const userMgmtSvc = new UserManagementService(em);
    const tenantMgmtSvc = new TenantManagementService(em);

    registerAuthMiddleware(fastify, em);

    // Allow requests from file:// origins and any localhost port (dev chat app, dashboard)
    fastify.register(fastifyCors, { origin: true });

    // Serve dashboard at /dashboard
    fastify.register(fastifyStatic, {
      root: join(__dirname, '../dashboard/dist'),
      prefix: '/dashboard',
      wildcard: false
    });

    // Serve portal at root (decorateReply: false — already decorated by dashboard plugin)
    fastify.register(fastifyStatic, {
      root: join(__dirname, '../portal/dist'),
      prefix: '/',
      decorateReply: false,
    });

    // SPA fallback for React Router
    fastify.setNotFoundHandler((request, reply) => {
      const url = request.url.split('?')[0];
      // Serve index.html for SPA routes, but NOT for static asset requests
      if (url.startsWith('/dashboard') && !url.startsWith('/dashboard/assets/')) {
        const indexHtml = readFileSync(join(__dirname, '../dashboard/dist/index.html'), 'utf-8');
        reply.header('Cache-Control', 'no-cache, no-store, must-revalidate').type('text/html').send(indexHtml);
      } else if (!url.startsWith('/v1/') && !url.startsWith('/dashboard') && !url.startsWith('/health') && !url.startsWith('/favicon.ico')) {
        // Portal SPA fallback
        try {
          const indexHtml = readFileSync(join(__dirname, '../portal/dist/index.html'), 'utf-8');
          reply.header('Cache-Control', 'no-cache, no-store, must-revalidate').type('text/html').send(indexHtml);
        } catch {
          reply.code(404).send({ error: 'Portal not built. Run: cd portal && npm run build' });
        }
      } else {
        reply.code(404).send({ error: 'Not Found' });
      }
    });

    fastify.get('/health', async (request, reply) => {
      return { status: 'ok' };
    });

    // Register dashboard API routes (/v1/traces, /v1/analytics/*)
    fastify.register((instance, opts, done) => {
      registerDashboardRoutes(instance, dashboardSvc).then(() => done()).catch(done);
    });

    // Register admin routes (/v1/admin/*)
    fastify.register((instance, opts, done) => {
      registerAdminRoutes(instance, adminSvc, em);
      done();
    });

    // Register portal routes (/v1/portal/*)
    fastify.register((instance, opts, done) => {
      registerPortalRoutes(instance, portalSvc, conversationSvc, userMgmtSvc, tenantMgmtSvc);
      done();
    });

    // Register registry routes (/v1/registry/*)
    fastify.register((instance, opts, done) => {
      registerRegistryRoutes(instance, orm);
      done();
    });

    // Register beta routes (/v1/beta/*)
    fastify.register((instance, opts, done) => {
      registerBetaRoutes(instance);
      done();
    });

    fastify.post('/v1/chat/completions', async (request, reply) => {
      const tenant = request.tenant;
      if (!tenant && !process.env.OPENAI_API_KEY) {
        return reply.code(500).send({
          error: {
            message: 'OPENAI_API_KEY not configured',
            type: 'server_error'
          }
        });
      }

      const provider = tenant
        ? await getProviderForTenant(tenant)
        : (() => { throw new Error('No tenant context'); })();

      const rawBody = request.body as any;

      // ── Conversation handling ────────────────────────────────────────────────
      const conversationExternalId: string | undefined = rawBody.conversation_id;
      const partitionExternalId: string | undefined = rawBody.partition_id;
      const cleanBody = { ...rawBody };
      delete cleanBody.conversation_id;
      delete cleanBody.partition_id;

      let conversationUUID: string | undefined;
      let partitionUUID: string | undefined;
      let resolvedConversationId: string | undefined;
      let historyMessages: any[] = [];
      let activeSnapshotId: string | null = null;

      if (tenant && tenant.agentConfig?.conversations_enabled) {
        if (partitionExternalId) {
          const partition = await conversationSvc.getOrCreatePartition(
            tenant.tenantId,
            partitionExternalId,
          );
          partitionUUID = partition.id;
        }

        resolvedConversationId = conversationExternalId ?? randomUUID();

        const conv = await conversationSvc.getOrCreateConversation(
          tenant.tenantId,
          partitionUUID ?? null,
          resolvedConversationId,
          tenant.agentId ?? null,
        );
        conversationUUID = conv.id;

        const ctx = await conversationSvc.loadContext(tenant.tenantId, conversationUUID);
        activeSnapshotId = ctx.latestSnapshotId;

        // Summarize if token budget exceeded
        if (ctx.tokenEstimate > (tenant.agentConfig.conversation_token_limit ?? 4000)) {
          const messagesText = ctx.messages
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n');
          const summaryModel =
            tenant.agentConfig.conversation_summary_model ?? cleanBody.model ?? 'gpt-4o-mini';
          try {
            const sumResponse = await provider.proxy({
              url: '/v1/chat/completions',
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: {
                model: summaryModel,
                messages: [
                  {
                    role: 'user',
                    content: `Summarize the following conversation concisely for context in future messages:\n\n${messagesText}`,
                  },
                ],
                stream: false,
              },
            });
            const summary = (sumResponse.body as any)?.choices?.[0]?.message?.content ?? '';
            if (summary) {
              const newSnapshotId = await conversationSvc.createSnapshot(
                tenant.tenantId,
                conversationUUID,
                summary,
                ctx.messages.length,
              );
              activeSnapshotId = newSnapshotId;
              // Reload context — messages are now archived; inject only the summary
              const freshCtx = await conversationSvc.loadContext(
                tenant.tenantId,
                conversationUUID,
              );
              historyMessages = conversationSvc.buildInjectionMessages(freshCtx);
            }
          } catch (sumErr) {
            fastify.log.error({ err: sumErr }, '[conversations] summarization failed; proceeding without summary');
            historyMessages = conversationSvc.buildInjectionMessages(ctx);
          }
        } else {
          historyMessages = conversationSvc.buildInjectionMessages(ctx);
        }
      }

      const bodyWithHistory =
        historyMessages.length > 0
          ? { ...cleanBody, messages: [...historyMessages, ...(cleanBody.messages ?? [])] }
          : cleanBody;

      // Inject RAG context if agent has a knowledgeBaseRef (before merge policies).
      let ragResult = {};
      let bodyWithRag = bodyWithHistory;
      if (tenant?.knowledgeBaseRef) {
        const ragOutput = await injectRagContext(bodyWithHistory, tenant, em);
        bodyWithRag = ragOutput.body;
        ragResult = ragOutput.ragResult;
      }

      // Apply agent merge policies (system prompt injection, skills merge) before forwarding.
      const effectiveBody = tenant ? applyAgentToRequest(bodyWithRag, tenant) : bodyWithRag;

      const proxyReq: ProxyRequest = {
        url: '/v1/chat/completions',
        method: 'POST',
        headers: request.headers as Record<string, string>,
        body: effectiveBody,
      };

      const startTimeMs = Date.now();

      try {
        const upstreamStartMs = Date.now();
        const response = await provider.proxy(proxyReq);

        // Forward upstream headers, but skip hop-by-hop and framing headers
        // so Fastify can properly serialize JSON object responses.
        const skipHeaders = new Set(['content-type', 'content-length', 'transfer-encoding', 'connection']);
        for (const [key, value] of Object.entries(response.headers)) {
          if (!skipHeaders.has(key.toLowerCase())) {
            reply.header(key, value);
          }
        }

        // Handle streaming response — pipe through SSE proxy for trace capture
        if (response.stream) {
          // For streaming, we need the original content-type (text/event-stream)
          if (response.headers['content-type']) {
            reply.header('content-type', response.headers['content-type']);
          }
          const sseProxy = createSSEProxy({
            onComplete: () => {},
            traceContext: tenant
              ? {
                  tenantId: tenant.tenantId,
                  agentId: tenant.agentId,
                  requestBody: effectiveBody,
                  model: effectiveBody?.model ?? 'unknown',
                  provider: provider.name,
                  statusCode: response.status,
                  startTimeMs,
                  upstreamStartMs,
                }
              : undefined,
          });
          reply.code(response.status);
          return reply.send((response.stream as unknown as NodeJS.ReadableStream).pipe(sseProxy));
        }

        // Handle regular JSON response

        // Detect upstream provider errors and return a friendly 200 with error details
        if (response.status >= 400) {
          const upstreamError = (response.body as any)?.error;
          const errorMessage = upstreamError?.message || `Provider returned HTTP ${response.status}`;
          const errorCode = upstreamError?.code || upstreamError?.type || 'provider_error';
          fastify.log.error(
            { provider: provider.name, status: response.status, upstreamError },
            `[provider] upstream error: ${errorMessage}`,
          );
          return reply.code(200).send({
            id: `error-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: effectiveBody?.model ?? 'unknown',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: `I'm sorry, I wasn't able to process your request. The model provider returned an error: ${errorMessage}`,
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            arachne_error: {
              upstream_status: response.status,
              code: errorCode,
              message: errorMessage,
            },
          });
        }

        if (tenant) {
          // MCP round-trip: if the response has tool_calls matching agent MCP endpoints,
          // call the MCP server and re-send to the provider (one round-trip only).
          let finalBody = response.body;
          try {
            const mcp = await handleMcpRoundTrip(effectiveBody, response.body, tenant, provider, proxyReq);
            finalBody = mcp.body;
          } catch (mcpErr) {
            fastify.log.error({ err: mcpErr }, '[mcp] round-trip failed; using original response');
          }

          const latencyMs = Date.now() - startTimeMs;
          const usage = (finalBody as any)?.usage;
          const r = ragResult as any;
          traceRecorder.record({
            tenantId: tenant.tenantId,
            agentId: tenant.agentId,
            model: effectiveBody?.model ?? 'unknown',
            provider: provider.name,
            requestBody: effectiveBody,
            responseBody: finalBody,
            latencyMs,
            statusCode: response.status,
            promptTokens: usage?.prompt_tokens,
            completionTokens: usage?.completion_tokens,
            totalTokens: usage?.total_tokens,
            ttfbMs: latencyMs,
            gatewayOverheadMs: upstreamStartMs - startTimeMs,
            knowledgeBaseId: r.knowledgeBaseId,
            ragRetrievalLatencyMs: r.ragRetrievalLatencyMs,
            embeddingLatencyMs: r.embeddingLatencyMs,
            vectorSearchLatencyMs: r.vectorSearchLatencyMs,
            retrievedChunkCount: r.retrievedChunkCount,
            topChunkSimilarity: r.topChunkSimilarity,
            avgChunkSimilarity: r.avgChunkSimilarity,
            ragStageFailed: r.ragStageFailed,
            fallbackToNoRag: r.fallbackToNoRag,
          });

          // Store conversation messages (fire-and-forget; do not block the response)
          if (conversationUUID) {
            const userMessages = (rawBody.messages ?? []).filter((m: any) => m.role === 'user');
            const userContent = userMessages
              .map((m: any) =>
                typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              )
              .join('\n');
            const assistantContent =
              (finalBody as any)?.choices?.[0]?.message?.content ?? '';
            conversationSvc
              .storeMessages(
                tenant.tenantId,
                conversationUUID,
                userContent,
                assistantContent,
                null,
                activeSnapshotId,
              )
              .catch((err) =>
                fastify.log.error({ err }, '[conversations] storeMessages failed'),
              );
          }

          const ragSources = r.sources?.length > 0 ? { rag_sources: r.sources } : {};
          const responseToSend =
            conversationUUID && resolvedConversationId
              ? {
                  ...(finalBody as any),
                  conversation_id: resolvedConversationId,
                  ...(partitionExternalId ? { partition_id: partitionExternalId } : {}),
                  ...ragSources,
                }
              : { ...(finalBody as any), ...ragSources };

          if (conversationUUID) {
            reply.header('X-Arachne-Conversation-ID', resolvedConversationId ?? '');
          }
          return reply.code(response.status).send(responseToSend);
        }
        return reply.code(response.status).send(response.body);
      } catch (err: any) {
        fastify.log.error(err);
        const errorMessage = err.message || 'Internal server error';
        return reply.code(200).send({
          id: `error-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: (effectiveBody as any)?.model ?? 'unknown',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: `I'm sorry, something went wrong processing your request. Please try again.`,
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          arachne_error: {
            upstream_status: 500,
            code: 'gateway_error',
            message: errorMessage,
          },
        });
      }
    });

    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({ port, host });
    console.log(`Server listening on ${host}:${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
