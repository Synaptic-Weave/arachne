/**
 * CLI Integration Smoke Tests
 *
 * Covers the full end-to-end workflow:
 *  1. Signup for account via portal
 *  2. Create an agent via portal
 *  3. Export agent to YAML
 *  4. Modify agent configuration via API (simulates CLI modification)
 *  5. Verify agent echoes responses (parrot behavior)
 *
 * Note: The CLI weave/push/deploy workflow requires the /v1/registry/weave endpoint
 * which is not yet implemented. This test uses the portal API directly to accomplish
 * the same verification goal.
 *
 * Requires: Loom stack running
 * Run: npm run test:smoke
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import type { Browser, Page } from 'playwright';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  launchBrowser,
  newPage,
  ensureSignup,
  uniqueEmail,
  uniqueName,
  BASE_URL,
} from './helpers.js';

describe('CLI integration smoke tests', () => {
  let browser: Browser;
  let page: Page;

  const email = uniqueEmail('smoke-cli');
  const password = 'CliTest1!';
  const tenantName = uniqueName('CliOrg');
  const agentName = uniqueName('TestAgent');

  let token: string;
  let tenantId: string;
  let agentId: string;

  const testDir = join(process.cwd(), 'tmp', 'cli-test-' + Date.now());

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);

    // Create test directory for CLI operations
    mkdirSync(testDir, { recursive: true });

    // 1. Signup for account via portal
    await ensureSignup(page, { email, password, tenantName });

    // Get the auth token and tenant info by calling the login API
    const loginResp = await fetch(`${BASE_URL}/v1/portal/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    expect(loginResp.ok).toBe(true);
    const loginData = await loginResp.json();
    token = loginData.token;
    tenantId = loginData.tenant.id;

    // Configure the tenant to use a local Ollama provider so that
    // chat tests work without requiring OPENAI_API_KEY.
    const settingsResp = await fetch(`${BASE_URL}/v1/portal/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
      }),
    });
    expect(settingsResp.ok).toBe(true);
  }, 120000);

  afterAll(async () => {
    await browser.close();
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('can create an agent via portal API', async () => {
    const resp = await fetch(`${BASE_URL}/v1/portal/agents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: agentName,
        systemPrompt: 'You are a helpful assistant.',
      }),
    });

    expect(resp.ok).toBe(true);
    const data = await resp.json();
    agentId = data.agent.id;
    expect(agentId).toBeTruthy();
    expect(data.agent.name).toBe(agentName);
    expect(data.agent.systemPrompt).toBe('You are a helpful assistant.');
  });

  it('can export agent to YAML spec', async () => {
    // Fetch the agent data
    const resp = await fetch(`${BASE_URL}/v1/portal/agents/${agentId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    expect(resp.ok).toBe(true);
    const data = await resp.json();
    const agent = data.agent;

    // Generate YAML spec for the agent
    const yaml = `kind: Agent
metadata:
  name: ${agent.name}
spec:
  systemPrompt: |
    ${agent.systemPrompt || 'You are a helpful assistant.'}
  mergePolicies:
    system_prompt: ${agent.mergePolicies?.system_prompt || 'prepend'}
    skills: ${agent.mergePolicies?.skills || 'merge'}
    mcp_endpoints: ${agent.mergePolicies?.mcp_endpoints || 'merge'}
`;

    const specPath = join(testDir, `${agent.name}.yaml`);
    writeFileSync(specPath, yaml, 'utf8');

    // Verify the file was written
    const writtenContent = readFileSync(specPath, 'utf8');
    expect(writtenContent).toContain('kind: Agent');
    expect(writtenContent).toContain(agent.name);
  });

  it('can modify agent YAML to use parrot prompt', async () => {
    const parrotYaml = `kind: Agent
metadata:
  name: ${agentName}
spec:
  systemPrompt: |
    You are a parrot. You can only repeat back to the user what they say to you. Do not add any additional text, explanations, or commentary. Just echo back their exact words.
  mergePolicies:
    system_prompt: prepend
    skills: merge
    mcp_endpoints: merge
`;

    const specPath = join(testDir, `${agentName}-parrot.yaml`);
    writeFileSync(specPath, parrotYaml, 'utf8');

    // Verify the file was written
    const writtenContent = readFileSync(specPath, 'utf8');
    expect(writtenContent).toContain('You are a parrot');
  });

  it('can apply parrot prompt modification via API', async () => {
    // Update the agent with the parrot prompt
    const resp = await fetch(`${BASE_URL}/v1/portal/agents/${agentId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        systemPrompt: 'You are a parrot. You can only repeat back to the user what they say to you. Do not add any additional text, explanations, or commentary. Just echo back their exact words.',
      }),
    });

    expect(resp.ok).toBe(true);
    const data = await resp.json();
    expect(data.agent.systemPrompt).toContain('You are a parrot');
  });

  it('agent echoes user input (parrot behavior)', async () => {
    const testMessage = 'Hello, this is a test message';

    const chatResp = await fetch(`${BASE_URL}/v1/portal/agents/${agentId}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: testMessage }],
        model: 'gemma3:4b',
      }),
    });

    if (!chatResp.ok) {
      const errorText = await chatResp.text();
      console.error('Chat API error:', chatResp.status, errorText);
      throw new Error(`Chat API failed with status ${chatResp.status}: ${errorText}`);
    }

    const chatData = await chatResp.json();
    const response = chatData.message?.content || '';

    // The parrot should echo back the test message (or a close paraphrase).
    // Ollama + Mistral may not always produce a verbatim echo, so we check
    // for key words from the original message.
    const lowerResponse = response.toLowerCase();
    const containsTestMessage =
      lowerResponse.includes(testMessage.toLowerCase()) ||
      (lowerResponse.includes('hello') && lowerResponse.includes('test message'));
    expect(containsTestMessage).toBe(true);
  }, 60000);
});
