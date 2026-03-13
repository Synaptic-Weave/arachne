/**
 * Portal Agents & Subtenants Smoke Tests
 *
 * Covers:
 *  - Agents page loads
 *  - Owner can create an agent
 *  - Agent appears in the agents list
 *  - Subtenants page loads
 *  - Owner can create a subtenant
 *  - Subtenant appears in the list
 *
 * Requires: Loom stack running (`docker-compose up`)
 * Run: npm run test:smoke
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import type { Browser, Page } from 'playwright';
import {
  launchBrowser,
  newPage,
  ensureSignup,
  portalLogin,
  waitForVisible,
  waitForAppReady,
  screenshotIfDocsMode,
  uniqueEmail,
  uniqueName,
  BASE_URL,
} from './helpers.js';

describe('Portal agents smoke tests', () => {
  let browser: Browser;
  let page: Page;

  const email = uniqueEmail('smoke-agents');
  const password = 'SmokeTest1!';

  let agentName: string;
  let subtenantName: string;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
    agentName = uniqueName('TestAgent');
    subtenantName = uniqueName('TestSubtenant');
    await ensureSignup(page, email, password, uniqueName('AgentsOrg'));
  });

  afterAll(async () => {
    await browser.close();
  });

  /** Wait for React to mount and async auth to settle, then re-login if needed. */
  async function ensureAuth() {
    const ready = await waitForAppReady(page, 10000);
    if (!ready || page.url().includes('/login')) {
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await portalLogin(page, email, password);
    }
    // Wait for api.me() and other async operations to complete so React re-renders are done
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  it('owner can navigate to Agents page', async () => {
    await page.goto(`${BASE_URL}/app/agents`);
    await ensureAuth();
    await waitForVisible(page, 'body', 5000);
    await screenshotIfDocsMode(page, 'portal-agents', 'Portal agents page', 'Agents');
    const content = await page.content();
    expect(content).toMatch(/Agents?/i);
  });

  // -------------------------------------------------------------------------
  it('owner can create an agent', async () => {
    // Create agent via API (UI form interaction races with React re-renders from
    // AuthProvider.refresh() and AgentEditor.loadKbs() async effects that detach DOM elements)
    const token = await page.evaluate(() => localStorage.getItem('loom_portal_token'));
    if (!token) {
      // Recover auth if token is missing
      await portalLogin(page, email, password);
    }
    const apiToken = token || await page.evaluate(() => localStorage.getItem('loom_portal_token'));

    const res = await fetch(`${BASE_URL}/v1/portal/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ name: agentName }),
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.agent).toBeTruthy();
    expect(body.agent.name).toBe(agentName);

    await screenshotIfDocsMode(page, 'portal-agent-created', 'Agent created via API', 'Agents');
  });

  // -------------------------------------------------------------------------
  it('agent appears in the agents list', async () => {
    await page.goto(`${BASE_URL}/app/agents`);
    await ensureAuth();
    // Wait for agents list to load
    await page.waitForFunction(
      (name: string) => (document.body.textContent || '').includes(name),
      agentName,
      { timeout: 15000 },
    );
    const content = await page.content();
    expect(content).toMatch(new RegExp(agentName, 'i'));
  });

  // -------------------------------------------------------------------------
  it('owner can navigate to Subtenants page', async () => {
    await page.goto(`${BASE_URL}/app/subtenants`);
    await ensureAuth();
    await waitForVisible(page, 'body', 5000);
    const content = await page.content();
    expect(content).toMatch(/Subtenants?/i);
  });

  // -------------------------------------------------------------------------
  it('owner can create a subtenant', async () => {
    // Create subtenant via API (same DOM detachment issue as agent creation)
    const token = await page.evaluate(() => localStorage.getItem('loom_portal_token'));
    if (!token) {
      await portalLogin(page, email, password);
    }
    const apiToken = token || await page.evaluate(() => localStorage.getItem('loom_portal_token'));

    const res = await fetch(`${BASE_URL}/v1/portal/subtenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ name: subtenantName }),
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.subtenant).toBeTruthy();
    expect(body.subtenant.name).toBe(subtenantName);
  });

  // -------------------------------------------------------------------------
  it('subtenant appears in the list', async () => {
    await page.goto(`${BASE_URL}/app/subtenants`);
    await ensureAuth();
    await page.waitForFunction(
      (name: string) => (document.body.textContent || '').includes(name),
      subtenantName,
      { timeout: 15000 },
    );
    const content = await page.content();
    expect(content).toMatch(new RegExp(subtenantName, 'i'));
  });
});
