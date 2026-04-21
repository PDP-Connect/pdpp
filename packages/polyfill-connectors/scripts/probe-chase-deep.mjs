import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com'));
if (!page) { console.error('no chase page'); process.exit(1); }

const info = await page.evaluate(() => {
  const counts = {
    iframes: document.querySelectorAll('iframe').length,
    shadow_hosts: [...document.querySelectorAll('*')].filter((e) => e.shadowRoot).length,
    all_buttons: document.querySelectorAll('button').length,
    inputs: document.querySelectorAll('input').length,
    custom_els: [...document.querySelectorAll('*')].filter((e) => e.tagName.includes('-')).length,
  };
  const customElNames = [...new Set([...document.querySelectorAll('*')]
    .filter((e) => e.tagName.includes('-'))
    .map((e) => e.tagName.toLowerCase()))];
  const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
    src: f.src, name: f.name, id: f.id,
  }));
  return { counts, customElNames: customElNames.slice(0, 40), iframes };
});
console.log(JSON.stringify(info, null, 2));

// Also check inside any frames
for (const frame of page.frames()) {
  console.log('frame url:', frame.url());
}

await browser.close();
