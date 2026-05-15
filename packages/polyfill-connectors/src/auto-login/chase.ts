/**
 * Chase automated session management.
 *
 * Chase uses `mds-*` custom elements (Web Components with Shadow DOM) for
 * its 2FA flow. The visual options and submit buttons are not clickable
 * via attribute selectors on the host elements — the host elements have
 * zero bounding box because the actual rendered content lives inside
 * mds-list's shadow root. Playwright's text-based and role-based locators
 * pierce shadow DOM and return the real clickable nodes.
 *
 * Flow:
 *   1. Probe — navigate to /web/auth/dashboard, check for "Sign out" text
 *   2. Logon — fill #userId-text-input-field + #password-text-input-field
 *      and click #signin-button
 *   3. Identity challenge — "Confirm Your Identity" page asks the user to
 *      pick a method (text / call / email). We auto-pick per
 *      CHASE_2FA_METHOD env (default 'text'). The method options render as
 *      `<a href="javascript:void(0)">` with aria-label starting with the
 *      short label ("Get a text" / "Call me" / "Email me").
 *   4. OTP — an `mds-text-input-secure#otpInput` wraps a shadow-DOM
 *      `<input type="password">`. Target that component explicitly:
 *      generic password selectors can hit the login password field or
 *      stale hidden controls.
 *      `pressSequentially` fires per-character events that the framework's
 *      validation listens for (bulk fill() did not trigger validation).
 *   5. Submit — click the rendered button inside `mds-button#next-content`.
 *      Text locators can resolve to Chase's hidden accessibility label.
 *
 * Selectors verified live 2026-04-21. Detailed probe history lives in git.
 */

import type { BrowserContext, Locator, Page } from "playwright";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";

const DASHBOARD_URL = "https://secure.chase.com/web/auth/dashboard";
const LOGON_URL = "https://secure.chase.com/web/auth/";

const SIGN_OUT_TEXT = /Sign Out|Log Off/i;
const CHALLENGE_TEXT = /Confirm Your Identity|Choose a confirmation method/i;
const OTP_PROMPT_TEXT = /Enter (the|your) code|identification code|verification code/i;
const OTP_PROMPT_TEXT_WITH_SENT = /Enter (the|your) code|identification code|verification code|we sent/i;
const REMEMBER_DEVICE_TEXT = /remember|trust|don't ask/i;
const NEXT_BUTTON_TEXT = /^Next$/i;
const OTP_INPUT_FALLBACK_SELECTOR =
  'input#otpInput-input, input[autocomplete="one-time-code"]:not([type="hidden"]):not([disabled]), input[name*="otp" i]:not([type="hidden"]):not([disabled]), input[id*="otp" i]:not([type="hidden"]):not([disabled])';

const METHOD_LABELS: Record<string, string> = {
  text: "Get a text",
  sms: "Get a text",
  voice: "Call me",
  call: "Call me",
  email: "Email me",
};

interface EnsureChaseSessionArgs {
  context: BrowserContext;
  page: Page;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

interface HandleChaseOtpArgs extends EnsureChaseSessionArgs {
  page: Page;
  surface: ChaseBrowserSurfaceMonitor;
}

type ChaseLoginStage = "before_otp_submit" | "after_otp_submit" | "final_session_probe";
type ChaseBrowserSurfaceState = "open" | "page_closed" | "context_closed" | "browser_disconnected";

interface ChaseBrowserSurfaceMonitor {
  browserDisconnected: () => boolean;
  contextClosed: () => boolean;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chaseStageError(stage: ChaseLoginStage, error: unknown): Error {
  return new Error(`chase_login_failed_${stage}: ${safeErrorMessage(error)}`);
}

function chaseSurfaceStageError(stage: ChaseLoginStage, state: ChaseBrowserSurfaceState, error: unknown): Error {
  return new Error(`chase_login_failed_${stage}: surface=${state}: ${safeErrorMessage(error)}`);
}

function watchChaseBrowserSurface(context: BrowserContext): ChaseBrowserSurfaceMonitor {
  let contextClosed = false;
  const browser = context.browser();
  let browserDisconnected = browser ? !browser.isConnected() : false;

  context.once("close", (): void => {
    contextClosed = true;
  });
  browser?.once("disconnected", (): void => {
    browserDisconnected = true;
  });

  return {
    browserDisconnected: (): boolean => browserDisconnected || Boolean(browser && !browser.isConnected()),
    contextClosed: (): boolean => contextClosed,
  };
}

export function classifyChaseBrowserSurface(page: Page, surface: ChaseBrowserSurfaceMonitor): ChaseBrowserSurfaceState {
  if (surface.browserDisconnected()) {
    return "browser_disconnected";
  }
  if (surface.contextClosed()) {
    return "context_closed";
  }
  if (page.isClosed()) {
    return "page_closed";
  }
  return "open";
}

async function recoverAfterPageClosed(
  context: BrowserContext,
  page: Page,
  stage: ChaseLoginStage,
  error: unknown
): Promise<{ loggedIn: boolean; page: Page }> {
  process.stderr.write(`[chase-login] ${stage}: surface=page_closed; probing session on a usable page\n`);
  const sessionProbe = await probeChaseSession(context, page);
  if (sessionProbe.loggedIn) {
    process.stderr.write(`[chase-login] ${stage}: recovered after page_closed; session is active\n`);
    return sessionProbe;
  }
  throw new Error(
    `chase_login_failed_${stage}: surface=page_closed; recovery_probe=not_logged_in: ${safeErrorMessage(error)}`
  );
}

function usablePage(context: BrowserContext, preferred: Page): Page | Promise<Page> {
  if (!preferred.isClosed()) {
    return preferred;
  }

  const openPage = context.pages().find((candidate): boolean => !candidate.isClosed());
  return openPage ?? context.newPage();
}

async function isOnChaseOtpPage(page: Page): Promise<boolean> {
  const textVisible = await page
    .getByText(OTP_PROMPT_TEXT_WITH_SENT)
    .first()
    .isVisible()
    .catch((): boolean => false);
  if (textVisible) {
    return true;
  }
  return findChaseOtpInput(page)
    .isVisible()
    .catch((): boolean => false);
}

async function clickChaseNext(page: Page, fallbackInput?: Locator): Promise<void> {
  const mdsNext = page.locator("mds-button#next-content").locator("button").first();
  if ((await mdsNext.count().catch((): number => 0)) > 0) {
    await mdsNext.click({ timeout: 10_000 });
    return;
  }

  const roleNext = page.getByRole("button", { name: NEXT_BUTTON_TEXT }).first();
  if ((await roleNext.count().catch((): number => 0)) > 0) {
    await roleNext.click({ timeout: 10_000 });
    return;
  }

  if (fallbackInput) {
    await fallbackInput.press("Enter");
    return;
  }

  throw new Error("chase_next_button_not_found");
}

function findChaseOtpInput(page: Page): Locator {
  // Chase's visible OTP input is inside the open shadow root of
  // mds-text-input-secure#otpInput, while the light DOM also contains a
  // disabled hidden input named otp-input. Use a host-then-shadow locator so
  // the hidden form mirror cannot win document-order matching.
  return page
    .locator("mds-text-input-secure#otpInput")
    .locator("input#otpInput-input, input[autocomplete='one-time-code']")
    .or(page.locator(OTP_INPUT_FALLBACK_SELECTOR))
    .first();
}

async function probeSession(page: Page): Promise<boolean> {
  // Auto-wait on "Sign out" being visible (logged in) or the logon form input
  // being visible (logged out), whichever shows first. Race with a timeout to
  // tolerate Chase serving a slow response.
  await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((): undefined => undefined);
  const signOutVisible = await page
    .getByText(SIGN_OUT_TEXT)
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then((): boolean => true)
    .catch((): boolean => false);
  return signOutVisible;
}

export async function probeChaseSession(
  context: BrowserContext,
  page: Page
): Promise<{ loggedIn: boolean; page: Page }> {
  const probePage = await usablePage(context, page);
  return {
    loggedIn: await probeSession(probePage),
    page: probePage,
  };
}

async function submitChaseOtp({
  context,
  page,
  sendInteraction,
  surface,
}: HandleChaseOtpArgs): Promise<{ loggedIn: boolean; page: Page }> {
  const resp = await sendInteraction({
    kind: "otp",
    message: "Chase sent a 2FA code. Reply with it.",
    schema: {
      type: "object",
      properties: { code: { type: "string", pattern: "^[0-9]{4,10}$" } },
      required: ["code"],
    },
    timeout_seconds: 600,
  });
  if (resp.status !== "success" || !resp.data?.code) {
    throw new Error("chase_otp_not_provided");
  }

  const otpInput = findChaseOtpInput(page);
  try {
    await otpInput.waitFor({ state: "visible", timeout: 10_000 });
    await otpInput.click({ timeout: 5000 });
    await otpInput.fill("");
    await otpInput.pressSequentially(resp.data.code, { delay: 60 });
  } catch (error) {
    const state = classifyChaseBrowserSurface(page, surface);
    if (state === "page_closed") {
      return recoverAfterPageClosed(context, page, "before_otp_submit", error);
    }
    throw chaseSurfaceStageError("before_otp_submit", state, error);
  }

  // Best-effort: tick any "remember this device" / "don't ask again"
  // checkbox before submitting. Chase sets a session-only
  // `_tmprememberme` cookie by default; it's upgraded to a persistent
  // trust cookie when the user opts in via a checkbox on the OTP page.
  // Without this, every run requires a fresh OTP. If the checkbox
  // isn't present or is already checked, this is a no-op.
  //
  // Uses accessibility-tree matching (Playwright's recommended
  // best practice: https://playwright.dev/docs/locators#locate-by-role).
  // Verified-on-real-DOM selector TBD — this is a first pass based on
  // common bank-UI naming conventions. If it doesn't trigger on the
  // real Chase page, probe the OTP page with the Playwright Inspector
  // (`PDPP_TRACE=1` + `npx playwright show-trace <zip>`) and add a
  // more specific selector here based on observation.
  try {
    const rememberBox = page
      .getByRole("checkbox", {
        name: REMEMBER_DEVICE_TEXT,
      })
      .first();
    const count = await rememberBox.count().catch((): number => 0);
    if (count > 0 && !(await rememberBox.isChecked().catch((): boolean => true))) {
      await rememberBox.check({ timeout: 2000 });
    }
  } catch {
    /* no-op on absence or timeout */
  }

  try {
    await clickChaseNext(page, otpInput);
  } catch (error) {
    const state = classifyChaseBrowserSurface(page, surface);
    if (state === "page_closed") {
      return recoverAfterPageClosed(context, page, "after_otp_submit", error);
    }
    throw chaseSurfaceStageError("after_otp_submit", state, error);
  }

  try {
    await page.getByText(SIGN_OUT_TEXT).first().waitFor({ state: "visible", timeout: 30_000 });
  } catch (error) {
    const state = classifyChaseBrowserSurface(page, surface);
    if (state === "page_closed") {
      return recoverAfterPageClosed(context, page, "after_otp_submit", error);
    }
    throw chaseSurfaceStageError("after_otp_submit", state, error);
  }

  return { loggedIn: true, page };
}

export async function ensureChaseSession({ context, page, sendInteraction }: EnsureChaseSessionArgs): Promise<boolean> {
  const surface = watchChaseBrowserSurface(context);
  let activePage = page;
  let sessionProbe = await probeChaseSession(context, activePage);
  activePage = sessionProbe.page;
  if (sessionProbe.loggedIn) {
    return true;
  }

  const username = process.env.CHASE_USERNAME;
  const password = process.env.CHASE_PASSWORD;
  if (!(username && password)) {
    throw new Error("CHASE_USERNAME/PASSWORD not set");
  }

  await activePage.goto(LOGON_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  // Logon form — ID pattern changed 2026-04-21:
  //   old: #userId-text-input-field / #password-text-input-field
  //   new: #userId-input-field-input / #password-input-field-input (+name=username)
  // Accept both so we work across Chase's redesigns without a release.
  const userField = activePage
    .locator(
      'input#userId-input-field-input, input[name="username"], input#userId-text-input-field, input[name="userId"]'
    )
    .first();
  await userField.waitFor({ state: "visible", timeout: 15_000 });
  await userField.fill(username);

  const passField = activePage
    .locator(
      'input#password-input-field-input, input#password-text-input-field, input[name="password"], input[type="password"]'
    )
    .first();
  await passField.fill(password);

  await activePage.locator('button#signin-button, button[type="submit"]').first().click({ timeout: 5000 });

  // After submit, Chase either advances to the challenge page or loads the
  // dashboard. Wait for a recognizable post-submit state rather than a fixed
  // sleep. Race: challenge indicator OR sign-out visible.
  await Promise.race([
    activePage
      .getByText(CHALLENGE_TEXT)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .catch((): null => null),
    activePage
      .getByText(SIGN_OUT_TEXT)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .catch((): null => null),
  ]);

  // Identity challenge — method chooser.
  const onChallenge = await activePage
    .getByText(CHALLENGE_TEXT)
    .first()
    .isVisible()
    .catch((): boolean => false);
  if (onChallenge) {
    const method = (process.env.CHASE_2FA_METHOD ?? "text").toLowerCase();
    const label = METHOD_LABELS[method] ?? METHOD_LABELS.text ?? "Get a text";

    await activePage
      .getByRole("link", { name: new RegExp(`^${label}`, "i") })
      .first()
      .click({ timeout: 10_000 });

    // Wait for the Next button to be enabled/visible before clicking it.
    await clickChaseNext(activePage);

    // Wait for either the OTP input page or the dashboard.
    await Promise.race([
      activePage
        .getByText(OTP_PROMPT_TEXT)
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch((): null => null),
      activePage
        .locator("mds-text-input-secure#otpInput")
        .locator("input#otpInput-input, input[autocomplete='one-time-code']")
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch((): null => null),
      activePage
        .getByText(SIGN_OUT_TEXT)
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch((): null => null),
    ]);
  }

  // OTP entry step.
  const onOtp = await isOnChaseOtpPage(activePage);
  if (onOtp) {
    sessionProbe = await submitChaseOtp({ context, page: activePage, sendInteraction, surface });
    activePage = sessionProbe.page;
    if (sessionProbe.loggedIn) {
      return true;
    }
  }

  try {
    sessionProbe = await probeChaseSession(context, activePage);
    activePage = sessionProbe.page;
  } catch (error) {
    throw chaseStageError("final_session_probe", error);
  }
  if (!sessionProbe.loggedIn) {
    throw new Error("chase_login_incomplete_after_submit");
  }
  return true;
}
