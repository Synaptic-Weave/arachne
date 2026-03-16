/**
 * Add provider_id column to agents table.
 * This creates a direct FK from agents → providers, enabling agent-level
 * provider selection that takes priority over the JSONB providerConfig chain.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
  pgm.addColumns('agents', {
    provider_id: {
      type: 'uuid',
      notNull: false,
      references: 'providers',
      onDelete: 'SET NULL',
    },
  });

  pgm.createIndex('agents', 'provider_id', {
    name: 'idx_agents_provider_id',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('agents', 'provider_id', { name: 'idx_agents_provider_id' });
  pgm.dropColumns('agents', ['provider_id']);
};
