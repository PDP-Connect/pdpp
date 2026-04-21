import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('chase.com'));
if (!page) page = await ctx.newPage();
await page.goto('https://secure.chase.com/web/auth/', { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log('url:', page.url());
console.log('title:', await page.title());
const preview = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
console.log('body:', preview);
// Bring to front for the owner to see
await page.bringToFront();
// Disconnect CDP without closing
await browser.close();
