import { EntitySchema } from '@mikro-orm/core';
import { BetaSignup } from '../entities/BetaSignup.js';

export const BetaSignupSchema = new EntitySchema<BetaSignup>({
  class: BetaSignup,
  tableName: 'beta_signups',
  properties: {
    id: { type: 'uuid', primary: true },
    email: { type: 'text' },
    name: { type: 'text', nullable: true },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
  },
});
