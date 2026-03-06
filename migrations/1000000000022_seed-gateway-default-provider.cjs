exports.shorthands = undefined;

exports.up = async (pgm) => {
  // Seed gateway default provider from environment variables
  // Uses OPENAI_API_KEY and OPENAI_BASE_URL if available
  pgm.sql(`
    INSERT INTO providers (
      name,
      description,
      type,
      tenant_id,
      is_default,
      api_key,
      base_url,
      available_models,
      created_at
    )
    SELECT
      'Default Gateway Provider',
      'Default LLM provider for all tenants',
      'openai',
      NULL,  -- Gateway provider (no tenant)
      true,  -- This is the default
      COALESCE(NULLIF(current_setting('app.openai_api_key', true), ''), 'sk-placeholder'),
      NULLIF(current_setting('app.openai_base_url', true), ''),
      '{}',  -- No model restrictions by default
      now()
    WHERE NOT EXISTS (
      SELECT 1 FROM providers WHERE tenant_id IS NULL AND is_default = true
    );
  `);
};

exports.down = async (pgm) => {
  // Remove the gateway default provider
  pgm.sql(`
    DELETE FROM providers
    WHERE tenant_id IS NULL
      AND name = 'Default Gateway Provider'
      AND is_default = true;
  `);
};
