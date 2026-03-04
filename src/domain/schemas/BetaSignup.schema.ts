import { EntitySchema } from '@mikro-orm/core';
import { BetaSignup } from '../entities/BetaSignup.js';

export const BetaSignupSchema = new EntitySchema<BetaSignup>({
  class: BetaSignup,
  tableName: 'beta_signups',
  properties: {
    id: { type: 'uuid', primary: true },
    email: { type: 'text' },
    name: { type: 'text', nullable: true },
    inviteCode: { type: 'uuid', fieldName: 'invite_code', nullable: true },
    approvedAt: { type: 'Date', fieldName: 'approved_at', nullable: true },
    approvedByAdminId: { type: 'uuid', fieldName: 'approved_by_admin_id', nullable: true },
    inviteUsedAt: { type: 'Date', fieldName: 'invite_used_at', nullable: true },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
  },
});
