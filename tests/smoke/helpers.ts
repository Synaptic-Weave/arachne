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

/**
 * Wait for the React SPA to mount and render content inside #root.
 * Returns true if the app rendered, false if it timed out (empty #root).
 */
export async function waitForAppReady(page: Page, timeout = 10000): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById('root');
        return root !== null && root.children.length > 0;
      },
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

export async function waitForText(page: Page, selector: string, text: string, timeout = 10000) {
  await page.locator(selector).filter({ hasText: text }).waitFor({ state: 'visible', timeout });
}

// ---------------------------------------------------------------------------
// Login helpers
// ---------------------------------------------------------------------------
export async function adminLogin(page: Page) {
  await page.goto(`${BASE_URL}/dashboard/admin`);

  // Wait for login form to be visible
  await page.waitForSelector('input[type="text"], input[placeholder*="admin" i], input[type="password"]', { timeout: 5000 });

  await page.locator('input[placeholder="admin"], input[placeholder*="Username" i], input[type="text"]').first().fill(ADMIN_USERNAME);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();

  // Wait for either the admin panel or force-change-password dialog
  await page.waitForFunction(
    () => {
      const hasAdminHeader = document.querySelector('.admin-header') !== null;
      const hasForceDialog = document.querySelector('[aria-label="Change Password"]') !== null;
      const hasTenantsList = document.querySelector('.tenants-list') !== null;
      const hasAdminPage = document.querySelector('.admin-page') !== null;
      const hasError = document.body.textContent?.includes('Invalid credentials');
      return hasAdminHeader || hasForceDialog || hasTenantsList || hasAdminPage || hasError;
    },
    { timeout: 60000 }
  );

  // Check for login error
  const errorText = await page.locator('.admin-login-error, .error').textContent().catch(() => '');
  if (errorText) {
    throw new Error(`Admin login failed: ${errorText}`);
  }

  // Handle force-change-password modal if must_change_password flag is set
  const forceDialog = page.locator('[aria-label="Change Password"]');
  const isForced = await forceDialog.isVisible().catch(() => false);
  if (isForced) {
    await page.locator('[aria-label="New Password"]').fill(ADMIN_PASSWORD);
    await page.locator('[aria-label="Confirm Password"]').fill(ADMIN_PASSWORD);
    await page.locator('[aria-label="Change Password"] button[type="submit"]').click();

    // Wait for admin panel after password change
    await page.waitForSelector('.admin-header', { timeout: 10000 });
  }
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

  // Wait for the signup form to be ready
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);

  if (name) {
    const nameInput = page.locator('input[name="tenantName"], input[placeholder*="org" i], input[placeholder*="company" i], input[placeholder*="tenant" i], input[placeholder*="Acme" i], input[placeholder*="corp" i], input[placeholder*="organization" i]').first();
    await nameInput.waitFor({ state: 'visible', timeout: 10000 });
    await nameInput.fill(name);
  }

  await page.locator('input[type="email"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 10000 });
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

  // Wait for the signup form to be ready
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);

  await page.locator('input[type="email"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await waitForUrl(page, /\/app/);
}

// ---------------------------------------------------------------------------
// Admin token helper (API-based, no browser)
// ---------------------------------------------------------------------------
export async function getAdminToken(): Promise<string> {
  const resp = await fetch(`${BASE_URL}/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  if (!resp.ok) {
    throw new Error(`Admin login failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json() as { token: string };
  return data.token;
}

// ---------------------------------------------------------------------------
// Beta signup flow (for environments with SIGNUPS_ENABLED=false)
// ---------------------------------------------------------------------------
export async function portalBetaSignup(
  page: Page,
  email: string,
  password: string,
  tenantName?: string
): Promise<void> {
  // 1. Submit beta signup request
  const signupResp = await fetch(`${BASE_URL}/v1/beta/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!signupResp.ok) {
    throw new Error(`Beta signup failed: ${signupResp.status} ${await signupResp.text()}`);
  }

  // 2. Get admin token
  const adminToken = await getAdminToken();

  // 3. Find the signup by email
  const listResp = await fetch(`${BASE_URL}/v1/admin/beta/signups`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!listResp.ok) {
    throw new Error(`Failed to list beta signups: ${listResp.status}`);
  }
  const { signups } = await listResp.json() as { signups: Array<{ id: string; email: string; inviteCode: string | null }> };
  const signup = signups.find((s) => s.email === email.toLowerCase());
  if (!signup) {
    throw new Error(`Beta signup not found for ${email}`);
  }

  // 4. Approve the signup
  const approveResp = await fetch(`${BASE_URL}/v1/admin/beta/approve/${signup.id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!approveResp.ok) {
    throw new Error(`Failed to approve beta signup: ${approveResp.status}`);
  }
  const approved = await approveResp.json() as { inviteCode: string };
  const inviteCode = approved.inviteCode;

  // 5. Create the account via direct API call so we can pass tenantName
  const signupResp2 = await fetch(`${BASE_URL}/v1/portal/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      inviteToken: inviteCode,
      ...(tenantName ? { tenantName } : {}),
    }),
  });
  if (!signupResp2.ok) {
    throw new Error(`Signup via invite failed: ${signupResp2.status} ${await signupResp2.text()}`);
  }
  const signupResult = await signupResp2.json() as { token: string };

  // 6. Set the auth token in the browser and navigate to /app
  await page.goto(`${BASE_URL}/login`);
  await page.evaluate((token) => {
    localStorage.setItem('loom_portal_token', token);
  }, signupResult.token);
  await page.goto(`${BASE_URL}/app`);
  await waitForUrl(page, /\/app/);
}

// ---------------------------------------------------------------------------
// Auto-detect signup mode and use appropriate flow
// ---------------------------------------------------------------------------
export async function ensureSignup(
  page: Page,
  email: string,
  password: string,
  tenantName?: string
): Promise<void>;
export async function ensureSignup(
  page: Page,
  opts: { email: string; password: string; tenantName?: string }
): Promise<void>;
export async function ensureSignup(
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

  // Check if self-service signups are enabled
  const resp = await fetch(`${BASE_URL}/v1/beta/signups-enabled`);
  const { signupsEnabled } = await resp.json() as { signupsEnabled: boolean };

  if (signupsEnabled) {
    await portalSignup(page, email, pass, name);
  } else {
    await portalBetaSignup(page, email, pass, name);
  }
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
