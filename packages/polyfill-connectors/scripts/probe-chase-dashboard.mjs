/**
 * Probe Chase dashboard for account-card structure. The connector's
 * discoverAccounts() walks DOM + shadow roots looking for
 * <a href*="accountDetails|accountSummary|activity"> links; this script
 * reports what's actually there so we can wire selectors.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('chase.com'));
if (!page) { console.error('no chase page'); process.exit(1); }

await page.goto('https://secure.chase.com/web/auth/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000));
console.log('url:', page.url());
console.log('title:', await page.title());
await page.screenshot({ path: '/tmp/chase-dashboard.png', fullPage: true }).catch(() => {});
console.log('screenshot: /tmp/chase-dashboard.png');

const info = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => {
      out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot, out);
    });
    return out;
  }
  const els = walk(document);

  // All links in light + shadow DOM
  const links = els.filter((el) => el.tagName === 'A' && el.getAttribute('href'));
  const byHref = {};
  for (const a of links) {
    const href = a.getAttribute('href') || '';
    const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const aria = a.getAttribute('aria-label') || '';
    if (!text && !aria) continue;
    byHref[href] = (byHref[href] || []);
    if (byHref[href].length < 2) byHref[href].push({ text, aria: aria.slice(0, 80) });
  }

  // Find anything mentioning "Details", "Summary", "Activity", or digit runs (last-four)
  const accountish = links.filter((a) => {
    const s = (a.innerText || '') + ' ' + (a.getAttribute('href') || '') + ' ' + (a.getAttribute('aria-label') || '');
    return /details|summary|activity|balance|ending in|\*\d{3,4}|\(\.\.\.\d{3,4}\)/i.test(s);
  }).slice(0, 20).map((a) => ({
    href: a.getAttribute('href'),
    aria: a.getAttribute('aria-label') || '',
    text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180),
  }));

  // Custom-element inventory (different from signin page)
  const customTags = [...new Set(els.filter((e) => e.tagName.includes('-')).map((e) => e.tagName.toLowerCase()))];

  return {
    links_total: links.length,
    unique_hrefs: Object.keys(byHref).length,
    accountish_links: accountish,
    custom_elements: customTags.slice(0, 30),
    body_preview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
