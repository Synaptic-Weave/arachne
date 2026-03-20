/**
 * Add `name` column to deployments table.
 * Backfill from artifact name + environment, then enforce NOT NULL + unique.
 */

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // 1. Add nullable column
  pgm.addColumn('deployments', {
    name: { type: 'varchar(200)', notNull: false },
  });

  // 2. Backfill existing rows
  pgm.sql(`
    UPDATE deployments d
    SET name = a.name || '-' || d.environment
    FROM artifacts a
    WHERE a.id = d.artifact_id
  `);

  // 3. Make NOT NULL
  pgm.alterColumn('deployments', 'name', { notNull: true });

  // 4. Add unique index
  pgm.createIndex('deployments', ['tenant_id', 'name'], {
    name: 'deployments_tenant_name_unique',
    unique: true,
  });
};

/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.down = (pgm) => {
  pgm.dropIndex('deployments', ['tenant_id', 'name'], {
    name: 'deployments_tenant_name_unique',
  });
  pgm.dropColumn('deployments', 'name');
};
