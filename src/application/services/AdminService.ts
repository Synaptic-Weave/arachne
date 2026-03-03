/**
 * AdminService — encapsulates all database access for admin routes.
 * Route handlers stay thin: parse HTTP → call AdminService → return DTO.
 */
import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { EntityManager } from '@mikro-orm/core';

const scryptAsync = promisify(scrypt);

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(':');
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return timingSafeEqual(Buffer.from(key, 'hex'), derivedKey);
}

export interface TenantRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface TenantDetailRow extends TenantRow {
  provider_config: any;
  api_key_count: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
}

export interface TraceRow {
  id: string;
  tenant_id: string;
  model: string;
  provider: string;
  status_code: number;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  ttfb_ms: number;
  gateway_overhead_ms: number;
  created_at: Date;
}

export interface ListTenantsFilters {
  limit: number;
  offset: number;
  status?: string;
}

export interface ListTracesFilters {
  limit: number;
  tenant_id?: string;
  cursor?: string;
}

export class AdminService {
  constructor(private readonly em: EntityManager) {}

  private async rawQuery<T extends object>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const rows = await this.em.getConnection().execute<T[]>(sql, params as any[], 'all');
    return { rows };
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async validateAdminLogin(
    username: string,
    password: string,
  ): Promise<{ id: string; username: string } | null> {
    const result = await this.rawQuery<{
      id: string;
      username: string;
      password_hash: string;
    }>('SELECT id, username, password_hash FROM admin_users WHERE username = ?', [username]);

    if (result.rows.length === 0) return null;

    const adminUser = result.rows[0];
    const isValid = await verifyPassword(password, adminUser.password_hash);
    if (!isValid) return null;

    return { id: adminUser.id, username: adminUser.username };
  }

  async updateAdminLastLogin(id: string): Promise<void> {
    await this.rawQuery('UPDATE admin_users SET last_login = now() WHERE id = ?', [id]);
  }

  // ── Tenants ───────────────────────────────────────────────────────────────

  async createTenant(name: string): Promise<TenantRow> {
    const result = await this.rawQuery<TenantRow>(
      'INSERT INTO tenants (name) VALUES (?) RETURNING id, name, status, created_at, updated_at',
      [name],
    );
    return result.rows[0];
  }

  async listTenants(
    filters: ListTenantsFilters,
  ): Promise<{ tenants: TenantRow[]; total: number }> {
    const { limit, offset, status } = filters;

    let sql = 'SELECT id, name, status, created_at, updated_at FROM tenants';
    const params: unknown[] = [];

    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [tenants, countResult] = await Promise.all([
      this.rawQuery<TenantRow>(sql, params),
      this.rawQuery<{ count: string }>(
        status ? 'SELECT COUNT(*) FROM tenants WHERE status = ?' : 'SELECT COUNT(*) FROM tenants',
        status ? [status] : [],
      ),
    ]);

    return {
      tenants: tenants.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  async getTenant(id: string): Promise<TenantDetailRow | null> {
    const result = await this.rawQuery<TenantDetailRow>(
      `SELECT
        t.id,
        t.name,
        t.status,
        t.provider_config,
        t.created_at,
        t.updated_at,
        COUNT(ak.id) AS api_key_count
       FROM tenants t
       LEFT JOIN api_keys ak ON ak.tenant_id = t.id
       WHERE t.id = ?
       GROUP BY t.id`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async updateTenant(
    id: string,
    fields: { name?: string; status?: string },
  ): Promise<TenantRow | null> {
    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (fields.name) {
      updates.push(`name = ?`);
      params.push(fields.name.trim());
      paramIndex++;
    }
    if (fields.status) {
      updates.push(`status = ?`);
      params.push(fields.status);
      paramIndex++;
    }
    updates.push(`updated_at = now()`);
    params.push(id);

    const result = await this.rawQuery<TenantRow>(
      `UPDATE tenants SET ${updates.join(', ')} WHERE id = ? RETURNING id, name, status, created_at, updated_at`,
      params,
    );
    return result.rows[0] ?? null;
  }

  async deleteTenant(id: string): Promise<boolean> {
    const result = await this.rawQuery('DELETE FROM tenants WHERE id = ? RETURNING id', [id]);
    return result.rows.length > 0;
  }

  // ── Provider config ────────────────────────────────────────────────────────

  async tenantExists(id: string): Promise<boolean> {
    const result = await this.rawQuery('SELECT id FROM tenants WHERE id = ?', [id]);
    return result.rows.length > 0;
  }

  async setProviderConfig(id: string, providerConfig: object): Promise<void> {
    await this.rawQuery(
      'UPDATE tenants SET provider_config = ?, updated_at = now() WHERE id = ?',
      [JSON.stringify(providerConfig), id],
    );
  }

  async clearProviderConfig(id: string): Promise<boolean> {
    const result = await this.rawQuery(
      'UPDATE tenants SET provider_config = NULL, updated_at = now() WHERE id = ? RETURNING id',
      [id],
    );
    return result.rows.length > 0;
  }

  // ── API keys ───────────────────────────────────────────────────────────────

  async createApiKey(
    tenantId: string,
    name: string,
    rawKey: string,
    keyPrefix: string,
    keyHash: string,
  ): Promise<{ id: string; name: string; key_prefix: string; status: string; created_at: string }> {
    const result = await this.rawQuery<{
      id: string;
      name: string;
      key_prefix: string;
      status: string;
      created_at: string;
    }>(
      `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash)
       VALUES (?, ?, ?, ?)
       RETURNING id, name, key_prefix, status, created_at`,
      [tenantId, name, keyPrefix, keyHash],
    );
    return result.rows[0];
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRow[]> {
    const result = await this.rawQuery<ApiKeyRow>(
      `SELECT id, name, key_prefix, status, created_at, revoked_at
       FROM api_keys
       WHERE tenant_id = ?
       ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows;
  }

  async getApiKeyHash(keyId: string, tenantId: string): Promise<string | null> {
    const result = await this.rawQuery<{ key_hash: string }>(
      'SELECT key_hash FROM api_keys WHERE id = ? AND tenant_id = ?',
      [keyId, tenantId],
    );
    return result.rows[0]?.key_hash ?? null;
  }

  async hardDeleteApiKey(keyId: string, tenantId: string): Promise<void> {
    await this.rawQuery('DELETE FROM api_keys WHERE id = ? AND tenant_id = ?', [
      keyId,
      tenantId,
    ]);
  }

  async revokeApiKey(keyId: string, tenantId: string): Promise<string | null> {
    const result = await this.rawQuery<{ key_hash: string }>(
      `UPDATE api_keys
       SET status = 'revoked', revoked_at = now()
       WHERE id = ? AND tenant_id = ?
       RETURNING key_hash`,
      [keyId, tenantId],
    );
    return result.rows[0]?.key_hash ?? null;
  }

  // ── Traces ─────────────────────────────────────────────────────────────────

  async listTraces(filters: ListTracesFilters): Promise<TraceRow[]> {
    const { limit, tenant_id, cursor } = filters;
    const params: unknown[] = [];
    let whereClause = '';

    if (tenant_id && cursor) {
      whereClause = `WHERE tenant_id = ? AND created_at < ?::timestamptz`;
      params.push(tenant_id, cursor);
    } else if (tenant_id) {
      whereClause = `WHERE tenant_id = ?`;
      params.push(tenant_id);
    } else if (cursor) {
      whereClause = `WHERE created_at < ?::timestamptz`;
      params.push(cursor);
    }
    params.push(limit);

    const result = await this.rawQuery<TraceRow>(
      `SELECT id, tenant_id, model, provider, status_code, latency_ms,
              prompt_tokens, completion_tokens, ttfb_ms, gateway_overhead_ms, created_at
       FROM   traces
       ${whereClause}
       ORDER  BY created_at DESC
       LIMIT  ?`,
      params,
    );
    return result.rows;
  }
}
