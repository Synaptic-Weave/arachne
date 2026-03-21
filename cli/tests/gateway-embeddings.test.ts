import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  discoverEmbeddingProviders,
  embedViaGateway,
} from '../src/lib/gateway-embeddings.js';
import { resolveEmbeddingConfig } from '../src/commands/weave.js';

describe('discoverEmbeddingProviders', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns providers from gateway', async () => {
    const mockProviders = [
      { name: 'system-embedder', provider: 'openai', model: 'text-embedding-3-small' },
      { name: 'tenant-embedder', provider: 'azure', model: 'text-embedding-3-large' },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ providers: mockProviders }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await discoverEmbeddingProviders('http://localhost:3000', 'test-token');

    expect(result).toEqual(mockProviders);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/registry/embedding-providers',
      { headers: { Authorization: 'Bearer test-token' } },
    );
  });

  it('returns empty array on gateway error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    const result = await discoverEmbeddingProviders('http://localhost:3000', 'test-token');

    expect(result).toEqual([]);
  });

  it('returns empty array when gateway is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await discoverEmbeddingProviders('http://localhost:3000', 'test-token');

    expect(result).toEqual([]);
  });

  it('returns empty array when response has no providers field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await discoverEmbeddingProviders('http://localhost:3000', 'test-token');

    expect(result).toEqual([]);
  });
});

describe('embedViaGateway', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns embeddings from gateway', async () => {
    const mockResponse = {
      embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
      model: 'text-embedding-3-small',
      dimensions: 3,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await embedViaGateway(
      'http://localhost:3000',
      'test-token',
      ['hello', 'world'],
      'system-embedder',
    );

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/registry/embeddings',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ texts: ['hello', 'world'], provider: 'system-embedder' }),
      },
    );
  });

  it('throws on gateway error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Bad Request', { status: 400 }),
    );

    await expect(
      embedViaGateway('http://localhost:3000', 'test-token', ['hello']),
    ).rejects.toThrow('Gateway embeddings API error 400: Bad Request');
  });

  it('omits provider field when not specified', async () => {
    const mockResponse = {
      embeddings: [[0.1, 0.2]],
      model: 'text-embedding-3-small',
      dimensions: 2,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await embedViaGateway('http://localhost:3000', 'test-token', ['test']);

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(callBody).toEqual({ texts: ['test'] });
    expect(callBody.provider).toBeUndefined();
  });
});

describe('resolveEmbeddingConfig falls through to null', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'ARACHNE_EMBED_PROVIDER',
    'ARACHNE_EMBED_MODEL',
    'ARACHNE_EMBED_API_KEY',
    'SYSTEM_EMBEDDER_PROVIDER',
    'SYSTEM_EMBEDDER_MODEL',
    'SYSTEM_EMBEDDER_API_KEY',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('returns null when no local config is available', () => {
    const result = resolveEmbeddingConfig(undefined);
    expect(result).toBeNull();
  });

  it('returns null when spec embedder is incomplete', () => {
    const result = resolveEmbeddingConfig({ provider: 'openai' });
    expect(result).toBeNull();
  });

  it('returns config when spec embedder is complete', () => {
    const result = resolveEmbeddingConfig({ provider: 'openai', model: 'text-embedding-3-small' });
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('openai');
    expect(result!.model).toBe('text-embedding-3-small');
  });

  it('returns config from ARACHNE_EMBED_* env vars', () => {
    process.env['ARACHNE_EMBED_PROVIDER'] = 'openai';
    process.env['ARACHNE_EMBED_MODEL'] = 'text-embedding-3-small';
    process.env['ARACHNE_EMBED_API_KEY'] = 'sk-test';

    const result = resolveEmbeddingConfig(undefined);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('openai');
    expect(result!.apiKey).toBe('sk-test');
  });

  it('returns config from SYSTEM_EMBEDDER_* env vars', () => {
    process.env['SYSTEM_EMBEDDER_PROVIDER'] = 'azure';
    process.env['SYSTEM_EMBEDDER_MODEL'] = 'text-embedding-3-large';

    const result = resolveEmbeddingConfig(undefined);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('azure');
  });
});
