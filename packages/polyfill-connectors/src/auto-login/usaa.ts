// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * USAA automated re-login.
 *
 * Given a Playwright context whose session has died, drives the full login
 * flow using stored credentials. Emits an INTERACTION kind=otp via the
 * provided `sendInteraction` callback; that in turn fires ntfy to
 * the owner's phone. the owner replies with the 6-digit code over the inbox (or by
 * writing to /tmp/usaa-otp.txt during manual testing).
 *
 * Returns true on success; throws on hard failure.
 */

import type { BrowserContext, Locator, Page } from "playwright";
import { manualAction } from "../browser-handoff.ts";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import type { CaptureSession } from "../fixture-capture.ts";

const DASHBOARD_URL = "https://www.usaa.com/my/usaa";
const LOGIN_URL = "https://www.usaa.com/my/logon";
const LOGGED_IN_TEXT = /Log Off|Good (Morning|Afternoon|Evening)/i;
const SESSION_COOKIE = /^(LtpaToken2|AST|MemberGlobalSession)$/;
const TEXT_CODE_PROMPT = /Text security code/i;
const OTP_INPUT_SELECTOR = 'input[autocomplete="one-time-code"], input[name*="code" i], input[placeholder*="code" i]';
const OTP_RETRY_TEXT = /retry|invalid|incorrect|expired|try again/i;
const LOGIN_NAVIGATION_INTERVENTION_ERROR = /page\.goto: net::ERR_(HTTP2_PROTOCOL_ERROR|CONNECTION_RESET|FAILED)\b/i;
// Deliberately narrow: only phrases that specifically assert the *provider's
// own system* is down. "try again later" alone is common boilerplate on
// challenge, lockout, and rate-limit pages too (which need a real owner
// action, not a suppressed retry) — it must not by itself classify as
// source_unavailable. Matches (with common wording variants) only the two
// phrases that unambiguously identify USAA's generic system-outage page.
const USAA_SOURCE_UNAVAILABLE_TEXT =
  /unable to complete (your|this) request|(our |the )?system is (currently )?unavailable/i;
const USAA_LOGIN_ACTION_NAME = /^(Log in|Log On)$/i;
const USAA_ORIGIN = "https://www.usaa.com";
const MEMBER_ID_INPUT = 'input[name="memberId"]';
const MAX_OTP_ATTEMPTS = 3;
const MANUAL_LOGIN_MESSAGE =
  "USAA could not finish sign-in automatically; open the browser to continue. PDPP resumes when sign-in succeeds.";
// `classifyUsaaLoginStepFailure` returning `source_unavailable` proves only
// that USAA's page copy matches known outage boilerplate — it does NOT prove
// the provider is actually down. It still reaches manual_action unless this
// exact state exposes exactly one visible semantic Log in/Log On action which,
// when activated once, returns to USAA's same-origin member-ID form. That is a
// proven continuation of the stored-credential flow, not a retry or an uptime
// claim; every absent, ambiguous, foreign, or failed transition falls through
// to the established owner handoff.
const MANUAL_LOGIN_MESSAGE_SOURCE_UNAVAILABLE_SUFFIX =
  " USAA's page reported its own system as unavailable, but this exact failure has recurred — if USAA works normally in your own browser, this may be an automated sign-in issue rather than a real outage.";
const STACK_TRACE_LOCATION_SUFFIX_RE = /\s+at\s+https?:\/\/\S+$/i;

interface EnsureUsaaSessionArgs {
  capture?: CaptureSession | null;
  context: BrowserContext;
  page: Page;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

interface InputProbe {
  name: string;
  placeholder: string;
  type: string;
}

interface SourceUnavailableLoginAction {
  locator: Locator;
  visible: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(message: string): string {
  return message.split("\n")[0]?.trim() || message.trim();
}

function trimForDiagnostic(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function classifyUsaaLoginStepFailure(bodyText: string): "source_unavailable" | "password_field_missing" {
  return USAA_SOURCE_UNAVAILABLE_TEXT.test(bodyText) ? "source_unavailable" : "password_field_missing";
}

/**
 * Admit only one visible semantic action.
 *
 * This is intentionally private: the browser recovery owns how candidates are
 * discovered, while this pure policy owns the ambiguity invariant.
 */
function selectSourceUnavailableLoginAction(
  actions: SourceUnavailableLoginAction[]
): SourceUnavailableLoginAction | "absent" | "ambiguous" {
  const visibleActions = actions.filter((action) => action.visible);
  if (visibleActions.length === 0) {
    return "absent";
  }
  if (visibleActions.length !== 1) {
    return "ambiguous";
  }
  return visibleActions[0] ?? "ambiguous";
}

type SourceUnavailableLoginRecoveryOutcome =
  | "absent"
  | "action_error"
  | "ambiguous"
  | "foreign_origin"
  | "member_id_form_missing"
  | "resume_error"
  | "recovered";

function sourceUnavailableLoginRecoveryDiagnostic(outcome: SourceUnavailableLoginRecoveryOutcome): string {
  return `source_unavailable_login_action=${outcome}`;
}

async function captureSourceUnavailableLoginActionStructure(
  capture: CaptureSession | null | undefined,
  page: Page
): Promise<void> {
  await capture
    ?.captureLocatorProbe?.(page, "usaa-source-unavailable-login-action", [
      {
        description: "Exact accessible-name candidate; captures only structural locator evidence.",
        id: "exact-login-button",
        kind: "role",
        namePattern: "^(Log in|Log On)$",
        nameFlags: "i",
        role: "button",
      },
      {
        description: "Exact accessible-name candidate; captures only structural locator evidence.",
        id: "exact-login-link",
        kind: "role",
        namePattern: "^(Log in|Log On)$",
        nameFlags: "i",
        role: "link",
      },
    ])
    .catch((): undefined => undefined);
}

async function sourceUnavailableLoginActions(page: Page): Promise<SourceUnavailableLoginAction[]> {
  const semanticActions = [
    page.getByRole("button", { name: USAA_LOGIN_ACTION_NAME }),
    page.getByRole("link", { name: USAA_LOGIN_ACTION_NAME }),
  ];
  const candidates: SourceUnavailableLoginAction[] = [];
  for (const action of semanticActions) {
    const count = await action.count().catch((): number => 0);
    for (let index = 0; index < count; index++) {
      const locator = action.nth(index);
      candidates.push({
        locator,
        visible: await locator.isVisible().catch((): boolean => false),
      });
    }
  }
  return candidates;
}

async function attemptSourceUnavailableLoginRecovery(
  capture: CaptureSession | null | undefined,
  page: Page
): Promise<SourceUnavailableLoginRecoveryOutcome> {
  await captureSourceUnavailableLoginActionStructure(capture, page);
  const actions = await sourceUnavailableLoginActions(page);
  const selectedAction = selectSourceUnavailableLoginAction(actions);
  if (typeof selectedAction === "string") {
    return selectedAction;
  }

  try {
    await selectedAction.locator.click({ timeout: 10_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch((): undefined => undefined);
  } catch {
    return "action_error";
  }
  let sameOrigin = false;
  try {
    sameOrigin = new URL(page.url()).origin === USAA_ORIGIN;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    return "foreign_origin";
  }
  return page
    .waitForSelector(MEMBER_ID_INPUT, { state: "visible", timeout: 10_000 })
    .then((): SourceUnavailableLoginRecoveryOutcome => "recovered")
    .catch((): SourceUnavailableLoginRecoveryOutcome => "member_id_form_missing");
}

function passwordStepFailureDiagnostic({
  body,
  inputs,
  url,
}: {
  body: string;
  inputs: InputProbe[];
  url: string;
}): string {
  return `url=${url} inputs=${JSON.stringify(inputs)} body-preview=${trimForDiagnostic(body, 300)}`;
}

function isLoggedInCookie(cookie: { name: string; value?: string }): boolean {
  if (cookie.name === "UsaaMbWebMemberLoggedIn") {
    return Boolean(cookie.value) && cookie.value !== "false";
  }
  return SESSION_COOKIE.test(cookie.name);
}

async function hasLoggedInCookie(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies("https://www.usaa.com/");
  return cookies.some(isLoggedInCookie);
}

async function verifyLoggedIn(context: BrowserContext, page: Page): Promise<boolean> {
  if (!(await hasLoggedInCookie(context))) {
    return false;
  }

  // Verify by hitting a cheap authenticated page.
  await page
    .goto(DASHBOARD_URL, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    })
    .catch((): undefined => undefined);
  await page.waitForTimeout(3000);
  const bodyText = (
    await page
      .locator("body")
      .innerText()
      .catch((): string => "")
  ).slice(0, 500);
  return LOGGED_IN_TEXT.test(bodyText);
}

async function requestManualLoginRecovery(
  { context, page, sendInteraction }: EnsureUsaaSessionArgs,
  message: string = MANUAL_LOGIN_MESSAGE
): Promise<boolean> {
  await manualAction(
    {
      page,
      reason: "login",
      message,
      timeoutSeconds: 1800,
    },
    sendInteraction
  );
  // Re-probe the session after the manual step rather than trusting the
  // interaction's completion status. The operator who completes login in a
  // visible browser may end the interaction as cancelled/error (timeout, or
  // an explicit "I'm already in" cancel) yet still have an active session.
  // Mirrors the chatgpt and reddit fallbacks: completing the manual step is a
  // signal to re-check ground truth, not an instruction to end the run.
  return verifyLoggedIn(context, page);
}

async function requestOtp(sendInteraction: EnsureUsaaSessionArgs["sendInteraction"], attempt: number): Promise<string> {
  const resp = await sendInteraction({
    kind: "otp",
    message:
      attempt === 1
        ? "USAA sent a 6-digit security code to your phone. Reply with the code to continue."
        : "USAA did not accept the previous security code. Reply with the newest 6-digit USAA code to continue.",
    schema: {
      type: "object",
      properties: { code: { type: "string", pattern: "^\\d{6}$" } },
      required: ["code"],
    },
    timeout_seconds: 600,
  });
  if (resp.status !== "success" || !resp.data?.code) {
    throw new Error("USAA OTP not provided");
  }
  return resp.data.code;
}

async function isStillOnOtpChallenge(page: Page): Promise<boolean> {
  const retryText = await page
    .locator("body")
    .innerText()
    .catch((): string => "");
  const otpStillVisible = await page
    .locator(OTP_INPUT_SELECTOR)
    .first()
    .isVisible()
    .catch((): boolean => false);
  return otpStillVisible || OTP_RETRY_TEXT.test(retryText);
}

async function completeOtpChallenge({ context, page, sendInteraction }: EnsureUsaaSessionArgs): Promise<boolean> {
  await page.waitForSelector(OTP_INPUT_SELECTOR, { timeout: 20_000 });

  for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt++) {
    const code = await requestOtp(sendInteraction, attempt);
    const otpInput = page.locator(OTP_INPUT_SELECTOR).first();
    await otpInput.fill(code);
    await page.click('button[type="submit"], #next-button').catch((): undefined => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch((): undefined => undefined);
    await page.waitForTimeout(3000);

    if ((await hasLoggedInCookie(context)) && (await verifyLoggedIn(context, page))) {
      return true;
    }
    if (!(await isStillOnOtpChallenge(page))) {
      return false;
    }
  }
  return false;
}

async function submitMemberId(page: Page, username: string): Promise<boolean> {
  // Give React a beat to initialize the form. USAA's SPA renders the
  // memberId input immediately but hasn't bound React event handlers yet —
  // filling in that <1s window produces a value that React discards.
  await page.waitForSelector(MEMBER_ID_INPUT, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.fill(MEMBER_ID_INPUT, username);
  // Wait until Next is enabled; USAA gates it on client-side validation.
  // If it stays disabled, tick a key event to try again, then check.
  try {
    await page.locator("#next-button:not([disabled])").waitFor({ state: "visible", timeout: 5000 });
  } catch {
    // Fallback: press a throwaway key to nudge React.
    await page
      .locator(MEMBER_ID_INPUT)
      .press("End")
      .catch((): undefined => undefined);
    await page.waitForTimeout(500);
  }
  await page.click("#next-button");
  return page
    .waitForSelector('input[name="password"]', { timeout: 25_000 })
    .then((): true => true)
    .catch((): false => false);
}

async function handlePasswordFieldStall(
  { capture, context, page, sendInteraction }: EnsureUsaaSessionArgs,
  username: string
): Promise<"logged_in" | "password_ready"> {
  const initialBody = await page
    .locator("body")
    .innerText()
    .catch((): string => "");
  const initialClassification = classifyUsaaLoginStepFailure(initialBody);
  let recoveryOutcome: SourceUnavailableLoginRecoveryOutcome | null = null;
  if (initialClassification === "source_unavailable") {
    recoveryOutcome = await attemptSourceUnavailableLoginRecovery(capture, page);
    if (recoveryOutcome === "recovered") {
      try {
        if (await submitMemberId(page, username)) {
          return "password_ready";
        }
      } catch {
        recoveryOutcome = "resume_error";
      }
    }
  }

  const body = await page
    .locator("body")
    .innerText()
    .catch((): string => "");
  const classification = classifyUsaaLoginStepFailure(body);
  // The source-unavailable branch already captured only fixed semantic
  // locator probes before the transition. Do not add a raw DOM snapshot after
  // the member ID was filled; it could retain credential-adjacent data.
  if (initialClassification !== "source_unavailable") {
    await capture?.captureDom(page, "usaa-password-field-stall").catch((): undefined => undefined);
  }
  const inputs = await page
    .evaluate((): InputProbe[] => {
      const els = document.querySelectorAll("input");
      return Array.from(els).map(
        (i): InputProbe => ({
          name: i.name,
          type: i.type,
          placeholder: i.placeholder,
        })
      );
    })
    .catch((): InputProbe[] => []);
  const diagnostic = passwordStepFailureDiagnostic({ body, inputs, url: page.url() });
  const manualLoginMessage =
    classification === "source_unavailable"
      ? `${MANUAL_LOGIN_MESSAGE}${MANUAL_LOGIN_MESSAGE_SOURCE_UNAVAILABLE_SUFFIX}`
      : MANUAL_LOGIN_MESSAGE;
  const recoveryDiagnostic = recoveryOutcome ? ` ${sourceUnavailableLoginRecoveryDiagnostic(recoveryOutcome)}.` : "";
  if (
    await requestManualLoginRecovery({ context, page, sendInteraction }, `${manualLoginMessage}${recoveryDiagnostic}`)
  ) {
    return "logged_in";
  }
  throw new Error(
    `USAA login stalled after Next click (${diagnostic}${recoveryOutcome ? ` ${sourceUnavailableLoginRecoveryDiagnostic(recoveryOutcome)}` : ""}); manual action did not establish a session`
  );
}

export async function ensureUsaaSession({
  capture,
  context,
  page,
  sendInteraction,
}: EnsureUsaaSessionArgs): Promise<boolean> {
  // Probe first — no need to re-login if session is alive.
  if (await verifyLoggedIn(context, page)) {
    return true;
  }

  // Session is dead or suspect — drive login.
  const username = process.env.USAA_USERNAME;
  const password = process.env.USAA_PASSWORD;
  if (!(username && password)) {
    throw new Error("USAA_USERNAME/PASSWORD not set; cannot auto-login");
  }

  try {
    await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch (err) {
    const message = errorMessage(err);
    if (LOGIN_NAVIGATION_INTERVENTION_ERROR.test(message)) {
      const reason = firstLine(message).replace(STACK_TRACE_LOCATION_SUFFIX_RE, "");
      if (await requestManualLoginRecovery({ context, page, sendInteraction })) {
        return true;
      }
      throw new Error(`USAA login page navigation failed (${reason}); manual action did not establish a session`);
    }
    throw err;
  }
  if (
    !(await submitMemberId(page, username)) &&
    (await handlePasswordFieldStall({ capture: capture ?? null, context, page, sendInteraction }, username)) ===
      "logged_in"
  ) {
    return true;
  }
  await page.fill('input[name="password"]', password);
  await page.waitForTimeout(500);
  await page.click("#next-button");
  await page.waitForTimeout(5000);

  const bodyText = (await page.locator("body").innerText()).slice(0, 1000);

  if (TEXT_CODE_PROMPT.test(bodyText)) {
    // Trigger the SMS + ask the owner for the code via INTERACTION
    await page
      .locator(':text-matches("Text security code to:", "i")')
      .first()
      .click()
      .catch(async (): Promise<void> => {
        await page.locator("#miam-choice-container\\ 0-id").click();
      });
    if (await completeOtpChallenge({ context, page, sendInteraction })) {
      return true;
    }
  }

  if (await verifyLoggedIn(context, page)) {
    return true;
  }

  const finalText = await page
    .locator("body")
    .innerText()
    .catch((): string => "");
  await capture?.captureDom(page, "usaa-post-password-no-session").catch((): undefined => undefined);
  const classification = classifyUsaaLoginStepFailure(finalText);
  const inputs = await page
    .evaluate((): InputProbe[] => {
      const els = document.querySelectorAll("input");
      return Array.from(els).map(
        (i): InputProbe => ({
          name: i.name,
          type: i.type,
          placeholder: i.placeholder,
        })
      );
    })
    .catch((): InputProbe[] => []);
  // `classification` here is a diagnostic label, not proof of provider
  // uptime — see the comment on MANUAL_LOGIN_MESSAGE_SOURCE_UNAVAILABLE_SUFFIX.
  // It is folded into the thrown diagnostic so downstream classification/logs
  // can see it, but it does not change what error this throws or suppress
  // the owner-visible diagnostic that was already here.
  throw new Error(
    `USAA login completed but no verified authenticated dashboard session was detected (classification=${classification}). url=${page.url()} inputs=${JSON.stringify(inputs)} body-preview=${trimForDiagnostic(finalText, 300)}`
  );
}
