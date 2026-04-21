import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('chase.com'));
if (!page) page = await ctx.newPage();

await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/details/creditCard;params=CARD,BAC,1212486749,CARD-BAC-001', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 8000));

// Check current URL — if session expired, we'll be on signin
console.log('url:', page.url());
if (/signin|logon/i.test(page.url())) {
  console.log('SESSION EXPIRED — need to re-auth');
  await browser.close();
  process.exit(2);
}

await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await new Promise((r) => setTimeout(r, 3000));

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
  const tables = els.filter((el) => el.tagName === 'TABLE' && isVis(el)).map((t) => ({
    id: t.id || null,
    cls: (typeof t.className === 'string' ? t.className : '').slice(0, 100),
    rows: t.querySelectorAll('tr').length,
  }));
  const roleTables = els.filter((el) => isVis(el) && /^(table|grid|list)$/i.test(el.getAttribute?.('role') || '')).map((t) => ({
    tag: t.tagName.toLowerCase(),
    role: t.getAttribute('role'),
    id: t.id || null,
    rows: t.querySelectorAll('[role="row"], [role="listitem"], tr, li').length,
  }));
  const txnish = els.filter((el) => {
    if (!isVis(el)) return false;
    if (el.children && el.children.length > 5) return false;
    const t = (el.innerText || '').trim();
    return /[A-Z][a-z]{2} \d{1,2}|\d{2}\/\d{2}/.test(t) && /\$[\d,]+\.\d{2}/.test(t) && t.length < 200;
  }).slice(0, 10).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 150),
  }));
  const pending = els.filter((el) => isVis(el) && /pending/i.test((el.innerText || '').slice(0, 30)) && (el.innerText || '').length < 100).slice(0, 8).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || '').slice(0, 80),
  }));
  return { tables, roleTables, txnish, pending };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
