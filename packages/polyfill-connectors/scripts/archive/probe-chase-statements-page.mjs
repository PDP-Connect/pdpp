import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

await page.getByTestId('requestAccountStatements').click();
await new Promise((r) => setTimeout(r, 5000));
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
  // Collect visible buttons/links with relevant keywords
  const actions = els
    .filter((el) => (el.tagName === 'A' || el.tagName === 'BUTTON' || el.tagName === 'MDS-BUTTON') && isVis(el))
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      href: el.getAttribute?.('href') || null,
      testid: el.getAttribute?.('data-testid') || null,
      id: el.id || null,
    }))
    .filter((x) => x.text && /download|export|statement|activity|quicken|qfx|csv|ofx/i.test(x.text + ' ' + (x.testid || '')));
  
  return {
    body_preview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
    actions: actions.slice(0, 30),
  };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: '/tmp/chase-statements-page.png', fullPage: true }).catch(() => {});
await browser.close();
