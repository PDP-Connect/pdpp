#!/usr/bin/env node
/**
 * PDPP ChatGPT Connector (v0.2.0)
 * Change note: conversation detail hydration prefers ChatGPT's capped batch
 * endpoint and falls back to the existing per-id detail fetch for omissions or
 * endpoint unavailability.
 *
 * Uses an isolated patchright profile under `~/.pdpp/profiles/chatgpt/` via
 * `acquireIsolatedBrowser`. Initial credentialing happens through the
 * connector's auto-login flow (`src/auto-login/chatgpt.ts`), which drives
 * login + 2FA via `INTERACTION kind=credentials`/`kind=otp` from a normal
 * connector run. All subsequent fetches happen via page.evaluate(fetch)
 * inside the browser context to preserve Cloudflare TLS fingerprint.
 *
 * Extracts bearer token from #client-bootstrap, device ID from oai-did
 * cookie. Walks conversation tree from root → current_node for each
 * conversation. Incremental via update_time cursor.
 */

import type { Page } from "playwright";
import {
  type AdaptiveLane,
  AdaptiveLaneCancelledError,
  type AdaptiveLaneEvent,
  createAdaptiveLane,
  currentAdaptiveLaneRunContext,
} from "../../src/adaptive-lane.ts";
import { ensureChatGptSession } from "../../src/auto-login/chatgpt.ts";
import {
  type BrowserCollectContext,
  buildDetailCoverageMessage,
  buildDetailGap,
  type CollectContext,
  type CollectionRateProgress,
  type DetailCoverageMessage,
  type DetailGapMessage,
  type NormalizeTerminalError,
  nowIso,
  type ProviderBudgetProgress,
  type RecordData,
  runConnector,
  type TerminalErrorDetails,
  type ValidateRecord,
} from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import type { CaptureSession } from "../../src/fixture-capture.ts";
import {
  RetryExhaustedError,
  retryAfterMsFromHeaders,
  retryHttp,
  TerminalHttpStatusError,
} from "../../src/http-retry.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  type ProviderBudgetCircuitTransition,
  ProviderBudgetController,
  type ProviderBudgetGate,
  retryBudgetCapacityFromRequestCap,
} from "../../src/provider-budget.ts";
import { RunBudget } from "../../src/run-budget.ts";
import {
  buildConversationRecord,
  buildCustomInstructionsRecord,
  buildGizmoRecord,
  buildMemoryRecord,
  buildSharedConversationRecord,
  type ConversationDetail,
  extractMessage,
  flattenTreeCurrentBranch,
  maxUpdateTimeIso,
  minUpdateTimeIso,
  tsToIso,
} from "./parsers.ts";
import { validateRecord as validateRecordRaw } from "./schemas.ts";
import type {
  ChatGptApi,
  ChatGptAuth,
  ChatGptFetchResult,
  ConversationListItem,
  RawCustomInstructionsBody,
  RawMemoryEntry,
  RawSharedConversation,
} from "./types.ts";

// schemas.js is a plain-JS Zod validator; cast at the boundary to the
// runtime's ValidateRecord contract. The JS module's safeParse already
// returns { ok, data, issues } in the shape the runtime expects.
const validateRecord = validateRecordRaw as ValidateRecord;

const CHATGPT_TERMINAL_DIAGNOSTIC_MAX = 240;
const CHATGPT_AUTH_FAILURE_RE =
  /(?:^|[^A-Za-z0-9])(?:401|403|auth_missing|session_required|session_failed|unauthorized|forbidden|credentials|CHATGPT_USERNAME\/PASSWORD not set)\b/iu;
const CHATGPT_MANUAL_ACTION_RE =
  /\b(?:login_unexpected_ui|login_post_submit_failed|Cloudflare|challenge|captcha|manual_action|2FA|verification code)\b/iu;

function scrubChatGptTerminalDiagnostic(message: string): string {
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(/access[_-]?token["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]+/giu, "access_token=[redacted]")
    .replace(/https?:\/\/\S+/giu, "[redacted-url]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHATGPT_TERMINAL_DIAGNOSTIC_MAX);
}

export const normalizeChatGptTerminalError: NormalizeTerminalError = ({
  message,
  retryable,
}: TerminalErrorDetails): TerminalErrorDetails => {
  const diagnostic = scrubChatGptTerminalDiagnostic(message);
  if (CHATGPT_AUTH_FAILURE_RE.test(message)) {
    return {
      message: `chatgpt_preprogress_failure: refresh_credentials: ${diagnostic}`,
      retryable: false,
    };
  }
  if (CHATGPT_MANUAL_ACTION_RE.test(message)) {
    return {
      message: `chatgpt_preprogress_failure: manual_action_required: ${diagnostic}`,
      retryable: false,
    };
  }
  return {
    message: `chatgpt_preprogress_failure: runtime_exception: ${diagnostic}`,
    retryable,
  };
};

// ─── Browser auth ───────────────────────────────────────────────────────

async function getAuthFromPage(page: Page): Promise<ChatGptAuth> {
  await page.goto("https://chatgpt.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  // Wait for client bootstrap to appear
  await page
    .waitForFunction(
      () => {
        const el = document.getElementById("client-bootstrap");
        return el?.textContent && el.textContent.length > 10;
      },
      null,
      { timeout: 20_000 }
    )
    .catch((): undefined => undefined);

  const auth = (await page.evaluate(() => {
    let accessToken: string | null = null;
    let deviceId: string | null = null;
    const el = document.getElementById("client-bootstrap");
    if (el) {
      try {
        const data = JSON.parse(el.textContent || "{}");
        accessToken = data?.session?.accessToken || null;
      } catch {
        /* ignore */
      }
    }
    // Next.js injects a __NEXT_DATA__ script-tag-mirrored global on chatgpt.com.
    // Not in the DOM lib; narrow via a local structural type that describes
    // just the path we read. Safer than @ts-expect-error because a typo in
    // the access path (e.g. `pageProps.sesison`) now fails typecheck.
    interface NextDataShape {
      props?: { pageProps?: { session?: { accessToken?: string } } };
    }
    const nextDataEl = document.getElementById("__NEXT_DATA__");
    const nextData: NextDataShape | null = nextDataEl?.textContent
      ? (JSON.parse(nextDataEl.textContent) as NextDataShape)
      : null;
    if (!accessToken && nextData) {
      accessToken = nextData.props?.pageProps?.session?.accessToken || null;
    }
    // biome-ignore lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const m = (document.cookie || "").match(/oai-did=([^;]+)/);
    if (m?.[1]) {
      deviceId = decodeURIComponent(m[1]);
    }
    return { accessToken, deviceId };
  })) as ChatGptAuth;

  return auth;
}

/**
 * Build a ChatGPT API client bound to this run's page + capture session.
 *
 * The client closes over page + capture so call sites read like plain HTTP:
 *     const res = await api.fetch('/conversations?offset=0');
 *
 * Auth is cached inside the closure — no module-level mutable state. Every
 * successful response is auto-captured when PDPP_CAPTURE_FIXTURES=1.
 *
 * Retry policy:
 *   - Retryable: 429, 408, 5xx, browser-level network errors
 *   - Terminal: 401/403 (auth dead)
 *   - Non-retryable 4xx return to stream code for SKIP_RESULT handling
 *   - Caller decides what to do with a successful response body
 */
const CHATGPT_RATE_LIMIT_MAX_ATTEMPTS = 12;
const CHATGPT_RATE_LIMIT_BASE_DELAY_MS = 2000;
const CHATGPT_RATE_LIMIT_MAX_DELAY_MS = 15 * 60_000;
const CHATGPT_RATE_LIMIT_MAX_RETRY_AFTER_MS = 15 * 60_000;
const CHATGPT_LONG_SLEEP_PROGRESS_THRESHOLD_MS = 5000;
const CHATGPT_CONVERSATION_BATCH_MAX_IDS = 10;
// Source-pressure fast-open. The live A/B probe (2026-06-02) showed ChatGPT's
// private detail endpoint returns BARE 429s — no `Retry-After` — and that the
// throttle is per-account, recovering over minutes, not per-conversation. A
// bare 429 is therefore a signal about the whole account/source bucket, not the
// one conversation in hand. Retrying the same conversation up to the full
// `CHATGPT_RATE_LIMIT_MAX_ATTEMPTS` budget would spend ~23–70 min of jittered
// exponential backoff hammering an already-hot account before the connector's
// upstream-pressure circuit opens and defers the rest as DETAIL_GAP.
//
// So a bare 429 (429 WITHOUT `Retry-After`) exhausts retryHttp after only
// `CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS` attempts. That throws the same
// `RetryExhaustedError` the full budget would, opening the existing
// observed-pressure circuit fast: the rest of the tranche is deferred to
// resumable DETAIL_GAP records instead of grinding the hot bucket.
//
// A 429 that DOES carry `Retry-After`, plus 408/5xx, keep the full budget:
// those are bounded transient waits we should respect, not blind hammering.
const CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS = 3;

// ─── Cumulative 429-density wait-resume (bounded-fallback defer) ──────────
//
// The existing upstream-pressure circuit (observedRecoverablePressure) only
// opens when a SINGLE conversation exhausts its retry budget (a thrown
// ChatGptRecoverableRetryExhaustedError). That catches the hard-throttled
// case, but NOT the slow-bleed case the 2026-06-02 429-efficiency audit
// measured: an account that serves a 429, honors a Retry-After, then SUCCEEDS
// — over and over. Each conversation "succeeds", so nothing ever throws, yet
// the run pays ~30–50s of served backoff per conversation and can grind for
// hours against a pressured account before finishing (or before a later
// conversation finally exhausts).
//
// This density stop counts served 429s ACROSS the run (each one already
// surfaces to the detail lane as a `rate_limited` cooldown event). The count is
// a SIGNAL that the account is hot — NOT a terminator. SLVP-ideal control-system
// verdict (docs/research/slvp-ideal-control-system-verdict-2026-06-11.md): the
// correct RESPONSE to source heat is to WAIT OUT the account's minutes-long
// cool-down IN-RUN and CONTINUE draining — the throttle is per-account and
// recovers in minutes while still serving, so stopping is "unnecessary lag." So
// once the cumulative count crosses the threshold the lane sleeps one bounded
// cool-down, RESETS this accumulator (the wait discharged the hot bucket), and
// resumes the SAME conversation — a single run drains the whole backlog instead
// of leaving a tail for a re-kick. Lose-nothing is preserved exactly: nothing is
// gapped at the wait; anything still unfetched at a GENUINE run end (work-drained
// / run-budget / abort) is durably gapped by the existing tail paths.
//
// BOUNDED FALLBACK (the lose-nothing guard against a hostile account): the number
// of cool-down waits in a run is capped by CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES,
// and each wait is bounded by the remaining run budget. Past that cap — or with
// no run budget left — the lane falls back to the OLD behavior: it opens the
// SAME defer circuit the exhaustion path uses and emits the remaining tail as
// resumable DETAIL_GAP records (reason "upstream_pressure"), so a persistently-hot
// account converges to a bounded, lossless stop rather than spinning forever.
//
// Default 8: at the measured ~30–50s per served 429 that is ~4–7 min of
// cumulative honored backoff between waits — enough that the threshold reflects a
// genuinely hot account, far short of the multi-hour grind. Owner-tunable via
// env; set to 0 (or any value < 1) to disable the density stop entirely and fall
// back to exhaustion-only behavior.
const CHATGPT_RATE_LIMIT_DENSITY_STOP_DEFAULT = 8;
const CHATGPT_RATE_LIMIT_DENSITY_STOP_ENV = "PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER";

/**
 * Resolve the cumulative served-429 count at which the detail lane treats the
 * account as hot and WAITS OUT a bounded cool-down before resuming (deferring the
 * tail as upstream_pressure DETAIL_GAP records only on the bounded-wait fallback).
 * Unset/invalid → the conservative default. An explicit value < 1 disables the
 * density stop (returns Infinity), preserving exhaustion-only behavior.
 */
export function resolveChatGptRateLimitDensityStop(env: NodeJS.ProcessEnv = process.env): number {
  const trimmed = env[CHATGPT_RATE_LIMIT_DENSITY_STOP_ENV]?.trim();
  if (trimmed == null || trimmed === "") {
    return CHATGPT_RATE_LIMIT_DENSITY_STOP_DEFAULT;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    return CHATGPT_RATE_LIMIT_DENSITY_STOP_DEFAULT;
  }
  // An explicit non-positive value is the documented disable escape hatch.
  return parsed < 1 ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Tiny run-scoped accumulator for served 429s. Pure and lane-agnostic so the
 * stop decision is unit-testable without standing up the adaptive lane: feed it
 * the lane's `rate_limited` cooldown events, ask `shouldStop()` before each
 * launch. `threshold` of Infinity (the disable sentinel) never trips.
 *
 * `initialCount` seeds the accumulator with served 429s the run already absorbed
 * BEFORE the detail lane started — list pagination and the other streams run
 * their fetches OUTSIDE any adaptive lane, so their served 429s never reach the
 * lane's cooldown event. Carrying that pre-detail pressure into the tracker lets
 * the detail phase wait out the account's cool-down sooner on an account the run
 * has already shown to be hot, instead of resetting to zero and grinding up to
 * `threshold` more served 429s before the first wait. Strictly safer: a higher
 * starting count can only ever make the lane pause-to-cool sooner, never launch
 * more requests into a hot account.
 */
export class ChatGptRateLimitDensityTracker {
  private rateLimitedCount: number;
  readonly threshold: number;

  constructor(threshold: number, initialCount = 0) {
    this.threshold = threshold;
    this.rateLimitedCount = Math.max(0, Math.trunc(initialCount));
  }

  /** Record one served 429 (a `rate_limited` cooldown reported by the lane). */
  recordRateLimited(): void {
    this.rateLimitedCount += 1;
  }

  get count(): number {
    return this.rateLimitedCount;
  }

  /** True once cumulative served 429s have reached the stop threshold. */
  shouldStop(): boolean {
    return this.rateLimitedCount >= this.threshold;
  }

  /**
   * Discharge the accumulator after the lane has WAITED OUT the account's
   * cool-down in-run (SLVP-ideal density wait-resume). The wait paid down the
   * hot bucket, so the lane re-earns its way to the next stop from zero — exactly
   * as a fresh run would. Does NOT change the threshold.
   */
  resetAfterWaitOut(): void {
    this.rateLimitedCount = 0;
  }
}

// ─── Bounded-run budget (provider requests / wall-clock per run) ───────────
//
// DEFAULT BEHAVIOR: BOTH CAPS ARE OFF. When neither env var is set (the normal
// case), both `maxDetailFetchesPerRun` and `maxRunWallClockMs` resolve to
// `Infinity`. A run terminates on genuine work-drained (all gaps + forward-walk
// exhausted) or on real source pressure (density stop). These caps are NOT
// safety invariants and NOT the default throttle. The single authored safety
// number is the rate ceiling (PDPP_CHATGPT_PACING_MIN_INTERVAL_MS, L320–327).
//
// When an owner opts in (sets either env var to a positive finite value), this
// budget bounds that run by SIZE and/or TIME, independent of source pressure.
// In this lane one admitted conversation-detail hydration maps to one provider
// request budget unit. When the run has admitted `maxDetailFetchesPerRun`
// conversation-detail requests, or has spent `maxRunWallClockMs` of wall-clock
// in the detail phase, it stops launching new detail fetches and defers the
// remaining tail as resumable DETAIL_GAP records — the SAME deferral the
// density stop and the per-conversation exhaustion path use, so a later run
// recovers the gaps first and walks forward. Strictly safer than today: it can
// only ever make a run stop EARLIER, never fetch more. A run that stops due to
// these opt-in caps does NOT affect 100% convergence — the gap substrate and
// scheduler cadence drain the backlog over compounding runs regardless.
//
// Crucially this is NOT a source-pressure signal — the account did not throttle
// us, the run chose to stop. So the deferred gaps carry reason
// `retry_exhausted` (resumable, does NOT arm the cross-run source-pressure
// cooldown governor) with a distinct `run_cap_deferred` error class, rather
// than `upstream_pressure` (which would falsely tell the governor the source is
// hot). The records already collected stay valid and the cursor still commits
// the hydrated prefix.
//
// ChatGPT ships an adaptive provider-control profile by default: conservative
// cold-start pacing, AIMD speed-up on clean success, retry-budget protection,
// and source-pressure deferral on real throttling. Size/time caps are explicit
// OPT-IN owner/system envelopes (default Infinity = off); they are not the
// default throttle and not a safety invariant.
const CHATGPT_MAX_DETAIL_FETCHES_PER_RUN_ENV = "PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN";
const CHATGPT_MAX_RUN_WALL_CLOCK_MS_ENV = "PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS";
const CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN_ENV = "PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN";
// When only a fetch/wall-clock cap is set (no explicit tail bound), derive a
// sane finite chunk so an owner who opts into a run cap also gets a bounded
// tail materialization. `max(fetchCap, 50)` keeps a small fetch cap from
// shrinking the per-run drain rate below a useful floor.
const CHATGPT_DERIVED_TAIL_DEFERRAL_GAPS_FLOOR = 50;
const CHATGPT_PACING_INITIAL_INTERVAL_MS_ENV = "PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS";
const CHATGPT_PACING_MIN_INTERVAL_MS_ENV = "PDPP_CHATGPT_PACING_MIN_INTERVAL_MS";
const CHATGPT_PACING_BURST_TOLERANCE_MS_ENV = "PDPP_CHATGPT_PACING_BURST_TOLERANCE_MS";
const CHATGPT_PACING_RECOVERY_GAIN_ENV = "PDPP_CHATGPT_PACING_RECOVERY_GAIN";
const CHATGPT_PACING_MAX_INTERVAL_MS_ENV = "PDPP_CHATGPT_PACING_MAX_INTERVAL_MS";
const CHATGPT_RETRY_BUDGET_CAPACITY_ENV = "PDPP_CHATGPT_RETRY_BUDGET_CAPACITY";
const CHATGPT_RETRY_BUDGET_INITIAL_TOKENS_ENV = "PDPP_CHATGPT_RETRY_BUDGET_INITIAL_TOKENS";
const CHATGPT_CIRCUIT_BREAKER_ENV = "PDPP_CHATGPT_CIRCUIT_BREAKER";
// Cold-start DISCOVERY seed (ms), used ONLY when no fresh learned interval is
// restored from durable state (see warm-start below). It is a one-time entry to
// the AIMD ramp, NOT a hand-authored operating point: warm-start persists the
// learned interval across runs so the descent compounds. Lowered from the legacy
// 2500ms so a genuine cold start is "safe but not glacial" (the SLVP ideal) while
// staying well above the ceiling. The circuit breaker + density stop + DETAIL_GAP
// deferral absorb any cold-start pressure exactly as before.
const CHATGPT_DEFAULT_PACING_INITIAL_INTERVAL_MS = 1000;
// THE ONE OWNER NUMBER: the rate ceiling. The fastest inter-request interval
// (= maximum sustained rate) the additive-increase loop may ever reach — the
// operator's risk tolerance, set below the provider's estimated behavioral
// flagging threshold. It cannot be discovered by probing without risking the
// account, so it is the single fixed prior the controller never crosses. Tune via
// PDPP_CHATGPT_PACING_MIN_INTERVAL_MS. Every other pacing constant is a derived
// horizon or an AIMD shape; this is the only behavioral safety number.
const CHATGPT_DEFAULT_PACING_MIN_INTERVAL_MS = 250;
// Hard ceiling on how far plain throttle can push the inter-request interval.
// Bounds the blast radius of a burst of 429s to ~30s max, keeping recovery
// time bounded (from 30s back to operating point) without crossing the safety
// ceiling (minIntervalMs). Tune via PDPP_CHATGPT_PACING_MAX_INTERVAL_MS.
const CHATGPT_DEFAULT_PACING_MAX_INTERVAL_MS = 30_000;
// Retry-budget defaults (adaptive give-up for the three wait-out regimes).
// capacity=100  — how much a healthy account can bank. A run that keeps
//                 succeeding refills toward 100 and is never artificially
//                 limited: 5 successes earn back 1 token (refillPerSuccess=0.2),
//                 so 500 successes bank the full ceiling. A healthy, busy account
//                 effectively drains forever.
// initialTokens=8 — how many wait-outs a COLD/DEAD account gets before depletion.
//                  Matches the old fixed densityWaitCycles=8 dead-account ceiling
//                  exactly: a dead account never succeeds, never refills, depletes
//                  from 8, and gives up gracefully (the lose-nothing durable defer).
// refillPerSuccess=0.2 — Finagle-validated ratio: 5 successes repair 1 retry.
// Override via PDPP_CHATGPT_RETRY_BUDGET_CAPACITY / PDPP_CHATGPT_RETRY_BUDGET_INITIAL_TOKENS.
const CHATGPT_DEFAULT_RETRY_BUDGET_CAPACITY = 100;
const CHATGPT_DEFAULT_RETRY_BUDGET_INITIAL_TOKENS = 8;
const CHATGPT_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 5 * 60_000;
// Forward-progress guard for the wait-out-circuit loop. A `circuit_open` gate is
// a TRANSIENT back-off, not budget exhaustion: the lane waits out the circuit's
// cool-down (bounded by the remaining run budget) and re-admits rather than
// deferring all remaining work and quitting (the live `run_1781150455121` 136s
// early-exit defect). This caps how many consecutive cool-down waits a single
// admit may pay before it gives up and defers the tail — so a circuit that keeps
// re-opening (the provider is genuinely hostile, not transiently busy) still
// converges to a durable defer instead of looping forever within budget. The
// real budget (wall-clock / detail-fetch) is the primary stop; this is the
// belt-and-braces ceiling on a pathological re-open storm. With the 5-min
// default reset, 8 cool-downs is ~40 min of waiting — far beyond any normal run
// envelope, so a budgeted run hits its wall-clock cap first and this guard never
// fires; it exists only to bound an uncapped (Infinity wall-clock) run.
//
// No-forward-progress pathology verdict: this guard is SUFFICIENT. A
// slow-but-successful crawl (every request succeeds, but slowly) never trips
// the circuit and is bounded by the scheduler cadence — each run commits its
// hydrated prefix before the next dispatch arrives, so nothing is lost and the
// wall-clock cap is never the load-bearing stop for a genuinely progressing
// run. The pathological case (circuit keeps re-opening = hostile provider, not
// merely slow) is exactly what this constant bounds.
const CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES = 8;
// Floor for a single cool-down wait. The circuit reports its exact remaining
// cool-down; this guarantees each wait cycle yields to the event loop and makes
// forward progress even when the reported cool-down has already elapsed to ~0
// (the next probe half-opens the circuit), so the wait loop can never spin.
const CHATGPT_CIRCUIT_WAIT_OUT_MIN_TICK_MS = 50;

/**
 * Resolve the maximum conversation-detail provider requests a single run may
 * admit before deferring the remaining tail as resumable DETAIL_GAP records.
 *
 * **Default: `Infinity` (off).** Unset or any value < 1 returns Infinity — the
 * cap is inactive and the run terminates on work-drained or source pressure.
 * This is an OPT-IN unattended-scheduling envelope, NOT a safety invariant.
 * The single authored safety number is the rate ceiling
 * (PDPP_CHATGPT_PACING_MIN_INTERVAL_MS). A positive integer opts into this
 * envelope. The env var keeps its legacy detail-fetch name because this lane
 * has a one-detail-fetch-to-one-provider-request mapping.
 */
export function resolveChatGptMaxDetailFetchesPerRun(env: NodeJS.ProcessEnv = process.env): number {
  const trimmed = env[CHATGPT_MAX_DETAIL_FETCHES_PER_RUN_ENV]?.trim();
  if (trimmed == null || trimmed === "") {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
}

/**
 * Resolve the maximum wall-clock (ms) the conversation-detail phase may spend
 * before deferring the remaining tail as resumable DETAIL_GAP records.
 *
 * **Default: `Infinity` (off).** Unset or any value <= 0 returns Infinity —
 * the cap is inactive and the run terminates on work-drained or source
 * pressure. This is an OPT-IN unattended-scheduling envelope, NOT a safety
 * invariant. The single authored safety number is the rate ceiling
 * (PDPP_CHATGPT_PACING_MIN_INTERVAL_MS). A positive value opts into this
 * envelope. The budget spans the gap-recovery pass and the forward-walk pass
 * of a single run.
 */
export function resolveChatGptMaxRunWallClockMs(env: NodeJS.ProcessEnv = process.env): number {
  const trimmed = env[CHATGPT_MAX_RUN_WALL_CLOCK_MS_ENV]?.trim();
  if (trimmed == null || trimmed === "") {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor(parsed);
}

/**
 * Resolve the maximum number of per-key `DETAIL_GAP` rows a single run may write
 * for the cap-tail deferral before folding the remaining older tail into ONE
 * durable backlog gap (carrying a content-derived `before_update_time`
 * watermark the next run re-lists from). This bounds the *foreground burn* of a
 * cap trip: a huge cold account no longer spends a long run writing thousands of
 * gap rows after it has already stopped fetching details.
 *
 * Resolution:
 * - explicit `PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN` (positive integer) wins;
 * - unset but a fetch cap is configured → derived `max(fetchCap, 50)` so an owner
 *   who set only a fetch cap still gets a bounded tail;
 * - otherwise (no fetch cap either) → `Infinity`: today's per-key behavior is
 *   byte-for-byte preserved. The bound is inert until an owner opts into a cap.
 */
export function resolveChatGptMaxTailDeferralGapsPerRun(env: NodeJS.ProcessEnv = process.env): number {
  const trimmed = env[CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN_ENV]?.trim();
  if (trimmed != null && trimmed !== "") {
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return parsed;
    }
    // Non-integer / non-positive explicit value is a disable sentinel.
    return Number.POSITIVE_INFINITY;
  }
  const fetchCap = resolveChatGptMaxDetailFetchesPerRun(env);
  if (Number.isFinite(fetchCap)) {
    return Math.max(fetchCap, CHATGPT_DERIVED_TAIL_DEFERRAL_GAPS_FLOOR);
  }
  return Number.POSITIVE_INFINITY;
}

function resolveChatGptRetryBudgetCapacity(env: NodeJS.ProcessEnv, maxRequests: number): number | null {
  const trimmed = env[CHATGPT_RETRY_BUDGET_CAPACITY_ENV]?.trim();
  if (trimmed == null || trimmed === "") {
    // Default ON with capacity=100. A healthy account banks tokens up to this ceiling
    // (5 successes refill 1 token via refillPerSuccess=0.2) so it can sustain
    // CHATGPT_DEFAULT_RETRY_BUDGET_CAPACITY wait-outs before depletion — effectively
    // unlimited for a live account. A dead/heavily-throttled account that never
    // succeeds starts at initialTokens=8 (CHATGPT_DEFAULT_RETRY_BUDGET_INITIAL_TOKENS)
    // and gives up gracefully after 8 wait-outs (matches the prior fixed
    // densityWaitCycles=8 ceiling). Override via PDPP_CHATGPT_RETRY_BUDGET_CAPACITY.
    // An explicit fetch-cap overrides the ceiling with a proportionally derived cap.
    return Number.isFinite(maxRequests)
      ? retryBudgetCapacityFromRequestCap({ maxRequests })
      : CHATGPT_DEFAULT_RETRY_BUDGET_CAPACITY;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function resolveChatGptRetryBudgetInitialTokens(env: NodeJS.ProcessEnv): number {
  const trimmed = env[CHATGPT_RETRY_BUDGET_INITIAL_TOKENS_ENV]?.trim();
  if (trimmed == null || trimmed === "") {
    return CHATGPT_DEFAULT_RETRY_BUDGET_INITIAL_TOKENS;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : CHATGPT_DEFAULT_RETRY_BUDGET_INITIAL_TOKENS;
}

function resolveChatGptCircuitBreakerEnabled(env: NodeJS.ProcessEnv): boolean {
  const trimmed = env[CHATGPT_CIRCUIT_BREAKER_ENV]?.trim().toLowerCase();
  return trimmed !== "0" && trimmed !== "false" && trimmed !== "off";
}

function resolvePositiveFiniteMs(env: NodeJS.ProcessEnv, key: string): number | null {
  const trimmed = env[key]?.trim();
  if (trimmed == null || trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

/**
 * Resolve the distance-proportional pacing recovery gain (see
 * ProviderPacing.recoveryGain). Unset → `null` so ProviderPacing applies its own
 * theory-tuned default (0.1). A finite, non-negative override wins; an invalid
 * value falls back to `null` (the default). The gain shapes how fast a transient
 * over-backoff unwinds toward the operating point WITHOUT changing the gentle
 * base step near the rate ceiling — it is an AIMD-shape tunable, never the
 * safety ceiling (that stays PDPP_CHATGPT_PACING_MIN_INTERVAL_MS).
 */
function resolveChatGptPacingRecoveryGain(env: NodeJS.ProcessEnv): number | null {
  const trimmed = env[CHATGPT_PACING_RECOVERY_GAIN_ENV]?.trim();
  if (trimmed == null || trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

/**
 * Resolve the hard ceiling on plain-throttle blast radius (see
 * PacingOptions.maxIntervalMs). Unset → CHATGPT_DEFAULT_PACING_MAX_INTERVAL_MS
 * (30s). An env override wins when it is a valid positive finite ms value; an
 * invalid value falls back to the default.
 */
function resolveChatGptPacingMaxIntervalMs(env: NodeJS.ProcessEnv): number {
  const override = resolvePositiveFiniteMs(env, CHATGPT_PACING_MAX_INTERVAL_MS_ENV);
  return override ?? CHATGPT_DEFAULT_PACING_MAX_INTERVAL_MS;
}

/**
 * Build the ProviderPacing warm-start fields from the raw persisted pacing.
 * Returns `restoredIntervalMs` when a usable interval was persisted, plus the
 * §10-E staleness inputs (`restoredAtMs` + the 6h `maxWarmStartAgeMs`) when the
 * persist also recorded WHEN it was learned — so ProviderPacing cold-starts a
 * stale interval rather than bursting into a possibly-tightened quota. Returns
 * an empty object (cold start) when nothing usable was persisted.
 */
function chatGptWarmStartPacingFields(
  persistedPacing?: { intervalMs: number; recordedAtMs?: number } | number | null
): { restoredIntervalMs?: number; restoredAtMs?: number; maxWarmStartAgeMs?: number } {
  const persisted = typeof persistedPacing === "number" ? { intervalMs: persistedPacing } : (persistedPacing ?? null);
  if (persisted == null || !Number.isFinite(persisted.intervalMs) || persisted.intervalMs <= 0) {
    return {};
  }
  const recordedAtMs = persisted.recordedAtMs;
  if (typeof recordedAtMs !== "number" || !Number.isFinite(recordedAtMs)) {
    return { restoredIntervalMs: persisted.intervalMs };
  }
  return {
    restoredIntervalMs: persisted.intervalMs,
    restoredAtMs: recordedAtMs,
    maxWarmStartAgeMs: CHATGPT_PACING_STATE_STALENESS_MS,
  };
}

export function resolveChatGptProviderBudget(
  env: NodeJS.ProcessEnv = process.env,
  // Warm-start: the RAW persisted pacing from durable connector state
  // (`{ intervalMs, recordedAtMs }`) or null/a bare interval. The staleness
  // guard is NOT applied here — it lives in ProviderPacing (§10-E), the shared
  // primitive, so every connector that warm-starts gets cold re-entry by
  // construction rather than each re-implementing the check. A bare number is
  // accepted for back-compat (no timestamp → caller-owned freshness).
  persistedPacing?: { intervalMs: number; recordedAtMs?: number } | number | null
): ProviderBudgetController | null {
  const pacingInitialOverride = env[CHATGPT_PACING_INITIAL_INTERVAL_MS_ENV]?.trim();
  const initialIntervalMs =
    pacingInitialOverride == null || pacingInitialOverride === ""
      ? CHATGPT_DEFAULT_PACING_INITIAL_INTERVAL_MS
      : resolvePositiveFiniteMs(env, CHATGPT_PACING_INITIAL_INTERVAL_MS_ENV);
  const maxRequests = resolveChatGptMaxDetailFetchesPerRun(env);
  const retryBudgetCapacity = resolveChatGptRetryBudgetCapacity(env, maxRequests);
  const hasRetryBudget = retryBudgetCapacity != null;
  const retryBudgetInitialTokens = resolveChatGptRetryBudgetInitialTokens(env);
  const hasCircuitBreaker = resolveChatGptCircuitBreakerEnabled(env);
  if (initialIntervalMs == null && !hasRetryBudget && !hasCircuitBreaker) {
    return null;
  }
  const minIntervalMs =
    resolvePositiveFiniteMs(env, CHATGPT_PACING_MIN_INTERVAL_MS_ENV) ?? CHATGPT_DEFAULT_PACING_MIN_INTERVAL_MS;
  const burstToleranceMs =
    initialIntervalMs == null
      ? null
      : (resolvePositiveFiniteMs(env, CHATGPT_PACING_BURST_TOLERANCE_MS_ENV) ?? 2 * initialIntervalMs);
  const recoveryGain = resolveChatGptPacingRecoveryGain(env);
  const maxIntervalMs = resolveChatGptPacingMaxIntervalMs(env);
  // The adaptive lane is the SOLE send governor; pacing rides as a
  // `launchDelayHint` (pacingMode: "signal"). The cold `initialIntervalMs` is a
  // one-time discovery seed; the restored interval (warm-start) lets the AIMD
  // descent compound across runs (SLVP ideal §5.2). ProviderPacing applies the
  // §10-E staleness guard from the warm-start fields below.
  const warmStart = chatGptWarmStartPacingFields(persistedPacing);
  return new ProviderBudgetController({
    ...(hasCircuitBreaker
      ? {
          circuitBreaker: {
            resetTimeoutMs: CHATGPT_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
          },
        }
      : {}),
    ...(initialIntervalMs == null
      ? {}
      : {
          pacing: {
            ...(burstToleranceMs == null ? {} : { burstToleranceMs }),
            initialIntervalMs,
            minIntervalMs,
            maxIntervalMs,
            ...(recoveryGain == null ? {} : { recoveryGain }),
            ...warmStart,
          },
        }),
    pacingMode: "signal",
    ...(hasRetryBudget
      ? {
          retryBudget: {
            capacity: retryBudgetCapacity,
            initialTokens: retryBudgetInitialTokens,
            refillPerSuccess: 0.2,
          },
        }
      : {}),
  });
}

// ─── Warm-start persistence (learned rate across runs) ───────────────────
//
// The controller's learned inter-request interval is persisted to the durable
// `messages` STATE cursor so the AIMD descent compounds across runs instead of
// resetting to the cold discovery seed every boundary (the ephemeral-state
// binding constraint, adaptive-floor-diagnosis §C). The cursor already rides the
// connector's durable state substrate; this adds two sibling fields next to
// `last_update_time`. A staleness guard discards a learned interval older than
// the guard window so a long-idle resume does not start aggressive against a
// possibly-reset provider quota.
const CHATGPT_PACING_STATE_INTERVAL_KEY = "pacing_interval_ms";
const CHATGPT_PACING_STATE_RECORDED_AT_KEY = "pacing_recorded_at_ms";
// Staleness guard: discard a learned interval older than this. Provider quotas
// reset on hour/day scales and scheduled runs are spaced hours apart, so a
// learned interval is meaningful for hours. 6 hours covers typical quota-reset
// cadences and expected run spacing while still discarding arbitrarily old rates.
const CHATGPT_PACING_STATE_STALENESS_MS = 6 * 60 * 60 * 1000; // 6 hours

interface ChatGptPersistedPacing {
  intervalMs: number;
  recordedAtMs: number;
}

/** Read the persisted learned interval from the messages cursor, if present. */
export function readChatGptPersistedPacing(state: CollectContext["state"] | undefined): ChatGptPersistedPacing | null {
  const messages = (state as { messages?: Record<string, unknown> } | undefined)?.messages;
  if (!messages || typeof messages !== "object") {
    return null;
  }
  const intervalMs = (messages as Record<string, unknown>)[CHATGPT_PACING_STATE_INTERVAL_KEY];
  const recordedAtMs = (messages as Record<string, unknown>)[CHATGPT_PACING_STATE_RECORDED_AT_KEY];
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null;
  }
  if (typeof recordedAtMs !== "number" || !Number.isFinite(recordedAtMs)) {
    return null;
  }
  return { intervalMs, recordedAtMs };
}

// NOTE: the warm-start staleness guard (§10-E) is no longer applied here. The
// raw persisted pacing (`readChatGptPersistedPacing`) is passed straight to
// `resolveChatGptProviderBudget`, which hands `restoredAtMs` + the 6h
// `maxWarmStartAgeMs` to ProviderPacing — the shared primitive owns the
// cold-re-entry decision so every connector inherits it, not just ChatGPT.

/**
 * Build the STATE event fields that persist the controller's final learned
 * interval alongside the messages cursor, so the next run warm-starts from it.
 * Returns an empty object when there is nothing to persist (no pacing).
 *
 * SEED-POISONING GUARD: the persisted interval is CAPPED at the cold-start
 * baseline (`initialIntervalMs`). Warm-start exists only to let the next run
 * START FASTER than a cold start by reusing a learned healthy operating rate — it
 * must never make the next run start SLOWER than cold. A run that ended deep in
 * throttle (e.g. a multi-second interval the AIMD backed off to, or a provider
 * Retry-After spike) would otherwise persist that transient backoff as the seed,
 * and the next run would crawl back toward the ceiling from an interval worse than
 * cold-start — the descent compounding across runs we observed live (a 14.3s seed
 * needing ~140 successful fetches just to re-reach the ceiling). Capping at
 * cold-start means a healthy run persists its fast learned interval (faster next
 * start) while a throttled run persists at most the cold-start baseline (a clean
 * cold re-entry, no poisoning). The within-run backoff still protects the live
 * account; only the CROSS-run seed is floored.
 */
export function buildChatGptPacingStateFields(
  providerBudget: ProviderBudgetController | null | undefined,
  now: () => number = Date.now
): Record<string, number> {
  const snapshot = providerBudget?.snapshotPacing();
  if (!snapshot) {
    return {};
  }
  const persistedIntervalMs = Math.min(snapshot.intervalMs, snapshot.initialIntervalMs);
  return {
    [CHATGPT_PACING_STATE_INTERVAL_KEY]: persistedIntervalMs,
    [CHATGPT_PACING_STATE_RECORDED_AT_KEY]: now(),
  };
}

/**
 * Run-scoped budget for the ChatGPT connector's bounded-run budget. Thin adapter
 * over the shared `RunBudget` that preserves the connector-specific API
 * (`maxFetches`, `recordDetailFetch`, `reason`) for backward compat with
 * existing tests and call sites. New code should use `RunBudget` directly.
 */
export class ChatGptRunBudget {
  readonly maxFetches: number;
  readonly maxWallClockMs: number;
  private readonly inner: RunBudget;

  constructor(options: { maxFetches?: number; maxWallClockMs?: number; now?: () => number } = {}) {
    this.maxFetches = options.maxFetches ?? Number.POSITIVE_INFINITY;
    this.maxWallClockMs = options.maxWallClockMs ?? Number.POSITIVE_INFINITY;
    this.inner = new RunBudget({
      ...(options.maxFetches == null ? {} : { maxRequests: options.maxFetches }),
      ...(options.maxWallClockMs == null ? {} : { maxWallClockMs: options.maxWallClockMs }),
      ...(options.now == null ? {} : { now: options.now }),
    });
  }

  /** Record one admitted conversation-detail request against the run budget. */
  recordDetailFetch(): void {
    this.inner.recordRequest();
  }

  get count(): number {
    return this.inner.count;
  }

  /** Wall-clock spent since the budget was first consulted, in ms. */
  elapsedMs(): number {
    return this.inner.elapsedMs();
  }

  /**
   * Wall-clock budget still available before the time cap trips, in ms
   * (`Infinity` when uncapped). Lets a transient back-off — e.g. waiting out an
   * open upstream-pressure circuit — bound its sleep by the time the run truly
   * has left, so a provider slow-down is never mistaken for budget exhaustion.
   */
  remainingWallClockMs(): number {
    return this.inner.remainingWallClockMs();
  }

  /** Returns the trip reason or null. Anchors clock on first call. */
  reason(): "max_detail_fetches" | "max_wall_clock" | null {
    const trip = this.inner.tripReason();
    if (trip === "max_requests") {
      return "max_detail_fetches";
    }
    if (trip === "max_wall_clock") {
      return "max_wall_clock";
    }
    return null;
  }

  /** True once any cap has been reached. */
  shouldStop(): boolean {
    return this.reason() !== null;
  }
}

export const CHATGPT_RETRYABLE_ERROR_PATTERN = /ECONN|ETIMEDOUT|fetch failed|429|retry budget exhausted/i;
const CHATGPT_BACKEND_FETCH_TIMEOUT_ENV = "PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS";
const CHATGPT_BACKEND_FETCH_TIMEOUT_MS = 45_000;
const CHATGPT_BACKEND_EVALUATE_TIMEOUT_BUFFER_MS = 5000;
const CHATGPT_SIDE_EFFECT_PROBE_ENV = "PDPP_CHATGPT_SIDE_EFFECT_PROBE";
const CHATGPT_CONVERSATION_DETAIL_PATH_PATTERN = /^\/conversation\/[^/?#]+(?:[?#].*)?$/;
const URL_QUERY_OR_FRAGMENT_PATTERN = /[?#].*$/;

export type ChatGptRunCapReason = "circuit_open" | "max_detail_fetches" | "max_wall_clock" | "provider_retry_budget";

export type ChatGptRetryExhaustedClass = "rate_limited" | "temporary_unavailable" | "upstream_pressure";

export interface ChatGptNetworkPressureDiagnostic {
  attempt?: number;
  endpoint_route: string;
  error_class: string;
  max_attempts?: number;
  method: string;
  retry_after_ms?: number;
  safe_headers?: Record<string, string | number>;
  status?: number;
}

export class ChatGptRecoverableRetryExhaustedError extends Error {
  readonly class: ChatGptRetryExhaustedClass;
  readonly httpStatus: number | null;
  readonly networkPressure: ChatGptNetworkPressureDiagnostic | undefined;

  constructor(
    message: string,
    details: {
      class: ChatGptRetryExhaustedClass;
      httpStatus?: number | null;
      networkPressure?: ChatGptNetworkPressureDiagnostic;
    }
  ) {
    super(message);
    this.name = "ChatGptRecoverableRetryExhaustedError";
    this.class = details.class;
    this.httpStatus = details.httpStatus ?? null;
    this.networkPressure = details.networkPressure;
  }
}

export class ChatGptPlannedProviderBudgetDeferredError extends Error {
  readonly gate: (ProviderBudgetGate & { ok: false }) | null;
  readonly reason: ChatGptRunCapReason;

  constructor(message: string, reason: ChatGptRunCapReason, gate: (ProviderBudgetGate & { ok: false }) | null = null) {
    super(message);
    this.name = "ChatGptPlannedProviderBudgetDeferredError";
    this.reason = reason;
    this.gate = gate;
  }
}

interface ChatGptBackendFetchArgs {
  auth: ChatGptAuth;
  body?: unknown;
  method: string;
  parseJson?: boolean;
  path: string;
  timeoutMs: number;
}

export function resolveChatGptBackendFetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CHATGPT_BACKEND_FETCH_TIMEOUT_ENV]?.trim();
  if (!raw) {
    return CHATGPT_BACKEND_FETCH_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return CHATGPT_BACKEND_FETCH_TIMEOUT_MS;
  }
  return Math.ceil(parsed);
}

export async function chatGptBackendFetchInBrowser({
  auth,
  body,
  method,
  parseJson = true,
  path,
  timeoutMs,
}: ChatGptBackendFetchArgs): Promise<ChatGptFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "*/*",
      authorization: `Bearer ${auth.accessToken}`,
      "oai-language": "en-US",
      "content-type": "application/json",
    };
    if (auth.deviceId) {
      headers["oai-device-id"] = auth.deviceId;
    }
    // Build RequestInit with body only when present — under
    // exactOptionalPropertyTypes, spreading {body: undefined} doesn't
    // match BodyInit | null. This is what the old @ts-expect-error
    // was papering over.
    const init: RequestInit = {
      method,
      credentials: "include",
      headers,
      signal: controller.signal,
    };
    if (body) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`https://chatgpt.com/backend-api${path}`, init);
    const status = res.status;
    const retryAfter = res.headers.get("retry-after") ?? undefined;
    let json: unknown = null;
    if (parseJson) {
      try {
        json = await res.json();
      } catch {
        json = null;
      }
    }
    return {
      status,
      json: json as ChatGptFetchResult["json"],
      ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`chatgpt_backend_fetch_timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function formatSleepDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  return remainderSeconds ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
}

/**
 * `retryHttp` early-stop predicate implementing the bare-429 source-pressure
 * fast-open. Returns `false` (stop retrying, exhaust now) once a bare 429 —
 * status 429 with no `Retry-After` — has been seen on
 * `CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS` attempts. Every other retryable
 * response (429 + `Retry-After`, 408, 5xx) keeps the full budget.
 *
 * Exported for direct unit testing of the boundary; `retryHttp` owns the
 * exhaustion accounting and error shape.
 */
export function shouldKeepRetryingChatGptDetail({
  attempt,
  response,
  retryAfterMs,
}: {
  attempt: number;
  response: { status: number };
  retryAfterMs: number | null;
}): boolean {
  const isBare429 = response.status === 429 && retryAfterMs == null;
  if (isBare429 && attempt >= CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS) {
    return false;
  }
  return true;
}

export function consumeChatGptProviderRetryBudget(
  providerBudget?: ProviderBudgetController | null
): ChatGptPlannedProviderBudgetDeferredError | null {
  const retryGate = providerBudget?.consumeRetry();
  if (!retryGate || retryGate.ok) {
    return null;
  }
  const reason = chatGptRunCapReasonFromProviderGate(retryGate);
  return new ChatGptPlannedProviderBudgetDeferredError(
    `ChatGPT provider retry budget exhausted (${retryGate.reason}); deferring remaining conversation details`,
    reason,
    retryGate
  );
}

async function admitChatGptProviderBudgetAttempt(
  providerBudget?: ProviderBudgetController | null
): Promise<ChatGptPlannedProviderBudgetDeferredError | null> {
  const providerGate = await providerBudget?.beforeRequest();
  if (!providerGate) {
    return null;
  }
  if (providerGate.ok) {
    providerBudget?.recordRequest();
    return null;
  }
  const reason = chatGptRunCapReasonFromProviderGate(providerGate);
  return new ChatGptPlannedProviderBudgetDeferredError(
    `ChatGPT provider budget gate closed (${providerGate.reason}); deferring remaining conversation details`,
    reason,
    providerGate
  );
}

/**
 * Whether a planned provider-budget defer is a TRANSIENT upstream-pressure
 * circuit trip (`circuit_open`) rather than genuine budget exhaustion
 * (`max_wall_clock` / `max_detail_fetches` / `provider_retry_budget`). The
 * former is a "slow down, then continue" signal the run should wait out within
 * its remaining budget; the latter is a "stop" signal that defers the tail. The
 * live `run_1781150455121` defect was conflating the two — quitting after 136s
 * of a 900s budget because a circuit trip was treated as exhaustion.
 */
function isChatGptTransientCircuitDefer(err: unknown): err is ChatGptPlannedProviderBudgetDeferredError {
  return err instanceof ChatGptPlannedProviderBudgetDeferredError && err.reason === "circuit_open";
}

function classifyRetryExhaustedStatus(status: number | null): ChatGptRetryExhaustedClass {
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 408 || (status != null && status >= 500 && status < 600)) {
    return "temporary_unavailable";
  }
  return "upstream_pressure";
}

function isChatGptRetryableStatus(status: number | undefined): boolean {
  return status === 429 || status === 408 || (status != null && status >= 500 && status < 600);
}

function providerBudgetRetryTokensForProgress(value: number): number | "unbounded" | undefined {
  if (value === Number.POSITIVE_INFINITY) {
    return "unbounded";
  }
  return Number.isFinite(value) ? value : undefined;
}

function providerBudgetTransitionProgress(transition: ProviderBudgetCircuitTransition): ProviderBudgetProgress {
  const retryTokensRemaining = providerBudgetRetryTokensForProgress(transition.retryTokensRemaining);
  const progress: ProviderBudgetProgress = {
    circuit: {
      previous_state: transition.previousState,
      reason: transition.reason,
      state: transition.state,
      trigger: transition.trigger,
    },
    elapsed_ms: transition.elapsedMs,
    object: "provider_budget_circuit_transition" as const,
    request_count: transition.requestCount,
  };
  if (retryTokensRemaining !== undefined) {
    progress.retry_tokens_remaining = retryTokensRemaining;
  }
  return progress;
}

async function emitChatGptProviderBudgetTransitions({
  emit,
  providerBudget,
}: {
  emit?: CollectContext["emit"] | undefined;
  providerBudget?: ProviderBudgetController | null | undefined;
}): Promise<void> {
  if (!(emit && providerBudget)) {
    providerBudget?.drainCircuitTransitions();
    return;
  }
  for (const transition of providerBudget.drainCircuitTransitions()) {
    await emit({
      type: "PROGRESS",
      message: `Provider-budget circuit ${transition.previousState} -> ${transition.state} (${transition.reason})`,
      provider_budget: providerBudgetTransitionProgress(transition),
    });
  }
}

/** Requests/min from an interval (ms); 0 interval reads as 0 rate (never ∞). */
function chatGptRatePerMin(intervalMs: number): number {
  return intervalMs > 0 ? Math.round(60_000 / intervalMs) : 0;
}

/**
 * Build the operator-legible `collection_rate` progress from the controller's
 * pacing snapshot. PURE; carries no account content — only rate numbers and the
 * last back-off reason (SLVP ideal §5: the controller's state is legible).
 */
export function buildChatGptCollectionRateProgress(
  providerBudget: ProviderBudgetController | null | undefined
): CollectionRateProgress | null {
  const snapshot = providerBudget?.snapshotPacing();
  if (!snapshot) {
    return null;
  }
  return {
    ceiling_interval_ms: snapshot.minIntervalMs,
    ceiling_rate_per_min: chatGptRatePerMin(snapshot.minIntervalMs),
    current_interval_ms: snapshot.intervalMs,
    effective_rate_per_min: chatGptRatePerMin(snapshot.intervalMs),
    last_backoff: snapshot.lastBackoff
      ? { at_interval_ms: snapshot.lastBackoff.atIntervalMs, reason: snapshot.lastBackoff.reason }
      : null,
    object: "collection_rate",
  };
}

/**
 * Emit a `collection_rate` progress event when the controller's interval has
 * changed since the last emission (a speed-up or back-off TRANSITION), so the
 * run trace shows the adaptation without one event per request. Returns the
 * interval just emitted so the caller can track the last-seen value.
 */
async function emitChatGptCollectionRateOnChange(
  emit: CollectContext["emit"] | undefined,
  providerBudget: ProviderBudgetController | null | undefined,
  lastEmittedIntervalMs: number | null
): Promise<number | null> {
  if (!(emit && providerBudget)) {
    return lastEmittedIntervalMs;
  }
  const rate = buildChatGptCollectionRateProgress(providerBudget);
  if (!rate || rate.current_interval_ms === lastEmittedIntervalMs) {
    return lastEmittedIntervalMs;
  }
  const backoffSuffix = rate.last_backoff
    ? `; last backed off to ${rate.last_backoff.at_interval_ms}ms (${rate.last_backoff.reason})`
    : "";
  await emit({
    type: "PROGRESS",
    stream: "messages",
    message: `Collection rate ${rate.effective_rate_per_min}/min (interval ${rate.current_interval_ms}ms; ceiling ${rate.ceiling_rate_per_min}/min)${backoffSuffix}`,
    collection_rate: rate,
  });
  return rate.current_interval_ms;
}

function chatGptEndpointRoute(path: string): string {
  if (CHATGPT_CONVERSATION_DETAIL_PATH_PATTERN.test(path)) {
    return "/conversation/{conversation_id}";
  }
  return path.replace(URL_QUERY_OR_FRAGMENT_PATTERN, "");
}

function makeChatGptNetworkPressureDiagnostic({
  attempts,
  cause,
  method,
  path,
}: {
  attempts?: number;
  cause: unknown;
  method: string;
  path: string;
}): ChatGptNetworkPressureDiagnostic {
  const response =
    cause && typeof cause === "object" ? (cause as { headers?: Record<string, string>; status?: number }) : {};
  const status = typeof response.status === "number" ? response.status : undefined;
  const retryAfterMs = retryAfterMsFromHeaders(response.headers);
  return {
    endpoint_route: `${method} ${chatGptEndpointRoute(path)}`,
    error_class: status === undefined ? "network_error" : `http_${status}`,
    method,
    ...(attempts === undefined ? {} : { attempt: attempts, max_attempts: attempts }),
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs == null ? {} : { retry_after_ms: retryAfterMs, safe_headers: { "retry-after-ms": retryAfterMs } }),
  };
}

/**
 * Route one retry's source pressure. retryHttp already slept `delayMs` inside
 * the request, so the lane report is marked `absorbedByRequestWait` to avoid
 * double-paying the backoff on the next launch. In-lane 429s are counted by the
 * lane's cooldown event; 429s OUTSIDE any lane (list pagination, non-detail
 * streams) are surfaced to the run-scoped accumulator so the detail phase can
 * inherit pressure the run already absorbed. Extracted to keep `onRetry` simple.
 *
 * Part A (one backoff per pressure event): `onRetry` fires once PER RETRY
 * ATTEMPT, but a single logical pressure event is ONE HTTP request that ended
 * up throttled — regardless of how many internal attempts it took to clear.
 * `providerBudget.recordThrottle` multiplies the pacing interval by
 * 1/multiplicativeDecreaseFactor (×2) on every call, so recording it per
 * attempt makes ONE 429 that retried 3× inflate the interval ×8. The caller
 * passes `recordPacingThrottle: true` for only the FIRST report of a given
 * request and `false` thereafter, so the interval-affecting throttle is
 * recorded AT MOST ONCE per request. The per-attempt density signal
 * (`laneContext.reportPressure`), the unlaned-429 accumulator, and the
 * circuit-transition emit stay PER ATTEMPT — only the multiplicative pacing
 * decrease is coalesced.
 */
async function reportChatGptRetryPressure({
  delayMs,
  emit,
  onUnlanedRateLimited,
  providerBudget,
  recordPacingThrottle,
  response,
  retryAfterMs,
}: {
  delayMs: number;
  emit?: CollectContext["emit"] | undefined;
  onUnlanedRateLimited?: (() => void) | undefined;
  providerBudget?: ProviderBudgetController | null | undefined;
  recordPacingThrottle: boolean;
  response?: { status?: number } | undefined;
  retryAfterMs?: number | undefined;
}): Promise<void> {
  if (recordPacingThrottle && isChatGptRetryableStatus(response?.status)) {
    providerBudget?.recordThrottle({
      retryAfterAlreadySlept: true,
      ...(retryAfterMs == null ? {} : { retryAfterMs }),
    });
    await emitChatGptProviderBudgetTransitions({ emit, providerBudget });
  }
  const laneContext = currentAdaptiveLaneRunContext();
  await laneContext?.reportPressure({
    absorbedByRequestWait: true,
    delayMs,
    kind: response?.status === 429 ? "rate_limited" : "transient_error",
    ...(retryAfterMs == null ? {} : { retryAfterMs }),
  });
  if (laneContext == null && response?.status === 429) {
    onUnlanedRateLimited?.();
  }
}

export function createChatGptApi({
  capture,
  emit,
  onUnlanedRateLimited,
  page,
  providerBudget,
}: {
  capture: CaptureSession | null;
  emit?: CollectContext["emit"];
  // Invoked once per served 429 that happens OUTSIDE an adaptive lane run
  // context (list pagination, memories, custom_gpts, shared_conversations).
  // In-lane 429s are already counted by the detail lane's cooldown event, so
  // they intentionally do NOT call this — avoiding a double count. Lets the run
  // carry pre-detail source pressure into the detail-phase density stop.
  onUnlanedRateLimited?: () => void;
  page: Page;
  providerBudget?: ProviderBudgetController | null;
}): ChatGptApi {
  let authCache: ChatGptAuth | null = null;
  async function auth(): Promise<ChatGptAuth> {
    if (authCache) {
      return authCache;
    }
    const fresh = await getAuthFromPage(page);
    if (!fresh.accessToken) {
      throw new Error("chatgpt_auth_missing: could not extract bearer token from #client-bootstrap");
    }
    authCache = fresh;
    return fresh;
  }

  // Re-extract the page's CURRENT bearer token, discarding the cached one. The
  // ChatGPT web `access_token` is a short-lived JWT that the browser rotates
  // silently; a long run (the recovery backlog can take 10s of minutes under
  // pacing) outlives the token it cached at run start, so a late fetch sees a
  // stale token and gets a 401 even though the page already holds a fresh one.
  // Clearing the cache and re-reading `#client-bootstrap` picks up the live
  // token. Returns the fresh auth, or throws `chatgpt_auth_missing` if the page
  // genuinely has no token (the session is actually dead → owner reconnect).
  function reauth(): Promise<ChatGptAuth> {
    authCache = null;
    return auth();
  }

  async function fetchOnce(
    path: string,
    { method, body, parseJson = true }: { method: string; body?: unknown; parseJson?: boolean }
  ): Promise<ChatGptFetchResult> {
    const timeoutMs = resolveChatGptBackendFetchTimeoutMs();
    const evaluate = (a: ChatGptAuth): Promise<ChatGptFetchResult> =>
      withTimeout(
        page.evaluate(chatGptBackendFetchInBrowser, { path, method, body, parseJson, auth: a, timeoutMs }),
        timeoutMs + CHATGPT_BACKEND_EVALUATE_TIMEOUT_BUFFER_MS,
        `chatgpt_backend_fetch_evaluate_timeout after ${timeoutMs + CHATGPT_BACKEND_EVALUATE_TIMEOUT_BUFFER_MS}ms`
      );
    const usedAuth = await auth();
    const result = await evaluate(usedAuth);
    // Stale-token self-heal: a 401 on the cached token is almost always a
    // rotated/expired JWT, not a dead session. Re-extract the page's current
    // token ONCE and retry — but only if it actually CHANGED (a different token
    // means the page rotated; an identical token means the session is genuinely
    // unauthorized, so retrying would just loop). If the retry still 401s, or the
    // token is unchanged, the result flows on to `shouldAbort` → terminal auth
    // error, which §10-C routes to a reconnect prompt rather than a silent fail.
    if (result.status === 401) {
      const refreshed = await reauth();
      if (refreshed.accessToken && refreshed.accessToken !== usedAuth.accessToken) {
        return evaluate(refreshed);
      }
    }
    return result;
  }

  function fetchWithRetry(
    path: string,
    {
      body,
      captureResult,
      method,
      parseJson,
    }: { body?: unknown; captureResult: boolean; method: string; parseJson: boolean }
  ): Promise<ChatGptFetchResult> {
    let plannedProviderBudgetDefer: ChatGptPlannedProviderBudgetDeferredError | null = null;
    // Part A: a single fetchWithRetry call is ONE logical pressure event. Record
    // the interval-affecting pacing throttle at most once across all of this
    // request's retry attempts (the first retryable report), so a 429 that
    // retries N times causes ONE ×2 backoff, not N. Reset per request because
    // this closure is fresh each call.
    let pacingThrottleRecordedForThisRequest = false;
    return retryHttp({
      baseDelayMs: CHATGPT_RATE_LIMIT_BASE_DELAY_MS,
      beforeAttempt: async () => {
        plannedProviderBudgetDefer = await admitChatGptProviderBudgetAttempt(providerBudget);
        await emitChatGptProviderBudgetTransitions({ emit, providerBudget });
        if (plannedProviderBudgetDefer) {
          throw plannedProviderBudgetDefer;
        }
      },
      maxAttempts: CHATGPT_RATE_LIMIT_MAX_ATTEMPTS,
      maxDelayMs: CHATGPT_RATE_LIMIT_MAX_DELAY_MS,
      maxRetryAfterMs: CHATGPT_RATE_LIMIT_MAX_RETRY_AFTER_MS,
      // Fast-open the source-pressure circuit on a bare 429 (no Retry-After):
      // a few short attempts, then exhaust so the lane defers the rest as
      // resumable DETAIL_GAP instead of burning the full 12-attempt budget
      // (~23–70 min of backoff) against an already-throttled account.
      // NOTE: we do NOT consume the give-up budget here. Per-request retries are
      // normal backoff — consuming the give-up budget on every retry attempt
      // depleted it during healthy throttled drains (the run_1781302239264 bug).
      // The give-up signal is now progress-based (consecutiveWaitOutsWithoutSuccess).
      shouldKeepRetrying: (input) => shouldKeepRetryingChatGptDetail(input),
      onRetry: async ({ attempt, delayMs, maxAttempts, response, retryAfterMs }) => {
        // retryHttp sleeps `delayMs` itself immediately after this callback,
        // inside the same (serialized) detail attempt. Route the pressure to
        // either the active detail lane or the run-scoped accumulator (extracted
        // so this callback stays simple); see reportChatGptRetryPressure.
        //
        // Part A: only the FIRST retryable report for this request applies the
        // multiplicative pacing backoff (one logical pressure event = one ×2
        // decrease). Consume the once-token only when the status is actually
        // retryable, so a leading network error doesn't waste the token before
        // the real 429 arrives.
        const recordPacingThrottle =
          !pacingThrottleRecordedForThisRequest && isChatGptRetryableStatus(response?.status);
        if (recordPacingThrottle) {
          pacingThrottleRecordedForThisRequest = true;
        }
        await reportChatGptRetryPressure({
          delayMs,
          emit,
          onUnlanedRateLimited,
          providerBudget,
          recordPacingThrottle,
          response,
          retryAfterMs,
        });
        if (delayMs < CHATGPT_LONG_SLEEP_PROGRESS_THRESHOLD_MS) {
          return;
        }
        const status = response?.status ? `HTTP ${response.status}` : "network error";
        const policy =
          retryAfterMs == null
            ? `jittered exponential backoff, capped at ${formatSleepDuration(CHATGPT_RATE_LIMIT_MAX_DELAY_MS)}`
            : `server Retry-After, capped at ${formatSleepDuration(CHATGPT_RATE_LIMIT_MAX_RETRY_AFTER_MS)}`;
        await emit?.({
          type: "PROGRESS",
          message: `ChatGPT rate limit/backoff on ${method} ${chatGptEndpointRoute(path)}: ${status}; waiting ${formatSleepDuration(delayMs)} before ${attempt + 1 === maxAttempts ? "final " : ""}retry ${attempt + 1}/${maxAttempts} (${policy})`,
        });
      },
      request: async () => {
        try {
          const result = await fetchOnce(path, { method, body, parseJson });
          if (captureResult && capture && !isChatGptRetryableStatus(result.status)) {
            capture.captureHttp(`${method}-${path}`, result.json, {
              status: result.status,
              path,
              method,
            });
          }
          return result;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          throw new Error(`apiFetch network error on ${method} ${path}: ${m}`);
        }
      },
      shouldAbort: (result) => result.status === 401 || result.status === 403,
    }).catch((err: unknown) => {
      if (err instanceof TerminalHttpStatusError) {
        throw new Error(`apiFetch got ${err.status} on ${method} ${path} (auth - not retryable)`);
      }
      if (err instanceof RetryExhaustedError) {
        if (plannedProviderBudgetDefer) {
          throw plannedProviderBudgetDefer;
        }
        const cause = err.originalCause;
        const status =
          cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number"
            ? cause.status
            : null;
        throw new ChatGptRecoverableRetryExhaustedError(
          status
            ? `apiFetch got ${status} on ${method} ${path} after retry budget exhausted`
            : `apiFetch retry budget exhausted on ${method} ${path}: ${err.message}`,
          {
            class: classifyRetryExhaustedStatus(status),
            httpStatus: status,
            networkPressure: makeChatGptNetworkPressureDiagnostic({
              attempts: err.attempts,
              cause,
              method,
              path,
            }),
          }
        );
      }
      throw err;
    });
  }

  return {
    auth,
    fetch(
      path: string,
      { method = "GET", body }: { method?: string; body?: unknown } = {}
    ): Promise<ChatGptFetchResult> {
      return fetchWithRetry(path, { method, body, parseJson: true, captureResult: true });
    },
    async fetchBatch(ids: readonly string[]): Promise<ChatGptFetchResult[]> {
      const conversationIds = Array.from(ids);
      if (conversationIds.length > CHATGPT_CONVERSATION_BATCH_MAX_IDS) {
        throw new Error(
          `chatgpt_batch_detail_over_cap: got ${conversationIds.length} ids, max ${CHATGPT_CONVERSATION_BATCH_MAX_IDS}`
        );
      }
      if (conversationIds.length === 0) {
        return [];
      }
      const result = await fetchWithRetry("/conversations/batch", {
        body: { conversation_ids: conversationIds },
        captureResult: true,
        method: "POST",
        parseJson: true,
      });
      const json = result.json as unknown;
      if (result.status !== 200 || !Array.isArray(json)) {
        throw new Error(`chatgpt_batch_detail_unavailable: status=${result.status}`);
      }
      return json
        .filter(
          (item): item is ChatGptFetchResult["json"] =>
            item !== null && typeof item === "object" && !Array.isArray(item)
        )
        .map((item) => ({
          ...(result.headers ? { headers: result.headers } : {}),
          json: item,
          status: result.status,
        }));
    },
    async fetchStatus(
      path: string,
      { method = "GET", body }: { method?: string; body?: unknown } = {}
    ): Promise<Pick<ChatGptFetchResult, "headers" | "status">> {
      const result = await fetchWithRetry(path, { method, body, parseJson: false, captureResult: false });
      return { status: result.status, ...(result.headers ? { headers: result.headers } : {}) };
    },
  };
}

function isChatGptSideEffectProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CHATGPT_SIDE_EFFECT_PROBE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "only";
}

interface ChatGptConversationProbeItem {
  create_time: number | null;
  current_node: string | null;
  id: string | null;
  index: number;
  update_time: number | null;
}

interface ChatGptSideEffectProbeResult {
  after1?: ChatGptConversationProbeItem[];
  after2?: ChatGptConversationProbeItem[];
  before?: ChatGptConversationProbeItem[];
  detail?: {
    create_time: number | null;
    current_node: string | null;
    status: number;
    update_time: number | null;
  };
  ok: boolean;
  stage?: string;
  status?: number;
  target_id?: string | null;
}

function sameOrder(a: ChatGptConversationProbeItem[], b: ChatGptConversationProbeItem[]): boolean {
  return a.map((item) => item.id).join("\n") === b.map((item) => item.id).join("\n");
}

function findProbeItem(
  items: ChatGptConversationProbeItem[] | undefined,
  id: string | null | undefined
): ChatGptConversationProbeItem | null {
  if (!id) {
    return null;
  }
  return items?.find((item) => item.id === id) ?? null;
}

function formatProbeFailure(result: ChatGptSideEffectProbeResult): string {
  const status = result.status ? ` (HTTP ${result.status})` : "";
  return `ChatGPT side-effect probe could not complete at ${result.stage ?? "unknown"}${status}`;
}

function formatProbeValue(value: number | string | boolean | null): string {
  return value == null ? "null" : String(value);
}

function formatProbeIndex(value: number | null): string {
  return value == null ? "missing" : String(value);
}

function probeValueChanged<T>(before: T, after1: T, after2: T): boolean {
  return before !== after1 || before !== after2;
}

function getProbeTargets(result: ChatGptSideEffectProbeResult): {
  after1Target: ChatGptConversationProbeItem | null;
  after2Target: ChatGptConversationProbeItem | null;
  beforeTarget: ChatGptConversationProbeItem | null;
  targetId: string | null;
} {
  const before = result.before ?? [];
  const targetId = result.target_id ?? before[0]?.id ?? null;
  return {
    targetId,
    beforeTarget: findProbeItem(before, targetId),
    after1Target: findProbeItem(result.after1, targetId),
    after2Target: findProbeItem(result.after2, targetId),
  };
}

export function summarizeChatGptSideEffectProbe(result: ChatGptSideEffectProbeResult): string {
  if (!result.ok) {
    return formatProbeFailure(result);
  }

  const before = result.before ?? [];
  const after1 = result.after1 ?? [];
  const after2 = result.after2 ?? [];
  const { after1Target, after2Target, beforeTarget, targetId } = getProbeTargets(result);
  const beforeUpdate = beforeTarget?.update_time ?? null;
  const after1Update = after1Target?.update_time ?? null;
  const after2Update = after2Target?.update_time ?? null;
  const beforeNode = beforeTarget?.current_node ?? null;
  const after1Node = after1Target?.current_node ?? null;
  const after2Node = after2Target?.current_node ?? null;
  const detailNode = result.detail?.current_node ?? null;
  const orderChangedAfter1 = !sameOrder(before, after1);
  const orderChangedAfter2 = !sameOrder(before, after2);
  const indexBefore = beforeTarget?.index ?? null;
  const indexAfter1 = after1Target?.index ?? null;
  const indexAfter2 = after2Target?.index ?? null;
  const updateChanged = probeValueChanged(beforeUpdate, after1Update, after2Update);
  const nodeChanged = probeValueChanged(beforeNode, after1Node, after2Node);

  return [
    "ChatGPT side-effect probe result:",
    `target=${targetId ?? "none"}`,
    `detail_http=${result.detail?.status ?? "none"}`,
    `index=${formatProbeIndex(indexBefore)}>${formatProbeIndex(indexAfter1)}>${formatProbeIndex(indexAfter2)}`,
    `update_time=${formatProbeValue(beforeUpdate)}>${formatProbeValue(after1Update)}>${formatProbeValue(after2Update)}`,
    `current_node=${formatProbeValue(beforeNode)}>${formatProbeValue(after1Node)}>${formatProbeValue(after2Node)}`,
    `detail_current_node=${detailNode ?? "null"}`,
    `order_changed=${orderChangedAfter1 || orderChangedAfter2}`,
    `update_time_changed=${updateChanged}`,
    `current_node_changed=${nodeChanged}`,
  ].join(" ");
}

async function runChatGptSideEffectProbe({
  api,
  emit,
  page,
}: {
  api: ChatGptApi;
  emit: CollectContext["emit"];
  page: Page;
}): Promise<void> {
  await emit({
    type: "PROGRESS",
    stream: "conversations",
    message:
      "ChatGPT side-effect probe enabled; running one GET-only list/detail/list comparison and skipping collection",
  });
  const auth = await api.auth();
  const result = (await page.evaluate(`(async () => {
    const accessToken = ${JSON.stringify(auth.accessToken)};
    const deviceId = ${JSON.stringify(auth.deviceId)};
    const metadata = (value, index) => {
      const item = value && typeof value === "object" ? value : {};
      return {
        index,
        id: typeof item.id === "string" ? item.id : null,
        create_time: typeof item.create_time === "number" ? item.create_time : null,
        update_time: typeof item.update_time === "number" ? item.update_time : null,
        current_node: typeof item.current_node === "string" ? item.current_node : null,
      };
    };
    const pickList = (json) => {
      const body = json && typeof json === "object" ? json : {};
      const items = Array.isArray(body.items) ? body.items : [];
      return items.slice(0, 5).map((item, index) => metadata(item, index));
    };
    const getJson = async (path) => {
      const headers = {
        accept: "*/*",
        authorization: "Bearer " + accessToken,
        "oai-language": "en-US",
      };
      if (deviceId) {
        headers["oai-device-id"] = deviceId;
      }
      const res = await fetch("https://chatgpt.com/backend-api" + path, {
        credentials: "include",
        headers,
        method: "GET",
      });
      let json = null;
      if (res.ok) {
        try {
          json = await res.json();
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    };

    if (!accessToken) {
      return { ok: false, stage: "auth_extract" };
    }

    const beforeRes = await getJson("/conversations?offset=0&limit=5&order=updated");
    if (beforeRes.status !== 200) {
      return { ok: false, stage: "before_list", status: beforeRes.status };
    }
    const before = pickList(beforeRes.json);
    const target = before[0];
    if (!target || !target.id) {
      return { ok: false, stage: "select_target", before };
    }

    const detailRes = await getJson("/conversation/" + encodeURIComponent(target.id));
    const detailBody = detailRes.json && typeof detailRes.json === "object" ? detailRes.json : {};
    const detail = {
      status: detailRes.status,
      create_time: typeof detailBody.create_time === "number" ? detailBody.create_time : null,
      update_time: typeof detailBody.update_time === "number" ? detailBody.update_time : null,
      current_node: typeof detailBody.current_node === "string" ? detailBody.current_node : null,
    };

    const after1Res = await getJson("/conversations?offset=0&limit=5&order=updated");
    if (after1Res.status !== 200) {
      return {
        ok: false,
        stage: "after1_list",
        status: after1Res.status,
        before,
        detail,
        target_id: target.id,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const after2Res = await getJson("/conversations?offset=0&limit=5&order=updated");
    if (after2Res.status !== 200) {
      return {
        ok: false,
        stage: "after2_list",
        status: after2Res.status,
        before,
        after1: pickList(after1Res.json),
        detail,
        target_id: target.id,
      };
    }

    return {
      ok: true,
      before,
      after1: pickList(after1Res.json),
      after2: pickList(after2Res.json),
      detail,
      target_id: target.id,
    };
  })()`)) as ChatGptSideEffectProbeResult;

  await emit({
    type: "PROGRESS",
    stream: "conversations",
    message: summarizeChatGptSideEffectProbe(result),
  });
}

// ─── Per-stream helpers ────────────────────────────────────────────────

/** Per-run dependency bag threaded through every emit-path helper. Mirrors
 *  the amazon/chase pattern: one stable bag so collect() becomes pure
 *  orchestration and the helpers are individually testable. */
export interface StreamDeps {
  api: ChatGptApi;
  detailGaps?: CollectContext["detailGaps"];
  emit: CollectContext["emit"];
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  // Run-scoped accumulator for served 429s seen OUTSIDE the detail lane (list
  // pagination + the non-detail streams). Read once when the detail phase starts
  // to seed its density tracker, so the run carries pre-detail source pressure
  // forward instead of resetting the budget to zero. A holder object (not a bare
  // number) so the count `createChatGptApi` increments is visible by reference.
  preDetailPressure?: ChatGptPreDetailPressure;
  progress: CollectContext["progress"];
  providerBudget?: ProviderBudgetController | null;
  /**
   * SLVP-ideal §4.3: when true, `runConversationsAndMessagesStreams` MUST run
   * the gap-recovery pass then return before any forward walk / list-phase
   * fetches. Prevents the recovery lane from re-pressuring the source the
   * source-pressure cooldown is protecting (§4.4 mandatory sequencing guard).
   * Threaded from CollectContext.recoveryOnly → collect() → StreamDeps.
   */
  recoveryOnly?: boolean;
  requestDetailGapPage?: CollectContext["requestDetailGapPage"];
  requested: CollectContext["requested"];
  // Run-scoped bounded-run cap shared across the gap-recovery pass and the
  // forward-walk pass, so a large recovery backlog plus new conversations are
  // bounded together. Absent means helpers fall back to the connector defaults;
  // tests can pass an empty budget object to exercise the no-cap primitive.
  runBudget?: ChatGptRunBudget;
}

/** Mutable holder for the run-scoped pre-detail served-429 count. */
export interface ChatGptPreDetailPressure {
  rateLimited: number;
}

const MEMORIES_PATH = "/memories?include_memory_entries=true";

/**
 * Fetch /memories and emit one record per entry.
 *
 * Invariants:
 *   - On http !== 200, emits a SKIP_RESULT and no records.
 *   - On success, emits records in list order, then a STATE heartbeat.
 *   - buildMemoryRecord filters entries with no id; those drop silently.
 */
export async function runMemoriesStream(deps: StreamDeps): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "memories",
    message: "Fetching memories",
  });
  const res = await deps.api.fetch(MEMORIES_PATH);
  if (res.status !== 200) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "memories",
      reason: "http_error",
      message: `memories fetch http ${res.status}`,
      diagnostics: { http_status: res.status },
    });
    return;
  }
  const entries =
    (res.json?.memories as RawMemoryEntry[] | undefined) || (res.json?.items as RawMemoryEntry[] | undefined) || [];
  for (const m of entries) {
    const rec = buildMemoryRecord(m);
    if (rec) {
      await deps.emitRecord("memories", rec);
    }
  }
  deps.emit({
    type: "STATE",
    stream: "memories",
    cursor: { fetched_at: nowIso() },
  });
}

/**
 * Fetch /user_system_messages and emit at most one custom_instructions
 * record (there is only one per user). 404/403 → SKIP "not_available";
 * other non-200 → SKIP "http_error". Success path emits the record and a
 * STATE heartbeat.
 */
export async function runCustomInstructionsStream(
  deps: StreamDeps,
  state: CollectContext["state"] = {}
): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "custom_instructions",
    message: "Fetching custom instructions",
  });
  const res = await deps.api.fetch("/user_system_messages");
  if (res.status === 404 || res.status === 403) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "custom_instructions",
      reason: "not_available",
      message: `user_system_messages http ${res.status}`,
    });
    return;
  }
  if (res.status !== 200) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "custom_instructions",
      reason: "http_error",
      message: `user_system_messages http ${res.status}`,
      diagnostics: { http_status: res.status },
    });
    return;
  }
  // `/user_system_messages` returns the full custom-instructions body every run.
  // The record carries a stable synthetic id and no run-clock field, so a
  // per-record fingerprint over the whole body is the exact "did the source
  // move?" gate. Without it, this single record re-versions on every run even
  // when the user never edits their instructions (the dashboard's
  // custom_instructions churn was 100% byte-identical no-op re-emit).
  const fingerprintCursor = openFingerprintCursor(state.custom_instructions);
  const record = buildCustomInstructionsRecord(res.json as RawCustomInstructionsBody);
  if (fingerprintCursor.shouldEmit(record)) {
    await deps.emitRecord("custom_instructions", record);
  }
  deps.emit({
    type: "STATE",
    stream: "custom_instructions",
    cursor: { fetched_at: nowIso(), fingerprints: fingerprintCursor.toState() },
  });
}

/**
 * Process a single fetched conversation detail payload: emit the merged
 * conversation record first, then emit messages along the current branch
 * (if the messages stream was requested).
 *
 * Parent-first emit order per Tranche C decision 2026-04-23 — matches the
 * rest of the connector fleet (amazon, chase, usaa, slack, codex). Consumers
 * that upsert conversations + messages see the conversation row before any
 * of its messages.
 *
 * When `detail.status !== 200` or the mapping is missing, emits a
 * `SKIP_RESULT` on the messages stream and falls back to a list-only
 * conversation record (null detail) so the conversation itself still
 * lands downstream.
 */
export async function processConversationDetail(
  deps: StreamDeps,
  c: ConversationListItem,
  detail: ChatGptFetchResult,
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>
): Promise<void> {
  if (detail.status !== 200 || !detail.json?.mapping) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: detail.status === 200 ? "missing_mapping" : "http_error",
      message: `conversation ${c.id} http ${detail.status}`,
      diagnostics: { http_status: detail.status, conversation_id: c.id },
    });
    // Fall back to list-only conversation record.
    await emitConversation(c, null);
    return;
  }
  // Emit conversation record first (parent-first), then messages.
  await emitConversation(c, detail.json as ConversationDetail);
  const mapping = detail.json.mapping;
  const currentNode = detail.json.current_node || c.current_node;
  const currentBranchIds = new Set(flattenTreeCurrentBranch(mapping, currentNode).map((x) => x.nodeId));
  let emittedMessageCount = 0;
  for (const [nodeId, node] of Object.entries(mapping)) {
    const msg = extractMessage(nodeId, node, c.id, currentBranchIds.has(nodeId));
    if (!msg?.role) {
      // synthetic root — skip
      continue;
    }
    emittedMessageCount += 1;
    await deps.emitRecord("messages", msg);
  }
  if (emittedMessageCount === 0) {
    // Completeness guard. A 200-with-mapping detail whose graph contains NO
    // message-bearing node leaves a bare conversation row with zero messages
    // and, without this, no signal at all — indistinguishable downstream from
    // data loss. This is the silent-empty class the dataconnect completeness
    // audit (2026-06-02) flagged as recommendation #5: "a 200-response whose
    // mapping yields zero kept nodes for a conversation with a non-empty title
    // should be flagged, not emitted as an empty conversation."
    //
    // It is NOT a fetch failure (the conversation record still emitted and the
    // conversation still counts as hydrated/covered — we successfully reached
    // it), so this is a SKIP_RESULT diagnostic, not a DETAIL_GAP. It exists so
    // an empty conversation is observable rather than silent, which matters
    // more as detail concurrency rises and partial/interleaved states become
    // more likely. The `node_count` lets a reviewer distinguish a genuinely
    // empty graph (0) from one whose every node was synthetic/role-less (>0).
    deps.emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: "empty_detail",
      message: `conversation ${c.id} returned http 200 with a mapping but no message-bearing nodes`,
      diagnostics: {
        http_status: 200,
        conversation_id: c.id,
        node_count: Object.keys(mapping).length,
      },
    });
  }
}

const PAGINATION_SAFETY_LIMIT = 5000;
const GIZMO_MAX_PAGES = 50;

export async function runCustomGptsStream(deps: StreamDeps): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "custom_gpts",
    message: "Fetching custom GPTs",
  });
  let cursor: string | null = null;
  let pages = 0;
  let anyError = false;
  do {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=100` : "?limit=100";
    const res = await deps.api.fetch(`/gizmos/mine${qs}`);
    if (res.status === 404 || res.status === 403) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "custom_gpts",
        reason: "not_available",
        message: `gizmos/mine http ${res.status} (feature may be disabled for this account)`,
      });
      anyError = true;
      break;
    }
    if (res.status !== 200) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "custom_gpts",
        reason: "http_error",
        message: `gizmos/mine http ${res.status}`,
        diagnostics: { http_status: res.status },
      });
      anyError = true;
      break;
    }
    const items = (res.json?.items as unknown[] | undefined) || (res.json?.gizmos as unknown[] | undefined) || [];
    for (const raw of items) {
      const rec = buildGizmoRecord(raw);
      if (rec) {
        await deps.emitRecord("custom_gpts", rec);
      }
    }
    cursor = (res.json?.cursor as string | null | undefined) ?? null;
    pages++;
    if (pages > GIZMO_MAX_PAGES) {
      break;
    }
    if (!items.length) {
      break;
    }
  } while (cursor);
  if (!anyError) {
    deps.emit({
      type: "STATE",
      stream: "custom_gpts",
      cursor: { fetched_at: nowIso() },
    });
  }
}

export async function runSharedConversationsStream(
  deps: StreamDeps,
  state: CollectContext["state"] = {}
): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "shared_conversations",
    message: "Fetching shared conversations",
  });
  // `/shared_conversations` is re-listed in full every run; each share record
  // carries a stable id and no run-clock field, so a per-record fingerprint
  // over the whole body is the exact "did this share move?" gate. Without it
  // every still-present share re-versions on every run even when nothing
  // changed (the dashboard's shared_conversations churn was 100%
  // byte-identical no-op re-emit). This is a full scan, so stale ids (shares
  // the user deleted on the source) are pruned from the carry-forward map
  // after a clean pass.
  const fingerprintCursor = openFingerprintCursor(state.shared_conversations);
  let offset = 0;
  const limit = 100;
  let sawError = false;
  while (true) {
    const res = await deps.api.fetch(`/shared_conversations?offset=${offset}&limit=${limit}&order=created`);
    if (res.status === 404 || res.status === 403) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "shared_conversations",
        reason: "not_available",
        message: `shared_conversations http ${res.status}`,
      });
      sawError = true;
      break;
    }
    if (res.status !== 200) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "shared_conversations",
        reason: "http_error",
        message: `shared_conversations http ${res.status}`,
        diagnostics: { http_status: res.status },
      });
      sawError = true;
      break;
    }
    const items = (res.json?.items as RawSharedConversation[] | undefined) || [];
    if (!items.length) {
      break;
    }
    for (const s of items) {
      const rec = buildSharedConversationRecord(s);
      if (rec && fingerprintCursor.shouldEmit(rec)) {
        await deps.emitRecord("shared_conversations", rec);
      }
    }
    if (items.length < limit) {
      break;
    }
    offset += items.length;
    if (offset > PAGINATION_SAFETY_LIMIT) {
      break;
    }
  }
  if (!sawError) {
    // Only prune after a clean full pass — an aborted/errored scan never saw
    // every id and must not drop carry-forward entries it failed to observe.
    fingerprintCursor.pruneStale();
    deps.emit({
      type: "STATE",
      stream: "shared_conversations",
      cursor: { fetched_at: nowIso(), fingerprints: fingerprintCursor.toState() },
    });
  }
}

// ─── Conversations + messages ──────────────────────────────────────────

/**
 * Walk /conversations pages newer than priorCursor and collect the list
 * items we still need to sync. Stops early once any update_time <= priorCursor
 * (conversations are returned ordered by updated desc).
 */
async function listConversationsSinceCursor(
  deps: StreamDeps,
  priorCursor: string | null
): Promise<ConversationListItem[]> {
  const convosToSync: ConversationListItem[] = [];
  let offset = 0;
  const limit = 100;
  let stopPaging = false;
  deps.emit({
    type: "PROGRESS",
    stream: "conversations",
    message: priorCursor ? `Listing conversations updated after ${priorCursor}` : "Listing conversations (full pass)",
  });
  while (!stopPaging) {
    const res = await deps.api.fetch(`/conversations?offset=${offset}&limit=${limit}&order=updated`);
    if (res.status !== 200) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "conversations",
        reason: "http_error",
        message: `conversations list http ${res.status}`,
        diagnostics: { http_status: res.status },
      });
      break;
    }
    const items = (res.json?.items as ConversationListItem[] | undefined) || [];
    if (!items.length) {
      break;
    }
    for (const c of items) {
      const updateIso = c.update_time ? tsToIso(c.update_time) : null;
      if (priorCursor && updateIso && updateIso <= priorCursor) {
        stopPaging = true;
        break;
      }
      convosToSync.push(c);
    }
    if (items.length < limit) {
      break;
    }
    offset += items.length;
    if (offset > PAGINATION_SAFETY_LIMIT) {
      break;
    }
  }
  return convosToSync;
}

function conversationIsAfterCursor(c: ConversationListItem, priorCursor: string | null): boolean {
  if (!priorCursor) {
    return true;
  }
  const updateIso = c.update_time ? tsToIso(c.update_time) : null;
  return !updateIso || updateIso > priorCursor;
}

function oldestConversationCursor(a: string | null, b: string | null): string | null {
  if (!(a && b)) {
    return null;
  }
  return a <= b ? a : b;
}

type ConversationListForCursor = (cursor: string | null) => Promise<ConversationListItem[]>;

async function selectConversationListsForRequestedStreams({
  wantsConversations,
  wantsMessages,
  priorConversationsCursor,
  priorMessagesCursor,
  listForCursor,
}: {
  wantsConversations: boolean;
  wantsMessages: boolean;
  priorConversationsCursor: string | null;
  priorMessagesCursor: string | null;
  listForCursor: ConversationListForCursor;
}): Promise<{
  conversationsToSync: ConversationListItem[];
  messageDetailConversations: ConversationListItem[];
}> {
  if (wantsConversations && wantsMessages) {
    const sharedCursor = oldestConversationCursor(priorConversationsCursor, priorMessagesCursor);
    const sharedList = await listForCursor(sharedCursor);
    return {
      conversationsToSync: sharedList.filter((c) => conversationIsAfterCursor(c, priorConversationsCursor)),
      messageDetailConversations: sharedList.filter((c) => conversationIsAfterCursor(c, priorMessagesCursor)),
    };
  }
  if (wantsConversations) {
    return {
      conversationsToSync: await listForCursor(priorConversationsCursor),
      messageDetailConversations: [],
    };
  }
  if (wantsMessages) {
    return {
      conversationsToSync: [],
      messageDetailConversations: await listForCursor(priorMessagesCursor),
    };
  }
  return { conversationsToSync: [], messageDetailConversations: [] };
}

// ε ANTI-PHASE-LOCK JITTER, NOT a rate floor. The lane waits
// `max(launchDelay≈εjitter, cooldown, pacingDelayHint())`; the GCRA rate-AIMD
// (pacingDelayHint) is the SOLE rate authority. These bounds are a sub-second
// ±ε noise band — a single serial collector has no competing flows for which a
// jitter *floor* has any convergence role, so jitter survives only to break
// timing patterns, never to cap throughput below the controller's learned rate.
// (Legacy 1500/3000 was a hand-tuned manual throttle that overrode the
// controller from below — the single biggest delete per the SLVP ideal.)
const CONVO_DETAIL_PAUSE_MIN_MS = 0;
const CONVO_DETAIL_PAUSE_MAX_MS = 150;
const CONVO_DETAIL_INITIAL_CONCURRENCY = 1;
// Concurrency is a HARD, NON-ADAPTIVE ceiling of 1 — not a second control
// dimension. With max === initial === 1 the lane's concurrency-AIMD
// (maybeIncreaseConcurrency) is inert dead code (`currentConcurrency >=
// maxConcurrency` is always true); rate is the single adaptive variable.
const CONVO_DETAIL_MAX_CONCURRENCY = 1;

// ─── Cold-state A/B probe overrides (DEFAULTS FROZEN) ────────────────────
//
// The detail-lane concurrency MUST stay at `1` in production until a
// genuinely cold-state live run produces clean evidence — see
// openspec/changes/add-connector-adaptive-lanes (design.md "Live Evidence":
// "ChatGPT `maxConcurrency` MUST stay at `1`...") and its Tasks §6 owner-only
// gate. The 2026-06-02 A/B probe showed even the minimal serial lane hits
// ~38% bare-429 on a hot account, so raising request rate is unsafe while
// hot and only justified from a cold start.
//
// These resolvers exist solely to let the OWNER run that cold-state A/B
// against the REAL connector lane (with real DETAIL_GAP/cursor semantics)
// without hand-editing — and committing — the frozen constants. They are
// PROBE-ONLY knobs: when the env vars are unset/invalid the production
// defaults (concurrency 1 / 1, ε-jitter 0ms / 150ms) hold exactly. The pause
// knobs now tune the ε anti-phase-lock band, NOT a rate floor — the GCRA
// rate-AIMD is the rate authority. Do NOT set the concurrency probe in a
// production environment; setting concurrency > 1 against a hot account
// increases 429 pressure.
const CHATGPT_DETAIL_INITIAL_CONCURRENCY_ENV = "PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY_PROBE";
const CHATGPT_DETAIL_MAX_CONCURRENCY_ENV = "PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE";
const CHATGPT_DETAIL_PAUSE_MIN_MS_ENV = "PDPP_CHATGPT_DETAIL_PAUSE_MIN_MS_PROBE";
const CHATGPT_DETAIL_PAUSE_MAX_MS_ENV = "PDPP_CHATGPT_DETAIL_PAUSE_MAX_MS_PROBE";
// Hard ceiling on the probe override. Even a cold-state A/B should not fan out
// beyond dataconnect's own batch size (5); anything higher is not an A/B, it is
// a different, untested posture.
const CHATGPT_DETAIL_PROBE_MAX_CONCURRENCY_CEILING = 5;

function resolvePositiveIntOverride(raw: string | undefined, fallback: number, ceiling: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, ceiling);
}

function resolvePositiveMsOverride(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export interface ChatGptDetailLaneTuning {
  initialConcurrency: number;
  maxConcurrency: number;
  pauseMaxMs: number;
  pauseMinMs: number;
}

/**
 * Resolve the conversation-detail lane tuning. With no probe env vars set this
 * returns the frozen production defaults; the OpenSpec concurrency constraint is
 * therefore preserved by default. Invalid values fall back to the default for
 * that knob. `maxConcurrency` is capped at `CHATGPT_DETAIL_PROBE_MAX_CONCURRENCY_CEILING`
 * and clamped to be >= `initialConcurrency`; `pauseMaxMs` is clamped to be >=
 * `pauseMinMs` so the lane's jitter window is always valid.
 */
export function resolveChatGptDetailLaneTuning(env: NodeJS.ProcessEnv = process.env): ChatGptDetailLaneTuning {
  const initialConcurrency = resolvePositiveIntOverride(
    env[CHATGPT_DETAIL_INITIAL_CONCURRENCY_ENV],
    CONVO_DETAIL_INITIAL_CONCURRENCY,
    CHATGPT_DETAIL_PROBE_MAX_CONCURRENCY_CEILING
  );
  const maxConcurrency = Math.max(
    initialConcurrency,
    resolvePositiveIntOverride(
      env[CHATGPT_DETAIL_MAX_CONCURRENCY_ENV],
      CONVO_DETAIL_MAX_CONCURRENCY,
      CHATGPT_DETAIL_PROBE_MAX_CONCURRENCY_CEILING
    )
  );
  const pauseMinMs = resolvePositiveMsOverride(env[CHATGPT_DETAIL_PAUSE_MIN_MS_ENV], CONVO_DETAIL_PAUSE_MIN_MS);
  const pauseMaxMs = Math.max(
    pauseMinMs,
    resolvePositiveMsOverride(env[CHATGPT_DETAIL_PAUSE_MAX_MS_ENV], CONVO_DETAIL_PAUSE_MAX_MS)
  );
  return { initialConcurrency, maxConcurrency, pauseMinMs, pauseMaxMs };
}

// ─── Cold-state preflight source-pressure classifier ────────────────────
//
// The cold-state A/B (PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE > 1) is the
// owner-only test that decides whether ChatGPT detail concurrency may ever rise
// above the frozen serial default. The 2026-06-02 evidence showed the throttle
// is per-ACCOUNT and time-varying: the same serial lane saw ~38% bare-429 while
// hot, then 0% hours later once cold. Raising concurrency is only safe from a
// genuinely cold start; firing a faster posture into a hot account is exactly
// the escalation the prior probe declined.
//
// This preflight closes that gap WITHOUT touching production. When the owner
// opts into the A/B by raising probe concurrency, the connector first fires a
// few SERIAL, content-free GET detail probes to classify the account. The
// request necessarily targets a conversation id, but the probe never parses or
// captures bodies and never emits bodies, titles, ids, or tokens. If any probe
// 429s, the run is forced back to the frozen serial posture (1/1) for safety
// and the faster posture is abandoned for this run. Only a clean preflight lets
// the requested faster tuning through.
//
// Invariants:
//   - Skipped entirely when maxConcurrency === 1 (production). No extra requests
//     on a normal run; the OpenSpec serial constraint holds byte-for-byte.
//   - Fails SAFE: any probe error or 429 → serial. It can only ever make a run
//     MORE conservative, never less.
//   - Reads only HTTP status. Emits no records and no sensitive strings.
const CHATGPT_PREFLIGHT_PROBE_COUNT = 3;

export interface ChatGptSourcePressureClassification {
  attempted: number;
  classification: "cold" | "pressured";
  rateLimited: number;
}

function isChatGptPressureStatus(status: number | undefined): boolean {
  return isChatGptRetryableStatus(status);
}

function rateLimitedCountForPreflightError(error: unknown): number {
  return error instanceof ChatGptRecoverableRetryExhaustedError ? 1 : 0;
}

function fetchChatGptPressureProbeStatus(
  deps: Pick<StreamDeps, "api">,
  id: string
): Promise<Pick<ChatGptFetchResult, "headers" | "status">> {
  if (!deps.api.fetchStatus) {
    throw new Error("ChatGPT status-only preflight is unavailable");
  }
  return deps.api.fetchStatus(`/conversation/${encodeURIComponent(id)}`);
}

async function classifyChatGptSerialPressure(
  deps: Pick<StreamDeps, "api">,
  ids: readonly string[]
): Promise<ChatGptSourcePressureClassification> {
  let attempted = 0;
  let rateLimited = 0;
  for (const id of ids) {
    attempted += 1;
    let status: number;
    try {
      const res = await fetchChatGptPressureProbeStatus(deps, id);
      status = res.status;
    } catch (err) {
      rateLimited += rateLimitedCountForPreflightError(err);
      return { attempted, classification: "pressured", rateLimited };
    }
    if (isChatGptPressureStatus(status)) {
      rateLimited += 1;
      return { attempted, classification: "pressured", rateLimited };
    }
  }
  return { attempted, classification: "cold", rateLimited };
}

async function classifyChatGptBurstPressure(
  deps: Pick<StreamDeps, "api">,
  probeIds: readonly string[],
  burstConcurrency: number
): Promise<ChatGptSourcePressureClassification> {
  const burstSize = Math.max(0, Math.floor(burstConcurrency));
  const ids = probeIds.slice(0, Math.min(probeIds.length, burstSize));
  if (ids.length <= 1) {
    return { attempted: 0, classification: "cold", rateLimited: 0 };
  }
  const results = await Promise.allSettled(ids.map((id) => fetchChatGptPressureProbeStatus(deps, id)));
  let rateLimited = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      rateLimited += rateLimitedCountForPreflightError(result.reason);
      return { attempted: results.length, classification: "pressured", rateLimited };
    }
    if (isChatGptPressureStatus(result.value.status)) {
      rateLimited += 1;
      return { attempted: results.length, classification: "pressured", rateLimited };
    }
  }
  return { attempted: results.length, classification: "cold", rateLimited };
}

/**
 * Fire up to `probeCount` SERIAL, content-free detail probes and classify the
 * account, then optionally replay the same ids as one bounded burst canary that
 * matches the requested raised concurrency. Any 429 (or required-detail HTTP
 * failure) marks the account `pressured`; an all-200 sweep marks it `cold`.
 * Stops at the first serial 429 — one rate-limit signal is enough to force the
 * conservative posture, and continuing would add load to an already-pressured
 * bucket.
 *
 * Probes reuse the connector's own `api.fetchStatus` (so they ride the same
 * browser transport, auth, and `retryHttp`/fast-open path the real lane uses).
 * The browser fetch does not parse response JSON; only `status` is inspected.
 */
export async function classifyChatGptSourcePressure(
  deps: Pick<StreamDeps, "api">,
  probeIds: readonly string[],
  probeCount = CHATGPT_PREFLIGHT_PROBE_COUNT,
  burstConcurrency = 1
): Promise<ChatGptSourcePressureClassification> {
  if (!deps.api.fetchStatus) {
    return { attempted: 0, classification: "pressured", rateLimited: 0 };
  }
  const ids = probeIds.slice(0, Math.max(0, probeCount));
  const serial = await classifyChatGptSerialPressure(deps, ids);
  if (serial.classification === "pressured") {
    return serial;
  }
  const burst = await classifyChatGptBurstPressure(deps, probeIds, burstConcurrency);
  if (burst.classification === "pressured") {
    return {
      attempted: serial.attempted + burst.attempted,
      classification: "pressured",
      rateLimited: serial.rateLimited + burst.rateLimited,
    };
  }
  return { attempted: serial.attempted + burst.attempted, classification: "cold", rateLimited: 0 };
}

/** The frozen serial posture a pressured preflight forces a run back to. */
const CHATGPT_SERIAL_TUNING: ChatGptDetailLaneTuning = {
  initialConcurrency: CONVO_DETAIL_INITIAL_CONCURRENCY,
  maxConcurrency: CONVO_DETAIL_MAX_CONCURRENCY,
  pauseMinMs: CONVO_DETAIL_PAUSE_MIN_MS,
  pauseMaxMs: CONVO_DETAIL_PAUSE_MAX_MS,
};

/**
 * Decide the effective detail-lane tuning for this run. When the requested
 * tuning is the serial production default (maxConcurrency === 1) this is a
 * no-op: it returns the requested tuning without firing any probe, so a normal
 * run is byte-for-byte unchanged. When the owner has opted into a faster A/B
 * posture (maxConcurrency > 1), it runs a content-free serial preflight and
 * forces the run back to serial if the account is pressured.
 */
export async function applyChatGptColdStatePreflight(
  deps: StreamDeps,
  convosToSync: readonly ConversationListItem[],
  requestedTuning: ChatGptDetailLaneTuning
): Promise<ChatGptDetailLaneTuning> {
  if (requestedTuning.maxConcurrency <= 1) {
    return requestedTuning;
  }
  const probeIds = convosToSync.slice(0, CHATGPT_PREFLIGHT_PROBE_COUNT).map((c) => c.id);
  if (!probeIds.length) {
    return requestedTuning;
  }
  deps.emit({
    type: "PROGRESS",
    stream: "messages",
    message: `ChatGPT cold-state preflight: probing source pressure with ${probeIds.length} serial detail request(s) before raising detail concurrency to ${requestedTuning.maxConcurrency}`,
  });
  const result = await classifyChatGptSourcePressure(
    deps,
    probeIds,
    CHATGPT_PREFLIGHT_PROBE_COUNT,
    requestedTuning.maxConcurrency
  );
  if (result.classification === "pressured") {
    deps.emit({
      type: "PROGRESS",
      stream: "messages",
      message: `ChatGPT cold-state preflight: source is pressured (rate_limited=${result.rateLimited}/${result.attempted}); holding detail lane at serial concurrency=1 for this run`,
    });
    return CHATGPT_SERIAL_TUNING;
  }
  deps.emit({
    type: "PROGRESS",
    stream: "messages",
    message: `ChatGPT cold-state preflight: source is cold (${result.attempted}/${result.attempted} ok); allowing requested detail concurrency=${requestedTuning.maxConcurrency}`,
  });
  return requestedTuning;
}

interface ConversationDetailPacingOptions {
  // Cumulative served-429 count at which the lane treats the account as hot and
  // waits out a bounded cool-down before resuming (deferring the tail as
  // upstream_pressure DETAIL_GAP records only on the bounded-wait fallback).
  // Defaults to resolveChatGptRateLimitDensityStop(); tests inject a small value
  // to exercise the trip without standing up real backoff.
  densityStopThreshold?: number;
  // Served 429s the run absorbed before this detail pass (list pagination + the
  // non-detail streams). Seeds the density tracker so pre-detail source pressure
  // carries forward. Defaults to the run-scoped accumulator on `deps`; tests
  // inject a fixed value to exercise the seed without a real list phase.
  preDetailRateLimited?: number;
  // Connector-agnostic provider budget controller. When present it owns
  // inter-request pacing for the detail lane, so the lane's ordinary launch
  // delay is neutralized to avoid stacking two pacing controllers.
  providerBudget?: ProviderBudgetController | null;
  random?: () => number;
  // Bounded-run budget for this detail pass. Tests inject a ChatGptRunBudget
  // (with a fake clock and/or a small request budget) to exercise the budget
  // deterministically without a real multi-hour run. Defaults to the run-scoped
  // budget on `deps`, and falls back to an env-resolved budget so production honors
  // PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN / PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS.
  runBudget?: ChatGptRunBudget;
  sleep?: (ms: number) => Promise<void> | void;
  // Max per-key DETAIL_GAP rows a run-cap tail materializes before folding the
  // older remainder into one backlog gap. Tests inject a small value to exercise
  // the bounded tail writer + backlog-cursor recovery without thousands of rows.
  // Defaults to resolveChatGptMaxTailDeferralGapsPerRun() (Infinity = unbounded
  // per-key behavior preserved). Only the run-cap deferral path honors it;
  // source-pressure deferrals stay per-key (their backlog IS the cooldown signal).
  tailGapBound?: number;
  tuning?: ChatGptDetailLaneTuning;
}

interface ConversationDetailCoverage {
  // When a cap-tail deferral folds the older tail into a backlog gap, this is
  // that backlog gap's synthetic record_key. The forward-pass coverage must list
  // it as a required key so the commit gate sees it backed by a durable gap; the
  // older tail conversations are intentionally NOT required keys this run (they
  // become required when a later run re-lists and materializes them). Absent
  // (undefined) when the run materialized every tail conversation per-key.
  backlogGapKey?: string;
  gapKeys: Array<string | number>;
  hydratedKeys: Array<string | number>;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldEmitConversationDetailLaneProgress(event: AdaptiveLaneEvent): boolean {
  if (event.type === "queued" || event.outcome === "ok") {
    return false;
  }
  if (event.type === "completed" && event.outcome === "terminal" && event.reason === "upstream_pressure_deferred") {
    return false;
  }
  return true;
}

function formatConversationDetailLaneProgress(event: AdaptiveLaneEvent): string {
  const parts = [
    `ChatGPT conversation-detail lane ${event.type}`,
    `active=${event.activeCount}`,
    `queued=${event.queueSize}`,
    `concurrency=${event.concurrency}/${event.maxConcurrency}`,
  ];
  if (event.attempt != null) {
    parts.push(`attempt=${event.attempt}`);
  }
  if (event.outcome != null) {
    parts.push(`outcome=${event.outcome}`);
  }
  if (event.delayMs != null) {
    parts.push(`delay_ms=${event.delayMs}`);
  }
  if (event.retryAfterMs != null) {
    parts.push(`retry_after_ms=${event.retryAfterMs}`);
  }
  if (event.errorName != null) {
    parts.push(`error=${event.errorName}`);
  }
  return parts.join(" ");
}

function safeConversationListItemHint(c: ConversationListItem): Record<string, string | number | boolean | null> {
  return {
    id: c.id,
    title: typeof c.title === "string" ? c.title : null,
    create_time: typeof c.create_time === "string" || typeof c.create_time === "number" ? c.create_time : null,
    update_time: typeof c.update_time === "string" || typeof c.update_time === "number" ? c.update_time : null,
    current_node: typeof c.current_node === "string" ? c.current_node : null,
    gizmo_id: typeof c.gizmo_id === "string" ? c.gizmo_id : null,
    is_archived: typeof c.is_archived === "boolean" ? c.is_archived : null,
    is_starred: typeof c.is_starred === "boolean" ? c.is_starred : null,
    workspace_id: typeof c.workspace_id === "string" ? c.workspace_id : null,
  };
}

function conversationListItemFromGap(gap: CollectContext["detailGaps"][number]): ConversationListItem | null {
  const locator = gap.detail_locator;
  if (!locator || locator.kind !== "chatgpt.conversation") {
    return null;
  }
  const hint = locator.list_item;
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
    return null;
  }
  const id = typeof locator.conversation_id === "string" ? locator.conversation_id : null;
  if (!id) {
    return null;
  }
  return { ...(hint as Record<string, unknown>), id } as ConversationListItem;
}

function makeConversationDetailGap(
  c: ConversationListItem,
  error: ChatGptRecoverableRetryExhaustedError
): DetailGapMessage {
  const networkPressure = omitAttemptBudget(error.networkPressure);
  return buildDetailGap({
    stream: "messages",
    recordKey: c.id,
    reason: error.class,
    locator: {
      kind: "chatgpt.conversation",
      conversation_id: c.id,
      list_item: safeConversationListItemHint(c),
    },
    error: {
      class: error.class,
      ...(error.httpStatus == null ? {} : { httpStatus: error.httpStatus }),
      ...(networkPressure == null ? {} : { networkPressure }),
    },
  });
}

function omitAttemptBudget(
  diagnostic: ChatGptNetworkPressureDiagnostic | undefined
): ChatGptNetworkPressureDiagnostic | undefined {
  if (!diagnostic) {
    return;
  }
  const { attempt: _attempt, max_attempts: _maxAttempts, ...safeDiagnostic } = diagnostic;
  return safeDiagnostic;
}

function makeDeferredConversationDetailGap(
  c: ConversationListItem,
  observedPressure: ChatGptRecoverableRetryExhaustedError
): DetailGapMessage {
  const networkPressure = omitAttemptBudget(observedPressure.networkPressure);
  return buildDetailGap({
    stream: "messages",
    recordKey: c.id,
    reason: "upstream_pressure",
    locator: {
      kind: "chatgpt.conversation",
      conversation_id: c.id,
      list_item: safeConversationListItemHint(c),
    },
    error: {
      class: "upstream_pressure_deferred",
      ...(observedPressure.httpStatus == null ? {} : { httpStatus: observedPressure.httpStatus }),
      ...(networkPressure == null ? {} : { networkPressure }),
    },
  });
}

/**
 * Synthesize the same recoverable-pressure error the per-conversation
 * exhaustion path throws, so the cumulative-429-density BOUNDED-WAIT FALLBACK
 * (a persistently-hot account that stayed hot across every cool-down wait) opens
 * the EXISTING upstream-pressure defer circuit and emits identical DETAIL_GAP
 * shapes rather than introducing a parallel deferral mechanism. NOT the primary
 * density response — that is wait-out-and-resume; this fires only once the
 * bounded wait budget is spent. No HTTP status: the trip is a run-level density
 * signal, not a single bad response.
 */
function makeRateLimitDensityPressureError(observedRateLimited: number): ChatGptRecoverableRetryExhaustedError {
  return new ChatGptRecoverableRetryExhaustedError(
    `ChatGPT conversation-detail lane stayed hot across the bounded cool-down waits after ${observedRateLimited} served 429s; deferring the remaining details as resumable gaps`,
    {
      class: "upstream_pressure",
      networkPressure: {
        endpoint_route: "/conversation/{id}",
        error_class: "rate_limit_density",
        method: "GET",
      },
    }
  );
}

/**
 * Build a resumable DETAIL_GAP for a conversation deferred because this run hit
 * its bounded-run cap (size or time), NOT because the source pressured us. The
 * wire `reason` is `retry_exhausted` — resumable and retryable next run, but it
 * does NOT arm the cross-run source-pressure cooldown governor the way
 * `upstream_pressure` / `rate_limited` would. A distinct `run_cap_deferred`
 * error class keeps the cap visibly separate from a source-pressure defer so
 * the console never reads a self-imposed bound as "the service is busy". No HTTP
 * status: nothing failed — the run simply stopped at its budget.
 */
function chatGptRunCapReasonFromProviderGate(gate: ProviderBudgetGate & { ok: false }): ChatGptRunCapReason {
  if (gate.reason === "max_wall_clock") {
    return "max_wall_clock";
  }
  if (gate.reason === "retry_budget") {
    return "provider_retry_budget";
  }
  if (gate.reason === "circuit_open") {
    return "circuit_open";
  }
  return "max_detail_fetches";
}

function makeRunCapDeferredConversationDetailGap(
  c: ConversationListItem,
  capReason: ChatGptRunCapReason
): DetailGapMessage {
  return buildDetailGap({
    stream: "messages",
    recordKey: c.id,
    reason: "retry_exhausted",
    locator: {
      kind: "chatgpt.conversation",
      conversation_id: c.id,
      list_item: safeConversationListItemHint(c),
    },
    error: {
      class: "run_cap_deferred",
      networkPressure: {
        endpoint_route: "/conversation/{id}",
        error_class: capReason,
        method: "GET",
      },
    },
  });
}

// Synthetic, stable record_key for the single backlog DETAIL_GAP a capped run
// folds its un-materialized older tail into. Stable so a rewrite (an older
// watermark) targets the same coverage slot; the durable row itself is replaced
// run-over-run (old resolved, fresh emitted) because the gap-store natural key
// includes detail_locator_json, which carries the watermark.
const CHATGPT_CONVERSATION_BACKLOG_RECORD_KEY = "__chatgpt_conversation_backlog__";
const CHATGPT_CONVERSATION_BACKLOG_LOCATOR_KIND = "chatgpt.conversation_backlog";

/**
 * Build the ONE durable backlog `DETAIL_GAP` that represents a capped run's
 * un-materialized older conversation tail. It carries a content-derived
 * `before_update_time` watermark (ISO) the next run re-lists from — NEVER an
 * offset — plus the count of conversations still owed. Same resumable
 * `retry_exhausted` / `run_cap_deferred` contract as the per-key cap gaps, so it
 * never arms the source-pressure cooldown. The `list_cursor` mirror is set for
 * protocol honesty even though recovery reads the watermark from the locator
 * (the recovery start-entry round-trips `detail_locator`, not `list_cursor`).
 */
function makeRunCapBacklogConversationDetailGap(
  beforeUpdateTimeIso: string,
  remaining: number,
  capReason: ChatGptRunCapReason
): DetailGapMessage {
  return buildDetailGap({
    stream: "messages",
    recordKey: CHATGPT_CONVERSATION_BACKLOG_RECORD_KEY,
    reason: "retry_exhausted",
    listCursor: { before_update_time: beforeUpdateTimeIso },
    locator: {
      kind: CHATGPT_CONVERSATION_BACKLOG_LOCATOR_KIND,
      before_update_time: beforeUpdateTimeIso,
      remaining,
    },
    error: {
      class: "run_cap_deferred",
      networkPressure: {
        endpoint_route: "/conversations",
        error_class: capReason,
        method: "GET",
      },
    },
  });
}

/** The inclusive watermark a backlog-gap recovery re-lists from, or null if absent/invalid. */
function backlogGapBeforeUpdateTime(gap: CollectContext["detailGaps"][number]): string | null {
  const locator = gap.detail_locator;
  if (!locator || locator.kind !== CHATGPT_CONVERSATION_BACKLOG_LOCATOR_KIND) {
    return null;
  }
  const before = (locator as { before_update_time?: unknown }).before_update_time;
  return typeof before === "string" && before !== "" ? before : null;
}

function makeConversationDetailCoverage(
  requiredKeys: Array<string | number>,
  coverage: ConversationDetailCoverage
): DetailCoverageMessage {
  return buildDetailCoverageMessage({
    stream: "messages",
    stateStream: "conversations",
    requiredKeys,
    hydratedKeys: coverage.hydratedKeys,
    gapKeys: coverage.gapKeys,
    considered: requiredKeys.length,
    covered: coverage.hydratedKeys.length,
  });
}

function makeConversationListCoverage(considered: number, covered = considered): DetailCoverageMessage {
  return buildDetailCoverageMessage({
    stream: "conversations",
    stateStream: "conversations",
    requiredKeys: [],
    hydratedKeys: [],
    considered,
    covered,
  });
}

/**
 * Fetch details one-at-a-time. ChatGPT's private detail endpoint appears to
 * throttle per authenticated account/session, and parallel retry loops keep
 * pressure on the same hot bucket. Prefer predictable low pressure over a
 * faster first-run that fails near the end and cannot commit its cursor.
 */
export async function runMessagesAndConversationsWithDetail(
  deps: StreamDeps,
  convosToSync: ConversationListItem[],
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>,
  pacing: ConversationDetailPacingOptions = {}
): Promise<ConversationDetailCoverage> {
  const random = pacing.random ?? Math.random;
  const sleep = pacing.sleep ?? sleepMs;
  const providerBudget = pacing.providerBudget ?? deps.providerBudget ?? null;
  // Defaults are the frozen production values (1 / 1 / 1500ms / 3000ms). A
  // cold-state A/B probe may override them via PDPP_CHATGPT_DETAIL_*_PROBE env
  // vars; see resolveChatGptDetailLaneTuning. Tests may also inject `tuning`.
  const rawRequestedTuning = pacing.tuning ?? resolveChatGptDetailLaneTuning();
  // The adaptive lane is the SOLE send governor. Pacing (when present) rides as
  // a `launchDelayHint` — one pre-flight wait, no stacking. Calibrated
  // 2026-06-11 (run_1781139968889): 14,721 records committed, upstream-pressure
  // circuit opened and deferred cleanly, zero stacking.
  const requestedTuning = rawRequestedTuning;
  // Cold-state preflight: only when the owner has opted into the faster A/B
  // posture (maxConcurrency > 1). Production (maxConcurrency === 1) skips this
  // entirely — no extra requests, frozen serial behavior preserved byte-for-byte.
  // A pressured account forces the run back to serial so the faster posture is
  // never fired into a hot bucket.
  const tuning = await applyChatGptColdStatePreflight(deps, convosToSync, requestedTuning);
  const coverage: ConversationDetailCoverage = { gapKeys: [], hydratedKeys: [] };
  // Cumulative served-429 density signal. Each `rate_limited` cooldown the lane
  // surfaces (one per served 429, success-after-backoff included) bumps the
  // tracker; once it crosses threshold the lane WAITS OUT the account's cool-down
  // in-run and resumes (SLVP-ideal), discharging the tracker so it re-earns its
  // way to the next wait. It opens the same upstream-pressure defer circuit the
  // per-conversation exhaustion path uses only on the bounded-wait fallback (a
  // persistently-hot account). Strictly safer than grinding: it never adds
  // requests into a hot account.
  //
  // Seed the tracker with served 429s the run already absorbed BEFORE this
  // detail pass — list pagination and the non-detail streams fetch outside any
  // lane, so their 429s never reached the lane's cooldown counter. `pacing`
  // wins for tests; production reads the run-scoped accumulator on `deps`.
  const seededRateLimited = pacing.preDetailRateLimited ?? deps.preDetailPressure?.rateLimited ?? 0;
  const densityTracker = new ChatGptRateLimitDensityTracker(
    pacing.densityStopThreshold ?? resolveChatGptRateLimitDensityStop(),
    seededRateLimited
  );
  // Bounded-run budget. `pacing` wins for tests; production reads the run-scoped
  // budget on `deps` (shared across the recovery + forward passes); if neither
  // is supplied, fall back to an env-resolved budget so a single-pass call still
  // honors the connector defaults and env overrides. Non-positive env values are
  // explicit disable sentinels for owner-supervised probes.
  const runBudget =
    pacing.runBudget ??
    deps.runBudget ??
    new ChatGptRunBudget({
      maxFetches: resolveChatGptMaxDetailFetchesPerRun(),
      maxWallClockMs: resolveChatGptMaxRunWallClockMs(),
    });
  // Max per-key DETAIL_GAP rows a run-cap tail may materialize before folding
  // the older remainder into one backlog gap. `pacing` wins for tests; otherwise
  // env-resolved (Infinity = today's unbounded per-key behavior). This bounds the
  // FOREGROUND WRITE burn of a cap trip; it does not change fetching.
  const tailGapBound = pacing.tailGapBound ?? resolveChatGptMaxTailDeferralGapsPerRun();
  let emittedConversationDetailLaneStart = false;
  const lane = createAdaptiveLane<ChatGptFetchResult>({
    name: "chatgpt.conversationDetail",
    initialConcurrency: tuning.initialConcurrency,
    maxConcurrency: tuning.maxConcurrency,
    maxDelayMs: tuning.pauseMaxMs,
    maxQueueSize: Math.max(1, convosToSync.length),
    minConcurrency: 1,
    minDelayMs: tuning.pauseMinMs,
    // Fold GCRA pacing into the lane's single launch wait: exactly one pre-flight
    // gate. The controller computes the delay without sleeping (signal mode);
    // the lane takes max(launchDelay, cooldown, hint).
    ...(providerBudget ? { launchDelayHint: (): number => providerBudget.pacingDelayHint() } : {}),
    pressureMaxDelayMs: CHATGPT_RATE_LIMIT_MAX_DELAY_MS,
    pressureMinDelayMs: CHATGPT_RATE_LIMIT_BASE_DELAY_MS,
    classifyOutcome: ({ result }) => {
      if (!result) {
        return { kind: "retryable" };
      }
      if (result.deferredDueToPressure) {
        return { kind: "terminal", reason: "upstream_pressure_deferred" };
      }
      if (isChatGptRetryableStatus(result.status)) {
        return { kind: "rate_limited" };
      }
      return { kind: "ok" };
    },
    random,
    sleep,
    emitProgress: (event) => {
      // A `cooldown` event with a `rate_limited` outcome is the lane surfacing a
      // served 429 (reported by the per-request onRetry, whether or not the
      // request later succeeds). Count it for the cumulative density stop.
      if (event.type === "cooldown" && event.outcome === "rate_limited") {
        densityTracker.recordRateLimited();
      }
      if (event.type === "started") {
        if (emittedConversationDetailLaneStart) {
          return;
        }
        emittedConversationDetailLaneStart = true;
      }
      if (!shouldEmitConversationDetailLaneProgress(event)) {
        return;
      }
      return deps.emit({
        type: "PROGRESS",
        stream: "messages",
        message: formatConversationDetailLaneProgress(event),
      });
    },
  });
  let observedRecoverablePressure: ChatGptRecoverableRetryExhaustedError | null = null;
  let runCapDeferReason: ChatGptRunCapReason | null = null;
  // Last collection-rate interval surfaced to the run trace, so the controller's
  // state is emitted on speed-up/back-off TRANSITIONS, not once per request.
  let lastEmittedRateIntervalMs: number | null = null;
  const gapKeys = new Set<string>();
  const hydratedKeys = new Set<string>();
  const batchDetailCache = new Map<string, ChatGptFetchResult>();
  const batchDetailCacheHits = new Set<string>();
  // Once run-cap or source-pressure deferral trips, all later conversation
  // details are local bookkeeping: emit durable DETAIL_GAP rows for the tail,
  // then abort queued lane work. With the launch-jitter floor deleted (now an ε
  // band), draining the tail through the lane costs sub-ms per item, so this
  // abort is a micro-optimization (queued tasks reject immediately), no longer
  // the load-bearing mechanism that made tail iteration affordable.
  const tailStopController = new AbortController();

  async function recordConversationDetailProviderSuccess(): Promise<void> {
    providerBudget?.recordSuccess(deps.recoveryOnly === true ? { suppressAdditiveIncrease: true } : undefined);
    await emitChatGptProviderBudgetTransitions({ emit: deps.emit, providerBudget });
    lastEmittedRateIntervalMs = await emitChatGptCollectionRateOnChange(
      deps.emit,
      providerBudget,
      lastEmittedRateIntervalMs
    );
  }

  function conversationIdsWithinDetailBudget(): string[] {
    const remainingDetailBudget = Number.isFinite(runBudget.maxFetches)
      ? Math.max(0, runBudget.maxFetches - runBudget.count)
      : convosToSync.length;
    return convosToSync.slice(0, remainingDetailBudget).map((conversation) => conversation.id);
  }

  function cachedBatchDetailId(detail: ChatGptFetchResult, chunkIdSet: ReadonlySet<string>): string | null {
    if (detail.status !== 200 || !detail.json || Array.isArray(detail.json)) {
      return null;
    }
    const id = typeof detail.json.id === "string" ? detail.json.id : null;
    return id && chunkIdSet.has(id) ? id : null;
  }

  function cacheBatchConversationDetails(details: readonly ChatGptFetchResult[], chunkIds: readonly string[]): void {
    const chunkIdSet = new Set(chunkIds);
    for (const detail of details) {
      const id = cachedBatchDetailId(detail, chunkIdSet);
      if (id) {
        batchDetailCache.set(id, detail);
      }
    }
  }

  async function prefetchConversationDetailBatches(): Promise<void> {
    const fetchBatch = deps.api.fetchBatch;
    if (!fetchBatch || convosToSync.length === 0 || runBudget.shouldStop()) {
      return;
    }
    const prefetchIds = conversationIdsWithinDetailBudget();
    for (let start = 0; start < prefetchIds.length; start += CHATGPT_CONVERSATION_BATCH_MAX_IDS) {
      if (runBudget.shouldStop()) {
        return;
      }
      const chunkIds = prefetchIds.slice(start, start + CHATGPT_CONVERSATION_BATCH_MAX_IDS);
      let details: ChatGptFetchResult[];
      try {
        details = await fetchBatch(chunkIds);
      } catch {
        // Batch is an optimization. If the endpoint is unavailable, stop trying
        // it for this pass and let the existing per-id lane preserve correctness.
        return;
      }
      await recordConversationDetailProviderSuccess();
      cacheBatchConversationDetails(details, chunkIds);
    }
  }

  async function emitConversationDetailGapOnce(c: ConversationListItem, gap: DetailGapMessage): Promise<void> {
    if (gapKeys.has(c.id) || hydratedKeys.has(c.id)) {
      return;
    }
    gapKeys.add(c.id);
    await deps.emit(gap);
    coverage.gapKeys.push(c.id);
  }

  async function emitTailConversationDetailGaps(
    from: ConversationListItem,
    makeGap: (item: ConversationListItem, indexFromTailStart: number) => DetailGapMessage
  ): Promise<ChatGptFetchResult> {
    const start = Math.max(
      0,
      convosToSync.findIndex((item) => item.id === from.id)
    );
    const tail = convosToSync.slice(start);
    for (const [index, item] of tail.entries()) {
      await emitConversationDetailGapOnce(item, makeGap(item, index));
    }
    tailStopController.abort();
    return { deferredDueToPressure: true, status: 0, json: null };
  }

  // Bounded run-cap tail writer. A capped run stopped FETCHING at its budget;
  // this stops it from spending a long foreground stretch WRITING one durable
  // gap row per remaining conversation. It materializes at most `tailGapBound`
  // per-key `run_cap_deferred` gaps (newest of the tail — these recover first
  // next run via their `list_item` hint), then folds every OLDER conversation
  // into ONE durable backlog gap carrying a content-derived `before_update_time`
  // watermark (the newest un-materialized update_time). A later run's recovery
  // re-lists at-or-older than that inclusive watermark and drains the next bounded chunk, so a
  // huge history converges oldest-ward over several bounded runs while each run
  // writes ≤ bound + 1 durable rows. NOT source pressure — same resumable
  // `retry_exhausted` / `run_cap_deferred` contract, no cooldown armed.
  //
  // `tailGapBound === Infinity` (no cap configured, or only this path's default)
  // collapses to the per-key behavior: the backlog branch is never taken and the
  // output is byte-for-byte identical to the unbounded writer above.
  async function emitRunCapTailConversationDetailGaps(
    from: ConversationListItem,
    capReason: ChatGptRunCapReason
  ): Promise<ChatGptFetchResult> {
    const start = Math.max(
      0,
      convosToSync.findIndex((item) => item.id === from.id)
    );
    const tail = convosToSync.slice(start);
    const perKey = Number.isFinite(tailGapBound) ? tail.slice(0, tailGapBound) : tail;
    const backlog = Number.isFinite(tailGapBound) ? tail.slice(tailGapBound) : [];
    for (const item of perKey) {
      await emitConversationDetailGapOnce(item, makeRunCapDeferredConversationDetailGap(item, capReason));
    }
    if (backlog.length) {
      // Watermark: the NEWEST update_time in the un-materialized backlog. Recovery
      // re-lists conversations `update_time <= watermark` — an INCLUSIVE upper
      // bound. Using the backlog's own newest boundary (rather than the accounted
      // set's oldest) is stranding-proof at a tie: if a boundary update_time is
      // shared between an accounted item and a backlog item, the inclusive filter
      // re-lists the tied accounted item and the bounded writer simply re-defers
      // it — wasteful by at most a tie group, never lost. Convergence holds: the
      // next watermark is the next backlog's newest, strictly older than the
      // current chunk's oldest accounted item.
      const watermark = maxUpdateTimeIso(backlog) ?? minUpdateTimeIso(backlog);
      if (watermark) {
        coverage.backlogGapKey = CHATGPT_CONVERSATION_BACKLOG_RECORD_KEY;
        await deps.emit(makeRunCapBacklogConversationDetailGap(watermark, backlog.length, capReason));
      } else {
        // Pathological: no usable timestamp anywhere in the backlog. Rather than
        // silently drop the older tail (non-convergent), fall back to per-key gaps.
        for (const item of backlog) {
          await emitConversationDetailGapOnce(item, makeRunCapDeferredConversationDetailGap(item, capReason));
        }
      }
    }
    tailStopController.abort();
    return { deferredDueToPressure: true, status: 0, json: null };
  }

  // Cumulative-429 density: the slow-bleed pressure SIGNAL (the account served
  // enough 429s that it is now hot). SLVP-ideal control-system verdict
  // (docs/research/slvp-ideal-control-system-verdict-2026-06-11.md): the correct
  // RESPONSE to source heat is to WAIT OUT the account's minutes-long cool-down
  // IN-RUN and CONTINUE — not to terminate the run and defer the whole tail.
  // ChatGPT throttle is per-account and recovers in minutes while still serving;
  // stopping is "unnecessary lag." So when density trips we sleep one bounded
  // cool-down, RESET the density accumulator (the wait discharged the hot
  // bucket), and return null so the SAME conversation is fetched and the lane
  // keeps draining. Lose-nothing is preserved exactly as before: nothing is
  // gapped here — any conversation still unfetched when the run GENUINELY ends
  // (work-drained or a real run-budget/abort) is durably gapped by the existing
  // run-cap / forward-walk tail paths.
  //
  // Bounds (mirror the circuit wait-out so a genuinely-hostile account cannot
  // loop forever): each density wait is bounded by the remaining run budget, and
  // the give-up is PROGRESS-BASED — a density wait only counts toward the cap
  // when there is no successful fetch between it and the previous wait. A healthy
  // account that succeeds between density trips keeps draining; each success resets
  // the shared progress counter. Past the cap, OR with no run budget left, we fall
  // back to the durable defer (the old behavior) so the run converges bounded.
  // `densityWaitCycles` is a per-density-path display counter only (for the
  // progress message); it does NOT govern give-up and is never reset on success.
  let densityWaitCycles = 0;
  // Progress-based give-up counter: increments on each wait-out across ALL three
  // wait-out regimes (density, retry-exhausted, circuit-open); resets to 0 on
  // each successful conversation-detail fetch. Give-up fires when this reaches
  // CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES consecutive wait-outs with no success
  // in between — meaning a genuinely-dead account, not a healthy throttled drain.
  // A run that alternates throttle→success→throttle→success never gives up here
  // because each success resets the counter, regardless of how many retries
  // happened inside retryHttp (those are per-request backoff, not account-death
  // evidence). This is the fix for run_1781302239264: 65 successes should drain
  // to zero, not quit after ~21 give-up tokens were spent by per-request retries.
  // Safe for density: density trips only on 429s (recordRateLimited), not on
  // successes; after resetAfterWaitOut() the tracker must re-accumulate real 429s
  // to trip again, so a success-reset cannot cause an infinite loop.
  let consecutiveWaitOutsWithoutSuccess = 0;
  async function maybeWaitOutRateLimitDensity(from: ConversationListItem): Promise<ChatGptFetchResult | null> {
    if (!densityTracker.shouldStop()) {
      return null;
    }
    const remainingRunBudgetMs = runBudget.remainingWallClockMs();
    // Density give-up uses the SAME progress-based bound as Gates B and C: N
    // consecutive wait-outs with no successful fetch in between → dead account.
    // A healthy account that earns a success between density trips resets the
    // counter and keeps draining — density can only re-trip via new 429s, not
    // through successes, so progress-reset is safe and never causes an infinite
    // loop (verified: shouldStop() is driven solely by recordRateLimited() calls).
    const exhaustedWaitBudget =
      runBudget.shouldStop() ||
      remainingRunBudgetMs <= 0 ||
      consecutiveWaitOutsWithoutSuccess >= CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES;
    if (exhaustedWaitBudget) {
      // Hostile/persistent density pressure or run budget gone: fall back to the
      // durable defer so the run stops bounded and lossless (the prior behavior).
      observedRecoverablePressure = makeRateLimitDensityPressureError(densityTracker.count);
      await deps.emit({
        type: "PROGRESS",
        stream: "messages",
        message: `ChatGPT conversation-detail lane: source still hot after ${densityWaitCycles} cool-down wait(s); deferring remaining conversation details as resumable DETAIL_GAP records (${formatWaitBound(consecutiveWaitOutsWithoutSuccess)})`,
      });
      return emitTailConversationDetailGaps(from, (item) =>
        makeDeferredConversationDetailGap(item, observedRecoverablePressure as ChatGptRecoverableRetryExhaustedError)
      );
    }
    densityWaitCycles += 1;
    consecutiveWaitOutsWithoutSuccess += 1;
    const servedCount = densityTracker.count;
    // The cool-down: prefer the provider-budget circuit's measured cool-down when
    // one is reported; otherwise the default reset timeout. The remaining run
    // budget is a HARD ceiling — apply it LAST so a tiny positive budget caps the
    // wait even below the floor tick (the floor only raises a sub-tick desired
    // wait; it never overrides the budget). `remainingRunBudgetMs > 0` is
    // guaranteed by the exhaustedWaitBudget check above.
    const cooldownMs = providerBudget?.circuitCooldownMs() ?? 0;
    const desiredWaitMs = Math.max(
      CHATGPT_CIRCUIT_WAIT_OUT_MIN_TICK_MS,
      cooldownMs > 0 ? cooldownMs : CHATGPT_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS
    );
    const waitMs = Math.min(desiredWaitMs, remainingRunBudgetMs);
    await deps.emit({
      type: "PROGRESS",
      stream: "messages",
      message: `ChatGPT conversation-detail lane hot after ${servedCount} served 429s; waiting ${formatSleepDuration(waitMs)} for the account to cool down, then resuming detail collection (${formatWaitBound(consecutiveWaitOutsWithoutSuccess)})`,
    });
    await sleep(waitMs);
    // The wait discharged the hot bucket — reset the accumulator so the lane
    // re-earns its way to the next stop, exactly as a fresh run would.
    densityTracker.resetAfterWaitOut();
    return null;
  }

  async function maybeDeferForRunBudget(from: ConversationListItem): Promise<ChatGptFetchResult | null> {
    const capReason = runBudget.reason();
    if (!capReason) {
      return null;
    }
    runCapDeferReason = capReason;
    const budgetDescription =
      capReason === "max_wall_clock"
        ? `wall-clock budget after ${runBudget.elapsedMs()}ms elapsed`
        : `provider-request budget after ${runBudget.count} conversation-detail request(s)`;
    await deps.emit({
      type: "PROGRESS",
      stream: "messages",
      message: `ChatGPT conversation-detail lane reached its per-run ${budgetDescription}; deferring the remaining conversation details as resumable DETAIL_GAP records for the next run`,
    });
    return emitRunCapTailConversationDetailGaps(from, capReason);
  }

  function formatWaitBound(noProgressCount: number): string {
    return `no-progress waits: ${noProgressCount}/${CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES} (resets on the next successful fetch)`;
  }

  async function maybeDeferForFetchError(from: ConversationListItem, err: unknown): Promise<ChatGptFetchResult | null> {
    if (err instanceof ChatGptPlannedProviderBudgetDeferredError) {
      runCapDeferReason = err.reason;
      const providerBudgetReason = err.gate?.reason ?? err.reason;
      await deps.emit({
        type: "PROGRESS",
        stream: "messages",
        message: `ChatGPT conversation-detail lane reached its per-run provider budget (${providerBudgetReason}); deferring remaining conversation details as resumable DETAIL_GAP records`,
      });
      return emitRunCapTailConversationDetailGaps(from, err.reason);
    }
    if (err instanceof ChatGptRecoverableRetryExhaustedError) {
      providerBudget?.recordThrottle({ retryAfterAlreadySlept: true });
      await emitChatGptProviderBudgetTransitions({ emit: deps.emit, providerBudget });
      lastEmittedRateIntervalMs = await emitChatGptCollectionRateOnChange(
        deps.emit,
        providerBudget,
        lastEmittedRateIntervalMs
      );

      // SLVP-ideal: wait out the cooldown in-run and re-fetch the SAME
      // conversation, exactly like the circuit-open and density regimes —
      // instead of immediately latching and dumping the tranche.
      // Progress-based give-up: N consecutive wait-outs with no successful
      // fetch in between → account is genuinely dead → durable defer.
      const remainingRunBudgetMs = runBudget.remainingWallClockMs();
      const waitBudgetExhausted =
        runBudget.shouldStop() ||
        remainingRunBudgetMs <= 0 ||
        consecutiveWaitOutsWithoutSuccess >= CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES;
      if (!waitBudgetExhausted) {
        consecutiveWaitOutsWithoutSuccess += 1;
        const cooldownMs = providerBudget?.circuitCooldownMs() ?? 0;
        const desiredWaitMs = Math.max(
          CHATGPT_CIRCUIT_WAIT_OUT_MIN_TICK_MS,
          cooldownMs > 0 ? cooldownMs : CHATGPT_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS
        );
        const waitMs = Math.min(desiredWaitMs, remainingRunBudgetMs);
        await deps.emit({
          type: "PROGRESS",
          stream: "messages",
          message: `ChatGPT conversation-detail lane hit a recoverable rate limit on this conversation; waiting ${formatSleepDuration(waitMs)} for the account to cool down, then resuming the SAME conversation (${formatWaitBound(consecutiveWaitOutsWithoutSuccess)})`,
        });
        await sleep(waitMs);
        densityTracker.resetAfterWaitOut();
        // Return null: caller retries fetchConversationDetailWaitingOutCircuit
        // on the SAME conversation. Do NOT latch; do NOT dump the tranche.
        return null;
      }

      // Bounded envelope spent → existing latch + lose-nothing tail defer:
      observedRecoverablePressure = err;
      await deps.emit({
        type: "PROGRESS",
        stream: "messages",
        message:
          "ChatGPT conversation-detail lane opened upstream-pressure circuit; deferring remaining conversation details as DETAIL_GAP records",
      });
      return emitTailConversationDetailGaps(from, (item, index) =>
        index === 0 ? makeConversationDetailGap(item, err) : makeDeferredConversationDetailGap(item, err)
      );
    }
    return null;
  }

  // Fetch one conversation detail with wait-out-and-resume for recoverable rate
  // limits (ChatGptRecoverableRetryExhaustedError). Uses the shared
  // consecutiveWaitOutsWithoutSuccess counter via maybeDeferForFetchError: if the
  // error handler waited and returned null, retry the same conversation; if it
  // returned a durable-defer result, propagate it. Non-recoverable errors re-throw.
  async function fetchConversationDetailWithRecoverableRetry(c: ConversationListItem): Promise<ChatGptFetchResult> {
    for (;;) {
      try {
        return await fetchConversationDetailWaitingOutCircuit(c);
      } catch (err) {
        const fetchErrorDefer = await maybeDeferForFetchError(c, err);
        if (fetchErrorDefer) {
          return fetchErrorDefer;
        }
        if (!(err instanceof ChatGptRecoverableRetryExhaustedError)) {
          throw err;
        }
        // null return + ChatGptRecoverableRetryExhaustedError: waited out,
        // re-fetch the SAME conversation on the next loop iteration.
      }
    }
  }

  // Fetch one conversation detail, treating a `circuit_open` provider-budget
  // defer as a TRANSIENT back-off rather than budget exhaustion. The upstream-
  // pressure circuit auto-transitions open→half_open after its reset timeout, so
  // instead of deferring the whole tail and quitting (the live
  // `run_1781150455121` defect: 136s exit, ~13 min budget unused), wait out the
  // circuit's exact cool-down — bounded by the remaining run budget — then retry
  // the SAME conversation. Forward progress is guaranteed: each wait advances
  // real wall-clock toward the cap AND decrements a bounded cycle guard, so a
  // circuit that keeps re-opening (a genuinely hostile provider, not a transient
  // burst) converges to a durable defer instead of looping. Genuine budget
  // exhaustion (`max_wall_clock` / `max_detail_fetches`) is never waited out:
  // that planned defer propagates immediately to the run-cap tail path. This is
  // "adapt down fast, up slow, inside a fixed envelope you never probe" — the
  // circuit already dropped the rate; one half-open success resumes it.
  // Handle a single transient circuit-open error inside the wait-out loop.
  // Returns the computed `remainingRunBudgetMs` when the wait was performed
  // (caller should continue the loop), or re-throws `err` when the wait is not
  // allowed (budget depleted / run budget exhausted / non-transient error).
  async function handleCircuitOpenForWaitOut(err: unknown): Promise<{ remainingRunBudgetMs: number }> {
    if (!isChatGptTransientCircuitDefer(err)) {
      throw err;
    }
    // Genuine budget exhaustion takes precedence over a transient circuit:
    // if the run is genuinely out of wall-clock/detail budget, stop waiting
    // and let the run-cap tail path defer the remainder durably.
    if (runBudget.shouldStop()) {
      throw err;
    }
    const remainingRunBudgetMs = runBudget.remainingWallClockMs();
    if (remainingRunBudgetMs <= 0) {
      throw err;
    }
    // Progress-based give-up: N consecutive wait-outs with no successful fetch
    // in between → genuinely dead account → re-throw so the outer caller
    // (maybeDeferForFetchError) produces the durable lose-nothing defer.
    const waitAllowed = consecutiveWaitOutsWithoutSuccess < CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES;
    if (!waitAllowed) {
      throw err;
    }
    consecutiveWaitOutsWithoutSuccess += 1;
    const cooldownMs = providerBudget?.circuitCooldownMs() ?? 0;
    // Sleep the circuit's exact cool-down, never past the remaining run
    // budget, and at least one floor tick so a cool-down already near zero
    // still yields and re-probes (half-opening the circuit on the next try).
    const waitMs = Math.max(CHATGPT_CIRCUIT_WAIT_OUT_MIN_TICK_MS, Math.min(cooldownMs, remainingRunBudgetMs));
    await deps.emit({
      type: "PROGRESS",
      stream: "messages",
      message: `ChatGPT upstream-pressure circuit open; waiting ${formatSleepDuration(waitMs)} for the provider to cool down, then resuming conversation-detail collection within the remaining run budget (${formatWaitBound(consecutiveWaitOutsWithoutSuccess)})`,
    });
    await sleep(waitMs);
    return { remainingRunBudgetMs };
  }

  async function fetchConversationDetailWaitingOutCircuit(c: ConversationListItem): Promise<ChatGptFetchResult> {
    const batchDetail = batchDetailCache.get(c.id);
    if (batchDetail) {
      batchDetailCache.delete(c.id);
      batchDetailCacheHits.add(c.id);
      return batchDetail;
    }
    // Progress-based give-up: the shared consecutiveWaitOutsWithoutSuccess
    // counter (incremented in handleCircuitOpenForWaitOut, reset on each
    // successful fetch) bounds this loop. A dead account gives up after
    // CHATGPT_CIRCUIT_WAIT_OUT_MAX_CYCLES consecutive waits with no success.
    for (;;) {
      try {
        return await deps.api.fetch(`/conversation/${encodeURIComponent(c.id)}`);
      } catch (err) {
        await handleCircuitOpenForWaitOut(err);
      }
    }
  }

  await prefetchConversationDetailBatches();

  await runLaneUntilTailStopped(lane, convosToSync, tailStopController.signal, async (c) => {
    if (!c) {
      return { status: 404, json: null };
    }
    if (observedRecoverablePressure) {
      return emitTailConversationDetailGaps(c, (item) =>
        makeDeferredConversationDetailGap(item, observedRecoverablePressure as ChatGptRecoverableRetryExhaustedError)
      );
    }
    // Bounded-run budget already tripped earlier in this pass. Any later task that
    // managed to start before the abort is local-only: materialize its tail as
    // resumable run-cap gaps and stop queued lane work.
    if (runCapDeferReason) {
      return emitRunCapTailConversationDetailGaps(c, runCapDeferReason as ChatGptRunCapReason);
    }
    // Cumulative 429-density trip (the slow-bleed "succeeds after backoff, over
    // and over, for hours" regime the exhaustion-only circuit never trips on).
    // Source-heat is a SIGNAL, not a terminator: wait out the account's cool-down
    // IN-RUN and continue draining (SLVP-ideal). Only falls back to a durable
    // defer when the bounded wait budget is exhausted (hostile/persistent
    // pressure) — see maybeWaitOutRateLimitDensity. A non-null result means we
    // genuinely deferred the tail; null means we waited and the lane continues.
    const densityResult = await maybeWaitOutRateLimitDensity(c);
    if (densityResult) {
      return densityResult;
    }
    // Bounded-run budget trip. Independent of source pressure: when the run has
    // spent its provider-request budget, or spent its wall-clock budget, stop
    // launching new fetches and defer this + every later conversation as a
    // resumable run-cap DETAIL_GAP. NOT a source failure — `reason` stays
    // `retry_exhausted` so no source-pressure cooldown is armed. The ChatGPT
    // default has no fixed size/time cap; this branch is for explicit envelopes.
    const runBudgetDefer = await maybeDeferForRunBudget(c);
    if (runBudgetDefer) {
      return runBudgetDefer;
    }
    const detail = await fetchConversationDetailWithRecoverableRetry(c);
    if (detail.deferredDueToPressure) {
      // fetchConversationDetailWithRecoverableRetry surfaced a durable-defer
      // result from maybeDeferForFetchError — propagate it directly.
      return detail;
    }
    if (detail.status !== 200) {
      providerBudget?.recordFailure();
      await emitChatGptProviderBudgetTransitions({ emit: deps.emit, providerBudget });
      throw new Error(`required conversation detail ${c.id} failed with http ${detail.status}`);
    }
    await processConversationDetail(deps, c, detail, emitConversation);
    // §10-D: suppress additive-decrease during the cooldown-exempt recovery
    // lane so the shared pacer interval is not un-learned. Throttles still
    // fire (recovery may decelerate, never accelerate the pacer).
    const servedFromBatchCache = batchDetailCacheHits.delete(c.id);
    if (!servedFromBatchCache) {
      await recordConversationDetailProviderSuccess();
    }
    // Reset the progress-based give-up counter: any successful fetch proves the
    // account is alive, so N consecutive no-progress waits restarts from 0.
    consecutiveWaitOutsWithoutSuccess = 0;
    hydratedKeys.add(c.id);
    coverage.hydratedKeys.push(c.id);
    // Count this hydration against the bounded-run cap. Done after a successful
    // fetch so deferred/failed conversations never consume the size budget; the
    // next `reason()` check (this pass or the forward pass sharing the budget)
    // sees the updated count.
    runBudget.recordDetailFetch();
    const synced = convosToSync.indexOf(c) + 1;
    const progressMsg = {
      type: "PROGRESS",
      stream: "messages",
      message: `Synced ${synced} / ${convosToSync.length} conversations`,
      count: synced,
      total: convosToSync.length,
    } as const;
    deps.emit(progressMsg);
    return detail;
  });
  return coverage;
}

/**
 * Run `task` over every item via `lane.runAll`, but treat an abort on
 * `tailStopSignal` as a CLEAN early stop rather than a failure.
 *
 * The bounded-run and upstream-pressure paths abort this signal after they have
 * materialized durable local DETAIL_GAP rows for the remaining listed tail.
 * Draining those no-op tail items through the serial lane would pay a 1.5-3s
 * launch delay per item (the idle-active hang seen live in run_1780693320152).
 * Aborting rejects queued-but-not-started tasks immediately, before their launch
 * delay, so `runAll` settles right after the local tail is represented.
 *
 * Only the abort WE triggered is swallowed. Any other AdaptiveLaneCancelledError
 * (e.g. an external cancel) or unrelated failure still propagates.
 */
async function runLaneUntilTailStopped(
  lane: AdaptiveLane<ChatGptFetchResult>,
  items: ConversationListItem[],
  tailStopSignal: AbortSignal,
  task: (c: ConversationListItem) => Promise<ChatGptFetchResult>
): Promise<void> {
  try {
    await lane.runAll(items, task, { signal: tailStopSignal });
  } catch (err) {
    if (tailStopSignal.aborted && err instanceof AdaptiveLaneCancelledError) {
      return;
    }
    throw err;
  }
}

async function recoverPendingConversationDetailGaps(
  deps: StreamDeps,
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>,
  pacing: ConversationDetailPacingOptions = {}
): Promise<{ recovered: number; stoppedWithPending: boolean }> {
  // CONTINUOUS DRAIN (SLVP-ideal "run = worker session draining a durable
  // work-list, NOT a completeness boundary"): keep requesting fresh pending-gap
  // pages and recovering them IN THIS RUN until the work-list is genuinely empty
  // — re-attacking the still-pending tail across pages instead of ending the run
  // the first time a page only partially hydrates.
  //
  // A page's `stoppedWithPending` is the NORMAL mid-drain state (a wait/defer
  // happened: density waited out, or the circuit/bounded-wait fallback durably
  // re-deferred some items as fresh `pending` gaps). It is NOT a terminator on
  // its own. The runtime re-reads fresh `pending` rows on every
  // requestDetailGapPage call, and `recovered`/`terminal` statuses are sticky, so
  // each loop either RECOVERS gaps (monotonic progress toward empty) or durably
  // RE-DEFERS them — the work-list strictly shrinks or churns the same hostile
  // tail. We stop on a GENUINE bound only:
  //   1. work-list empty (page.length === 0) — the drain is complete;
  //   2. run budget exhausted (runBudget.shouldStop()) — leave the rest durable
  //      for the next run (an explicit owner-set envelope, off by default);
  //   3. single-pass mode (no requestDetailGapPage) — can't re-page;
  //   4. ZERO-PROGRESS round — a full page recovered nothing new, meaning every
  //      remaining item is durably deferred by the bounded-wait fallback (a
  //      persistently-hot account). Re-attacking would spin, so we stop and leave
  //      them as durable `pending` gaps. Lose-nothing holds: nothing recovered is
  //      ever lost (records persisted, gap marked recovered); nothing un-recovered
  //      is dropped (it stays a durable pending gap).
  let recovered = 0;
  let page = deps.detailGaps ?? [];
  let stoppedWithPending = false;

  while (page.length > 0) {
    const result = await recoverPendingConversationDetailGapPage(deps, page, emitConversation, pacing);
    recovered += result.recovered;
    stoppedWithPending = result.stoppedWithPending;

    // Bound 3: single-pass mode — honor the page's own stop signal verbatim.
    if (!deps.requestDetailGapPage) {
      return { recovered, stoppedWithPending };
    }
    // Bound 2: a genuine run-budget envelope tripped — stop and leave the rest
    // durable for the next run (the un-recovered tail is already pending gaps).
    if (deps.runBudget?.shouldStop()) {
      return { recovered, stoppedWithPending };
    }
    // Bound 4: a stopped page that recovered NOTHING means the remaining work is
    // all durably deferred (hostile account exhausted the bounded wait) — further
    // re-paging would spin on the same tail. Stop; the tail stays durable pending.
    if (result.stoppedWithPending && result.recovered === 0) {
      return { recovered, stoppedWithPending: true };
    }

    // Otherwise keep draining: re-read the fresh pending work-list. The page that
    // partially hydrated made progress, so its un-hydrated tail (now re-written as
    // `pending`) comes back here to be re-attacked in the SAME run.
    page = await deps.requestDetailGapPage({ streams: ["messages"] });
  }

  // Bound 1: the work-list drained to empty — the run recovered everything it
  // could reach. `stoppedWithPending` is false: nothing is owed.
  return { recovered, stoppedWithPending: false };
}

/**
 * Expand a single cap-tail backlog gap: re-list the parent conversation list and
 * materialize the next bounded chunk of conversations at-or-older than the
 * backlog's inclusive `before_update_time` watermark, then resolve the backlog
 * gap. The same bounded `runMessagesAndConversationsWithDetail` writer runs over
 * that window, so it hydrates what the shared run budget allows and folds ITS
 * remainder into a fresh backlog gap carrying a new content-derived watermark —
 * draining the history oldest-ward over runs, ≤ bound + 1 durable rows per run.
 * No offset arithmetic: the boundary is a content-derived `update_time`
 * watermark, re-listed each run.
 *
 * Returns `expanded: true` so the caller STOPS this run's recovery before any
 * forward walk — the freshly-rewritten backlog gap is attacked on the NEXT run,
 * never re-expanded inside the same run.
 */
async function expandBacklogConversationDetailGap(
  deps: StreamDeps,
  gap: CollectContext["detailGaps"][number],
  beforeUpdateTime: string,
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>,
  pacing: ConversationDetailPacingOptions = {}
): Promise<{ recovered: number; expanded: boolean }> {
  // `listConversationsSinceCursor` returns the parent list `order=updated`
  // descending (newest-first), preserving source order. Keep conversations at or
  // older than the backlog watermark (`<= watermark`, the backlog's own newest
  // boundary) — that is the un-materialized older window. The inclusive bound is
  // stranding-proof at a tie; an already-accounted tie is harmlessly re-deferred.
  // No re-sort: source order is already the descending order the bounded writer
  // expects (materialize the newest of the window per-key, fold the rest).
  const listed = await listConversationsSinceCursor(deps, null);
  const olderWindow = listed.filter((c) => {
    const iso = c.update_time ? tsToIso(c.update_time) : null;
    return iso != null && iso <= beforeUpdateTime;
  });
  if (!olderWindow.length) {
    // The backlog is fully drained: nothing older remains. Resolve the gap.
    await deps.emit({
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: gap.gap_id,
      stream: "messages",
      record_key: CHATGPT_CONVERSATION_BACKLOG_RECORD_KEY,
    });
    return { recovered: 1, expanded: false };
  }
  const coverage = await runMessagesAndConversationsWithDetail(deps, olderWindow, emitConversation, pacing);
  // The old backlog gap is now superseded: its window was re-listed and the run
  // either hydrated/per-key-gapped a bounded chunk and emitted a FRESH backlog
  // gap (older watermark) for the remainder, or accounted the whole window. Mark
  // it recovered so it is never re-served; the fresh backlog gap (if any) carries
  // the remainder forward.
  await deps.emit({
    type: "DETAIL_GAP_RECOVERED",
    reference_only: true,
    gap_id: gap.gap_id,
    stream: "messages",
    record_key: CHATGPT_CONVERSATION_BACKLOG_RECORD_KEY,
  });
  return { recovered: coverage.hydratedKeys.length, expanded: true };
}

async function recoverPendingConversationDetailGapPage(
  deps: StreamDeps,
  detailGaps: readonly CollectContext["detailGaps"][number][],
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>,
  pacing: ConversationDetailPacingOptions = {}
): Promise<{ recovered: number; stoppedWithPending: boolean }> {
  const messagesGaps = detailGaps.filter((gap) => gap.stream === "messages");
  // Per-key conversation gaps recover FIRST — they are the newest deferred slice
  // (the cap chunk and prior per-record exhaustions) and self-hydrate from their
  // stored `list_item` hint. A backlog gap is only expanded once every per-key
  // gap on this page is drained AND the shared run budget still allows fetching,
  // so the older window is never re-listed while newer per-key gaps remain owed
  // (which would strand the chunk).
  const recoveryItems = messagesGaps
    .map((gap) => ({ gap, conversation: conversationListItemFromGap(gap) }))
    .filter(
      (item): item is { gap: CollectContext["detailGaps"][number]; conversation: ConversationListItem } =>
        item.conversation !== null
    );

  let recovered = 0;
  let stoppedWithPending = false;
  if (recoveryItems.length) {
    const coverage = await runMessagesAndConversationsWithDetail(
      deps,
      recoveryItems.map((item) => item.conversation),
      emitConversation,
      pacing
    );
    const hydrated = new Set(coverage.hydratedKeys.map(String));
    for (const { gap, conversation } of recoveryItems) {
      if (!hydrated.has(conversation.id)) {
        continue;
      }
      await deps.emit({
        type: "DETAIL_GAP_RECOVERED",
        reference_only: true,
        gap_id: gap.gap_id,
        stream: "messages",
        record_key: conversation.id,
      });
    }
    recovered = hydrated.size;
    // A backlog gap may itself have been (re)written into this coverage's
    // accounted set when the recovery run capped; if so the older window is
    // already represented and re-expanding here would double-list. Stop when any
    // per-key gap remains owed OR the recovery run capped (signalled by a fresh
    // backlog key), so the rewritten backlog is attacked next run.
    stoppedWithPending = hydrated.size < recoveryItems.length || coverage.backlogGapKey != null;
    if (stoppedWithPending) {
      return { recovered, stoppedWithPending };
    }
  }

  // Every per-key gap on this page recovered and the run did not cap. If a backlog
  // gap is present, expand exactly one: re-list the older window and drain its
  // next bounded chunk, then stop the run so the rewritten backlog waits for the
  // next run rather than being re-expanded in place.
  const backlogGap = messagesGaps.find((gap) => backlogGapBeforeUpdateTime(gap) != null);
  if (backlogGap) {
    const beforeUpdateTime = backlogGapBeforeUpdateTime(backlogGap);
    if (beforeUpdateTime) {
      const result = await expandBacklogConversationDetailGap(
        deps,
        backlogGap,
        beforeUpdateTime,
        emitConversation,
        pacing
      );
      return { recovered: recovered + result.recovered, stoppedWithPending: result.expanded };
    }
  }

  return { recovered, stoppedWithPending };
}

/**
 * Run gap recovery before the forward walk. Returns void: recovery stopping with
 * pending items (a transient source-pressure circuit trip) is NOT a reason to
 * terminate the run — the un-hydrated recovery items are already durable
 * `DETAIL_GAP` records and will be re-attempted next run. The caller decides
 * whether to proceed to the forward walk based on the RUN BUDGET, not on
 * recovery's transient stop (drain-within-budget, recovery-early-exit-diagnosis
 * §5). The intra-recovery `stoppedWithPending` paging guard inside
 * `recoverPendingConversationDetailGapPage` is unchanged; only this inter-phase
 * decision changes.
 */
async function recoverPendingMessageDetailGapsBeforeForwardRun(
  deps: StreamDeps,
  wantsMessages: boolean,
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>,
  pacing: ConversationDetailPacingOptions = {}
): Promise<void> {
  if (!wantsMessages) {
    return;
  }
  const recovery = await recoverPendingConversationDetailGaps(deps, emitConversation, pacing);
  if (recovery.stoppedWithPending) {
    await deps.emit({
      type: "PROGRESS",
      stream: "messages",
      message:
        "Gap recovery stopped short with retryable gaps still pending; they remain durable DETAIL_GAP records and the run continues its forward walk while budget remains",
    });
  }
}

/**
 * Emit a messages STATE event that carries ONLY the controller's learned pacing
 * interval (cursor unchanged), so warm-start survives a run that defers before
 * the forward walk wrote its own messages STATE. No-op when there is no pacing
 * state to persist.
 */
function persistChatGptPacingStateOnly(deps: StreamDeps, priorMessagesCursor: string | null): void {
  const pacingFields = buildChatGptPacingStateFields(deps.providerBudget);
  if (Object.keys(pacingFields).length === 0) {
    return;
  }
  deps.emit({
    type: "STATE",
    stream: "messages",
    cursor: { last_update_time: priorMessagesCursor, ...pacingFields },
  });
}

/**
 * After the gap-recovery pass, decide whether to SKIP the forward walk. Two cases:
 *   1. §4.3/§4.4 recoveryOnly — the source-pressure cooldown is active, so the
 *      list phase MUST NOT fire (it would re-pressure the source the cooldown
 *      protects). Recovery fetches already rode the same pacer/circuit, so they
 *      backed off on 429s and re-deferred; nothing is lost.
 *   2. The RUN BUDGET is exhausted — defer the forward walk to the next run
 *      (drain-within-budget, recovery-early-exit-diagnosis §5).
 * Otherwise the forward walk proceeds: its list phase advances the cursor and
 * discovers new conversations even when the detail endpoint is under pressure.
 */
function shouldSuppressForwardWalkAfterRecovery(deps: StreamDeps): boolean {
  return deps.recoveryOnly === true || deps.runBudget?.shouldStop() === true;
}

export async function runConversationsAndMessagesStreams(
  deps: StreamDeps,
  state: CollectContext["state"],
  options: { detailPacing?: ConversationDetailPacingOptions } = {}
): Promise<void> {
  const conversationsCursor = state.conversations as { last_update_time?: string | null } | undefined;
  const messagesCursor = state.messages as { last_update_time?: string | null } | undefined;
  const priorConversationsCursor = conversationsCursor?.last_update_time || null;
  const priorMessagesCursor = messagesCursor?.last_update_time || null;
  const wantsConversations = deps.requested.has("conversations");
  const wantsMessages = deps.requested.has("messages");
  const listedByCursor = new Map<string, Promise<ConversationListItem[]>>();
  const listForCursor = (cursor: string | null): Promise<ConversationListItem[]> => {
    const key = cursor ?? "";
    const existing = listedByCursor.get(key);
    if (existing) {
      return existing;
    }
    const listed = listConversationsSinceCursor(deps, cursor);
    listedByCursor.set(key, listed);
    return listed;
  };
  const emitConversation = async (c: ConversationListItem, detail: ConversationDetail | null): Promise<void> => {
    if (!wantsConversations) {
      return;
    }
    await deps.emitRecord("conversations", buildConversationRecord(c, detail));
  };

  await recoverPendingMessageDetailGapsBeforeForwardRun(deps, wantsMessages, emitConversation, options.detailPacing);
  if (shouldSuppressForwardWalkAfterRecovery(deps)) {
    // Forward walk suppressed; persist the learned interval so warm-start
    // survives, then return — deferred work stays durable DETAIL_GAPs for the
    // next run. (See shouldSuppressForwardWalkAfterRecovery for the two cases.)
    persistChatGptPacingStateOnly(deps, priorMessagesCursor);
    return;
  }

  const { conversationsToSync, messageDetailConversations } = await selectConversationListsForRequestedStreams({
    wantsConversations,
    wantsMessages,
    priorConversationsCursor,
    priorMessagesCursor,
    listForCursor,
  });
  if (wantsConversations) {
    const foundProgressMsg = {
      type: "PROGRESS",
      stream: "conversations",
      message: `Found ${conversationsToSync.length} conversations to sync`,
      count: conversationsToSync.length,
      total: conversationsToSync.length,
    } as const;
    deps.emit(foundProgressMsg);
  }

  if (wantsMessages) {
    const foundMessageDetailProgressMsg = {
      type: "PROGRESS",
      stream: "messages",
      message: `Found ${messageDetailConversations.length} conversations requiring message detail`,
      count: messageDetailConversations.length,
      total: messageDetailConversations.length,
    } as const;
    deps.emit(foundMessageDetailProgressMsg);
    const coverage = await runMessagesAndConversationsWithDetail(
      deps,
      messageDetailConversations,
      emitConversation,
      options.detailPacing
    );
    // Required keys are the set the run ACCOUNTED FOR: every hydrated and
    // per-key-gapped conversation, plus — when a cap-tail deferral folded the
    // older tail into a backlog gap — that backlog gap's synthetic key (backed
    // by its durable row). Without a backlog gap this is exactly
    // `messageDetailConversations` (byte-identical to today). With one, the
    // older tail conversations are intentionally NOT required this run; the
    // backlog gap represents them and a later run re-lists + materializes them,
    // so the commit gate passes with a bounded row count instead of one
    // required key per conversation.
    const requiredKeys: Array<string | number> = coverage.backlogGapKey
      ? [...coverage.hydratedKeys, ...coverage.gapKeys, coverage.backlogGapKey]
      : messageDetailConversations.map((c) => c.id);
    await deps.emit(makeConversationDetailCoverage(requiredKeys, coverage));
    const maxMessagesUpdate = maxUpdateTimeIso(messageDetailConversations);
    deps.emit({
      type: "STATE",
      stream: "messages",
      // Persist the controller's learned interval alongside the cursor so the
      // next run warm-starts from it (warm-start, SLVP ideal §5.2).
      cursor: {
        last_update_time: maxMessagesUpdate || priorMessagesCursor || null,
        ...buildChatGptPacingStateFields(deps.providerBudget),
      },
    });
  }

  if (wantsConversations) {
    const detailedIds = new Set(messageDetailConversations.map((c) => c.id));
    // Emit list-only parents for conversation rows not already repaired by
    // message-detail fetches in this run.
    for (const c of conversationsToSync) {
      if (detailedIds.has(c.id)) {
        continue;
      }
      await emitConversation(c, null);
    }
    await deps.emit(makeConversationListCoverage(conversationsToSync.length));
  }

  if (wantsConversations && conversationsToSync.length) {
    const maxUpdate = maxUpdateTimeIso(conversationsToSync);
    deps.emit({
      type: "STATE",
      stream: "conversations",
      cursor: { last_update_time: maxUpdate || priorConversationsCursor || null },
    });
  } else if (wantsConversations) {
    deps.emit({
      type: "STATE",
      stream: "conversations",
      cursor: { last_update_time: priorConversationsCursor || null },
    });
  }
}

/**
 * ChatGPT-specific wrapper: unstringifiable values (bad Date, circular refs)
 * historically crashed the whole run when the runtime's shape-check tried to
 * serialize them into a SKIP_RESULT diagnostic. Guard here so
 * "Invalid time value" points at the offending row instead of killing the run.
 */
function makeEmitRecord(
  baseEmitRecord: CollectContext["emitRecord"]
): (stream: string, data: RecordData) => Promise<void> {
  return (stream: string, data: RecordData): Promise<void> => {
    if (data?.id != null) {
      try {
        JSON.stringify(data);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[chatgpt-debug] emit failed for ${stream} id=${String(data.id)}: ${m}\n`);
        return Promise.resolve();
      }
    }
    return baseEmitRecord(stream, data);
  };
}

// ─── Entry ─────────────────────────────────────────────────────────────

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/chatgpt/index.ts`).
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "chatgpt",
    validateRecord,
    normalizeTerminalError: normalizeChatGptTerminalError,
    browser: { preservePageOnSuccess: true, profileName: "chatgpt" },
    async ensureSession({ assist, capture, checkpoint, completeAssistance, context, page, progress, sendInteraction }) {
      await ensureChatGptSession({
        assist,
        capture,
        checkpoint,
        completeAssistance,
        context,
        page,
        progress,
        sendInteraction,
      });
    },
    async collect(ctx: CollectContext | BrowserCollectContext): Promise<void> {
      const { state, requested, emit, emitRecord: baseEmitRecord, progress, capture } = ctx;
      const { page } = ctx as BrowserCollectContext;

      // Run-scoped accumulator for served 429s seen outside the detail lane
      // (list pagination + the non-detail streams). createChatGptApi bumps it
      // via onUnlanedRateLimited; the detail phase reads it to seed its density
      // stop so pre-detail source pressure defers the tail earlier.
      const preDetailPressure: ChatGptPreDetailPressure = { rateLimited: 0 };

      // Run-scoped bounded-run envelope, created once so the gap-recovery pass
      // and the forward-walk pass share one budget. By default ChatGPT has no
      // fixed size/time cap; positive env values opt into explicit envelopes.
      const runBudget = new ChatGptRunBudget({
        maxFetches: resolveChatGptMaxDetailFetchesPerRun(),
        maxWallClockMs: resolveChatGptMaxRunWallClockMs(),
      });
      // Warm-start: pass the RAW persisted pacing (interval + when it was
      // learned) so ProviderPacing can apply the §10-E staleness guard itself —
      // a stale interval (idle > 6h) cold-starts instead of bursting into a
      // possibly-tightened quota. The descent compounds across fresh runs.
      const providerBudget = resolveChatGptProviderBudget(process.env, readChatGptPersistedPacing(state));

      // API client closes over page + capture — no module-level mutable state,
      // auth cached inside the closure for the run's lifetime.
      const api = createChatGptApi({
        page,
        capture,
        emit,
        onUnlanedRateLimited: () => {
          preDetailPressure.rateLimited += 1;
        },
        providerBudget,
      });
      const emitRecord = makeEmitRecord(baseEmitRecord);

      // Verify session (extract bearer token for /backend-api calls)
      const auth = await api.auth();
      progress(`Authenticated to ChatGPT (device_id=${auth.deviceId ? `${auth.deviceId.slice(0, 8)}…` : "unknown"})`);

      const deps: StreamDeps = {
        api,
        detailGaps: ctx.detailGaps,
        emit,
        emitRecord,
        preDetailPressure,
        progress,
        providerBudget,
        // §4.3: thread recoveryOnly from the CollectContext (sourced from the
        // START message's recovery_only field) into the dep bag so
        // runConversationsAndMessagesStreams can gate the forward walk. Normalize
        // to a concrete boolean (CollectContext.recoveryOnly is optional).
        recoveryOnly: ctx.recoveryOnly === true,
        requested,
        requestDetailGapPage: ctx.requestDetailGapPage,
        runBudget,
      };

      if (isChatGptSideEffectProbeEnabled()) {
        await runChatGptSideEffectProbe({ api, emit, page });
        return;
      }

      if (requested.has("memories")) {
        await runMemoriesStream(deps);
      }
      if (requested.has("custom_gpts")) {
        await runCustomGptsStream(deps);
      }
      if (requested.has("custom_instructions")) {
        await runCustomInstructionsStream(deps, state);
      }
      if (requested.has("shared_conversations")) {
        await runSharedConversationsStream(deps, state);
      }
      if (requested.has("conversations") || requested.has("messages")) {
        await runConversationsAndMessagesStreams(deps, state);
      }
    },
    retryablePattern: CHATGPT_RETRYABLE_ERROR_PATTERN,
  });
}
