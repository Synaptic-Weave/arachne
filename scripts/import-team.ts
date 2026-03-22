#!/usr/bin/env npx tsx
/**
 * Import/Restore Agent Team
 *
 * Restores an agent team archive (created by export-team.ts) into the
 * correct memory locations. Supports dry-run and force-overwrite modes.
 *
 * Usage:
 *   npx tsx scripts/import-team.ts ./arachne-team-2026-03-21.tar.gz
 *   npx tsx scripts/import-team.ts ./arachne-team-2026-03-21.tar.gz --dry-run
 *   npx tsx scripts/import-team.ts ./arachne-team-2026-03-21.tar.gz --force
 */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  readdirSync,
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
const FORCE = args.includes('--force');

// First non-flag argument is the archive path
const archivePath = args.find((a) => !a.startsWith('--'));

if (!archivePath) {
  console.error('Usage: npx tsx scripts/import-team.ts <archive.tar.gz> [--dry-run] [--force]');
  process.exit(1);
}

const resolvedArchive = resolve(archivePath);
if (!existsSync(resolvedArchive)) {
  console.error(`Archive not found: ${resolvedArchive}`);
  process.exit(1);
}

// ── Paths ────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? '~';
const projectSlug = process.cwd().replace(/\//g, '-');
const PROJECT_MEMORY = resolve(HOME, '.claude/projects', projectSlug, 'memory');
const GLOBAL_AGENTS = resolve(HOME, '.claude/memory/agents');

// ── Extract archive ──────────────────────────────────────────────────────────

const tmpDir = join(__dirname, '..', '.tmp-import-team');

if (existsSync(tmpDir)) {
  rmSync(tmpDir, { recursive: true });
}
mkdirSync(tmpDir, { recursive: true });

execSync(`tar -xzf "${resolvedArchive}" -C "${tmpDir}"`, { stdio: 'inherit' });

// Find the extracted directory (arachne-team-YYYY-MM-DD)
const extractedDirs = readdirSync(tmpDir).filter((d) =>
  statSync(join(tmpDir, d)).isDirectory(),
);

if (extractedDirs.length !== 1) {
  console.error('Unexpected archive structure: expected a single top-level directory');
  rmSync(tmpDir, { recursive: true });
  process.exit(1);
}

const stageDir = join(tmpDir, extractedDirs[0]);

// ── Validate manifest ────────────────────────────────────────────────────────

const manifestPath = join(stageDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('Invalid archive: manifest.json not found');
  rmSync(tmpDir, { recursive: true });
  process.exit(1);
}

interface Manifest {
  exportDate: string;
  version: string;
  agents: string[];
  agentCount: number;
  includes: {
    prompts: boolean;
    tier1General: boolean;
    blogs: boolean;
    findings: boolean;
    memories: boolean;
  };
  fileCount: number;
}

const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

console.log(`Archive: ${resolvedArchive}`);
console.log(`Exported: ${manifest.exportDate}`);
console.log(`Agents: ${manifest.agents.join(', ')} (${manifest.agentCount})`);
console.log(`Includes: prompts, tier1${manifest.includes.blogs ? ', blogs' : ''}${manifest.includes.findings ? ', findings' : ''}${manifest.includes.memories ? ', memories' : ''}`);
console.log(`Total files: ${manifest.fileCount}\n`);

// ── Import helpers ───────────────────────────────────────────────────────────

let imported = 0;
let skipped = 0;
let overwritten = 0;

function importFile(src: string, dest: string, label: string): void {
  if (!existsSync(src)) return;

  const exists = existsSync(dest);

  if (DRY_RUN) {
    if (exists && !FORCE) {
      console.log(`  [skip] ${label} (exists)`);
      skipped++;
    } else if (exists && FORCE) {
      console.log(`  [overwrite] ${label}`);
      overwritten++;
    } else {
      console.log(`  [import] ${label}`);
      imported++;
    }
    return;
  }

  if (exists && !FORCE) {
    console.log(`  skip: ${label} (exists, use --force to overwrite)`);
    skipped++;
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });

  if (exists) {
    console.log(`  overwrite: ${label}`);
    overwritten++;
  } else {
    console.log(`  import: ${label}`);
    imported++;
  }

  copyFileSync(src, dest);
}

// ── Import agent files ───────────────────────────────────────────────────────

console.log('Agent files:');

for (const name of manifest.agents) {
  // Prompts (project memory)
  importFile(
    join(stageDir, 'memory/agents', name, 'prompt.md'),
    join(PROJECT_MEMORY, 'agents', name, 'prompt.md'),
    `agents/${name}/prompt.md`,
  );

  // Blogs (project memory)
  if (manifest.includes.blogs) {
    importFile(
      join(stageDir, 'memory/agents', name, 'blog.md'),
      join(PROJECT_MEMORY, 'agents', name, 'blog.md'),
      `agents/${name}/blog.md`,
    );
  }

  // Findings (project memory, Tier 2)
  if (manifest.includes.findings) {
    importFile(
      join(stageDir, 'memory/agents', name, 'findings.md'),
      join(PROJECT_MEMORY, 'agents', name, 'findings.md'),
      `agents/${name}/findings.md`,
    );
  }

  // Tier 1 general knowledge (global memory)
  importFile(
    join(stageDir, 'general', name, 'general.md'),
    join(GLOBAL_AGENTS, name, 'general.md'),
    `general/${name}/general.md (Tier 1)`,
  );
}

// ── Import memory files ──────────────────────────────────────────────────────

if (manifest.includes.memories) {
  console.log('\nMemory files:');

  // MEMORY.md index
  importFile(
    join(stageDir, 'memory/MEMORY.md'),
    join(PROJECT_MEMORY, 'MEMORY.md'),
    'MEMORY.md',
  );

  // All other .md files in memory root (feedback, project, reference, user)
  const memoryDir = join(stageDir, 'memory');
  if (existsSync(memoryDir)) {
    const memFiles = readdirSync(memoryDir).filter(
      (f) => f.endsWith('.md') && f !== 'MEMORY.md',
    );
    for (const file of memFiles) {
      const srcPath = join(memoryDir, file);
      if (statSync(srcPath).isFile()) {
        importFile(srcPath, join(PROJECT_MEMORY, file), file);
      }
    }
  }
}

// ── Clean up and summary ─────────────────────────────────────────────────────

rmSync(tmpDir, { recursive: true });

console.log('\n--- Summary ---');
console.log(`Imported:    ${imported}`);
console.log(`Skipped:     ${skipped}`);
console.log(`Overwritten: ${overwritten}`);

if (DRY_RUN) {
  console.log('\n(Dry run: no files written. Remove --dry-run to import.)');
}
