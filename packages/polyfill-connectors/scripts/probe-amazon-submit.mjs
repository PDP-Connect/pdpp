import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('amazon.com'));
console.log('url:', page.url());

const info = await page.evaluate(() => {
  const isVis = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };
  const submits = [...document.querySelectorAll('input[type="submit"], button[type="submit"], button')]
    .filter(isVis)
    .map((el) => ({
      tag: el.tagName,
      id: el.id,
      name: el.name,
      type: el.type,
      text: (el.innerText || el.value || '').slice(0, 40),
      aria: el.getAttribute('aria-labelledby') || el.getAttribute('aria-label') || '',
      cls: (el.className || '').toString().slice(0, 80),
    }));
  return {
    submits,
    email_value_length: document.querySelector('#ap_email_login')?.value?.length || 0,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
