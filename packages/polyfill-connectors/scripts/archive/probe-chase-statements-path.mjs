import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Look for "Statements" or "Documents" link anywhere on the page
const links = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const matches = els.filter((el) => {
    const s = (el.innerText || el.textContent || '').trim();
    return /(Statements|Documents|See all activity|View activity|All activity|Activity|history)/i.test(s) && s.length < 80;
  }).slice(0, 30).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || '').trim().slice(0, 60),
    href: el.getAttribute?.('href') || null,
    role: el.getAttribute?.('role') || null,
    testid: el.getAttribute?.('data-testid') || null,
  }));
  // Dedupe by text
  const seen = new Set();
  return matches.filter((m) => {
    const key = m.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});
console.log('statement/activity links:', JSON.stringify(links, null, 2));
await browser.close();
