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
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import type { CaptureSession } from "../fixture-capture.ts";

interface EnsureChatGptSessionArgs {
  capture?: CaptureSession | null;
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
export const CHATGPT_PUSH_APPROVAL_PROGRESS_MESSAGE =
  "ChatGPT sent an app approval notification. Approve it in the ChatGPT app; PDPP will continue automatically after ChatGPT confirms the session.";
export const CHATGPT_PUSH_APPROVAL_FALLBACK_MESSAGE =
  "ChatGPT sent an app approval notification, but the session did not continue automatically. Approve it in the ChatGPT app if you have not already, then click Continue here.";
const PUSH_APPROVAL_POLL_ATTEMPTS = 36;
const PUSH_APPROVAL_POLL_INTERVAL_MS = 5000;

export function interactionResponseCode(resp: InteractionResponse): string | null {
  return resp.data?.code ?? resp.value ?? null;
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

async function fallbackForUnexpectedLoginUi({
  capture,
  page,
  sendInteraction,
}: Pick<EnsureChatGptSessionArgs, "capture" | "page" | "sendInteraction">): Promise<never> {
  await manualAction(
    {
      ...(capture ? { capture } : {}),
      page,
      message:
        "ChatGPT auto-login UI is unexpected (possibly Cloudflare challenge). Use the streaming companion to complete login, or rerun on a host desktop with PDPP_CHATGPT_HEADLESS=0.",
      reason: "captcha",
      timeoutSeconds: 1800,
    },
    sendInteraction
  );
  throw new Error("chatgpt_login_unexpected_ui");
}

async function findAndFillEmail({
  capture,
  email,
  page,
  sendInteraction,
}: Pick<EnsureChatGptSessionArgs, "capture" | "page" | "sendInteraction"> & {
  readonly email: string;
}): Promise<void> {
  const emailIn = page.locator('input[type="email"], input[name="username"], input[name="email"]').first();
  if (!(await emailIn.count())) {
    await fallbackForUnexpectedLoginUi({ ...(capture ? { capture } : {}), page, sendInteraction });
  }

  await emailIn.fill(email);
  await page
    .locator('button[type="submit"], :text-is("Continue")')
    .first()
    .click()
    .catch((): undefined => undefined);
  await page.waitForTimeout(3000);
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

async function handlePushApproval({
  capture,
  page,
  progress,
  sendInteraction,
}: Pick<EnsureChatGptSessionArgs, "capture" | "page" | "progress" | "sendInteraction">): Promise<boolean> {
  if (!(await isLikelyChatGptPushApprovalPage(page))) {
    return false;
  }

  await capture?.captureDom(page, "auth-push-approval-detected");
  await progress?.(CHATGPT_PUSH_APPROVAL_PROGRESS_MESSAGE);
  for (let attempt = 0; attempt < PUSH_APPROVAL_POLL_ATTEMPTS; attempt++) {
    await page.waitForTimeout(PUSH_APPROVAL_POLL_INTERVAL_MS);
    if (await isChatGptSessionActive(page)) {
      await progress?.("ChatGPT app approval accepted; continuing collection.");
      return true;
    }
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
  capture,
  page,
  password,
  progress,
  sendInteraction,
}: Pick<EnsureChatGptSessionArgs, "capture" | "page" | "progress" | "sendInteraction"> & {
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
      ...(capture ? { capture } : {}),
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

export async function ensureChatGptSession({
  capture,
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
  await findAndFillEmail({ ...(capture ? { capture } : {}), email, page, sendInteraction });
  await continueWithPasswordIfPresent(page);

  if (
    await submitPasswordAndHandleSecondFactor({
      ...(capture ? { capture } : {}),
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
