/**
 * Click the accordion and/or scroll for more statements.
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

// Try clicking the accordion
await page.locator('#button-documentsAccordion-0').click().catch(() => {});
await new Promise((r) => setTimeout(r, 3000));

let anchorCount = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  return walk(document).filter((a) => a.tagName === 'A' && /accountsTable-\d+-row\d+-cell\d+-requestThisDocumentAnchor-download/.test(a.id || '')).length;
});
console.log('anchors after accordion click:', anchorCount);

// Look for any "View more", "Show more", "Older statements" buttons
const more = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const els = walk(document);
  const isVis = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };
  return els
    .filter((el) => isVis(el) && (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'MDS-BUTTON'))
    .filter((el) => /view more|show more|older|load more|previous year|earlier|all statements|show all|view all/i.test((el.innerText || '').trim()))
    .slice(0, 5)
    .map((el) => ({ tag: el.tagName.toLowerCase(), id: el.id || null, text: (el.innerText || '').trim().slice(0, 60) }));
});
console.log('more:', JSON.stringify(more));

// Also check year selectors or anything like "Time period"
const timeFilters = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const els = walk(document);
  const isVis = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };
  return els
    .filter(isVis)
    .filter((el) => (el.tagName === 'MDS-SELECT' || el.tagName === 'SELECT' || el.tagName === 'MDS-DATEPICKER' || (el.tagName === 'INPUT' && (el.name || '').match(/date|year|time/i))))
    .map((el) => ({ tag: el.tagName.toLowerCase(), id: el.id || null, label: el.getAttribute?.('label') || null, value: el.getAttribute?.('value') || el.value || null }));
});
console.log('time filters:', JSON.stringify(timeFilters));

// Take full-page screenshot for inspection
await page.screenshot({ path: '/tmp/chase-stmt-page.png', fullPage: true }).catch(() => {});
await browser.close();
