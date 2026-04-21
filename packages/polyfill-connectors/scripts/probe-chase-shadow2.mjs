import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com'));

const info = await page.evaluate(() => {
  // Walk light + shadow DOM; return a flattened inventory of clickable things.
  function collectAll(root, acc = []) {
    root.querySelectorAll('*').forEach((el) => {
      acc.push(el);
      if (el.shadowRoot) collectAll(el.shadowRoot, acc);
    });
    return acc;
  }
  const allEls = collectAll(document.documentElement || document);

  // Find all mds-* elements with their rendered text (via shadow or slot)
  const mdsItems = [];
  for (const el of allEls) {
    const tag = el.tagName.toLowerCase();
    if (!tag.startsWith('mds-')) continue;
    // Get text from shadow tree if any
    let text = '';
    try {
      if (el.shadowRoot) text = (el.shadowRoot.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    } catch {}
    // Also collect attributes useful for selection
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value.slice(0, 80);
    const rect = el.getBoundingClientRect();
    mdsItems.push({
      tag, text: text.slice(0, 160), attrs, visible: rect.width > 0 && rect.height > 0,
    });
  }
  return { mdsItems };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
