/**
 * Probe the current Amazon signin page DOM — no interaction, just report.
 * Drops a screenshot and JSON of the visible inputs / buttons.
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

// Find or open the Amazon signin tab.
let page = null;
for (const p of context.pages()) {
  if (p.url().includes('amazon.com')) { page = p; break; }
}
if (!page) {
  page = await context.newPage();
  await page.goto('https://www.amazon.com/gp/sign-in.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
}

console.log('url:', page.url());
console.log('title:', await page.title());
const shotPath = '/tmp/amazon-signin-probe.png';
await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
console.log('screenshot:', shotPath);

const diag = await page.evaluate(() => {
  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && box.width > 0 && box.height > 0;
  };
  const inputs = [...document.querySelectorAll('input')].map((i) => ({
    name: i.name || null,
    id: i.id || null,
    type: i.type,
    placeholder: i.placeholder || null,
    value: (i.value || '').slice(0, 20),
    visible: isVisible(i),
  }));
  const buttons = [...document.querySelectorAll('button, input[type="submit"]')].map((b) => ({
    text: (b.innerText || b.value || '').slice(0, 40),
    id: b.id || null,
    type: b.type || null,
    visible: isVisible(b),
  }));
  const forms = [...document.querySelectorAll('form')].map((f) => ({
    name: f.name || null, id: f.id || null, action: f.action || null,
  }));
  return {
    url: location.href,
    body_preview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    forms, inputs, buttons,
  };
});
console.log(JSON.stringify(diag, null, 2));

await browser.close();
