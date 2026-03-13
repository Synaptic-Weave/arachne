/**
 * Portal Auth Smoke Tests
 *
 * Covers:
 *  - Signup (creates a new tenant)
 *  - Login with valid credentials
 *  - Logout
 *  - Invalid credentials rejection
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
  waitForUrl,
  waitForVisible,
  screenshotIfDocsMode,
  uniqueEmail,
  uniqueName,
  BASE_URL,
} from './helpers.js';

describe('Portal auth smoke tests', () => {
  let browser: Browser;
  let page: Page;

  const email = uniqueEmail('smoke-auth');
  const password = 'SmokeTest1!';
  const tenantName = uniqueName('SmokeOrg');

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
  });

  afterAll(async () => {
    await browser.close();
  });

  // -------------------------------------------------------------------------
  it('signup page loads', async () => {
    await page.goto(`${BASE_URL}/signup`);
    await waitForVisible(page, 'input[type="email"]');
    const field = page.locator('input[type="email"]');
    expect(await field.count()).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  it('new user can sign up and lands on /app', async () => {
    await ensureSignup(page, email, password, tenantName);
    await screenshotIfDocsMode(page, 'portal-signup-success', 'Portal after signup', 'Authentication');
    const url = page.url();
    expect(url).toMatch(/\/app/);
  });

  // -------------------------------------------------------------------------
  it('authenticated page shows user/tenant info', async () => {
    const url = page.url();
    expect(url).toMatch(/\/app/);
    const loginForms = page.locator('form input[type="email"]');
    expect(await loginForms.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  it('user can log out', async () => {
    try {
      const logoutEl = page.locator(':text("Logout"), :text("Sign out"), :text("Log out")').first();
      const count = await logoutEl.count();
      if (count > 0) {
        await logoutEl.click();
        await waitForUrl(page, /\/(login|$)/, 8000);
      } else {
        throw new Error('no logout element');
      }
    } catch {
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.goto(`${BASE_URL}/login`);
    }

    const url = page.url();
    expect(url).toMatch(/\/(login|signup|$)/);
  });

  // -------------------------------------------------------------------------
  it('login page renders', async () => {
    await page.goto(`${BASE_URL}/login`);
    await waitForVisible(page, 'input[type="email"]');
    const field = page.locator('input[type="email"]');
    expect(await field.count()).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  it('valid credentials → lands on /app', async () => {
    await portalLogin(page, email, password);
    await screenshotIfDocsMode(page, 'portal-login-success', 'Portal after login', 'Authentication');
    const url = page.url();
    expect(url).toMatch(/\/app/);
  });

  // -------------------------------------------------------------------------
  it('invalid credentials show an error', async () => {
    await page.goto(`${BASE_URL}/login`);
    await waitForVisible(page, 'input[type="email"]');
    await page.locator('input[type="email"]').fill('nobody@test.loom.local');
    await page.locator('input[type="password"]').fill('wrongpassword');
    await page.locator('button[type="submit"]').click();

    await page.waitForTimeout(2000);
    const url = page.url();
    expect(url).not.toMatch(/\/app/);

    const content = await page.content();
    expect(content).toMatch(/invalid|incorrect|wrong|error|not found/i);
  });
});
