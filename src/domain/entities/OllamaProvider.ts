import { ProviderBase } from './ProviderBase.js';
import type { BaseProvider } from '../../providers/base.js';
import { OpenAIProvider as OpenAIProxyAdapter } from '../../providers/openai.js';

export class OllamaProvider extends ProviderBase {
  baseUrl!: string; // Required for Ollama

  validate(): void {
    if (!this.baseUrl) {
      throw new Error('Base URL is required for Ollama provider');
    }
    // Ollama typically doesn't require an API key, but we keep the field for consistency
  }

  createClient(_tenantId?: string): BaseProvider {
    return new OpenAIProxyAdapter({
      apiKey: 'ollama',
      baseUrl: (this.baseUrl || 'http://localhost:11434') + '/v1',
    });
  }

  sanitizeForTenant(): Partial<OllamaProvider> {
    if (this.isGatewayProvider()) {
      // Hide credentials for gateway providers
      return {
        id: this.id,
        name: this.name,
        description: this.description,
        isDefault: this.isDefault,
        availableModels: this.availableModels,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
        // EXCLUDE: apiKey, baseUrl
      };
    }

    // Custom providers: return all fields (tenant owns this)
    return this;
  }
}
