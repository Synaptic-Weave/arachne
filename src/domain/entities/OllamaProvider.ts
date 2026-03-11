import { ProviderBase } from './ProviderBase.js';

export class OllamaProvider extends ProviderBase {
  baseUrl!: string; // Required for Ollama

  validate(): void {
    if (!this.baseUrl) {
      throw new Error('Base URL is required for Ollama provider');
    }
    // Ollama typically doesn't require an API key, but we keep the field for consistency
  }

  createClient(): any {
    // TODO: Implement Ollama client creation
    // return new OllamaClient({
    //   baseURL: this.baseUrl,
    // });
    throw new Error('Ollama client creation not yet implemented');
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
