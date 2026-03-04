import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const BASE_URL = process.env['LOOM_BASE_URL'] ?? 'http://localhost:3000';
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'changeme';
export const HEADLESS = process.env.HEADLESS !== 'false';
export const DOCS_MODE = process.env.DOCS_MODE === 'true';

// ---------------------------------------------------------------------------
// Browser/page lifecycle
// ---------------------------------------------------------------------------
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: HEADLESS });
}

export async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return context.newPage();
}

// ---------------------------------------------------------------------------
// Screenshot helper for docs
// ---------------------------------------------------------------------------
const SCREENSHOTS_DIR = join(process.cwd(), 'docs', 'screenshots');

export async function screenshotIfDocsMode(
  page: Page,
  name: string,
  caption: string,
  section: string = 'General'
): Promise<void> {
  if (!DOCS_MODE) return;
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS_DIR, `${name}.png`), fullPage: false });
  writeFileSync(
    join(SCREENSHOTS_DIR, `${name}.json`),
    JSON.stringify({ caption, section, name, timestamp: new Date().toISOString() }, null, 2)
  );
}

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------
export async function waitForUrl(page: Page, pattern: RegExp, timeout = 10000) {
  await page.waitForURL(pattern, { timeout });
}

export async function waitForVisible(page: Page, selector: string, timeout = 10000) {
  await page.locator(selector).first().waitFor({ state: 'visible', timeout });
}

export async function waitForElement(page: Page, selector: string, timeout = 10000) {
  await page.locator(selector).waitFor({ state: 'attached', timeout });
}

export async function waitForText(page: Page, selector: string, text: string, timeout = 10000) {
  await page.locator(selector).filter({ hasText: text }).waitFor({ state: 'visible', timeout });
}

// ---------------------------------------------------------------------------
// Login helpers
// ---------------------------------------------------------------------------
export async function adminLogin(page: Page) {
  await page.goto(`${BASE_URL}/dashboard/admin`);
  await page.locator('input[placeholder="admin"], input[type="text"]').first().fill(ADMIN_USERNAME);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();

  // Handle force-change-password modal if must_change_password flag is set
  const forceDialog = page.locator('[aria-label="Change Password"]');
  const isForced = await forceDialog.isVisible({ timeout: 3000 }).catch(() => false);
  if (isForced) {
    await page.locator('[aria-label="New Password"]').fill(ADMIN_PASSWORD);
    await page.locator('[aria-label="Confirm Password"]').fill(ADMIN_PASSWORD);
    await page.locator('[aria-label="Change Password"] button[type="submit"]').click();
  }

  await waitForUrl(page, /\/dashboard\/admin/, 10000);
}

export async function portalLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await waitForUrl(page, /\/dashboard|\/traces|\/analytics|\/app/);
}

/** Navigate to a portal app URL, re-authenticating if the auth context redirects to login. */
export async function navigateTo(
  page: Page,
  url: string,
  email: string,
  password: string
): Promise<void> {
  await page.goto(url);
  // Give React time to finish auth refresh — if redirected to login, re-authenticate
  await page.waitForTimeout(1500);
  if (page.url().includes('/login')) {
    await portalLogin(page, email, password);
    await page.goto(url);
    await page.waitForTimeout(500);
  }
}

export async function portalSignup(
  page: Page,
  opts: { email: string; password: string; tenantName?: string }
): Promise<void>;
export async function portalSignup(
  page: Page,
  email: string,
  password: string,
  tenantName?: string
): Promise<void>;
export async function portalSignup(
  page: Page,
  emailOrOpts: string | { email: string; password: string; tenantName?: string },
  password?: string,
  tenantName?: string
): Promise<void> {
  let email: string;
  let pass: string;
  let name: string | undefined;

  if (typeof emailOrOpts === 'string') {
    email = emailOrOpts;
    pass = password!;
    name = tenantName;
  } else {
    email = emailOrOpts.email;
    pass = emailOrOpts.password;
    name = emailOrOpts.tenantName;
  }

  await page.goto(`${BASE_URL}/signup`);
  if (name) {
    const nameInput = page.locator('input[name="tenantName"], input[placeholder*="org" i], input[placeholder*="company" i], input[placeholder*="tenant" i], input[placeholder*="Acme" i], input[placeholder*="corp" i], input[placeholder*="organization" i]').first();
    const count = await nameInput.count();
    if (count > 0) await nameInput.fill(name);
  }
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();

  // Handle API key reveal modal if present, then redirect to /app
  await page.waitForFunction(
    () => {
      const url = window.location.href;
      if (url.includes('/app')) return true;
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some(b => b.textContent?.includes('saved'));
    },
    { timeout: 15000 }
  );

  const dismissBtns = page.locator('button:has-text("saved")');
  const dismissCount = await dismissBtns.count();
  if (dismissCount > 0) {
    await dismissBtns.first().click();
  }

  await waitForUrl(page, /\/app/);
}

export async function acceptInvite(
  page: Page,
  inviteUrl: string,
  email: string,
  password: string
): Promise<void> {
  await page.goto(inviteUrl);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await waitForUrl(page, /\/app/);
}

export async function portalLogout(page: Page) {
  const logoutBtn = page.locator('button:has-text("Logout"), button:has-text("Sign out"), a:has-text("Logout"), a:has-text("Sign out")').first();
  await logoutBtn.click();
  await waitForUrl(page, /\/login|\/$/);
}

// ---------------------------------------------------------------------------
// Unique test data helpers
// ---------------------------------------------------------------------------
let _seq = Date.now();

export function uniqueEmail(prefix = 'smoke'): string {
  return `${prefix}+${_seq++}@test.loom.local`;
}

export function uniqueName(prefix = 'Smoke'): string {
  return `${prefix} ${_seq++}`;
}
