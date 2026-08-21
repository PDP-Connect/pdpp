// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * H-E-B automated session management.
 *
 * Strategy:
 *   1. Probe the live orders page first.
 *   2. If dead and stored sign-in details are present, fill the verified login
 *      form only, submit it, and wait for a bounded post-submit state change
 *      before re-checking the session.
 *   3. If H-E-B shows the post-authentication passkey-enrollment upsell,
 *      decline it automatically and keep waiting for the live session. This
 *      screen is not a challenge: sign-in has already succeeded behind it.
 *   4. If H-E-B shows a verification-code page, emit the shared OTP
 *      interaction, fill and submit the code, then re-probe the live session.
 *   5. If H-E-B shows passkey, CAPTCHA, Incapsula, or any other unexpected
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
const POST_SUBMIT_TIMEOUT_MS = 12_000;
const FIELD_TIMEOUT_MS = 15_000;
const EMAIL_SELECTOR =
  'input[name="email"], input[type="email"], input[autocomplete="username"], input[name="username"]';
const PASSWORD_SELECTOR = 'input[name="password"], input[type="password"], input[autocomplete="current-password"]';
const SUBMIT_SELECTOR = 'button[type="submit"], input[type="submit"]';
const VERIFICATION_CODE_SELECTOR =
  'input[name="code"], input[name="otp"], input[name="verification_code"], input[autocomplete="one-time-code"]';
const VERIFY_SUBMIT_TEXT_RE = /\b(verify|continue|submit)\b/i;
const MAX_SPLIT_CODE_DIGITS = 8;
/**
 * Bounds the decline retries. H-E-B may re-render the screen once after the
 * click; more than that means the decline is not taking effect and the run
 * must stop with an honest error rather than spin.
 */
const MAX_PASSKEY_DECLINE_ATTEMPTS = 3;
const PASSKEY_RE = /\bpasskey\b/i;
/**
 * The post-authentication passkey-enrollment upsell. H-E-B's OIDC provider
 * serves it at `/interaction/<id>/passkey_registration` on accounts.heb.com;
 * the path segment is the route name, so it is far more durable than the
 * marketing copy on the page ("Skip the password", "You can now use passkeys
 * to log in"), which H-E-B rewords freely.
 *
 * Deliberately matched against the URL only, never the body: every regex in
 * this module runs over raw `page.content()`, and a marketing-copy match there
 * can fire on invisible framework payload (embedded JSON, script chunks) on
 * pages that are not this screen at all. The URL is the one signal that cannot
 * be spoofed by page text.
 */
const PASSKEY_ENROLLMENT_URL_RE = /^https:\/\/accounts\.heb\.com\/interaction\/[^/]+\/passkey_registration\b/i;
/**
 * The decline control. Requiring a real, visible, enabled match keeps the
 * automatic decline honest: if H-E-B ever turns this route into something
 * mandatory, the run stops with a named error instead of clicking blind or
 * inventing an OTP. Text-matched because the button carries no stable
 * id/data-testid; scoped to `button`/`a`/`[role=button]` so it cannot match
 * body prose. Anchored (`^...$`) so it matches the control's own label rather
 * than any element that merely contains the words.
 */
const PASSKEY_DECLINE_SELECTOR = 'button, a, [role="button"], input[type="button"]';
const PASSKEY_DECLINE_TEXT_RE = /^\s*(not now|skip|maybe later|no thanks)\s*$/i;
/**
 * Copy that ACCOMPANIES a code-entry screen. Necessary but never sufficient:
 * H-E-B's own login form carries the string "Email me a one-time code" as the
 * label of a radio button that merely OFFERS to send one, so this pattern
 * matches the plain sign-in page too. See `hasUsableVerificationCodeInput`.
 */
const VERIFICATION_CODE_RE = /\b(verification code|security code|one[- ]time code|code sent)\b/i;
const CAPTCHA_RE = /\b(captcha|verify you are human|security check)\b/i;
const AUTHENTICATED_ORDERS_EVIDENCE_RE = /data-qe-id="orderResults"|data-testid="no-orders-message"/i;
const LOGIN_FORM_SELECTOR = "form";
/**
 * H-E-B's promotional "what's new" interstitial.
 *
 * This is not an auth surface at all. It is a marketing announcement portaled
 * to `<body>` — OUTSIDE the Next.js root — over an already-authenticated page.
 * It steals focus and covers the order content, which is exactly why the run
 * that hit it asked the owner to sign in when no sign-in was needed.
 *
 * Keyed on `data-component` + the ARIA dialog contract, never on the CSS-module
 * class names beside them: `ModalContainers_modalContent__o_tcp` carries a build
 * hash that rotates on every H-E-B deploy. The copy is off-limits for the same
 * reason it always is — it is marketing text, it is localized, and the
 * `WhatsNewModal_` chassis is a GENERIC slot that will carry entirely different
 * words next month with this identical structure.
 */
const INTERSTITIAL_DIALOG_SELECTOR = '[data-component="modal-content"][role="dialog"][aria-modal="true"]';
/**
 * The dismissal control. `data-qe-id` is H-E-B's own QA-engineering hook and is
 * the most durable handle on the page. Its accessible name is "Close Modal",
 * not "Close" — matched structurally here so the label never has to be.
 */
const INTERSTITIAL_CLOSE_SELECTOR = '[data-qe-id="modalClose"]';
/**
 * Bounds the dismissal retries. One interstitial may be queued behind another,
 * but a control that keeps not taking effect means the page is not what this
 * code thinks it is, and the run must stop rather than spin.
 */
const MAX_INTERSTITIAL_DISMISS_ATTEMPTS = 3;

export type HebAuthSurface =
  | "live"
  | "login_form"
  | "passkey"
  | "passkey_enrollment"
  | "verification_code"
  | "captcha"
  | "incapsula"
  | "unknown";

interface EnsureHebSessionArgs {
  capture?: CaptureSession | null;
  checkpoint?: SessionCheckpointFn;
  onCredentialSubmit?: () => void;
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
  for (let i = 0; i < count; i += 1) {
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
    for (let i = 0; i < count; i += 1) {
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
    for (let i = 0; i < count; i += 1) {
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

/**
 * Whether this form root is H-E-B's login form.
 *
 * The bar is one visible email input and one visible submit control. The
 * password field is counted but NOT required to be visible, because H-E-B
 * serves an email-first variant of this form: the password input is present in
 * the DOM from first paint, parked inside
 *
 *   <fieldset aria-hidden="true" tabindex="-1" class="... overflow-hidden w-0 h-0">
 *
 * A `w-0 h-0 overflow-hidden` ancestor has a zero bounding box, so Playwright
 * reports every descendant as not visible. Requiring a VISIBLE password input
 * therefore rejected an ordinary, unambiguous login form — the owner was told
 * "H-E-B did not render the expected login form" while looking at H-E-B's login
 * form. See `connectors/heb/__fixtures__/email-first-login-page.html`.
 *
 * Requiring a password input to EXIST still distinguishes this form from the
 * other single-field pages in the flow (forgot-password, register, the OTP
 * entry screen), none of which carry a password input at all.
 * `submitVerifiedLoginForm` remains responsible for whether the field can
 * actually be FILLED; that is a separate question from what this surface IS,
 * and it fails honestly on its own when the answer is no.
 *
 * The two-clause password rule is deliberate. When a password field IS on
 * screen, exactly one must be — more than one visible password input is
 * genuine ambiguity and stays fail-closed, which is what keeps the
 * hidden-and-disabled-distractor guarantee intact. Only when NONE is visible
 * does mere presence suffice, because that is precisely the email-first state.
 */
async function countsMatchLoginForm(root: Locator): Promise<boolean> {
  const emailCount = await countUsableCandidates(root.locator(EMAIL_SELECTOR));
  if (emailCount !== 1) {
    return false;
  }
  const submitCount = await countUsableCandidates(root.locator(SUBMIT_SELECTOR));
  if (submitCount !== 1) {
    return false;
  }
  const passwordLocator = root.locator(PASSWORD_SELECTOR);
  const visiblePasswordCount = await countUsableCandidates(passwordLocator);
  if (visiblePasswordCount > 0) {
    return visiblePasswordCount === 1;
  }
  const presentPasswordCount = await passwordLocator.count().catch((): number => 0);
  return presentPasswordCount > 0;
}

async function resolveUniqueLoginFormRoot(page: Page): Promise<Locator | null> {
  const forms = page.locator(LOGIN_FORM_SELECTOR);
  const count = await forms.count().catch((): number => 0);
  let resolved: Locator | null = null;
  let viableRoots = 0;

  for (let i = 0; i < count; i += 1) {
    const root = forms.nth(i);
    const [visible, enabled] = await Promise.all([
      root.isVisible().catch((): boolean => false),
      root.isEnabled().catch((): boolean => false),
    ]);
    if (!(visible && enabled)) {
      continue;
    }
    if (await countsMatchLoginForm(root)) {
      viableRoots += 1;
      resolved = root;
      if (viableRoots > 1) {
        return null;
      }
    }
  }

  return viableRoots === 1 ? resolved : null;
}

function isViableVerificationCodeDigitCount(codeCount: number): boolean {
  return codeCount === 1 || (codeCount > 1 && codeCount <= MAX_SPLIT_CODE_DIGITS);
}

async function resolveUniqueVerificationCodeFormRoot(page: Page): Promise<Locator | null> {
  const forms = page.locator(LOGIN_FORM_SELECTOR);
  const count = await forms.count().catch((): number => 0);
  let resolved: Locator | null = null;
  let viableRoots = 0;

  for (let i = 0; i < count; i += 1) {
    const root = forms.nth(i);
    const [visible, enabled] = await Promise.all([
      root.isVisible().catch((): boolean => false),
      root.isEnabled().catch((): boolean => false),
    ]);
    if (!(visible && enabled)) {
      continue;
    }
    const codeCount = await countUsableCandidates(root.locator(VERIFICATION_CODE_SELECTOR));
    if (isViableVerificationCodeDigitCount(codeCount)) {
      viableRoots += 1;
      resolved = root;
      if (viableRoots > 1) {
        return null;
      }
    }
  }

  return viableRoots === 1 ? resolved : null;
}

function isPasskeyEnrollmentUrl(url: string): boolean {
  return PASSKEY_ENROLLMENT_URL_RE.test(url);
}

/**
 * Resolve the visible, enabled "Not now" control on the passkey-enrollment
 * screen. Returns `null` when the screen has no usable decline control, which
 * is what keeps this fail-closed rather than fail-open.
 */
async function resolvePasskeyDeclineControl(page: Page): Promise<Locator | null> {
  const candidates = page.locator(PASSKEY_DECLINE_SELECTOR);
  const count = await candidates.count().catch((): number => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    const [visible, enabled, text] = await Promise.all([
      candidate.isVisible().catch((): boolean => false),
      candidate.isEnabled().catch((): boolean => false),
      candidate.innerText().catch((): string => ""),
    ]);
    if (!(visible && enabled)) {
      continue;
    }
    // Only an exact decline label is actionable. "Add passkey" cannot match
    // this anchored pattern, so the enroll control is unreachable by
    // construction — no separate enroll denylist is needed.
    if (PASSKEY_DECLINE_TEXT_RE.test(text)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Whether this page can actually ACCEPT a code right now.
 *
 * This is the evidence that makes a `verification_code` classification honest.
 * Prompting the owner for a code commits them to fetching a secret out of
 * band, so the bar is a real, visible, enabled code input — one field, or the
 * split per-digit layout H-E-B also uses. Text is not evidence: a radio label
 * reading "Email me a one-time code" is an OFFER to send one, and no code has
 * been dispatched at the moment it is on screen.
 */
async function hasUsableVerificationCodeInput(page: Page): Promise<boolean> {
  const digitCount = await countUsableCandidates(page.locator(VERIFICATION_CODE_SELECTOR));
  return isViableVerificationCodeDigitCount(digitCount);
}

/**
 * Page-aware because `verification_code` is gated on a real code input rather
 * than on copy alone. `passkey` and `captcha` stay text/URL-keyed: both route
 * to a human handoff, so a false positive there costs an unnecessary browser
 * handoff, not a demand for a secret that does not exist.
 */
async function classifyChallengeSurface(
  page: Page,
  url: string,
  html: string
): Promise<Exclude<HebAuthSurface, "live" | "login_form" | "unknown"> | null> {
  if (PASSKEY_RE.test(html) || PASSKEY_RE.test(url)) {
    return "passkey";
  }
  if (
    (VERIFICATION_CODE_RE.test(html) || VERIFICATION_CODE_RE.test(url)) &&
    (await hasUsableVerificationCodeInput(page))
  ) {
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

/**
 * Whether a promotional interstitial is currently covering the page.
 *
 * Requires a visible, enabled dismissal control, not merely a dialog node in
 * the DOM. H-E-B leaves collapsed modal containers parked in the markup, and a
 * dialog this code cannot actually close is not one it should claim to handle —
 * it must fall through to classification like any other unrecognized surface.
 */
async function hasDismissibleInterstitial(page: Page): Promise<boolean> {
  const dialogs = await page
    .locator(INTERSTITIAL_DIALOG_SELECTOR)
    .count()
    .catch((): number => 0);
  if (dialogs === 0) {
    return false;
  }
  return (await countUsableCandidates(page.locator(INTERSTITIAL_CLOSE_SELECTOR))) > 0;
}

/**
 * Dismiss the promotional interstitial covering an authenticated page.
 *
 * Deliberately silent from the owner's point of view: closing a marketing
 * announcement is not a decision that needs a human, and asking for one was the
 * defect. Returns `false` when the overlay outlives its dismissals so the caller
 * classifies the page normally instead of assuming success.
 */
async function dismissInterstitials(page: Page, checkpoint?: SessionCheckpointFn): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_INTERSTITIAL_DISMISS_ATTEMPTS; attempt += 1) {
    if (!(await hasDismissibleInterstitial(page))) {
      return true;
    }
    await checkpoint?.("heb-interstitial-dismissing");
    const clicked = await clickWhenUsable(page, page.locator(INTERSTITIAL_CLOSE_SELECTOR), {
      timeout: POST_SUBMIT_POLL_INTERVAL_MS,
    });
    if (!clicked) {
      return false;
    }
    await page.waitForTimeout(POST_SUBMIT_POLL_INTERVAL_MS);
  }
  return !(await hasDismissibleInterstitial(page));
}

/**
 * Names what was actually observed. Deliberately distinct per reason so an
 * operator can tell "the button was gone" from "the click did not stick".
 */
function passkeyEnrollmentDeclineError(reason: "control_unavailable" | "still_on_enrollment_page"): string {
  return reason === "control_unavailable"
    ? "heb_passkey_enrollment_decline_control_missing"
    : "heb_passkey_enrollment_decline_ineffective";
}

/**
 * What the classifier could see, for the honest-unknown message.
 *
 * Structural facts only — no page text, no account content. The URL and title
 * are H-E-B's own routing and chrome, which is what makes them useful to an
 * owner deciding what to do next and safe to show.
 */
interface UnknownSurfaceObservation {
  readonly hasDialog: boolean;
  readonly hasPasswordInput: boolean;
  readonly title: string;
  readonly url: string;
}

async function observeUnknownSurface(page: Page): Promise<UnknownSurfaceObservation> {
  const [title, dialogCount, passwordCount] = await Promise.all([
    page.title().catch((): string => ""),
    page
      .locator(INTERSTITIAL_DIALOG_SELECTOR)
      .count()
      .catch((): number => 0),
    page
      .locator(PASSWORD_SELECTOR)
      .count()
      .catch((): number => 0),
  ]);
  return {
    hasDialog: dialogCount > 0,
    hasPasswordInput: passwordCount > 0,
    title,
    url: page.url(),
  };
}

/**
 * The honest unknown.
 *
 * The old copy asserted a specific cause — "H-E-B did not render the expected
 * login form" — for every surface the classifier failed to recognize. Two
 * different live pages hit it within minutes: a promo overlay on an already
 * signed-in session, where no login was needed at all, and a perfectly ordinary
 * login form. Both owners were told the same wrong thing and had to guess.
 *
 * So this says what was seen and admits what it does not know. A confident
 * wrong cause is worse than an accurate "PDPP could not classify this": the
 * owner is the one looking at the screen, and they can act on a description far
 * better than on a misdiagnosis.
 */
function unknownSurfaceMessage(observed: UnknownSurfaceObservation): string {
  const sawParts = [
    observed.hasPasswordInput ? "a password field" : "no password field",
    observed.hasDialog ? "a dialog overlay" : "no dialog overlay",
  ];
  const titlePart = observed.title ? ` titled “${observed.title}”` : "";
  return (
    `PDPP could not identify what H-E-B is showing. The page at ${observed.url}${titlePart} ` +
    `had ${sawParts.join(" and ")}, which does not match any surface PDPP recognizes. ` +
    "Open the secure browser, do whatever the page actually asks for, then continue. " +
    "PDPP will re-check the session afterward."
  );
}

function manualLoginMessage(surface: Exclude<HebAuthSurface, "live">): string {
  switch (surface) {
    case "login_form":
      return "H-E-B did not finish signing in automatically. Complete the sign-in form in the secure browser, then continue. PDPP will re-check the session afterward.";
    case "passkey":
      return "H-E-B is asking for a passkey. Complete the prompt in the secure browser, then continue. PDPP will re-check the session afterward.";
    case "passkey_enrollment":
      return "H-E-B is offering to set up a passkey and PDPP could not decline it automatically. Choose “Not now” in the secure browser, then continue. PDPP will re-check the session afterward.";
    case "verification_code":
      return "H-E-B is asking for a verification code. Enter it in the secure browser, then continue. PDPP will re-check the session afterward.";
    case "captcha":
      return "H-E-B is showing a CAPTCHA. Complete it in the secure browser, then continue. PDPP will re-check the session afterward.";
    case "incapsula":
      return "H-E-B is showing an Imperva Incapsula challenge. Complete it in the secure browser, then continue. PDPP will re-check the session afterward.";
    default:
      // `unknown` never reaches here: it routes through `unknownSurfaceMessage`,
      // which describes the page instead of asserting a cause. Keeping this
      // branch total-but-unreachable means a NEW surface added to the union
      // fails typecheck at the switch rather than silently inheriting someone
      // else's copy — which is how both misleading messages happened.
      return unknownSurfaceMessage({ hasDialog: false, hasPasswordInput: false, title: "", url: "" });
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
  // Checked before challenge classification: this screen is post-authentication
  // and must never reach the verification-code (OTP) branch. Keyed on the OIDC
  // route only; whether a usable "Not now" exists is decided at click time so a
  // missing control surfaces as its own error rather than as `unknown`.
  if (isPasskeyEnrollmentUrl(url)) {
    return "passkey_enrollment";
  }
  const challengeSurface = await classifyChallengeSurface(page, url, html);
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
  // Checked before challenge classification: this screen is post-authentication
  // and must never reach the verification-code (OTP) branch. Keyed on the OIDC
  // route only; whether a usable "Not now" exists is decided at click time so a
  // missing control surfaces as its own error rather than as `unknown`.
  if (isPasskeyEnrollmentUrl(url)) {
    return "passkey_enrollment";
  }
  const challengeSurface = await classifyChallengeSurface(page, url, html);
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

async function probeOrdersPage(page: Page, checkpoint?: SessionCheckpointFn): Promise<HebAuthSurface> {
  await page
    .goto(ORDERS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
    .catch((): undefined => undefined);
  await page.waitForTimeout(SESSION_PROBE_WAIT_MS);
  // Clear promotional overlays BEFORE classifying. An interstitial is not an
  // auth surface, and leaving one up made a live session look like a broken
  // one. Dismissal failure is deliberately not fatal: the classifier then reads
  // the page as it actually is and reports an honest unknown if it must.
  await dismissInterstitials(page, checkpoint);
  return inspectAuthSurface(page);
}

async function reProbeAfterManualAction(page: Page, checkpoint?: SessionCheckpointFn): Promise<boolean> {
  return (await probeOrdersPage(page, checkpoint)) === "live";
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
  | { kind: "passkey_enrollment_decline_failed"; reason: "control_unavailable" | "still_on_enrollment_page" }
  | { kind: "timeout"; surface: Exclude<HebAuthSurface, "live"> };

/**
 * Click the "Not now" control on the passkey-enrollment screen. Returns
 * `false` when no usable decline control is present so the caller can fail
 * with an honest error rather than falling through to another surface.
 */
async function declinePasskeyEnrollment(page: Page): Promise<boolean> {
  const decline = await resolvePasskeyDeclineControl(page);
  if (!decline) {
    return false;
  }
  return await decline
    .click()
    .then((): boolean => true)
    .catch((): boolean => false);
}

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
  let declineAttempts = 0;
  let observedUrl = page.url();
  let observedHtml = await page.content().catch((): string => "");

  await checkpoint?.("heb-post-submit-await-transition");

  while (clock.now() - startedAt <= POST_SUBMIT_TIMEOUT_MS) {
    const surface = await inspectPostSubmitAuthSurface(page);
    if (surface === "live") {
      return { kind: "live" };
    }
    // Sign-in already succeeded behind this upsell. Decline it and keep waiting
    // for the live session instead of treating it as a challenge. A failed or
    // ineffective decline is reported as its own outcome — never as an OTP
    // prompt, which is the defect this branch exists to prevent.
    if (surface === "passkey_enrollment") {
      await checkpoint?.("heb-passkey-enrollment-declining");
      const declined = await declinePasskeyEnrollment(page);
      if (!declined) {
        return { kind: "passkey_enrollment_decline_failed", reason: "control_unavailable" };
      }
      await checkpoint?.("heb-passkey-enrollment-declined");
      declineAttempts += 1;
      if (declineAttempts > MAX_PASSKEY_DECLINE_ATTEMPTS) {
        return { kind: "passkey_enrollment_decline_failed", reason: "still_on_enrollment_page" };
      }
      await clock.wait(POST_SUBMIT_POLL_INTERVAL_MS);
      continue;
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
  checkpoint,
  page,
  sendInteraction,
  surface,
}: Pick<EnsureHebSessionArgs, "capture" | "page" | "sendInteraction"> & {
  readonly checkpoint?: SessionCheckpointFn | undefined;
  readonly surface: Exclude<HebAuthSurface, "live">;
}): Promise<boolean> {
  let message: string;
  if (surface === "unknown") {
    const observed = await observeUnknownSurface(page);
    // Make the classifier's failure VISIBLE. A surface that silently defaults
    // forever never gets fixed; this checkpoint is the record that says which
    // page shape H-E-B served that PDPP could not name.
    await checkpoint?.("heb-unclassified-surface");
    message = unknownSurfaceMessage(observed);
  } else {
    message = manualLoginMessage(surface);
  }
  await manualAction(
    {
      ...(capture ? { capture } : {}),
      message,
      page,
      reason: "login",
      timeoutSeconds: 1800,
    },
    sendInteraction
  );
  return reProbeAfterManualAction(page, checkpoint);
}

async function handleVerifiedLoginFormSubmission({
  capture,
  checkpoint,
  onCredentialSubmit,
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
  readonly onCredentialSubmit?: (() => void) | undefined;
  readonly postSubmitWaitClock?: PostSubmitWaitClock | undefined;
  readonly password: string;
  readonly username: string;
}): Promise<boolean> {
  await checkpoint?.("heb-login-form-loaded");
  const submitted = await submitVerifiedLoginForm(loginFormRoot, page, username, password);
  if (!submitted) {
    return false;
  }
  onCredentialSubmit?.();

  const postSubmitSurface = await waitForPostSubmitAuthSurface(
    page,
    postSubmitWaitClock ?? defaultPostSubmitWaitClock(page),
    checkpoint
  );
  if (postSubmitSurface.kind === "live") {
    await checkpoint?.("heb-post-submit-live");
    return true;
  }

  if (postSubmitSurface.kind === "passkey_enrollment_decline_failed") {
    await checkpoint?.("heb-passkey-enrollment-decline-failed");
    throw new Error(passkeyEnrollmentDeclineError(postSubmitSurface.reason));
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
    checkpoint,
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

async function fillSplitVerificationCodeDigits(
  page: Page,
  verificationCode: Locator,
  digits: string,
  digitCount: number
): Promise<boolean> {
  if (digits.length !== digitCount) {
    return false;
  }
  for (let i = 0; i < digitCount; i += 1) {
    const filled = await fillWhenUsable(page, verificationCode.nth(i), digits[i] ?? "", { timeout: 3000 });
    if (!filled) {
      return false;
    }
  }
  return true;
}

async function clickVerifySubmit(page: Page, submit: Locator): Promise<boolean> {
  const count = await submit.count().catch((): number => 0);
  const start = Date.now();
  while (Date.now() - start < 3000) {
    for (let i = 0; i < count; i += 1) {
      const candidate = submit.nth(i);
      const [visible, enabled, text] = await Promise.all([
        candidate.isVisible().catch((): boolean => false),
        candidate.isEnabled().catch((): boolean => false),
        candidate.innerText().catch((): string => ""),
      ]);
      if (visible && enabled && VERIFY_SUBMIT_TEXT_RE.test(text)) {
        await candidate.click();
        return true;
      }
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function submitVerificationCodeForm(root: Locator, page: Page, code: string): Promise<boolean> {
  const verificationCode = root.locator(VERIFICATION_CODE_SELECTOR);
  const codeCount = await countUsableCandidates(verificationCode);

  const codeFilled =
    codeCount > 1
      ? await fillSplitVerificationCodeDigits(page, verificationCode, code, codeCount)
      : await fillWhenUsable(page, verificationCode, code);
  if (!codeFilled) {
    return false;
  }

  const submit = root.locator(SUBMIT_SELECTOR);
  const submitCount = await countUsableCandidates(submit);
  if (submitCount > 1) {
    return await clickVerifySubmit(page, submit);
  }
  if (submitCount === 1) {
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
  // Last line of defense before the owner is asked for a secret. Classification
  // already required a usable code input, but this path is reachable from two
  // callers, so the precondition is re-checked at the one place that actually
  // spends the owner's attention. Failing here is named and loud; the run must
  // never fabricate an OTP prompt for a page that cannot accept a code.
  if (!(await hasUsableVerificationCodeInput(page))) {
    throw new Error("heb_verification_code_input_missing");
  }
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

  const waitClock = postSubmitWaitClock ?? defaultPostSubmitWaitClock(page);
  const verificationCodeRoot = await waitForUniqueVerificationCodeFormRoot(page, waitClock);
  if (!verificationCodeRoot) {
    throw new Error("heb_verification_code_input_missing");
  }

  const submitted = await submitVerificationCodeForm(verificationCodeRoot, page, code);
  if (!submitted) {
    throw new Error("heb_verification_code_submit_failed");
  }

  await checkpoint?.("heb-verification-code-submitted");
  const postSubmitSurface = await waitForPostSubmitAuthSurface(page, waitClock, checkpoint, {
    ignoreVerificationCode: true,
  });
  if (postSubmitSurface.kind === "live") {
    await checkpoint?.("heb-post-submit-live");
    await checkpoint?.("heb-verification-code-reprobe");
    const recovered = await probeHebSession(page);
    if (!recovered) {
      throw new Error("heb_verification_code_reprobe_failed");
    }
    return true;
  }

  if (postSubmitSurface.kind === "passkey_enrollment_decline_failed") {
    await checkpoint?.("heb-passkey-enrollment-decline-failed");
    throw new Error(passkeyEnrollmentDeclineError(postSubmitSurface.reason));
  }

  if (postSubmitSurface.surface === "verification_code") {
    throw new Error("heb_verification_code_not_accepted");
  }

  await checkpoint?.("heb-manual-login-handoff");
  const recovered = await handOffToOwner({
    ...(capture ? { capture } : {}),
    checkpoint,
    page,
    sendInteraction,
    surface: postSubmitSurface.surface,
  });
  if (recovered) {
    return true;
  }

  throw new Error("heb_login_unexpected_ui");
}

export async function probeHebSession(page: Page, checkpoint?: SessionCheckpointFn): Promise<boolean> {
  return (await probeOrdersPage(page, checkpoint)) === "live";
}

/**
 * Decline an enrollment upsell that was already on screen when the run began,
 * then wait for the session to settle. Every failure path names what was
 * observed; none of them prompts the owner for a code.
 */
async function declinePasskeyEnrollmentThenSettle({
  checkpoint,
  page,
  postSubmitWaitClock,
}: Pick<EnsureHebSessionArgs, "page"> & {
  readonly checkpoint?: SessionCheckpointFn | undefined;
  readonly postSubmitWaitClock?: PostSubmitWaitClock | undefined;
}): Promise<boolean> {
  await checkpoint?.("heb-passkey-enrollment-declining");
  const declined = await declinePasskeyEnrollment(page);
  if (!declined) {
    throw new Error(passkeyEnrollmentDeclineError("control_unavailable"));
  }
  await checkpoint?.("heb-passkey-enrollment-declined");

  const settled = await waitForPostSubmitAuthSurface(
    page,
    postSubmitWaitClock ?? defaultPostSubmitWaitClock(page),
    checkpoint
  );
  if (settled.kind === "live") {
    await checkpoint?.("heb-post-submit-live");
    return true;
  }
  if (settled.kind === "passkey_enrollment_decline_failed") {
    await checkpoint?.("heb-passkey-enrollment-decline-failed");
    throw new Error(passkeyEnrollmentDeclineError(settled.reason));
  }
  if (await probeHebSession(page)) {
    return true;
  }
  throw new Error(passkeyEnrollmentDeclineError("still_on_enrollment_page"));
}

export async function ensureHebSession({
  capture,
  checkpoint,
  onCredentialSubmit,
  page,
  postSubmitWaitClock,
  sendInteraction,
}: EnsureHebSessionArgs): Promise<boolean> {
  await checkpoint?.("heb-auth-probe");
  if (await probeHebSession(page, checkpoint)) {
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
      onCredentialSubmit,
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

  // Handled before the verification-code branch: a resumed session can land
  // straight on the enrollment upsell, and that screen must never be mistaken
  // for a challenge.
  if (surface === "passkey_enrollment") {
    return await declinePasskeyEnrollmentThenSettle({
      checkpoint,
      page,
      postSubmitWaitClock,
    });
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
    checkpoint,
    page,
    sendInteraction,
    surface: repairSurface,
  });
  if (recovered) {
    return true;
  }

  throw new Error("heb_login_unexpected_ui");
}

async function waitForUniqueVerificationCodeFormRoot(page: Page, clock: PostSubmitWaitClock): Promise<Locator | null> {
  const deadline = clock.now() + FIELD_TIMEOUT_MS;
  while (clock.now() <= deadline) {
    const resolved = await resolveUniqueVerificationCodeFormRoot(page);
    if (resolved) {
      return resolved;
    }

    const remainingMs = deadline - clock.now();
    if (remainingMs <= 0) {
      return null;
    }
    await clock.wait(Math.min(POST_SUBMIT_POLL_INTERVAL_MS, remainingMs));
  }
  return null;
}
