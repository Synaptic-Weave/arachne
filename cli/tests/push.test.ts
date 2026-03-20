import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gzipSync } from 'zlib';
import { buildTar } from '../src/lib/tar.js';
import { extractManifest } from '../src/commands/push.js';

function createTestOrb(manifest: Record<string, unknown>): Buffer {
  const tarFiles = [
    {
      path: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifest), 'utf8'),
    },
    {
      path: 'spec.yaml',
      data: Buffer.from('kind: Agent\nmetadata:\n  name: test', 'utf8'),
    },
  ];
  const tarBuf = buildTar(tarFiles);
  return gzipSync(tarBuf);
}

describe('push command', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'arachne-push-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('extractManifest', () => {
    it('reads name and kind from .orb bundle', () => {
      const orb = createTestOrb({
        name: 'my-agent',
        kind: 'Agent',
        version: '2026-01-01T00:00:00.000Z',
      });

      const manifest = extractManifest(orb);
      expect(manifest.name).toBe('my-agent');
      expect(manifest.kind).toBe('Agent');
    });

    it('reads sha256 and chunkCount when present', () => {
      const orb = createTestOrb({
        name: 'my-kb',
        kind: 'KnowledgeBase',
        sha256: 'abc123',
        chunkCount: 42,
      });

      const manifest = extractManifest(orb);
      expect(manifest.name).toBe('my-kb');
      expect(manifest.kind).toBe('KnowledgeBase');
      expect(manifest.sha256).toBe('abc123');
      expect(manifest.chunkCount).toBe(42);
    });

    it('throws when manifest.json is missing', () => {
      const tarBuf = buildTar([
        { path: 'spec.yaml', data: Buffer.from('kind: Agent', 'utf8') },
      ]);
      const orb = gzipSync(tarBuf);

      expect(() => extractManifest(orb)).toThrow('No manifest.json found');
    });

    it('throws when name or kind is missing from manifest', () => {
      const orb = createTestOrb({ version: '1.0' });
      expect(() => extractManifest(orb)).toThrow('missing required');
    });
  });

  describe('push action sends form data with name, kind, sha256', () => {
    it('sends manifest fields in form data', async () => {
      const orb = createTestOrb({
        name: 'test-agent',
        kind: 'Agent',
        sha256: 'deadbeef',
        chunkCount: 10,
      });

      const orbPath = join(tempDir, 'test-agent.orb');
      writeFileSync(orbPath, orb);

      // Mock config to avoid "not logged in" error
      vi.mock('../src/config.js', () => ({
        getGatewayUrl: () => 'http://localhost:3000',
        getToken: () => 'test-token',
      }));

      // Capture fetch call
      let capturedUrl = '';
      let capturedBody: FormData | undefined;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        capturedUrl = url as string;
        capturedBody = init?.body as FormData;
        return new Response(JSON.stringify({ ref: 'test-agent:latest' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const { pushCommand } = await import('../src/commands/push.js');
      await pushCommand.parseAsync(['node', 'push', orbPath]);

      expect(fetchSpy).toHaveBeenCalled();
      expect(capturedUrl).toContain('/v1/registry/push');

      // Verify form data has the right fields
      expect(capturedBody).toBeDefined();
      if (capturedBody) {
        expect(capturedBody.get('name')).toBe('test-agent');
        expect(capturedBody.get('kind')).toBe('Agent');
        expect(capturedBody.get('sha256')).toBe('deadbeef');
        expect(capturedBody.get('chunkCount')).toBe('10');
        expect(capturedBody.get('tag')).toBe('latest');
      }
    });
  });
});
