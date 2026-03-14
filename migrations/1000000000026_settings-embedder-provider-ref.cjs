/**
 * Add FK reference from settings to a gateway provider for default embedder.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
  pgm.addColumns('settings', {
    default_embedder_provider_id: {
      type: 'uuid',
      notNull: false,
      references: '"providers"',
      onDelete: 'SET NULL',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('settings', ['default_embedder_provider_id']);
};
