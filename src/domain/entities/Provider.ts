import { randomUUID } from 'node:crypto';
import type { Tenant } from './Tenant.js';

export type ProviderType = 'openai' | 'azure' | 'ollama';

export class Provider {
  id!: string;
  name!: string;
  description!: string | null;
  type!: ProviderType;

  // Scoping: null = gateway provider, uuid = tenant provider
  tenant!: Tenant | null;

  // Gateway default flag (only one gateway provider can be default)
  isDefault!: boolean;

  // Configuration (hidden from tenants for gateway providers)
  apiKey!: string; // Encrypted
  baseUrl!: string | null;
  deployment!: string | null; // Azure
  apiVersion!: string | null; // Azure

  // Model restrictions (enforced at API level)
  availableModels!: string[];

  createdAt!: Date;
  updatedAt!: Date | null;

  constructor(
    name: string,
    type: ProviderType,
    apiKey: string,
    config?: {
      description?: string;
      tenant?: Tenant;
      isDefault?: boolean;
      baseUrl?: string;
      deployment?: string;
      apiVersion?: string;
      availableModels?: string[];
    }
  ) {
    this.id = randomUUID();
    this.name = name;
    this.description = config?.description ?? null;
    this.type = type;
    this.tenant = config?.tenant ?? null;
    this.isDefault = config?.isDefault ?? false;
    this.apiKey = apiKey;
    this.baseUrl = config?.baseUrl ?? null;
    this.deployment = config?.deployment ?? null;
    this.apiVersion = config?.apiVersion ?? null;
    this.availableModels = config?.availableModels ?? [];
    this.createdAt = new Date();
    this.updatedAt = null;
  }

  /**
   * Check if this is a gateway provider (available to all tenants)
   */
  isGatewayProvider(): boolean {
    return this.tenant === null;
  }

  /**
   * Sanitize provider for tenant view (hide credentials for gateway providers)
   */
  sanitizeForTenant(): Partial<Provider> {
    if (this.isGatewayProvider()) {
      return {
        id: this.id,
        name: this.name,
        description: this.description,
        type: this.type,
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
