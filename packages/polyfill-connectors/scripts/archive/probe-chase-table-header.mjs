import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Find the activity table's container and dump the visual header/toolbar area
const info = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const table = document.getElementById('ovd-recent-activity-table-dataTableId-row-1')?.closest('table');
  if (!table) return { error: 'table not found' };
  // Walk up from table looking for section container
  let container = table;
  for (let i = 0; i < 8 && container.parentElement; i++) container = container.parentElement;
  // Within this container, find ALL interactive elements
  const inner = walk(container);
  const actions = inner
    .filter((el) => (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'MDS-BUTTON' || el.tagName === 'MDS-LINK') && (() => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    })())
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      testid: el.getAttribute?.('data-testid') || '',
      aria: (el.getAttribute?.('aria-label') || '').slice(0, 80),
      title: el.getAttribute?.('title') || '',
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    }));
  return { count: actions.length, actions: actions.slice(0, 60) };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
