#!/usr/bin/env node
/**
 * One-shot: drive USAA headless login + 2FA reconnaissance.
 *
 * Flow:
 *   1. goto /my/logon, fill memberId, click Next
 *   2. fill password, click Next
 *   3. click "Text security code to:" button (triggers SMS)
 *   4. wait for OTP_CODE env var to be present (poll /tmp/usaa-otp.txt)
 *   5. enter OTP, submit
 *   6. confirm session, then walk authenticated pages and dump selectors
 *
 * Run: `node packages/polyfill-connectors/scripts/usaa-login-and-recon.js`
 * the owner submits OTP by: `echo <CODE> > /tmp/usaa-otp.txt`
 */

import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPersistentContext } from '../src/browser-profile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
dotenvConfig({ path: join(REPO_ROOT, '.env.local') });

const OTP_FILE = '/tmp/usaa-otp.txt';

async function waitForOtp() {
  console.log(`[usaa] waiting for OTP — the owner should write it to ${OTP_FILE}`);
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min
  while (Date.now() < deadline) {
    if (existsSync(OTP_FILE)) {
      const code = readFileSync(OTP_FILE, 'utf8').trim();
      if (/^\d{6}$/.test(code)) {
        unlinkSync(OTP_FILE);
        console.log(`[usaa] OTP received: ${code}`);
        return code;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('OTP timeout — no code within 10 min');
}

async function run() {
  if (!process.env.USAA_USERNAME || !process.env.USAA_PASSWORD) {
    throw new Error('USAA_USERNAME / USAA_PASSWORD not set in .env.local');
  }
  const ctx = await launchPersistentContext({ headless: true });
  const page = await ctx.newPage();

  try {
    console.log('[usaa] navigating to /my/logon');
    await page.goto('https://www.usaa.com/my/logon', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[name="memberId"]', { timeout: 20000 });
    await page.fill('input[name="memberId"]', process.env.USAA_USERNAME);
    console.log('[usaa] filled memberId');
    await page.click('#next-button');

    await page.waitForSelector('input[name="password"]', { timeout: 20000 });
    await page.fill('input[name="password"]', process.env.USAA_PASSWORD);
    console.log('[usaa] filled password');
    await page.click('#next-button');

    // Wait for 2FA choice page (or accounts landing if already-trusted device)
    await page.waitForTimeout(5000);
    const pageText = (await page.locator('body').innerText()).slice(0, 1000);
    console.log('[usaa] post-password body preview:', pageText.replace(/\s+/g, ' ').slice(0, 300));

    if (/Text security code/i.test(pageText)) {
      console.log('[usaa] 2FA required → clicking "Text security code"');
      await page.click('#miam-choice-container\\ 0-id').catch(async () => {
        // Fallback by text if the id selector's escape doesn't resolve
        await page.getByText(/Text security code to:/i).first().click();
      });
      console.log('[usaa] SMS requested — waiting for OTP file');
      // Wait for OTP entry page
      await page.waitForSelector('input[type="text"][autocomplete="one-time-code"], input[name*="code" i], input[name*="Code" i], input[placeholder*="code" i]', { timeout: 20000 }).catch(async () => {
        // Unknown field — dump what we see
        const fields = await page.evaluate(() => [...document.querySelectorAll('input')].map(el => ({
          name: el.name, id: el.id, placeholder: el.placeholder, type: el.type, ac: el.getAttribute('autocomplete'),
        })));
        console.log('[usaa] OTP input selectors not matched; visible inputs:', JSON.stringify(fields));
        throw new Error('OTP input selector unknown');
      });

      const otp = await waitForOtp();
      const otpInput = await page.locator('input[type="text"][autocomplete="one-time-code"], input[name*="code" i], input[placeholder*="code" i]').first();
      await otpInput.fill(otp);
      console.log('[usaa] OTP filled — clicking submit');
      await page.click('button[type="submit"], #next-button').catch(() => {});
      await page.waitForTimeout(6000);
    }

    console.log('[usaa] post-2FA url:', page.url());
    const bodyAfter = (await page.locator('body').innerText()).slice(0, 800).replace(/\s+/g, ' ');
    console.log('[usaa] post-2FA body:', bodyAfter);

    // Quick authenticated check: cookie probe
    const cookies = await ctx.cookies('https://www.usaa.com/');
    const loggedIn = cookies.find((c) => c.name === 'UsaaMbWebMemberLoggedIn');
    console.log('[usaa] UsaaMbWebMemberLoggedIn:', loggedIn?.value);

    // Now reconnoiter the logged-in dashboard
    console.log('[usaa] recon: navigating to /my/accounts');
    await page.goto('https://www.usaa.com/my/accounts', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(6000);
    console.log('[usaa] /my/accounts final url:', page.url());
    const accountsBody = (await page.locator('body').innerText()).slice(0, 800).replace(/\s+/g, ' ');
    console.log('[usaa] /my/accounts body preview:', accountsBody);

    const accountLinks = await page.evaluate(() => {
      return [...document.querySelectorAll('a[href*="/my/"], a[href*="account" i], button')].slice(0, 40).map((el) => ({
        tag: el.tagName.toLowerCase(),
        href: el.getAttribute('href'),
        text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 70),
        id: el.id || null,
        dataTestid: el.getAttribute('data-testid') || null,
      }));
    });
    console.log('[usaa] account-like links:');
    for (const l of accountLinks.slice(0, 30)) console.log('   ', JSON.stringify(l));

    // Dollar amounts
    const amounts = await page.evaluate(() => [...(document.body.innerText || '').matchAll(/\$[\d,]+\.\d{2}/g)].map(m => m[0]).slice(0, 20));
    console.log('[usaa] amounts found on dashboard:', amounts);

    console.log('[usaa] DONE — leaving context open for 30s to let you inspect (or Ctrl+C)');
    await page.waitForTimeout(30000);
  } finally {
    await ctx.close();
  }
}

run().catch((e) => {
  console.error('[usaa] FAILED:', e.message);
  process.exit(1);
});
