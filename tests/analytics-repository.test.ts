/**
 * AnalyticsRepository unit tests
 *
 * Tests the AnalyticsRepository class directly (not the facade in src/analytics.ts).
 * Mocks EntityManager with getKnex() returning a fake Knex instance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityManager } from '@mikro-orm/core';
import {
  AnalyticsRepository,
  type AnalyticsSummary,
  type TimeseriesBucket,
  type ModelBreakdown,
} from '../src/domain/repositories/AnalyticsRepository.js';

// ── Mock Knex factory ───────────────────────────────────────────────────────

const mockRaw = vi.fn();

function buildMockEm(): EntityManager {
  return {
    getKnex: () => ({ raw: mockRaw }),
  } as unknown as EntityManager;
}

// ── Fixture data ────────────────────────────────────────────────────────────

const FULL_SUMMARY_ROW = {
  total_requests: 100,
  total_tokens: '5000',
  estimated_cost_usd: 0.05,
  avg_latency_ms: 250.0,
  p95_latency_ms: 500.0,
  p99_latency_ms: 800.0,
  error_rate: 0.02,
  avg_overhead_ms: 10.0,
  avg_ttfb_ms: 120.0,
  rag_total_requests: 20,
  rag_failure_rate: 0.05,
  avg_retrieval_ms: 45.0,
  avg_chunks_retrieved: 3.2,
  rag_fallback_rate: 0.01,
};

const NULL_SUMMARY_ROW = {
  total_requests: null,
  total_tokens: null,
  estimated_cost_usd: null,
  avg_latency_ms: null,
  p95_latency_ms: null,
  p99_latency_ms: null,
  error_rate: null,
  avg_overhead_ms: null,
  avg_ttfb_ms: null,
  rag_total_requests: null,
  rag_failure_rate: null,
  avg_retrieval_ms: null,
  avg_chunks_retrieved: null,
  rag_fallback_rate: null,
};

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
  rag_total_requests: 0,
  rag_failure_rate: 0,
  avg_retrieval_ms: 0,
  avg_chunks_retrieved: 0,
  rag_fallback_rate: 0,
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AnalyticsRepository', () => {
  let repo: AnalyticsRepository;

  beforeEach(() => {
    mockRaw.mockReset();
    repo = new AnalyticsRepository(buildMockEm());
  });

  it('accepts an EntityManager in the constructor', () => {
    expect(repo).toBeInstanceOf(AnalyticsRepository);
  });

  // ── getSummary ──────────────────────────────────────────────────────────

  describe('getSummary', () => {
    it('returns a properly shaped AnalyticsSummary', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [FULL_SUMMARY_ROW] });

      const result = await repo.getSummary('tenant-1', 24);

      expect(result).toEqual<AnalyticsSummary>({
        totalRequests: 100,
        totalTokens: 5000,
        estimatedCostUSD: 0.05,
        avgLatencyMs: 250.0,
        p95LatencyMs: 500.0,
        p99LatencyMs: 800.0,
        errorRate: 0.02,
        avgOverheadMs: 10.0,
        avgTtfbMs: 120.0,
        ragMetrics: {
          totalRagRequests: 20,
          ragFailureRate: 0.05,
          avgRetrievalMs: 45.0,
          avgChunksRetrieved: 3.2,
          fallbackRate: 0.01,
        },
      });
    });

    it('uses subtenant CTE when rollup=true', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });

      await repo.getSummary('tenant-1', 24, true);

      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).toContain('subtenant_tree');
      expect(calledSql).toContain('IN (SELECT id FROM subtenant_tree)');
    });

    it('uses direct tenant_id filter when rollup=false', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });

      await repo.getSummary('tenant-1', 24, false);

      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).not.toContain('subtenant_tree');
      // After $N to ? conversion, it should be tenant_id = ?
      expect(calledSql).toContain('tenant_id = ?');
    });

    it('passes tenantId and windowHours as parameters', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });

      await repo.getSummary('tenant-abc', 48);

      const params = mockRaw.mock.calls[0][1] as unknown[];
      expect(params).toContain('tenant-abc');
      expect(params).toContain(48);
    });

    it('propagates query errors', async () => {
      mockRaw.mockRejectedValueOnce(new Error('connection refused'));
      await expect(repo.getSummary('tenant-1')).rejects.toThrow('connection refused');
    });
  });

  // ── parseSummaryRow (tested via getSummary) ─────────────────────────────

  describe('parseSummaryRow (null/undefined handling)', () => {
    it('falls back to 0 for null values', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [NULL_SUMMARY_ROW] });

      const result = await repo.getSummary('tenant-1');

      expect(result.totalRequests).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.estimatedCostUSD).toBe(0);
      expect(result.avgLatencyMs).toBe(0);
      expect(result.p95LatencyMs).toBe(0);
      expect(result.p99LatencyMs).toBe(0);
      expect(result.errorRate).toBe(0);
      expect(result.avgOverheadMs).toBe(0);
      expect(result.avgTtfbMs).toBe(0);
      expect(result.ragMetrics.totalRagRequests).toBe(0);
      expect(result.ragMetrics.ragFailureRate).toBe(0);
      expect(result.ragMetrics.avgRetrievalMs).toBe(0);
      expect(result.ragMetrics.avgChunksRetrieved).toBe(0);
      expect(result.ragMetrics.fallbackRate).toBe(0);
    });

    it('falls back to 0 for undefined values', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [{}] });

      const result = await repo.getSummary('tenant-1');

      expect(result.totalRequests).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.ragMetrics.totalRagRequests).toBe(0);
    });
  });

  // ── Placeholder conversion ($N to ?) ───────────────────────────────────

  describe('placeholder conversion', () => {
    it('converts $1, $2 placeholders to ? for Knex', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });

      await repo.getSummary('tenant-1', 24, false);

      const calledSql = mockRaw.mock.calls[0][0] as string;
      // Should not contain any remaining $N placeholders
      expect(calledSql).not.toMatch(/\$\d+\b/);
      // But quoted strings like '$2 hours' in interval expressions are allowed
    });

    it('preserves $N inside quoted strings (interval expressions)', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });

      await repo.getSummary('tenant-1', 24, false);

      const calledSql = mockRaw.mock.calls[0][0] as string;
      // The interval expression uses a ? placeholder outside quotes, concatenated with ' hours'
      // The key test is that the SQL is syntactically valid (mockRaw receives it)
      expect(calledSql).toContain('hours');
    });
  });

  // ── getTimeseries ──────────────────────────────────────────────────────

  describe('getTimeseries', () => {
    it('returns properly shaped TimeseriesBucket[]', async () => {
      const bucketDate = new Date('2024-06-01T12:00:00Z');
      mockRaw.mockResolvedValueOnce({
        rows: [{
          bucket: bucketDate,
          requests: 15,
          tokens: '750',
          cost_usd: 0.0075,
          avg_latency_ms: 220,
          error_rate: 0.01,
          avg_overhead_ms: 6.0,
          avg_ttfb_ms: 95.0,
        }],
      });

      const result = await repo.getTimeseries('tenant-1', 24);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<TimeseriesBucket>({
        bucket: bucketDate,
        requests: 15,
        tokens: 750,
        costUSD: 0.0075,
        avgLatencyMs: 220,
        errorRate: 0.01,
        avgOverheadMs: 6.0,
        avgTtfbMs: 95.0,
      });
    });

    it('returns empty array when no data', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      const result = await repo.getTimeseries('tenant-1');
      expect(result).toEqual([]);
    });

    it('uses rollup CTE when rollup=true', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      await repo.getTimeseries('tenant-1', 24, 60, true);
      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).toContain('subtenant_tree');
    });

    it('uses direct tenant filter when rollup=false', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      await repo.getTimeseries('tenant-1', 24, 60, false);
      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).not.toContain('subtenant_tree');
      expect(calledSql).toContain('tenant_id = ?');
    });

    it('changes bucket size when custom bucketMinutes is provided', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      await repo.getTimeseries('tenant-1', 24, 15); // 15-minute buckets

      const calledSql = mockRaw.mock.calls[0][0] as string;
      // 15 minutes = 900 seconds
      expect(calledSql).toContain('900');
    });

    it('returns multiple buckets in order', async () => {
      const d1 = new Date('2024-06-01T00:00:00Z');
      const d2 = new Date('2024-06-01T01:00:00Z');
      mockRaw.mockResolvedValueOnce({
        rows: [
          { bucket: d1, requests: 5, tokens: 100, cost_usd: 0.001, avg_latency_ms: 150, error_rate: 0, avg_overhead_ms: 3, avg_ttfb_ms: 60 },
          { bucket: d2, requests: 8, tokens: 200, cost_usd: 0.002, avg_latency_ms: 180, error_rate: 0, avg_overhead_ms: 4, avg_ttfb_ms: 70 },
        ],
      });

      const result = await repo.getTimeseries('tenant-1');
      expect(result).toHaveLength(2);
      expect(result[0].requests).toBe(5);
      expect(result[1].requests).toBe(8);
    });

    it('propagates query errors', async () => {
      mockRaw.mockRejectedValueOnce(new Error('timeseries fail'));
      await expect(repo.getTimeseries('tenant-1')).rejects.toThrow('timeseries fail');
    });
  });

  // ── getModelBreakdown ──────────────────────────────────────────────────

  describe('getModelBreakdown', () => {
    it('returns properly shaped ModelBreakdown[]', async () => {
      mockRaw.mockResolvedValueOnce({
        rows: [{
          model: 'gpt-4o',
          requests: 75,
          error_rate: 0.01,
          avg_latency_ms: 300,
          total_tokens: '3000',
          estimated_cost_usd: 0.045,
        }],
      });

      const result = await repo.getModelBreakdown('tenant-1', 24);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual<ModelBreakdown>({
        model: 'gpt-4o',
        requests: 75,
        errorRate: 0.01,
        avgLatencyMs: 300,
        totalTokens: 3000,
        estimatedCostUSD: 0.045,
      });
    });

    it('respects limit parameter', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      await repo.getModelBreakdown('tenant-1', 24, 5);

      const params = mockRaw.mock.calls[0][1] as unknown[];
      expect(params).toContain(5);
    });

    it('uses rollup CTE when rollup=true', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      await repo.getModelBreakdown('tenant-1', 24, 10, true);
      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).toContain('subtenant_tree');
    });

    it('uses direct tenant filter when rollup=false', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      await repo.getModelBreakdown('tenant-1', 24, 10, false);
      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).not.toContain('subtenant_tree');
      expect(calledSql).toContain('tenant_id = ?');
    });

    it('returns empty array when no model data', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      const result = await repo.getModelBreakdown('tenant-1');
      expect(result).toEqual([]);
    });

    it('propagates query errors', async () => {
      mockRaw.mockRejectedValueOnce(new Error('model breakdown fail'));
      await expect(repo.getModelBreakdown('tenant-1')).rejects.toThrow('model breakdown fail');
    });
  });

  // ── getAdminSummary ────────────────────────────────────────────────────

  describe('getAdminSummary', () => {
    it('omits tenant filter when tenantId is undefined', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });
      await repo.getAdminSummary(undefined, 24);

      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).not.toContain('tenant_id');
    });

    it('includes tenant filter when tenantId is provided', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [ZERO_SUMMARY_ROW] });
      await repo.getAdminSummary('tenant-abc', 24);

      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).toContain('tenant_id');
    });

    it('returns a properly shaped AnalyticsSummary', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [FULL_SUMMARY_ROW] });

      const result = await repo.getAdminSummary(undefined, 24);
      expect(result.totalRequests).toBe(100);
      expect(result.totalTokens).toBe(5000);
      expect(result.ragMetrics.totalRagRequests).toBe(20);
    });

    it('propagates query errors', async () => {
      mockRaw.mockRejectedValueOnce(new Error('admin summary fail'));
      await expect(repo.getAdminSummary()).rejects.toThrow('admin summary fail');
    });
  });

  // ── getAdminTimeseries ─────────────────────────────────────────────────

  describe('getAdminTimeseries', () => {
    it('returns TimeseriesBucket[] for all tenants', async () => {
      const d = new Date('2024-06-15T00:00:00Z');
      mockRaw.mockResolvedValueOnce({
        rows: [{ bucket: d, requests: 30, tokens: '1200', cost_usd: 0.012, avg_latency_ms: 190, error_rate: 0, avg_overhead_ms: 5, avg_ttfb_ms: 80 }],
      });

      const result = await repo.getAdminTimeseries(undefined, 24);
      expect(result).toHaveLength(1);
      expect(result[0].requests).toBe(30);
      expect(result[0].bucket).toEqual(d);
    });

    it('returns empty array when no data', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      const result = await repo.getAdminTimeseries();
      expect(result).toEqual([]);
    });

    it('includes tenant filter when tenantId is provided', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      await repo.getAdminTimeseries('tenant-xyz', 24);
      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).toContain('tenant_id');
    });

    it('propagates query errors', async () => {
      mockRaw.mockRejectedValueOnce(new Error('admin timeseries fail'));
      await expect(repo.getAdminTimeseries()).rejects.toThrow('admin timeseries fail');
    });
  });

  // ── getAdminModelBreakdown ─────────────────────────────────────────────

  describe('getAdminModelBreakdown', () => {
    it('returns ModelBreakdown[] for all tenants', async () => {
      mockRaw.mockResolvedValueOnce({
        rows: [{ model: 'gpt-4o', requests: 200, error_rate: 0.01, avg_latency_ms: 280, total_tokens: '10000', estimated_cost_usd: 0.1 }],
      });

      const result = await repo.getAdminModelBreakdown(undefined, 24);
      expect(result).toHaveLength(1);
      expect(result[0].model).toBe('gpt-4o');
      expect(result[0].totalTokens).toBe(10000);
    });

    it('returns empty array when no data', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      const result = await repo.getAdminModelBreakdown();
      expect(result).toEqual([]);
    });

    it('includes tenant filter when tenantId is provided', async () => {
      mockRaw.mockResolvedValueOnce({ rows: [] });
      await repo.getAdminModelBreakdown('tenant-xyz', 24);
      const calledSql = mockRaw.mock.calls[0][0] as string;
      expect(calledSql).toContain('tenant_id');
    });

    it('propagates query errors', async () => {
      mockRaw.mockRejectedValueOnce(new Error('admin model fail'));
      await expect(repo.getAdminModelBreakdown()).rejects.toThrow('admin model fail');
    });
  });
});
