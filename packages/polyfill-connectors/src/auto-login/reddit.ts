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
import { manualAction } from "../browser-handoff.ts";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";

const LOGIN_URL = "https://www.reddit.com/login/";
const HOME_URL = "https://www.reddit.com/";
const SESSION_COOKIE_NAME = "reddit_session";
const USERNAME_SELECTOR = 'input[name="username"], input#loginUsername';
const PASSWORD_SELECTOR = 'input[name="password"], input#loginPassword';
const SUBMIT_SELECTOR = 'button[type="submit"]:has-text("Log In"), button[type="submit"]:has-text("Continue")';
const OTP_SELECTOR = 'input[name="otp"], input[name="verification_code"], input[autocomplete="one-time-code"]';

type SendInteraction = (req: InteractionRequest) => Promise<InteractionResponse>;

interface EnsureRedditSessionArgs {
  context: BrowserContext;
  page: Page;
  sendInteraction: SendInteraction;
}

function otpCode(resp: InteractionResponse): string | null {
  return resp.data?.code ?? resp.value ?? null;
}

async function hasSessionCookie(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies(HOME_URL);
  return cookies.some((c) => c.name === SESSION_COOKIE_NAME && Boolean(c.value));
}

/**
 * Confirm the session cookie actually grants access — a stale cookie may
 * still exist after logout. Hit old.reddit.com (stable markup) and look for
 * the logout link, which is only rendered when authenticated.
 */
async function isSessionLive(page: Page): Promise<boolean> {
  try {
    await page.goto("https://old.reddit.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const logout = await page.locator('a[href*="/logout"], form[action*="logout"]').count();
    return logout > 0;
  } catch {
    return false;
  }
}

export async function ensureRedditSession({ context, page, sendInteraction }: EnsureRedditSessionArgs): Promise<void> {
  if ((await hasSessionCookie(context)) && (await isSessionLive(page))) {
    return;
  }

  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;
  if (!(username && password)) {
    throw new Error("reddit_creds_missing: set REDDIT_USERNAME and REDDIT_PASSWORD in .env.local");
  }

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((): undefined => undefined);

  const userIn = page.locator(USERNAME_SELECTOR).first();
  if (!(await userIn.count().catch(() => 0))) {
    // Cloudflare challenge, shadow DOM change, or redirect loop — hand off.
    await manualAction(
      {
        page,
        reason: "captcha",
        message:
          "Reddit login page did not render expected inputs (possible Cloudflare challenge). Log in to reddit.com in the browser window and re-run.",
        timeoutSeconds: 1800,
      },
      sendInteraction
    );
    if (!(await isSessionLive(page))) {
      throw new Error("reddit_login_unexpected_ui");
    }
    return;
  }

  await userIn.fill(username);
  await page.locator(PASSWORD_SELECTOR).first().fill(password);
  await page
    .locator(SUBMIT_SELECTOR)
    .first()
    .click()
    .catch((): undefined => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);

  // 2FA: Reddit shows a separate OTP step when 2FA is enabled on the account.
  const otpIn = page.locator(OTP_SELECTOR).first();
  if (await otpIn.count().catch(() => 0)) {
    const resp = await sendInteraction({
      kind: "otp",
      message: "Reddit requires a 2FA verification code. Enter the 6-digit code from your authenticator app or SMS:",
      timeout_seconds: 300,
    });
    const code = otpCode(resp);
    if (!code) {
      throw new Error("reddit_2fa_cancelled");
    }
    await otpIn.fill(code);
    await page
      .locator('button[type="submit"]')
      .first()
      .click()
      .catch((): undefined => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch((): null => null);
  }

  // Poll up to 90s — Reddit may redirect through interstitials before the
  // session cookie is written.
  for (let attempt = 0; attempt < 18; attempt++) {
    if ((await hasSessionCookie(context)) && (await isSessionLive(page))) {
      return;
    }
    await page.waitForTimeout(5000);
  }

  throw new Error("reddit_login_post_submit_failed");
}
