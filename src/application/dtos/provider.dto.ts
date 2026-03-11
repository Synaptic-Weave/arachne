import type { ProviderBase } from '../../domain/entities/ProviderBase.js';
import type { OpenAIProvider } from '../../domain/entities/OpenAIProvider.js';
import type { AzureProvider } from '../../domain/entities/AzureProvider.js';
import type { OllamaProvider } from '../../domain/entities/OllamaProvider.js';

export type ProviderType = 'openai' | 'azure' | 'ollama';

export interface ProviderViewModel {
  id: string;
  name: string;
  description: string | null;
  type: ProviderType;
  isDefault: boolean;
  availableModels: string[];

  // Type-specific fields (nullable for other types)
  baseUrl?: string | null;
  deployment?: string;
  apiVersion?: string;

  // Only for custom providers or admin view
  apiKey?: string;

  createdAt: string;
  updatedAt: string | null;
}

export interface CreateProviderDto {
  name: string;
  description?: string;
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  deployment?: string; // Required for Azure
  apiVersion?: string; // Required for Azure
  availableModels?: string[];
}

export interface UpdateProviderDto {
  name?: string;
  description?: string;
  apiKey?: string;
  baseUrl?: string;
  deployment?: string;
  apiVersion?: string;
  availableModels?: string[];
}

/**
 * Convert Provider entity to view model
 * @param p Provider entity
 * @param includeSecrets Include sensitive fields (apiKey, etc.)
 */
export function toProviderViewModel(p: ProviderBase, includeSecrets: boolean = false): ProviderViewModel {
  // Determine type from class name
  const className = p.constructor.name;
  let type: ProviderType;
  if (className === 'OpenAIProvider') {
    type = 'openai';
  } else if (className === 'AzureProvider') {
    type = 'azure';
  } else if (className === 'OllamaProvider') {
    type = 'ollama';
  } else {
    throw new Error(`Unknown provider class: ${className}`);
  }

  const base: ProviderViewModel = {
    id: p.id,
    name: p.name,
    description: p.description,
    type,
    isDefault: p.isDefault,
    availableModels: p.availableModels,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt ? p.updatedAt.toISOString() : null,
  };

  // Type-specific fields
  if ('baseUrl' in p) {
    base.baseUrl = (p as OpenAIProvider | AzureProvider | OllamaProvider).baseUrl;
  }
  if ('deployment' in p) {
    base.deployment = (p as AzureProvider).deployment;
  }
  if ('apiVersion' in p) {
    base.apiVersion = (p as AzureProvider).apiVersion;
  }

  // Include secrets for custom providers or admin view
  if (includeSecrets || !p.isGatewayProvider()) {
    base.apiKey = p.apiKey;
  }

  return base;
}
