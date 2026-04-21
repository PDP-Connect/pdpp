import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('chase.com'));

// Try the accounts-summary view explicitly
const candidates = [
  'https://secure.chase.com/web/auth/dashboard#/dashboard/accounts',
  'https://secure.chase.com/web/auth/dashboard#/dashboard/overview',
  'https://secure.chase.com/web/auth/dashboard#/dashboard/summary',
  'https://secure.chase.com/web/auth/dashboard#/dashboard/index',
  'https://secure.chase.com/web/auth/dashboard',
];

for (const url of candidates) {
  console.log(`\n=== trying ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('nav err:', e.message));
  await new Promise((r) => setTimeout(r, 4000));
  const finalUrl = page.url();
  console.log('landed:', finalUrl);
  const bodyPreview = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
  console.log('body:', bodyPreview);
  if (/accountDetails|Current balance/i.test(bodyPreview) && /Credit card|Checking|Savings/i.test(bodyPreview)) break;
}
// Now dump what's actually on page
const info = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const cards = els.filter((el) => {
    const text = (el.innerText || el.textContent || '').slice(0, 200);
    return /(Credit card|Checking|Savings|Money Market)\b[^\n]{0,50}\$/.test(text);
  }).slice(0, 10).map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
    id: el.id || null,
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
  }));
  return { cards };
});
console.log('\nACCOUNT-LIKE ELEMENTS:');
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: '/tmp/chase-overview.png', fullPage: true }).catch(() => {});
await browser.close();
