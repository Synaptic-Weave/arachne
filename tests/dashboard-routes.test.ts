/**
 * Dashboard routes integration tests
 *
 * Tests /v1/traces, /v1/analytics/summary, /v1/analytics/timeseries
 * via fastify.inject() with a mocked DashboardService.
 *
 * Auth middleware is bypassed by injecting request.tenant directly via
 * an addHook preHandler — the auth layer is tested separately in auth.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerDashboardRoutes } from '../src/routes/dashboard.js';
import { DashboardService } from '../src/application/services/DashboardService.js';

const TEST_TENANT_ID = 'tenant-uuid-dash-001';

// ── Mock service builder ──────────────────────────────────────────────────

function buildMockDashboardSvc(overrides: Partial<Record<keyof DashboardService, unknown>> = {}): DashboardService {
  return {
    getTraces: vi.fn().mockResolvedValue({ traces: [], nextCursor: null }),
    getAnalyticsSummary: vi.fn().mockResolvedValue({
      totalRequests: 0,
      totalTokens: 0,
      estimatedCostUSD: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
      errorRate: 0,
      avgOverheadMs: 0,
      avgTtfbMs: 0,
    }),
    getTimeseriesMetrics: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as DashboardService;
}

// ── Mock DashboardService constructor ──────────────────────────────────────

let _mockDashboardSvc: DashboardService;

vi.mock('../src/application/services/DashboardService.js', () => ({
  DashboardService: vi.fn().mockImplementation(() => _mockDashboardSvc),
}));

// ── App factory ───────────────────────────────────────────────────────────

async function buildApp(svc: DashboardService = buildMockDashboardSvc()): Promise<FastifyInstance> {
  _mockDashboardSvc = svc;
  const app = Fastify({ logger: false });

  // Per-request EM (simulated for tests)
  app.decorateRequest('em', null as any);
  app.addHook('onRequest', async (request) => {
    request.em = {} as any;
  });

  // Inject a synthetic tenant context — bypasses the real API-key auth middleware
  app.addHook('preHandler', async (request) => {
    (request as any).tenant = {
      tenantId: TEST_TENANT_ID,
      tenantName: 'Test Tenant',
    };
  });

  await registerDashboardRoutes(app);
  await app.ready();
  return app;
}

// ── GET /v1/traces ─────────────────────────────────────────────────────────

describe('GET /v1/traces', () => {
  let app: FastifyInstance;
  let svc: DashboardService;

  beforeEach(async () => {
    svc = buildMockDashboardSvc();
    app = await buildApp(svc);
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns traces with default limit (50) and no cursor', async () => {
    const mockTraces = [
      { id: 'trace-1', tenant_id: TEST_TENANT_ID, model: 'gpt-4o', provider: 'openai',
        status_code: 200, latency_ms: 120, prompt_tokens: 10, completion_tokens: 20,
        ttfb_ms: null, gateway_overhead_ms: null, created_at: new Date('2025-01-01T00:00:00Z') },
    ];
    (svc.getTraces as any).mockResolvedValue({ traces: mockTraces, nextCursor: null });

    const res = await app.inject({ method: 'GET', url: '/v1/traces' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ traces: any[]; nextCursor: string | null }>();
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0].id).toBe('trace-1');
    expect(body.nextCursor).toBeNull();
    expect(svc.getTraces).toHaveBeenCalledWith(TEST_TENANT_ID, 50, undefined);
  });

  it('passes cursor param to service when provided', async () => {
    const cursor = '2025-01-01T00:00:00.000Z';
    (svc.getTraces as any).mockResolvedValue({ traces: [], nextCursor: null });

    const res = await app.inject({ method: 'GET', url: `/v1/traces?cursor=${cursor}` });

    expect(res.statusCode).toBe(200);
    expect(svc.getTraces).toHaveBeenCalledWith(TEST_TENANT_ID, 50, cursor);
  });

  it('passes custom limit param to service', async () => {
    (svc.getTraces as any).mockResolvedValue({ traces: [], nextCursor: null });

    const res = await app.inject({ method: 'GET', url: '/v1/traces?limit=10' });

    expect(res.statusCode).toBe(200);
    expect(svc.getTraces).toHaveBeenCalledWith(TEST_TENANT_ID, 10, undefined);
  });

  it('caps limit at 200', async () => {
    (svc.getTraces as any).mockResolvedValue({ traces: [], nextCursor: null });

    await app.inject({ method: 'GET', url: '/v1/traces?limit=9999' });

    expect(svc.getTraces).toHaveBeenCalledWith(TEST_TENANT_ID, 200, undefined);
  });

  it('returns nextCursor from service when provided', async () => {
    const nextCursor = '2025-06-01T00:00:00.000Z';
    (svc.getTraces as any).mockResolvedValue({ traces: [], nextCursor });

    const res = await app.inject({ method: 'GET', url: '/v1/traces' });

    expect(res.json<{ nextCursor: string | null }>().nextCursor).toBe(nextCursor);
  });
});

// ── GET /v1/analytics/summary ──────────────────────────────────────────────

describe('GET /v1/analytics/summary', () => {
  let app: FastifyInstance;
  let svc: DashboardService;

  beforeEach(async () => {
    svc = buildMockDashboardSvc();
    app = await buildApp(svc);
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns analytics summary with default window (24h)', async () => {
    const mockSummary = {
      totalRequests: 100, totalTokens: 5000, estimatedCostUSD: 0.5,
      avgLatencyMs: 200, p95LatencyMs: 500, p99LatencyMs: 800,
      errorRate: 0.02, avgOverheadMs: 10, avgTtfbMs: 150,
    };
    (svc.getAnalyticsSummary as any).mockResolvedValue(mockSummary);

    const res = await app.inject({ method: 'GET', url: '/v1/analytics/summary' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalRequests: 100, avgLatencyMs: 200 });
    expect(svc.getAnalyticsSummary).toHaveBeenCalledWith(TEST_TENANT_ID, 24);
  });

  it('passes custom window param to service', async () => {
    (svc.getAnalyticsSummary as any).mockResolvedValue({ totalRequests: 0 });

    await app.inject({ method: 'GET', url: '/v1/analytics/summary?window=48' });

    expect(svc.getAnalyticsSummary).toHaveBeenCalledWith(TEST_TENANT_ID, 48);
  });
});

// ── GET /v1/analytics/timeseries ───────────────────────────────────────────

describe('GET /v1/analytics/timeseries', () => {
  let app: FastifyInstance;
  let svc: DashboardService;

  beforeEach(async () => {
    svc = buildMockDashboardSvc();
    app = await buildApp(svc);
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it('returns timeseries data with default params (window=24, bucket=60)', async () => {
    const mockBuckets = [
      { bucket: new Date('2025-01-01T00:00:00Z'), requests: 5, tokens: 200,
        costUSD: 0.01, avgLatencyMs: 150, errorRate: 0, avgOverheadMs: 5, avgTtfbMs: 80 },
    ];
    (svc.getTimeseriesMetrics as any).mockResolvedValue(mockBuckets);

    const res = await app.inject({ method: 'GET', url: '/v1/analytics/timeseries' });

    expect(res.statusCode).toBe(200);
    const body = res.json<any[]>();
    expect(body).toHaveLength(1);
    expect(body[0].requests).toBe(5);
    expect(svc.getTimeseriesMetrics).toHaveBeenCalledWith(TEST_TENANT_ID, 24, 60);
  });

  it('passes custom window and bucket params to service', async () => {
    (svc.getTimeseriesMetrics as any).mockResolvedValue([]);

    await app.inject({ method: 'GET', url: '/v1/analytics/timeseries?window=72&bucket=30' });

    expect(svc.getTimeseriesMetrics).toHaveBeenCalledWith(TEST_TENANT_ID, 72, 30);
  });

  it('returns empty array when no data', async () => {
    (svc.getTimeseriesMetrics as any).mockResolvedValue([]);

    const res = await app.inject({ method: 'GET', url: '/v1/analytics/timeseries' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
