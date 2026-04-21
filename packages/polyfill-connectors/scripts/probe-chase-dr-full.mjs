import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com')) || await ctx.newPage();

// Dashboard warm
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));

// Download form
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/downloadAccountTransactions/index;params=CARD,BAC,1212486749', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.locator('#downloadFileTypeOption').waitFor({ state: 'attached', timeout: 15000 });

// QFX
await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const sel = walk(document).find((e) => e.id === 'downloadFileTypeOption');
  if (sel) { sel.setAttribute('value', 'QFX'); sel.setAttribute('selected-index', '1'); sel.dispatchEvent(new Event('change', { bubbles: true, composed: true })); }
});

// Choose a date range
await page.locator('#select-downloadActivityOptionId').click();
await page.getByRole('option', { name: /^Choose a date range$/i }).click({ timeout: 10000 });
await new Promise((r) => setTimeout(r, 3000));

// Dump EVERY element with `date` / `from` / `to` / `start` / `end` in id/class/label/placeholder/aria
const info = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const els = walk(document);
  const matches = els.filter((el) => {
    const s = [
      el.id || '',
      (typeof el.className === 'string') ? el.className : '',
      el.getAttribute?.('label') || '',
      el.getAttribute?.('placeholder') || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('data-testid') || '',
      el.name || '',
    ].join(' ');
    return /date|from|to\b|start|end|range|picker|calendar/i.test(s);
  }).slice(0, 50).map((el) => {
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
      label: el.getAttribute?.('label') || null,
      aria: el.getAttribute?.('aria-label') || null,
      placeholder: el.getAttribute?.('placeholder') || null,
      visible: (cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0),
      value: (el.value?.toString() || el.getAttribute?.('value') || '').slice(0, 40),
    };
  });
  return { matches, count: matches.length };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: '/tmp/chase-daterange.png', fullPage: true }).catch(() => {});
await browser.close();
