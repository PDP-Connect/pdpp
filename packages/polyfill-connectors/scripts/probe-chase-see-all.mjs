import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/details/creditCard;params=CARD,BAC,1212486749,CARD-BAC-001', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 6000));

// Find and click "See all transactions" / "See all activity"
const clicked = await page.evaluate(() => {
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
  const target = els.find((el) => isVis(el) && /see all (transactions|activity|account activity)/i.test((el.innerText || '').trim()));
  if (!target) return { error: 'not_found' };
  target.click();
  return { clicked_text: (target.innerText || '').trim().slice(0, 60) };
});
console.log('click:', JSON.stringify(clicked));
await new Promise((r) => setTimeout(r, 6000));
console.log('url after:', page.url());

// Now look for download affordances
const info = await page.evaluate(() => {
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
  const actions = els
    .filter((el) => (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'MDS-BUTTON') && isVis(el))
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      testid: el.getAttribute?.('data-testid') || null,
      aria: (el.getAttribute?.('aria-label') || '').slice(0, 100),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    }));
  const dl = actions.filter((a) => /download|export|qfx|csv|ofx|quicken/i.test((a.aria || '') + ' ' + (a.text || '') + ' ' + (a.testid || '') + ' ' + (a.id || '')));
  return { total: actions.length, dl };
});
console.log('download matches:', JSON.stringify(info, null, 2));
await browser.close();
