import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { gzip, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import type { EmbeddingAgentConfig } from './EmbeddingAgentService.js';

const gzipAsync = promisify(gzip) as (buf: Buffer) => Promise<Buffer>;
const inflateRawAsync = promisify(inflateRaw) as (buf: Buffer) => Promise<Buffer>;

// ─── Spec Interfaces ─────────────────────────────────────────────────────────

export interface KnowledgeBaseSpec {
  apiVersion: 'arachne-ai.com/v0';
  kind: 'KnowledgeBase';
  metadata: { name: string };
  spec: {
    docsPath: string;
    embedder?: { agentRef: string };
    chunking?: { tokenSize?: number; overlap?: number };
    retrieval?: { topK?: number; citations?: boolean };
  };
}

export interface EmbeddingAgentSpec {
  apiVersion: 'arachne-ai.com/v0';
  kind: 'EmbeddingAgent';
  metadata: { name: string };
  spec: {
    provider: string;
    model: string;
    knowledgeBaseRef?: string;
  };
}

export interface AgentSpec {
  apiVersion: 'arachne-ai.com/v0';
  kind: 'Agent';
  metadata: { name: string };
  spec: {
    model: string;
    systemPrompt: string;
    knowledgeBaseRef?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

export type AnySpec = KnowledgeBaseSpec | EmbeddingAgentSpec | AgentSpec;

export interface WeaveResult {
  bundlePath: string;
  sha256: string;
  chunkCount?: number;
  vectorSpaceId?: string;
}

// ─── Minimal YAML Parser ─────────────────────────────────────────────────────

function parseYamlValue(raw: string): string | number | boolean | null {
  const stripped = raw.indexOf(' #') > 0 ? raw.slice(0, raw.indexOf(' #')).trim() : raw;
  if (stripped === 'true') return true;
  if (stripped === 'false') return false;
  if (stripped === 'null' || stripped === '~') return null;
  if (
    (stripped.startsWith('"') && stripped.endsWith('"')) ||
    (stripped.startsWith("'") && stripped.endsWith("'"))
  ) {
    return stripped.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(stripped)) return Number(stripped);
  return stripped;
}

function parseSimpleYaml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
    { obj: root, indent: -1 },
  ];

  for (const line of content.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - trimmed.length;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    // Pop stack until we find the correct parent scope
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;

    if (!rawValue || rawValue.startsWith('#')) {
      // Nested object
      const nested: Record<string, unknown> = {};
      parent[key] = nested;
      stack.push({ obj: nested, indent });
    } else {
      parent[key] = parseYamlValue(rawValue);
    }
  }

  return root;
}

// ─── Minimal tar Builder ─────────────────────────────────────────────────────

function buildTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);

  // name (100 bytes)
  header.write(name.slice(0, 99), 0, 'utf8');
  // mode
  header.write('0000644\0', 100, 'ascii');
  // uid
  header.write('0000000\0', 108, 'ascii');
  // gid
  header.write('0000000\0', 116, 'ascii');
  // size (12 bytes, octal)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  // mtime (12 bytes, octal)
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
  // checksum placeholder (8 spaces)
  header.fill(0x20, 148, 156);
  // typeflag: regular file
  header.write('0', 156, 'ascii');
  // magic: ustar\0
  header.write('ustar\0', 257, 'ascii');
  // version: 00
  header.write('00', 263, 'ascii');

  // Compute and write checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');

  return header;
}

function buildTar(files: Array<{ path: string; data: Buffer }>): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    blocks.push(buildTarHeader(file.path, file.data.length));
    // Pad data to 512-byte boundary
    const padded = Buffer.alloc(Math.ceil(file.data.length / 512) * 512);
    file.data.copy(padded);
    blocks.push(padded);
  }

  // End-of-archive marker: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ─── ZIP Extractor ───────────────────────────────────────────────────────────

async function extractZip(
  data: Buffer,
): Promise<Array<{ filename: string; content: Buffer }>> {
  const files: Array<{ filename: string; content: Buffer }> = [];
  let offset = 0;

  while (offset + 30 <= data.length) {
    const sig = data.readUInt32LE(offset);

    // Central directory or EOCD → done scanning local headers
    if (sig === 0x02014b50 || sig === 0x06054b50) break;

    if (sig !== 0x04034b50) break; // Not a valid local file header

    const flags = data.readUInt16LE(offset + 6);
    const compressionMethod = data.readUInt16LE(offset + 8);
    const compressedSize = data.readUInt32LE(offset + 18);
    const filenameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);

    const filenameStart = offset + 30;
    const filename = data.toString('utf8', filenameStart, filenameStart + filenameLength);
    const dataStart = filenameStart + filenameLength + extraLength;

    if (!filename.endsWith('/') && compressedSize > 0) {
      const compressedData = data.subarray(dataStart, dataStart + compressedSize);
      let content: Buffer;

      if (compressionMethod === 0) {
        content = compressedData;
      } else if (compressionMethod === 8) {
        content = await inflateRawAsync(compressedData);
      } else {
        throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${filename}`);
      }

      files.push({ filename, content });
    }

    let nextOffset = dataStart + compressedSize;
    // If data descriptor flag set (bit 3), skip the 16-byte descriptor
    if (flags & 0x8) nextOffset += 16;
    offset = nextOffset;
  }

  return files;
}

// ─── WeaveService ────────────────────────────────────────────────────────────

export class WeaveService {
  /**
   * Parse and validate a YAML spec file. Returns a typed AnySpec.
   */
  async parseSpec(yamlPath: string): Promise<AnySpec> {
    const content = await readFile(yamlPath, 'utf8');
    const raw = parseSimpleYaml(content) as {
      apiVersion?: unknown;
      kind?: unknown;
      metadata?: unknown;
      spec?: unknown;
    };

    if (raw.apiVersion !== 'arachne-ai.com/v0') {
      throw new Error(`Invalid apiVersion: ${raw.apiVersion}. Expected "arachne-ai.com/v0"`);
    }

    const kind = raw.kind;
    if (kind !== 'KnowledgeBase' && kind !== 'EmbeddingAgent' && kind !== 'Agent') {
      throw new Error(`Unknown kind: ${kind}`);
    }

    return raw as AnySpec;
  }

  /**
   * Resolve docs from a docsPath:
   * - Directory → all files recursively
   * - .zip file → extract in-memory
   * - Single file → just that file
   */
  async resolveDocs(
    docsPath: string,
  ): Promise<Array<{ filename: string; content: Buffer }>> {
    const info = await stat(docsPath);

    if (info.isDirectory()) {
      return this._walkDir(docsPath, docsPath);
    }

    if (extname(docsPath).toLowerCase() === '.zip') {
      const data = await readFile(docsPath);
      return extractZip(data);
    }

    // Single file
    const content = await readFile(docsPath);
    return [{ filename: docsPath, content }];
  }

  private async _walkDir(
    dir: string,
    base: string,
  ): Promise<Array<{ filename: string; content: Buffer }>> {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: Array<{ filename: string; content: Buffer }> = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this._walkDir(fullPath, base)));
      } else {
        const content = await readFile(fullPath);
        // Store relative path from base for source tracking
        const filename = fullPath.slice(base.length).replace(/^[/\\]/, '');
        results.push({ filename, content });
      }
    }

    return results;
  }

  /**
   * Chunk text into overlapping token windows.
   * Uses word-based approximation: 1 token ≈ 4 chars.
   */
  chunkText(text: string, tokenSize: number, overlap: number): string[] {
    const charSize = tokenSize * 4;
    const charOverlap = overlap * 4;
    const step = charSize - charOverlap;

    if (step <= 0) throw new Error('overlap must be less than tokenSize');

    const trimmed = text.trim();
    if (!trimmed) return [];
    if (trimmed.length <= charSize) return [trimmed];

    const chunks: string[] = [];
    let start = 0;

    while (start < trimmed.length) {
      let end = start + charSize;

      if (end >= trimmed.length) {
        const tail = trimmed.slice(start).trim();
        if (tail) chunks.push(tail);
        break;
      }

      // Align to word boundary: find last space before end
      const boundary = trimmed.lastIndexOf(' ', end);
      if (boundary > start + step / 2) end = boundary;

      const chunk = trimmed.slice(start, end).trim();
      if (chunk) chunks.push(chunk);
      start += step;
    }

    return chunks;
  }

  /**
   * Generate embeddings via the configured provider API.
   * Batches internally at 100 texts per request.
   * Accepts either full EmbeddingAgentConfig or legacy (provider, model, apiKey) args.
   */
  async embedTexts(
    texts: string[],
    providerOrConfig: string | EmbeddingAgentConfig,
    model?: string,
    apiKey?: string,
  ): Promise<number[][]> {
    // Normalize to config object
    const config: EmbeddingAgentConfig = typeof providerOrConfig === 'string'
      ? { provider: providerOrConfig, model: model!, dimensions: 0, apiKey }
      : providerOrConfig;

    const BATCH_SIZE = 100;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);

      let url: string;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      let body: object;

      if (config.provider === 'azure') {
        const baseUrl = config.baseUrl ?? '';
        const deployment = config.deployment ?? config.model;
        const apiVersion = config.apiVersion ?? '2024-02-01';
        url = `${baseUrl}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`;
        headers['api-key'] = config.apiKey ?? '';
        body = { input: batch };
      } else if (config.provider === 'ollama') {
        const baseUrl = config.baseUrl ?? 'http://localhost:11434';
        url = `${baseUrl}/api/embeddings`;
        // Ollama /api/embeddings takes a single prompt; batch one at a time
        for (const text of batch) {
          const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: config.model, prompt: text }),
          });
          if (!resp.ok) {
            const errBody = await resp.text();
            throw new Error(`Ollama embeddings API error ${resp.status}: ${errBody}`);
          }
          const json = (await resp.json()) as { embedding: number[] };
          allEmbeddings.push(json.embedding);
        }
        continue; // Skip the common fetch below — already handled per-text
      } else {
        // OpenAI or OpenAI-compatible
        const baseUrl = config.baseUrl ?? 'https://api.openai.com';
        url = `${baseUrl}/v1/embeddings`;
        headers['Authorization'] = `Bearer ${config.apiKey ?? ''}`;
        body = { model: config.model, input: batch };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Embeddings API error ${response.status}: ${errBody}`);
      }

      const json = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Sort by index to preserve order
      const sorted = json.data.slice().sort((a, b) => a.index - b.index);
      allEmbeddings.push(...sorted.map((d) => d.embedding));
    }

    return allEmbeddings;
  }

  /**
   * Compute SHA-256 of chunking + embedding config for VectorSpace fingerprint.
   */
  computePreprocessingHash(config: {
    provider: string;
    model: string;
    tokenSize: number;
    overlap: number;
  }): string {
    return createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex');
  }

  /**
   * Package chunks + metadata into a .tgz bundle.
   * Signs with HMAC-SHA256 using BUNDLE_SIGNING_SECRET env var.
   */
  async packageBundle(
    spec: AnySpec,
    chunks: Array<{
      content: string;
      sourcePath: string;
      tokenCount: number;
      embedding: number[];
    }>,
    vectorSpace: {
      provider: string;
      model: string;
      dimensions: number;
      preprocessingHash: string;
    },
  ): Promise<{ bundle: Buffer; sha256: string; signature: string }> {
    const manifest = {
      kind: spec.kind,
      name: spec.metadata.name,
      version: new Date().toISOString(),
      chunkCount: chunks.length,
      vectorSpace: {
        provider: vectorSpace.provider,
        model: vectorSpace.model,
        dimensions: vectorSpace.dimensions,
      },
    };

    const tarFiles: Array<{ path: string; data: Buffer }> = [
      {
        path: 'manifest.json',
        data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      },
    ];

    for (let i = 0; i < chunks.length; i++) {
      tarFiles.push({
        path: `chunks/${i}.json`,
        data: Buffer.from(JSON.stringify(chunks[i]), 'utf8'),
      });
    }

    const tarBuf = buildTar(tarFiles);
    const bundle = await gzipAsync(tarBuf);
    const sha256 = createHash('sha256').update(bundle).digest('hex');

    const secret = process.env['BUNDLE_SIGNING_SECRET'];
    const signature = secret
      ? createHmac('sha256', secret).update(bundle).digest('hex')
      : '';

    if (!secret) {
      console.warn('⚠️  WARNING: BUNDLE_SIGNING_SECRET is not set. Bundle will not be signed.');
    }

    return { bundle, sha256, signature };
  }

  /**
   * Main entry point: weave a KnowledgeBase spec end-to-end.
   */
  async weaveKnowledgeBase(
    yamlPath: string,
    outputDir: string,
    tenantId: string,
    em?: unknown,
  ): Promise<WeaveResult> {
    const spec = await this.parseSpec(yamlPath);

    if (spec.kind !== 'KnowledgeBase') {
      throw new Error(`Expected KnowledgeBase spec, got ${spec.kind}`);
    }

    const kbSpec = spec as KnowledgeBaseSpec;
    const tokenSize = kbSpec.spec.chunking?.tokenSize ?? 650;
    const overlap = kbSpec.spec.chunking?.overlap ?? 120;

    // Resolve embedder config
    let provider: string;
    let model: string;
    let apiKey: string;

    if (kbSpec.spec.embedder?.agentRef && em) {
      // Future: resolve EmbeddingAgent from tenant DB via em
      // For P0 — fall through to system embedder
      provider = process.env['SYSTEM_EMBEDDER_PROVIDER'] ?? '';
      model = process.env['SYSTEM_EMBEDDER_MODEL'] ?? '';
      apiKey = process.env['SYSTEM_EMBEDDER_API_KEY'] ?? '';
    } else {
      provider = process.env['SYSTEM_EMBEDDER_PROVIDER'] ?? '';
      model = process.env['SYSTEM_EMBEDDER_MODEL'] ?? '';
      apiKey = process.env['SYSTEM_EMBEDDER_API_KEY'] ?? '';
    }

    if (!provider || !model || !apiKey) {
      throw new Error(
        'Embedding provider not configured. Set SYSTEM_EMBEDDER_PROVIDER, SYSTEM_EMBEDDER_MODEL, and SYSTEM_EMBEDDER_API_KEY.',
      );
    }

    // Resolve and read docs
    const docs = await this.resolveDocs(kbSpec.spec.docsPath);

    // Chunk all docs
    const rawChunks: Array<{ content: string; sourcePath: string }> = [];
    for (const doc of docs) {
      const text = doc.content.toString('utf8');
      const textChunks = this.chunkText(text, tokenSize, overlap);
      for (const chunk of textChunks) {
        rawChunks.push({ content: chunk, sourcePath: doc.filename });
      }
    }

    if (rawChunks.length === 0) {
      throw new Error('No chunks produced from docs. Check docsPath and content.');
    }

    // Embed all chunks (batched at 100)
    const texts = rawChunks.map((c) => c.content);
    const embeddings = await this.embedTexts(texts, provider, model, apiKey);

    // Infer dimensions from first embedding
    const dimensions = embeddings[0]?.length ?? 0;

    const preprocessingHash = this.computePreprocessingHash({
      provider,
      model,
      tokenSize,
      overlap,
    });

    const chunks = rawChunks.map((c, i) => ({
      content: c.content,
      sourcePath: c.sourcePath,
      tokenCount: Math.ceil(c.content.length / 4),
      embedding: embeddings[i] ?? [],
    }));

    const vectorSpace = { provider, model, dimensions, preprocessingHash };
    const { bundle, sha256, signature: _signature } = await this.packageBundle(
      spec,
      chunks,
      vectorSpace,
    );

    // Write bundle to outputDir
    await mkdir(outputDir, { recursive: true });
    const bundleFilename = `${kbSpec.metadata.name}.tgz`;
    const bundlePath = join(outputDir, bundleFilename);
    await writeFile(bundlePath, bundle);

    return {
      bundlePath,
      sha256,
      chunkCount: chunks.length,
      vectorSpaceId: preprocessingHash,
    };
  }

  /**
   * Weave an EmbeddingAgent or Agent spec — package spec as a config bundle.
   */
  async weaveConfigArtifact(yamlPath: string, outputDir: string): Promise<WeaveResult> {
    const spec = await this.parseSpec(yamlPath);

    if (spec.kind !== 'Agent' && spec.kind !== 'EmbeddingAgent') {
      throw new Error(`weaveConfigArtifact expects Agent or EmbeddingAgent, got ${spec.kind}`);
    }

    const tarFiles: Array<{ path: string; data: Buffer }> = [
      {
        path: 'manifest.json',
        data: Buffer.from(
          JSON.stringify(
            {
              kind: spec.kind,
              name: spec.metadata.name,
              version: new Date().toISOString(),
            },
            null,
            2,
          ),
          'utf8',
        ),
      },
      {
        path: 'spec.json',
        data: Buffer.from(JSON.stringify(spec, null, 2), 'utf8'),
      },
    ];

    const tarBuf = buildTar(tarFiles);
    const bundle = await gzipAsync(tarBuf);
    const sha256 = createHash('sha256').update(bundle).digest('hex');

    const secret = process.env['BUNDLE_SIGNING_SECRET'];
    if (!secret) {
      console.warn('⚠️  WARNING: BUNDLE_SIGNING_SECRET is not set. Bundle will not be signed.');
    }

    await mkdir(outputDir, { recursive: true });
    const bundleFilename = `${spec.metadata.name}.tgz`;
    const bundlePath = join(outputDir, bundleFilename);
    await writeFile(bundlePath, bundle);

    return { bundlePath, sha256 };
  }
}
