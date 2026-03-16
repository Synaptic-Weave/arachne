import { request } from 'undici';
import { BaseProvider } from './base.js';
import { ProxyRequest, ProxyResponse, ProviderConfig } from '../types/openai.js';

export interface AzureProviderConfig extends ProviderConfig {
  /** Azure OpenAI resource endpoint, e.g. https://my-resource.openai.azure.com */
  endpoint: string;
  /** Default deployment name as configured in Azure AI Studio */
  deployment: string;
  /** Azure OpenAI API version, e.g. 2024-02-01 */
  apiVersion: string;
  /** Optional map of model name → Azure deployment name, e.g. { "gpt-4o": "gpt-4o", "gpt-4o-mini": "gpt4o-mini" } */
  deploymentMap?: Record<string, string>;
}

/**
 * Azure OpenAI provider adapter.
 *
 * Key differences from the OpenAI provider:
 * - URL: deployment-based routing via {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...
 * - Auth: "api-key" header instead of "Authorization: Bearer ..."
 * - Errors: Azure wraps errors with additional innerError; mapped to OpenAI format on return
 */
export class AzureProvider extends BaseProvider {
  name = 'azure';

  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly apiVersion: string;
  private readonly deploymentMap: Record<string, string>;

  constructor(config: AzureProviderConfig) {
    super(config);
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.deployment = config.deployment;
    this.apiVersion = config.apiVersion;
    this.deploymentMap = config.deploymentMap ?? {};
  }

  async proxy(proxyReq: ProxyRequest): Promise<ProxyResponse> {
    // Resolve deployment: deploymentMap override → default deployment → request model name
    const requestModel = (proxyReq.body as any)?.model;
    const deployment = (requestModel && this.deploymentMap[requestModel])
      || this.deployment
      || requestModel;

    const url =
      `${this.endpoint}/openai/deployments/${deployment}` +
      `/chat/completions?api-version=${this.apiVersion}`;

    const headers: Record<string, string> = {
      'api-key': this.config.apiKey,   // Azure uses api-key, not Authorization: Bearer
      'Content-Type': 'application/json',
    };

    // Forward request-id for end-to-end tracing
    if (proxyReq.headers['x-request-id']) {
      headers['x-request-id'] = proxyReq.headers['x-request-id'];
    }

    const response = await request(url, {
      method: proxyReq.method,
      headers,
      body: proxyReq.body ? JSON.stringify(proxyReq.body) : undefined,
    });

    // Normalise response headers
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') {
        responseHeaders[key] = value;
      } else if (Array.isArray(value)) {
        responseHeaders[key] = value.join(', ');
      }
    }

    const contentType = responseHeaders['content-type'] ?? '';

    // Streaming — pass the body stream through unchanged
    if (contentType.includes('text/event-stream')) {
      return {
        status: response.statusCode,
        headers: responseHeaders,
        body: null,
        stream: response.body as any,
      };
    }

    // Non-streaming
    if (contentType.includes('application/json')) {
      const raw = (await response.body.json()) as any;
      const body =
        raw?.error && response.statusCode >= 400
          ? mapAzureError(raw.error, response.statusCode)
          : raw;

      return { status: response.statusCode, headers: responseHeaders, body };
    }

    const body = await response.body.text();
    return { status: response.statusCode, headers: responseHeaders, body };
  }
}

/**
 * Map Azure's error envelope to the OpenAI-compatible error shape so callers
 * don't need to handle two different formats.
 *
 * Azure:  { error: { code, message, innerError?, status? } }
 * OpenAI: { error: { message, type, code, param } }
 */
function mapAzureError(azureError: any, statusCode: number): any {
  return {
    error: {
      message: azureError.message ?? 'An Azure OpenAI error occurred',
      type: mapErrorType(statusCode, azureError.code),
      code: azureError.code ?? null,
      param: azureError.param ?? null,
    },
  };
}

function mapErrorType(statusCode: number, _code?: string): string {
  if (statusCode === 401) return 'authentication_error';
  if (statusCode === 403) return 'permission_error';
  if (statusCode === 404) return 'not_found_error';
  if (statusCode === 429) return 'rate_limit_error';
  if (statusCode >= 500) return 'server_error';
  return 'invalid_request_error';
}
