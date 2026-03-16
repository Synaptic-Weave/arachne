/**
 * Data migration: Convert legacy JSONB provider_config on tenants and agents
 * into proper Provider entity rows with FK relationships.
 *
 * Phase 1: Tenant migration — creates Provider rows from tenant.provider_config,
 *          sets tenant.default_provider_id
 * Phase 2: Agent migration — creates Provider rows from agent.provider_config,
 *          sets agent.provider_id
 *
 * Does NOT drop the provider_config columns — that will be a separate migration
 * after verification.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // ── Phase 1: Tenant migration ────────────────────────────────────────────

  const { rows: tenants } = await pgm.db.query(`
    SELECT id, provider_config
    FROM tenants
    WHERE provider_config IS NOT NULL
      AND provider_config->>'provider' IS NOT NULL
      AND default_provider_id IS NULL
  `);

  for (const tenant of tenants) {
    const cfg = tenant.provider_config;
    const providerType = cfg.provider; // 'openai', 'azure', 'ollama'
    const apiKey = cfg.apiKey || '';
    const baseUrl = cfg.baseUrl || null;

    // Dedup: check if a matching provider already exists for this tenant
    const { rows: existing } = await pgm.db.query(
      `SELECT id FROM providers
       WHERE tenant_id = $1
         AND type = $2
         AND (base_url IS NOT DISTINCT FROM $3)
       LIMIT 1`,
      [tenant.id, providerType, baseUrl]
    );

    let providerId;

    if (existing.length > 0) {
      providerId = existing[0].id;
    } else {
      // Build INSERT with Azure-specific fields
      const deployment = cfg.deployment || null;
      const apiVersion = cfg.apiVersion || null;
      const name = `Migrated: ${providerType}`;

      const { rows: inserted } = await pgm.db.query(
        `INSERT INTO providers (name, type, tenant_id, api_key, base_url, deployment, api_version, available_models, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', now())
         RETURNING id`,
        [name, providerType, tenant.id, apiKey, baseUrl, deployment, apiVersion]
      );
      providerId = inserted[0].id;
    }

    // Set the tenant's default_provider_id
    await pgm.db.query(
      `UPDATE tenants SET default_provider_id = $1 WHERE id = $2`,
      [providerId, tenant.id]
    );
  }

  // ── Phase 2: Agent migration ─────────────────────────────────────────────

  const { rows: agents } = await pgm.db.query(`
    SELECT a.id, a.tenant_id, a.provider_config
    FROM agents a
    WHERE a.provider_config IS NOT NULL
      AND a.provider_id IS NULL
  `);

  for (const agent of agents) {
    const cfg = agent.provider_config;

    // Case 1: gatewayProviderId already points to an existing provider entity
    if (cfg.gatewayProviderId) {
      // Verify the provider exists before setting the FK
      const { rows: providerExists } = await pgm.db.query(
        `SELECT id FROM providers WHERE id = $1 LIMIT 1`,
        [cfg.gatewayProviderId]
      );
      if (providerExists.length > 0) {
        await pgm.db.query(
          `UPDATE agents SET provider_id = $1 WHERE id = $2`,
          [cfg.gatewayProviderId, agent.id]
        );
        continue;
      }
      // If the referenced provider doesn't exist, fall through to Case 2
    }

    // Case 2: Full provider config — create a tenant-scoped Provider entity
    const providerType = cfg.provider;
    if (!providerType) continue; // Skip if no provider type

    const apiKey = cfg.apiKey || '';
    const baseUrl = cfg.baseUrl || null;
    const deployment = cfg.deployment || null;
    const apiVersion = cfg.apiVersion || null;

    // Dedup: reuse if identical config exists for the same tenant
    const { rows: existing } = await pgm.db.query(
      `SELECT id FROM providers
       WHERE tenant_id = $1
         AND type = $2
         AND (base_url IS NOT DISTINCT FROM $3)
       LIMIT 1`,
      [agent.tenant_id, providerType, baseUrl]
    );

    let providerId;

    if (existing.length > 0) {
      providerId = existing[0].id;
    } else {
      const name = `Migrated: ${providerType}`;

      const { rows: inserted } = await pgm.db.query(
        `INSERT INTO providers (name, type, tenant_id, api_key, base_url, deployment, api_version, available_models, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}', now())
         RETURNING id`,
        [name, providerType, agent.tenant_id, apiKey, baseUrl, deployment, apiVersion]
      );
      providerId = inserted[0].id;
    }

    await pgm.db.query(
      `UPDATE agents SET provider_id = $1 WHERE id = $2`,
      [providerId, agent.id]
    );
  }
};

exports.down = async (pgm) => {
  // Clear provider_id on agents that were set by this migration
  // (only those pointing to "Migrated:" providers or any provider_id we set)
  await pgm.db.query(`
    UPDATE agents a
    SET provider_id = NULL
    WHERE provider_id IN (
      SELECT id FROM providers WHERE name LIKE 'Migrated: %'
    )
  `);

  // Clear default_provider_id on tenants that were set by this migration
  await pgm.db.query(`
    UPDATE tenants t
    SET default_provider_id = NULL
    WHERE default_provider_id IN (
      SELECT id FROM providers WHERE name LIKE 'Migrated: %'
    )
  `);

  // Also clear agents that had gatewayProviderId copied directly
  // (These pointed to pre-existing providers, so just NULL the FK)
  await pgm.db.query(`
    UPDATE agents a
    SET provider_id = NULL
    WHERE provider_id IS NOT NULL
      AND provider_config IS NOT NULL
      AND provider_config->>'gatewayProviderId' IS NOT NULL
      AND provider_id = (provider_config->>'gatewayProviderId')::uuid
  `);

  // Delete the provider rows created by this migration
  await pgm.db.query(`
    DELETE FROM providers WHERE name LIKE 'Migrated: %'
  `);
};
