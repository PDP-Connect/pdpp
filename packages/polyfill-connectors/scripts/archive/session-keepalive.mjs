/**
 * Keep Chase + Amazon sessions alive by pinging an authenticated page on
 * each every few minutes. Intended to run in the background while the
 * connectors are being developed so we don't burn the human's 2FA attention
 * on session expiry.
 *
 * Usage: nohup node scripts/session-keepalive.mjs > /tmp/pdpp-keepalive.log 2>&1 &
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const INTERVAL_MS = 8 * 60 * 1000;

function disco() {
  return JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
}

async function pingChase() {
  const browser = await chromium.connectOverCDP(disco().wsEndpoint);
  try {
    const ctx = browser.contexts()[0];
    let page = ctx.pages().find((p) => p.url().includes('chase.com'));
    if (!page) page = await ctx.newPage();
    await page.goto('https://secure.chase.com/web/auth/dashboard', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
    const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
    const ok = /sign out|log off/i.test(text);
    console.log(`[${new Date().toISOString()}] chase: ${ok ? 'OK' : 'EXPIRED'} (url=${page.url()})`);
    return ok;
  } finally {
    await browser.close();
  }
}

async function pingAmazon() {
  const browser = await chromium.connectOverCDP(disco().wsEndpoint);
  try {
    const ctx = browser.contexts()[0];
    let page = ctx.pages().find((p) => p.url().includes('amazon.com'));
    if (!page) page = await ctx.newPage();
    await page.goto('https://www.amazon.com/your-orders/orders', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    }).catch(() => {});
    await page.waitForTimeout(3000);
    const url = page.url();
    const ok = !/\/ap\/(signin|challenge|mfa)/.test(url);
    console.log(`[${new Date().toISOString()}] amazon: ${ok ? 'OK' : 'EXPIRED'} (url=${url})`);
    return ok;
  } finally {
    await browser.close();
  }
}

async function cycle() {
  const [c, a] = await Promise.allSettled([pingChase(), pingAmazon()]);
  if (c.status === 'rejected') console.error('[keepalive] chase error:', c.reason?.message);
  if (a.status === 'rejected') console.error('[keepalive] amazon error:', a.reason?.message);
}

console.log(`[keepalive] starting, interval=${INTERVAL_MS}ms`);
await cycle();
setInterval(cycle, INTERVAL_MS);

process.on('SIGTERM', () => process.exit(0));
