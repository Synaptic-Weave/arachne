/**
 * Analytics module unit tests
 *
 * Tests analytics query functions from src/analytics.ts.
 * Mocks the ORM module to provide a fake Knex instance (no real DB connections).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Build a mock Knex raw function we can control per-test
const mockRaw = vi.fn();

// Mock the ORM to provide a fake EntityManager with getKnex()
vi.mock('../src/orm.js', () => ({
  orm: {
    em: {
      getKnex: () => ({ raw: mockRaw }),
    },
  },
}));

import {
  getAnalyticsSummary,
  getTimeseriesMetrics,
  getModelBreakdown,
  getAdminAnalyticsSummary,
  getAdminTimeseriesMetrics,
  getAdminModelBreakdown,
} from '../src/analytics.js';

/** A fully-populated analytics summary row as the DB would return. */
const FULL_SUMMARY_ROW = {
  total_requests: 100,
  total_tokens: 5000,
  estimated_cost_usd: 0.05,
  avg_latency_ms: 250.0,
  p95_latency_ms: 500.0,
  p99_latency_ms: 800.0,
  error_rate: 0.02,
  avg_overhead_ms: 10.0,
  avg_ttfb_ms: 120.0,
};

/** A zero-valued summary row (no traffic). */
const ZERO_SUMMARY_ROW = {
  total_requests: 0,
  total_tokens: 0,
  estimated_cost_usd: 0,
  avg_latency_ms: 0,
  p95_latency_ms: 0,
  p99_latency_ms: 0,
  error_rate: 0,
  avg_overhead_ms: 0,
  avg_ttfb_ms: 0,
};

describe('getAnalyticsSummary', () => {
  beforeEach(() => mockRaw.mockReset());

  it('returns summary object with correct shape and values', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [FULL_SUMMARY_ROW] });

    const result = await getAnalyticsSummary('tenant-1', 24);

    expect(result.totalRequests).toBe(100);
    expect(result.totalTokens).toBe(5000);
    expect(result.estimatedCostUSD).toBe(0.05);
    expect(result.avgLatencyMs).toBe(250.0);
    expect(result.p95LatencyMs).toBe(500.0);
    expect(result.p99LatencyMs).toBe(800.0);
    expect(result.errorRate).toBe(0.02);
    expect(result.avgOverheadMs).toBe(10.0);
    expect(result.avgTtfbMs).toBe(120.0);
  });

  it('returns zeros when no traffic (empty result set values all zero)', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });

    const result = await getAnalyticsSummary('tenant-1');

    expect(result.totalRequests).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.estimatedCostUSD).toBe(0);
    expect(result.errorRate).toBe(0);
  });

  it('uses rollup CTE when rollup=true', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });

    await getAnalyticsSummary('tenant-1', 24, true);

    const calledSql = mockRaw.mock.calls[0][0] as string;
    expect(calledSql).toContain('subtenant_tree');
  });

  it('uses direct tenant filter when rollup=false (default)', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });

    await getAnalyticsSummary('tenant-1', 24, false);

    const calledSql = mockRaw.mock.calls[0][0] as string;
    expect(calledSql).not.toContain('subtenant_tree');
    // After placeholder conversion $1 becomes ?, so check for tenant_id = ?
    expect(calledSql).toContain('tenant_id = ?');
  });

  it('propagates query errors', async () => {
    mockRaw.mockRejectedValueOnce(new Error('DB down'));
    await expect(getAnalyticsSummary('tenant-1')).rejects.toThrow('DB down');
  });
});

describe('getTimeseriesMetrics', () => {
  beforeEach(() => mockRaw.mockReset());

  it('returns array of buckets with correct shape', async () => {
    const bucketDate = new Date('2024-01-01T00:00:00Z');
    mockRaw.mockResolvedValueOnce({
      rows: [{
        bucket: bucketDate,
        requests: 10,
        tokens: 500,
        cost_usd: 0.005,
        avg_latency_ms: 200,
        error_rate: 0.0,
        avg_overhead_ms: 5.0,
        avg_ttfb_ms: 90.0,
      }],
    });

    const result = await getTimeseriesMetrics('tenant-1', 24, 60);

    expect(result).toHaveLength(1);
    expect(result[0].bucket).toBeInstanceOf(Date);
    expect(result[0].requests).toBe(10);
    expect(result[0].tokens).toBe(500);
    expect(result[0].costUSD).toBe(0.005);
    expect(result[0].avgLatencyMs).toBe(200);
    expect(result[0].errorRate).toBe(0.0);
    expect(result[0].avgOverheadMs).toBe(5.0);
    expect(result[0].avgTtfbMs).toBe(90.0);
  });

  it('returns empty array when no traffic data', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [] });
    const result = await getTimeseriesMetrics('tenant-1');
    expect(result).toEqual([]);
  });

  it('uses rollup CTE when rollup=true', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [] });
    await getTimeseriesMetrics('tenant-1', 24, 60, true);
    const calledSql = mockRaw.mock.calls[0][0] as string;
    expect(calledSql).toContain('subtenant_tree');
  });

  it('returns multiple buckets in order', async () => {
    const d1 = new Date('2024-01-01T00:00:00Z');
    const d2 = new Date('2024-01-01T01:00:00Z');
    mockRaw.mockResolvedValueOnce({
      rows: [
        { bucket: d1, requests: 5, tokens: 100, cost_usd: 0.001, avg_latency_ms: 150, error_rate: 0, avg_overhead_ms: 3, avg_ttfb_ms: 60 },
        { bucket: d2, requests: 8, tokens: 200, cost_usd: 0.002, avg_latency_ms: 180, error_rate: 0, avg_overhead_ms: 4, avg_ttfb_ms: 70 },
      ],
    });

    const result = await getTimeseriesMetrics('tenant-1');
    expect(result).toHaveLength(2);
    expect(result[0].requests).toBe(5);
    expect(result[1].requests).toBe(8);
  });

  it('propagates query errors', async () => {
    mockRaw.mockRejectedValueOnce(new Error('timeseries query fail'));
    await expect(getTimeseriesMetrics('tenant-1')).rejects.toThrow('timeseries query fail');
  });
});

describe('getModelBreakdown', () => {
  beforeEach(() => mockRaw.mockReset());

  it('returns array of model usage with correct shape', async () => {
    mockRaw.mockResolvedValueOnce({
      rows: [{
        model: 'gpt-4o',
        requests: 75,
        error_rate: 0.01,
        avg_latency_ms: 300,
        total_tokens: 3000,
        estimated_cost_usd: 0.045,
      }],
    });

    const result = await getModelBreakdown('tenant-1', 24, 10);

    expect(result).toHaveLength(1);
    expect(result[0].model).toBe('gpt-4o');
    expect(result[0].requests).toBe(75);
    expect(result[0].errorRate).toBe(0.01);
    expect(result[0].avgLatencyMs).toBe(300);
    expect(result[0].totalTokens).toBe(3000);
    expect(result[0].estimatedCostUSD).toBe(0.045);
  });

  it('returns empty array when no model data', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [] });
    const result = await getModelBreakdown('tenant-1');
    expect(result).toEqual([]);
  });

  it('uses rollup CTE when rollup=true', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [] });
    await getModelBreakdown('tenant-1', 24, 10, true);
    const calledSql = mockRaw.mock.calls[0][0] as string;
    expect(calledSql).toContain('subtenant_tree');
  });

  it('returns multiple models sorted by request count', async () => {
    mockRaw.mockResolvedValueOnce({
      rows: [
        { model: 'gpt-4o', requests: 100, error_rate: 0, avg_latency_ms: 250, total_tokens: 5000, estimated_cost_usd: 0.05 },
        { model: 'gpt-3.5-turbo', requests: 40, error_rate: 0.05, avg_latency_ms: 100, total_tokens: 1000, estimated_cost_usd: 0.001 },
      ],
    });

    const result = await getModelBreakdown('tenant-1');
    expect(result).toHaveLength(2);
    expect(result[0].model).toBe('gpt-4o');
    expect(result[1].model).toBe('gpt-3.5-turbo');
  });

  it('propagates query errors', async () => {
    mockRaw.mockRejectedValueOnce(new Error('model query fail'));
    await expect(getModelBreakdown('tenant-1')).rejects.toThrow('model query fail');
  });
});

// ── Admin variants ──────────────────────────────────────────────────────────

describe('getAdminAnalyticsSummary', () => {
  beforeEach(() => mockRaw.mockReset());

  it('returns summary across all tenants', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [FULL_SUMMARY_ROW] });
    const result = await getAdminAnalyticsSummary(undefined, 24);
    expect(result.totalRequests).toBe(100);
    const calledSql = mockRaw.mock.calls[0][0] as string;
    expect(calledSql).not.toContain('tenant_id =');
  });

  it('filters to one tenant when tenantId provided', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });
    await getAdminAnalyticsSummary('tenant-abc', 24);
    const calledSql = mockRaw.mock.calls[0][0] as string;
    expect(calledSql).toContain('tenant_id');
  });

  it('propagates errors', async () => {
    mockRaw.mockRejectedValueOnce(new Error('admin summary fail'));
    await expect(getAdminAnalyticsSummary()).rejects.toThrow('admin summary fail');
  });
});

describe('getAdminTimeseriesMetrics', () => {
  beforeEach(() => mockRaw.mockReset());

  it('returns empty array when no data', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [] });
    const result = await getAdminTimeseriesMetrics(undefined, 24, 60);
    expect(result).toEqual([]);
  });

  it('returns buckets for all tenants', async () => {
    const d = new Date();
    mockRaw.mockResolvedValueOnce({
      rows: [{ bucket: d, requests: 20, tokens: 800, cost_usd: 0.01, avg_latency_ms: 200, error_rate: 0, avg_overhead_ms: 5, avg_ttfb_ms: 80 }],
    });
    const result = await getAdminTimeseriesMetrics();
    expect(result).toHaveLength(1);
    expect(result[0].requests).toBe(20);
  });

  it('propagates errors', async () => {
    mockRaw.mockRejectedValueOnce(new Error('admin ts fail'));
    await expect(getAdminTimeseriesMetrics()).rejects.toThrow('admin ts fail');
  });
});

describe('getAdminModelBreakdown', () => {
  beforeEach(() => mockRaw.mockReset());

  it('returns model breakdown across all tenants', async () => {
    mockRaw.mockResolvedValueOnce({
      rows: [{ model: 'gpt-4o', requests: 200, error_rate: 0.01, avg_latency_ms: 280, total_tokens: 10000, estimated_cost_usd: 0.1 }],
    });
    const result = await getAdminModelBreakdown(undefined, 24, 10);
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe('gpt-4o');
  });

  it('returns empty array when no data', async () => {
    mockRaw.mockResolvedValueOnce({ rows: [] });
    const result = await getAdminModelBreakdown();
    expect(result).toEqual([]);
  });

  it('propagates errors', async () => {
    mockRaw.mockRejectedValueOnce(new Error('admin model fail'));
    await expect(getAdminModelBreakdown()).rejects.toThrow('admin model fail');
  });
});
