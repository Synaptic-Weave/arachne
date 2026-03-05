exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.createTable('settings', {
    id: {
      type: 'integer',
      primaryKey: true,
      default: 1,
    },
    signups_enabled: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_by_admin_id: {
      type: 'uuid',
      references: 'admin_users(id)',
    },
  }, { ifNotExists: true });

  // Insert the singleton settings row with default value from environment
  pgm.sql(`
    INSERT INTO settings (id, signups_enabled, updated_at)
    VALUES (1, COALESCE(NULLIF(current_setting('app.signups_enabled', true), ''), 'true')::boolean, now())
    ON CONFLICT (id) DO NOTHING;
  `);
};

exports.down = async (pgm) => {
  pgm.dropTable('settings');
};
