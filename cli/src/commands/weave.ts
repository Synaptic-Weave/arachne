import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { tarDirectory } from '../lib/zip.js';

interface SpecFields {
  kind: string;
  name: string;
  docsPath?: string;
}

function parseSpec(yaml: string): SpecFields {
  const kindMatch = yaml.match(/^kind:\s*(\S+)/m);
  const nameMatch = yaml.match(/^\s+name:\s*(\S+)/m);
  const docsPathMatch = yaml.match(/^\s+docsPath:\s*(\S+)/m);

  if (!kindMatch) throw new Error('Missing "kind" in spec YAML');
  if (!nameMatch) throw new Error('Missing "metadata.name" in spec YAML');

  return {
    kind: kindMatch[1].trim(),
    name: nameMatch[1].trim(),
    docsPath: docsPathMatch?.[1].trim(),
  };
}

// Minimal tar archive builder (no external dependencies)
function createTarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  const nameBytes = Buffer.from(name, 'utf8');
  nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));

  // File mode (0644)
  Buffer.from('0000644\0', 'ascii').copy(header, 100);
  // Owner/group id
  Buffer.from('0001000\0', 'ascii').copy(header, 108);
  Buffer.from('0001000\0', 'ascii').copy(header, 116);
  // File size (octal, 11 chars + null)
  Buffer.from(data.length.toString(8).padStart(11, '0') + '\0', 'ascii').copy(header, 124);
  // Modification time
  const mtime = Math.floor(Date.now() / 1000);
  Buffer.from(mtime.toString(8).padStart(11, '0') + '\0', 'ascii').copy(header, 136);
  // Type flag: regular file
  header[156] = 0x30; // '0'
  // USTAR indicator
  Buffer.from('ustar\0', 'ascii').copy(header, 257);
  Buffer.from('00', 'ascii').copy(header, 263);

  // Compute checksum (sum of all bytes, treating checksum field as spaces)
  Buffer.from('        ', 'ascii').copy(header, 148);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);

  // Pad data to 512-byte boundary
  const paddingLen = (512 - (data.length % 512)) % 512;
  const padding = Buffer.alloc(paddingLen, 0);

  return Buffer.concat([header, data, padding]);
}

function buildOrbBundle(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts = entries.map(e => createTarEntry(e.name, e.data));
  // End-of-archive marker (two 512-byte zero blocks)
  parts.push(Buffer.alloc(1024, 0));
  const tarBuffer = Buffer.concat(parts);
  return gzipSync(tarBuffer);
}

export const weaveCommand = new Command('weave')
  .description('Weave a KnowledgeBase or Agent YAML spec into an artifact bundle (.orb)')
  .argument('<spec>', 'Path to the YAML spec file (KnowledgeBase or Agent)')
  .option('-o, --output <dir>', 'Output directory for the bundle', 'dist')
  .action(async (specPath: string, options: { output: string }) => {
    const specFile = resolve(specPath);

    if (!existsSync(specFile)) {
      console.error(`Error: spec file not found: ${specFile}`);
      process.exit(1);
    }

    const specContent = readFileSync(specFile, 'utf8');
    const { kind, name, docsPath } = parseSpec(specContent);

    // Build bundle entries
    const entries: Array<{ name: string; data: Buffer }> = [
      { name: 'spec.yaml', data: Buffer.from(specContent, 'utf8') },
    ];

    // Include docs if specified
    if (docsPath) {
      const absDocsPath = resolve(dirname(specFile), docsPath);
      if (existsSync(absDocsPath)) {
        const stat = statSync(absDocsPath);
        if (stat.isDirectory()) {
          const tarBuf = await tarDirectory(absDocsPath);
          entries.push({ name: 'docs/docs.tgz', data: tarBuf });
        } else {
          const buf = readFileSync(absDocsPath);
          entries.push({ name: `docs/${basename(absDocsPath)}`, data: buf });
        }
      }
    }

    // Compute content hash
    const contentHash = createHash('sha256');
    for (const entry of entries) {
      contentHash.update(entry.data);
    }
    const sha256 = contentHash.digest('hex');

    // Add manifest
    const manifest = {
      kind,
      name,
      version: '1.0.0',
      sha256,
      createdAt: new Date().toISOString(),
    };
    entries.push({
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    });

    // Build and write the .orb bundle
    const bundle = buildOrbBundle(entries);
    const outDir = resolve(options.output);
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, `${name}.orb`);
    writeFileSync(outPath, bundle);

    console.log(`✓ Wove ${kind} artifact → ${outPath} (${(bundle.length / 1024).toFixed(1)} KB)`);
  });
