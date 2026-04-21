import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Ensure we're on dashboard
await page.goto('https://secure.chase.com/web/auth/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 4000));

// Open Accounts menu
await page.getByTestId('menu-item-dropdown-button:requestAccounts').click();
await new Promise((r) => setTimeout(r, 1500));

// Click Statements & documents
await page.getByTestId('requestAccountStatements').click();
await new Promise((r) => setTimeout(r, 6000));
console.log('url:', page.url());
console.log('title:', await page.title());

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
  const buttons = els
    .filter((el) => (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'SELECT') && isVis(el))
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      href: el.getAttribute?.('href') || null,
      testid: el.getAttribute?.('data-testid') || null,
      id: el.id || null,
    }))
    .filter((x) => x.text && /download|export|statement|activity|quicken|qfx|csv|ofx|document/i.test(x.text));
  // Also any select dropdowns (format chooser likely)
  const selects = [...document.querySelectorAll('select')]
    .filter(isVis)
    .map((s) => ({
      name: s.name, id: s.id,
      options: [...s.options].map((o) => ({ value: o.value, text: o.text })).slice(0, 10),
    }));
  return {
    body_preview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
    buttons: buttons.slice(0, 30),
    selects,
  };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: '/tmp/chase-statements-page.png', fullPage: true }).catch(() => {});
await browser.close();
