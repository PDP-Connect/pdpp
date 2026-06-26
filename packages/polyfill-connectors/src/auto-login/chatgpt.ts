/**
 * ChatGPT automated session management.
 *
 * ChatGPT auth expires after ~30 days. When expired, the user must either
 * sign in via Google SSO (couldn't be fully automated without Google creds)
 * or email+password.
 *
 * Env: CHATGPT_USERNAME / CHATGPT_PASSWORD. ChatGPT has Cloudflare protection
 * and may demand 2FA (app approval or code entry).
 *
 * If auto-login fails (Cloudflare challenge, unexpected UI), fall back to
 * INTERACTION manual_action so the user can be prompted.
 */

import type { BrowserContext, Locator, Page } from "playwright";
import { manualAction } from "../browser-handoff.ts";
import type {
  AssistanceCompletionStatus,
  AssistanceRequest,
  InteractionRequest,
  InteractionResponse,
  SessionCheckpointFn,
} from "../connector-runtime.ts";
import type { CaptureSession } from "../fixture-capture.ts";
import { detectCloudflareChallenge } from "../platform-probes.ts";

interface EnsureChatGptSessionArgs {
  assist?: (req: AssistanceRequest) => Promise<string>;
  capture?: CaptureSession | null;
  /**
   * Session-establishment progress hook. The runtime resets the
   * no-progress watchdog deadline on each call. The push-approval poll calls
   * it on every iteration so a long (but progressing) wait on an external app
   * approval is not failed closed by the watchdog. Optional so call sites that
   * do not wire it (older callers, tests) still work — when absent the poll
   * simply does not advance the watchdog, matching pre-change behavior.
   */
  checkpoint?: SessionCheckpointFn;
  completeAssistance?: (
    assistanceRequestId: string,
    status: AssistanceCompletionStatus,
    extra?: { message?: string }
  ) => Promise<void>;
  context: BrowserContext;
  page: Page;
  progress?: (message: string, extra?: { stream?: string }) => Promise<void>;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

interface SessionResponse {
  user?: unknown;
}

const APPROVE_SIGN_IN_TEXT = /approve sign-in/i;
const CHATGPT_DEVICE_TEXT = /chatgpt app|your devices/i;
const CONTINUE_WITH_PASSWORD_NAME = /^continue with password$/i;
const LOG_IN_NAME = /^log in$/i;
const RESEND_PROMPT_TEXT = /resend prompt/i;
const SENT_NOTIFICATION_TEXT = /sent a notification/i;
const TRY_WITH_EMAIL_TEXT = /try with email/i;
export const CHATGPT_PUSH_APPROVAL_ASSISTANCE_MESSAGE =
  "ChatGPT sent an app approval notification. Approve it in the ChatGPT app; PDPP will continue automatically after ChatGPT confirms the session.";
export const CHATGPT_PUSH_APPROVAL_PROGRESS_MESSAGE = CHATGPT_PUSH_APPROVAL_ASSISTANCE_MESSAGE;
export const CHATGPT_PUSH_APPROVAL_FALLBACK_MESSAGE =
  "ChatGPT sent an app approval notification, but the session did not continue automatically. Approve it in the ChatGPT app if you have not already, then click Continue here.";
const PUSH_APPROVAL_POLL_INTERVAL_MS = 5000;
/**
 * Default push-approval observation budget. Raised from the original 180s
 * (36 × 5s) to 900s so realistic human app-approval latency auto-resumes via
 * the non-blocking poll instead of falling through to the blocking owner-click
 * fallback. Override with `PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS`.
 *
 * The poll checkpoints on every iteration (see `handlePushApproval`), so the
 * session-establishment watchdog is not tripped by a long-but-progressing wait
 * even though this budget exceeds the watchdog's default 120s no-progress
 * deadline.
 */
const PUSH_APPROVAL_DEFAULT_TIMEOUT_MS = 900_000;
const PUSH_APPROVAL_TIMEOUT_ENV = "PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS";

/**
 * Resolve the push-approval observation budget in ms. Honors a positive-integer
 * `PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS`; otherwise the raised default.
 */
export function resolveChatGptPushApprovalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PUSH_APPROVAL_TIMEOUT_ENV]?.trim();
  if (!raw) {
    return PUSH_APPROVAL_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!(Number.isFinite(parsed) && parsed > 0)) {
    return PUSH_APPROVAL_DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}

/** Number of poll iterations for the resolved budget (at least one). */
function pushApprovalPollAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Math.ceil(resolveChatGptPushApprovalTimeoutMs(env) / PUSH_APPROVAL_POLL_INTERVAL_MS));
}

export function chatGptPushApprovalAssistance(env: NodeJS.ProcessEnv = process.env): AssistanceRequest {
  return {
    message: CHATGPT_PUSH_APPROVAL_ASSISTANCE_MESSAGE,
    progress_posture: "running",
    owner_action: "act_elsewhere",
    response_contract: "none",
    sensitivity: "non_secret",
    timeout_seconds: Math.ceil(resolveChatGptPushApprovalTimeoutMs(env) / 1000),
  };
}

export function interactionResponseCode(resp: InteractionResponse): string | null {
  return resp.data?.code ?? resp.value ?? null;
}

function checkpointOption(checkpoint: SessionCheckpointFn | undefined): { checkpoint?: SessionCheckpointFn } {
  return checkpoint ? { checkpoint } : {};
}

async function checkSession(page: Page): Promise<boolean> {
  try {
    const r = await page.evaluate(async (): Promise<SessionResponse | null> => {
      try {
        const res = await fetch("/api/auth/session", {
          credentials: "include",
        });
        if (!res.ok) {
          return null;
        }
        const text = await res.text();
        try {
          return JSON.parse(text) as SessionResponse;
        } catch {
          return null;
        }
      } catch {
        return null;
      }
    });
    return Boolean(r?.user);
  } catch {
    return false;
  }
}

async function checkLoggedInViaDOM(page: Page): Promise<boolean> {
  try {
    return await page.evaluate((): boolean => {
      const allButtons = document.querySelectorAll("button, a");
      const hasLoginButton = Array.from(allButtons).some((el): boolean => {
        const text = el.textContent?.toLowerCase() ?? "";
        return text.includes("log in") || text.includes("sign up");
      });
      if (hasLoginButton) {
        return false;
      }
      const hasSidebar =
        !!document.querySelector('nav[aria-label="Chat history"]') ||
        !!document.querySelector('nav a[href^="/c/"]') ||
        document.querySelectorAll("nav").length > 0;
      const hasUserMenu =
        !!document.querySelector('[data-testid="profile-button"]') ||
        !!document.querySelector('button[aria-label*="User menu"]');
      return hasSidebar || hasUserMenu;
    });
  } catch {
    return false;
  }
}

export function isLikelyChatGptPushApprovalText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  const hasApproveHeading = normalized.includes("approve sign-in");
  const hasNotificationCopy = normalized.includes("sent a notification");
  const hasDeviceCopy = normalized.includes("chatgpt app") || normalized.includes("your devices");
  const hasResendPrompt = normalized.includes("resend prompt");
  const hasEmailFallback = normalized.includes("try with email");
  return (
    (hasApproveHeading && (hasNotificationCopy || hasDeviceCopy || hasResendPrompt)) ||
    (hasNotificationCopy && hasDeviceCopy) ||
    (hasResendPrompt && hasEmailFallback && (hasNotificationCopy || hasDeviceCopy))
  );
}

async function hasVisibleText(page: Page, text: RegExp): Promise<boolean> {
  try {
    await page.getByText(text).first().waitFor({ state: "visible", timeout: 500 });
    return true;
  } catch {
    return false;
  }
}

async function clickFirstVisible(locators: Locator[], timeoutMs = 1000): Promise<boolean> {
  for (const locator of locators) {
    const candidate = locator.first();
    try {
      await candidate.waitFor({ state: "visible", timeout: timeoutMs });
      await candidate.click({ timeout: timeoutMs });
      return true;
    } catch {
      // Try the next bounded, accessible locator.
    }
  }
  return false;
}

async function isLikelyChatGptPushApprovalPage(page: Page): Promise<boolean> {
  const [hasApproveHeading, hasNotificationCopy, hasDeviceCopy, hasResendPrompt, hasEmailFallback] = await Promise.all([
    hasVisibleText(page, APPROVE_SIGN_IN_TEXT),
    hasVisibleText(page, SENT_NOTIFICATION_TEXT),
    hasVisibleText(page, CHATGPT_DEVICE_TEXT),
    hasVisibleText(page, RESEND_PROMPT_TEXT),
    hasVisibleText(page, TRY_WITH_EMAIL_TEXT),
  ]);
  return (
    (hasApproveHeading && (hasNotificationCopy || hasDeviceCopy || hasResendPrompt)) ||
    (hasNotificationCopy && hasDeviceCopy) ||
    (hasResendPrompt && hasEmailFallback && (hasNotificationCopy || hasDeviceCopy))
  );
}

async function isChatGptSessionActive(page: Page): Promise<boolean> {
  return (await checkSession(page)) || (await checkLoggedInViaDOM(page));
}

async function navigateAndProbeSession(page: Page): Promise<boolean> {
  await page
    .goto("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    .catch((): undefined => undefined);
  await page.waitForTimeout(3000);

  return await checkSession(page);
}

async function openChatGptLogin(page: Page): Promise<void> {
  await page.goto("https://chatgpt.com/auth/login", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(2500);
}

async function clickIntermediateLogin(page: Page): Promise<void> {
  await clickFirstVisible([
    page.getByRole("button", { name: LOG_IN_NAME }),
    page.getByRole("link", { name: LOG_IN_NAME }),
  ]);
  await page.waitForTimeout(3000);
}

/**
 * Hand the unexpected/Cloudflare-challenge login UI to the operator, then
 * re-probe the session. Returns `true` when the operator completed login in
 * the streaming companion (or on a host desktop) and the session is now
 * active; `false` when login still has not happened.
 *
 * This mirrors `fallbackForPostSubmitLogin` and the reddit connector's
 * captcha fallback: completing the manual step is a *signal to re-check*, not
 * an instruction to end the run. Earlier this helper threw unconditionally
 * after `manualAction` resolved, so the operator's "I completed login" click
 * always ended the run even when they had just solved the challenge — the
 * message tells them to "complete login," so the connector must honor that.
 */
async function fallbackForUnexpectedLoginUi({
  capture,
  page,
  sendInteraction,
}: Pick<EnsureChatGptSessionArgs, "capture" | "page" | "sendInteraction">): Promise<boolean> {
  // EARN the diagnosis instead of guessing. We only reach this branch because
  // the expected login inputs were absent — historically we blindly blamed
  // "possibly Cloudflare challenge", which was right by luck at best. Consult the
  // shared connector-agnostic detector so the operator-facing message and the
  // interaction reason reflect what the page ACTUALLY is.
  const cf = await detectCloudflareChallenge(page);
  const message = cf.isChallenge
    ? `Cloudflare challenge confirmed (signals: ${cf.signals.join(", ")}). Complete the "Verify you are human" check in the streaming companion, then the run will resume — or rerun on a host desktop with PDPP_CHATGPT_HEADLESS=0.`
    : "ChatGPT login inputs were not found and no Cloudflare challenge was detected (the login page may have changed). Complete login in the streaming companion, or rerun on a host desktop with PDPP_CHATGPT_HEADLESS=0.";
  await manualAction(
    {
      ...(capture ? { capture } : {}),
      page,
      message,
      reason: "captcha",
      timeoutSeconds: 1800,
    },
    sendInteraction
  );
  await page.waitForTimeout(3000);
  return await isChatGptSessionActive(page);
}

/**
 * Returns `true` when login is already complete (the operator finished it in
 * the streaming companion during the unexpected-UI fallback) and the caller
 * should stop the automated flow; `false` when the connector should continue
 * driving the form. Throws `chatgpt_login_unexpected_ui` only when the
 * expected inputs never appear *and* the operator's manual step did not yield
 * an active session.
 */
async function findAndFillEmail({
  capture,
  email,
  page,
  sendInteraction,
}: Pick<EnsureChatGptSessionArgs, "capture" | "page" | "sendInteraction"> & {
  readonly email: string;
}): Promise<boolean> {
  const emailIn = page.locator('input[type="email"], input[name="username"], input[name="email"]').first();
  if (!(await emailIn.count())) {
    if (await fallbackForUnexpectedLoginUi({ ...(capture ? { capture } : {}), page, sendInteraction })) {
      return true;
    }
    throw new Error("chatgpt_login_unexpected_ui");
  }

  await emailIn.fill(email);
  await page
    .locator('button[type="submit"], :text-is("Continue")')
    .first()
    .click()
    .catch((): undefined => undefined);
  await page.waitForTimeout(3000);
  return false;
}

async function continueWithPasswordIfPresent(page: Page): Promise<void> {
  const clicked = await clickFirstVisible([
    page.getByRole("button", { name: CONTINUE_WITH_PASSWORD_NAME }),
    page.getByRole("link", { name: CONTINUE_WITH_PASSWORD_NAME }),
  ]);
  if (clicked) {
    await page.waitForTimeout(3000);
  }
}

/**
 * Drive the ChatGPT app push-approval flow. Exported for focused tests of the
 * non-blocking observation poll (watchdog checkpointing, auto-resume without an
 * interaction, and escalation ordering); production reaches it via
 * `submitPasswordAndHandleSecondFactor`.
 */
export async function handlePushApproval({
  assist,
  capture,
  checkpoint,
  completeAssistance,
  page,
  progress,
  sendInteraction,
}: Pick<
  EnsureChatGptSessionArgs,
  "assist" | "capture" | "checkpoint" | "completeAssistance" | "page" | "progress" | "sendInteraction"
>): Promise<boolean> {
  if (!(await isLikelyChatGptPushApprovalPage(page))) {
    return false;
  }

  await capture?.captureDom(page, "auth-push-approval-detected");
  let assistanceRequestId: string | null = null;
  if (assist) {
    assistanceRequestId = await assist(chatGptPushApprovalAssistance());
  } else {
    await progress?.(CHATGPT_PUSH_APPROVAL_PROGRESS_MESSAGE);
  }
  await checkpoint?.("chatgpt-push-approval-requested");
  // Non-blocking observation window: poll session readiness across the (now
  // owner-configurable) budget. The owner approves the sign-in in the ChatGPT
  // app out of band; the moment the session goes active we resolve the
  // assistance and continue — no INTERACTION, no owner click. `checkpoint` is
  // called on every iteration so the session-establishment watchdog sees
  // forward progress and does not fail the run closed even though this budget
  // exceeds its default 120s no-progress deadline (the run IS progressing — it
  // is actively probing readiness). A genuinely wedged page that hangs the
  // probe stops advancing the checkpoint, so the watchdog still catches it.
  const attempts = pushApprovalPollAttempts();
  for (let attempt = 0; attempt < attempts; attempt++) {
    await checkpoint?.("push-approval-poll");
    await page.waitForTimeout(PUSH_APPROVAL_POLL_INTERVAL_MS);
    // `assist()` is a nonblocking attention signal, not an open
    // `sendInteraction()` promise, so the runtime watchdog does not pause
    // automatically. Checkpoint sparingly while polling so a legitimate app
    // approval wait is progress, but fixture capture stays bounded.
    if ((attempt + 1) % 12 === 0) {
      await checkpoint?.(`chatgpt-push-approval-waiting-${String(attempt + 1)}`);
    }
    if (await isChatGptSessionActive(page)) {
      if (assistanceRequestId && completeAssistance) {
        await completeAssistance(assistanceRequestId, "resolved", {
          message: "The external approval completed and the connector is continuing.",
        });
      }
      await progress?.("ChatGPT app approval accepted; continuing collection.");
      return true;
    }
  }

  if (assistanceRequestId && completeAssistance) {
    await completeAssistance(assistanceRequestId, "escalated", {
      message: "External approval did not complete automatically; falling back to browser confirmation.",
    });
  }

  await manualAction(
    {
      ...(capture ? { capture } : {}),
      page,
      message: CHATGPT_PUSH_APPROVAL_FALLBACK_MESSAGE,
      reason: "2fa",
      timeoutSeconds: 1800,
    },
    sendInteraction
  );
  await page.waitForTimeout(3000);
  return await isChatGptSessionActive(page);
}

async function handleOtpIfPresent({
  page,
  sendInteraction,
}: Pick<EnsureChatGptSessionArgs, "page" | "sendInteraction">): Promise<void> {
  const tfaIn = page.locator('input[name="code"], input[type="tel"], input[inputmode="numeric"]').first();
  if (!(await tfaIn.count())) {
    return;
  }

  const resp = await sendInteraction({
    kind: "otp",
    message: "ChatGPT requires a 2FA verification code. Enter the 6-digit code:",
    timeout_seconds: 300,
  });
  const code = interactionResponseCode(resp);
  if (!code) {
    return;
  }

  await tfaIn.fill(code);
  await page
    .locator('button[type="submit"]')
    .first()
    .click()
    .catch((): undefined => undefined);
  await page.waitForTimeout(5000);
}

async function submitPasswordAndHandleSecondFactor({
  assist,
  capture,
  checkpoint,
  completeAssistance,
  page,
  password,
  progress,
  sendInteraction,
}: Pick<
  EnsureChatGptSessionArgs,
  "assist" | "capture" | "checkpoint" | "completeAssistance" | "page" | "progress" | "sendInteraction"
> & {
  readonly password: string;
}): Promise<boolean> {
  const passwordIn = page.locator('input[type="password"]').first();
  if (!(await passwordIn.count())) {
    throw new Error("chatgpt_login_no_password_field");
  }

  await passwordIn.fill(password);
  await page
    .locator('button[type="submit"], :text-is("Continue")')
    .first()
    .click()
    .catch((): undefined => undefined);
  await page.waitForTimeout(5000);
  await capture?.captureDom(page, "auth-after-password-submit");

  if (
    await handlePushApproval({
      ...(assist ? { assist } : {}),
      ...(capture ? { capture } : {}),
      ...(completeAssistance ? { completeAssistance } : {}),
      ...checkpointOption(checkpoint),
      page,
      ...(progress ? { progress } : {}),
      sendInteraction,
    })
  ) {
    return true;
  }

  await handleOtpIfPresent({ page, sendInteraction });
  return false;
}

async function waitForSubmittedLogin(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 18; attempt++) {
    await page.waitForTimeout(5000);
    if (await isChatGptSessionActive(page)) {
      return true;
    }
  }
  return false;
}

async function fallbackForPostSubmitLogin({
  capture,
  page,
  sendInteraction,
}: Pick<EnsureChatGptSessionArgs, "capture" | "page" | "sendInteraction">): Promise<boolean> {
  await manualAction(
    {
      ...(capture ? { capture } : {}),
      page,
      message:
        "ChatGPT login submitted but session still not active after 90s. Use the streaming companion to complete login (Cloudflare challenge, 2FA, etc.).",
      reason: "login",
      timeoutSeconds: 1800,
    },
    sendInteraction
  );

  await page.waitForTimeout(3000);
  return await isChatGptSessionActive(page);
}

/**
 * Drive the password form, second-factor (push approval / OTP), and the
 * post-submit confirmation / manual fallback once the login UI is present and
 * the email step has been completed. Returns `true` when the session is active;
 * throws `chatgpt_login_post_submit_failed` only when every path has been
 * exhausted without an active session. Extracted from `ensureChatGptSession`
 * to keep that entrypoint's branching legible.
 */
async function driveLoginFormAndConfirm({
  assist,
  capture,
  checkpoint,
  completeAssistance,
  page,
  password,
  progress,
  sendInteraction,
}: Pick<
  EnsureChatGptSessionArgs,
  "assist" | "capture" | "checkpoint" | "completeAssistance" | "page" | "progress" | "sendInteraction"
> & {
  readonly password: string;
}): Promise<boolean> {
  await continueWithPasswordIfPresent(page);

  if (
    await submitPasswordAndHandleSecondFactor({
      ...(assist ? { assist } : {}),
      ...(capture ? { capture } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(completeAssistance ? { completeAssistance } : {}),
      page,
      password,
      ...(progress ? { progress } : {}),
      sendInteraction,
    })
  ) {
    return true;
  }

  if (await waitForSubmittedLogin(page)) {
    return true;
  }

  if (await fallbackForPostSubmitLogin({ ...(capture ? { capture } : {}), page, sendInteraction })) {
    return true;
  }

  throw new Error("chatgpt_login_post_submit_failed");
}

export async function ensureChatGptSession({
  assist,
  capture,
  checkpoint,
  completeAssistance,
  context: _context,
  page,
  progress,
  sendInteraction,
}: EnsureChatGptSessionArgs): Promise<boolean> {
  if (await navigateAndProbeSession(page)) {
    return true;
  }

  const email = process.env.CHATGPT_USERNAME;
  const password = process.env.CHATGPT_PASSWORD;
  if (!(email && password)) {
    throw new Error("CHATGPT_USERNAME/PASSWORD not set");
  }

  await openChatGptLogin(page);
  await clickIntermediateLogin(page);
  // If the expected login UI is missing (e.g. a Cloudflare challenge), the
  // operator completes login in the streaming companion. When that succeeds we
  // stop here instead of driving the password form against an already
  // authenticated page.
  if (await findAndFillEmail({ ...(capture ? { capture } : {}), email, page, sendInteraction })) {
    return true;
  }

  return await driveLoginFormAndConfirm({
    ...(assist ? { assist } : {}),
    ...(capture ? { capture } : {}),
    ...checkpointOption(checkpoint),
    ...(completeAssistance ? { completeAssistance } : {}),
    page,
    password,
    ...(progress ? { progress } : {}),
    sendInteraction,
  });
}
