import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Click the Activity dropdown to force it to populate & reveal options
// mds-select's trigger is usually a button inside its shadow root. Use locator.click.
await page.locator('mds-select#downloadActivityOptionId').click({ timeout: 10000 });
await new Promise((r) => setTimeout(r, 2000));

const info = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  // Options are typically rendered as mds-list-item with id or label after expansion
  const activityOptions = els
    .filter((el) => el.tagName.toLowerCase() === 'mds-list-item' || el.tagName.toLowerCase() === 'option')
    .slice(0, 30)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      label: el.getAttribute('label') || (el.textContent || '').trim().slice(0, 80),
    }));
  const sel = els.find((e) => e.id === 'downloadActivityOptionId');
  const attrs = {};
  if (sel) for (const a of sel.attributes) attrs[a.name] = a.value.slice(0, 100);
  return { activityOptions, selectAttrs: attrs };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
