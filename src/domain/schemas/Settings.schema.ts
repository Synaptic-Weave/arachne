import { EntitySchema } from '@mikro-orm/core';
import { Settings } from '../entities/Settings.js';

export const SettingsSchema = new EntitySchema<Settings>({
  class: Settings,
  tableName: 'settings',
  properties: {
    id: { type: 'number', primary: true },
    signupsEnabled: { type: 'boolean', fieldName: 'signups_enabled' },
    updatedAt: { type: 'Date', fieldName: 'updated_at', onUpdate: () => new Date() },
    updatedByAdminId: { type: 'uuid', fieldName: 'updated_by_admin_id', nullable: true },
  },
});
