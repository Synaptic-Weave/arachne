import { Migration } from '@mikro-orm/migrations';

/**
 * Baseline migration: represents the cumulative schema created by
 * node-pg-migrate migrations 001 through 027.
 *
 * This migration is intentionally a no-op. On existing databases the
 * schema already exists (applied via node-pg-migrate). On fresh databases
 * the full schema should be created by running `npm run legacy:migrate:up`
 * first, then marking this baseline as applied.
 *
 * After this baseline, all new schema changes use MikroORM migrations.
 *
 * Covered tables (from node-pg-migrate history):
 *   tenants, api_keys, traces (partitioned), admin_users, users,
 *   tenant_memberships, invites, agents, conversations,
 *   conversation_messages, conversation_snapshots, artifacts,
 *   artifact_tags, knowledge_base_chunks, vector_spaces, deployments,
 *   beta_signups, settings, providers, provider_tenant_access,
 *   smoke_test_runs, partitions
 */
export class Migration00000000000000_baseline extends Migration {
  override async up(): Promise<void> {
    // No-op: schema already exists via node-pg-migrate migrations.
    // This migration exists solely as a baseline marker so that
    // MikroORM's migrator knows where its history begins.
  }

  override async down(): Promise<void> {
    // Rolling back the baseline is not supported.
    // Use node-pg-migrate (npm run legacy:migrate:down) for legacy rollbacks.
    throw new Error(
      'Cannot roll back baseline migration. Use node-pg-migrate for legacy schema rollbacks.'
    );
  }
}
