// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CollectionRateProgress } from "./connector-runtime-protocol.js";
import {
  type HttpRetryBudget,
  type HttpRetryResponse,
  RetryExhaustedError,
  retryHttp,
  TerminalHttpStatusError,
} from "./http-retry.js";
import { type PacingSnapshot, ProviderPacing } from "./provider-pacing.js";
import type { ProviderPacingProfile } from "./provider-profile.js";
import type { SendGovernor } from "./send-governor.js";

/**
 * Shared HTTP request governor for API connectors.
 *
 * NEW-CONNECTOR ONE-LINER: to add an API connector with fastest-safe adaptive
 * collection, call `createConnectorHttpGovernor({ name, profile })` — discovery,
 * warm-start, back-off, and observability are automatic once the connector
 * declares its provider-specific rate ceiling.
 *
 * That minimal profiled call gives a connector author, by default and with zero
 * additional rate-governor code:
 *
 * - **Adaptive, fastest-safe collection** — a per-provider {@link ProviderPacing}
 *   GCRA bucket whose interval STARTS conservative (slow-start discovery seed)
 *   and accelerates under sustained success (AIMD additive increase), backing off
 *   multiplicatively the instant the provider throttles, never crossing the
 *   owner-authored rate ceiling. This is the SLVP-ideal "adapt rate down fast and
 *   up slow inside a fixed envelope you never probe", hoisted here as the DEFAULT
 *   so every governor-using connector inherits it (Phase A of the
 *   collection-governor generalization). The behavior was proven live on ChatGPT
 *   (19 → 32.7 conv/min), but the rate ceiling itself is provider-specific and
 *   comes from the required ProviderProfile, never from a cross-provider default.
 * - **Warm-start across runs (opt-in seam, ~2 lines)** — the learned interval is
 *   ephemeral within a process. To compound the descent across runs, a connector
 *   restores last run's interval via `restoredIntervalMs` (from
 *   {@link readPersistedPacingInterval}) and persists this run's interval via
 *   {@link buildPacingStateFields}. The governor owns the GCRA mechanics; the
 *   connector only threads its durable state.
 * - **collection_rate observability** — {@link buildCollectionRateProgress} turns
 *   the governor's live {@link snapshot} into the redacted `collection_rate`
 *   run-trace progress every connector can emit, so an operator can watch the
 *   controller speed up and back off.
 * - ONE pre-flight send governor: pacing's single `admit()` is the only
 *   pre-flight wait. (These API connectors are serial — one in-flight request —
 *   so a concurrency lane would be a no-op governor; pacing is the right single
 *   governor here.)
 * - Retry-After honor with the per-request double-pay guard handled inside
 *   `retryHttp` (the server interval is slept once, not stacked on backoff).
 * - A Finagle-style ratio-based retry budget bounds retry *volume*.
 * - On terminal exhaustion of a rate-limit (429), it throws the connector's
 *   existing `<name>_rate_limited` error so the runtime's `retryablePattern`
 *   cross-run source-pressure deferral/cooldown contract is byte-preserved.
 *
 * Transport-agnostic: the caller supplies `send` (native `fetch`, a browser
 * `page.evaluate` fetch, etc.). The governor normalizes the response into the
 * minimal `{ status, headers }` shape `retryHttp` needs via `classify`.
 *
 * Scope: API connectors only. Browser-bound connectors (amazon/chase/usaa) and
 * reddit are Phase B (a separate research verdict) and do NOT use this factory.
 */
export interface ConnectorHttpGovernorOptions {
  /** Base backoff (ms) for jittered exponential delay. Default: 1000. */
  baseDelayMs?: number;
  /** Max bounded attempts per request (incl. the first). Default: 4. */
  maxAttempts?: number;
  /** Backoff ceiling (ms). Default: 60_000. */
  maxDelayMs?: number;
  /** Cap an honored Retry-After to this many ms. Default: 5 × 60_000. */
  maxRetryAfterMs?: number;
  /** Connector name, used to build the `<name>_rate_limited` terminal error. */
  name: string;
  /** Injectable clock for the pacing bucket (tests). */
  now?: () => number;
  /**
   * Conservative slow-start DISCOVERY interval (ms) the AIMD ramp enters from on
   * a cold start. Unknown-quota API; start polite. Default:
   * {@link DEFAULT_PACING_INITIAL_INTERVAL_MS} (adaptive collection is on by
   * default). Pass `0` to opt OUT of pacing entirely (no pre-flight wait — the
   * pre-convergence byte-identical behavior).
   */
  pacingInitialIntervalMs?: number;
  /**
   * REQUIRED per-provider profile carrying the safety-/pressure-shaped pacing
   * quantity (`pacingMinIntervalMs`, the rate ceiling). NO cross-provider default
   * (SLVP-ideal spec §3): a connector must declare its own ceiling from its own
   * provider's observed behavior — omitting it is a build error, not a silent
   * borrow of ChatGPT's account-tuned 250ms. Construct from this provider's
   * audited per-connector profile factory in `provider-profile.ts` (e.g.
   * `githubPacingProfile()`), each derived from the provider's documented rate
   * limit (WI-1b; see docs/research/per-connector-rate-profiles-2026-06-13.md).
   *
   * @see ProviderPacingProfile
   */
  profile: ProviderPacingProfile;
  /** Injectable RNG for jitter (tests). */
  random?: () => number;
  /**
   * Warm-start seed: the interval the controller LEARNED at the end of a prior
   * run, restored so the AIMD descent compounds across runs instead of resetting
   * to the cold discovery seed at each boundary. Read it from durable connector
   * state with {@link readPersistedPacingInterval} (which owns the staleness
   * guard). Absent → cold start at `pacingInitialIntervalMs`.
   */
  restoredIntervalMs?: number | null;
  /** Optional ratio-based retry budget (Finagle). Absent → only `maxAttempts`. */
  retryBudget?: HttpRetryBudget;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => void | Promise<void>;
}

export interface ConnectorHttpResult<T> extends HttpRetryResponse {
  /** The parsed body, available on a non-retryable (typically 2xx) response. */
  value: T;
}

export interface ConnectorHttpGovernor {
  /**
   * The single pre-flight send governor. Exposed so a stacking-regression test
   * can assert there is exactly one pre-flight wait source on the request path.
   */
  readonly governor: SendGovernor;
  /**
   * Run one logical request (with bounded inline retries) through the governor.
   * `send` performs the transport call; `classify` maps its result to a status,
   * optional headers, and a parsed value. On terminal 429 exhaustion throws
   * `<name>_rate_limited`; on terminal non-429 retryable exhaustion rethrows the
   * `RetryExhaustedError`; on a `shouldAbort` status throws
   * `TerminalHttpStatusError` (or the caller maps it first via `classify`).
   */
  request<T, R>(
    send: () => R | Promise<R>,
    classify: (raw: R) => { status: number; headers?: Record<string, string | undefined>; value: T }
  ): Promise<ConnectorHttpResult<T>>;
  /**
   * Operator-legible snapshot of the live rate controller, or `null` when pacing
   * is disabled (`pacingInitialIntervalMs: 0`). `snapshot.intervalMs` is the
   * durable value a connector persists for warm-start; pass it to
   * {@link buildPacingStateFields} / {@link buildCollectionRateProgress}. PURE:
   * reads only, never advances GCRA state.
   */
  snapshot(): PacingSnapshot | null;
}

/**
 * The terminal error a 429 exhaustion throws — `<name>_rate_limited` — so the
 * existing connector `retryablePattern` cross-run contract still fires.
 */
export class ConnectorRateLimitedError extends Error {
  constructor(name: string) {
    super(`${name}_rate_limited`);
    this.name = "ConnectorRateLimitedError";
  }
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 5 * 60_000;
/**
 * Cold-start DISCOVERY seed (ms) every governor enters the AIMD ramp from when
 * no fresh learned interval is restored. "Safe but not glacial": polite against
 * an unknown-quota API, well above the ceiling. Live-calibrated on ChatGPT
 * (run_1781139968889) and adopted as the shared default for all API connectors.
 */
export const DEFAULT_PACING_INITIAL_INTERVAL_MS = 1000;
/**
 * ChatGPT's live-calibrated rate ceiling (ms), retained as a NAMED, AUDITED
 * reference value — NOT a silent cross-provider default. As of the §3
 * ProviderProfile generalization the governor no longer falls back to this:
 * every governor-using connector declares its own ceiling via the required
 * `profile.pacingMinIntervalMs` (spec §3 rule 6). This export survives only as
 * documentation of ChatGPT's audited number and for tests that pin it; a new
 * connector author must NOT reach for it (author a per-connector profile factory
 * in `provider-profile.ts` derived from the provider's documented limit instead —
 * see the WI-1b factories, e.g. `githubPacingProfile()`).
 */
export const DEFAULT_PACING_MIN_INTERVAL_MS = 250;

export function createConnectorHttpGovernor(options: ConnectorHttpGovernorOptions): ConnectorHttpGovernor {
  // Belt-and-braces for the spec §3 "missing field = build error" rule: the type
  // makes `profile.pacingMinIntervalMs` required, but a JS caller (no tsc) could
  // still omit it. Fail LOUD rather than silently borrowing a shared default —
  // an omitted safety ceiling must never pass quietly.
  if (
    !options.profile ||
    typeof options.profile.pacingMinIntervalMs !== "number" ||
    !Number.isFinite(options.profile.pacingMinIntervalMs) ||
    options.profile.pacingMinIntervalMs <= 0
  ) {
    throw new Error(
      `createConnectorHttpGovernor({ name: "${options.name}" }) requires a per-provider ` +
        "profile.pacingMinIntervalMs (the rate ceiling). Declare one from this provider's " +
        "observed behavior — there is NO cross-provider default (SLVP-ideal spec §3 rule 6)."
    );
  }
  // Adaptive collection is ON by default: a `{ name, profile }` call yields
  // slow-start discovery + AIMD accelerate-under-success + ceiling-bounded
  // back-off. Pass `pacingInitialIntervalMs: 0` to opt out of pacing entirely.
  const pacingInitialIntervalMs = options.pacingInitialIntervalMs ?? DEFAULT_PACING_INITIAL_INTERVAL_MS;
  // The rate ceiling comes from the REQUIRED per-provider profile — never a
  // shared fallback (spec §3). A missing profile is a compile-time error on the
  // options type, so by the time we are here `pacingMinIntervalMs` is always a
  // declared, per-provider value.
  const pacingMinIntervalMs = options.profile.pacingMinIntervalMs;
  const pacingEnabled = pacingInitialIntervalMs > 0;
  // Warm-start: seed from the prior run's learned interval when the connector
  // restored one (already staleness-guarded by readPersistedPacingInterval).
  const restored =
    options.restoredIntervalMs == null || !Number.isFinite(options.restoredIntervalMs)
      ? null
      : options.restoredIntervalMs;
  const pacing = new ProviderPacing({
    initialIntervalMs: pacingInitialIntervalMs,
    minIntervalMs: pacingMinIntervalMs,
    ...(restored == null ? {} : { restoredIntervalMs: restored }),
    ...(options.now == null ? {} : { now: options.now }),
    ...(options.sleep == null ? {} : { sleep: (ms: number) => Promise.resolve(options.sleep?.(ms)) }),
  });

  // The single pre-flight wait. ProviderPacing.admit() is the ONE governor for
  // these serial API connectors. There is deliberately no second pre-flight
  // gate to compose with — that is the convergence invariant.
  const governor: SendGovernor = {
    acquire: () => pacing.admit(),
  };

  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;

  async function request<T, R>(
    send: () => R | Promise<R>,
    classify: (raw: R) => { status: number; headers?: Record<string, string | undefined>; value: T }
  ): Promise<ConnectorHttpResult<T>> {
    try {
      const response = await retryHttp<ConnectorHttpResult<T>>({
        baseDelayMs,
        // The single pre-flight gate fires before each attempt (initial + retry),
        // so retries pass through the same governor as originals (prior-art
        // transferable pattern #3).
        beforeAttempt: () => governor.acquire(),
        maxAttempts,
        maxDelayMs,
        maxRetryAfterMs,
        ...(options.random == null ? {} : { random: options.random }),
        ...(options.retryBudget == null ? {} : { retryBudget: options.retryBudget }),
        ...(options.sleep == null ? {} : { sleep: options.sleep }),
        request: async () => {
          const raw = await send();
          const c = classify(raw);
          const result: ConnectorHttpResult<T> = { status: c.status, value: c.value };
          if (c.headers) {
            result.headers = c.headers;
          }
          return result;
        },
        onRetry: () => {
          // Feed the pacing AIMD with the throttle signal (multiplicative
          // fill-rate decrease) ONLY. Crucially we do NOT forward Retry-After
          // into the pacing bucket: `retryHttp` already sleeps the Retry-After
          // (or jittered backoff) for this attempt. Re-queuing it as a pacing
          // pre-flight wait would double-pay the same delay — the exact
          // `retryAfterAlreadySlept` / `absorbedByRequestWait` guard. The
          // backoff (post-failure) and pacing (pre-flight) stay one wait each.
          pacing.recordThrottle({});
        },
      });
      pacing.recordSuccess();
      return response;
    } catch (error) {
      if (isRateLimitTerminal(error)) {
        throw new ConnectorRateLimitedError(options.name);
      }
      throw error;
    }
  }

  function snapshot(): PacingSnapshot | null {
    return pacingEnabled ? pacing.snapshot() : null;
  }

  return { governor, request, snapshot };
}

function isRateLimitTerminal(error: unknown): boolean {
  if (error instanceof RetryExhaustedError) {
    const cause = error.originalCause;
    return typeof cause === "object" && cause !== null && (cause as { status?: number }).status === 429;
  }
  if (error instanceof TerminalHttpStatusError) {
    return error.status === 429;
  }
  return false;
}

// ─── Warm-start persistence + observability helpers (shared, opt-in) ─────────
//
// These let any governor-using connector thread the learned rate across runs and
// surface it to operators with ~2 lines of glue, instead of hand-rolling the
// read/write/snapshot logic the ChatGPT detail path pioneered. The governor owns
// the GCRA mechanics; the connector owns where its durable state lives.

/** Default state sub-key the persisted learned interval is stored under. */
export const PACING_STATE_INTERVAL_KEY = "pacing_interval_ms";
/** Default state sub-key the persist timestamp (ms epoch) is stored under. */
export const PACING_STATE_RECORDED_AT_KEY = "pacing_recorded_at_ms";
/**
 * Default staleness guard (ms): a learned interval older than this is discarded
 * so a long-idle resume cold-starts conservatively against a possibly-reset
 * provider quota.
 *
 * Rationale: provider quotas reset on hour/day scales and scheduled connector
 * runs are spaced hours apart, so a learned interval is meaningful for HOURS.
 * 6 hours covers typical quota-reset cadences (most providers use daily or
 * per-hour windows) and matches the expected gap between scheduled runs, while
 * still discarding rates from arbitrarily distant prior sessions.
 * Operator-tunable via the `stalenessMs` option if a connector's quota resets
 * faster (or if you want a larger safety margin).
 */
export const DEFAULT_PACING_STALENESS_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface PacingPersistOptions {
  /** State sub-key for the interval. Default: {@link PACING_STATE_INTERVAL_KEY}. */
  intervalKey?: string;
  /** Injectable clock (tests). Default: Date.now. */
  now?: () => number;
  /** State sub-key for the timestamp. Default: {@link PACING_STATE_RECORDED_AT_KEY}. */
  recordedAtKey?: string;
  /** Staleness window (ms). Default: {@link DEFAULT_PACING_STALENESS_MS}. */
  stalenessMs?: number;
}

/**
 * Read a fresh learned interval out of a connector's durable state cursor for
 * warm-start, applying the staleness guard. Returns `null` when absent, malformed,
 * or older than `stalenessMs` (→ cold start). Pass the result as the governor's
 * `restoredIntervalMs`. `stateSlice` is the per-stream cursor object the connector
 * persisted the pacing fields into (e.g. `state.messages`).
 */
export function readPersistedPacingInterval(
  stateSlice: Record<string, unknown> | null | undefined,
  options: PacingPersistOptions = {}
): number | null {
  if (!stateSlice || typeof stateSlice !== "object") {
    return null;
  }
  const intervalKey = options.intervalKey ?? PACING_STATE_INTERVAL_KEY;
  const recordedAtKey = options.recordedAtKey ?? PACING_STATE_RECORDED_AT_KEY;
  const stalenessMs = options.stalenessMs ?? DEFAULT_PACING_STALENESS_MS;
  const now = options.now ?? Date.now;
  const intervalMs = stateSlice[intervalKey];
  const recordedAtMs = stateSlice[recordedAtKey];
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null;
  }
  if (typeof recordedAtMs !== "number" || !Number.isFinite(recordedAtMs)) {
    return null;
  }
  if (now() - recordedAtMs > stalenessMs) {
    return null;
  }
  return intervalMs;
}

/**
 * Build the durable state fields that persist a governor's learned interval for
 * the next run's warm-start. Spread the result into the connector's STATE cursor
 * alongside its own cursor fields. Returns `{}` when pacing is disabled (nothing
 * to persist).
 *
 * SEED-POISONING GUARD: the persisted interval is CAPPED at the cold-start
 * baseline (`initialIntervalMs`). Warm-start exists only to let the next run START
 * FASTER than a cold start by reusing a learned healthy operating rate — it must
 * never make the next run start SLOWER than cold. A run that ended deep in
 * throttle (an interval the AIMD backed off to, or a provider Retry-After spike)
 * would otherwise persist that transient backoff as the seed, so the next run
 * would crawl back toward the ceiling from an interval worse than cold-start (the
 * descent compounding across runs). Capping at cold-start means a healthy run
 * persists its fast learned interval while a throttled run persists at most the
 * cold-start baseline (a clean cold re-entry). Within-run backoff still protects
 * the live account; only the CROSS-run seed is floored.
 */
export function buildPacingStateFields(
  governor: Pick<ConnectorHttpGovernor, "snapshot"> | null | undefined,
  options: PacingPersistOptions = {}
): Record<string, number> {
  const snapshot = governor?.snapshot();
  if (!snapshot) {
    return {};
  }
  const intervalKey = options.intervalKey ?? PACING_STATE_INTERVAL_KEY;
  const recordedAtKey = options.recordedAtKey ?? PACING_STATE_RECORDED_AT_KEY;
  const now = options.now ?? Date.now;
  return {
    [intervalKey]: Math.min(snapshot.intervalMs, snapshot.initialIntervalMs),
    [recordedAtKey]: now(),
  };
}

/** Requests/min from an interval (ms); 0 interval reads as 0 rate (never ∞). */
function ratePerMinFromInterval(intervalMs: number): number {
  return intervalMs > 0 ? Math.round(60_000 / intervalMs) : 0;
}

/**
 * Build the operator-legible `collection_rate` progress from a governor's live
 * snapshot, or `null` when pacing is disabled. PURE; carries no account content —
 * only rate numbers and the last back-off reason (SLVP ideal §5: legibility).
 * The shape matches the `CollectionRateProgress` runtime-protocol type so the
 * caller can emit it as `{ type: "PROGRESS", collection_rate }`.
 */
export function buildCollectionRateProgress(
  governor: Pick<ConnectorHttpGovernor, "snapshot"> | null | undefined
): CollectionRateProgress | null {
  const snapshot = governor?.snapshot();
  if (!snapshot) {
    return null;
  }
  return {
    ceiling_interval_ms: snapshot.minIntervalMs,
    ceiling_rate_per_min: ratePerMinFromInterval(snapshot.minIntervalMs),
    current_interval_ms: snapshot.intervalMs,
    effective_rate_per_min: ratePerMinFromInterval(snapshot.intervalMs),
    last_backoff: snapshot.lastBackoff
      ? { at_interval_ms: snapshot.lastBackoff.atIntervalMs, reason: snapshot.lastBackoff.reason }
      : null,
    object: "collection_rate",
  };
}
