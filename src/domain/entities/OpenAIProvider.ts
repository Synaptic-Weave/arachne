import { ProviderBase } from './ProviderBase.js';

export class OpenAIProvider extends ProviderBase {
  baseUrl!: string | null;

  validate(): void {
    if (!this.apiKey) {
      throw new Error('API key is required for OpenAI provider');
    }
  }

  createClient(): any {
    // TODO: Implement OpenAI client creation
    // return new OpenAI({
    //   apiKey: decrypt(this.apiKey),
    //   baseURL: this.baseUrl ?? undefined,
    // });
    throw new Error('OpenAI client creation not yet implemented');
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
