/**
 * Auto-login probe: drives ensureAmazonSession + Chase login against the
 * daemon browser. Uses .env credentials. OTP requests go through the
 * standard interaction-handler (file drop at /tmp/pdpp-interaction-<id>.response.json).
 *
 * Usage:
 *   node scripts/auto-login-probe.mjs amazon
 *   node scripts/auto-login-probe.mjs chase
 *   node scripts/auto-login-probe.mjs both
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { ensureAmazonSession } from '../src/auto-login/amazon.js';
import { handleInteraction } from '../src/interaction-handler.js';

loadEnv({ path: '/home/user/code/pdpp/.env.local' });

const target = process.argv[2] || 'both';

const discovery = JSON.parse(
  readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8')
);
const browser = await chromium.connectOverCDP(discovery.wsEndpoint);
const context = browser.contexts()[0];

let interactionCounter = 0;
const nextInteractionId = () => `int_${Date.now()}_${++interactionCounter}`;

// Wrap handleInteraction to match the ensureSession signature.
const sendInteractionAndWait = (msg) =>
  handleInteraction(msg, { connectorName: 'auto-login-probe' });

async function findOrCreatePage(origin) {
  for (const p of context.pages()) {
    try {
      if (new URL(p.url()).origin === origin) return p;
    } catch {}
  }
  for (const p of context.pages()) {
    if (p.url() === 'about:blank') return p;
  }
  return await context.newPage();
}

async function loginAmazon() {
  console.log('\n=== AMAZON ===');
  const page = await findOrCreatePage('https://www.amazon.com');
  try {
    await ensureAmazonSession({
      context,
      page,
      sendInteractionAndWait,
      nextInteractionId,
    });
    console.log('[amazon] session OK');
    return true;
  } catch (err) {
    console.error(`[amazon] FAILED: ${err.message}`);
    return false;
  }
}

async function loginChase() {
  console.log('\n=== CHASE ===');
  const page = await findOrCreatePage('https://secure.chase.com');
  const username = process.env.CHASE_USERNAME;
  const password = process.env.CHASE_PASSWORD;
  if (!username || !password) {
    console.error('[chase] CHASE_USERNAME / CHASE_PASSWORD not set');
    return false;
  }

  // No ensureChaseSession helper yet — this is first-principles probe.
  // Goal: get logged in, let the owner's 2FA code flow through, end up on dashboard.
  try {
    await page.goto('https://secure.chase.com/web/auth/', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const url = page.url();
    console.log(`[chase] landed: ${url}`);

    // Quick probe: are we already logged in?
    const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
    if (/Sign Out|Log ?Off|welcome back/i.test(bodyText) && !/Sign ?(?:In|On)/i.test(bodyText.slice(0, 100))) {
      console.log('[chase] already logged in');
      return true;
    }

    // Diagnose the login page structure for the first time.
    const diag = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      inputs: [...document.querySelectorAll('input')].slice(0, 10).map((i) => ({
        name: i.name, id: i.id, type: i.type, placeholder: i.placeholder,
      })),
      buttons: [...document.querySelectorAll('button, input[type="submit"]')].slice(0, 10).map((b) => ({
        text: (b.innerText || b.value || '').slice(0, 40),
        id: b.id, type: b.type,
      })),
      iframes: document.querySelectorAll('iframe').length,
    }));
    console.log('[chase] login page diag:', JSON.stringify(diag, null, 2).slice(0, 1500));

    // Try common selectors — Chase has historically used #userId-text-input-field + #password-text-input-field
    const userSel = 'input#userId-text-input-field, input[name="userId"], input[id*="userId" i], input[id*="username" i]';
    const passSel = 'input#password-text-input-field, input[name="password"], input[type="password"]';

    await page.waitForSelector(userSel, { timeout: 15000 });
    await page.fill(userSel, username);
    await page.fill(passSel, password);

    // Submit
    const submitSel = 'button#signin-button, button[type="submit"], button:has-text("Sign In"), input[type="submit"]';
    await page.click(submitSel).catch(() => {});
    await page.waitForTimeout(6000);

    const postUrl = page.url();
    const postText = (await page.locator('body').innerText().catch(() => '')).slice(0, 600);
    console.log(`[chase] after submit: ${postUrl}`);
    console.log(`[chase] text preview: ${postText.replace(/\s+/g, ' ').slice(0, 300)}`);

    // Chase's 2FA is a two-step flow:
    //   (1) Confirm Your Identity — chooser page ("Choose a confirmation method").
    //   (2) Enter the code.
    // We auto-pick SMS/text unless CHASE_2FA_METHOD overrides it.
    if (/confirm your identity|choose a confirmation method|how would you like/i.test(postText)) {
      // Chase uses `mds-*` Web Components. The mds-list-item HOST elements
      // have zero bounding box (their visual content is rendered inside the
      // parent mds-list's shadow root, slot-projected). Attribute-based
      // locators like `mds-list-item#sms` resolve the host but fail
      // Playwright's visibility check because the host has size 0.
      //
      // Solution: locate by visible TEXT. Playwright's `text=` and
      // `getByRole` engines pierce shadow DOM and return the actual
      // rendered node, which has a real bounding box and accepts trusted
      // clicks.
      const method = (process.env.CHASE_2FA_METHOD || 'text').toLowerCase();
      const methodLabels = {
        text: 'Get a text', sms: 'Get a text',
        voice: 'Call me', call: 'Call me',
        email: 'Email me',
      };
      const label = methodLabels[method] || 'Get a text';
      console.log(`[chase] method-chooser page; picking role=link name^="${label}"`);

      // Chase's method options render as <a href="javascript:void(0)"> with
      // aria-label starting with the short label. text= matches the inner
      // span but pointer events are captured by the <a>, so we target the
      // link directly. Using partial match because aria-label includes the
      // full description ("Get a text. We'll text a one-time code to your phone.").
      await page.getByRole('link', { name: new RegExp(`^${label}`, 'i') })
        .first()
        .click({ timeout: 10000 });
      await page.waitForTimeout(1500);

      // Next button — prefer text-based locator. Falls back to mds-button#next-content.
      const nextByText = page.locator('text="Next"').first();
      if (await nextByText.count().catch(() => 0)) {
        await nextByText.click({ timeout: 10000 });
        console.log('[chase] continue click: text="Next"');
      } else {
        await page.locator('mds-button#next-content').click({ timeout: 10000 }).catch(() => {});
        console.log('[chase] continue click: mds-button#next-content');
      }
      await page.waitForTimeout(5000);

      const newText = (await page.locator('body').innerText().catch(() => '')).slice(0, 600);
      console.log(`[chase] after method-pick: ${newText.replace(/\s+/g, ' ').slice(0, 300)}`);
    }

    const afterText = (await page.locator('body').innerText().catch(() => '')).slice(0, 600);
    if (/identification code|security code|verification code|we sent|enter (the|your) code|enter identification code/i.test(afterText)) {
      console.log('[chase] 2FA challenge detected, requesting OTP from user');
      const resp = await sendInteractionAndWait({
        type: 'INTERACTION',
        request_id: nextInteractionId(),
        kind: 'otp',
        message: 'Chase sent a 2FA code. Reply with it.',
        schema: {
          type: 'object',
          properties: { code: { type: 'string', pattern: '^[0-9]{4,8}$' } },
          required: ['code'],
        },
        timeout_seconds: 600,
      });
      if (resp.status !== 'success' || !resp.data?.code) {
        console.error('[chase] OTP not provided');
        return false;
      }
      // Chase's OTP input is `mds-text-input-secure#otpInput`. The actual
      // <input type="password"> lives in the host's shadow root. Playwright's
      // default CSS engine pierces open shadow DOM for descendant selectors,
      // so `input[type="password"]` finds the inner input directly (the
      // signin page is the only other place a password input exists, and
      // we're past signin now).
      //
      // `pressSequentially` fires per-character keydown/input events, which
      // mds-* framework components listen for. A bulk `.fill()` or JS-level
      // `.value = code` did not trigger the component's internal validation
      // state, so the form treated the input as empty and rejected submit.
      const otpInput = page.locator('input[type="password"]').first();
      await otpInput.click({ timeout: 5000 });
      await otpInput.fill('');
      await otpInput.pressSequentially(resp.data.code, { delay: 60 });
      console.log('[chase] otp typed');
      await page.waitForTimeout(800);

      // Submit — locator.click() dispatches trusted events via CDP.
      // Prefer text="Next" (pierces shadow); fall back to mds-button#next-content
      // host; final fallback is keyboard Enter in the input.
      const nextByText = page.locator('text="Next"').first();
      if (await nextByText.count().catch(() => 0)) {
        await nextByText.click({ timeout: 5000 }).catch(() => {});
        console.log('[chase] otp submit: text="Next"');
      } else {
        await page.locator('mds-button#next-content').click({ timeout: 5000 }).catch(async () => {
          await otpInput.press('Enter').catch(() => {});
        });
        console.log('[chase] otp submit: mds-button#next-content (or Enter)');
      }
      await page.waitForTimeout(8000);
    }

    const finalUrl = page.url();
    const finalText = (await page.locator('body').innerText().catch(() => '')).slice(0, 400);
    console.log(`[chase] final: ${finalUrl}`);
    if (/Sign Off|Log Off|sign out/i.test(finalText)) {
      console.log('[chase] session OK');
      return true;
    }
    console.error('[chase] did not reach logged-in state');
    return false;
  } catch (err) {
    console.error(`[chase] FAILED: ${err.message}`);
    return false;
  }
}

const results = {};
if (target === 'amazon' || target === 'both') results.amazon = await loginAmazon();
if (target === 'chase' || target === 'both') results.chase = await loginChase();

console.log('\n=== RESULTS ===');
console.log(JSON.stringify(results, null, 2));

// Disconnect CDP without closing pages.
await browser.close();
process.exit(results && Object.values(results).every(Boolean) ? 0 : 1);
