import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// We should already be on the account page
console.log('url:', page.url());
// Scroll down to see all menu items & look for download affordances
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await new Promise((r) => setTimeout(r, 3000));

// Look for any element whose text contains "Download" (case insensitive), including in menus / overlay dialogs
const downloadResults = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const matches = els.filter((el) => {
    const text = (el.innerText || el.textContent || '').trim();
    const aria = el.getAttribute?.('aria-label') || '';
    return (
      (/^Download/i.test(text) && text.length < 40) ||
      /^Download/i.test(aria) ||
      /download.*(activity|transactions|qfx|csv|ofx)/i.test(text + ' ' + aria)
    );
  }).slice(0, 10).map((el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    testid: el.getAttribute?.('data-testid') || null,
    href: el.getAttribute?.('href') || null,
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    aria: (el.getAttribute?.('aria-label') || '').slice(0, 100),
  }));
  return matches;
});
console.log('download matches:', JSON.stringify(downloadResults, null, 2));

// Also check the secondary menu list items
const menuItems = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const menu = document.getElementById('secondary-menu');
  if (!menu) return { error: 'no secondary-menu' };
  const items = [...menu.querySelectorAll('li, a, button')].map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || '').slice(0, 60),
    href: el.getAttribute('href') || null,
  }));
  return items;
});
console.log('\nsecondary-menu items:', JSON.stringify(menuItems, null, 2));
await browser.close();
