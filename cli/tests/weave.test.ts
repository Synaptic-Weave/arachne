import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gunzipSync } from 'node:zlib';
import { execSync } from 'child_process';
import { weaveCommand } from '../src/commands/weave.js';

const VALID_AGENT_SPEC = `apiVersion: arachne.ai/v0
kind: Agent
metadata:
  name: test-agent
spec:
  model: gpt-4
`;

const VALID_KB_SPEC = `apiVersion: arachne.ai/v0
kind: KnowledgeBase
metadata:
  name: test-kb
  docsPath: ./docs
spec:
  chunking:
    tokenSize: 650
    overlap: 120
`;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'weave-test-'));
}

/**
 * List filenames inside a .orb (tar.gz) archive using the system tar command.
 */
function listOrbEntries(orbPath: string): string[] {
  const output = execSync(`tar -tzf "${orbPath}"`, { encoding: 'utf8' });
  return output.trim().split('\n').filter(Boolean);
}

/**
 * Extract a single file from a .orb archive and return its contents as a string.
 */
function extractOrbEntry(orbPath: string, entryName: string): string {
  return execSync(`tar -xzf "${orbPath}" -O "${entryName}"`, { encoding: 'utf8' });
}

describe('arachne weave', () => {
  let tempDir: string;
  let outDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    outDir = join(tempDir, 'output');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('weaves a valid agent spec into an .orb file', async () => {
    const specPath = join(tempDir, 'agent.yaml');
    writeFileSync(specPath, VALID_AGENT_SPEC);

    await weaveCommand.parseAsync(['node', 'arachne', specPath, '-o', outDir]);

    const orbPath = join(outDir, 'test-agent.orb');
    expect(existsSync(orbPath)).toBe(true);

    // Verify it is valid gzip (magic bytes 0x1f 0x8b)
    const orbBytes = readFileSync(orbPath);
    expect(orbBytes[0]).toBe(0x1f);
    expect(orbBytes[1]).toBe(0x8b);

    // Verify it can be gunzipped without error
    const tarData = gunzipSync(orbBytes);
    expect(tarData.length).toBeGreaterThan(0);

    // Verify expected entries exist
    const entries = listOrbEntries(orbPath);
    expect(entries).toContain('spec.yaml');
    expect(entries).toContain('manifest.json');
  });

  it('weaves a KnowledgeBase spec into an .orb file', async () => {
    const specPath = join(tempDir, 'kb.yaml');
    writeFileSync(specPath, VALID_KB_SPEC);

    // Create docs directory with a small text file
    const docsDir = join(tempDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'test.txt'), 'Hello world test content for chunking.');

    // Mock embedding env vars and fetch
    process.env['ARACHNE_EMBED_PROVIDER'] = 'openai';
    process.env['ARACHNE_EMBED_MODEL'] = 'text-embedding-3-small';
    process.env['ARACHNE_EMBED_API_KEY'] = 'test-key';

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: Array(1536).fill(0.1), index: 0 }] }), { status: 200 }),
    );

    try {
      await weaveCommand.parseAsync(['node', 'arachne', specPath, '-o', outDir]);

      const orbPath = join(outDir, 'test-kb.orb');
      expect(existsSync(orbPath)).toBe(true);

      const entries = listOrbEntries(orbPath);
      expect(entries).toContain('spec.yaml');
      expect(entries).toContain('manifest.json');

      // Verify the manifest references KnowledgeBase kind
      const manifest = JSON.parse(extractOrbEntry(orbPath, 'manifest.json'));
      expect(manifest.kind).toBe('KnowledgeBase');
      expect(manifest.name).toBe('test-kb');
      expect(manifest.chunkCount).toBeGreaterThan(0);
    } finally {
      mockFetch.mockRestore();
      delete process.env['ARACHNE_EMBED_PROVIDER'];
      delete process.env['ARACHNE_EMBED_MODEL'];
      delete process.env['ARACHNE_EMBED_API_KEY'];
    }
  });

  it('manifest contains correct metadata fields', async () => {
    const specPath = join(tempDir, 'agent.yaml');
    writeFileSync(specPath, VALID_AGENT_SPEC);

    await weaveCommand.parseAsync(['node', 'arachne', specPath, '-o', outDir]);

    const orbPath = join(outDir, 'test-agent.orb');
    const manifest = JSON.parse(extractOrbEntry(orbPath, 'manifest.json'));

    expect(manifest.kind).toBe('Agent');
    expect(manifest.name).toBe('test-agent');
    expect(manifest.version).toBe('1.0.0');

    // sha256 should be a 64-char hex string
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);

    // createdAt should be a valid ISO date string
    expect(new Date(manifest.createdAt).toISOString()).toBe(manifest.createdAt);
  });

  it('includes docs file when docsPath points to a file', async () => {
    const specWithDocs = `apiVersion: arachne.ai/v0
kind: Agent
metadata:
  name: agent-with-docs
  docsPath: ./readme.md
spec:
  model: gpt-4
`;
    const specPath = join(tempDir, 'agent.yaml');
    writeFileSync(specPath, specWithDocs);

    const readmePath = join(tempDir, 'readme.md');
    writeFileSync(readmePath, '# My Agent\n\nThis is the agent documentation.');

    await weaveCommand.parseAsync(['node', 'arachne', specPath, '-o', outDir]);

    const orbPath = join(outDir, 'agent-with-docs.orb');
    expect(existsSync(orbPath)).toBe(true);

    const entries = listOrbEntries(orbPath);
    expect(entries).toContain('docs/readme.md');

    // Verify the docs content is intact
    const docsContent = extractOrbEntry(orbPath, 'docs/readme.md');
    expect(docsContent).toContain('# My Agent');
  });

  it('uses custom output directory via -o flag', async () => {
    const customOut = join(tempDir, 'custom', 'nested', 'out');
    const specPath = join(tempDir, 'agent.yaml');
    writeFileSync(specPath, VALID_AGENT_SPEC);

    await weaveCommand.parseAsync(['node', 'arachne', specPath, '-o', customOut]);

    const orbPath = join(customOut, 'test-agent.orb');
    expect(existsSync(orbPath)).toBe(true);
  });

  it('errors on missing spec file', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const bogusPath = join(tempDir, 'nonexistent.yaml');

    await expect(
      weaveCommand.parseAsync(['node', 'arachne', bogusPath, '-o', outDir])
    ).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('spec file not found')
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('errors when kind is missing from YAML', async () => {
    const noKindSpec = `apiVersion: arachne.ai/v0
metadata:
  name: bad-agent
spec:
  model: gpt-4
`;
    const specPath = join(tempDir, 'no-kind.yaml');
    writeFileSync(specPath, noKindSpec);

    await expect(
      weaveCommand.parseAsync(['node', 'arachne', specPath, '-o', outDir])
    ).rejects.toThrow('Missing "kind" in spec YAML');
  });

  it('errors when metadata.name is missing from YAML', async () => {
    const noNameSpec = `apiVersion: arachne.ai/v0
kind: Agent
metadata:
  version: 1
spec:
  model: gpt-4
`;
    const specPath = join(tempDir, 'no-name.yaml');
    writeFileSync(specPath, noNameSpec);

    await expect(
      weaveCommand.parseAsync(['node', 'arachne', specPath, '-o', outDir])
    ).rejects.toThrow('Missing "metadata.name" in spec YAML');
  });
});
