import { randomUUID } from 'node:crypto';
import type { Tenant } from './Tenant.js';

export abstract class ProviderBase {
  id!: string;
  name!: string;
  description!: string | null;

  // Scoping: null = gateway provider, uuid = tenant provider
  tenant!: Tenant | null;

  // Gateway default flag
  isDefault!: boolean;

  // Configuration (encrypted)
  apiKey!: string;

  // Model restrictions
  availableModels!: string[];

  createdAt!: Date;
  updatedAt!: Date | null;

  constructor(
    name: string,
    apiKey: string,
    config?: {
      description?: string;
      tenant?: Tenant;
      isDefault?: boolean;
      availableModels?: string[];
    }
  ) {
    this.id = randomUUID();
    this.name = name;
    this.description = config?.description ?? null;
    this.tenant = config?.tenant ?? null;
    this.isDefault = config?.isDefault ?? false;
    this.apiKey = apiKey;
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
   * Abstract methods - implemented by concrete providers
   */
  abstract validate(): void;
  abstract createClient(): any; // Will be typed as LLMClient when available
  abstract sanitizeForTenant(): Partial<ProviderBase>;
}
