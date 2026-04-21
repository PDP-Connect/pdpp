import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com'));

// Use Playwright's pierceShadow text locator
const items = await page.locator('mds-list-item').all();
console.log('mds-list-item count:', items.length);
for (let i = 0; i < items.length; i++) {
  const text = await items[i].innerText().catch(() => '');
  console.log(`  [${i}] text=${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 120))}`);
}

const buttons = await page.locator('mds-button').all();
console.log('mds-button count:', buttons.length);
for (let i = 0; i < buttons.length; i++) {
  const text = await buttons[i].innerText().catch(() => '');
  console.log(`  [${i}] text=${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 80))}`);
}

await browser.close();
