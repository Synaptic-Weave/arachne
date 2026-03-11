import { ProviderBase } from './ProviderBase.js';

export class AzureProvider extends ProviderBase {
  baseUrl!: string | null;
  deployment!: string;
  apiVersion!: string;

  validate(): void {
    if (!this.apiKey) {
      throw new Error('API key is required for Azure provider');
    }
    if (!this.deployment) {
      throw new Error('Deployment is required for Azure provider');
    }
    if (!this.apiVersion) {
      throw new Error('API version is required for Azure provider');
    }
  }

  createClient(): any {
    // TODO: Implement Azure OpenAI client creation
    // return new AzureOpenAI({
    //   apiKey: decrypt(this.apiKey),
    //   endpoint: this.baseUrl,
    //   deployment: this.deployment,
    //   apiVersion: this.apiVersion,
    // });
    throw new Error('Azure client creation not yet implemented');
  }

  sanitizeForTenant(): Partial<AzureProvider> {
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
        // EXCLUDE: apiKey, baseUrl, deployment, apiVersion
      };
    }

    // Custom providers: return all fields (tenant owns this)
    return this;
  }
}
