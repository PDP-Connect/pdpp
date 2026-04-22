import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com')) || await ctx.newPage();

await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/downloadAccountTransactions/index;params=CARD,BAC,1212486749', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.locator('#downloadFileTypeOption').waitFor({ state: 'attached', timeout: 15000 });

// Set QFX, pick date range
await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const sel = walk(document).find((e) => e.id === 'downloadFileTypeOption');
  if (sel) { sel.setAttribute('value', 'QFX'); sel.setAttribute('selected-index', '1'); sel.dispatchEvent(new Event('change', { bubbles: true, composed: true })); }
});
await page.locator('#select-downloadActivityOptionId').click();
await page.getByRole('option', { name: /^Choose a date range$/i }).click({ timeout: 10000 });
await new Promise((r) => setTimeout(r, 4000));

// Take a screenshot + read the activity select's current value
const after = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const sel = walk(document).find((e) => e.id === 'downloadActivityOptionId');
  return {
    activity_value: sel?.getAttribute('value'),
    activity_selected_index: sel?.getAttribute('selected-index'),
  };
});
console.log('after:', JSON.stringify(after));

// Dump ALL custom element tags on page and find ones containing date-picker-like tags
const allTags = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const els = walk(document);
  const tags = [...new Set(els.map((e) => e.tagName.toLowerCase()))];
  return tags;
});
const dateishTags = allTags.filter((t) => /date|calendar|picker|range|from|start|end/i.test(t));
console.log('date-ish tags:', JSON.stringify(dateishTags));
await page.screenshot({ path: '/tmp/chase-dr-after.png', fullPage: true }).catch(() => {});
console.log('screenshot: /tmp/chase-dr-after.png');
await browser.close();
