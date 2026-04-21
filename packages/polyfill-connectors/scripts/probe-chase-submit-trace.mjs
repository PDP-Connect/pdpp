/**
 * Trace the Chase login step-by-step with screenshots at each stage to
 * understand what's happening between submit and the "site isn't working"
 * error page.
 */
import { chromium } from 'patchright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '/home/user/code/pdpp/.env.the owner.local' });

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

await page.goto('https://www.chase.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));
await page.mouse.move(500, 400);
await new Promise((r) => setTimeout(r, 1500));

await page.goto('https://secure.chase.com/web/auth/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000));
await page.screenshot({ path: '/tmp/chase-1-form.png', fullPage: true }).catch(() => {});

const userField = page.locator('input#userId-input-field-input, input[name="username"], input#userId-text-input-field').first();
await userField.waitFor({ state: 'visible', timeout: 15000 });
await userField.fill(process.env.CHASE_USERNAME);
const passField = page.locator('input#password-input-field-input, input#password-text-input-field, input[type="password"]').first();
await passField.fill(process.env.CHASE_PASSWORD);
await page.screenshot({ path: '/tmp/chase-2-filled.png', fullPage: true }).catch(() => {});

// Trace which form state we actually have at submit time
const preState = await page.evaluate(() => ({
  username_value: document.querySelector('#userId-input-field-input, #userId-text-input-field, input[name="username"]')?.value?.slice(0, 20),
  password_length: document.querySelector('#password-input-field-input, #password-text-input-field, input[type="password"]')?.value?.length,
  signin_disabled: document.querySelector('#signin-button')?.disabled,
}));
console.log('pre-submit:', JSON.stringify(preState));

await page.locator('button#signin-button').click({ timeout: 5000 });
await new Promise((r) => setTimeout(r, 2000));
console.log('1s after click:', page.url());
await page.screenshot({ path: '/tmp/chase-3-submit1s.png', fullPage: true }).catch(() => {});

await new Promise((r) => setTimeout(r, 6000));
console.log('8s after click:', page.url());
const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
console.log('body:', bodyText);
await page.screenshot({ path: '/tmp/chase-4-submit8s.png', fullPage: true }).catch(() => {});

await browser.close();
