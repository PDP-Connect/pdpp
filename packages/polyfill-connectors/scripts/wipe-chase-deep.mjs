/**
 * Surgical wipe of Chase state from the persistent daemon profile:
 *   - All chase.com cookies
 *   - All localStorage + sessionStorage on chase.com origins
 *   - All IndexedDB for chase.com via CDP Storage.clearDataForOrigin
 *   - Service workers for chase.com
 *
 * Preserves other connector profiles (USAA, Amazon, ChatGPT).
 */
import { chromium } from 'patchright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];

// Cookies
const before = (await ctx.cookies()).filter((c) => c.domain.includes('chase')).length;
await ctx.clearCookies({ domain: /chase/i });
console.log(`cookies wiped: ${before} -> 0`);

// Navigate to chase.com to get a Chase-origin page so we can wipe its storage
const page = await ctx.newPage();
await page.goto('https://www.chase.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

// Wipe localStorage + sessionStorage on chase.com
try {
  await page.evaluate(() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  });
  console.log('localStorage + sessionStorage cleared for www.chase.com');
} catch (err) {
  console.log('storage clear failed:', err.message);
}

// Wipe IndexedDB + service workers via CDP Storage domain
const client = await ctx.newCDPSession(page);
for (const origin of ['https://www.chase.com', 'https://secure.chase.com', 'https://chase.com']) {
  try {
    await client.send('Storage.clearDataForOrigin', {
      origin,
      storageTypes: 'appcache,cookies,file_systems,indexeddb,local_storage,shader_cache,websql,service_workers,cache_storage',
    });
    console.log(`cleared all storage for ${origin}`);
  } catch (err) {
    console.log(`failed to clear ${origin}:`, err.message.slice(0, 120));
  }
}

// Also hit secure.chase.com directly in case it has its own storage silo
await page.goto('https://secure.chase.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));
try {
  await page.evaluate(() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  });
  console.log('localStorage + sessionStorage cleared for secure.chase.com');
} catch {}

await page.close().catch(() => {});
await browser.close();
