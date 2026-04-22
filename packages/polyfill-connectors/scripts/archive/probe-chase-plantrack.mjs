import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Back to account detail page and click on the account ID to see if there's a "Download transactions" link
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/details/creditCard;params=CARD,BAC,1212486749,CARD-BAC-001', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000));

// Enumerate EVERY visible action element
const all = await page.evaluate(() => {
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
  return els
    .filter((el) => (el.tagName === 'A' || el.tagName === 'BUTTON') && isVis(el))
    .map((el) => ({
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70),
      testid: el.getAttribute?.('data-testid') || null,
      id: el.id || null,
    }))
    .filter((x) => x.text && x.text.length < 70)
    .slice(0, 60);
});
console.log('all visible actions:', JSON.stringify(all, null, 2));
await browser.close();
