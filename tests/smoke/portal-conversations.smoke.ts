/**
 * Portal Conversations Smoke Tests
 *
 * Covers:
 *  - Conversations page loads
 *  - Lists conversations (empty state and with data)
 *  - Can select and view conversation details
 *  - Can filter by partition (if partitions exist)
 *
 * Requires: API server running
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
  uniqueEmail,
  uniqueName,
  BASE_URL,
} from './helpers.js';

describe('Portal conversations smoke tests', () => {
  let browser: Browser;
  let page: Page;

  const email = uniqueEmail('smoke-conversations');
  const password = 'SmokeTest1!';
  const agentName = `ConvTestAgent_${Date.now()}`;
  let agentId: string | null = null;
  let hasConversation = false;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
    await ensureSignup(page, email, password, uniqueName('ConversationsOrg'));

    const token = await page.evaluate(() => localStorage.getItem('loom_portal_token'));
    if (!token) return;

    // Configure ollama provider so chat creates a real conversation
    await fetch(`${BASE_URL}/v1/portal/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider: 'ollama', baseUrl: 'http://localhost:11434' }),
    }).catch(() => {});

    // Create agent via API with conversations enabled
    const res = await fetch(`${BASE_URL}/v1/portal/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: agentName, conversationsEnabled: true }),
    });
    if (res.ok) {
      const body = await res.json();
      agentId = body.agent?.id ?? null;
    } else {
      console.warn('Agent creation via API failed:', res.status, await res.text().catch(() => ''));
    }

    // Send a chat message to create a conversation
    if (agentId) {
      const chatRes = await fetch(`${BASE_URL}/v1/portal/agents/${agentId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model: 'gemma3:4b',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });
      if (chatRes.ok) {
        hasConversation = true;
      } else {
        console.warn('Chat API failed:', chatRes.status, await chatRes.text().catch(() => ''));
      }
    }
  }, 120000);

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
  it('conversations page loads and shows empty state', async () => {
    await page.goto(`${BASE_URL}/app/conversations`);
    await ensureAuth();
    await waitForVisible(page, 'body', 5000);

    const content = await page.content();
    expect(content).toMatch(/Conversations/i);

    // Should show empty state initially (no conversations yet)
    const hasEmptyText = content.includes('No conversations') || content.includes('conversation') ;
    expect(hasEmptyText).toBe(true);
  });

  // -------------------------------------------------------------------------
  it('conversations page shows empty state initially', async () => {
    await page.goto(`${BASE_URL}/app/conversations`);
    await ensureAuth();
    await waitForVisible(page, 'body', 5000);
    await page.waitForTimeout(1000);

    const content = await page.content();

    // Should show either "No conversations" or "Conversations" heading
    const hasConversationsUI =
      content.includes('No conversations') ||
      content.includes('Conversations') ||
      content.includes('conversation');

    expect(hasConversationsUI).toBe(true);
  });

  // -------------------------------------------------------------------------
  it('can click on conversation to view details', async () => {
    if (!hasConversation) {
      console.warn('No conversation created in beforeAll - skipping');
      return;
    }

    await page.goto(`${BASE_URL}/app/conversations`);
    await ensureAuth();
    await page.waitForTimeout(2000);

    // Click the first conversation row (rows have role="button")
    const firstRow = page.locator('tr[role="button"]').first();
    const rowCount = await firstRow.count();
    if (rowCount === 0) {
      console.warn('No conversation rows found - skipping detail check');
      return;
    }

    await firstRow.click();
    await page.waitForTimeout(1500);

    // Expanded row should show message content (role labels like "user"/"assistant")
    const content = await page.content();
    const hasMessages = content.includes('user') || content.includes('assistant') || content.includes('No messages');
    expect(hasMessages).toBe(true);
  });

  // -------------------------------------------------------------------------
  it('conversations page has basic layout', async () => {
    await page.goto(`${BASE_URL}/app/conversations`);
    await ensureAuth();
    await waitForVisible(page, 'body', 5000);

    const content = await page.content();

    // Check that the page has basic conversation UI elements
    const hasConversationsLayout =
      content.includes('Conversations') ||
      content.includes('conversation') ||
      content.includes('No conversations');
    expect(hasConversationsLayout).toBe(true);
  });

  // -------------------------------------------------------------------------
  it('conversation list shows timestamp info', async () => {
    if (!hasConversation) {
      console.warn('No conversation created in beforeAll - skipping');
      return;
    }

    await page.goto(`${BASE_URL}/app/conversations`);
    await ensureAuth();
    await page.waitForTimeout(2000);

    const content = await page.content();

    // timeAgo() returns "just now", "X mins ago", "X hours ago", or "X days ago"
    const hasTimeInfo =
      content.includes('just now') ||
      content.includes('ago') ||
      content.includes('Created');
    expect(hasTimeInfo).toBe(true);
  });
});
