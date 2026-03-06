import { EntitySchema } from '@mikro-orm/core';
import { Provider } from '../entities/Provider.js';
import { Tenant } from '../entities/Tenant.js';

export const ProviderSchema = new EntitySchema<Provider>({
  class: Provider,
  tableName: 'providers',
  properties: {
    id: { type: 'uuid', primary: true },
    name: { type: 'string', columnType: 'varchar(255)' },
    description: { type: 'text', nullable: true },
    type: { type: 'string', columnType: 'varchar(50)' },
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
    baseUrl: { type: 'text', fieldName: 'base_url', nullable: true },
    deployment: { type: 'string', columnType: 'varchar(255)', nullable: true },
    apiVersion: {
      type: 'string',
      columnType: 'varchar(50)',
      fieldName: 'api_version',
      nullable: true,
    },
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
    { properties: ['isDefault'], expression: 'is_default WHERE tenant_id IS NULL' },
  ],
  uniques: [
    { properties: ['tenant', 'name'] },
  ],
});
