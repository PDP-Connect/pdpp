import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Hover over Accounts dropdown
await page.getByTestId('menu-item-dropdown-button:requestAccounts').hover();
await new Promise((r) => setTimeout(r, 2000));

const items = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  // Look for links/buttons with data-testid containing "navigation-dropdown" or similar
  const matches = els.filter((el) => {
    if (el.tagName !== 'A' && el.tagName !== 'BUTTON') return false;
    const t = (el.innerText || '').trim();
    return t && t.length < 60;
  });
  // Only show ones whose ancestor mentions the dropdown state being open
  return matches.slice(0, 60).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || '').slice(0, 60),
    href: el.getAttribute?.('href') || null,
    testid: el.getAttribute?.('data-testid') || null,
  })).filter((x) => /statement|document|secure message|profile|preference/i.test(x.text + ' ' + (x.testid || '')));
});
console.log('accounts menu matches:', JSON.stringify(items, null, 2));
await browser.close();
