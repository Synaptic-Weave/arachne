/**
 * PortalService — encapsulates all database access for portal routes.
 * Route handlers stay thin: parse HTTP → call PortalService → return DTO.
 */
import type { EntityManager } from '@mikro-orm/core';

export class PortalService {
  constructor(private readonly em: EntityManager) {}

  private async rawQuery<T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const knex = (this.em as any).getKnex();
    // Convert PostgreSQL placeholders ($1, $2, etc.) to Knex placeholders (?)
    // But only outside of quoted strings to avoid replacing '$2' in expressions like "'$2 hours'"
    let convertedSql = sql;
    for (let i = params.length; i >= 1; i--) {
      // Match $i that's NOT inside single quotes
      // This is a simplified approach - splits by quotes and only replaces in non-quoted parts
      const parts = convertedSql.split("'");
      for (let j = 0; j < parts.length; j += 2) {
        // Only replace in parts that are outside quotes (even indices)
        parts[j] = parts[j].replace(new RegExp(`\\$${i}\\b`, 'g'), '?');
      }
      convertedSql = parts.join("'");
    }
    const result = await knex.raw(convertedSql, params);
    return { rows: result.rows as T[] };
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  async getMe(userId: string, tenantId: string) {
    const result = await this.rawQuery<{
      id: string; email: string; role: string;
      tenant_id: string; tenant_name: string;
      provider_config: Record<string, unknown> | null;
      available_models: string[] | null;
    }>(
      `SELECT u.id, u.email, tm.role, t.id AS tenant_id, t.name AS tenant_name, t.provider_config, t.available_models
       FROM users u
       JOIN tenant_memberships tm ON tm.user_id = u.id
       JOIN tenants t ON t.id = tm.tenant_id
       WHERE u.id = $1 AND t.id = $2`,
      [userId, tenantId],
    );
    if (result.rows.length === 0) return null;

    const tenantsResult = await this.rawQuery<{
      tenant_id: string; tenant_name: string; role: string;
    }>(
      `SELECT tm.tenant_id, t.name AS tenant_name, tm.role
       FROM tenant_memberships tm
       JOIN tenants t ON tm.tenant_id = t.id
       WHERE tm.user_id = $1 AND t.status = 'active'
       ORDER BY tm.joined_at ASC`,
      [userId],
    );

    const [agentsResult, subtenantsResult] = await Promise.all([
      this.rawQuery<{ id: string; name: string }>(
        'SELECT id, name FROM agents WHERE tenant_id = $1 ORDER BY created_at',
        [tenantId],
      ),
      this.rawQuery<{ id: string; name: string; status: string }>(
        'SELECT id, name, status FROM tenants WHERE parent_id = $1 ORDER BY created_at',
        [tenantId],
      ),
    ]);

    return {
      row: result.rows[0],
      tenants: tenantsResult.rows,
      agents: agentsResult.rows,
      subtenants: subtenantsResult.rows,
    };
  }

  // ── Traces ────────────────────────────────────────────────────────────────

  async listTraces(tenantId: string, limit: number, cursor?: string) {
    let result;
    if (cursor) {
      result = await this.rawQuery(
        `SELECT id, tenant_id, model, provider, status_code, latency_ms,
                prompt_tokens, completion_tokens, ttfb_ms, gateway_overhead_ms, created_at
         FROM   traces
         WHERE  tenant_id = $1
           AND  created_at < $2::timestamptz
         ORDER  BY created_at DESC
         LIMIT  $3`,
        [tenantId, cursor, limit],
      );
    } else {
      result = await this.rawQuery(
        `SELECT id, tenant_id, model, provider, status_code, latency_ms,
                prompt_tokens, completion_tokens, ttfb_ms, gateway_overhead_ms, created_at
         FROM   traces
         WHERE  tenant_id = $1
         ORDER  BY created_at DESC
         LIMIT  $2`,
        [tenantId, limit],
      );
    }
    return result.rows;
  }

  // ── Tenants ───────────────────────────────────────────────────────────────

  async listUserTenants(userId: string) {
    const result = await this.rawQuery<{
      tenant_id: string; tenant_name: string; role: string; joined_at: string;
    }>(
      `SELECT tm.tenant_id, t.name AS tenant_name, tm.role, tm.joined_at
       FROM tenant_memberships tm
       JOIN tenants t ON tm.tenant_id = t.id
       WHERE tm.user_id = $1 AND t.status = 'active'
       ORDER BY tm.joined_at ASC`,
      [userId],
    );
    return result.rows;
  }

  async getInviteInfo(token: string) {
    // First check if it's a beta signup invite code
    const betaResult = await this.rawQuery<{
      email: string; approved_at: string | null; invite_used_at: string | null;
    }>(
      `SELECT email, approved_at, invite_used_at
       FROM beta_signups
       WHERE invite_code = $1`,
      [token],
    );

    if (betaResult.rows.length > 0) {
      const beta = betaResult.rows[0];
      return {
        tenant_name: 'Arachne', // Beta invites create new tenants
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year validity
        revoked_at: null,
        max_uses: 1,
        use_count: beta.invite_used_at ? 1 : 0,
        tenant_status: 'active',
      };
    }

    // Otherwise check for tenant invite
    const result = await this.rawQuery<{
      tenant_name: string; expires_at: string;
      revoked_at: string | null; max_uses: number | null; use_count: number;
      tenant_status: string;
    }>(
      `SELECT t.name AS tenant_name, i.expires_at, i.revoked_at,
              i.max_uses, i.use_count, t.status AS tenant_status
       FROM invites i
       JOIN tenants t ON i.tenant_id = t.id
       WHERE i.token = $1`,
      [token],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async listSubtenants(tenantId: string) {
    const result = await this.rawQuery<{
      id: string; name: string; parent_id: string; status: string; created_at: string;
    }>(
      'SELECT id, name, parent_id, status, created_at FROM tenants WHERE parent_id = $1 ORDER BY created_at',
      [tenantId],
    );
    return result.rows;
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  async listAgents(tenantId: string) {
    const result = await this.rawQuery<{
      id: string; name: string;
      provider_config: Record<string, unknown> | null;
      system_prompt: string | null;
      skills: unknown[] | null;
      mcp_endpoints: unknown[] | null;
      merge_policies: Record<string, unknown>;
      available_models: string[] | null;
      conversations_enabled: boolean;
      conversation_token_limit: number | null;
      conversation_summary_model: string | null;
      created_at: string; updated_at: string | null;
    }>(
      `SELECT id, name, provider_config, system_prompt, skills, mcp_endpoints, merge_policies,
              available_models, conversations_enabled, conversation_token_limit,
              conversation_summary_model, created_at, updated_at
       FROM agents WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return result.rows;
  }

  async getAgent(agentId: string, userId: string) {
    const result = await this.rawQuery<{
      id: string; name: string;
      provider_config: Record<string, unknown> | null;
      system_prompt: string | null;
      skills: unknown[] | null;
      mcp_endpoints: unknown[] | null;
      merge_policies: Record<string, unknown>;
      available_models: string[] | null;
      conversations_enabled: boolean;
      conversation_token_limit: number | null;
      conversation_summary_model: string | null;
      created_at: string; updated_at: string | null;
    }>(
      `SELECT a.id, a.name, a.provider_config, a.system_prompt, a.skills, a.mcp_endpoints, a.merge_policies,
              a.available_models, a.conversations_enabled, a.conversation_token_limit,
              a.conversation_summary_model, a.created_at, a.updated_at
       FROM agents a
       JOIN tenant_memberships tm ON tm.tenant_id = a.tenant_id
       WHERE a.id = $1 AND tm.user_id = $2`,
      [agentId, userId],
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async getAgentResolved(agentId: string, userId: string) {
    const agentResult = await this.rawQuery<{
      id: string; name: string; tenant_id: string;
      provider_config: Record<string, unknown> | null;
      system_prompt: string | null;
      skills: unknown[] | null;
      mcp_endpoints: unknown[] | null;
      merge_policies: Record<string, unknown>;
    }>(
      `SELECT a.id, a.name, a.tenant_id, a.provider_config, a.system_prompt,
              a.skills, a.mcp_endpoints, a.merge_policies
       FROM agents a
       JOIN tenant_memberships tm ON tm.tenant_id = a.tenant_id
       WHERE a.id = $1 AND tm.user_id = $2`,
      [agentId, userId],
    );
    if (agentResult.rows.length === 0) return null;

    const agent = agentResult.rows[0];
    const chainResult = await this.rawQuery<{
      id: string; name: string;
      provider_config: Record<string, unknown> | null;
      system_prompt: string | null;
      skills: unknown[] | null;
      mcp_endpoints: unknown[] | null;
      depth: number;
    }>(
      `WITH RECURSIVE tenant_chain AS (
         SELECT id, name, parent_id, provider_config, system_prompt, skills, mcp_endpoints, 0 AS depth
         FROM tenants WHERE id = $1
         UNION ALL
         SELECT t.id, t.name, t.parent_id, t.provider_config, t.system_prompt, t.skills, t.mcp_endpoints, tc.depth + 1
         FROM tenants t
         JOIN tenant_chain tc ON t.id = tc.parent_id
       )
       SELECT id, name, provider_config, system_prompt, skills, mcp_endpoints, depth
       FROM tenant_chain ORDER BY depth ASC`,
      [agent.tenant_id],
    );
    return { agent, tenantChain: chainResult.rows };
  }

  async getAgentForChat(agentId: string, userId: string) {
    const agentResult = await this.rawQuery<{
      id: string; name: string; tenant_id: string;
      provider_config: Record<string, unknown> | null;
      system_prompt: string | null;
      skills: unknown[] | null;
      mcp_endpoints: unknown[] | null;
      merge_policies: Record<string, unknown>;
      conversations_enabled: boolean;
      conversation_token_limit: number | null;
      conversation_summary_model: string | null;
    }>(
      `SELECT a.id, a.name, a.tenant_id, a.provider_config, a.system_prompt, a.skills,
              a.mcp_endpoints, a.merge_policies, a.conversations_enabled,
              a.conversation_token_limit, a.conversation_summary_model
       FROM agents a
       JOIN tenant_memberships tm ON tm.tenant_id = a.tenant_id
       WHERE a.id = $1 AND tm.user_id = $2`,
      [agentId, userId],
    );
    if (agentResult.rows.length === 0) return null;

    const agent = agentResult.rows[0];
    const chainResult = await this.rawQuery<{
      id: string; name: string;
      provider_config: Record<string, unknown> | null;
      system_prompt: string | null;
      skills: unknown[] | null;
      mcp_endpoints: unknown[] | null;
      depth: number;
    }>(
      `WITH RECURSIVE tenant_chain AS (
         SELECT id, name, parent_id, provider_config, system_prompt, skills, mcp_endpoints, 0 AS depth
         FROM tenants WHERE id = $1
         UNION ALL
         SELECT t.id, t.name, t.parent_id, t.provider_config, t.system_prompt, t.skills, t.mcp_endpoints, tc.depth + 1
         FROM tenants t
         JOIN tenant_chain tc ON t.id = tc.parent_id
       )
       SELECT id, name, provider_config, system_prompt, skills, mcp_endpoints, depth
       FROM tenant_chain ORDER BY depth ASC`,
      [agent.tenant_id],
    );
    return { agent, tenantChain: chainResult.rows };
  }

  // ── Partitions ────────────────────────────────────────────────────────────

  async listPartitions(tenantId: string) {
    const result = await this.rawQuery<{
      id: string; parent_id: string | null; external_id: string;
      title_encrypted: string | null; title_iv: string | null; created_at: string;
    }>(
      `SELECT id, parent_id, external_id, title_encrypted, title_iv, created_at
       FROM partitions
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [tenantId],
    );
    return result.rows;
  }

  async createPartition(
    tenantId: string,
    externalId: string,
    parentId: string | null,
    titleEncrypted: string | null,
    titleIv: string | null,
  ) {
    const result = await this.rawQuery<{
      id: string; external_id: string; parent_id: string | null; created_at: string;
    }>(
      `INSERT INTO partitions (tenant_id, parent_id, external_id, title_encrypted, title_iv)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, external_id, parent_id, created_at`,
      [tenantId, parentId, externalId, titleEncrypted, titleIv],
    );
    return result.rows[0];
  }

  async updatePartition(
    id: string,
    tenantId: string,
    updates: {
      titleEncrypted?: string;
      titleIv?: string;
      parentId?: string | null;
    },
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [id, tenantId];

    if (updates.titleEncrypted !== undefined && updates.titleIv !== undefined) {
      sets.push(`title_encrypted = $${params.length + 1}, title_iv = $${params.length + 2}`);
      params.push(updates.titleEncrypted, updates.titleIv);
    }
    if ('parentId' in updates) {
      sets.push(`parent_id = $${params.length + 1}`);
      params.push(updates.parentId);
    }
    if (sets.length === 0) return false;

    const result = await this.rawQuery(
      `UPDATE partitions SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      params,
    );
    return (result.rows.length) > 0;
  }

  async deletePartition(id: string, tenantId: string): Promise<boolean> {
    const result = await this.rawQuery(
      'DELETE FROM partitions WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId],
    );
    return result.rows.length > 0;
  }

  // ── Conversations ─────────────────────────────────────────────────────────

  async listConversations(tenantId: string, partitionId?: string | null) {
    const result = await this.rawQuery<{
      id: string; agent_id: string | null; partition_id: string | null;
      external_id: string; created_at: string; last_active_at: string;
    }>(
      partitionId
        ? `SELECT c.id, c.agent_id, c.partition_id, c.external_id, c.created_at, c.last_active_at
           FROM conversations c
           WHERE c.tenant_id = $1 AND c.partition_id = $2
           ORDER BY c.last_active_at DESC`
        : `SELECT c.id, c.agent_id, c.partition_id, c.external_id, c.created_at, c.last_active_at
           FROM conversations c
           WHERE c.tenant_id = $1
           ORDER BY c.last_active_at DESC`,
      partitionId ? [tenantId, partitionId] : [tenantId],
    );
    return result.rows;
  }

  async getConversation(id: string, tenantId: string) {
    const convResult = await this.rawQuery<{
      id: string; agent_id: string | null; partition_id: string | null;
      external_id: string; created_at: string; last_active_at: string;
    }>(
      `SELECT id, agent_id, partition_id, external_id, created_at, last_active_at
       FROM conversations WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (convResult.rows.length === 0) return null;

    const snapResult = await this.rawQuery<{
      id: string; summary_encrypted: string; summary_iv: string;
      messages_archived: number; created_at: string;
    }>(
      `SELECT id, summary_encrypted, summary_iv, messages_archived, created_at
       FROM conversation_snapshots WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id],
    );

    const msgResult = await this.rawQuery<{
      id: string; role: string; content_encrypted: string; content_iv: string;
      token_estimate: number | null; snapshot_id: string | null; created_at: string;
    }>(
      `SELECT id, role, content_encrypted, content_iv, token_estimate, snapshot_id, created_at
       FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id],
    );

    return { conv: convResult.rows[0], snapshots: snapResult.rows, messages: msgResult.rows };
  }
}
