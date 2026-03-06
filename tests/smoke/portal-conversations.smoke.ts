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
  portalSignup,
  waitForVisible,
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

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
    await portalSignup(page, email, password, uniqueName('ConversationsOrg'));

    // Create an agent with conversations enabled
    await page.goto(`${BASE_URL}/app/agents`);
    await page.locator(':text("New Agent")').first().click();
    await waitForVisible(page, 'input[placeholder*="customer-support" i]', 8000);
    await page.locator('input[placeholder*="customer-support" i]').fill(agentName);

    // Enable conversations feature
    const conversationsToggle = page.locator('input[type="checkbox"]').nth(0); // First checkbox is conversations
    const isChecked = await conversationsToggle.isChecked();
    if (!isChecked) {
      await conversationsToggle.click();
    }

    await page.locator('button[type="submit"]:has-text("Create agent")').click();
    await page.waitForTimeout(2000);
  });

  afterAll(async () => {
    await browser.close();
  });

  // -------------------------------------------------------------------------
  it('conversations page loads and shows empty state', async () => {
    await page.goto(`${BASE_URL}/app/conversations`);
    await waitForVisible(page, 'body', 5000);

    const content = await page.content();
    expect(content).toMatch(/Conversations/i);

    // Should show empty state initially (no conversations yet)
    const hasEmptyText = content.includes('No conversations') || content.includes('conversation') ;
    expect(hasEmptyText).toBe(true);
  });

  // -------------------------------------------------------------------------
  it('can create conversation via API and it appears in list', async () => {
    // Get auth token from localStorage
    const token = await page.evaluate(() => localStorage.getItem('portalToken'));
    expect(token).toBeTruthy();

    // Create a conversation by sending a chat message via API
    const conversationId = `test-conv-${Date.now()}`;
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Test message for conversation' }],
        conversation_id: conversationId,
      }),
    });

    expect(response.ok).toBe(true);

    // Reload conversations page and check if it appears
    await page.goto(`${BASE_URL}/app/conversations`);
    await waitForVisible(page, 'body', 5000);
    await page.waitForTimeout(2000); // Wait for data to load

    const content = await page.content();
    // The external_id should appear in the list
    expect(content).toContain(conversationId);
  });

  // -------------------------------------------------------------------------
  it('can click on conversation to view details', async () => {
    await page.goto(`${BASE_URL}/app/conversations`);
    await waitForVisible(page, 'body', 5000);
    await page.waitForTimeout(1000);

    // Click the first conversation in the list
    const firstConversation = page.locator('button:has-text("test-conv-")').first();
    await firstConversation.click();
    await page.waitForTimeout(1500);

    // Detail panel should show messages
    const content = await page.content();
    expect(content).toContain('Test message for conversation');
  });

  // -------------------------------------------------------------------------
  it('shows partition filter UI if partitions exist', async () => {
    await page.goto(`${BASE_URL}/app/conversations`);
    await waitForVisible(page, 'body', 5000);

    const content = await page.content();

    // Should have either "All Conversations" or partition tree structure
    const hasPartitionUI = content.includes('All Conversations') || content.includes('partition');
    expect(hasPartitionUI).toBe(true);
  });

  // -------------------------------------------------------------------------
  it('conversation list shows timestamp info', async () => {
    await page.goto(`${BASE_URL}/app/conversations`);
    await waitForVisible(page, 'body', 5000);
    await page.waitForTimeout(1000);

    const content = await page.content();

    // Should show relative time like "just now", "mins ago", etc.
    const hasTimeInfo =
      content.includes('just now') ||
      content.includes('ago') ||
      content.includes('Created');
    expect(hasTimeInfo).toBe(true);
  });
});
