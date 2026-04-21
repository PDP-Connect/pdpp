import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('chase.com'));
if (!page) page = await ctx.newPage();

// Go back to dashboard and click the Sapphire Preferred card — that path showed transactionDetails anchors
await page.goto('https://secure.chase.com/web/auth/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000));
console.log('dashboard url:', page.url());

// Click the Sapphire Preferred button (the same one that led to transactionDetails anchors earlier)
await page.getByRole('button', { name: /Sapphire Preferred/i }).first().click().catch(() => {});
await new Promise((r) => setTimeout(r, 6000));
console.log('after card click:', page.url());

const txList = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const anchors = els.filter((el) => el.tagName === 'A' && /transactionDetails/i.test(el.getAttribute('href') || ''));
  return anchors.slice(0, 15).map((a) => ({
    href: a.getAttribute('href'),
    aria: a.getAttribute('aria-label') || '',
    // walk up to find the row container with full text
    row_text: (() => {
      let cur = a;
      for (let i = 0; i < 6 && cur; i++) {
        const t = (cur.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length > 30 && t.length < 300 && /\$[\d,]+\.\d{2}/.test(t)) return t;
        cur = cur.parentElement;
      }
      return (a.innerText || '').slice(0, 60);
    })(),
  }));
});
console.log('transaction anchors:', JSON.stringify(txList, null, 2));

// Look for download icon near the txn list
const icons = await page.evaluate(() => {
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
  // Any element whose aria-label mentions download/export/CSV/QFX
  return els
    .filter((el) => isVis(el) && /download|export|\.qfx|\.csv|quicken/i.test(el.getAttribute?.('aria-label') || ''))
    .slice(0, 10)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      testid: el.getAttribute?.('data-testid') || null,
      aria: el.getAttribute('aria-label'),
      text: (el.innerText || '').slice(0, 40),
    }));
});
console.log('download icons:', JSON.stringify(icons, null, 2));

await page.screenshot({ path: '/tmp/chase-txn-page.png', fullPage: true }).catch(() => {});
console.log('screenshot: /tmp/chase-txn-page.png');
await browser.close();
