/**
 * Add sandbox_key column to agents table for internal sandbox API key.
 * Stores the encrypted raw API key used by the portal sandbox chat.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
  pgm.addColumns('agents', {
    sandbox_key: {
      type: 'text',
      notNull: false,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('agents', ['sandbox_key']);
};
