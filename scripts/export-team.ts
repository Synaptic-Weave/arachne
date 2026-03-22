#!/usr/bin/env npx tsx
/**
 * Export/Backup Agent Team
 *
 * Bundles agent prompts, Tier 1 general knowledge, and optionally blogs,
 * project findings, and memory files into a portable .tar.gz archive.
 *
 * Usage:
 *   npx tsx scripts/export-team.ts                          # prompts + Tier 1 only
 *   npx tsx scripts/export-team.ts --include-blogs          # + agent blogs
 *   npx tsx scripts/export-team.ts --include-findings       # + Tier 2 findings
 *   npx tsx scripts/export-team.ts --include-memories       # + feedback/project/ref/user
 *   npx tsx scripts/export-team.ts --output ./backup.tar.gz # custom output path
 *   npx tsx scripts/export-team.ts --dry-run                # preview without creating
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  rmSync,
  statSync,
} from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── CLI flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const INCLUDE_BLOGS = args.includes('--include-blogs');
const INCLUDE_FINDINGS = args.includes('--include-findings');
const INCLUDE_MEMORIES = args.includes('--include-memories');

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

const today = new Date().toISOString().slice(0, 10);
const OUTPUT = resolve(
  getFlag('--output') ?? join(__dirname, '..', `arachne-team-${today}.tar.gz`),
);

// ── Paths ────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? '~';
const projectSlug = process.cwd().replace(/\//g, '-');
const PROJECT_MEMORY = resolve(HOME, '.claude/projects', projectSlug, 'memory');
const GLOBAL_AGENTS = resolve(HOME, '.claude/memory/agents');
const AGENTS_DIR = join(PROJECT_MEMORY, 'agents');

// ── Helpers ──────────────────────────────────────────────────────────────────

interface FileEntry {
  src: string;
  dest: string; // relative path inside archive
}

const entries: FileEntry[] = [];

function enqueue(src: string, dest: string): void {
  if (existsSync(src)) {
    entries.push({ src, dest });
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}K`;
}

// ── Discover agents ──────────────────────────────────────────────────────────

if (!existsSync(AGENTS_DIR)) {
  console.error(`Agent directory not found: ${AGENTS_DIR}`);
  process.exit(1);
}

const agentNames = readdirSync(AGENTS_DIR).filter((name) =>
  statSync(join(AGENTS_DIR, name)).isDirectory(),
);

console.log(`Found ${agentNames.length} agents: ${agentNames.join(', ')}\n`);

// ── Collect files ────────────────────────────────────────────────────────────

// Agent prompts (always included)
for (const name of agentNames) {
  enqueue(join(AGENTS_DIR, name, 'prompt.md'), `memory/agents/${name}/prompt.md`);
}

// Agent blogs (optional)
if (INCLUDE_BLOGS) {
  for (const name of agentNames) {
    enqueue(join(AGENTS_DIR, name, 'blog.md'), `memory/agents/${name}/blog.md`);
  }
}

// Agent Tier 2 findings (optional)
if (INCLUDE_FINDINGS) {
  for (const name of agentNames) {
    enqueue(
      join(AGENTS_DIR, name, 'findings.md'),
      `memory/agents/${name}/findings.md`,
    );
  }
}

// Tier 1 general knowledge (always included)
for (const name of agentNames) {
  enqueue(join(GLOBAL_AGENTS, name, 'general.md'), `general/${name}/general.md`);
}

// Memory files (optional)
if (INCLUDE_MEMORIES) {
  // MEMORY.md index
  enqueue(join(PROJECT_MEMORY, 'MEMORY.md'), 'memory/MEMORY.md');

  // All non-agent .md files in project memory root
  const memoryFiles = readdirSync(PROJECT_MEMORY).filter(
    (f) => f.endsWith('.md') && f !== 'MEMORY.md',
  );
  for (const file of memoryFiles) {
    const fullPath = join(PROJECT_MEMORY, file);
    if (statSync(fullPath).isFile()) {
      enqueue(fullPath, `memory/${file}`);
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

const agentCount = agentNames.length;
const promptCount = entries.filter((e) => e.dest.endsWith('prompt.md')).length;
const blogCount = entries.filter(
  (e) => e.dest.includes('memory/agents/') && e.dest.endsWith('blog.md'),
).length;
const findingsCount = entries.filter((e) => e.dest.endsWith('findings.md')).length;
const generalCount = entries.filter((e) => e.dest.startsWith('general/')).length;
const memoryCount = entries.filter(
  (e) =>
    e.dest.startsWith('memory/') &&
    !e.dest.startsWith('memory/agents/'),
).length;

console.log('Files to export:');
console.log(`  Agent prompts:      ${promptCount}`);
console.log(`  Tier 1 general:     ${generalCount}`);
if (INCLUDE_BLOGS) console.log(`  Agent blogs:        ${blogCount}`);
if (INCLUDE_FINDINGS) console.log(`  Agent findings:     ${findingsCount}`);
if (INCLUDE_MEMORIES) console.log(`  Memory files:       ${memoryCount}`);
console.log(`  Total files:        ${entries.length}\n`);

if (DRY_RUN) {
  console.log('Archive contents (dry run):\n');
  for (const entry of entries) {
    const size = formatSize(statSync(entry.src).size);
    console.log(`  ${entry.dest}  (${size})`);
  }
  console.log(`\nWould create: ${OUTPUT}`);
  console.log('(Dry run: no files written. Remove --dry-run to export.)');
  process.exit(0);
}

// ── Build archive ────────────────────────────────────────────────────────────

const archiveName = `arachne-team-${today}`;
const tmpDir = join(__dirname, '..', `.tmp-${archiveName}`);

// Clean up any leftover temp dir
if (existsSync(tmpDir)) {
  rmSync(tmpDir, { recursive: true });
}

const stageDir = join(tmpDir, archiveName);
mkdirSync(stageDir, { recursive: true });

// Copy files into staging directory
for (const entry of entries) {
  const destPath = join(stageDir, entry.dest);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(entry.src, destPath);
}

// Write manifest
const manifest = {
  exportDate: new Date().toISOString(),
  version: '1.0.0',
  agents: agentNames,
  agentCount,
  includes: {
    prompts: true,
    tier1General: true,
    blogs: INCLUDE_BLOGS,
    findings: INCLUDE_FINDINGS,
    memories: INCLUDE_MEMORIES,
  },
  fileCount: entries.length,
};

writeFileSync(
  join(stageDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);

// Create tar.gz
execSync(`tar -czf "${OUTPUT}" -C "${tmpDir}" "${archiveName}"`, {
  stdio: 'inherit',
});

// Clean up
rmSync(tmpDir, { recursive: true });

const archiveSize = formatSize(statSync(OUTPUT).size);
console.log(`Archive created: ${OUTPUT} (${archiveSize})`);
