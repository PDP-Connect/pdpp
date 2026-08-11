// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Venmo automated session management.
 *
 * Ground truth: /tmp/venmo-provider-path-audit-0810.md. Venmo's internal
 * `api.venmo.com` JSON API rejects a synthetic, per-run `device-id` sent
 * over raw HTTP with a hardcoded User-Agent — a documented, multi-year
 * device/session-trust anti-automation gate (github.com/mmohades/Venmo
 * issue #86). The fix is architectural, not a retry: authenticate through
 * a real, owner-driven browser session (same pattern as `reddit`/`amazon`)
 * and read the same JSON endpoints through `page.evaluate(fetch)` under
 * that session's real cookies — no synthetic device identity, no spoofed
 * User-Agent, full Patchright stealth inherited for free.
 *
 * Flow:
 *   1. Probe — page-context fetch to `/account` with `credentials:
 *      "include"`; a 2xx with a `user.id` means the session is live.
 *   2. If dead and `VENMO_USERNAME`/`VENMO_PASSWORD` are set, drive
 *      venmo.com's own sign-in form (assists login only; never a
 *      substitute for it — the owner may still see a device-approval or
 *      SMS/2FA prompt Venmo serves to its own web app).
 *   3. If dead and no credentials are set, hand the page to the owner via
 *      `manual_action` and re-probe once they respond.
 *   4. OTP: Venmo's web sign-in renders its own 6-digit code input when it
 *      wants SMS/email verification; surfaced via `sendInteraction`, same
 *      shape as reddit/amazon's OTP handoff.
 */

import type { BrowserContext, Locator, Page } from "playwright";
import { manualAction } from "../browser-handoff.ts";
import type { InteractionRequest, InteractionResponse, SessionCheckpointFn } from "../connector-runtime.ts";
import type { CaptureSession } from "../fixture-capture.ts";

const LOGIN_URL = "https://venmo.com/login";
const ACCOUNT_PROBE_URL = "https://venmo.com/account";
const USERNAME_SELECTOR = 'input[name="phoneEmailUsername"], input#username, input[autocomplete="username"]';
const PASSWORD_SELECTOR = 'input[name="password"], input#password, input[type="password"]';
const OTP_SELECTOR =
  'input[name="otp"], input[name="code"], input[autocomplete="one-time-code"], input[name="smsCode"]';
const SUBMIT_BUTTON_NAME_RE = /^(log in|sign in|continue|next)$/i;
const OTP_PROMPT_TEXT_RE = /verification code|enter the code|we (?:sent|texted)|2-step|two-factor/i;
const MANUAL_LOGIN_WITHOUT_CREDENTIALS_MESSAGE =
  "No optional Venmo sign-in details were provided. Sign in to Venmo in the secure browser, then respond success.";

const noopCheckpoint: SessionCheckpointFn = () => Promise.resolve();

interface EnsureVenmoSessionArgs {
  capture?: CaptureSession | null;
  checkpoint?: SessionCheckpointFn;
  context: BrowserContext;
  page: Page;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

export interface VenmoAccountProbeResult {
  live: boolean;
  ownerId: string | null;
}

/**
 * Page-context probe: fetch `/account` under the real session cookie
 * (`credentials: "include"`, no Authorization header, no device-id, no
 * spoofed User-Agent). A 2xx body carrying `data.user.id` proves the
 * session is live and gives the owner id for free — the same call
 * `fetchProfile`/`collectProfile` will make once collection starts.
 */
export async function probeVenmoAccount(page: Page): Promise<VenmoAccountProbeResult> {
  return await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
      if (res.status < 200 || res.status >= 300) {
        return { live: false, ownerId: null };
      }
      const body = (await res.json().catch(() => null)) as { data?: { user?: { id?: string } } } | null;
      const ownerId = body?.data?.user?.id ?? null;
      return { live: Boolean(ownerId), ownerId };
    } catch {
      return { live: false, ownerId: null };
    }
  }, ACCOUNT_PROBE_URL);
}

async function locatorIsVisible(locator: Locator): Promise<boolean> {
  return await locator
    .first()
    .isVisible({ timeout: 1000 })
    .catch((): boolean => false);
}

async function clickVenmoLoginSubmit(page: Page): Promise<boolean> {
  const semantic = page.getByRole("button", { name: SUBMIT_BUTTON_NAME_RE }).first();
  if (await locatorIsVisible(semantic)) {
    await semantic.click();
    return true;
  }
  const fallback = page.locator('button[type="submit"]').first();
  if (await locatorIsVisible(fallback)) {
    await fallback.click();
    return true;
  }
  return false;
}

async function captureLoginState(capture: CaptureSession | null | undefined, page: Page, label: string): Promise<void> {
  if (!capture) {
    return;
  }
  await capture.captureDom(page, label).catch((): undefined => undefined);
}

async function waitForManualLogin({
  capture,
  message,
  page,
  sendInteraction,
}: Pick<EnsureVenmoSessionArgs, "capture" | "page" | "sendInteraction"> & {
  readonly message: string;
}): Promise<VenmoAccountProbeResult> {
  await manualAction(
    {
      ...(capture ? { capture } : {}),
      page,
      reason: "login",
      message,
      timeoutSeconds: 1800,
    },
    sendInteraction
  );
  await page.waitForTimeout(2000);
  return await probeVenmoAccount(page);
}

async function ensureManualSessionWithoutCredentials({
  capture,
  checkpoint,
  page,
  sendInteraction,
}: Pick<EnsureVenmoSessionArgs, "capture" | "page" | "sendInteraction"> & {
  checkpoint: SessionCheckpointFn;
}): Promise<VenmoAccountProbeResult> {
  await checkpoint("venmo-signin-manual-required");
  const result = await waitForManualLogin({
    ...(capture ? { capture } : {}),
    message: MANUAL_LOGIN_WITHOUT_CREDENTIALS_MESSAGE,
    page,
    sendInteraction,
  });
  if (result.live) {
    return result;
  }
  throw new Error("venmo_login_manual_incomplete");
}

async function requestManualLoginForChallenge({
  capture,
  page,
  reason,
  sendInteraction,
}: Pick<EnsureVenmoSessionArgs, "capture" | "page" | "sendInteraction"> & {
  readonly reason: string;
}): Promise<VenmoAccountProbeResult> {
  return await waitForManualLogin({
    ...(capture ? { capture } : {}),
    message: `Venmo did not render the expected sign-in form (${reason}). Complete sign-in — including any device approval, CAPTCHA, or verification step — in the secure browser, then respond success.`,
    page,
    sendInteraction,
  });
}

type ManualHandoff = Pick<EnsureVenmoSessionArgs, "capture" | "page" | "sendInteraction">;

/**
 * Fill the password field, handling Venmo's split username-then-password
 * sign-in variant: if no password field is visible yet, submit once to
 * advance past the username-only screen and look again. Returns a manual
 * handoff result when neither attempt finds a password field, or `null`
 * when the password was filled and the caller should continue.
 */
async function fillVenmoPassword(args: ManualHandoff & { password: string }): Promise<VenmoAccountProbeResult | null> {
  const { capture, page, password, sendInteraction } = args;
  const passwordIn = page.locator(PASSWORD_SELECTOR).first();
  if (await locatorIsVisible(passwordIn)) {
    await passwordIn.fill(password);
    return null;
  }
  // Some Venmo sign-in variants split username/password across two
  // screens (continue, then password). Submit once to advance, then
  // fill password on the next screen if it appears.
  await clickVenmoLoginSubmit(page);
  await page.waitForTimeout(1500);
  const passwordIn2 = page.locator(PASSWORD_SELECTOR).first();
  if (!(await locatorIsVisible(passwordIn2))) {
    return await requestManualLoginForChallenge({
      ...(capture ? { capture } : {}),
      page,
      reason: "password field did not render",
      sendInteraction,
    });
  }
  await passwordIn2.fill(password);
  return null;
}

/**
 * Handle Venmo's post-submit verification step, if one rendered. Matches on
 * either a known OTP input shape or the page's own prompt copy — never
 * guesses a code the owner never saw. Returns `null` when no verification
 * step was detected (the caller proceeds to the final session probe).
 */
async function handleVenmoOtpIfPresent(args: ManualHandoff): Promise<VenmoAccountProbeResult | null> {
  const { capture, page, sendInteraction } = args;
  const otpIn = page.locator(OTP_SELECTOR).first();
  const bodyText = (
    await page
      .locator("body")
      .innerText()
      .catch((): string => "")
  ).slice(0, 1000);
  if (!((await locatorIsVisible(otpIn)) || OTP_PROMPT_TEXT_RE.test(bodyText))) {
    return null;
  }
  await captureLoginState(capture, page, "venmo-otp-detected");
  if (!(await locatorIsVisible(otpIn))) {
    // Prompt text matched but no known input shape — hand off rather
    // than guess a selector for a UI we can't confirm.
    return await requestManualLoginForChallenge({
      ...(capture ? { capture } : {}),
      page,
      reason: "verification step did not match a known input",
      sendInteraction,
    });
  }
  const resp = await sendInteraction({
    kind: "otp",
    message: "Venmo requires a verification code. Enter the code sent to your phone or email:",
    schema: {
      type: "object",
      properties: { code: { type: "string", pattern: "^\\d{4,8}$" } },
      required: ["code"],
    },
    timeout_seconds: 300,
  });
  const code = resp.data?.code ?? resp.value ?? null;
  if (!code) {
    const probed = await probeVenmoAccount(page);
    if (probed.live) {
      return probed;
    }
    throw new Error("venmo_otp_cancelled");
  }
  await otpIn.fill(code);
  await clickVenmoLoginSubmit(page).catch((): boolean => false);
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);
  await captureLoginState(capture, page, "venmo-otp-after-submit");
  return null;
}

/**
 * Drive Venmo's own web sign-in form with the owner's saved credentials.
 * This assists login only — every branch that hits an unexpected UI (no
 * username field, no OTP match against the copy Venmo actually renders)
 * hands off to the owner rather than guessing further, exactly like
 * amazon.ts/reddit.ts.
 */
async function loginWithSavedCredentials({
  capture,
  checkpoint,
  page,
  sendInteraction,
  username,
  password,
}: Pick<EnsureVenmoSessionArgs, "capture" | "page" | "sendInteraction"> & {
  checkpoint: SessionCheckpointFn;
  password: string;
  username: string;
}): Promise<VenmoAccountProbeResult> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((): undefined => undefined);
  await captureLoginState(capture, page, "venmo-login-page");
  await checkpoint("venmo-signin-loaded");

  const userIn = page.locator(USERNAME_SELECTOR).first();
  const usernameAppeared = await userIn
    .waitFor({ state: "attached", timeout: 10_000 })
    .then((): true => true)
    .catch((): false => false);
  if (!usernameAppeared) {
    return await requestManualLoginForChallenge({
      ...(capture ? { capture } : {}),
      page,
      reason: "sign-in form did not render",
      sendInteraction,
    });
  }
  await userIn.fill(username);

  const passwordHandoff = await fillVenmoPassword({ ...(capture ? { capture } : {}), page, password, sendInteraction });
  if (passwordHandoff) {
    return passwordHandoff;
  }

  await captureLoginState(capture, page, "venmo-login-before-submit");
  await checkpoint("venmo-password-submit");
  if (!(await clickVenmoLoginSubmit(page))) {
    await captureLoginState(capture, page, "venmo-login-submit-missing");
    throw new Error("venmo_login_submit_missing");
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);
  await captureLoginState(capture, page, "venmo-login-after-submit");
  await checkpoint("venmo-2fa-decision");

  const otpHandoff = await handleVenmoOtpIfPresent({ ...(capture ? { capture } : {}), page, sendInteraction });
  if (otpHandoff) {
    return otpHandoff;
  }

  await checkpoint("venmo-final-verify");
  const finalProbe = await probeVenmoAccount(page);
  if (finalProbe.live) {
    return finalProbe;
  }
  return await requestManualLoginForChallenge({
    ...(capture ? { capture } : {}),
    page,
    reason: "automated sign-in did not complete",
    sendInteraction,
  });
}

/**
 * Resolve a live Venmo browser session. Returns the probed owner id so the
 * caller does not need a second `/account` round trip.
 */
export async function ensureVenmoSession({
  capture,
  checkpoint = noopCheckpoint,
  page,
  sendInteraction,
}: Omit<EnsureVenmoSessionArgs, "context">): Promise<VenmoAccountProbeResult> {
  await checkpoint("venmo-auth-probe");
  const initial = await probeVenmoAccount(page);
  if (initial.live) {
    await checkpoint("venmo-session-already-live");
    return initial;
  }

  const username = process.env.VENMO_USERNAME;
  const password = process.env.VENMO_PASSWORD;
  if (!(username && password)) {
    return await ensureManualSessionWithoutCredentials({
      ...(capture ? { capture } : {}),
      checkpoint,
      page,
      sendInteraction,
    });
  }

  const result = await loginWithSavedCredentials({
    ...(capture ? { capture } : {}),
    checkpoint,
    page,
    sendInteraction,
    username,
    password,
  });
  if (result.live) {
    return result;
  }
  throw new Error("venmo_login_incomplete_after_submit");
}
