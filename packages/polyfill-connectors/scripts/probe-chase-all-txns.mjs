import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

await page.getByRole('link', { name: /See all transactions/i }).first().click({ timeout: 10000 });
await new Promise((r) => setTimeout(r, 6000));
console.log('url:', page.url());
console.log('title:', await page.title());

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

  // Cast wide net for download/export
  const candidates = els
    .filter(isVis)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      testid: el.getAttribute?.('data-testid') || '',
      aria: (el.getAttribute?.('aria-label') || '').slice(0, 100),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    }))
    .filter((c) => {
      const s = c.id + ' ' + c.testid + ' ' + c.aria + ' ' + c.text;
      return /download|export|\.qfx|\.csv|\.ofx|quicken/i.test(s);
    });

  // Also — any icon-only buttons (empty text but has aria-label)
  const iconButtons = els
    .filter((el) => isVis(el) && (el.tagName === 'BUTTON' || el.tagName === 'MDS-BUTTON' || el.tagName === 'MDS-ICON') && (el.getAttribute?.('aria-label') || '').length > 0)
    .slice(0, 20)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      aria: (el.getAttribute('aria-label') || '').slice(0, 80),
    }));

  return { candidates: candidates.slice(0, 20), iconButtons };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
