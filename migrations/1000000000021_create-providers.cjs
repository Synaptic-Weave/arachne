exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.createTable('providers', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    name: {
      type: 'varchar(255)',
      notNull: true,
    },
    description: {
      type: 'text',
    },
    type: {
      type: 'varchar(50)',
      notNull: true,
      check: "type IN ('openai', 'azure', 'ollama')",
    },
    tenant_id: {
      type: 'uuid',
      references: 'tenants(id)',
      onDelete: 'CASCADE',
    },
    is_default: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    api_key: {
      type: 'text',
      notNull: true,
    },
    base_url: {
      type: 'text',
    },
    deployment: {
      type: 'varchar(255)',
    },
    api_version: {
      type: 'varchar(50)',
    },
    available_models: {
      type: 'text[]',
      notNull: true,
      default: pgm.func("'{}'"),
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
    },
  }, { ifNotExists: true });

  // Indexes
  pgm.createIndex('providers', 'tenant_id', { ifNotExists: true });
  pgm.createIndex('providers', 'is_default', {
    where: 'tenant_id IS NULL',
    name: 'idx_providers_gateway_default',
    ifNotExists: true,
  });

  // Unique constraint: (tenant_id, name)
  pgm.addConstraint('providers', 'providers_tenant_id_name_unique', {
    unique: ['tenant_id', 'name'],
  });

  // Only one gateway provider can be default
  pgm.sql(`
    CREATE UNIQUE INDEX idx_providers_gateway_default_unique
    ON providers(is_default)
    WHERE tenant_id IS NULL AND is_default = true;
  `);
};

exports.down = async (pgm) => {
  pgm.dropTable('providers');
};
