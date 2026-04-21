/**
 * Open Chase + Amazon sign-in pages in the headed browser daemon.
 *
 * Critically: we do NOT call release() — that function closes non-blank
 * pages as part of its cleanup, which was closing the tabs the human is
 * supposed to log into. Instead we connect via CDP directly, navigate,
 * and exit without touching page lifecycle.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const discovery = JSON.parse(
  readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8')
);
const browser = await chromium.connectOverCDP(discovery.wsEndpoint);
const context = browser.contexts()[0];

const amazonUrl = 'https://www.amazon.com/gp/sign-in.html';
const chaseUrl = 'https://secure.chase.com/web/auth/dashboard';

async function ensureTab(url) {
  const pages = context.pages();
  // Reuse an existing tab on the same origin if present
  const origin = new URL(url).origin;
  for (const p of pages) {
    try {
      if (new URL(p.url()).origin === origin) {
        console.log(`[reuse] ${p.url()}`);
        return p;
      }
    } catch {}
  }
  // Reuse about:blank if any
  for (const p of pages) {
    if (p.url() === 'about:blank') {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      console.log(`[reused blank] ${p.url()}`);
      return p;
    }
  }
  // Otherwise open a new tab
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  console.log(`[new] ${page.url()}`);
  return page;
}

await ensureTab(amazonUrl);
await ensureTab(chaseUrl);

console.log('\nTabs ready. The browser window stays open.');
console.log('Log into each. Cookies persist via the daemon profile.');

// Disconnect our CDP client WITHOUT closing tabs.
// browser.close() here disconnects the CDP client only — tabs stay alive
// in the underlying daemon Chromium because it's a separate process.
await browser.close();
