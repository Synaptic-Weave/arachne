export interface GatewayEmbeddingProvider {
  name: string;
  provider: string;
  model: string;
}

/**
 * Query the gateway for available embedding providers.
 * Returns empty array if gateway is unreachable or has no providers.
 */
export async function discoverEmbeddingProviders(
  gatewayUrl: string,
  registryToken: string,
): Promise<GatewayEmbeddingProvider[]> {
  try {
    const res = await fetch(`${gatewayUrl}/v1/registry/embedding-providers`, {
      headers: { Authorization: `Bearer ${registryToken}` },
    });

    if (!res.ok) return [];

    const data = (await res.json()) as { providers?: GatewayEmbeddingProvider[] };
    return data.providers ?? [];
  } catch {
    return [];
  }
}

/**
 * Generate embeddings via the gateway's embedding proxy.
 */
export async function embedViaGateway(
  gatewayUrl: string,
  registryToken: string,
  texts: string[],
  providerName?: string,
): Promise<{ embeddings: number[][]; model: string; dimensions: number }> {
  const body: Record<string, unknown> = { texts };
  if (providerName) body.provider = providerName;

  const res = await fetch(`${gatewayUrl}/v1/registry/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${registryToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gateway embeddings API error ${res.status}: ${errBody}`);
  }

  const data = (await res.json()) as {
    embeddings: number[][];
    model: string;
    dimensions: number;
  };

  return data;
}
