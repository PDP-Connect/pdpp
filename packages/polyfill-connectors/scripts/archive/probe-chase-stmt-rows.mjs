/**
 * Navigate to Chase Statements & Documents and dump the row structure so we
 * can wire selectors for the statements stream.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com')) || await ctx.newPage();

// Warm overview first
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));

await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index;mode=documents', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 6000));
console.log('url:', page.url());
console.log('title:', await page.title());

const info = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const els = walk(document);
  const isVis = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };

  // Find row download anchors by id pattern
  const anchors = els
    .filter((el) => el.tagName === 'A' && /accountsTable-\d+-row\d+-cell\d+-requestThisDocumentAnchor/.test(el.id || ''))
    .map((a) => ({
      id: a.id,
      aria: a.getAttribute('aria-label') || null,
      href: a.getAttribute('href') || null,
    }))
    .slice(0, 30);

  // Also find the table rows so we can walk them
  const rows = [...document.querySelectorAll('tbody tr')]
    .filter(isVis)
    .slice(0, 30)
    .map((tr, i) => ({
      rowIdx: i,
      cellText: [...tr.querySelectorAll('td, th')].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)),
    }));

  // Selectors for the account filter (we want only the current Sapphire acct's statements)
  const acctSelects = [...document.querySelectorAll('select, mds-select')].filter(isVis).map((s) => ({
    tag: s.tagName.toLowerCase(),
    id: s.id || null,
    label: s.getAttribute('label') || null,
    value: s.value || s.getAttribute?.('value') || null,
  }));

  return { anchor_count: anchors.length, anchors: anchors.slice(0, 10), rows: rows.slice(0, 10), acctSelects };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
