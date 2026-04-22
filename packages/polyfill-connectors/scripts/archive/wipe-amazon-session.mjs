/**
 * Clear Amazon cookies + storage to force a fresh 2FA-gated login on the
 * next probe. Used to verify the auto-login flow handles a cold session
 * (not just a warm profile). Chase is untouched.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];

// Navigate to Amazon to hit sign-out if possible first
let page = ctx.pages().find((p) => p.url().includes('amazon.com'));
if (!page) page = await ctx.newPage();

// Try server-side sign-out (revokes the token on Amazon's side, not just cookies)
try {
  await page.goto('https://www.amazon.com/gp/flex/sign-out.html?path=%2Fgp%2Fyourstore%2Fhome&signIn=1&useRedirectOnSuccess=1&action=sign-out&ref_=nav_AccountFlyout_signout', {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  console.log('[wipe] hit signout URL:', page.url());
  await page.waitForTimeout(3000);
} catch (e) {
  console.log('[wipe] signout nav failed:', e.message);
}

// Clear cookies for amazon domains
const before = await ctx.cookies();
const amazonCookies = before.filter((c) => c.domain.includes('amazon.com') || c.domain.includes('amazon.') );
console.log(`[wipe] amazon cookies before: ${amazonCookies.length}`);
// Remove via clearCookies with a domain filter (Playwright 1.43+ supports this)
await ctx.clearCookies({ domain: /amazon/i });
const after = (await ctx.cookies()).filter((c) => c.domain.includes('amazon.'));
console.log(`[wipe] amazon cookies after: ${after.length}`);

// Clear local/session storage on any open amazon page
try {
  await page.evaluate(() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  });
  console.log('[wipe] cleared localStorage + sessionStorage on current page');
} catch {}

await browser.close();
console.log('[wipe] done');
