/**
 * Migration: Add invite code columns to beta_signups
 *
 * Allows admins to approve beta signups by generating invite codes
 * that can be used even when SIGNUPS_ENABLED=false
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.addColumns('beta_signups', {
    invite_code: {
      type: 'uuid',
      unique: true,
    },
    approved_at: {
      type: 'timestamptz',
    },
    approved_by_admin_id: {
      type: 'uuid',
      references: '"admin_users"',
    },
    invite_used_at: {
      type: 'timestamptz',
    },
  });

  pgm.createIndex('beta_signups', 'invite_code', { where: 'invite_code IS NOT NULL' });
};

exports.down = async (pgm) => {
  pgm.dropIndex('beta_signups', 'invite_code');
  pgm.dropColumns('beta_signups', ['invite_code', 'approved_at', 'approved_by_admin_id', 'invite_used_at']);
};
