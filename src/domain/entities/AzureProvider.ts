import { ProviderBase } from './ProviderBase.js';
import type { BaseProvider } from '../../providers/base.js';
import { AzureProvider as AzureProxyAdapter } from '../../providers/azure.js';

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

  createClient(tenantId?: string): BaseProvider {
    const apiKey = this.decryptApiKey(tenantId);
    return new AzureProxyAdapter({
      apiKey: apiKey || '',
      endpoint: this.baseUrl || '',
      deployment: this.deployment || '',
      apiVersion: this.apiVersion || '2024-02-01',
      deploymentMap: {},
    });
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
