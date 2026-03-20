import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gunzipSync } from 'zlib';
import { extractFileFromTar } from '../src/lib/tar.js';
import { chunkText } from '../src/lib/embedding.js';

describe('KB weave', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'arachne-weave-kb-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('chunks text correctly', () => {
    // 650 tokens * 4 chars = 2600 chars per chunk, overlap 120 * 4 = 480 chars
    // step = 2600 - 480 = 2120 chars
    const text = 'word '.repeat(600); // 3000 chars
    const chunks = chunkText(text, 650, 120);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('chunks short text as single chunk', () => {
    const text = 'Hello world';
    const chunks = chunkText(text, 650, 120);
    expect(chunks).toEqual(['Hello world']);
  });

  it('returns empty array for empty text', () => {
    expect(chunkText('', 650, 120)).toEqual([]);
    expect(chunkText('   ', 650, 120)).toEqual([]);
  });

  it('weaves KB spec with docs into .orb with chunks and manifest', async () => {
    // Create docs directory with small files
    const docsDir = join(tempDir, 'docs');
    mkdirSync(docsDir);
    writeFileSync(join(docsDir, 'doc1.md'), 'This is document one with some content for testing.');
    writeFileSync(join(docsDir, 'doc2.txt'), 'This is document two with different content.');

    // Create KB spec
    const specContent = `apiVersion: arachne-ai.com/v0
kind: KnowledgeBase
metadata:
  name: test-kb
  docsPath: ./docs
spec:
  chunking:
    tokenSize: 650
    overlap: 120
  retrieval:
    topK: 8
    citations: true
`;
    const specPath = join(tempDir, 'test-kb.yaml');
    writeFileSync(specPath, specContent);

    // Mock fetch to return deterministic embeddings
    const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          { embedding: mockEmbedding, index: 0 },
          { embedding: mockEmbedding, index: 1 },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    // Set env vars for embedding
    process.env['ARACHNE_EMBED_PROVIDER'] = 'openai';
    process.env['ARACHNE_EMBED_MODEL'] = 'text-embedding-3-small';
    process.env['ARACHNE_EMBED_API_KEY'] = 'test-key';

    // Import and run weave command
    const { weaveCommand } = await import('../src/commands/weave.js');
    const outputDir = join(tempDir, 'dist');

    await weaveCommand.parseAsync([
      'node', 'weave', specPath, '-o', outputDir,
    ]);

    // Verify .orb was created
    const orbPath = join(outputDir, 'test-kb.orb');
    expect(existsSync(orbPath)).toBe(true);

    // Extract and verify contents
    const orbBuf = readFileSync(orbPath);
    const tarBuf = gunzipSync(orbBuf);

    // Check manifest
    const manifestBuf = extractFileFromTar(tarBuf, 'manifest.json');
    expect(manifestBuf).not.toBeNull();
    const manifest = JSON.parse(manifestBuf!.toString('utf8'));
    expect(manifest.kind).toBe('KnowledgeBase');
    expect(manifest.name).toBe('test-kb');
    expect(manifest.chunkCount).toBeGreaterThanOrEqual(2);
    expect(manifest.vectorSpace).toBeDefined();
    expect(manifest.vectorSpace.provider).toBe('openai');
    expect(manifest.vectorSpace.model).toBe('text-embedding-3-small');
    expect(manifest.vectorSpace.dimensions).toBe(5); // length of mockEmbedding

    // Check chunk files exist
    const chunk0Buf = extractFileFromTar(tarBuf, 'chunks/0.json');
    expect(chunk0Buf).not.toBeNull();
    const chunk0 = JSON.parse(chunk0Buf!.toString('utf8'));
    expect(chunk0.content).toBeTruthy();
    expect(chunk0.sourcePath).toBeTruthy();
    expect(chunk0.tokenCount).toBeGreaterThan(0);
    expect(chunk0.embedding).toEqual(mockEmbedding);

    // Check spec.yaml is included
    const specBuf = extractFileFromTar(tarBuf, 'spec.yaml');
    expect(specBuf).not.toBeNull();

    // Verify fetch was called for embeddings
    expect(fetchSpy).toHaveBeenCalled();

    // Cleanup env
    delete process.env['ARACHNE_EMBED_PROVIDER'];
    delete process.env['ARACHNE_EMBED_MODEL'];
    delete process.env['ARACHNE_EMBED_API_KEY'];
  });

  it('chunking produces expected number of chunks for known input', () => {
    // 10000 chars, tokenSize=250 (1000 chars), overlap=50 (200 chars), step=800
    // Expect ceil((10000-1000)/800) + 1 = 12 + 1 = ~12-13 chunks
    const text = 'abcdefghij '.repeat(909); // ~10000 chars
    const chunks = chunkText(text, 250, 50);
    expect(chunks.length).toBeGreaterThanOrEqual(10);
    expect(chunks.length).toBeLessThanOrEqual(15);
  });
});
