/**
 * Probe the Statements & Documents page for year/date filters so we can
 * retrieve all historical statements, not just the 4 most recent.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com')) || await ctx.newPage();

await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index;mode=documents', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 6000));

// Dump all visible buttons, links, selects — looking for "View more", "Previous year", year dropdown
const info = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const els = walk(document);
  const isVis = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };
  const actions = els
    .filter((el) => isVis(el) && (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'MDS-BUTTON' || el.tagName === 'MDS-SELECT' || el.tagName === 'SELECT'))
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      aria: (el.getAttribute?.('aria-label') || '').slice(0, 80),
      value: el.getAttribute?.('value') || null,
      label: el.getAttribute?.('label') || null,
    }))
    .filter((a) => a.text || a.aria || a.label);
  return { actions: actions.slice(0, 60) };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
