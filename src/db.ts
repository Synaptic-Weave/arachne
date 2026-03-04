/**
 * Database query helper — thin shim over the ORM's knex instance.
 * analytics.ts, tracing.ts, and dashboard routes use this for raw SQL.
 * Tests mock this module via vi.mock('../src/db.js').
 */
import { orm } from './orm.js';

export async function query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
  const knex = (orm as any).em.getKnex();
  const paramArray = params ?? [];
  // Convert PostgreSQL placeholders ($1, $2, etc.) to Knex placeholders (?)
  // But only outside of quoted strings to avoid replacing '$2' in expressions like "'$2 hours'"
  let convertedSql = sql;
  for (let i = paramArray.length; i >= 1; i--) {
    // Match $i that's NOT inside single quotes
    // This is a simplified approach - splits by quotes and only replaces in non-quoted parts
    const parts = convertedSql.split("'");
    for (let j = 0; j < parts.length; j += 2) {
      // Only replace in parts that are outside quotes (even indices)
      parts[j] = parts[j].replace(new RegExp(`\\$${i}\\b`, 'g'), '?');
    }
    convertedSql = parts.join("'");
  }
  const result = await knex.raw(convertedSql, paramArray);
  return { rows: result.rows };
}
