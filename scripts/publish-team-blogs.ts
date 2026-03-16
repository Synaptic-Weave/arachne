#!/usr/bin/env npx tsx
/**
 * Publish Team Blog Entries
 *
 * Reads each agent's blog.md from the memory directory, splits into
 * individual entries, and generates Astro-compatible markdown files
 * in site/src/content/blog/ under a developer-blogs section.
 *
 * Usage:
 *   npx tsx scripts/publish-team-blogs.ts
 *   npx tsx scripts/publish-team-blogs.ts --dry-run
 *
 * Each entry becomes: site/src/content/blog/{date}-{agent}-{slug}.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DRY_RUN = process.argv.includes('--dry-run');

const MEMORY_BASE = resolve(
  process.env.HOME ?? '~',
  '.claude/projects/-Users-michaelbrown-projects-loom/memory/agents',
);
const BLOG_OUTPUT = resolve(__dirname, '../site/src/content/devblog');

interface AgentMeta {
  name: string;
  displayName: string;
  role: string;
}

const AGENTS: AgentMeta[] = [
  { name: 'neo', displayName: 'Neo', role: 'Product Vision Interpreter' },
  { name: 'morpheus', displayName: 'Morpheus', role: 'Scrum Master' },
  { name: 'architect', displayName: 'Architect', role: 'Domain Modeling Expert' },
  { name: 'trinity', displayName: 'Trinity', role: 'UX Architect' },
  { name: 'tank', displayName: 'Tank', role: 'Backend Engineer' },
  { name: 'switch', displayName: 'Switch', role: 'Frontend Engineer' },
  { name: 'oracle', displayName: 'Oracle', role: 'AI Systems Advisor' },
  { name: 'mouse', displayName: 'Mouse', role: 'Test Engineer' },
  { name: 'niobe', displayName: 'Niobe', role: 'Security Engineer' },
  { name: 'cipher', displayName: 'Cipher', role: 'Pentester' },
  { name: 'smith', displayName: 'Agent Smith', role: 'Code Review & Quality' },
  { name: 'merovingian', displayName: 'Merovingian', role: 'System Impact Analyst' },
];

interface BlogEntry {
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM
  title: string;
  content: string;
  agent: AgentMeta;
}

/**
 * Parse a blog.md file into individual entries.
 * Format: ### YYYY-MM-DD HH:MM — Title\n\nContent\n\n---
 */
function parseBlog(markdown: string, agent: AgentMeta): BlogEntry[] {
  const entries: BlogEntry[] = [];
  // Match ### date time — title
  const entryPattern = /^### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) — (.+)$/gm;
  const matches = [...markdown.matchAll(entryPattern)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const [, date, time, title] = match;
    const startIdx = match.index! + match[0].length;
    const endIdx = i + 1 < matches.length
      ? matches[i + 1].index!
      : markdown.length;

    let content = markdown.slice(startIdx, endIdx).trim();
    // Remove trailing --- separator
    content = content.replace(/\n---\s*$/, '').trim();

    if (content) {
      entries.push({ date, time, title, content, agent });
    }
  }

  return entries;
}

/**
 * Generate a URL-friendly slug from a title.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Generate Astro-compatible frontmatter + content for a blog entry.
 */
function renderPost(entry: BlogEntry): string {
  const slug = slugify(entry.title);
  const tags = ['developer-blog', 'building-arachne', entry.agent.name];

  return `---
title: "${entry.title}"
date: ${entry.date}
author: ${entry.agent.displayName}
description: "${entry.agent.displayName} (${entry.agent.role}) writes about building Arachne."
tags:
${tags.map(t => `  - ${t}`).join('\n')}
series: "Building Arachne"
agentRole: "${entry.agent.role}"
---

*${entry.agent.displayName} is the ${entry.agent.role} on the Arachne development team.*

${entry.content}
`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!existsSync(BLOG_OUTPUT)) {
  mkdirSync(BLOG_OUTPUT, { recursive: true });
}

let totalEntries = 0;
let newEntries = 0;
const allEntries: BlogEntry[] = [];

for (const agent of AGENTS) {
  const blogPath = join(MEMORY_BASE, agent.name, 'blog.md');
  if (!existsSync(blogPath)) {
    console.log(`  skip ${agent.displayName} — no blog.md`);
    continue;
  }

  const markdown = readFileSync(blogPath, 'utf-8');
  const entries = parseBlog(markdown, agent);
  totalEntries += entries.length;
  allEntries.push(...entries);

  for (const entry of entries) {
    const slug = slugify(entry.title);
    const filename = `${entry.date}-${agent.name}-${slug}.md`;
    const filepath = join(BLOG_OUTPUT, filename);

    if (existsSync(filepath)) {
      continue; // Already published, skip
    }

    newEntries++;
    const content = renderPost(entry);

    if (DRY_RUN) {
      console.log(`  [dry-run] would create: ${filename}`);
    } else {
      writeFileSync(filepath, content, 'utf-8');
      console.log(`  created: ${filename}`);
    }
  }
}

// Sort all entries by date for summary
allEntries.sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));

console.log(`\n--- Summary ---`);
console.log(`Total entries across all agents: ${totalEntries}`);
console.log(`New entries published: ${newEntries}`);
console.log(`Agents with blogs: ${AGENTS.filter(a => existsSync(join(MEMORY_BASE, a.name, 'blog.md'))).length}/${AGENTS.length}`);

if (DRY_RUN) {
  console.log(`\n(Dry run — no files written. Remove --dry-run to publish.)`);
}
