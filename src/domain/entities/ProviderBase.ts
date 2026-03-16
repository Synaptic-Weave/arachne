import { randomUUID } from 'node:crypto';
import type { Tenant } from './Tenant.js';
import type { BaseProvider } from '../../providers/base.js';
import { decryptTraceBody } from '../../encryption.js';

export abstract class ProviderBase {
  id!: string;
  name!: string;
  description!: string | null;

  // Scoping: null = gateway provider, uuid = tenant provider
  tenant!: Tenant | null;

  // Gateway default flag
  isDefault!: boolean;

  // Tenant availability: when true, available to all tenants
  tenantAvailable!: boolean;

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
      tenantAvailable?: boolean;
      availableModels?: string[];
    }
  ) {
    this.id = randomUUID();
    this.name = name;
    this.description = config?.description ?? null;
    this.tenant = config?.tenant ?? null;
    this.isDefault = config?.isDefault ?? false;
    this.tenantAvailable = config?.tenantAvailable ?? false;
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
   * Decrypt the stored API key if it uses the `encrypted:{ciphertext}:{iv}` format.
   * @param tenantId - Used for per-tenant key derivation. If omitted, decryption of
   *   encrypted keys will fail gracefully and return an empty string.
   */
  protected decryptApiKey(tenantId?: string): string {
    if (!this.apiKey) return '';
    if (!this.apiKey.startsWith('encrypted:')) return this.apiKey;

    try {
      const parts = this.apiKey.split(':');
      if (parts.length === 3 && tenantId) {
        return decryptTraceBody(tenantId, parts[1], parts[2]);
      }
    } catch (err) {
      console.error('Failed to decrypt provider API key', err);
    }
    return '';
  }

  /**
   * Abstract methods - implemented by concrete providers
   */
  abstract validate(): void;
  abstract createClient(tenantId?: string): BaseProvider;
  abstract sanitizeForTenant(): Partial<ProviderBase>;
}
