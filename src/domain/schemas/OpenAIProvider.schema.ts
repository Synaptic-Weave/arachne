import { EntitySchema } from '@mikro-orm/core';
import { OpenAIProvider } from '../entities/OpenAIProvider.js';

export const OpenAIProviderSchema = new EntitySchema<OpenAIProvider>({
  class: OpenAIProvider,
  extends: 'ProviderBase',
  properties: {
    baseUrl: { type: 'text', fieldName: 'base_url', nullable: true },
  } as any,
});
