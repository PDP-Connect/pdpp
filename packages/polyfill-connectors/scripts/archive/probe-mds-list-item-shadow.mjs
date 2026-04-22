import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com'));
console.log('url:', page.url());

// Navigate back to method chooser if needed
if (!page.url().includes('confirmIdentity') || page.url().includes('verifyOTP')) {
  console.log('not on method chooser; this probe expects the chooser page');
}

// Find mds-list-item#sms, dump its shadow root structure
const dump = await page.evaluate(() => {
  function find(root) {
    let x = null;
    root.querySelectorAll('*').forEach((el) => {
      if (!x && el.tagName.toLowerCase() === 'mds-list-item' && el.id === 'sms') x = el;
      if (!x && el.shadowRoot) x = find(el.shadowRoot);
    });
    return x;
  }
  const host = find(document);
  if (!host) return { error: 'not_found' };
  const box = host.getBoundingClientRect();
  const result = {
    host: { tag: host.tagName, id: host.id, box: { w: box.width, h: box.height, x: box.x, y: box.y } },
    shadow_children: [],
  };
  if (host.shadowRoot) {
    host.shadowRoot.querySelectorAll('*').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || el.tagName === 'STYLE') return;
      result.shadow_children.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 60) : '',
        role: el.getAttribute('role') || null,
        cursor: getComputedStyle(el).cursor,
        tabindex: el.getAttribute('tabindex'),
        box: { w: b.width, h: b.height, x: b.x, y: b.y },
      });
    });
  }
  return result;
});
console.log(JSON.stringify(dump, null, 2));
await browser.close();
