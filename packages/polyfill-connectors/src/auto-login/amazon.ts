/**
 * Amazon automated session management.
 *
 * Strategy:
 *   1. Probe session via deep check (navigate to /your-orders, check no
 *      signin redirect)
 *   2. If dead, drive email + password form through Amazon's two-step flow
 *   3. If 2FA prompted, emit INTERACTION kind=otp — owner replies with the
 *      code from their SMS or authenticator app
 *
 * Selectors notes (updated 2026-04-20):
 *   - Amazon's signin page has a HIDDEN autofill-hint input at
 *     `input[name="password"]#auth-credential-autofill-hint` that matches
 *     `input[name="password"]` but is not fillable. The real password input
 *     appears only after email+continue and uses `input#ap_password`. We
 *     prefer the specific ID and require visibility before filling.
 */

import type { BrowserContext, Locator, Page } from "playwright";
import { manualAction } from "../browser-handoff.ts";
import type { InteractionRequest, InteractionResponse } from "../connector-runtime.ts";
import type { CaptureSession } from "../fixture-capture.ts";

const SIGNIN_CHALLENGE_URL = /\/ap\/(signin|challenge|mfa)/;
const ORDER_URL = /\/your-orders|\/order-history/;
const TFA_PROMPT_TEXT = /verification|two.?step|authenticator|passcode|code we sent|sent a text/i;
const ORDERS_URL = "https://www.amazon.com/your-orders/orders";

interface EnsureAmazonSessionArgs {
  capture?: CaptureSession | null;
  context: BrowserContext;
  page: Page;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

async function fillWhenVisible(
  page: Page,
  locator: Locator,
  value: string,
  { timeout = 15_000 }: { timeout?: number } = {}
): Promise<boolean> {
  // Find the first visible candidate out of the locator's matches. This
  // dodges Amazon's hidden autofill-hint inputs that share name= attrs
  // with the real form field.
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const n = await locator.count().catch((): number => 0);
    for (let i = 0; i < n; i++) {
      const el = locator.nth(i);
      if (await el.isVisible().catch((): boolean => false)) {
        await el.fill(value);
        return true;
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error("no visible match for locator within timeout");
}

function isMissingVisibleFieldError(error: unknown): boolean {
  return error instanceof Error && error.message === "no visible match for locator within timeout";
}

/**
 * Probe whether the persistent profile already has a live Amazon session by
 * navigating to the orders page and confirming Amazon did not redirect to a
 * sign-in/challenge URL or render the sign-in form. Used both for the initial
 * fast path and to re-check ground truth after a manual/browser action.
 */
async function probeAmazonSession(page: Page): Promise<boolean> {
  await page
    .goto(ORDERS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    .catch((): undefined => undefined);
  await page.waitForTimeout(2500);
  const url = page.url();
  if (SIGNIN_CHALLENGE_URL.test(url)) {
    return false;
  }
  const loginForm = await page
    .locator('form[name="signIn"]')
    .first()
    .isVisible()
    .catch((): boolean => false);
  return !loginForm && ORDER_URL.test(url);
}

/**
 * Hand the unexpected/Cloudflare-or-CAPTCHA sign-in UI to the operator, then
 * re-probe the session. Returns `true` when the operator completed login in
 * the streaming companion (or on a host desktop) and the session is now
 * active; `false` when login still has not happened.
 *
 * Mirrors the reddit captcha fallback and the chatgpt/usaa manual-action
 * handoffs: completing the manual step is a *signal to re-check ground truth*,
 * not an instruction to end the run. The message never interpolates the stored
 * credentials, and the sign-in URL handed to the operator carries no secrets.
 */
async function requestManualLoginForChallenge({
  capture,
  page,
  reason,
  sendInteraction,
}: Pick<EnsureAmazonSessionArgs, "capture" | "page" | "sendInteraction"> & {
  readonly reason: string;
}): Promise<boolean> {
  await manualAction(
    {
      ...(capture ? { capture } : {}),
      page,
      reason: "captcha",
      message:
        `Amazon did not render the expected sign-in form (${reason}). ` +
        "This usually means Amazon is showing a CAPTCHA/puzzle or an approve-on-device challenge to the automated browser. " +
        "If this run opened a visible browser, complete Amazon sign-in there and respond success. " +
        "If it is headless, cancel this interaction and rerun Amazon headed (for example with PDPP_AMAZON_HEADLESS=0 on a desktop or under xvfb-run).",
      timeoutSeconds: 1800,
    },
    sendInteraction
  );
  await page.waitForTimeout(3000);
  return probeAmazonSession(page);
}

/**
 * Fill a login field that should be visible, or — when it never renders
 * (Amazon interposed a challenge) — hand off to the operator and re-probe.
 *
 * Returns:
 *   - `"filled"`     — the field was found and filled; keep driving the form.
 *   - `"recovered"`  — the field was missing, the operator completed the manual
 *                      step, and the session is now live; the caller should
 *                      return success without driving further form steps.
 * Throws `amazon_login_unexpected_ui` when the field was missing and the manual
 * step did not establish a session.
 */
async function fillOrHandleChallenge({
  capture,
  locator,
  page,
  reason,
  sendInteraction,
  value,
}: Pick<EnsureAmazonSessionArgs, "capture" | "page" | "sendInteraction"> & {
  readonly locator: Locator;
  readonly reason: string;
  readonly value: string;
}): Promise<"filled" | "recovered"> {
  try {
    await fillWhenVisible(page, locator, value);
    return "filled";
  } catch (error) {
    if (!isMissingVisibleFieldError(error)) {
      throw error;
    }
    // The expected input never became visible — Amazon is most likely serving a
    // Cloudflare/CAPTCHA/puzzle or approve-on-device challenge instead of the
    // sign-in form. Hand off to the operator and re-probe the session before
    // declaring failure, rather than crashing with a bare selector timeout.
    if (await requestManualLoginForChallenge({ ...(capture ? { capture } : {}), page, reason, sendInteraction })) {
      return "recovered";
    }
    throw new Error("amazon_login_unexpected_ui");
  }
}

export async function ensureAmazonSession({
  capture,
  context: _context,
  page,
  sendInteraction,
}: EnsureAmazonSessionArgs): Promise<boolean> {
  // Deep probe
  if (await probeAmazonSession(page)) {
    return true;
  }

  const email = process.env.AMAZON_USERNAME;
  const password = process.env.AMAZON_PASSWORD;
  if (!(email && password)) {
    throw new Error("AMAZON_USERNAME/PASSWORD not set for auto-login");
  }

  // Drive login. Navigate to the signin page explicitly; a prior page may
  // have redirected from /your-orders and not shown the email field yet.
  await page.goto(
    "https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select",
    {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }
  );
  await page.waitForTimeout(2000);

  // Email step. Observed ids (2026-04-20):
  //   - `#ap_email_login` on the new FullPageUnifiedClaim signin flow
  //   - `#ap_email` on the legacy flow (some account tiers / regions)
  // We prefer the new id first but fall back to the legacy one. We also
  // skip filling if the field already has the right value.
  const emailLoc = page.locator('input#ap_email_login, input#ap_email, input[name="email"]');
  const currentEmail = await emailLoc
    .first()
    .inputValue()
    .catch((): string => "");
  if (currentEmail !== email) {
    const emailStep = await fillOrHandleChallenge({
      ...(capture ? { capture } : {}),
      locator: emailLoc,
      page,
      reason: "sign-in form did not render",
      sendInteraction,
      value: email,
    });
    if (emailStep === "recovered") {
      return true;
    }
  }
  // Amazon's unified-claim signin page uses an unlabeled <input type="submit">
  // with aria-labelledby="continue-announce" — no stable id. Cover all shapes.
  await page
    .locator(
      'input#continue, button#continue, input[type="submit"][aria-labelledby~="continue-announce"], input[type="submit"], button[type="submit"]'
    )
    .first()
    .click()
    .catch((): undefined => undefined);
  await page.waitForTimeout(3000);

  // Password step — `#ap_password` remains stable; `input[name="password"]`
  // also matches a hidden autofill hint, so we prefer the id + require vis.
  const passwordStep = await fillOrHandleChallenge({
    ...(capture ? { capture } : {}),
    locator: page.locator("input#ap_password"),
    page,
    reason: "password form did not render",
    sendInteraction,
    value: password,
  });
  if (passwordStep === "recovered") {
    return true;
  }
  await page
    .locator('input#signInSubmit, input[type="submit"], button[type="submit"]')
    .first()
    .click()
    .catch((): undefined => undefined);
  await page.waitForTimeout(5000);

  // 2FA?
  const bodyText = (
    await page
      .locator("body")
      .innerText()
      .catch((): string => "")
  ).slice(0, 500);
  if (TFA_PROMPT_TEXT.test(bodyText)) {
    const resp = await sendInteraction({
      kind: "otp",
      message: "Amazon 2FA required. Check your phone / authenticator and reply with the code.",
      schema: {
        type: "object",
        properties: { code: { type: "string", pattern: "^\\d{4,10}$" } },
        required: ["code"],
      },
      timeout_seconds: 1800,
    });
    if (resp.status !== "success" || !resp.data?.code) {
      throw new Error("amazon_2fa_not_provided");
    }
    await fillWhenVisible(
      page,
      page.locator('input[name="otpCode"], input#auth-mfa-otpcode, input[autocomplete="one-time-code"]'),
      resp.data.code
    );
    await page
      .locator('input#auth-signin-button, button[type="submit"]')
      .first()
      .click()
      .catch((): undefined => undefined);
    await page.waitForTimeout(6000);
  }

  // Verify. If Amazon still parks us on a sign-in/challenge URL after the
  // automated flow (e.g. an approve-on-device prompt or an OTP variant whose
  // copy did not match TFA_PROMPT_TEXT), give the operator one manual/browser
  // step and re-probe before declaring the login incomplete.
  if (await probeAmazonSession(page)) {
    return true;
  }
  if (
    await requestManualLoginForChallenge({
      ...(capture ? { capture } : {}),
      page,
      reason: "automated sign-in did not complete",
      sendInteraction,
    })
  ) {
    return true;
  }
  throw new Error("amazon_login_incomplete_after_submit");
}
