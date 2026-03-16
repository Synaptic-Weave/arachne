import { ProviderBase } from './ProviderBase.js';
import type { BaseProvider } from '../../providers/base.js';
import { OpenAIProvider as OpenAIProxyAdapter } from '../../providers/openai.js';

export class OpenAIProvider extends ProviderBase {
  baseUrl!: string | null;

  validate(): void {
    if (!this.apiKey) {
      throw new Error('API key is required for OpenAI provider');
    }
  }

  createClient(tenantId?: string): BaseProvider {
    const apiKey = this.decryptApiKey(tenantId);
    return new OpenAIProxyAdapter({
      apiKey: apiKey || process.env.OPENAI_API_KEY || '',
      baseUrl: this.baseUrl ?? undefined,
    });
  }

  sanitizeForTenant(): Partial<OpenAIProvider> {
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
