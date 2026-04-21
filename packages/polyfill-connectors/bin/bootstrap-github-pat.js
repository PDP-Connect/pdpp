#!/usr/bin/env node
/**
 * One-shot: log into github.com (reusing the shared Playwright profile),
 * drive the classic PAT creation form, read the generated token, and append
 * it to .env.local as GITHUB_PERSONAL_ACCESS_TOKEN.
 *
 * Usage:
 *   node bin/bootstrap-github-pat.js                     # default: name=PDPP, scopes=repo,read:user
 *   node bin/bootstrap-github-pat.js --headed            # visible browser (first run likely needs this)
 *   node bin/bootstrap-github-pat.js --name="X" --scopes=repo,gist
 *
 * Requires in .env.local:
 *   GITHUB_EMAIL=...
 *   GITHUB_PASSWORD=...
 *   GITHUB_TOTP_SECRET=...   (optional, for unattended; otherwise you'll be
 *                              prompted via INTERACTION over ntfy or stdin)
 */

import { config as dotenvConfig } from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPersistentContext } from '../src/browser-profile.js';
import { ensureGithubSession, ensureSudoMode } from '../src/auto-login/github.js';
import { handleInteraction } from '../src/interaction-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const ENV_FILE = join(REPO_ROOT, '.env.local');

dotenvConfig({ path: ENV_FILE });

function parseArgs(argv) {
  const out = { headed: false, name: `PDPP polyfill (${new Date().toISOString().slice(0, 10)})`, scopes: 'repo,read:user,read:org' };
  for (const a of argv) {
    if (a === '--headed') out.headed = true;
    else if (a.startsWith('--name=')) out.name = a.slice(7);
    else if (a.startsWith('--scopes=')) out.scopes = a.slice(9);
  }
  return out;
}

let _ic = 0;
const nextInteractionId = () => `int_${Date.now()}_${++_ic}`;
const sendInteractionAndWait = (msg) => handleInteraction(msg, { connectorName: 'github-bootstrap' });

async function createPat({ page, name, scopes }) {
  const description = encodeURIComponent(name);
  const scopeParam = encodeURIComponent(scopes);
  const targetUrl = `https://github.com/settings/tokens/new?description=${description}&scopes=${scopeParam}`;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Drive login/2FA/sudo as required, looping until we either land on the PAT
  // form (#oauth_access_description visible) or exhaust our step budget.
  const isOnPatForm = () => page.locator('#oauth_access_description').isVisible().catch(() => false);
  const loginId = process.env.GITHUB_EMAIL || process.env.GITHUB_USERNAME;
  const password = process.env.GITHUB_PASSWORD;

  for (let step = 0; step < 6; step++) {
    if (await isOnPatForm()) break;
    const url = page.url();

    if (/\/login/.test(url)) {
      console.error(`[bootstrap-github-pat] step ${step}: on /login — filling credentials`);
      await page.locator('#login_field').waitFor({ state: 'visible', timeout: 15000 });
      await page.fill('#login_field', loginId);
      await page.fill('#password', password);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
        page.click('input[type="submit"][name="commit"]'),
      ]);
      continue;
    }

    // 2FA TOTP page: /sessions/two-factor or inline 2FA challenge
    const totpField = page.locator('#app_totp, #sms_totp, input[name="otp"]').first();
    if (await totpField.isVisible().catch(() => false)) {
      console.error(`[bootstrap-github-pat] step ${step}: 2FA prompt at ${url}`);
      const resp = await sendInteractionAndWait({
        type: 'INTERACTION', request_id: nextInteractionId(), kind: 'otp',
        message: 'GitHub wants a 2FA code. Reply with the 6-digit TOTP.',
        schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
        timeout_seconds: 600,
      });
      if (resp.status !== 'success' || !resp.data?.code) throw new Error('github_totp_not_provided');
      await totpField.fill(resp.data.code);
      // GitHub auto-submits the OTP form on input length; race a nav event with an explicit click.
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
        (async () => {
          const btn = page.locator('form button[type="submit"], form input[type="submit"]').first();
          if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
        })(),
      ]);
      continue;
    }

    // Device-verification by email
    const deviceField = page.locator('input[name="otp"], input[autocomplete="one-time-code"]').first();
    if (/verified-device|device-verification/.test(url) || await deviceField.isVisible().catch(() => false)) {
      console.error(`[bootstrap-github-pat] step ${step}: device-verification at ${url}`);
      const resp = await sendInteractionAndWait({
        type: 'INTERACTION', request_id: nextInteractionId(), kind: 'otp',
        message: 'GitHub sent a device-verification code to your email. Reply with the code.',
        schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
        timeout_seconds: 900,
      });
      if (resp.status !== 'success' || !resp.data?.code) throw new Error('github_device_code_not_provided');
      await deviceField.fill(resp.data.code);
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
        (async () => {
          const btn = page.locator('form button[type="submit"], form input[type="submit"]').first();
          if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
        })(),
      ]);
      continue;
    }

    // Sudo mode
    if (/\/sessions\/sudo/.test(url)) {
      console.error(`[bootstrap-github-pat] step ${step}: sudo mode`);
      await ensureSudoMode(page, { sendInteractionAndWait, nextInteractionId });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      continue;
    }

    // No known challenge visible — navigate to target and retry.
    console.error(`[bootstrap-github-pat] step ${step}: no challenge recognized at ${url}; navigating to target`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }

  if (!(await isOnPatForm())) {
    throw new Error(`couldn't land on PAT form; final url=${page.url()}`);
  }

  // Confirm we're on the form — log diagnostics if not
  try {
    await page.waitForSelector('#oauth_access_description', { timeout: 15000 });
  } catch (err) {
    const curUrl = page.url();
    const title = await page.title().catch(() => '');
    const h1 = await page.locator('h1, h2').first().innerText().catch(() => '');
    const bodyPreview = (await page.locator('body').innerText().catch(() => '')).slice(0, 800);
    console.error(`[bootstrap-github-pat] PAT form not found`);
    console.error(`  url: ${curUrl}`);
    console.error(`  title: ${title}`);
    console.error(`  heading: ${h1}`);
    console.error(`  body preview: ${bodyPreview}`);
    throw err;
  }

  // The description is prefilled via query param but we re-fill to be safe.
  await page.fill('#oauth_access_description', name);

  // Expiration: set to "No expiration" for a long-lived polyfill cred. If the
  // page enforces a max, fall back to 1 year (max option).
  const expSelect = page.locator('select[name="oauth_access[expires_at]"]').first();
  if (await expSelect.count()) {
    // Try value="none" (No expiration); fall back to the last option (longest lived).
    const values = await expSelect.evaluate((el) => [...el.options].map((o) => o.value));
    const preferred = values.includes('none') ? 'none' : values[values.length - 1];
    await expSelect.selectOption(preferred);
    // Some flows pop a confirmation modal — click it if it appears.
    const confirmBtn = page.locator('button:has-text("OK"), button:has-text("I understand")').first();
    if (await confirmBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await confirmBtn.click();
      await confirmBtn.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
  }

  // Scope checkboxes are prefilled via the URL param. Double-check the ones we asked for.
  const wanted = scopes.split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of wanted) {
    const cb = page.locator(`input[type=checkbox][value="${s}"]`).first();
    if (await cb.count()) {
      const checked = await cb.isChecked();
      if (!checked) await cb.check();
    }
  }

  // Submit — generic: last submit button on the page (expiration confirm is separate).
  const submit = page.locator('button[type=submit]:has-text("Generate"), button[type=submit]:has-text("Create")').last();
  await submit.click();
  await page.waitForSelector('#new-oauth-token, clipboard-copy[value^="ghp_"]', { timeout: 20000 });

  const token = await page.evaluate(() => {
    const el = document.querySelector('#new-oauth-token');
    if (el) return el.textContent.trim();
    const cc = document.querySelector('clipboard-copy[value^="ghp_"]');
    return cc ? cc.getAttribute('value') : null;
  });

  if (!token || !token.startsWith('ghp_')) {
    throw new Error(`token not found in DOM (value=${String(token).slice(0, 20)}...)`);
  }
  return token;
}

function appendEnv(varName, value) {
  const line = `${varName}=${value}\n`;
  if (existsSync(ENV_FILE)) {
    const current = readFileSync(ENV_FILE, 'utf8');
    if (new RegExp(`^${varName}=`, 'm').test(current)) {
      const updated = current.replace(new RegExp(`^${varName}=.*$`, 'm'), `${varName}=${value}`);
      writeFileSync(ENV_FILE, updated, { mode: 0o600 });
      return 'updated';
    }
    writeFileSync(ENV_FILE, current.endsWith('\n') ? current + line : current + '\n' + line, { mode: 0o600 });
    return 'appended';
  }
  writeFileSync(ENV_FILE, line, { mode: 0o600 });
  return 'created';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.error(`[bootstrap-github-pat] name="${args.name}" scopes="${args.scopes}" headed=${args.headed}`);

  const loginId = process.env.GITHUB_EMAIL || process.env.GITHUB_USERNAME;
  if (!loginId || !process.env.GITHUB_PASSWORD) {
    console.error('[bootstrap-github-pat] GITHUB_EMAIL (or GITHUB_USERNAME) and GITHUB_PASSWORD must be set in .env.local');
    process.exit(2);
  }

  const context = await launchPersistentContext({ headless: !args.headed });
  try {
    const page = await context.newPage();
    await ensureGithubSession({ page, sendInteractionAndWait, nextInteractionId });
    const token = await createPat({ page, name: args.name, scopes: args.scopes });
    const mode = appendEnv('GITHUB_PERSONAL_ACCESS_TOKEN', token);
    console.error(`[bootstrap-github-pat] token ${mode} in ${ENV_FILE} (ghp_${token.slice(4, 8)}…${token.slice(-4)})`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('[bootstrap-github-pat] ERROR:', e.message || e);
  process.exit(1);
});
