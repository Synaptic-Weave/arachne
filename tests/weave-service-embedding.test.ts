/**
 * Unit tests for WeaveService.embedTexts() rate-limit batching (#183)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EntityManager } from '@mikro-orm/core';

// Mock ORM so WeaveService can be imported without real DB
vi.mock('../src/orm.js', () => ({
  getORM: vi.fn().mockReturnValue({
    em: { fork: vi.fn() },
  }),
}));

import { WeaveService } from '../src/services/WeaveService.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const originalFetch = global.fetch;

function makeEmbeddingResponse(count: number) {
  return {
    ok: true,
    text: async () => '',
    json: async () => ({
      data: Array.from({ length: count }, (_, i) => ({
        embedding: [0.1 * (i + 1), 0.2, 0.3],
        index: i,
      })),
    }),
  };
}

function buildMockEm(): EntityManager {
  return {
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockResolvedValue([]),
    persist: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    persistAndFlush: vi.fn().mockResolvedValue(undefined),
  } as unknown as EntityManager;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WeaveService.embedTexts — rate-limit batching', () => {
  let service: WeaveService;
  let mockFetch: ReturnType<typeof vi.fn>;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const em = buildMockEm();
    service = new WeaveService(em);
    mockFetch = vi.fn();
    global.fetch = mockFetch as any;
    setTimeoutSpy = vi.spyOn(global, 'setTimeout');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setTimeoutSpy.mockRestore();
    vi.clearAllMocks();
  });

  const openaiConfig = {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    apiKey: 'sk-test',
  };

  it('returns all embeddings for small input without delay', async () => {
    const texts = ['hello', 'world', 'test'];
    mockFetch.mockResolvedValue(makeEmbeddingResponse(3));

    const result = await service.embedTexts(texts, openaiConfig);

    expect(result).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // No 60s delay should have been scheduled
    const longTimeouts = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 60_000);
    expect(longTimeouts).toHaveLength(0);
  });

  it('splits large input into multiple rate batches', async () => {
    // Each text is 1040 chars = ~260 estimated tokens
    // TOKEN_BUDGET = 260,000 so ~1000 texts per rate batch
    // 1500 texts should produce 2 rate batches
    const texts = Array.from({ length: 1500 }, (_, i) => 'x'.repeat(1040));

    // Each API batch of 100 returns 100 embeddings
    mockFetch.mockImplementation(async () => {
      const callCount = mockFetch.mock.calls.length;
      // Figure out batch size from request body
      const body = JSON.parse(mockFetch.mock.calls[callCount - 1][1].body);
      return makeEmbeddingResponse(body.input.length);
    });

    // Replace setTimeout to resolve immediately
    setTimeoutSpy.mockImplementation(((fn: Function, ms?: number) => {
      if (ms === 60_000) {
        fn();
        return 0 as any;
      }
      return originalFetch ? (Function.prototype.bind.call(setTimeout, null, fn, ms) as any) : (0 as any);
    }) as any);

    const result = await service.embedTexts(texts, openaiConfig);

    expect(result).toHaveLength(1500);
    // Should have 60s delay calls (at least 1 between rate batches)
    const longTimeouts = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 60_000);
    expect(longTimeouts.length).toBeGreaterThanOrEqual(1);
  });

  it('logs progress when multiple rate batches are needed', async () => {
    // 1500 texts at 1040 chars each = 2 rate batches
    const texts = Array.from({ length: 1500 }, () => 'x'.repeat(1040));
    const logger = { info: vi.fn() };

    mockFetch.mockImplementation(async () => {
      const callCount = mockFetch.mock.calls.length;
      const body = JSON.parse(mockFetch.mock.calls[callCount - 1][1].body);
      return makeEmbeddingResponse(body.input.length);
    });

    setTimeoutSpy.mockImplementation(((fn: Function, ms?: number) => {
      if (ms === 60_000) { fn(); return 0 as any; }
      return 0 as any;
    }) as any);

    await service.embedTexts(texts, openaiConfig, undefined, undefined, logger);

    // Logger should have been called with rate-batch progress
    expect(logger.info).toHaveBeenCalled();
    const messages = logger.info.mock.calls.map(([msg]: [string]) => msg);
    expect(messages.some((m: string) => m.includes('rate-batch'))).toBe(true);
    expect(messages.some((m: string) => m.includes('rate-limit pause'))).toBe(true);
  });

  it('does not log or delay for single rate batch', async () => {
    const texts = ['short text', 'another short text'];
    const logger = { info: vi.fn() };

    mockFetch.mockResolvedValue(makeEmbeddingResponse(2));

    await service.embedTexts(texts, openaiConfig, undefined, undefined, logger);

    // No rate-batch logging for single batch
    const messages = logger.info.mock.calls.map(([msg]: [string]) => msg);
    expect(messages.some((m: string) => m.includes('rate-batch'))).toBe(false);
    // No 60s delay
    const longTimeouts = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 60_000);
    expect(longTimeouts).toHaveLength(0);
  });

  it('preserves embedding order across rate batches', async () => {
    // Use 1500 texts to force 2 rate batches
    const texts = Array.from({ length: 1500 }, (_, i) => 'x'.repeat(1040));
    let batchCallIndex = 0;

    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      const count = body.input.length;
      batchCallIndex++;
      return {
        ok: true,
        json: async () => ({
          data: Array.from({ length: count }, (_, i) => ({
            embedding: [batchCallIndex, i],
            index: i,
          })),
        }),
      };
    });

    setTimeoutSpy.mockImplementation(((fn: Function, ms?: number) => {
      if (ms === 60_000) { fn(); return 0 as any; }
      return 0 as any;
    }) as any);

    const result = await service.embedTexts(texts, openaiConfig);

    expect(result).toHaveLength(1500);
    // First batch's embeddings should come before second batch's
    expect(result[0][0]).toBe(1); // from first API call
  });

  it('batches API calls at 100 texts per request', async () => {
    // 250 texts, all small (fit in one rate batch), should produce 3 API calls
    const texts = Array.from({ length: 250 }, () => 'small');

    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      return makeEmbeddingResponse(body.input.length);
    });

    const result = await service.embedTexts(texts, openaiConfig);

    expect(result).toHaveLength(250);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 100 + 100 + 50
  });
});
