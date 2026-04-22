import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com'));

const loc = page.getByText('Get a text', { exact: false });
console.log('getByText "Get a text" count:', await loc.count());
const first = loc.first();
const box = await first.boundingBox().catch(() => null);
console.log('first box:', JSON.stringify(box));
console.log('visible?', await first.isVisible().catch((e) => 'err: ' + e.message));

// Also try Playwright's text= engine which pierces shadow
const loc2 = page.locator('text="Get a text"').first();
console.log('text="Get a text" count:', await page.locator('text="Get a text"').count());
console.log('box:', JSON.stringify(await loc2.boundingBox().catch(() => null)));
await browser.close();
