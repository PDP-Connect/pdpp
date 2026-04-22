import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Click top nav "Accounts" to see dropdown
const navContent = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  // Primary nav items
  const navItems = els.filter((el) => {
    const td = el.getAttribute?.('data-testid') || '';
    return /menu-item-(link|dropdown-button):/i.test(td);
  }).map((el) => ({
    testid: el.getAttribute('data-testid'),
    text: (el.innerText || '').slice(0, 40),
    href: el.getAttribute?.('href') || null,
  }));
  return navItems;
});
console.log('nav items:', JSON.stringify(navContent, null, 2));

// Look for Statements/Documents links in the entire page
const statementPaths = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const anchors = els.filter((el) => {
    if (el.tagName !== 'A' && el.tagName !== 'BUTTON') return false;
    const t = (el.innerText || el.textContent || '').trim();
    const td = el.getAttribute?.('data-testid') || '';
    return /statements|documents|account services|download|transactions export/i.test(t + ' ' + td) && t.length < 100;
  }).slice(0, 20).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || '').slice(0, 60),
    href: el.getAttribute?.('href') || null,
    testid: el.getAttribute?.('data-testid') || null,
  }));
  return anchors;
});
console.log('statements/documents paths:', JSON.stringify(statementPaths, null, 2));
await browser.close();
