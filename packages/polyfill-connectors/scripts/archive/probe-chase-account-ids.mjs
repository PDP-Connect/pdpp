import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Current page is after the expand. Find ALL account-name buttons.
const accts = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  // Pattern: <span class="accessible-text" id="accounts-name-link-button-<ID>-label">Name (...1234)</span>
  const labels = els.filter((el) =>
    el.id && /^accounts-name-link-button-\d+-label$/.test(el.id)
  ).map((el) => {
    // Pull the internal id out
    const m = el.id.match(/^accounts-name-link-button-(\d+)-label$/);
    return {
      id: m[1],
      display_name: (el.innerText || el.textContent || '').trim(),
    };
  });
  return labels;
});
console.log('accounts found:', JSON.stringify(accts, null, 2));
await browser.close();
