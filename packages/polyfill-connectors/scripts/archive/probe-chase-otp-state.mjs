import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com'));
console.log('url:', page.url());
console.log('body:', ((await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500)));

// Reach into the shadow DOM and find the inner <input> under #otpInput
const inner = await page.evaluate(() => {
  function find(root) {
    let x = null;
    root.querySelectorAll('*').forEach((el) => {
      if (!x && el.id === 'otpInput') x = el;
      if (!x && el.shadowRoot) x = find(el.shadowRoot);
    });
    return x;
  }
  const host = find(document);
  if (!host) return { error: 'host_not_found' };
  const innerInput = host.shadowRoot?.querySelector('input');
  if (!innerInput) return { error: 'inner_input_not_in_shadow', hostOuterHtml: host.outerHTML.slice(0, 300) };
  const box = innerInput.getBoundingClientRect();
  return {
    host_id: host.id, host_tag: host.tagName,
    inner_type: innerInput.type,
    inner_value: innerInput.value,
    inner_box: { x: box.x + box.width/2, y: box.y + box.height/2 },
    inner_disabled: innerInput.disabled,
    error_text: (document.body.innerText.match(/invalid|expired|incorrect|error|try again|doesn't match|does not match/i) || [])[0] || null,
  };
});
console.log(JSON.stringify(inner, null, 2));

await browser.close();
