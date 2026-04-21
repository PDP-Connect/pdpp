/**
 * Navigate to Chase's download form and try to open the Activity dropdown
 * by clicking its trigger button. If options render, enumerate them and
 * look for a "Date range" / similar option.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('chase.com'));
if (!page) page = await ctx.newPage();

// Navigate fresh to the download form
const url = 'https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/downloadAccountTransactions/index;params=CARD,BAC,1212486749';
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.locator('#downloadFileTypeOption').waitFor({ state: 'attached', timeout: 15000 });
console.log('on download form');

// Before click — state
const before = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const sel = walk(document).find((e) => e.id === 'downloadActivityOptionId');
  return { value: sel?.getAttribute('value'), options: sel?.getAttribute('options') };
});
console.log('before:', JSON.stringify(before));

// Click the trigger button via Playwright trusted click
await page.locator('#select-downloadActivityOptionId').click({ timeout: 10000 });

// Wait for a list-item or option element to appear
await page.locator('mds-list-item, [role="option"]').first()
  .waitFor({ state: 'visible', timeout: 5000 })
  .catch(() => {});

const after = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const isVis = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };
  // Any visible list-item with a label
  const items = els
    .filter((el) => isVis(el) && (el.tagName === 'MDS-LIST-ITEM' || el.getAttribute?.('role') === 'option'))
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      label: el.getAttribute?.('label') || (el.textContent || '').trim().slice(0, 80),
      value: el.getAttribute?.('value') || null,
    }));
  const sel = els.find((e) => e.id === 'downloadActivityOptionId');
  return {
    items,
    select_options_attr: sel?.getAttribute('options'),
    select_value: sel?.getAttribute('value'),
    select_selected_index: sel?.getAttribute('selected-index'),
  };
});
console.log('after:', JSON.stringify(after, null, 2));

await page.screenshot({ path: '/tmp/chase-activity-dropdown.png', fullPage: true }).catch(() => {});
await browser.close();
