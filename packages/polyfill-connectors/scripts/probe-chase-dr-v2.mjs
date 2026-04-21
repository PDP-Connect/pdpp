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

// File type via clicking
await page.locator('#select-downloadFileTypeOption').click();
await page.getByRole('option', { name: /^Quicken Web Connect/i }).click({ timeout: 10000 });
await new Promise((r) => setTimeout(r, 1500));
const ftCheck = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  return walk(document).find((e) => e.id === 'downloadFileTypeOption')?.getAttribute('value');
});
console.log('file type after click-select:', ftCheck);

// Activity via clicking
await page.locator('#select-downloadActivityOptionId').click();
await page.getByRole('option', { name: /^Choose a date range$/i }).click({ timeout: 10000 });
await new Promise((r) => setTimeout(r, 3000));
const actCheck = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  return walk(document).find((e) => e.id === 'downloadActivityOptionId')?.getAttribute('value');
});
console.log('activity after click-select:', actCheck);
await page.screenshot({ path: '/tmp/chase-dr-v2.png', fullPage: true }).catch(() => {});

// Dump date-ish elements
const dateish = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const els = walk(document);
  const tags = [...new Set(els.map((e) => e.tagName.toLowerCase()))];
  return { dateishTags: tags.filter((t) => /date|calendar|picker/i.test(t)), all_mds: tags.filter((t) => t.startsWith('mds-')) };
});
console.log('tags:', JSON.stringify(dateish));
await browser.close();
