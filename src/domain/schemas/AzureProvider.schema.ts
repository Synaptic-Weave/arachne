import { EntitySchema } from '@mikro-orm/core';
import { AzureProvider } from '../entities/AzureProvider.js';

export const AzureProviderSchema = new EntitySchema<AzureProvider>({
  class: AzureProvider,
  extends: 'ProviderBase',
  properties: {
    baseUrl: { type: 'text', fieldName: 'base_url', nullable: true },
    deployment: { type: 'string', columnType: 'varchar(255)' },
    apiVersion: {
      type: 'string',
      columnType: 'varchar(50)',
      fieldName: 'api_version',
    },
  } as any,
});
