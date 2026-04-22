import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

await page.locator('#select-downloadActivityOptionId').click({ timeout: 10000 });
await new Promise((r) => setTimeout(r, 2000));

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
    .filter(isVis)
    .filter((el) => {
      const tag = el.tagName.toLowerCase();
      return tag === 'mds-list-item' || tag === 'li' || (tag === 'option') || (el.getAttribute?.('role') === 'option');
    })
    .slice(0, 20)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      value: el.getAttribute('value') || el.getAttribute('data-value') || null,
      label: el.getAttribute('label') || (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    }));
});
console.log(JSON.stringify(items, null, 2));
await browser.close();
