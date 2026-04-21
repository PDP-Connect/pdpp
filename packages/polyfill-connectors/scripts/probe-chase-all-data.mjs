import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('chase.com'));
if (!page) page = await ctx.newPage();

// Navigate back to the Sapphire card detail page
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/details/creditCard;params=CARD,BAC,1212486749,CARD-BAC-001', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 8000));
console.log('url:', page.url());

// Full page text with ALL visible content (including scroll-hidden)
const full = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  // All a[href*="transactionDetails"] anywhere, visible or not
  const txnAnchors = els.filter((a) => a.tagName === 'A' && /transactionDetails/i.test(a.getAttribute('href') || ''));
  // All MDS custom elements
  const mdsTags = [...new Set(els.filter((e) => e.tagName.includes('-')).map((e) => e.tagName.toLowerCase()))];
  // All testids
  const testids = [...new Set(els.filter((e) => e.getAttribute?.('data-testid')).map((e) => e.getAttribute('data-testid')))];
  // Full body text (including hidden)
  const allText = [];
  els.forEach((el) => {
    if (el.children?.length === 0) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 200 && /\$[\d,]+\.\d{2}|[A-Z][a-z]{2}\s+\d{1,2}/.test(t)) allText.push(t.slice(0, 100));
    }
  });
  return {
    txnAnchor_count: txnAnchors.length,
    txnAnchor_samples: txnAnchors.slice(0, 5).map((a) => ({ href: a.getAttribute('href'), aria: a.getAttribute('aria-label') })),
    mdsTags: mdsTags.slice(0, 25),
    testids: testids.filter((t) => /trans|activ|detail|download|export/i.test(t)).slice(0, 20),
    dollarish_texts: [...new Set(allText)].slice(0, 20),
  };
});
console.log(JSON.stringify(full, null, 2));
await browser.close();
