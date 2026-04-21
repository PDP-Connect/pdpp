/**
 * Probe whatever Chase page is currently open. Assumes the owner has logged in
 * manually in the headed daemon window and may be on any page — dashboard,
 * card detail, statements, etc.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com'));
if (!page) { console.error('no chase page'); process.exit(1); }

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

  // Cast a wide net — anything whose text, aria-label, id, or testid hints at download/export/activity
  const candidates = els
    .filter(isVis)
    .map((el) => ({
      el,
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      testid: el.getAttribute?.('data-testid') || '',
      aria: el.getAttribute?.('aria-label') || '',
      title: el.getAttribute?.('title') || '',
      href: el.getAttribute?.('href') || '',
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    }))
    .filter((c) => {
      const s = c.id + ' ' + c.testid + ' ' + c.aria + ' ' + c.title + ' ' + c.text + ' ' + c.href;
      return /download|export|\.qfx|\.csv|\.ofx|quicken|transactions?.*(?:export|download)/i.test(s);
    })
    .slice(0, 30);

  // Also: all visible TRs / role=row / list-item-like elements — transactions often live in <tr> or aria-labelled rows
  const txnRows = els.filter((el) => {
    if (!isVis(el)) return false;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute?.('role') || '';
    if (tag !== 'tr' && tag !== 'li' && role !== 'row' && role !== 'listitem') return false;
    const t = (el.innerText || '').trim();
    return /\$[\d,]+\.\d{2}/.test(t) && t.length < 200;
  }).slice(0, 5).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    id: el.id || '',
  }));

  return {
    download_candidates: candidates.map((c) => ({ tag: c.tag, id: c.id, testid: c.testid, aria: c.aria.slice(0, 60), text: c.text, href: c.href.slice(0, 60) })),
    txn_rows: txnRows,
    body_preview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
