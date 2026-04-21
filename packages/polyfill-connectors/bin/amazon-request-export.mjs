#!/usr/bin/env node
/**
 * Amazon data-request kickoff utility (WIP — see openspec note
 * `platform-archive-requests-open-question.md`).
 *
 * Automates step 1 of the "request your Amazon data" flow: log in if
 * needed, navigate to Privacy Central, submit a data-request form, and
 * report back to the user. Does NOT handle email verification, zip
 * download, or ingest — those are explicit human-in-the-loop steps today.
 *
 * Usage:
 *   node bin/amazon-request-export.mjs                # interactive: print form state, don't submit
 *   node bin/amazon-request-export.mjs --submit       # submit the form (reserved; not wired yet)
 *   node bin/amazon-request-export.mjs --category all # category selection (reserved; not wired yet)
 *
 * Why a standalone script and not a connector mode: until the archive
 * ingest path is designed (see open question), the request flow is a
 * one-shot utility, not part of a scheduled connector run. Making it a
 * connector mode today would commit us to a `mode` flag in START/state
 * that we haven't designed.
 *
 * Status by section (as of 2026-04-21):
 *   - [✓] Attach to browser daemon via CDP (validated against live daemon)
 *   - [✓] Navigate to Privacy Central preview URL (validated — URL is
 *         `/hz/privacy-central/data-requests/preview.html`)
 *   - [~] Handle Amazon re-auth challenge (reuses ensureAmazonSession;
 *         Privacy Central is known to force re-auth even for logged-in
 *         sessions, so this path will be exercised in practice)
 *   - [ ] Form interaction (category select + submit) — requires live
 *         selector probe when the daemon is free. See PROBE markers.
 *   - [ ] Email-verification link click — explicitly out of scope.
 *   - [ ] Zip download & ingest — explicitly out of scope (open question).
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { ensureAmazonSession } from '../src/auto-login/amazon.js';
import { config as dotenvConfig } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
dotenvConfig({ path: join(REPO_ROOT, '.env.the owner.local') });

const PRIVACY_CENTRAL_URL = 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html';

// Mapping from a CLI --category flag to the exact button text on the
// Privacy Central form. Button text is stable-looking ("Submit Request
// <Category>") but there's no form id or name; we have to match on text.
// Discovered via live DOM probe 2026-04-21.
const AMAZON_CATEGORIES = [
  { flag: 'all',        buttonText: 'Submit Request Request All Your Data' },
  { flag: 'orders',     buttonText: 'Submit Request Your Orders' },
  { flag: 'addresses',  buttonText: 'Submit Request Your Addresses' },
  { flag: 'payment',    buttonText: 'Submit Request Payment Options' },
  { flag: 'subs',       buttonText: 'Submit Request Subscriptions' },
  { flag: 'search',     buttonText: 'Submit Request Search History' },
  { flag: 'alexa',      buttonText: 'Submit Request Echo Devices and Alexa' },
  { flag: 'kindle',     buttonText: 'Submit Request Kindle' },
  { flag: 'firetv',     buttonText: 'Submit Request Fire TV' },
  { flag: 'firetab',    buttonText: 'Submit Request Fire Tablets' },
  { flag: 'advertising', buttonText: 'Submit Request Advertising' },
  { flag: 'photos',     buttonText: 'Submit Request Amazon Photos and Drive' },
  { flag: 'apps',       buttonText: 'Submit Request Apps and More' },
  { flag: 'music',      buttonText: 'Submit Request Amazon Music' },
  { flag: 'video',      buttonText: 'Submit Request Prime Video' },
  { flag: 'audible',    buttonText: 'Submit Request Audible' },
  { flag: 'support',    buttonText: 'Submit Request Customer Support Communication' },
];

const args = process.argv.slice(2);
const submit = args.includes('--submit');
const category = (() => {
  const i = args.indexOf('--category');
  return i >= 0 ? args[i + 1] : null;
})();

// Minimal INTERACTION plumbing so ensureAmazonSession can pass us OTP.
// Stdin is a terminal here, not a Collection Profile orchestrator, so
// we implement INTERACTION by reading a 6-digit code from stdin.
let interactionCounter = 0;
const nextInteractionId = () => `cli_${Date.now()}_${++interactionCounter}`;

async function sendInteractionAndWait(msg) {
  console.error(`\n[interaction] ${msg.message || msg.kind}`);
  console.error(`[interaction] waiting for input on stdin (enter 6-digit code)...`);
  return new Promise((resolve) => {
    const onData = (buf) => {
      const s = buf.toString().trim();
      process.stdin.off('data', onData);
      resolve({ status: 'success', data: { code: s }, request_id: msg.request_id });
    };
    process.stdin.on('data', onData);
  });
}

function readDaemonDiscovery() {
  try {
    return JSON.parse(readFileSync(`${process.env.HOME}/.pdpp/browser-daemon.json`, 'utf8'));
  } catch (e) {
    throw new Error(`could not read browser-daemon.json: ${e.message}. Start the daemon first.`);
  }
}

async function snapshotFormState(page) {
  return page.evaluate(() => {
    const qa = (sel) => [...document.querySelectorAll(sel)];
    return {
      url: location.href,
      title: document.title,
      headings: qa('h1, h2, h3').map((h) => (h.innerText || '').trim()).filter(Boolean).slice(0, 20),
      selects: qa('select').map((s) => ({
        name: s.name, id: s.id,
        options: [...s.options].map((o) => ({ value: o.value, label: (o.textContent || '').trim() })).slice(0, 40),
      })),
      radios: qa('input[type="radio"]').map((r) => ({
        name: r.name, id: r.id, value: r.value,
        labelText: (document.querySelector(`label[for="${r.id}"]`)?.innerText || '').trim().slice(0, 120),
        checked: r.checked,
      })),
      buttons: qa('button, input[type="submit"]').map((b) => ({
        id: b.id, name: b.name, type: b.type,
        text: (b.innerText || b.value || '').trim().slice(0, 80),
        disabled: b.disabled,
      })).filter((b) => b.text).slice(0, 30),
      bodyPreview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
    };
  });
}

async function main() {
  const disc = readDaemonDiscovery();
  console.error(`[request-export] attaching to daemon ws=${disc.wsEndpoint.slice(0, 40)}…`);
  const browser = await chromium.connectOverCDP(disc.wsEndpoint);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  try {
    console.error(`[request-export] navigating to ${PRIVACY_CENTRAL_URL}`);
    await page.goto(PRIVACY_CENTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Privacy Central enforces a stricter re-auth challenge than normal
    // session-alive checks — the redirect has `openid.pape.max_auth_age=600`,
    // meaning Amazon wants a password entered within the last 10 minutes
    // even if the general session is active. `ensureAmazonSession` probes
    // /your-orders and short-circuits when that works, so it doesn't drive
    // the re-auth. Handle the re-auth here directly: password input is
    // typically pre-seeded with the right email, so we only need to fill
    // password and submit. Fall back to full auto-login on 2FA.
    if (/\/ap\/(signin|challenge|mfa)/.test(page.url())) {
      console.error('[request-export] Privacy Central triggered re-auth challenge');
      const password = process.env.AMAZON_PASSWORD;
      if (!password) throw new Error('AMAZON_PASSWORD not set; cannot drive Privacy Central re-auth');

      // Password input on the re-auth page is `#ap_password`. The email
      // is already selected via the "Switch accounts" panel.
      const pwLoc = page.locator('input#ap_password');
      await pwLoc.waitFor({ state: 'visible', timeout: 15000 });
      await pwLoc.fill(password);
      await page.locator('input#signInSubmit, input[type="submit"], button[type="submit"]').first().click();
      await page.waitForTimeout(5000);

      // 2FA may follow on some challenges. Reuse the INTERACTION shim.
      const bodyAfter = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
      if (/verification|two.?step|authenticator|passcode|code we sent|sent a text/i.test(bodyAfter)) {
        console.error('[request-export] 2FA challenge after password — prompting for code');
        const resp = await sendInteractionAndWait({
          type: 'INTERACTION',
          request_id: nextInteractionId(),
          kind: 'otp',
          message: 'Amazon 2FA required for Privacy Central. Reply with the code from your phone or authenticator.',
        });
        if (resp.status !== 'success' || !resp.data?.code) throw new Error('2FA code not provided');
        const otp = page.locator('input[name="otpCode"], input#auth-mfa-otpcode, input[autocomplete="one-time-code"]');
        await otp.first().waitFor({ state: 'visible', timeout: 15000 });
        await otp.first().fill(resp.data.code);
        await page.locator('input#auth-signin-button, button[type="submit"], input[type="submit"]').first().click();
        await page.waitForTimeout(6000);
      }

      // If we're still on /ap/signin after password (+ optional 2FA),
      // something else is wrong — fall back to the full ensureAmazonSession
      // path in case the session itself is actually dead.
      if (/\/ap\/(signin|challenge|mfa)/.test(page.url())) {
        console.error('[request-export] still on sign-in; falling back to full auto-login');
        await ensureAmazonSession({ context, page, sendInteractionAndWait, nextInteractionId });
        await page.goto(PRIVACY_CENTRAL_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);
      }
    }

    const snap = await snapshotFormState(page);
    console.log(JSON.stringify(snap, null, 2));

    if (!submit) {
      console.error('\n[request-export] --submit not passed; printing form state and exiting.');
      console.error('[request-export] re-run with --submit --category <name> to actually request data.');
      console.error('[request-export] known categories (button-text prefix "Submit Request "):');
      console.error(AMAZON_CATEGORIES.map((c) => `  - ${c.flag.padEnd(20)} → "${c.buttonText}"`).join('\n'));
      return;
    }

    if (!category) throw new Error('--submit requires --category <name>. See listed categories above.');
    const match = AMAZON_CATEGORIES.find((c) => c.flag === category);
    if (!match) throw new Error(`unknown category "${category}". Known: ${AMAZON_CATEGORIES.map((c) => c.flag).join(', ')}`);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = '/tmp';
    const preShotPath = `${outDir}/amazon-request-${match.flag}-${stamp}-pre.png`;
    const postShotPath = `${outDir}/amazon-request-${match.flag}-${stamp}-post.png`;
    const postDomPath = `${outDir}/amazon-request-${match.flag}-${stamp}-post.html`;

    console.error(`[request-export] capturing pre-submit screenshot → ${preShotPath}`);
    await page.screenshot({ path: preShotPath, fullPage: true }).catch((e) => console.error(`  screenshot failed: ${e.message}`));

    // Start listening for the response to the form POST before we click,
    // so we can capture the server's confirmation URL and status cleanly.
    const postPromise = page.waitForResponse(
      (r) => r.url().includes('/privacy-central/data-requests/create.html') && r.request().method() === 'POST',
      { timeout: 30000 }
    ).catch(() => null);

    console.error(`[request-export] submitting category="${match.flag}" via button text "${match.buttonText}"`);
    const submitBtn = page.getByRole('button', { name: match.buttonText, exact: true })
      .or(page.locator(`input[type="submit"][value="${match.buttonText}"]`));
    await submitBtn.first().waitFor({ state: 'visible', timeout: 15000 });
    await submitBtn.first().click();

    const postResp = await postPromise;
    if (postResp) {
      console.error(`[request-export] POST response: status=${postResp.status()} url=${postResp.url()}`);
    } else {
      console.error('[request-export] POST response was not observed within timeout (may have already redirected)');
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);

    console.error(`[request-export] capturing post-submit screenshot → ${postShotPath}`);
    await page.screenshot({ path: postShotPath, fullPage: true }).catch((e) => console.error(`  screenshot failed: ${e.message}`));

    const postSnap = await page.evaluate(() => {
      const qa = (sel) => [...document.querySelectorAll(sel)];
      return {
        url: location.href,
        title: document.title,
        bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000),
        headings: qa('h1, h2, h3').map((h) => (h.innerText || '').trim()).filter(Boolean).slice(0, 20),
        forms: qa('form').map((f) => ({
          id: f.id,
          action: f.action,
          method: f.method,
          buttons: [...f.querySelectorAll('input[type="submit"], button')]
            .map((b) => (b.value || b.innerText || '').trim()).filter(Boolean).slice(0, 10),
        })),
        buttons: qa('button, input[type="submit"], a[role="button"]').map((b) => ({
          tag: b.tagName,
          text: (b.value || b.innerText || '').trim().slice(0, 120),
          href: b.href || null,
        })).filter((b) => b.text).slice(0, 30),
        links: qa('a[href]').map((a) => ({
          text: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100),
          href: a.href,
        })).filter((a) => /request|privacy|data|confirm|cancel|verif/i.test(a.text + a.href)).slice(0, 20),
      };
    });

    console.error('[request-export] capturing post-submit DOM → ' + postDomPath);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(postDomPath, await page.content());

    console.error('\n===== POST-SUBMIT SNAPSHOT =====');
    console.log(JSON.stringify(postSnap, null, 2));
    console.error('===== END SNAPSHOT =====');

    console.error(`\n[request-export] URL: ${postSnap.url}`);
    console.error(`[request-export] screenshots: pre=${preShotPath} post=${postShotPath}`);
    console.error(`[request-export] DOM: ${postDomPath}`);

  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`[request-export] ERROR: ${e.message}`);
  process.exit(1);
});
