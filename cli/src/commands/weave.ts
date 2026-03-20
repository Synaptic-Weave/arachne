import { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'fs';
import { resolve, basename, dirname, join, extname } from 'path';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { chunkText, embedTexts, computePreprocessingHash, getDimensions } from '../lib/embedding.js';
import { buildTar } from '../lib/tar.js';
import type { EmbeddingConfig } from '../lib/embedding.js';

interface SpecFields {
  kind: string;
  name: string;
  docsPath?: string;
  tokenSize?: number;
  overlap?: number;
  embedder?: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    deployment?: string;
    apiVersion?: string;
  };
}

function parseSpec(yaml: string): SpecFields {
  const kindMatch = yaml.match(/^kind:\s*(\S+)/m);
  const nameMatch = yaml.match(/^\s+name:\s*(\S+)/m);
  const docsPathMatch = yaml.match(/^\s+docsPath:\s*(\S+)/m);

  if (!kindMatch) throw new Error('Missing "kind" in spec YAML');
  if (!nameMatch) throw new Error('Missing "metadata.name" in spec YAML');

  // Parse chunking config
  const tokenSizeMatch = yaml.match(/^\s+tokenSize:\s*(\d+)/m);
  const overlapMatch = yaml.match(/^\s+overlap:\s*(\d+)/m);

  // Parse embedder config
  let embedder: SpecFields['embedder'];
  const embedderBlock = yaml.match(/^\s+embedder:\s*\n((?:\s+\w+:.*\n?)*)/m);
  if (embedderBlock) {
    const block = embedderBlock[1];
    const prov = block.match(/provider:\s*(\S+)/);
    const mod = block.match(/model:\s*(\S+)/);
    const key = block.match(/apiKey:\s*(\S+)/);
    const base = block.match(/baseUrl:\s*(\S+)/);
    const depl = block.match(/deployment:\s*(\S+)/);
    const ver = block.match(/apiVersion:\s*(\S+)/);
    embedder = {
      provider: prov?.[1],
      model: mod?.[1],
      apiKey: key?.[1],
      baseUrl: base?.[1],
      deployment: depl?.[1],
      apiVersion: ver?.[1],
    };
  }

  return {
    kind: kindMatch[1].trim(),
    name: nameMatch[1].trim(),
    docsPath: docsPathMatch?.[1].trim(),
    tokenSize: tokenSizeMatch ? parseInt(tokenSizeMatch[1], 10) : undefined,
    overlap: overlapMatch ? parseInt(overlapMatch[1], 10) : undefined,
    embedder,
  };
}

/**
 * Recursively collect doc files (.md, .txt, .html) from a directory.
 */
function collectDocs(dir: string): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];
  const EXTENSIONS = new Set(['.md', '.txt', '.html']);

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        results.push({
          path: entry.name,
          content: readFileSync(fullPath, 'utf8'),
        });
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Resolve embedding config from spec, env vars, or system fallback.
 */
function resolveEmbeddingConfig(specEmbedder?: SpecFields['embedder']): EmbeddingConfig {
  // Priority 1: spec.embedder fields
  if (specEmbedder?.provider && specEmbedder?.model) {
    return {
      provider: specEmbedder.provider,
      model: specEmbedder.model,
      apiKey: specEmbedder.apiKey,
      baseUrl: specEmbedder.baseUrl,
      deployment: specEmbedder.deployment,
      apiVersion: specEmbedder.apiVersion,
    };
  }

  // Priority 2: ARACHNE_EMBED_* env vars
  const aProvider = process.env['ARACHNE_EMBED_PROVIDER'];
  const aModel = process.env['ARACHNE_EMBED_MODEL'];
  const aKey = process.env['ARACHNE_EMBED_API_KEY'];
  if (aProvider && aModel) {
    return { provider: aProvider, model: aModel, apiKey: aKey };
  }

  // Priority 3: SYSTEM_EMBEDDER_* env vars
  const sProvider = process.env['SYSTEM_EMBEDDER_PROVIDER'];
  const sModel = process.env['SYSTEM_EMBEDDER_MODEL'];
  const sKey = process.env['SYSTEM_EMBEDDER_API_KEY'];
  if (sProvider && sModel) {
    return { provider: sProvider, model: sModel, apiKey: sKey };
  }

  throw new Error(
    'No embedding provider configured. Set spec.embedder, ARACHNE_EMBED_PROVIDER/MODEL, or SYSTEM_EMBEDDER_PROVIDER/MODEL.',
  );
}

export const weaveCommand = new Command('weave')
  .description('Weave a KnowledgeBase or Agent YAML spec into a signed artifact bundle')
  .argument('<spec>', 'Path to the YAML spec file (KnowledgeBase or Agent)')
  .option('-o, --output <dir>', 'Output directory for the bundle', 'dist')
  .action(async (specPath: string, options: { output: string }) => {
    const specFile = resolve(specPath);

    if (!existsSync(specFile)) {
      console.error(`Error: spec file not found: ${specFile}`);
      process.exit(1);
    }

    const specContent = readFileSync(specFile, 'utf8');
    const spec = parseSpec(specContent);

    if (spec.kind === 'KnowledgeBase') {
      await weaveKnowledgeBase(specFile, specContent, spec, options.output);
    } else {
      weaveLocal(specFile, specContent, spec, options.output);
    }
  });

/**
 * Local KB weave: chunk docs, embed, package into .orb locally.
 */
async function weaveKnowledgeBase(
  specFile: string,
  specContent: string,
  spec: SpecFields,
  outputDir: string,
) {
  const tokenSize = spec.tokenSize ?? 650;
  const overlap = spec.overlap ?? 120;

  // Resolve docs
  if (!spec.docsPath) {
    console.error('Error: KnowledgeBase spec requires docsPath');
    process.exit(1);
  }

  const absDocsPath = resolve(dirname(specFile), spec.docsPath);
  if (!existsSync(absDocsPath)) {
    console.error(`Error: docsPath not found: ${spec.docsPath}`);
    process.exit(1);
  }

  let docs: Array<{ path: string; content: string }>;
  const stat = statSync(absDocsPath);
  if (stat.isDirectory()) {
    docs = collectDocs(absDocsPath);
  } else {
    docs = [{ path: basename(absDocsPath), content: readFileSync(absDocsPath, 'utf8') }];
  }

  if (docs.length === 0) {
    console.error('Error: no docs found at docsPath');
    process.exit(1);
  }

  // Chunk all docs
  console.log(`Chunking docs...`);
  const rawChunks: Array<{ content: string; sourcePath: string }> = [];
  for (const doc of docs) {
    const textChunks = chunkText(doc.content, tokenSize, overlap);
    for (const chunk of textChunks) {
      rawChunks.push({ content: chunk, sourcePath: doc.path });
    }
  }

  if (rawChunks.length === 0) {
    console.error('Error: no chunks produced. Check docsPath and content.');
    process.exit(1);
  }

  console.log(`${rawChunks.length} chunks`);

  // Resolve embedding config
  const embeddingConfig = resolveEmbeddingConfig(spec.embedder);

  // Embed all chunks
  console.log(`Embedding ${rawChunks.length} chunks...`);
  const texts = rawChunks.map((c) => c.content);
  const embeddings = await embedTexts(texts, embeddingConfig);

  // Infer dimensions from first embedding or use known map
  const dimensions = embeddings[0]?.length ?? getDimensions(embeddingConfig.model);

  const preprocessingHash = computePreprocessingHash({
    provider: embeddingConfig.provider,
    model: embeddingConfig.model,
    tokenSize,
    overlap,
  });

  const chunks = rawChunks.map((c, i) => ({
    content: c.content,
    sourcePath: c.sourcePath,
    tokenCount: Math.ceil(c.content.length / 4),
    embedding: embeddings[i] ?? [],
  }));

  // Build manifest
  const manifest = {
    kind: spec.kind,
    name: spec.name,
    version: new Date().toISOString(),
    chunkCount: chunks.length,
    vectorSpace: {
      provider: embeddingConfig.provider,
      model: embeddingConfig.model,
      dimensions,
      preprocessingHash,
    },
  };

  // Build tar files
  const tarFiles: Array<{ path: string; data: Buffer }> = [
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { path: 'spec.yaml', data: Buffer.from(specContent, 'utf8') },
  ];

  for (let i = 0; i < chunks.length; i++) {
    tarFiles.push({
      path: `chunks/${i}.json`,
      data: Buffer.from(JSON.stringify(chunks[i]), 'utf8'),
    });
  }

  const tarBuf = buildTar(tarFiles);
  const bundle = gzipSync(tarBuf);
  const sha256 = createHash('sha256').update(bundle).digest('hex');

  // Write bundle
  const outDir = resolve(outputDir);
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${spec.name}.orb`);
  writeFileSync(outPath, bundle);

  console.log(`Wove KnowledgeBase artifact -> ${outPath}`);
  console.log(`  SHA-256: ${sha256}`);
  console.log(`  Chunks: ${chunks.length}`);
  console.log(`  Dimensions: ${dimensions}`);
}

/**
 * Local weave for Agent/EmbeddingAgent: bundle spec + optional docs into .orb locally.
 */
function weaveLocal(
  specFile: string,
  specContent: string,
  spec: SpecFields,
  outputDir: string,
) {
  const tarFiles: Array<{ path: string; data: Buffer }> = [
    { path: 'spec.yaml', data: Buffer.from(specContent, 'utf8') },
  ];

  // Include docs if specified
  if (spec.docsPath) {
    const absDocsPath = resolve(dirname(specFile), spec.docsPath);
    if (existsSync(absDocsPath)) {
      const stat = statSync(absDocsPath);
      if (stat.isDirectory()) {
        const docs = collectDocs(absDocsPath);
        for (const doc of docs) {
          tarFiles.push({ path: `docs/${doc.path}`, data: Buffer.from(doc.content, 'utf8') });
        }
      } else {
        tarFiles.push({ path: `docs/${basename(absDocsPath)}`, data: readFileSync(absDocsPath) });
      }
    }
  }

  // Compute content hash
  const contentHash = createHash('sha256');
  for (const f of tarFiles) contentHash.update(f.data);
  const sha256 = contentHash.digest('hex');

  // Add manifest
  const manifest = { kind: spec.kind, name: spec.name, version: '1.0.0', sha256, createdAt: new Date().toISOString() };
  tarFiles.push({ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

  const tarBuf = buildTar(tarFiles);
  const bundle = gzipSync(tarBuf);
  const outDir = resolve(outputDir);
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${spec.name}.orb`);
  writeFileSync(outPath, bundle);

  console.log(`\u2713 Wove ${spec.kind} artifact \u2192 ${outPath} (${(bundle.length / 1024).toFixed(1)} KB)`);
}
