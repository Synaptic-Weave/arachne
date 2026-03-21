/**
 * Add `token_version` column to deployments table.
 * Used to invalidate old runtime tokens after rotation.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.addColumn('deployments', {
    token_version: { type: 'integer', notNull: true, default: 1 },
  });
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.dropColumn('deployments', 'token_version');
};
