import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Click the "Details" on the credit card accordion
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000));

// Try clicking the CARD_ACCOUNTS tile (or its Details button) to expand
const clickResult = await page.evaluate(() => {
  // First look for "Details" button inside the credit cards tile
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const tile = document.getElementById('CARD_ACCOUNTS');
  if (!tile) return { error: 'CARD_ACCOUNTS not found' };
  const tileEls = walk(tile);
  const detailsBtn = tileEls.find((el) => /^Details$/i.test((el.innerText || el.textContent || '').trim()) && (el.tagName === 'BUTTON' || el.tagName === 'A'));
  if (detailsBtn) { detailsBtn.click(); return { clicked: 'Details button via walk' }; }
  // Try the tile itself
  tile.click();
  return { clicked: 'CARD_ACCOUNTS tile click' };
});
console.log('click:', JSON.stringify(clickResult));
await new Promise((r) => setTimeout(r, 5000));
console.log('url:', page.url());

// Now dump any mds-list-items or links that look like individual accounts
const cards = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);

  const labels = els.filter((el) => {
    const s = (el.innerText || '').slice(0, 300);
    return /(Signature|Sapphire|Freedom|Prime|Amazon|Hyatt|United|Southwest|Ink|Platinum|Marriott|IHG|Disney).*(\(\.\.\.\d{3,4}\)|\*\d{3,4}|ending in \d{3,4}|\d{4}$)/i.test(s) ||
           /Checking\b.*(\(\.\.\.\d{3,4}\)|\*\d{3,4}|\d{4})/i.test(s);
  }).slice(0, 10);

  return labels.map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
    id: el.id || null,
    testid: el.getAttribute?.('data-testid') || null,
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  }));
});
console.log('cards:', JSON.stringify(cards, null, 2));
await page.screenshot({ path: '/tmp/chase-expanded.png', fullPage: true }).catch(() => {});
await browser.close();
