import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

await page.getByTestId('menu-item-dropdown-button:requestAccounts').click();
await new Promise((r) => setTimeout(r, 2000));

// Grab all visible links/buttons with useful text
const items = await page.evaluate(() => {
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
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      href: el.getAttribute?.('href') || null,
      testid: el.getAttribute?.('data-testid') || null,
    }))
    .filter((x) => x.text && x.text.length < 80 && /statement|document|download|export|activity|transaction/i.test(x.text + ' ' + (x.testid || '') + ' ' + (x.href || '')));
});
console.log('menu items:', JSON.stringify(items, null, 2));
await page.screenshot({ path: '/tmp/chase-accounts-menu.png', fullPage: true }).catch(() => {});
await browser.close();
