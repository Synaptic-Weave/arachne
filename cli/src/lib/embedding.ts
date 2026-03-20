import { createHash } from 'crypto';

export interface EmbeddingConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  deployment?: string;
  apiVersion?: string;
}

/**
 * Known embedding dimensions by model name.
 */
const KNOWN_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export function getDimensions(model: string): number {
  return KNOWN_DIMENSIONS[model] ?? 1536;
}

/**
 * Chunk text into overlapping token windows.
 * Uses word-based approximation: 1 token ~ 4 chars.
 */
export function chunkText(text: string, tokenSize: number, overlap: number): string[] {
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
 */
export async function embedTexts(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
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
      continue; // Skip the common fetch below
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
export function computePreprocessingHash(config: {
  provider: string;
  model: string;
  tokenSize: number;
  overlap: number;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex');
}
