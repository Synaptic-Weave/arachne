import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createInitCommand } from '../src/commands/init.js';

describe('init command', () => {
  let tempDir: string;
  let origCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'arachne-init-test-'));
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('generates agent YAML with correct apiVersion, kind, and metadata.name', async () => {
    const cmd = createInitCommand();
    await cmd.parseAsync(['node', 'init', '--kind', 'agent']);

    const filePath = join(tempDir, 'my-agent.yaml');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('apiVersion: arachne-ai.com/v0');
    expect(content).toContain('kind: Agent');
    expect(content).toContain('name: my-agent');
    expect(content).toContain('model: gpt-4.1-mini');
  });

  it('generates kb YAML with correct apiVersion, kind, and metadata.name', async () => {
    const cmd = createInitCommand();
    await cmd.parseAsync(['node', 'init', '--kind', 'kb']);

    const filePath = join(tempDir, 'my-kb.yaml');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('apiVersion: arachne-ai.com/v0');
    expect(content).toContain('kind: KnowledgeBase');
    expect(content).toContain('name: my-kb');
    expect(content).toContain('tokenSize: 650');
    expect(content).toContain('overlap: 120');
  });

  it('generates embedding-agent YAML with correct fields', async () => {
    const cmd = createInitCommand();
    await cmd.parseAsync(['node', 'init', '--kind', 'embedding-agent']);

    const filePath = join(tempDir, 'my-embedder.yaml');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('apiVersion: arachne-ai.com/v0');
    expect(content).toContain('kind: EmbeddingAgent');
    expect(content).toContain('name: my-embedder');
    expect(content).toContain('provider: openai');
    expect(content).toContain('model: text-embedding-3-small');
  });

  it('--name substitutes into metadata.name and filename', async () => {
    const cmd = createInitCommand();
    await cmd.parseAsync(['node', 'init', '--kind', 'agent', '--name', 'custom-bot']);

    const filePath = join(tempDir, 'custom-bot.yaml');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('name: custom-bot');
  });

  it('errors when file exists without --force', async () => {
    const filePath = join(tempDir, 'my-agent.yaml');
    writeFileSync(filePath, 'existing content', 'utf8');

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cmd = createInitCommand();

    try {
      await cmd.parseAsync(['node', 'init', '--kind', 'agent']);
    } catch {
      // Expected: process.exit mock throws
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
    );

    // File should not be overwritten
    expect(readFileSync(filePath, 'utf8')).toBe('existing content');
  });

  it('--force overwrites existing file', async () => {
    const filePath = join(tempDir, 'my-agent.yaml');
    writeFileSync(filePath, 'old content', 'utf8');

    const cmd = createInitCommand();
    await cmd.parseAsync(['node', 'init', '--kind', 'agent', '--force']);

    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('apiVersion: arachne-ai.com/v0');
    expect(content).toContain('kind: Agent');
    expect(content).not.toContain('old content');
  });
});
