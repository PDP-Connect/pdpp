import {
  type HttpRetryBudget,
  type HttpRetryResponse,
  RetryExhaustedError,
  retryHttp,
  TerminalHttpStatusError,
} from "./http-retry.js";
import { ProviderPacing } from "./provider-pacing.js";
import type { SendGovernor } from "./send-governor.js";

/**
 * Shared HTTP request governor for API connectors that previously hand-rolled
 * `if (status === 429) throw new Error("<name>_rate_limited")` with no
 * Retry-After honor and no inline retry.
 *
 * It converges those connectors onto the doctrine
 * (design-notes/provider-rate-governance-convergence-2026-06-10.md):
 *
 * - ONE pre-flight send governor: a per-provider {@link ProviderPacing} bucket
 *   whose single `admit()` is the only pre-flight wait. (These API connectors
 *   are serial — one in-flight request — so a concurrency lane would be a
 *   no-op governor; pacing is the right single governor here.)
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
   * Conservative starting inter-request interval (ms) for the single pacing
   * governor. Unknown-quota API; start polite. Default: 0 (no pacing wait) so
   * adoption is opt-in for pacing — set a positive value to enable smoothing.
   */
  pacingInitialIntervalMs?: number;
  /** Minimum inter-request interval the AIMD fill-rate may reach. Default: 0. */
  pacingMinIntervalMs?: number;
  /** Injectable RNG for jitter (tests). */
  random?: () => number;
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

export function createConnectorHttpGovernor(options: ConnectorHttpGovernorOptions): ConnectorHttpGovernor {
  const pacing = new ProviderPacing({
    initialIntervalMs: options.pacingInitialIntervalMs ?? 0,
    minIntervalMs: options.pacingMinIntervalMs ?? 0,
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

  return { governor, request };
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
