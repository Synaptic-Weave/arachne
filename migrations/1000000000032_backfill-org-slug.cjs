/**
 * Backfill org_slug for existing tenants and make it non-nullable.
 * Generates slug from tenant name: lowercase, replace non-alphanumeric with hyphens,
 * collapse, trim, max 50 chars. Appends suffix if collision.
 */

exports.up = async (pgm) => {
  // Backfill null org_slugs from tenant name
  await pgm.db.query(`
    UPDATE tenants
    SET org_slug = LOWER(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '-', 'g'),
          '^-|-$', '', 'g'
        ),
        '-{2,}', '-', 'g'
      )
    )
    WHERE org_slug IS NULL
  `);

  // Handle any remaining nulls (empty names) with tenant id prefix
  await pgm.db.query(`
    UPDATE tenants
    SET org_slug = SUBSTRING(id::text FROM 1 FOR 8)
    WHERE org_slug IS NULL OR org_slug = ''
  `);

  // Handle collisions by appending id suffix
  await pgm.db.query(`
    UPDATE tenants t1
    SET org_slug = t1.org_slug || '-' || SUBSTRING(t1.id::text FROM 1 FOR 4)
    WHERE EXISTS (
      SELECT 1 FROM tenants t2
      WHERE t2.org_slug = t1.org_slug AND t2.id < t1.id
    )
  `);

  // Now make it non-nullable
  pgm.alterColumn('tenants', 'org_slug', { notNull: true });
};

exports.down = (pgm) => {
  pgm.alterColumn('tenants', 'org_slug', { notNull: false });
};
