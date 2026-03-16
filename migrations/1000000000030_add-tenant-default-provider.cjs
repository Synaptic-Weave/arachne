/**
 * Add default_provider_id column to tenants table.
 * This lets tenants select a default provider that sits between the
 * agent-level override and the legacy JSONB providerConfig in the
 * resolution chain.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
  pgm.addColumns('tenants', {
    default_provider_id: {
      type: 'uuid',
      notNull: false,
      references: 'providers',
      onDelete: 'SET NULL',
    },
  });

  pgm.createIndex('tenants', 'default_provider_id', {
    name: 'idx_tenants_default_provider_id',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('tenants', 'default_provider_id', { name: 'idx_tenants_default_provider_id' });
  pgm.dropColumns('tenants', ['default_provider_id']);
};
