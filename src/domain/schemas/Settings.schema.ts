import { EntitySchema } from '@mikro-orm/core';
import { Settings } from '../entities/Settings.js';

export const SettingsSchema = new EntitySchema<Settings>({
  class: Settings,
  tableName: 'settings',
  properties: {
    id: { type: 'number', primary: true },
    signupsEnabled: { type: 'boolean', fieldName: 'signups_enabled' },
    defaultEmbedderProvider: { type: 'string', fieldName: 'default_embedder_provider', nullable: true },
    defaultEmbedderModel: { type: 'string', fieldName: 'default_embedder_model', nullable: true },
    defaultEmbedderApiKey: { type: 'text', fieldName: 'default_embedder_api_key', nullable: true },
    defaultEmbedderProviderId: { type: 'uuid', fieldName: 'default_embedder_provider_id', nullable: true },
    updatedAt: { type: 'Date', fieldName: 'updated_at', onUpdate: () => new Date() },
    updatedByAdminId: { type: 'uuid', fieldName: 'updated_by_admin_id', nullable: true },
  },
});
