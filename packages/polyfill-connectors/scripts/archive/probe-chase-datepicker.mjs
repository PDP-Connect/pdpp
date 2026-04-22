import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com'));

const info = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const els = walk(document);
  const pickers = els.filter((el) => el.tagName.toLowerCase() === 'mds-datepicker');
  const inputs = els.filter((el) => el.tagName.toLowerCase() === 'mds-text-input' || el.tagName === 'INPUT');
  return {
    pickers: pickers.map((p) => {
      const attrs = {};
      for (const a of p.attributes) attrs[a.name] = a.value.slice(0, 60);
      return { id: p.id, attrs };
    }),
    inputs: inputs.map((i) => ({
      tag: i.tagName.toLowerCase(),
      id: i.id || null,
      name: i.name || null,
      type: i.type || null,
      label: i.getAttribute?.('label') || null,
      placeholder: i.getAttribute?.('placeholder') || i.placeholder || null,
      value: i.value?.toString() || i.getAttribute?.('value') || null,
    })).slice(0, 15),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
