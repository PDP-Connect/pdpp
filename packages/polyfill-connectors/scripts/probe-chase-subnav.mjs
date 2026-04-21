import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/details/creditCard;params=CARD,BAC,1212486749,CARD-BAC-001', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000));

// Earlier probe showed a secondary menu with "Pay bills / Card balance transfers / Payment activity"
// Let me check for OTHER sub-tabs that might exist (e.g. "Transactions" or "Activity")
const subtabs = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  // Look in mds-navigation-bar and mds-navigation-bar-item
  const navbars = els.filter((el) => el.tagName.toLowerCase() === 'mds-navigation-bar' || el.tagName.toLowerCase() === 'mds-navigation-bar-item');
  return navbars.map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    attrs: [...el.attributes].filter((a) => /label|href|test|data-/i.test(a.name)).map((a) => `${a.name}=${a.value.slice(0, 60)}`),
  }));
});
console.log('navbars:', JSON.stringify(subtabs, null, 2));

// Also try navigating to common activity URLs
const urls = [
  'https://secure.chase.com/web/auth/dashboard#/dashboard/activity/details/index;params=CARD,BAC,1212486749',
  'https://secure.chase.com/web/auth/dashboard#/dashboard/cardDetails/activity;params=CARD,BAC,1212486749',
  'https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/activity;params=CARD,BAC,1212486749',
];
for (const u of urls) {
  await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  const url = page.url();
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 200);
  console.log(`\n${u}\n  -> ${url}\n  preview: ${text.replace(/\s+/g, ' ')}`);
}
await browser.close();
