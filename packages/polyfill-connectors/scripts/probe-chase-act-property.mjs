import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

const info = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const sel = walk(document).find((e) => e.id === 'downloadActivityOptionId');
  if (!sel) return { error: 'no sel' };
  return {
    prop_options: sel.options,
    prop_value: sel.value,
    prop_keys: Object.keys(sel).slice(0, 40),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
