import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/downloadAccountTransactions/index;params=CARD,BAC,1212486749', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.locator('#downloadFileTypeOption').waitFor({ state: 'attached', timeout: 15000 });
await page.locator('#select-downloadActivityOptionId').click();
await new Promise(r => setTimeout(r, 1500));

// Find what actually represents each option: the div with "option" class? role="option"? Try many locators.
const results = {};
results.byRoleOption = await page.getByRole('option', { name: /All transactions/i }).count();
results.byRoleOption_ytd = await page.getByRole('option', { name: /Year to date/i }).count();
results.cssOptionCls = await page.locator('.option', { hasText: 'All transactions' }).count();
results.cssListItem = await page.locator('[class*="list-item"]', { hasText: 'All transactions' }).count();
results.divHasText = await page.locator('div', { hasText: 'All transactions' }).count();
console.log(JSON.stringify(results, null, 2));

// See the DOM around "All transactions" text
const context = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const el = walk(document).find((e) => (e.textContent || '').includes('All transactions') && e.children.length === 0);
  if (!el) return { error: 'not found' };
  // Walk up
  const lineage = [];
  let cur = el;
  for (let i = 0; i < 10 && cur; i++) {
    const cs = getComputedStyle(cur);
    lineage.push({
      tag: cur.tagName.toLowerCase(),
      cls: (typeof cur.className === 'string' ? cur.className : '').slice(0, 100),
      id: cur.id || null,
      role: cur.getAttribute?.('role') || null,
      cursor: cs.cursor,
      display: cs.display,
    });
    cur = cur.parentElement;
  }
  return { lineage };
});
console.log(JSON.stringify(context, null, 2));
await browser.close();
