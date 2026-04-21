/**
 * Select "Choose a date range" in the Activity dropdown, then dump the
 * revealed date-picker UI so we can wire selectors.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com')) || await ctx.newPage();

// Warm the SPA with overview first — direct-nav to the download URL often
// bounces to logon if the route isn't preceded by a dashboard hit.
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));

await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/downloadAccountTransactions/index;params=CARD,BAC,1212486749', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.locator('#downloadFileTypeOption').waitFor({ state: 'attached', timeout: 15000 });

// Set QFX
await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const sel = walk(document).find((e) => e.id === 'downloadFileTypeOption');
  if (sel) { sel.setAttribute('value', 'QFX'); sel.setAttribute('selected-index', '1'); sel.dispatchEvent(new Event('change', { bubbles: true, composed: true })); }
});
await page.locator('#downloadFileTypeOption[value="QFX"]').waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});

// Open Activity dropdown + select "Choose a date range"
await page.locator('#select-downloadActivityOptionId').click();
await page.getByRole('option', { name: /^Choose a date range$/i }).click({ timeout: 10000 });
await new Promise((r) => setTimeout(r, 2500));

// Dump every visible input + mds-* date-related element
const dump = await page.evaluate(() => {
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

  const inputs = els.filter((el) => isVis(el) && (el.tagName === 'INPUT' || /mds-date|mds-input/i.test(el.tagName)))
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      name: el.name || null,
      type: el.type || null,
      placeholder: el.placeholder || null,
      ariaLabel: el.getAttribute?.('aria-label') || null,
      label: el.getAttribute?.('label') || null,
      value: (el.value?.toString() || el.getAttribute?.('value') || '').slice(0, 40),
    }));

  // Any new custom elements that appeared
  const customTags = [...new Set(els.filter((e) => e.tagName.includes('-')).map((e) => e.tagName.toLowerCase()))];

  // Labels for visible things
  const labels = [...document.querySelectorAll('label')].filter(isVis).map((l) => ({
    text: (l.innerText || '').trim().slice(0, 60),
    htmlFor: l.getAttribute('for') || null,
  }));

  return {
    inputs,
    customTags: customTags.filter((t) => /date|range|picker|calendar/i.test(t)),
    labels,
    bodyPreview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
  };
});
console.log(JSON.stringify(dump, null, 2));
await page.screenshot({ path: '/tmp/chase-daterange-dom.png', fullPage: true }).catch(() => {});
await browser.close();
