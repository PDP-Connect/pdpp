/**
 * H-E-B automated session management.
 *
 * Strategy:
 *   1. Probe the live orders page first.
 *   2. If dead and stored sign-in details are present, fill the verified login
 *      form only, submit it, and wait for a bounded post-submit state change
 *      before re-checking the session.
 *   3. If H-E-B shows a verification-code page, emit the shared OTP
 *      interaction, fill and submit the code, then re-probe the live session.
 *   4. If H-E-B shows passkey, CAPTCHA, Incapsula, or any other unexpected
 *      UI, hand the browser to the owner and probe again.
 *
 * The runtime never logs or stores the provider password here. When the owner
 * has opted into credential capture, the connector receives it through the
 * existing connection-scoped secret injection path.
 */

import type { Locator, Page } from "playwright";
import { isIncapsulaBlocked, looksLoggedOut } from "../../connectors/heb/parsers.ts";
import { manualAction } from "../browser-handoff.ts";
import type { InteractionRequest, InteractionResponse, SessionCheckpointFn } from "../connector-runtime.ts";
import type { CaptureSession } from "../fixture-capture.ts";

const ORDERS_URL = "https://www.heb.com/my-account/your-orders";
const SESSION_PROBE_WAIT_MS = 2000;
const POST_SUBMIT_POLL_INTERVAL_MS = 200;
const POST_SUBMIT_TIMEOUT_MS = 8000;
const FIELD_TIMEOUT_MS = 15_000;
const EMAIL_SELECTOR =
  'input[name="email"], input[type="email"], input[autocomplete="username"], input[name="username"]';
const PASSWORD_SELECTOR = 'input[name="password"], input[type="password"], input[autocomplete="current-password"]';
const SUBMIT_SELECTOR = 'button[type="submit"], input[type="submit"]';
const VERIFICATION_CODE_SELECTOR =
  'input[name="code"], input[name="otp"], input[name="verification_code"], input[autocomplete="one-time-code"]';
const PASSKEY_RE = /\bpasskey\b/i;
const VERIFICATION_CODE_RE = /\b(verification code|security code|one[- ]time code|code sent)\b/i;
const CAPTCHA_RE = /\b(captcha|verify you are human|security check)\b/i;
const AUTHENTICATED_ORDERS_EVIDENCE_RE = /data-qe-id="orderResults"|data-testid="no-orders-message"/i;
const LOGIN_FORM_SELECTOR = "form";

export type HebAuthSurface =
  | "live"
  | "login_form"
  | "passkey"
  | "verification_code"
  | "captcha"
  | "incapsula"
  | "unknown";

interface EnsureHebSessionArgs {
  capture?: CaptureSession | null;
  checkpoint?: SessionCheckpointFn;
  page: Page;
  postSubmitWaitClock?: PostSubmitWaitClock;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

interface PostSubmitWaitClock {
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

async function countUsableCandidates(locator: Locator): Promise<number> {
  const count = await locator.count().catch((): number => 0);
  let usable = 0;
  for (let i = 0; i < count; i++) {
    const candidate = locator.nth(i);
    const [visible, enabled] = await Promise.all([
      candidate.isVisible().catch((): boolean => false),
      candidate.isEnabled().catch((): boolean => false),
    ]);
    if (visible && enabled) {
      usable += 1;
    }
  }
  return usable;
}

async function fillWhenUsable(
  page: Page,
  locator: Locator,
  value: string,
  { timeout = FIELD_TIMEOUT_MS }: { timeout?: number } = {}
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const count = await locator.count().catch((): number => 0);
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      const [visible, enabled] = await Promise.all([
        candidate.isVisible().catch((): boolean => false),
        candidate.isEnabled().catch((): boolean => false),
      ]);
      if (visible && enabled) {
        await candidate.fill(value);
        return true;
      }
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function clickWhenUsable(
  page: Page,
  locator: Locator,
  { timeout = FIELD_TIMEOUT_MS }: { timeout?: number } = {}
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const count = await locator.count().catch((): number => 0);
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      const [visible, enabled] = await Promise.all([
        candidate.isVisible().catch((): boolean => false),
        candidate.isEnabled().catch((): boolean => false),
      ]);
      if (visible && enabled) {
        await candidate.click();
        return true;
      }
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function hasUniqueLoginFormRoot(page: Page): Promise<boolean> {
  return (await resolveUniqueLoginFormRoot(page)) !== null;
}

async function resolveUniqueLoginFormRoot(page: Page): Promise<Locator | null> {
  const forms = page.locator(LOGIN_FORM_SELECTOR);
  const count = await forms.count().catch((): number => 0);
  let resolved: Locator | null = null;
  let viableRoots = 0;

  for (let i = 0; i < count; i++) {
    const root = forms.nth(i);
    const [visible, enabled] = await Promise.all([
      root.isVisible().catch((): boolean => false),
      root.isEnabled().catch((): boolean => false),
    ]);
    if (!(visible && enabled)) {
      continue;
    }
    const emailCount = await countUsableCandidates(root.locator(EMAIL_SELECTOR));
    const passwordCount = await countUsableCandidates(root.locator(PASSWORD_SELECTOR));
    const submitCount = await countUsableCandidates(root.locator(SUBMIT_SELECTOR));
    if (emailCount === 1 && passwordCount === 1 && submitCount === 1) {
      viableRoots += 1;
      resolved = root;
      if (viableRoots > 1) {
        return null;
      }
    }
  }

  return viableRoots === 1 ? resolved : null;
}

async function resolveUniqueVerificationCodeFormRoot(page: Page): Promise<Locator | null> {
  const forms = page.locator(LOGIN_FORM_SELECTOR);
  const count = await forms.count().catch((): number => 0);
  let resolved: Locator | null = null;
  let viableRoots = 0;

  for (let i = 0; i < count; i++) {
    const root = forms.nth(i);
    const [visible, enabled] = await Promise.all([
      root.isVisible().catch((): boolean => false),
      root.isEnabled().catch((): boolean => false),
    ]);
    if (!(visible && enabled)) {
      continue;
    }
    const codeCount = await countUsableCandidates(root.locator(VERIFICATION_CODE_SELECTOR));
    if (codeCount === 1) {
      viableRoots += 1;
      resolved = root;
      if (viableRoots > 1) {
        return null;
      }
    }
  }

  return viableRoots === 1 ? resolved : null;
}

function classifyChallengeSurface(
  url: string,
  html: string
): Exclude<HebAuthSurface, "live" | "login_form" | "unknown"> | null {
  if (PASSKEY_RE.test(html) || PASSKEY_RE.test(url)) {
    return "passkey";
  }
  if (VERIFICATION_CODE_RE.test(html) || VERIFICATION_CODE_RE.test(url)) {
    return "verification_code";
  }
  if (CAPTCHA_RE.test(html) || CAPTCHA_RE.test(url)) {
    return "captcha";
  }
  return null;
}

function hasAuthenticatedOrdersEvidence(html: string): boolean {
  return AUTHENTICATED_ORDERS_EVIDENCE_RE.test(html);
}

function manualLoginMessage(surface: Exclude<HebAuthSurface, "live">): string {
  switch (surface) {
    case "login_form":
      return "H-E-B did not finish signing in automatically. Complete the sign-in form in the secure browser, then continue. PDPP will re-check the session afterward.";
    case "passkey":
      return "H-E-B is asking for a passkey. Complete the prompt in the secure browser, then continue. PDPP will re-check the session afterward.";
    case "verification_code":
      return "H-E-B is asking for a verification code. Enter it in the secure browser, then continue. PDPP will re-check the session afterward.";
    case "captcha":
      return "H-E-B is showing a CAPTCHA. Complete it in the secure browser, then continue. PDPP will re-check the session afterward.";
    case "incapsula":
      return "H-E-B is showing an Imperva Incapsula challenge. Complete it in the secure browser, then continue. PDPP will re-check the session afterward.";
    default:
      return "H-E-B did not render the expected login form. Open the secure browser, sign in there, then continue. PDPP will re-check the session afterward.";
  }
}

async function inspectAuthSurface(page: Page): Promise<HebAuthSurface> {
  const url = page.url();
  const html = await page.content().catch((): string => "");
  if (!html) {
    return "unknown";
  }
  if (isIncapsulaBlocked(html)) {
    return "incapsula";
  }
  if (await hasUniqueLoginFormRoot(page)) {
    return "login_form";
  }
  const challengeSurface = classifyChallengeSurface(url, html);
  if (challengeSurface) {
    return challengeSurface;
  }
  if (url === ORDERS_URL && hasAuthenticatedOrdersEvidence(html)) {
    return "live";
  }
  return "unknown";
}

async function inspectPostSubmitAuthSurface(page: Page): Promise<HebAuthSurface> {
  const url = page.url();
  const html = await page.content().catch((): string => "");
  if (!html) {
    return "unknown";
  }
  if (isIncapsulaBlocked(html)) {
    return "incapsula";
  }
  const challengeSurface = classifyChallengeSurface(url, html);
  if (challengeSurface) {
    return challengeSurface;
  }
  if (looksLoggedOut(url, html)) {
    return "login_form";
  }
  if (url === ORDERS_URL && hasAuthenticatedOrdersEvidence(html)) {
    return "live";
  }
  return "unknown";
}

async function probeOrdersPage(page: Page): Promise<HebAuthSurface> {
  await page
    .goto(ORDERS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    .catch((): undefined => undefined);
  await page.waitForTimeout(SESSION_PROBE_WAIT_MS);
  return inspectAuthSurface(page);
}

async function reProbeAfterManualAction(page: Page): Promise<boolean> {
  return (await probeOrdersPage(page)) === "live";
}

function defaultPostSubmitWaitClock(page: Page): PostSubmitWaitClock {
  return {
    now: (): number => Date.now(),
    wait: (ms: number): Promise<void> => page.waitForTimeout(ms),
  };
}

type PostSubmitAuthOutcome =
  | { kind: "live" }
  | { kind: "challenge"; surface: Exclude<HebAuthSurface, "live" | "login_form" | "unknown"> }
  | { kind: "timeout"; surface: Exclude<HebAuthSurface, "live"> };

interface WaitForPostSubmitAuthSurfaceOptions {
  readonly ignoreVerificationCode?: boolean;
}

async function waitForPostSubmitAuthSurface(
  page: Page,
  clock: PostSubmitWaitClock,
  checkpoint?: SessionCheckpointFn,
  { ignoreVerificationCode = false }: WaitForPostSubmitAuthSurfaceOptions = {}
): Promise<PostSubmitAuthOutcome> {
  const startedAt = clock.now();
  let observedUrl = page.url();
  let observedHtml = await page.content().catch((): string => "");

  await checkpoint?.("heb-post-submit-await-transition");

  while (clock.now() - startedAt <= POST_SUBMIT_TIMEOUT_MS) {
    const surface = await inspectPostSubmitAuthSurface(page);
    if (surface === "live") {
      return { kind: "live" };
    }
    if (
      surface === "passkey" ||
      surface === "captcha" ||
      surface === "incapsula" ||
      (!ignoreVerificationCode && surface === "verification_code")
    ) {
      return { kind: "challenge", surface };
    }

    const currentUrl = page.url();
    const currentHtml = await page.content().catch((): string => "");
    if (currentUrl !== observedUrl || currentHtml !== observedHtml) {
      await checkpoint?.("heb-post-submit-transition-observed");
      observedUrl = currentUrl;
      observedHtml = currentHtml;
      continue;
    }

    await clock.wait(POST_SUBMIT_POLL_INTERVAL_MS);
  }

  await checkpoint?.("heb-post-submit-timeout");
  const finalSurface = await inspectPostSubmitAuthSurface(page);
  return {
    kind: "timeout",
    surface: finalSurface === "live" ? "unknown" : finalSurface,
  };
}

async function handOffToOwner({
  capture,
  page,
  sendInteraction,
  surface,
}: Pick<EnsureHebSessionArgs, "capture" | "page" | "sendInteraction"> & {
  readonly surface: Exclude<HebAuthSurface, "live">;
}): Promise<boolean> {
  await manualAction(
    {
      ...(capture ? { capture } : {}),
      message: manualLoginMessage(surface),
      page,
      reason: "login",
      timeoutSeconds: 1800,
    },
    sendInteraction
  );
  return reProbeAfterManualAction(page);
}

async function handleVerifiedLoginFormSubmission({
  capture,
  checkpoint,
  page,
  postSubmitWaitClock,
  password,
  sendInteraction,
  username,
  loginFormRoot,
}: Pick<EnsureHebSessionArgs, "page" | "sendInteraction"> & {
  readonly capture?: CaptureSession | null | undefined;
  readonly checkpoint?: SessionCheckpointFn | undefined;
  readonly loginFormRoot: Locator;
  readonly postSubmitWaitClock?: PostSubmitWaitClock | undefined;
  readonly password: string;
  readonly username: string;
}): Promise<boolean> {
  await checkpoint?.("heb-login-form-loaded");
  const submitted = await submitVerifiedLoginForm(loginFormRoot, page, username, password);
  if (!submitted) {
    return false;
  }

  const postSubmitSurface = await waitForPostSubmitAuthSurface(
    page,
    postSubmitWaitClock ?? defaultPostSubmitWaitClock(page),
    checkpoint
  );
  if (postSubmitSurface.kind === "live") {
    await checkpoint?.("heb-post-submit-live");
    return true;
  }

  if (postSubmitSurface.kind === "challenge" && postSubmitSurface.surface === "verification_code") {
    await checkpoint?.("heb-post-submit-verification-code");
    return await handleVerificationCodeSubmission({
      ...(capture ? { capture } : {}),
      checkpoint,
      page,
      postSubmitWaitClock,
      sendInteraction,
    });
  }

  await checkpoint?.("heb-manual-login-handoff");
  const recovered = await handOffToOwner({
    ...(capture ? { capture } : {}),
    page,
    sendInteraction,
    surface: postSubmitSurface.surface,
  });
  if (recovered) {
    return true;
  }

  throw new Error("heb_login_unexpected_ui");
}

async function submitVerifiedLoginForm(
  root: Locator,
  page: Page,
  username: string,
  password: string
): Promise<boolean> {
  const email = root.locator(EMAIL_SELECTOR);
  const pass = root.locator(PASSWORD_SELECTOR);
  const submit = root.locator(SUBMIT_SELECTOR);
  const emailFilled = await fillWhenUsable(page, email, username);
  if (!emailFilled) {
    return false;
  }
  const passwordFilled = await fillWhenUsable(page, pass, password);
  if (!passwordFilled) {
    return false;
  }
  const clicked = await clickWhenUsable(page, submit);
  return clicked;
}

async function submitVerificationCodeForm(root: Locator, page: Page, code: string): Promise<boolean> {
  const verificationCode = root.locator(VERIFICATION_CODE_SELECTOR);
  const codeFilled = await fillWhenUsable(page, verificationCode, code);
  if (!codeFilled) {
    return false;
  }

  const submit = root.locator(SUBMIT_SELECTOR);
  const submitCount = await countUsableCandidates(submit);
  if (submitCount > 0) {
    const clicked = await clickWhenUsable(page, submit, { timeout: 3000 });
    if (!clicked) {
      return false;
    }
    return true;
  }

  await verificationCode.first().press("Enter");
  return true;
}

async function handleVerificationCodeSubmission({
  capture,
  checkpoint,
  page,
  postSubmitWaitClock,
  sendInteraction,
}: Pick<EnsureHebSessionArgs, "page" | "sendInteraction"> & {
  readonly capture?: CaptureSession | null | undefined;
  readonly checkpoint?: SessionCheckpointFn | undefined;
  readonly postSubmitWaitClock?: PostSubmitWaitClock | undefined;
}): Promise<boolean> {
  await checkpoint?.("heb-verification-code-loaded");
  const resp = await sendInteraction({
    kind: "otp",
    message: "H-E-B sent a verification code. Reply with the code to continue signing in.",
    schema: {
      type: "object",
      properties: { code: { type: "string", pattern: "^\\d{6}$" } },
      required: ["code"],
    },
    timeout_seconds: 600,
  });
  const code = resp.status === "success" ? (resp.data?.code ?? null) : null;
  if (!code) {
    if (await probeHebSession(page)) {
      await checkpoint?.("heb-verification-code-already-live");
      return true;
    }
    throw new Error("heb_verification_code_not_provided");
  }

  const verificationCodeRoot = await resolveUniqueVerificationCodeFormRoot(page);
  if (!verificationCodeRoot) {
    throw new Error("heb_verification_code_input_missing");
  }

  const submitted = await submitVerificationCodeForm(verificationCodeRoot, page, code);
  if (!submitted) {
    throw new Error("heb_verification_code_submit_failed");
  }

  await checkpoint?.("heb-verification-code-submitted");
  const postSubmitSurface = await waitForPostSubmitAuthSurface(
    page,
    postSubmitWaitClock ?? defaultPostSubmitWaitClock(page),
    checkpoint,
    { ignoreVerificationCode: true }
  );
  if (postSubmitSurface.kind === "live") {
    await checkpoint?.("heb-post-submit-live");
    await checkpoint?.("heb-verification-code-reprobe");
    const recovered = await probeHebSession(page);
    if (!recovered) {
      throw new Error("heb_verification_code_reprobe_failed");
    }
    return true;
  }

  if (postSubmitSurface.surface === "verification_code") {
    throw new Error("heb_verification_code_not_accepted");
  }

  await checkpoint?.("heb-manual-login-handoff");
  const recovered = await handOffToOwner({
    ...(capture ? { capture } : {}),
    page,
    sendInteraction,
    surface: postSubmitSurface.surface,
  });
  if (recovered) {
    return true;
  }

  throw new Error("heb_login_unexpected_ui");
}

export async function probeHebSession(page: Page): Promise<boolean> {
  return (await probeOrdersPage(page)) === "live";
}

export async function ensureHebSession({
  capture,
  checkpoint,
  page,
  postSubmitWaitClock,
  sendInteraction,
}: EnsureHebSessionArgs): Promise<boolean> {
  await checkpoint?.("heb-auth-probe");
  if (await probeHebSession(page)) {
    await checkpoint?.("heb-session-already-live");
    return true;
  }

  const username = process.env.HEB_USERNAME;
  const password = process.env.HEB_PASSWORD;
  const loginFormRoot = await resolveUniqueLoginFormRoot(page);
  const surface = loginFormRoot ? "login_form" : await inspectAuthSurface(page);

  if (username && password && loginFormRoot) {
    const submitted = await handleVerifiedLoginFormSubmission({
      capture,
      checkpoint,
      loginFormRoot,
      page,
      postSubmitWaitClock,
      password,
      sendInteraction,
      username,
    });
    if (submitted) {
      return true;
    }
  }

  if (surface === "verification_code") {
    const recovered = await handleVerificationCodeSubmission({
      ...(capture ? { capture } : {}),
      checkpoint,
      page,
      postSubmitWaitClock,
      sendInteraction,
    });
    if (recovered) {
      return true;
    }
  }

  await checkpoint?.("heb-manual-login-handoff");
  const repairSurface: Exclude<HebAuthSurface, "live"> = surface === "live" ? "unknown" : surface;
  const recovered = await handOffToOwner({
    ...(capture ? { capture } : {}),
    page,
    sendInteraction,
    surface: repairSurface,
  });
  if (recovered) {
    return true;
  }

  throw new Error("heb_login_unexpected_ui");
}
