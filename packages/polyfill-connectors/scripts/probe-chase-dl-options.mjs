import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Click the File Type select to reveal options
const info = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const sel1 = els.find((e) => e.tagName.toLowerCase() === 'mds-select' && e.id === 'downloadFileTypeOption');
  const sel2 = els.find((e) => e.tagName.toLowerCase() === 'mds-select' && e.id === 'downloadActivityOptionId');
  const acct = els.find((e) => e.tagName.toLowerCase() === 'mds-select' && e.id === 'account-selector');

  const opts = (host) => {
    if (!host) return { error: 'no_host' };
    // mds-select usually contains mds-option children in light DOM
    const options = [...host.querySelectorAll('mds-option, option, mds-list-item')].map((o) => ({
      tag: o.tagName.toLowerCase(),
      value: o.getAttribute('value') || o.value || null,
      id: o.id || null,
      label: o.getAttribute('label') || (o.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    }));
    const attrs = {};
    for (const a of host.attributes) attrs[a.name] = a.value.slice(0, 80);
    return { tag: host.tagName.toLowerCase(), id: host.id, attrs, options };
  };

  return {
    file_type: opts(sel1),
    activity: opts(sel2),
    account: opts(acct),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
