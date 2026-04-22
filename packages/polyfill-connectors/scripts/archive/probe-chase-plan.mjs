import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

await page.getByTestId('menu-item-link:requestPlanTrack').click().catch(() => {});
await new Promise((r) => setTimeout(r, 5000));
console.log('url:', page.url());
console.log('body:', (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500));

// Also look for any "Download" or "Export" anywhere in the whole DOM
const all = await page.evaluate(() => {
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
  return els
    .filter(isVis)
    .map((el) => ({ text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) }))
    .filter((x) => /download|\.qfx|\.csv|\.ofx|export|quicken/i.test(x.text) && x.text.length < 80)
    .slice(0, 15);
});
console.log('download matches:', JSON.stringify(all, null, 2));
await browser.close();
