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
 *   2. If dead and setup-supplied credentials are available, drive
 *      venmo.com's own sign-in form (assists login only; never a
 *      substitute for it — the owner may still see a device-approval or
 *      SMS/2FA prompt Venmo serves to its own web app).
 *   3. If dead and no credentials are set, hand the page to the owner via
 *      `manual_action` and re-probe once they respond.
 *   4. OTP: Venmo's web sign-in renders its own 6-digit code input when it
 *      wants SMS/email verification; surfaced via `sendInteraction`, same
 *      shape as reddit/amazon's OTP handoff.
 */

import { redactTransportDetail } from "@pdpp/collector-runtime/http-retry";
import type { Page } from "playwright";
import { manualBrowserLogin } from "../browser-handoff.ts";
import type { InteractionRequest, InteractionResponse, SessionCheckpointFn } from "../connector-runtime.ts";
import type { CaptureSession, LocatorProbe } from "../fixture-capture.ts";
import { locatorIsVisible } from "./locator-helpers.ts";

/** Same bound `index.ts`'s `errorDetail` applies after redaction — keeps one link short and legible without truncating mid-token. */
const PROBE_TRANSPORT_DETAIL_MAX = 200;

const HOME_URL = "https://venmo.com/";
const LOGIN_URL = "https://venmo.com/login";
const ACCOUNT_PROBE_URL = "https://venmo.com/account";
const VENMO_ORIGIN = "https://venmo.com";
const USERNAME_SELECTOR = 'input[name="phoneEmailUsername"], input#username, input[autocomplete="username"]';
const PASSWORD_SELECTOR = 'input[name="password"], input#password, input[type="password"]';
const OTP_SELECTOR =
  'input[name="otp"], input[name="code"], input[autocomplete="one-time-code"], input[name="smsCode"]';
const SUBMIT_BUTTON_NAME_RE = /^(log in|sign in|continue|next)$/i;
const OTP_PROMPT_TEXT_RE = /verification code|enter the code|we (?:sent|texted)|2-step|two-factor/i;
const MANUAL_LOGIN_WITHOUT_CREDENTIALS_MESSAGE =
  "No optional Venmo sign-in details were provided. Sign in to Venmo in the secure browser, then respond success.";

const LOGIN_LOCATOR_PROBES: LocatorProbe[] = [
  {
    id: "username",
    kind: "css",
    selector: USERNAME_SELECTOR,
    description: "Venmo username/phone/email field candidates used by the connector.",
  },
  {
    id: "password",
    kind: "css",
    selector: PASSWORD_SELECTOR,
    description: "Venmo password field candidates used by the connector.",
  },
  {
    id: "submit-role",
    kind: "role",
    role: "button",
    namePattern: SUBMIT_BUTTON_NAME_RE.source,
    nameFlags: "i",
    description: "Semantic log in/continue/next button candidate.",
  },
  {
    id: "otp",
    kind: "css",
    selector: OTP_SELECTOR,
    description: "OTP candidates; hidden fields must not trigger an OTP interaction.",
  },
];

/**
 * Ensure `page` is on the `venmo.com` origin before a credentialed
 * page-context fetch: `api.venmo.com`'s CORS allowlist grants
 * `credentials:"include"` only to `Access-Control-Allow-Origin:
 * https://venmo.com` (confirmed live 2026-08-10, /tmp/review-venmo-
 * browser-redesign-0810.md §1). `about:blank` has an opaque origin and
 * hard-fails the same fetch with `TypeError: Failed to fetch` — not a
 * session signal, a transport precondition. Every sibling browser
 * connector navigates before its first credentialed fetch
 * (reddit.ts:100, amazon.ts:90); this was the one that didn't.
 */
export async function ensureVenmoOrigin(page: Page): Promise<void> {
  let currentOrigin: string | null = null;
  try {
    currentOrigin = new URL(page.url()).origin;
  } catch {
    currentOrigin = null;
  }
  if (currentOrigin === VENMO_ORIGIN) {
    return;
  }
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((): undefined => undefined);
}

const noopCheckpoint: SessionCheckpointFn = () => Promise.resolve();

interface EnsureVenmoSessionArgs {
  capture?: CaptureSession | null;
  checkpoint?: SessionCheckpointFn;
  credentials?: Readonly<Record<string, string>>;
  onCredentialSubmit?: () => void;
  page: Page;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

export interface VenmoAccountProbeResult {
  live: boolean;
  ownerId: string | null;
}

/**
 * Which side of an automated credential submission a probe runs on — see
 * {@link probeVenmoAccount}'s "B4" doc for why this determines the thrown
 * error's NAME (and therefore its retryability), not just its message.
 */
export type VenmoProbePhase = "post_submit" | "pre_submit";

/**
 * Page-context probe: fetch `/account` under the real session cookie
 * (`credentials: "include"`, no Authorization header, no device-id, no
 * spoofed User-Agent). A 2xx body carrying `data.user.id` proves the
 * session is live and gives the owner id for free — the same call
 * `fetchProfile`/`collectProfile` will make once collection starts.
 *
 * Navigates to `venmo.com` first when not already there: the page starts
 * on `about:blank` (opaque origin) on a fresh run, and `api.venmo.com`'s
 * CORS allowlist only grants a credentialed fetch from `https://venmo.com`
 * — see {@link ensureVenmoOrigin}. A probe that skipped this would read
 * every live session as dead and never actually test session state.
 *
 * `phase` (default `"pre_submit"`) governs the NAME of a transport-fault
 * throw, not just its text — see the "B4" note above `throw` below.
 */
export async function probeVenmoAccount(
  page: Page,
  phase: VenmoProbePhase = "pre_submit"
): Promise<VenmoAccountProbeResult> {
  await ensureVenmoOrigin(page);
  let outcome: { kind: "dead" } | { kind: "live"; ownerId: string } | { kind: "transport_error"; message: string };
  try {
    outcome = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
        if (res.status < 200 || res.status >= 300) {
          return { kind: "dead" as const };
        }
        const body = (await res.json().catch(() => null)) as { data?: { user?: { id?: string } } } | null;
        const ownerId = body?.data?.user?.id ?? null;
        return ownerId ? { kind: "live" as const, ownerId } : { kind: "dead" as const };
      } catch (err) {
        return { kind: "transport_error" as const, message: err instanceof Error ? err.message : String(err) };
      }
    }, ACCOUNT_PROBE_URL);
  } catch (err) {
    // `page.evaluate` itself rejected — the execution context was destroyed
    // (navigation raced the probe) or the page/browser crashed. Same
    // "could not run at all" classification as a fetch throwing inside the
    // callback: a transport fault, not proof the session is dead.
    outcome = { kind: "transport_error", message: err instanceof Error ? err.message : String(err) };
  }
  if (outcome.kind === "transport_error") {
    const detail = redactTransportDetail(outcome.message).slice(0, PROBE_TRANSPORT_DETAIL_MAX);
    // B4: a transport blip has NO cost to retry before a password was ever
    // typed (`pre_submit` — nothing has been sent to Venmo yet), but the SAME
    // fault immediately after `loginWithSavedCredentials` submits the saved
    // password (`post_submit` — this probe is verifying that submission's
    // outcome) is a different risk entirely: this repo's own
    // `venmo_.*transport_error` wildcard classified BOTH names as retryable,
    // so a transient network blip landing on the post-submit probe alone
    // (session establishment already succeeded) would terminal the run
    // retryable, and a runtime-level retry re-enters ensureVenmoSession from
    // scratch — re-submitting the SAME saved password against Venmo's own
    // login form on every retry, with no run-scoped budget (unlike usaa's
    // sessionRepairAttempted) to stop it. Venmo's own anti-automation gate
    // (this file's header) makes repeated automated logins against one real
    // account exactly the kind of signal that risks a lockout. Naming this
    // throw distinctly (`venmo_post_submit_probe_transport_error`, deliberately
    // NOT matching connectors/venmo/index.ts's retryablePattern) makes the
    // runtime terminal this run permanently instead of retrying it — losing
    // one run's-worth of collection is the safe failure mode, not repeatedly
    // re-submitting a real password.
    const name = phase === "post_submit" ? "venmo_post_submit_probe_transport_error" : "venmo_probe_transport_error";
    throw new Error(`${name}: ${detail}`);
  }
  return outcome.kind === "live" ? { live: true, ownerId: outcome.ownerId } : { live: false, ownerId: null };
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
  await capture.captureLocatorProbe?.(page, label, LOGIN_LOCATOR_PROBES).catch((): undefined => undefined);
}

/**
 * Hand the page to the owner, navigating to the real sign-in page first so
 * the handoff shows a Venmo sign-in screen rather than `about:blank` — the
 * page at handoff time has no `preservePageOnSuccess`/`preservePageOnFailure`
 * guarantee and may still be on its initial blank state (F2 in
 * /tmp/review-venmo-browser-redesign-0810.md). Re-probes via
 * `probeVenmoAccount`, whose own origin guard covers wherever the owner's
 * sign-in actually lands.
 *
 * `phase` (default `"pre_submit"`) passes straight through to that re-probe
 * — see {@link probeVenmoAccount}'s B4 doc. Every caller of this function
 * that hands off AFTER `loginWithSavedCredentials` has already submitted the
 * saved password must pass `"post_submit"` explicitly.
 */
async function waitForManualLogin({
  capture,
  message,
  page,
  phase = "pre_submit",
  reason,
  sendInteraction,
}: Pick<EnsureVenmoSessionArgs, "capture" | "page" | "sendInteraction"> & {
  readonly message: string;
  readonly phase?: VenmoProbePhase;
  readonly reason?: "captcha";
}): Promise<VenmoAccountProbeResult> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((): undefined => undefined);
  return await manualBrowserLogin({
    ...(capture ? { capture } : {}),
    message,
    page,
    probe: () => probeVenmoAccount(page, phase),
    ...(reason ? { reason } : {}),
    sendInteraction,
    timeoutSeconds: 1800,
  });
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
  // pre_submit (default): no credentials are saved at all, so no password
  // has ever been typed anywhere in this call graph.
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
  phase = "pre_submit",
  reason,
  sendInteraction,
}: Pick<EnsureVenmoSessionArgs, "capture" | "page" | "sendInteraction"> & {
  readonly phase?: VenmoProbePhase;
  readonly reason: string;
}): Promise<VenmoAccountProbeResult> {
  return await waitForManualLogin({
    ...(capture ? { capture } : {}),
    message: `Venmo did not render the expected sign-in form (${reason}). Complete sign-in — including any device approval, CAPTCHA, or verification step — in the secure browser, then respond success.`,
    page,
    phase,
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
 *
 * Only ever called from `loginWithSavedCredentials` AFTER the saved password
 * was already submitted — every probe in this function is `"post_submit"`
 * (see {@link probeVenmoAccount}'s B4 doc).
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
      phase: "post_submit",
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
    const probed = await probeVenmoAccount(page, "post_submit");
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
  onCredentialSubmit,
  page,
  sendInteraction,
  username,
  password,
}: Pick<EnsureVenmoSessionArgs, "capture" | "page" | "sendInteraction"> & {
  checkpoint: SessionCheckpointFn;
  onCredentialSubmit?: () => void;
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
  onCredentialSubmit?.();
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);
  await captureLoginState(capture, page, "venmo-login-after-submit");
  await checkpoint("venmo-2fa-decision");

  const otpHandoff = await handleVenmoOtpIfPresent({ ...(capture ? { capture } : {}), page, sendInteraction });
  if (otpHandoff) {
    return otpHandoff;
  }

  await checkpoint("venmo-final-verify");
  // post_submit: this is the direct outcome check for the password submit
  // above — see probeVenmoAccount's B4 doc for why a transport fault here
  // must not be classified the same as a fault that happened before any
  // password was ever typed.
  const finalProbe = await probeVenmoAccount(page, "post_submit");
  if (finalProbe.live) {
    return finalProbe;
  }
  return await requestManualLoginForChallenge({
    ...(capture ? { capture } : {}),
    page,
    phase: "post_submit",
    reason: "automated sign-in did not complete",
    sendInteraction,
  });
}

/** Resolve a live Venmo browser session, or throw if establishment fails. */
export async function ensureVenmoSession({
  capture,
  checkpoint = noopCheckpoint,
  credentials = {},
  onCredentialSubmit,
  page,
  sendInteraction,
}: EnsureVenmoSessionArgs): Promise<VenmoAccountProbeResult> {
  await checkpoint("venmo-auth-probe");
  const initial = await probeVenmoAccount(page);
  if (initial.live) {
    await checkpoint("venmo-session-already-live");
    return initial;
  }

  const username = credentials.VENMO_USERNAME;
  const password = credentials.VENMO_PASSWORD;
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
    ...(onCredentialSubmit ? { onCredentialSubmit } : {}),
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
