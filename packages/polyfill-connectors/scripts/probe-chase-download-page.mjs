import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));
console.log('url:', page.url());
console.log('title:', await page.title());
const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1200);
console.log('body:', body);

// Selects + radios + inputs + buttons
const info = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const isVis = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };
  return {
    selects: [...document.querySelectorAll('select')].filter(isVis).map((s) => ({
      name: s.name, id: s.id,
      options: [...s.options].map((o) => ({ value: o.value, text: o.text })),
    })),
    radios: els.filter((el) => el.tagName === 'INPUT' && el.type === 'radio').map((r) => ({
      name: r.name, value: r.value, id: r.id,
      label: (el => {
        const lab = document.querySelector(`label[for="${el.id}"]`);
        return lab ? lab.innerText.trim() : null;
      })(r),
    })),
    inputs: [...document.querySelectorAll('input')].filter(isVis).map((i) => ({
      name: i.name, id: i.id, type: i.type, placeholder: i.placeholder, value: i.value?.slice(0, 40),
    })),
    mdsInputs: els.filter((el) => isVis(el) && /mds-(date|input|select|radio|dropdown)/i.test(el.tagName)).map((el) => ({
      tag: el.tagName.toLowerCase(), id: el.id || null, label: el.getAttribute?.('label') || null,
    })),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
