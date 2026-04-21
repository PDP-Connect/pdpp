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
  const els = walk(document);
  const get = (id) => {
    const el = els.find((e) => e.id === id);
    if (!el) return null;
    const raw = el.getAttribute('options') || '[]';
    try { return { id, options: JSON.parse(raw), value: el.getAttribute('value') }; } catch { return { id, raw }; }
  };
  // Click the "Activity" select to force it to populate options, if needed
  const acct = get('account-selector');
  const filetype = get('downloadFileTypeOption');
  const activity = get('downloadActivityOptionId');
  // Also check whether clicking date-range option reveals date pickers
  const dateInputs = els
    .filter((el) => /mds-date|mds-input/i.test(el.tagName))
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id, label: el.getAttribute('label'),
    }));
  return { account: acct, filetype, activity, dateInputs };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
