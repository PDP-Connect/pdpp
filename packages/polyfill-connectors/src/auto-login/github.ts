// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub automated login + sudo-mode re-auth.
 *
 * Probes the shared Playwright profile for a live github.com session.
 * Falls back to username/password login. Handles sudo mode (required before
 * creating PATs, ~2h session). TOTP codes always come via INTERACTION —
 * the operator supplies the 6-digit code (ntfy → phone or file drop).
 *
 * Device-verification email on first login from a new IP/UA is NOT handled
 * automatically — the owner must have done a headed bootstrap-browser pass first
 * so the IP + profile are trusted.
 */

import type { Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";

const AUTH_REDIRECT_URL = /\/login|\/sessions|verified-device|two-factor/;
const DEVICE_VERIFICATION_URL = /verified-device|device-verification/;
const VERIFY_HEADING_TEXT = /verify|device/;
const SUDO_URL = /\/sessions\/sudo/;

type SendInteraction = (req: InteractionRequest) => Promise<InteractionResponse>;

interface EnsureGithubSessionArgs {
  page: Page;
  sendInteraction: SendInteraction;
}

interface HandlerArgs {
  sendInteraction: SendInteraction;
}

interface SudoHandlerArgs {
  password: string | undefined;
  sendInteraction: SendInteraction | undefined;
}

interface EnsureSudoModeArgs {
  sendInteraction?: SendInteraction;
}

async function isLoggedIn(page: Page): Promise<boolean> {
  await page
    .goto("https://github.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    .catch((): undefined => undefined);
  const url = page.url();
  if (AUTH_REDIRECT_URL.test(url)) {
    return false;
  }
  // Stricter: presence of user-login meta is the most reliable signal.
  const userLoginMeta = await page
    .locator('meta[name="user-login"]')
    .count()
    .catch((): number => 0);
  return userLoginMeta > 0;
}

async function fillLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto("https://github.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.locator("#login_field").waitFor({ state: "visible", timeout: 15_000 });
  await page.fill("#login_field", email);
  await page.fill("#password", password);
  await page.click('input[type="submit"][name="commit"], button[type="submit"]');
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);
}

async function handleDeviceVerificationIfAsked(page: Page, { sendInteraction }: HandlerArgs): Promise<void> {
  const url = page.url();
  if (!DEVICE_VERIFICATION_URL.test(url)) {
    // Also check the page content — sometimes the URL doesn't match but the page asks for a device code.
    const heading = (
      await page
        .locator("h1, h2")
        .first()
        .innerText()
        .catch((): string => "")
    ).toLowerCase();
    if (!VERIFY_HEADING_TEXT.test(heading)) {
      return;
    }
  }

  const otpField = page.locator('input[name="otp"], input#otp, input[autocomplete="one-time-code"]').first();
  if (!(await otpField.isVisible().catch((): boolean => false))) {
    return;
  }

  if (!sendInteraction) {
    throw new Error("github_device_verification_required_but_no_handler");
  }
  const resp = await sendInteraction({
    kind: "otp",
    message: "GitHub sent a device-verification code to your email. Reply with the code.",
    schema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
    timeout_seconds: 900,
  });
  if (resp.status !== "success" || !resp.data?.code) {
    throw new Error("github_device_code_not_provided");
  }
  await otpField.fill(resp.data.code);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);
}

async function handleTotpIfAsked(page: Page, { sendInteraction }: HandlerArgs): Promise<void> {
  const totpField = page.locator('#app_totp, #sms_totp, input[name="otp"], input#otp').first();
  const visible = await totpField.isVisible().catch((): boolean => false);
  if (!visible) {
    return;
  }

  if (!sendInteraction) {
    throw new Error("github_totp_required_but_no_interaction_handler");
  }
  const resp = await sendInteraction({
    kind: "otp",
    message: "GitHub wants a 2FA code. Reply with the 6-digit TOTP from your authenticator app.",
    schema: {
      type: "object",
      properties: { code: { type: "string", pattern: "^\\d{6}$" } },
      required: ["code"],
    },
    timeout_seconds: 600,
  });
  if (resp.status !== "success" || !resp.data?.code) {
    throw new Error("github_totp_not_provided");
  }
  const { code } = resp.data;

  await totpField.fill(code);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);
}

async function handleSudoIfAsked(page: Page, { password, sendInteraction }: SudoHandlerArgs): Promise<void> {
  if (!SUDO_URL.test(page.url())) {
    return;
  }

  // Prefer password path (TOTP in sudo needs recent re-auth too and adds a hop).
  const usePasswordLink = page.locator('a:has-text("password"), a[href*="sudo_password"]').first();
  const passwordFieldVisible = await page
    .locator('input[name="sudo_password"]')
    .isVisible()
    .catch((): boolean => false);

  // Try to switch to password input if the field isn't already visible.
  if (!passwordFieldVisible && (await usePasswordLink.isVisible().catch((): boolean => false))) {
    await usePasswordLink.click();
    await page
      .locator('input[name="sudo_password"]')
      .waitFor({ state: "visible", timeout: 8000 })
      .catch((): undefined => undefined);
  }

  const pwVisible = await page
    .locator('input[name="sudo_password"]')
    .isVisible()
    .catch((): boolean => false);
  if (pwVisible) {
    if (!password) {
      throw new Error("github_sudo_password_required");
    }
    await page.fill('input[name="sudo_password"]', password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);
    return;
  }

  // Fallback: TOTP in sudo mode
  const otpField = page.locator('input[name="otp"], input#otp').first();
  if (await otpField.isVisible().catch((): boolean => false)) {
    if (!sendInteraction) {
      throw new Error("github_sudo_totp_required_but_no_interaction_handler");
    }
    await handleTotpIfAsked(page, { sendInteraction });
    return;
  }

  throw new Error("github_sudo_unrecognized_form");
}

/**
 * Ensure the browser is logged into github.com. Returns when ready.
 */
export async function ensureGithubSession({ page, sendInteraction }: EnsureGithubSessionArgs): Promise<boolean> {
  const alreadyLoggedIn = await isLoggedIn(page);
  process.stderr.write(`[github-login] initial isLoggedIn=${alreadyLoggedIn} url=${page.url()}\n`);
  if (alreadyLoggedIn) {
    return true;
  }

  const email = process.env.GITHUB_EMAIL ?? process.env.GITHUB_USERNAME;
  const password = process.env.GITHUB_PASSWORD;
  if (!(email && password)) {
    throw new Error("GITHUB_EMAIL/USERNAME + GITHUB_PASSWORD must be set; cannot auto-login");
  }

  await fillLogin(page, email, password);
  // Diagnostic trace so we can see where GitHub routes us post-credentials.
  process.stderr.write(`[github-login] after password submit, url=${page.url()}\n`);
  await handleTotpIfAsked(page, { sendInteraction });
  process.stderr.write(`[github-login] after totp, url=${page.url()}\n`);
  await handleDeviceVerificationIfAsked(page, { sendInteraction });
  process.stderr.write(`[github-login] after device-verify, url=${page.url()}\n`);

  if (!(await isLoggedIn(page))) {
    const url = page.url();
    throw new Error(`github_login_failed (landed on ${url})`);
  }
  return true;
}

/**
 * Ensure the session is in sudo mode (required for PAT creation). Caller
 * should navigate the page to a sudo-triggering URL first (e.g.
 * /settings/tokens/new) and then call this.
 */
export async function ensureSudoMode(page: Page, { sendInteraction }: EnsureSudoModeArgs = {}): Promise<boolean> {
  if (SUDO_URL.test(page.url())) {
    await handleSudoIfAsked(page, {
      password: process.env.GITHUB_PASSWORD,
      sendInteraction,
    });
  }
  return true;
}
