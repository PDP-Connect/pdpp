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

import { redactTransportDetail } from "@pdpp/connector-protocol/http-retry";
import type { Locator, Page } from "playwright";
import { DEADLINE_TIMEOUT, manualBrowserLogin, withDeadline } from "../browser-handoff.ts";
import type { InteractionRequest, InteractionResponse, SessionCheckpointFn } from "../connector-runtime.ts";
import type { CaptureSession, LocatorProbe } from "../fixture-capture.ts";
import { locatorIsVisible } from "./locator-helpers.ts";

/** Same bound `index.ts`'s `errorDetail` applies after redaction — keeps one link short and legible without truncating mid-token. */
const PROBE_TRANSPORT_DETAIL_MAX = 200;

/**
 * Per-probe bounds for the page-context account probe — see
 * {@link probeVenmoAccount}. The outer (`evaluate`) bound is deliberately
 * longer than the inner (`fetch`) one so a healthy page reports its own abort
 * as a clean transport error rather than racing the outer deadline.
 */
const PROBE_FETCH_TIMEOUT_MS = 8000;
const PROBE_EVALUATE_TIMEOUT_MS = 12_000;

/**
 * Fault-class name for a transport failure discovered by the PRE-submit
 * session probe — see {@link probeVenmoAccount}'s B4 doc for why this must
 * stay distinct from the post-submit name below.
 */
export const VENMO_PROBE_TRANSPORT_ERROR = "venmo_probe_transport_error";
/** Fault-class name for a transport failure discovered by the POST-submit probe — see the B4 doc. Deliberately excluded from `VENMO_RETRYABLE_PATTERN`. */
export const VENMO_POST_SUBMIT_PROBE_TRANSPORT_ERROR = "venmo_post_submit_probe_transport_error";
/** Fault-class name for {@link ensureVenmoOrigin} failing to land the page on the venmo.com origin — see that function's doc (production run_1787101857760). */
export const VENMO_ORIGIN_NAVIGATION_FAILED = "venmo_origin_navigation_failed";
/**
 * Fault-class name for the password screen never arriving after a successful
 * identifier submit on Venmo's two-step sign-in — see {@link fillVenmoPassword}.
 *
 * Deliberately a distinct, named, NON-retryable-by-omission class rather than
 * a fall-through: the identifier has been sent to Venmo at this point, so a
 * blind retry re-enters `ensureVenmoSession` and re-submits it. It is also
 * distinct from the OTP vocabulary on purpose — a missing password field is
 * not evidence Venmo asked for a code, and treating it as one is exactly the
 * fabricated-prompt defect class this file's OTP path already guards against.
 *
 * Declared here rather than beside its sibling sign-in constants below because
 * {@link VENMO_DECLARED_REASON_TOKENS} is built eagerly at module load and
 * would read it from the temporal dead zone otherwise.
 */
export const VENMO_PASSWORD_SCREEN_TIMEOUT = "venmo_password_screen_timeout";

/**
 * This connector's classifying fault-class names — single source of truth,
 * built from the same constants every throw site below uses, so it cannot
 * drift from the vocabulary it names. Every one of these is >=24 chars and
 * therefore invisible to an owner today: `runtime/connector-gap-bounding.ts`'s
 * `boundConnectorErrorMessage` redacts any bare token this long
 * (`stderr-redact.ts`'s `LONG_OPAQUE_RE`, an entropy heuristic for
 * unlabelled API keys) with no notion that a categorical, PII-free reason
 * code is not the kind of secret that rule exists to catch — the same
 * defect class production hit for HEB (`heb_session_failed: [REDACTED]`,
 * see `runtime/stderr-redact.ts`'s `declaredReasonTokens` doc) and, on
 * 2026-08-18, for Venmo's own first live run (`run_1787101857760`:
 * `venmo_session_failed: [REDACTED]: Failed to fetch` — the eaten token was
 * exactly `VENMO_PROBE_TRANSPORT_ERROR`). Consumed by
 * `runtime/declared-reason-tokens.ts` on the RS side so these survive that
 * redaction pass without a hand-copied, driftable string list on the other
 * side of the process boundary.
 */
export const VENMO_DECLARED_REASON_TOKENS: ReadonlySet<string> = new Set([
  VENMO_PROBE_TRANSPORT_ERROR,
  VENMO_POST_SUBMIT_PROBE_TRANSPORT_ERROR,
  VENMO_ORIGIN_NAVIGATION_FAILED,
  VENMO_PASSWORD_SCREEN_TIMEOUT,
]);

const HOME_URL = "https://venmo.com/";
const LOGIN_URL = "https://venmo.com/login";
/**
 * The probe hits the SAME endpoint `collect()` does — `api.venmo.com/v1/account`
 * (`connectors/venmo/parsers.ts`'s `API_BASE`), the one that actually returns
 * the `data.user.id` JSON this function parses.
 *
 * It used to point at `https://venmo.com/account`, which is not that endpoint
 * and never returned JSON at all. That URL is Venmo's own web app route, and
 * as of 2026-08-18 it answers a redirect chain that terminates on plain HTTP:
 *
 *   https://venmo.com/account          -> 302 https://account.venmo.com/account
 *   https://account.venmo.com/account  -> 307 http://account.venmo.com:8080/
 *
 * A `fetch` issued from the HTTPS `venmo.com` page follows those redirects and
 * is then blocked by the browser's mixed-content rule on the final http:// hop.
 * A blocked redirect surfaces to page JS as exactly `TypeError: Failed to
 * fetch` — indistinguishable, from inside the callback, from a network
 * failure. That is production `run_1787108832272`'s
 * `venmo_probe_transport_error: Failed to fetch`, on a host where
 * `https://venmo.com/` itself was reachable and returning 200.
 *
 * The origin guard below is still required and still correct: `api.venmo.com`
 * grants a credentialed cross-origin fetch only to `Access-Control-Allow-Origin:
 * https://venmo.com`. The previous URL made that guard look like the whole
 * story, because a same-origin `venmo.com` URL needs no CORS grant at all —
 * so the guard could never have fixed a fault the URL itself was causing.
 */
export const ACCOUNT_PROBE_URL = "https://api.venmo.com/v1/account";
/**
 * The ONE origin a credentialed page-context fetch may run from. Not a
 * stylistic preference: `api.venmo.com` answers a `credentials:"include"`
 * cross-origin fetch with `Access-Control-Allow-Origin: https://venmo.com`,
 * and the CORS spec forbids the wildcard form entirely once credentials are
 * involved — the header must echo one exact origin. So `id.venmo.com` and
 * `account.venmo.com` are real Venmo hosts that still cannot issue this
 * fetch. This value is the fetch PRECONDITION, not the trust boundary; see
 * {@link VENMO_FAMILY_HOSTS} for the latter.
 */
const VENMO_ORIGIN = "https://venmo.com";

/**
 * Venmo's real first-party host family — the hosts a correct, non-hostile
 * sign-in flow legitimately parks the page on before {@link ensureVenmoOrigin}
 * navigates back to {@link VENMO_ORIGIN}.
 *
 * Each entry is load-bearing, verified against live behavior 2026-08-18:
 *   - `venmo.com`         the canonical app origin and the only CORS-granted one.
 *   - `www.venmo.com`     the marketing/apex alias venmo.com itself redirects between.
 *   - `id.venmo.com`      where sign-in actually happens (`id.venmo.com/signin?...`).
 *   - `account.venmo.com` where a signed-in `venmo.com/account` request lands
 *                         (302 -> account.venmo.com, per ACCOUNT_PROBE_URL's doc).
 *   - `api.venmo.com`     the JSON API `collect()` and the probe both read.
 *
 * An EXACT host set, deliberately not a suffix test. `"evil-venmo.com"` and
 * `"notvenmo.com"` both satisfy `endsWith("venmo.com")`, so a suffix match
 * would hand an attacker-controlled page the same "this is Venmo, carry on"
 * verdict as the real thing. Membership is `Set.has(hostname)` — the same
 * shape `streaming-target-registration.ts`'s `ALLOWED_CDP_TARGET_HOSTS` uses
 * for the same reason.
 */
const VENMO_FAMILY_HOSTS: ReadonlySet<string> = new Set([
  "account.venmo.com",
  "api.venmo.com",
  "id.venmo.com",
  "venmo.com",
  "www.venmo.com",
]);

/**
 * Whether `url` is a page on Venmo's own https host family.
 *
 * HTTPS is required, not incidental: `venmo.com`'s own redirect chain
 * terminates on `http://account.venmo.com:8080/` (see {@link ACCOUNT_PROBE_URL}),
 * and a plain-http Venmo page is both a downgraded origin and one whose
 * credentialed fetch the browser's mixed-content rule blocks anyway. Treating
 * it as "close enough to Venmo" would re-admit exactly the fault that
 * production `run_1787108832272` recorded.
 */
export function isVenmoFamilyUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // `about:blank` and any other unparseable/opaque page land here.
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  return VENMO_FAMILY_HOSTS.has(parsed.hostname);
}
/**
 * Venmo's identifier field, across both sign-in generations.
 *
 * `input[name="login_email"]` is the CURRENT one and the reason this connector
 * had collected zero records ever. Read live over CDP during production
 * `run_1787164654406`: `https://id.venmo.com/signin?...` renders exactly two
 * enabled, visible inputs — `{type: email, name: "login_email"}` and an unnamed
 * `{type: password}` — under the copy "Log in" / "Enter email, mobile, or
 * username" / "Next". None of the three prior candidates
 * (`phoneEmailUsername`, `#username`, `[autocomplete="username"]`) match
 * `login_email`, so `loginWithSavedCredentials` found no identifier field,
 * concluded the sign-in form had not rendered, and handed off to the owner on
 * every run regardless of the saved credentials being present and correct.
 *
 * The older candidates are KEPT, not replaced: they cost one selector-union
 * branch each, and Venmo demonstrably serves more than one sign-in generation
 * (this is the second shape this file has had to learn). A union that still
 * matches the previous shape degrades to the old behavior rather than to a
 * handoff if Venmo rolls back or A/B-splits.
 */
const USERNAME_SELECTOR =
  'input[name="login_email"], input[name="phoneEmailUsername"], input#username, input[autocomplete="username"]';
const PASSWORD_SELECTOR = 'input[name="password"], input#password, input[type="password"]';
/**
 * The step-one ("Next") control on Venmo's two-step sign-in.
 *
 * Venmo now splits sign-in across two screens: identifier -> `Next` ->
 * password. The live page carries a submit button with id `btnNext`, whose
 * accessible name ("Next") {@link SUBMIT_BUTTON_NAME_RE} already matches — so
 * this id is a FALLBACK for the case where the accessible name is absent,
 * localized, or rendered as an icon, not the primary path. See
 * {@link clickVenmoLoginSubmit}.
 */
const STEP_ONE_SUBMIT_SELECTOR = "#btnNext";
/**
 * How long to wait for the password screen after submitting the identifier.
 *
 * A real bound, not a sleep: the prior code slept a fixed 1500ms and then
 * looked once, so a slower-than-1.5s second screen was misread as "no password
 * field" and a faster one wasted the remainder. This is the ceiling on a wait
 * that resolves as soon as the field is actually visible.
 */
const PASSWORD_SCREEN_TIMEOUT_MS = 15_000;
/**
 * Copy/markup that means a human-verification challenge is blocking the flow.
 *
 * Venmo's own sign-in page embeds a reCAPTCHA iframe from `paypalobjects.com`
 * (confirmed live, `run_1787164654406`). Solving it is explicitly NOT a goal:
 * when one blocks progress the connector hands the page to the owner via the
 * existing `manual_action` path with `reason: "captcha"`, the same shape
 * reddit/amazon/chatgpt use. The alternative failure modes are the two this
 * must never produce — a silent failure, or a spin.
 */
const CAPTCHA_FRAME_SELECTOR =
  'iframe[src*="recaptcha"], iframe[src*="paypalobjects.com"], iframe[title*="recaptcha" i], div.g-recaptcha';
const OTP_SELECTOR =
  'input[name="otp"], input[name="code"], input[autocomplete="one-time-code"], input[name="smsCode"]';
const SUBMIT_BUTTON_NAME_RE = /^(log in|sign in|continue|next)$/i;
/**
 * Copy that ACCOMPANIES a code-entry screen. Necessary but never sufficient:
 * "we sent"/"we texted" is ordinary Venmo prose that also appears on device-
 * approval screens and notification banners, none of which can accept a code.
 * See {@link hasUsableVenmoOtpInput}.
 */
const OTP_PROMPT_TEXT_RE = /verification code|enter the code|we (?:sent|texted)|2-step|two-factor/i;
/**
 * A split per-digit layout has one input per digit. Venmo's current web
 * sign-in renders a single 6-digit field, but the bound keeps a redesign to a
 * boxed layout classifiable instead of silently unrecognized. Anything larger
 * is a page full of inputs, not a code entry.
 */
const MAX_SPLIT_CODE_DIGITS = 10;
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
  {
    id: "step-one-submit",
    kind: "css",
    selector: STEP_ONE_SUBMIT_SELECTOR,
    description: "Venmo's two-step identifier ('Next') control; absence means a one-screen or unrecognized form.",
  },
  {
    id: "captcha",
    kind: "css",
    selector: CAPTCHA_FRAME_SELECTOR,
    description: "Human-verification frames; presence explains a stalled password step but never blocks a healthy one.",
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
 *
 * Production `run_1787101857760` (2026-08-18, the owner's first-ever Venmo
 * run — a brand-new persistent profile, so `page.url()` starts on
 * `about:blank`): the pre-submit probe threw
 * `venmo_probe_transport_error: Failed to fetch`. The prior version of this
 * function swallowed a failed `page.goto` with `.catch(() => undefined)` and
 * returned regardless of whether the navigation actually landed on
 * `venmo.com` — so a transient failure of THIS `goto` (not the eventual
 * fetch) silently left the page on its opaque `about:blank` origin, and the
 * caller's credentialed fetch then failed for a reason this function was
 * supposed to have already ruled out. Every DOM-probing sibling connector
 * (chase.ts's `probeSession`, reddit.ts's credential-less `isSessionLive`)
 * has the same swallowed `.catch`, but degrades gracefully: a `waitFor`/
 * `count` against an unnavigated page just times out to "not logged in".
 * Venmo's probe is `fetch`-based, so the same swallowed failure surfaces as
 * an opaque transport throw instead of a clean liveness signal — verifying
 * the navigation actually landed is the fix that closes that gap for a
 * fetch-based probe specifically.
 *
 * This function checks TWO different facts, and conflating them is what broke
 * production `run_1787151856448`:
 *
 *   1. PRECONDITION — the page must END on `https://venmo.com`, because that
 *      is the single origin `api.venmo.com` grants a credentialed fetch to
 *      (see {@link VENMO_ORIGIN}). Nothing weaker satisfies CORS.
 *   2. TRUST — landing on another of Venmo's OWN hosts
 *      ({@link VENMO_FAMILY_HOSTS}) is normal, expected behavior after a real
 *      sign-in; landing off that family entirely is not.
 *
 * The first version tested only (1) and treated any miss as fatal, so an owner
 * who genuinely signed in at `id.venmo.com` — the correct flow — had the run
 * terminalled by the guard meant to protect it. A guard that fires on correct
 * behavior teaches operators to ignore it, so the family case now re-navigates
 * instead of throwing, while a landing outside the family still fails loudly.
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
  const landedUrl = page.url();
  let landedOrigin: string | null = null;
  try {
    landedOrigin = new URL(landedUrl).origin;
  } catch {
    landedOrigin = null;
  }
  // A landing anywhere in Venmo's own host family is CORRECT behavior, not a
  // fault. Production `run_1787151856448` (connection
  // cin_94f4a295dda3f17d0f307a33), captured via PDPP_BROWSER_SURFACE_DIAGNOSTICS:
  //   interaction_start    -> https://id.venmo.com/signin
  //   interaction_response -> https://account.venmo.com/   (status: success)
  // The owner completed a real sign-in and this guard terminalled the run on
  // the SUCCESS page.
  //
  // `venmo.com` is still the only origin the credentialed `api.venmo.com`
  // fetch can run from (CORS forbids a wildcard once credentials are sent), so
  // a family host is not "good enough" to return on — it is grounds to
  // navigate once more rather than to fail. Bounded to exactly one extra
  // attempt: no loop, and a non-family landing gets no retry at all.
  //
  // Honest limit: if Venmo ever 302s a signed-in `venmo.com/` request to
  // `account.venmo.com` DETERMINISTICALLY, this retry cannot converge and the
  // run fails with the named error. That is the correct failure — it is a real
  // inability to satisfy the fetch precondition, reported as such, rather than
  // a silent proceed into an opaque `TypeError: Failed to fetch`. The probe
  // that follows is the actual evidence of session liveness; this guard only
  // guarantees that probe runs from an origin where a negative result MEANS
  // something.
  if (landedOrigin !== VENMO_ORIGIN && isVenmoFamilyUrl(landedUrl)) {
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((): undefined => undefined);
    try {
      landedOrigin = new URL(page.url()).origin;
    } catch {
      landedOrigin = null;
    }
  }
  if (landedOrigin !== VENMO_ORIGIN) {
    // Named distinctly from `venmo_probe_transport_error`/`venmo_transport_error`
    // (the callers' own catch-and-wrap throws) so this fault's cause is legible
    // on its own — "navigation to venmo.com did not land" rather than a bare
    // "Failed to fetch" with no indication the origin was never established.
    // Still retryable: this is the same class of transient-navigation fault
    // VENMO_RETRYABLE_PATTERN already treats as safe to retry pre-submit, and
    // both callers wrap this in their own try/catch that classifies it via
    // that pattern the same way as any other transport error.
    // `landedOrigin` is an ORIGIN (scheme+host+port), never a full URL — no
    // path, query, or fragment, so no session token or account identifier can
    // ride along into `connector_error_json`. A non-Venmo origin is reported
    // as an opaque class rather than echoed: if a hostile redirect landed us
    // somewhere, its hostname is attacker-chosen text and this message is
    // owner-visible.
    const landedDescription = describeLandedOrigin(landedOrigin, page.url());
    throw new Error(
      `${VENMO_ORIGIN_NAVIGATION_FAILED}: could not establish the venmo.com origin (landed on ${landedDescription})`
    );
  }
}

/**
 * How a failed landing is described in the owner-visible error text.
 *
 * A Venmo-family origin is named outright — that is the diagnostically useful
 * case ("we ended on id.venmo.com and could not get back"). Anything else is
 * reported as an opaque class: an origin we did not expect may be
 * attacker-chosen text, and this string lands in `connector_error_json`.
 * Origins carry no path/query/fragment, so nothing token-shaped rides along
 * either way.
 */
function describeLandedOrigin(landedOrigin: string | null, landedUrl: string): string {
  if (landedOrigin === null) {
    return "unknown";
  }
  return isVenmoFamilyUrl(landedUrl) ? landedOrigin : "a non-venmo.com origin";
}

const noopCheckpoint: SessionCheckpointFn = () => Promise.resolve();

interface EnsureVenmoSessionArgs {
  capture?: CaptureSession | null;
  checkpoint?: SessionCheckpointFn;
  credentials?: Readonly<Record<string, string>>;
  onCredentialSubmit?: () => void;
  page: Page;
  /**
   * Bound on the wait for Venmo's second (password) sign-in screen; defaults
   * to {@link PASSWORD_SCREEN_TIMEOUT_MS}. Exposed so a test can assert the
   * bound is real without sitting through the production one — the same seam
   * `probeVenmoAccount`'s `evaluateTimeoutMs` already provides.
   */
  passwordScreenTimeoutMs?: number;
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
  phase: VenmoProbePhase = "pre_submit",
  { evaluateTimeoutMs = PROBE_EVALUATE_TIMEOUT_MS }: { readonly evaluateTimeoutMs?: number } = {}
): Promise<VenmoAccountProbeResult> {
  let outcome: { kind: "dead" } | { kind: "live"; ownerId: string } | { kind: "transport_error"; message: string };
  try {
    // Folded into the same try/catch as the fetch below: a failed navigation
    // (ensureVenmoOrigin now throws rather than silently proceeding — see its
    // doc) must be classified through the SAME phase-aware transport-error
    // path as a fetch failure, not escape unwrapped and skip the B4
    // post-submit non-retry invariant this function exists to enforce.
    await ensureVenmoOrigin(page);
    // Bounded on both layers, for the same reasons as reddit.ts's
    // `isSessionLive`: the in-page `fetch` has no default timeout (an
    // accepted-but-unanswered connection hangs the callback forever, and the
    // `catch` cannot see a hang), and `page.evaluate` has no default timeout
    // either (a wedged page context never runs the callback at all, so the
    // inner abort has nothing to abort).
    const evaluated = await withDeadline(
      page.evaluate(
        async ({ fetchTimeoutMs, url }) => {
          try {
            const res = await fetch(url, {
              credentials: "include",
              headers: { accept: "application/json" },
              signal: AbortSignal.timeout(fetchTimeoutMs),
            });
            if (res.status < 200 || res.status >= 300) {
              return { kind: "dead" as const };
            }
            const body = (await res.json().catch(() => null)) as { data?: { user?: { id?: string } } } | null;
            const ownerId = body?.data?.user?.id ?? null;
            return ownerId ? { kind: "live" as const, ownerId } : { kind: "dead" as const };
          } catch (err) {
            return { kind: "transport_error" as const, message: err instanceof Error ? err.message : String(err) };
          }
        },
        { fetchTimeoutMs: PROBE_FETCH_TIMEOUT_MS, url: ACCOUNT_PROBE_URL }
      ),
      evaluateTimeoutMs
    );
    // A page context that never answers is a transport fault, not a dead
    // session — and it stays phase-aware, so a post-submit hang still gets
    // the non-retryable name (B4) rather than silently retrying a password.
    outcome =
      evaluated === DEADLINE_TIMEOUT
        ? { kind: "transport_error", message: `probe did not return within ${evaluateTimeoutMs}ms` }
        : evaluated;
  } catch (err) {
    // Either `ensureVenmoOrigin` threw (navigation never landed on venmo.com)
    // or `page.evaluate` itself rejected — the execution context was
    // destroyed (navigation raced the probe) or the page/browser crashed.
    // Same "could not run at all" classification as a fetch throwing inside
    // the callback: a transport fault, not proof the session is dead.
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
    const name = phase === "post_submit" ? VENMO_POST_SUBMIT_PROBE_TRANSPORT_ERROR : VENMO_PROBE_TRANSPORT_ERROR;
    throw new Error(`${name}: ${detail}`);
  }
  return outcome.kind === "live" ? { live: true, ownerId: outcome.ownerId } : { live: false, ownerId: null };
}

/**
 * Every OTP input this module recognizes, unnarrowed — the countable form of
 * {@link findVenmoOtpInput}. Classification needs to count candidates (a split
 * per-digit layout has several); the fill path needs exactly one. Both read the
 * same selector so a page can never be classified off an input the fill path
 * would not find.
 */
function venmoOtpInputCandidates(page: Page): Locator {
  return page.locator(OTP_SELECTOR);
}

function findVenmoOtpInput(page: Page): Locator {
  return venmoOtpInputCandidates(page).first();
}

function isViableVenmoOtpDigitCount(codeCount: number): boolean {
  return codeCount === 1 || (codeCount > 1 && codeCount <= MAX_SPLIT_CODE_DIGITS);
}

/**
 * Count the OTP inputs that are actually usable right now — visible AND
 * enabled. `locatorIsVisible` answers only the first half: a disabled field
 * still reports itself visible, so a rendered-but-inert code box passed the
 * old check and reached the prompt. Presence, and even visibility, is not
 * evidence; usability is.
 */
async function countUsableVenmoOtpInputs(page: Page): Promise<number> {
  const candidates = venmoOtpInputCandidates(page);
  const count = await candidates.count().catch((): number => 0);
  let usable = 0;
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
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

/**
 * Whether this page can actually ACCEPT a code right now.
 *
 * This is the evidence that makes an OTP classification honest. Prompting the
 * owner commits them to fetching a secret out of band, and a fabricated prompt
 * on a payments account trains them to expect code demands Venmo never sent.
 * So the bar is a real, visible, enabled code input: one field, or the split
 * per-digit layout.
 */
async function hasUsableVenmoOtpInput(page: Page): Promise<boolean> {
  return isViableVenmoOtpDigitCount(await countUsableVenmoOtpInputs(page));
}

/**
 * Click the sign-in form's submit control. Returns `false` when no control
 * could be found — the caller decides whether that is fatal.
 *
 * Candidate order is deliberate. The semantic role query comes first because
 * an accessible name is the most stable thing about a button; `extraSelectors`
 * (Venmo's `#btnNext` on the identifier screen) is tried before the generic
 * `button[type="submit"]` because on a page carrying more than one submit
 * control the generic selector's `.first()` is a coin flip, whereas the id is
 * exact.
 */
async function clickVenmoLoginSubmit(page: Page, extraSelectors: readonly string[] = []): Promise<boolean> {
  const semantic = page.getByRole("button", { name: SUBMIT_BUTTON_NAME_RE }).first();
  if (await locatorIsVisible(semantic)) {
    await semantic.click();
    return true;
  }
  for (const selector of [...extraSelectors, 'button[type="submit"]']) {
    const fallback = page.locator(selector).first();
    if (await locatorIsVisible(fallback)) {
      await fallback.click();
      return true;
    }
  }
  return false;
}

/**
 * Whether a human-verification challenge is currently rendered.
 *
 * Presence of the frame is the signal, and it is deliberately checked only
 * where a challenge would EXPLAIN a stall — never as a precondition for
 * proceeding. Venmo embeds reCAPTCHA on the sign-in page unconditionally
 * (`run_1787164654406`), including on flows that complete without ever
 * challenging the user, so treating a mere embed as "blocked" would hand every
 * healthy login to the owner. See {@link fillVenmoPassword}.
 */
async function hasVenmoCaptcha(page: Page): Promise<boolean> {
  return await locatorIsVisible(page.locator(CAPTCHA_FRAME_SELECTOR));
}

/**
 * Wait for the password screen to actually render, bounded.
 *
 * `waitFor` resolves the instant the field is visible and rejects at the
 * deadline — the replacement for a fixed `waitForTimeout(1500)` that could
 * neither wait long enough for a slow screen nor return early from a fast one.
 * There is no polling loop here and therefore nothing that can spin.
 */
async function waitForVenmoPasswordScreen(page: Page, timeoutMs: number): Promise<boolean> {
  return await page
    .locator(PASSWORD_SELECTOR)
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then((): true => true)
    .catch((): false => false);
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
 * Fill the password field, advancing Venmo's two-step sign-in when needed.
 *
 * Venmo's current flow (live `run_1787164654406`) is identifier -> `Next` ->
 * password on a SECOND screen. The one-screen shape is still handled first and
 * costs nothing: if a password field is already visible, this fills it and
 * returns without ever clicking anything.
 *
 * Returns `null` when the password was filled and the caller should continue
 * to the password submit; returns a probe result when the flow was handed to
 * the owner instead. Throws {@link VENMO_PASSWORD_SCREEN_TIMEOUT} when the
 * second screen never arrives for a reason we cannot attribute.
 *
 * THIS FUNCTION NEVER MARKS THE CREDENTIAL AS SUBMITTED. The click it performs
 * sends the IDENTIFIER only — an email/username, not a secret — so the
 * `onCredentialSubmit` marker and its non-retryable classification stay with
 * the password submit in {@link loginWithSavedCredentials}. Firing the marker
 * here would classify every identifier-screen fault as "a password went out",
 * permanently terminalling runs that cost nothing to retry.
 */
async function fillVenmoPassword(
  args: ManualHandoff & { password: string; passwordScreenTimeoutMs?: number }
): Promise<VenmoAccountProbeResult | null> {
  const { capture, page, password, passwordScreenTimeoutMs = PASSWORD_SCREEN_TIMEOUT_MS, sendInteraction } = args;
  const passwordIn = page.locator(PASSWORD_SELECTOR).first();
  if (await locatorIsVisible(passwordIn)) {
    await passwordIn.fill(password);
    return null;
  }
  // Two-step flow: advance past the identifier-only screen. `#btnNext` is
  // Venmo's current step-one control; the semantic "Next" name inside
  // clickVenmoLoginSubmit matches it first when the accessible name is
  // present.
  if (!(await clickVenmoLoginSubmit(page, [STEP_ONE_SUBMIT_SELECTOR]))) {
    // No way to advance at all. This is the genuinely-unrecognized page the
    // handoff exists for, so it hands off rather than throwing — nothing has
    // been submitted, and the owner can still finish by hand.
    await captureLoginState(capture, page, "venmo-step-one-submit-missing");
    return await requestManualLoginForChallenge({
      ...(capture ? { capture } : {}),
      page,
      reason: "could not advance past the sign-in identifier step",
      sendInteraction,
    });
  }
  await captureLoginState(capture, page, "venmo-identifier-submitted");
  if (await waitForVenmoPasswordScreen(page, passwordScreenTimeoutMs)) {
    await page.locator(PASSWORD_SELECTOR).first().fill(password);
    return null;
  }
  // The password screen did not arrive within the bound. A rendered captcha is
  // the one cause we can attribute and the one the owner can actually resolve,
  // so it routes to the existing manual path with an honest message rather
  // than to a named failure they cannot act on. Checked only HERE — after a
  // real stall — because Venmo embeds reCAPTCHA on healthy sign-ins too.
  await captureLoginState(capture, page, "venmo-password-screen-missing");
  if (await hasVenmoCaptcha(page)) {
    return await waitForManualLogin({
      ...(capture ? { capture } : {}),
      message:
        "Venmo is showing a human-verification challenge (CAPTCHA) that PDPP will not attempt to solve. " +
        "Complete the challenge and finish signing in to Venmo in the secure browser, then respond success.",
      page,
      reason: "captcha",
      sendInteraction,
    });
  }
  // No captcha, no password screen, and no evidence of what Venmo did. Fail
  // with a named, bounded error rather than falling through into the OTP path,
  // where an absent password field would be misread as a verification prompt
  // and fabricate a code demand the owner never received.
  throw new Error(
    `${VENMO_PASSWORD_SCREEN_TIMEOUT}: the password step did not render within ${passwordScreenTimeoutMs}ms after the identifier was submitted`
  );
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
  const otpIn = findVenmoOtpInput(page);
  const bodyText = (
    await page
      .locator("body")
      .innerText()
      .catch((): string => "")
  ).slice(0, 1000);
  // A usable code input is what makes this an OTP challenge. Matching copy
  // alone still routes to a handoff below rather than a prompt, but a code box
  // that is merely RENDERED is not evidence either: a disabled field reports
  // itself visible, so `locatorIsVisible` alone let an inert box demand a code
  // Venmo never sent.
  const usableOtpInput = await hasUsableVenmoOtpInput(page);
  if (!(usableOtpInput || OTP_PROMPT_TEXT_RE.test(bodyText))) {
    return null;
  }
  await captureLoginState(capture, page, "venmo-otp-detected");
  if (!usableOtpInput) {
    // Either the prompt copy matched with no known input shape, or an input
    // rendered that cannot accept a code. Hand off rather than guess a
    // selector for a UI we can't confirm — and never fabricate a code demand.
    return await requestManualLoginForChallenge({
      ...(capture ? { capture } : {}),
      page,
      phase: "post_submit",
      reason: "verification step did not match a known input",
      sendInteraction,
    });
  }
  // Last line of defense before the owner is asked for a secret. Classification
  // already required a usable code input, but Venmo can re-render or navigate
  // between that check and this one. Fail loudly with a named error rather than
  // prompting against a page that cannot accept a code.
  if (!(await hasUsableVenmoOtpInput(page))) {
    throw new Error("venmo_otp_input_missing");
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
  passwordScreenTimeoutMs,
  sendInteraction,
  username,
  password,
}: Pick<EnsureVenmoSessionArgs, "capture" | "page" | "passwordScreenTimeoutMs" | "sendInteraction"> & {
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

  // Two-step flow, submit 1 of 2: `fillVenmoPassword` may click Venmo's `Next`
  // control to reach the password screen. That click sends the IDENTIFIER, not
  // a secret, so it deliberately does NOT fire `onCredentialSubmit` — see that
  // function's doc.
  const passwordHandoff = await fillVenmoPassword({
    ...(capture ? { capture } : {}),
    page,
    password,
    ...(passwordScreenTimeoutMs === undefined ? {} : { passwordScreenTimeoutMs }),
    sendInteraction,
  });
  if (passwordHandoff) {
    return passwordHandoff;
  }

  await captureLoginState(capture, page, "venmo-login-before-submit");
  await checkpoint("venmo-password-submit");
  // Submit 2 of 2 — the one that sends the saved PASSWORD. Everything after
  // this line is post-submit: the marker fires here and only here, and it must
  // stay immediately after the click that succeeded so no branch can reach the
  // post-submit probes without having set it.
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
  passwordScreenTimeoutMs,
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
    ...(passwordScreenTimeoutMs === undefined ? {} : { passwordScreenTimeoutMs }),
    sendInteraction,
    username,
    password,
  });
  if (result.live) {
    return result;
  }
  throw new Error("venmo_login_incomplete_after_submit");
}
