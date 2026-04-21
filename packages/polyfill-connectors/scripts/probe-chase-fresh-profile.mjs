/**
 * Test Chase login from a completely fresh browser profile (not the persistent
 * daemon one). If this succeeds where the daemon profile fails, Chase has
 * flagged the persistent profile specifically — and we need to either
 * (a) wipe the profile, or (b) accept that the device is burned.
 *
 * Uses rebrowser-playwright under Xvfb. DISPLAY must be set by the caller.
 */

import { chromium } from 'patchright';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '/home/user/code/pdpp/.env.local' });

const profileDir = mkdtempSync(join(tmpdir(), 'chase-fresh-'));
console.log('fresh profile:', profileDir);

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  channel: 'chrome',
  viewport: { width: 1280, height: 800 },
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-default-browser-check',
    '--no-first-run',
    '--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3',
  ],
});

const page = await context.newPage();
// Go to chase.com homepage first — Akamai expects a "warm-up" nav before
// hitting the login page directly.
await page.goto('https://www.chase.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3500));
// Simulate some idle time — Akamai's bm-verify beacon wants human-like gap.
await page.mouse.move(500, 400);
await new Promise((r) => setTimeout(r, 1500));
await page.mouse.move(600, 500);
await new Promise((r) => setTimeout(r, 1500));

await page.goto('https://secure.chase.com/web/auth/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 4000));

// Capture page state when login form expected
const initialUrl = page.url();
const initialBody = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
console.log('initial url:', initialUrl);
console.log('initial body:', initialBody);

if (/logon\/error/.test(initialUrl)) {
  console.log('BLOCKED on first navigation (before any credential attempt)');
  await context.close();
  await rm(profileDir, { recursive: true, force: true });
  process.exit(2);
}

const username = process.env.CHASE_USERNAME;
const password = process.env.CHASE_PASSWORD;

const userField = page.locator('input#userId-input-field-input, input[name="username"], input#userId-text-input-field').first();
await userField.waitFor({ state: 'visible', timeout: 15000 });
await userField.fill(username);
await page.locator('input#password-input-field-input, input#password-text-input-field, input[type="password"]').first().fill(password);
await page.locator('button#signin-button').click({ timeout: 5000 });
await new Promise((r) => setTimeout(r, 8000));

const url = page.url();
const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
console.log('url:', url);
console.log('body:', body.replace(/\s+/g, ' '));
console.log('result:', /logon\/error/.test(url) ? 'BLOCKED' : /Confirm Your Identity|Sign out/i.test(body) ? 'PROGRESS' : 'UNKNOWN');

// Capture cookies Chase set on the way in
const cookies = await context.cookies();
const akamaiCookies = cookies.filter((c) => /_abck|bm_sz|bm_sv|ak_bmsc/.test(c.name));
console.log('akamai cookies set:', akamaiCookies.map((c) => c.name));

await context.close();
await rm(profileDir, { recursive: true, force: true });
