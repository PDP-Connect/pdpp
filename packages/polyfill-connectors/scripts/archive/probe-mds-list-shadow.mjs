import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com'));

const dump = await page.evaluate(() => {
  function findAll(root, tag, acc = []) {
    root.querySelectorAll('*').forEach((el) => {
      if (el.tagName.toLowerCase() === tag) acc.push(el);
      if (el.shadowRoot) findAll(el.shadowRoot, tag, acc);
    });
    return acc;
  }
  const lists = findAll(document, 'mds-list');
  const result = [];
  for (const list of lists) {
    const listInfo = {
      host_id: list.id,
      host_selected: list.getAttribute('selected-index'),
      shadow_rendered: [],
    };
    if (list.shadowRoot) {
      // Everything visible inside the list's shadow root
      list.shadowRoot.querySelectorAll('*').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width < 10 || b.height < 10 || el.tagName === 'STYLE') return;
        listInfo.shadow_rendered.push({
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string') ? el.className.slice(0, 60) : '',
          id: el.id || null,
          role: el.getAttribute('role') || null,
          cursor: getComputedStyle(el).cursor,
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          box: { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) },
        });
      });
    }
    result.push(listInfo);
  }
  return result;
});
console.log(JSON.stringify(dump, null, 2));
await browser.close();
