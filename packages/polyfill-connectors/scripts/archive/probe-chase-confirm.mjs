/**
 * Probe the Chase "Confirm Your Identity" method-chooser page.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const discovery = JSON.parse(
  readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8')
);
const browser = await chromium.connectOverCDP(discovery.wsEndpoint);
const context = browser.contexts()[0];

const page = context.pages().find((p) => p.url().includes('chase.com'));
if (!page) {
  console.error('no chase page open');
  process.exit(1);
}

console.log('url:', page.url());
await page.screenshot({ path: '/tmp/chase-confirm-probe.png', fullPage: true }).catch(() => {});

const diag = await page.evaluate(() => {
  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && box.width > 0 && box.height > 0;
  };
  // Collect every "chooser-likely" element and its nested text.
  const chooserSel = 'button, [role="button"], label, li, [role="radio"], [role="option"], input[type="radio"], a[href], div[tabindex]';
  const els = [...document.querySelectorAll(chooserSel)].filter(isVisible);
  return {
    url: location.href,
    body_preview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
    candidates: els.slice(0, 40).map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || null,
      id: el.id || null,
      testid: el.getAttribute('data-testid') || null,
      cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : '',
      text: (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    })),
  };
});

console.log(JSON.stringify(diag, null, 2));
await browser.close();
