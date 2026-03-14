/**
 * Backfill sandbox API keys for agents that were created before the sandbox key feature.
 *
 * Usage:
 *   npx tsx scripts/backfill-sandbox-keys.ts
 *
 * Idempotent — skips agents that already have a sandboxKey set.
 */
import 'dotenv/config';
import { initOrm } from '../src/orm.js';
import { Agent } from '../src/domain/entities/Agent.js';
import { ApiKey } from '../src/domain/entities/ApiKey.js';
import { encryptTraceBody } from '../src/encryption.js';

async function main() {
  const orm = await initOrm();
  const em = orm.em.fork();

  const agents = await em.find(Agent, { sandboxKey: null, kind: 'inference' }, { populate: ['tenant'] });
  console.log(`Found ${agents.length} agents without sandbox keys`);

  let created = 0;
  for (const agent of agents) {
    // Check if a _sandbox key already exists for this agent
    const existing = await em.findOne(ApiKey, { agent: agent.id, name: '_sandbox' });
    if (existing) {
      console.log(`  [skip] ${agent.name} (${agent.id}) — stale _sandbox key, replacing...`);
      await em.removeAndFlush(existing);
    }

    const apiKey = new ApiKey(agent, '_sandbox');
    try {
      const encrypted = encryptTraceBody(agent.tenant.id, apiKey.rawKey);
      agent.sandboxKey = `encrypted:${encrypted.ciphertext}:${encrypted.iv}`;
    } catch {
      // Dev environment without encryption — store raw
      agent.sandboxKey = apiKey.rawKey;
    }

    em.persist(apiKey);
    created++;
    console.log(`  [ok] ${agent.name} (${agent.id})`);
  }

  await em.flush();
  console.log(`Done. Created ${created} sandbox keys.`);

  await orm.close();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
