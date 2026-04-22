import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Click into the account
await page.getByRole('button', { name: /Sapphire Preferred/i }).first().click();
await new Promise((r) => setTimeout(r, 5000));
console.log('after click url:', page.url());

// Look for "Download", "Export", or "Account activity" links
const downloadish = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const matches = els.filter((el) => {
    const s = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute?.('aria-label') || '') + ' ' + (el.getAttribute?.('href') || '')).slice(0, 200);
    return /download|\.qfx|\.csv|\.ofx|export|activity|transactions/i.test(s);
  }).slice(0, 20).map((el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    testid: el.getAttribute?.('data-testid') || null,
    href: el.getAttribute?.('href') || null,
    text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
  }));
  return matches;
});
console.log('downloadish:', JSON.stringify(downloadish, null, 2));
await page.screenshot({ path: '/tmp/chase-account.png', fullPage: true }).catch(() => {});
await browser.close();
