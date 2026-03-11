import { EntitySchema } from '@mikro-orm/core';
import { OllamaProvider } from '../entities/OllamaProvider.js';

export const OllamaProviderSchema = new EntitySchema<OllamaProvider>({
  class: OllamaProvider,
  extends: 'ProviderBase',
  properties: {
    baseUrl: { type: 'text', fieldName: 'base_url' },
  } as any,
});
