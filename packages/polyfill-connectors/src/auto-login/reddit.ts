// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reddit automated session management.
 *
 * Reddit killed the OAuth script-app password grant in 2024, so the only
 * durable path for personal data collection is a cookie-authenticated
 * browser session. We keep the session in the shared persistent profile and
 * surface the read-only `reddit_session` cookie to old.reddit.com JSON
 * endpoints — effectively "what a logged-in user sees," no API key needed.
 *
 * Env: REDDIT_USERNAME / REDDIT_PASSWORD. Reddit often serves a 2FA code
 * input (OTP app or SMS) on first login from a new profile; we surface that
 * via INTERACTION so the operator can supply the 6-digit code (ntfy → phone
 * or file drop). Persistent session.
 *
 * Anti-bot: Reddit shows a Cloudflare challenge for residential IPs in the
 * default profile; if we can't reach login inputs we fall back to a
 * manual_action INTERACTION rather than banging on the form.
 */

import type { BrowserContext, Page } from "playwright";
import { DEADLINE_TIMEOUT, manualBrowserLogin, withDeadline } from "../browser-handoff.ts";
import type { InteractionRequest, InteractionResponse, SessionCheckpointFn } from "../connector-runtime.ts";
import type { CaptureSession, LocatorProbe } from "../fixture-capture.ts";
import { detectCloudflareChallenge } from "../platform-probes.ts";
import { locatorIsVisible } from "./locator-helpers.ts";

const LOGIN_URL = "https://www.reddit.com/login/";
const HOME_URL = "https://www.reddit.com/";
const SESSION_COOKIE_NAME = "reddit_session";
const USERNAME_SELECTOR = 'input[name="username"], input#loginUsername';
const PASSWORD_SELECTOR = 'input[name="password"], input#loginPassword';
const SUBMIT_SELECTOR = 'button[type="submit"]:has-text("Log In"), button[type="submit"]:has-text("Continue")';
const OTP_SELECTOR = 'input[name="otp"], input[name="verification_code"], input[autocomplete="one-time-code"]';
const SUBMIT_BUTTON_NAME_RE = /^(log in|continue)$/i;
const MANUAL_LOGIN_WITHOUT_CREDENTIALS_MESSAGE =
  "No optional Reddit sign-in details were provided. Sign in to Reddit in the secure browser, then respond success.";

const LOGIN_LOCATOR_PROBES: LocatorProbe[] = [
  {
    id: "username",
    kind: "css",
    selector: USERNAME_SELECTOR,
    description: "Reddit username field candidates used by the connector.",
  },
  {
    id: "password",
    kind: "css",
    selector: PASSWORD_SELECTOR,
    description: "Reddit password field candidates used by the connector.",
  },
  {
    id: "submit-role",
    kind: "role",
    role: "button",
    namePattern: "^(log in|continue)$",
    nameFlags: "i",
    description: "Semantic login/continue button candidate.",
  },
  {
    id: "submit-css",
    kind: "css",
    selector: SUBMIT_SELECTOR,
    description: "Fallback CSS submit candidate.",
  },
  {
    id: "otp",
    kind: "css",
    selector: OTP_SELECTOR,
    description: "OTP candidates; hidden fields must not trigger an OTP interaction.",
  },
];

type SendInteraction = (req: InteractionRequest) => Promise<InteractionResponse>;

interface ManualHandoffProbeRetryOptions {
  pollIntervalMs?: number;
  retryForMs?: number;
}

interface EnsureRedditSessionArgs {
  capture?: CaptureSession | null;
  /**
   * Mark a session-establishment phase so the runtime watchdog's no-progress
   * message names WHERE establishment stalled. Optional (matching heb.ts's
   * shape) so the many internal/test callers that don't checkpoint keep
   * working; the production hook (`connectors/reddit/index.ts`'s
   * `redditEnsureSession`) forwards the runtime's real one.
   *
   * Production `run_1787109028586` is why this exists: the run hung 120s
   * inside the first liveness probe with `session-establish:begin` — the
   * RUNTIME's own framing checkpoint — as the last marker, so the failure
   * named the whole window rather than the probe that actually stalled.
   */
  checkpoint?: SessionCheckpointFn;
  context: BrowserContext;
  /**
   * Test seam for the manual-handoff post-interaction re-probe window (see
   * `isSessionLiveWithRetry`). Defaults to the production window
   * (`MANUAL_HANDOFF_PROBE_RETRY_MS` / `MANUAL_HANDOFF_PROBE_POLL_INTERVAL_MS`);
   * tests that deliberately exercise the "never becomes live" throw path
   * override this so the assertion doesn't burn the real retry window.
   */
  manualHandoffProbeRetry?: ManualHandoffProbeRetryOptions;
  /**
   * Runtime marker for the post-submit credential-safety invariant: fired at
   * the exact click that sends the saved password to Reddit's real sign-in
   * form (see `EnsureSessionArgs.onCredentialSubmit`). Never fired on the
   * session-reuse early return, the manual hand-off paths, or the OTP
   * resubmit — those never send the saved password.
   */
  onCredentialSubmit?: () => void;
  page: Page;
  sendInteraction: SendInteraction;
  /**
   * Test seam for the per-probe bounds (see {@link SessionProbeOptions}).
   * Production passes nothing and gets the real bounds; tests that prove the
   * hang path shrink `evaluateTimeoutMs` so the assertion doesn't have to
   * spend the production bound in real wall-clock.
   */
  sessionProbe?: SessionProbeOptions;
}

function otpCode(resp: InteractionResponse): string | null {
  return resp.data?.code ?? resp.value ?? null;
}

async function hasSessionCookie(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies(HOME_URL);
  return cookies.some((c) => c.name === SESSION_COOKIE_NAME && Boolean(c.value));
}

/**
 * Per-probe bounds for the owner-only JSON liveness check.
 *
 * TWO layers, because they fail independently and neither subsumes the other:
 *
 *  - `SESSION_PROBE_FETCH_TIMEOUT_MS` aborts the in-page `fetch` itself. It
 *    covers the common case — Reddit accepts the TCP connection and then
 *    never answers (throttle/tarpit, which is exactly what repeated failed
 *    logins from one IP earn). A `fetch` with no signal has NO default
 *    timeout, and the `try/catch` around it cannot help: a hang is not a
 *    rejection, so the callback simply never returns.
 *  - `SESSION_PROBE_EVALUATE_TIMEOUT_MS` bounds the `page.evaluate` call
 *    itself, which also has no Playwright default timeout. The inner abort
 *    is worthless if the page's JS context is wedged (busy loop, crashed
 *    renderer, execution context destroyed mid-navigation) — the callback
 *    never runs at all, so nothing is there to abort. Slightly longer than
 *    the inner bound so a healthy page reports its own abort as a clean
 *    `status: 0` rather than racing the outer deadline.
 *
 * Production `run_1787109028586` is what these fix: `ensureRedditSession`
 * entered this probe and the run emitted no progress for 120s until the
 * runtime watchdog killed it (`reddit_session_establish_timeout ... last
 * checkpoint: session-establish:begin`).
 */
const SESSION_PROBE_FETCH_TIMEOUT_MS = 8000;
const SESSION_PROBE_EVALUATE_TIMEOUT_MS = 12_000;

/**
 * The JSON host every in-page `fetch` must be issued to, and — because Reddit
 * grants no cross-origin access to it — the origin the page must already be on
 * when it issues that fetch.
 *
 * `old.reddit.com` and `www.reddit.com` serve the SAME listing JSON, but they
 * are different origins, and neither answers a credentialed cross-origin
 * request: as of 2026-08-19 a request to either host carrying
 * `Origin: https://www.reddit.com` comes back with NO
 * `Access-Control-Allow-Origin` header at all. CORS forbids a wildcard once
 * credentials are sent, so there is no header Reddit could send that would
 * make the cross-origin form work either.
 *
 * That is production `run_1787164349370`. The owner was genuinely signed in as
 * confirmed over CDP, the page sat on `https://www.reddit.com/`, and the probe
 * fetched `https://old.reddit.com/user/{u}/saved.json`. Read from that page,
 * the two calls disagreed completely:
 *
 *   fetch('https://www.reddit.com/user/{u}/saved.json') -> 200
 *   fetch('https://old.reddit.com/user/{u}/saved.json') -> TypeError: Failed to fetch
 *
 * The browser blocks the second before it reaches the network, and a blocked
 * fetch surfaces to page JS as exactly `TypeError: Failed to fetch` — which
 * the probe's `catch` mapped to `status: 0`, i.e. "not live". So a working
 * session read as dead, every run threw `reddit_login_unexpected_ui`, and five
 * of six streams collected nothing from 2026-06-02 onward while Reddit pruned
 * the listings past ~1000 items underneath.
 *
 * Switching the probe to `www.reddit.com` would have fixed THAT page, and only
 * by accident: it would break again the moment the page legitimately sits on
 * `old.reddit.com` (which `isSessionLive`'s own credential-less fallback
 * navigates to). The origin is the invariant, not the hostname — so the fix
 * establishes the origin rather than guessing which one the page is on. The
 * collect path in `connectors/reddit/index.ts` depends on this same origin
 * holding for its own `redditFetch`.
 */
export const REDDIT_JSON_ORIGIN = "https://old.reddit.com";

/**
 * Put the page on {@link REDDIT_JSON_ORIGIN} so a credentialed same-origin
 * `fetch` is possible at all, and report whether that succeeded.
 *
 * Returns `false` rather than throwing: a probe that cannot establish its
 * origin has not proven the session is dead, only that it could not ask. Every
 * caller already treats `false` as "could not determine live" and proceeds to
 * login, which is the correct action either way.
 *
 * Bounded like every other step in this probe — `goto` carries an explicit
 * timeout, so this cannot reintroduce an unbounded await.
 */
export async function ensureRedditJsonOrigin(page: Page): Promise<boolean> {
  try {
    if (new URL(page.url()).origin === REDDIT_JSON_ORIGIN) {
      return true;
    }
  } catch {
    // An unnavigated page (`about:blank`) has no parseable origin — fall
    // through and navigate rather than treating it as a fault.
  }
  try {
    await page.goto(`${REDDIT_JSON_ORIGIN}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch {
    return false;
  }
  try {
    return new URL(page.url()).origin === REDDIT_JSON_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Options for a single liveness probe.
 *
 * `evaluateTimeoutMs` is a test seam of the same kind as
 * `EnsureRedditSessionArgs.manualHandoffProbeRetry`: the bound must be REAL
 * wall-clock in production, so a test that wants to prove "a hang resolves to
 * false" would otherwise have to actually wait the production bound. Tests
 * shrink it instead of sleeping; nothing in production passes it.
 */
export interface SessionProbeOptions {
  readonly evaluateTimeoutMs?: number;
  /**
   * Fired when a probe could not answer within its bound — never fired for a
   * probe that ran and reported a dead session. Keeps "Reddit stopped
   * answering" distinguishable from "you are logged out" in diagnostics, even
   * though both produce the same `false` verdict and the same next action.
   */
  readonly onProbeTimeout?: (stage: string) => void;
}

/**
 * Confirm the session cookie actually grants access — a stale cookie may
 * still exist after logout. Prefer an owner-only JSON endpoint
 * (`/user/{username}/saved.json`) over a DOM guess: it's exactly the data the
 * connector needs downstream anyway, so a 200 there is ground truth rather
 * than a heuristic, and it survives old.reddit.com markup changes that broke
 * a prior logout-link selector check even while a real session was live.
 * Falls back to the logout-link probe when no username is known yet (the
 * credential-less manual hand-off, which runs before any account is chosen).
 *
 * NEVER hangs and NEVER throws: every failure mode — dead session, transport
 * fault, aborted fetch, wedged page context — resolves to a boolean. A probe
 * that could not answer within its bound reports `false` ("I could not
 * determine this session is live"), which is the same ACTIONABLE state as
 * "not live": proceed to login. `onProbeTimeout` exists so that equivalence
 * does not erase the distinction in DIAGNOSTICS — a tarpit and a genuinely
 * logged-out session must not look identical to whoever reads the run later.
 */
export async function isSessionLive(page: Page, options: SessionProbeOptions = {}): Promise<boolean> {
  const { evaluateTimeoutMs = SESSION_PROBE_EVALUATE_TIMEOUT_MS, onProbeTimeout } = options;
  const username = process.env.REDDIT_USERNAME;
  if (username) {
    // The fetch below is same-origin ONLY because of this: Reddit grants no
    // cross-origin access to its JSON, so a probe issued from the wrong origin
    // is blocked by the browser and reads as a dead session no matter how live
    // the session is. See REDDIT_JSON_ORIGIN.
    if (!(await ensureRedditJsonOrigin(page))) {
      // Could not even ask — nameable in diagnostics as its own stage rather
      // than collapsing into the same silent `false` as a logged-out session.
      onProbeTimeout?.("origin");
      return false;
    }
    try {
      const result = await withDeadline(
        page.evaluate(
          async ({ origin, path, fetchTimeoutMs }) => {
            try {
              const res = await fetch(`${origin}${path}`, {
                credentials: "include",
                headers: { accept: "application/json" },
                signal: AbortSignal.timeout(fetchTimeoutMs),
              });
              return { status: res.status };
            } catch {
              // Includes the abort: an unanswered request is reported as
              // status 0, i.e. "not live", never as a hang.
              return { status: 0 };
            }
          },
          {
            fetchTimeoutMs: SESSION_PROBE_FETCH_TIMEOUT_MS,
            origin: REDDIT_JSON_ORIGIN,
            path: `/user/${encodeURIComponent(username)}/saved.json`,
          }
        ) as Promise<{ status: number }>,
        evaluateTimeoutMs
      );
      if (result === DEADLINE_TIMEOUT) {
        // The page context never returned — distinct from a probe that ran
        // and reported a dead session. Same verdict, different diagnosis.
        onProbeTimeout?.("evaluate");
        return false;
      }
      return result.status === 200;
    } catch {
      return false;
    }
  }

  try {
    // Same origin requirement as the JSON probe above, for a different reason:
    // the logout link only exists in old.reddit.com's markup. Reuses the shared
    // guard so both paths agree on what "on the right origin" means.
    if (!(await ensureRedditJsonOrigin(page))) {
      onProbeTimeout?.("origin");
      return false;
    }
    // `count()` is a CDP round-trip with no default timeout of its own, so a
    // wedged renderer hangs it the same way the JSON probe above hung. The
    // `goto` timeout does not cover it — that bound is already spent by the
    // time this runs.
    const logout = await withDeadline(
      page.locator('a[href*="/logout"], form[action*="logout"]').count(),
      evaluateTimeoutMs
    );
    if (logout === DEADLINE_TIMEOUT) {
      onProbeTimeout?.("logout-locator");
      return false;
    }
    return logout > 0;
  } catch {
    return false;
  }
}

const MANUAL_HANDOFF_PROBE_RETRY_MS = 15_000;
const MANUAL_HANDOFF_PROBE_POLL_INTERVAL_MS = 3000;

/**
 * Re-probe liveness for a bounded window instead of trusting a single check
 * right after the owner's `manual_action` response resolves.
 *
 * The owner's "success" click only means they finished on their end — it is
 * not proof the post-captcha/post-login page has settled. Reddit still has
 * to run its own redirect/render pass after that click (the same class of
 * "second client-side render pass" the post-submit OTP fix in
 * `ensureRedditSession` already accounts for with a `waitFor`, not a
 * one-shot check). `isSessionLive`'s credential-less fallback additionally
 * does a real navigation (`page.goto("https://old.reddit.com/")`), which
 * itself takes time and can transiently fail immediately after a challenge
 * redirect. A single call here read that transient state as "not live" and
 * threw `reddit_login_unexpected_ui` ~300ms after the owner solved the
 * captcha, discarding a login that was already succeeding — see the
 * `run_1787090213822` production evidence this fixes.
 *
 * `retryForMs` bounds the LOOP, and that bound is only real because each
 * `isSessionLive` call is now itself bounded. The deadline is checked between
 * probes, so before `isSessionLive` grew its own timeouts a single hung probe
 * pinned this wrapper open forever and the 15s window here was decorative —
 * the wrapper is not what failed in `run_1787109028586`, but it would not
 * have saved the run either. Worst case is now roughly
 * `retryForMs + SESSION_PROBE_EVALUATE_TIMEOUT_MS` (one in-flight probe may
 * start just under the deadline and run its full bound), which is finite and
 * far under the runtime watchdog's no-progress window.
 */
export async function isSessionLiveWithRetry(
  page: Page,
  {
    evaluateTimeoutMs,
    onProbeTimeout,
    pollIntervalMs = MANUAL_HANDOFF_PROBE_POLL_INTERVAL_MS,
    retryForMs = MANUAL_HANDOFF_PROBE_RETRY_MS,
  }: SessionProbeOptions & { pollIntervalMs?: number; retryForMs?: number } = {}
): Promise<boolean> {
  const probeOptions: SessionProbeOptions = {
    ...(evaluateTimeoutMs === undefined ? {} : { evaluateTimeoutMs }),
    ...(onProbeTimeout === undefined ? {} : { onProbeTimeout }),
  };
  const deadline = Date.now() + retryForMs;
  for (;;) {
    if (await isSessionLive(page, probeOptions)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await page.waitForTimeout(pollIntervalMs);
  }
}

async function captureLoginState(capture: CaptureSession | null | undefined, page: Page, label: string): Promise<void> {
  if (!capture) {
    return;
  }
  await capture.captureDom(page, label).catch((): undefined => undefined);
  await capture.captureLocatorProbe?.(page, label, LOGIN_LOCATOR_PROBES).catch((): undefined => undefined);
}

async function clickRedditLoginSubmit(page: Page, onCredentialSubmit?: () => void): Promise<boolean> {
  const { getByRole } = page as Pick<Page, "getByRole">;
  if (typeof getByRole === "function") {
    const semantic = getByRole.call(page, "button", { name: SUBMIT_BUTTON_NAME_RE }).first();
    if (await locatorIsVisible(semantic)) {
      await semantic.click();
      onCredentialSubmit?.();
      return true;
    }
  }

  const fallback = page.locator(SUBMIT_SELECTOR).first();
  if (await locatorIsVisible(fallback)) {
    await fallback.click();
    onCredentialSubmit?.();
    return true;
  }
  return false;
}

function loginBlockedMessage(cfSignals: string[]): string {
  if (cfSignals.length > 0) {
    return `Cloudflare challenge confirmed (signals: ${cfSignals.join(", ")}). Complete the "Verify you are human" check on reddit.com in the browser window and re-run.`;
  }
  return "Reddit login page did not render expected inputs and no Cloudflare challenge was detected (the page may have changed). Log in to reddit.com in the browser window and re-run.";
}

/**
 * Assembles the manual-handoff args shared by `ensureRedditManualSession` and
 * `recoverRedditBlockedLogin`, keeping the optional-field spreads (needed for
 * `exactOptionalPropertyTypes`) out of `ensureRedditSession` itself — that
 * function's cognitive-complexity budget is already spent on the real
 * session-establishment branching.
 */
function manualHandoffArgs({
  capture,
  checkpoint,
  manualHandoffProbeRetry,
  page,
  sendInteraction,
  sessionProbe,
}: {
  capture: CaptureSession | null | undefined;
  checkpoint: SessionCheckpointFn | undefined;
  manualHandoffProbeRetry: ManualHandoffProbeRetryOptions | undefined;
  page: Page;
  sendInteraction: SendInteraction;
  sessionProbe: SessionProbeOptions | undefined;
}): Pick<
  EnsureRedditSessionArgs,
  "capture" | "checkpoint" | "manualHandoffProbeRetry" | "page" | "sendInteraction" | "sessionProbe"
> {
  return {
    ...(capture === undefined ? {} : { capture }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(manualHandoffProbeRetry === undefined ? {} : { manualHandoffProbeRetry }),
    page,
    sendInteraction,
    ...(sessionProbe === undefined ? {} : { sessionProbe }),
  };
}

async function ensureRedditManualSession({
  capture,
  checkpoint,
  manualHandoffProbeRetry,
  page,
  sendInteraction,
  sessionProbe,
}: Pick<
  EnsureRedditSessionArgs,
  "capture" | "checkpoint" | "manualHandoffProbeRetry" | "page" | "sendInteraction" | "sessionProbe"
>): Promise<void> {
  await checkpoint?.("reddit-signin-manual-required");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((): undefined => undefined);
  if (
    await manualBrowserLogin({
      ...(capture ? { capture } : {}),
      message: MANUAL_LOGIN_WITHOUT_CREDENTIALS_MESSAGE,
      page,
      probe: () => isSessionLiveWithRetry(page, { ...sessionProbe, ...manualHandoffProbeRetry }),
      sendInteraction,
      timeoutSeconds: 1800,
    })
  ) {
    return;
  }
  throw new Error("reddit_login_manual_incomplete");
}

async function recoverRedditBlockedLogin({
  capture,
  checkpoint,
  manualHandoffProbeRetry,
  page,
  sendInteraction,
  sessionProbe,
}: Pick<
  EnsureRedditSessionArgs,
  "capture" | "checkpoint" | "manualHandoffProbeRetry" | "page" | "sendInteraction" | "sessionProbe"
>): Promise<void> {
  await checkpoint?.("reddit-login-blocked-handoff");
  const cf = await detectCloudflareChallenge(page);
  const message = loginBlockedMessage(cf.signals);
  if (
    await manualBrowserLogin({
      ...(capture ? { capture } : {}),
      message,
      page,
      probe: () => isSessionLiveWithRetry(page, { ...sessionProbe, ...manualHandoffProbeRetry }),
      reason: "captcha",
      sendInteraction,
      timeoutSeconds: 1800,
    })
  ) {
    return;
  }
  throw new Error("reddit_login_unexpected_ui");
}

export async function ensureRedditSession({
  capture,
  checkpoint,
  context,
  manualHandoffProbeRetry,
  onCredentialSubmit,
  page,
  sendInteraction,
  sessionProbe,
}: EnsureRedditSessionArgs): Promise<void> {
  // BEFORE the probe, not after: this is the first thing this function does,
  // and the probe below is where run_1787109028586 spent its 120 silent
  // seconds. A checkpoint emitted after the probe would name a phase the run
  // never reached.
  await checkpoint?.("reddit-session-probe");
  // Probe timeouts are recorded synchronously and drained after the probe
  // returns: `onProbeTimeout` fires from inside `isSessionLive`, which is not
  // an async-callback seam, so awaiting a checkpoint there is not possible and
  // firing one unawaited would leave a floating promise racing the flow below.
  const timedOutStages: string[] = [];
  const probeOptions: SessionProbeOptions = {
    ...sessionProbe,
    onProbeTimeout: (stage: string): void => {
      // Distinguishable in diagnostics from a probe that ran and said "dead":
      // both proceed to login, but only one of them means Reddit stopped
      // answering us.
      timedOutStages.push(stage);
      sessionProbe?.onProbeTimeout?.(stage);
    },
  };
  const drainProbeTimeouts = async (): Promise<void> => {
    while (timedOutStages.length > 0) {
      const stage = timedOutStages.shift();
      await checkpoint?.(`reddit-session-probe-timeout:${stage}`);
    }
  };
  const sessionAlreadyLive = (await hasSessionCookie(context)) && (await isSessionLive(page, probeOptions));
  await drainProbeTimeouts();
  if (sessionAlreadyLive) {
    await checkpoint?.("reddit-session-already-live");
    return;
  }

  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;
  if (!(username && password)) {
    await ensureRedditManualSession(
      manualHandoffArgs({ capture, checkpoint, manualHandoffProbeRetry, page, sendInteraction, sessionProbe })
    );
    return;
  }

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((): undefined => undefined);
  await captureLoginState(capture, page, "reddit-login-page");
  await checkpoint?.("reddit-signin-loaded");

  const userIn = page.locator(USERNAME_SELECTOR).first();
  // `count()` is a one-shot DOM snapshot with no wait; on Reddit's
  // client-rendered login page it can read 0 before the field has painted.
  // `waitFor` gives the render a real, bounded chance instead.
  const usernameAppeared = await userIn
    .waitFor({ state: "attached", timeout: 10_000 })
    .then((): true => true)
    .catch((): false => false);
  if (!usernameAppeared) {
    // Cloudflare challenge, shadow DOM change, or redirect loop — hand off.
    // Earn the diagnosis via the shared detector instead of guessing "possible
    // Cloudflare challenge" from absence of inputs alone.
    await recoverRedditBlockedLogin(
      manualHandoffArgs({ capture, checkpoint, manualHandoffProbeRetry, page, sendInteraction, sessionProbe })
    );
    return;
  }

  await userIn.fill(username);
  await page.locator(PASSWORD_SELECTOR).first().fill(password);
  await captureLoginState(capture, page, "reddit-login-before-submit");
  await checkpoint?.("reddit-password-submit");
  if (!(await clickRedditLoginSubmit(page, onCredentialSubmit))) {
    await captureLoginState(capture, page, "reddit-login-submit-missing");
    throw new Error("reddit_login_submit_missing");
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);
  await captureLoginState(capture, page, "reddit-login-after-submit");
  await checkpoint?.("reddit-2fa-decision");

  // 2FA: Reddit shows a separate OTP step when 2FA is enabled on the account.
  // Give it the same bounded render tolerance as the pre-submit username
  // field (waitFor, not a flat 1s isVisible): the post-submit transition is a
  // second client-side render pass, and a `locatorIsVisible`-only check
  // (hardcoded 1s) can read "not present" before the field paints, silently
  // skipping the owner's OTP interaction and falling through to the dead
  // 90s cookie poll — the exact shape of `reddit_login_post_submit_failed`
  // with zero interaction requests ever sent.
  const otpIn = page.locator(OTP_SELECTOR).first();
  const otpAppeared = await otpIn
    .waitFor({ state: "visible", timeout: 5000 })
    .then((): true => true)
    .catch((): false => false);
  if (otpAppeared) {
    await captureLoginState(capture, page, "reddit-otp-detected");
    const resp = await sendInteraction({
      kind: "otp",
      message: "Reddit requires a 2FA verification code. Enter the 6-digit code from your authenticator app or SMS:",
      schema: {
        type: "object",
        properties: { code: { type: "string", pattern: "^\\d{6}$" } },
        required: ["code"],
      },
      timeout_seconds: 300,
    });
    const code = otpCode(resp);
    if (!code) {
      if (await isSessionLive(page)) {
        return;
      }
      throw new Error("reddit_2fa_cancelled");
    }
    await otpIn.fill(code);
    await page
      .locator('button[type="submit"]')
      .first()
      .click()
      .catch((): undefined => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);
    await captureLoginState(capture, page, "reddit-otp-after-submit");
  }

  // Poll up to 90s — Reddit may redirect through interstitials before the
  // session cookie is written. Checkpointed per attempt so this window shows
  // as live progress rather than another silent stretch: each iteration now
  // has a bounded probe, so a checkpoint here is a real liveness signal about
  // the run, not just a timer tick.
  await checkpoint?.("reddit-final-verify");
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const live = (await hasSessionCookie(context)) && (await isSessionLive(page, probeOptions));
    await drainProbeTimeouts();
    if (live) {
      return;
    }
    await checkpoint?.(`reddit-final-verify:attempt-${attempt + 1}`);
    await page.waitForTimeout(5000);
  }

  await captureLoginState(capture, page, "reddit-login-post-submit-failed");
  // NOT IMPLEMENTED: unlike amazon.ts's final-verify (fillOrHandleChallenge /
  // the amazon_login_incomplete_after_submit path), this gives the operator
  // no manual-handoff second chance when the automated flow completes but
  // the poll above never finds a live session (e.g. an approve-on-device
  // prompt or challenge variant the steps above didn't recognize) — it fails
  // straight to `reddit_login_post_submit_failed`. Adding one here is safe in
  // principle (a manual handoff only waits on the operator and re-probes,
  // it never resubmits the saved credential), but three existing tests
  // (`reddit.test.ts`: "fires onCredentialSubmit exactly once" x2, and the
  // post-submit-fault COUNTERWEIGHT pair around POST_SUBMIT_TRANSPORT_FAULT)
  // deliberately assert `sendInteraction` is NEVER called on this path as
  // defense-in-depth for the credential-safety invariant, so adding the
  // handoff here requires rewriting those assertions rather than a small
  // isolated change. Left as a follow-up rather than done under this fix.
  throw new Error("reddit_login_post_submit_failed");
}
