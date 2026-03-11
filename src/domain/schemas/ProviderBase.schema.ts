import { EntitySchema } from '@mikro-orm/core';
import { ProviderBase } from '../entities/ProviderBase.js';
import { Tenant } from '../entities/Tenant.js';

export const ProviderBaseSchema = new EntitySchema<ProviderBase>({
  class: ProviderBase,
  tableName: 'providers',
  discriminatorColumn: 'type',
  discriminatorMap: {
    openai: 'OpenAIProvider',
    azure: 'AzureProvider',
    ollama: 'OllamaProvider',
  },
  abstract: true,
  properties: {
    id: { type: 'uuid', primary: true },
    name: { type: 'string', columnType: 'varchar(255)' },
    description: { type: 'text', nullable: true },
    tenant: {
      kind: 'm:1',
      entity: () => Tenant,
      fieldName: 'tenant_id',
      nullable: true,
    },
    isDefault: {
      type: 'boolean',
      fieldName: 'is_default',
      default: false,
    },
    apiKey: { type: 'text', fieldName: 'api_key' },
    availableModels: {
      type: 'array',
      fieldName: 'available_models',
      default: [],
    },
    createdAt: {
      type: 'Date',
      fieldName: 'created_at',
      onCreate: () => new Date(),
    },
    updatedAt: {
      type: 'Date',
      fieldName: 'updated_at',
      nullable: true,
      onUpdate: () => new Date(),
    },
  },
  indexes: [
    { properties: ['tenant'] },
    {
      properties: ['isDefault'],
      expression: 'is_default WHERE tenant_id IS NULL',
      name: 'idx_providers_gateway_default'
    },
  ],
  uniques: [
    { properties: ['tenant', 'name'], name: 'providers_tenant_id_name_unique' },
  ],
});
