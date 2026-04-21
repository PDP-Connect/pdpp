import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// The mds-select host has 0 size; we need to click the trigger button inside its shadow
// root. Let's click at the coordinate of its label instead.
await page.locator('text="Activity"').first().click({ timeout: 5000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

// Enumerate visible list-item-like things
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
  // Look for any visible element that mentions "date range" / "year to date" / "all" / statement period
  const matches = els
    .filter(isVis)
    .filter((el) => {
      const t = (el.innerText || el.textContent || '').trim();
      return /date range|year to date|since last|statement|all transactions|all activity|current display/i.test(t) && t.length < 120;
    })
    .slice(0, 20)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    }));
  return matches;
});
console.log(JSON.stringify(items, null, 2));
await browser.close();
