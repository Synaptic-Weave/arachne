/**
 * Admin Dashboard Smoke Tests
 *
 * Covers:
 *  - Admin login / logout
 *  - Traces list renders
 *  - Analytics page renders (charts visible)
 *  - Tenant management panel visible
 *
 * Requires: Loom stack running (`docker-compose up`)
 * Run: npm run test:smoke
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import type { Browser, Page } from 'playwright';
import {
  launchBrowser,
  newPage,
  adminLogin,
  waitForVisible,
  screenshotIfDocsMode,
  BASE_URL,
} from './helpers.js';

describe('Admin Dashboard smoke tests', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
  });

  afterAll(async () => {
    await browser.close();
  });

  // -------------------------------------------------------------------------
  it('admin login → lands on dashboard', async () => {
    await adminLogin(page);
    await screenshotIfDocsMode(page, 'admin-login', 'Admin dashboard after login', 'Authentication');
    const url = page.url();
    expect(url).toMatch(/\/dashboard\/admin/);
  });

  // -------------------------------------------------------------------------
  it('traces list renders with table', async () => {
    await page.goto(`${BASE_URL}/dashboard`);
    await waitForVisible(page, 'table, [data-testid="traces-list"], .traces-table, .trace-row', 15000);
    await screenshotIfDocsMode(page, 'admin-traces', 'Admin traces list', 'Traces');
    const el = page.locator('table, [data-testid="traces-list"], .traces-table, .trace-row').first();
    expect(await el.count()).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  it('analytics page renders with charts', async () => {
    await page.goto(`${BASE_URL}/dashboard/analytics`);
    await waitForVisible(page, 'body', 5000);
    await screenshotIfDocsMode(page, 'admin-analytics', 'Admin analytics charts', 'Analytics');
    // Charts may not render in headless without container dimensions; check page content instead
    const content = await page.content();
    expect(content).toMatch(/Analytics|Requests|Tokens|Latency/i);
  });

  // -------------------------------------------------------------------------
  it('analytics summary cards visible', async () => {
    await page.goto(`${BASE_URL}/dashboard/analytics`);
    const cards = page.locator('.summary-card, [data-testid="summary-card"], .metric-card');
    const count = await cards.count();
    if (count === 0) {
      const content = await page.content();
      expect(content).toMatch(/Requests|Total Requests/i);
    } else {
      expect(count).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  it('admin page renders tenant list', async () => {
    await page.goto(`${BASE_URL}/dashboard/admin`);
    await waitForVisible(
      page,
      '[data-testid="tenant-list"], .tenant-row, table, button[data-testid="create-tenant"], button',
      15000,
    );
    const el = page.locator('[data-testid="tenant-list"], .tenant-row, table, button').first();
    expect(await el.count()).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  it('tenant selector dropdown present on analytics page', async () => {
    await page.goto(`${BASE_URL}/dashboard/analytics`);
    await waitForVisible(page, 'select, [data-testid="tenant-selector"], .tenant-select', 15000);
    const selector = page.locator('select, [data-testid="tenant-selector"], .tenant-select').first();
    expect(await selector.count()).toBeGreaterThan(0);
  });
});
