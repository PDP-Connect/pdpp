// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type PacingOptions, type PacingSnapshot, ProviderPacing, type ThrottleSignal } from "./provider-pacing.ts";
import { RunBudget, type RunBudgetOptions, type RunBudgetTrip } from "./run-budget.ts";
import type { SendDelayHint } from "./send-governor.ts";

export type ProviderBudgetDeferReason = RunBudgetTrip | "circuit_open" | "retry_budget";

/**
 * How the controller's GCRA pacing participates in the request path.
 *
 * - `"preflight"` (default, pre-convergence): the controller owns pacing as its
 *   own pre-flight wait — `beforeRequest()` `await`s `pacing.admit()`. When the
 *   caller ALSO runs a concurrency send governor (e.g. an adaptive lane with a
 *   launch delay), this is the two-gate stacking the rate-governance
 *   convergence forbids. Retained as the default so existing connector behavior
 *   is byte-identical until an owner opts into convergence.
 * - `"signal"` (converged): the controller performs NO pre-flight wait. Pacing
 *   becomes a {@link SendDelayHint} (`pacingDelayHint()`) the single send
 *   governor folds into its one wait. The controller is then a pure
 *   admission-decision + signal layer — a second pre-flight gate is not
 *   expressible.
 */
export type ProviderBudgetPacingMode = "preflight" | "signal";
export type CircuitBreakerState = "closed" | "half_open" | "open";
export type ProviderBudgetCircuitTransitionTrigger =
  | "before_request"
  | "provider_failure"
  | "provider_throttle"
  | "success";

export interface ProviderBudgetCircuitTransition {
  elapsedMs: number;
  previousState: CircuitBreakerState;
  reason: "provider_failure" | "provider_throttle" | "reset_timeout" | "success";
  requestCount: number;
  retryTokensRemaining: number;
  state: CircuitBreakerState;
  trigger: ProviderBudgetCircuitTransitionTrigger;
}

export interface ProviderBudgetStop {
  circuitState?: CircuitBreakerState;
  elapsedMs: number;
  reason: ProviderBudgetDeferReason;
  requestCount: number;
  retryTokensRemaining: number;
}

export type ProviderBudgetGate = { ok: true } | ({ ok: false } & ProviderBudgetStop);

export interface RetryBudgetOptions {
  /** Maximum retry tokens. Infinity disables retry-budget exhaustion. */
  capacity?: number;
  /** Starting retry tokens. Defaults to capacity. */
  initialTokens?: number;
  /** Tokens refilled per successful provider response. Default: 1. */
  refillPerSuccess?: number;
}

export class RetryBudget {
  readonly capacity: number;
  readonly refillPerSuccess: number;
  private tokens: number;

  constructor(options: RetryBudgetOptions = {}) {
    this.capacity = sanitizeNonNegative(options.capacity ?? Number.POSITIVE_INFINITY);
    this.refillPerSuccess = sanitizeNonNegative(options.refillPerSuccess ?? 1);
    this.tokens = Math.min(sanitizeNonNegative(options.initialTokens ?? this.capacity), this.capacity);
  }

  consume(): boolean {
    if (this.capacity === Number.POSITIVE_INFINITY) {
      return true;
    }
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  recordSuccess(): void {
    if (this.capacity === Number.POSITIVE_INFINITY) {
      return;
    }
    this.tokens = Math.min(this.capacity, this.tokens + this.refillPerSuccess);
  }

  get remaining(): number {
    return this.tokens;
  }
}

export interface CircuitBreakerOptions {
  /** Failure ratio required to open the circuit. Default: 0.5. */
  failureRateThreshold?: number;
  /** Number of observations required before the breaker may open. Default: 5. */
  minimumThroughput?: number;
  /** Clock used for reset timeout checks. Default: Date.now. */
  now?: () => number;
  /** How long the circuit stays open before a half-open probe. Default: 60s. */
  resetTimeoutMs?: number;
  /** Sliding observation window size. Default: 10. */
  windowSize?: number;
}

export class CircuitBreaker {
  private readonly failureRateThreshold: number;
  private readonly minimumThroughput: number;
  private readonly now: () => number;
  private readonly resetTimeoutMs: number;
  private readonly windowSize: number;
  private openedAt: number | null = null;
  private outcomes: boolean[] = [];
  private _state: CircuitBreakerState = "closed";

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureRateThreshold = clampRatio(options.failureRateThreshold ?? 0.5);
    this.minimumThroughput = Math.max(1, Math.floor(options.minimumThroughput ?? 5));
    this.now = options.now ?? Date.now;
    this.resetTimeoutMs = Math.max(0, Math.floor(options.resetTimeoutMs ?? 60_000));
    this.windowSize = Math.max(this.minimumThroughput, Math.floor(options.windowSize ?? 10));
  }

  beforeRequest(): ProviderBudgetGate {
    if (this._state !== "open") {
      return { ok: true };
    }
    const elapsedOpenMs = this.openedAt == null ? 0 : Math.max(0, this.now() - this.openedAt);
    if (elapsedOpenMs >= this.resetTimeoutMs) {
      this._state = "half_open";
      return { ok: true };
    }
    return {
      ok: false,
      circuitState: this._state,
      elapsedMs: 0,
      reason: "circuit_open",
      requestCount: 0,
      retryTokensRemaining: Number.POSITIVE_INFINITY,
    };
  }

  recordSuccess(): void {
    if (this._state === "half_open") {
      this.close();
      return;
    }
    if (this._state === "closed") {
      this.recordOutcome(true);
    }
  }

  recordFailure(): void {
    if (this._state === "half_open") {
      this.open();
      return;
    }
    if (this._state !== "closed") {
      return;
    }
    this.recordOutcome(false);
    if (this.outcomes.length < this.minimumThroughput) {
      return;
    }
    const failures = this.outcomes.filter((ok) => !ok).length;
    if (failures / this.outcomes.length >= this.failureRateThreshold) {
      this.open();
    }
  }

  get state(): CircuitBreakerState {
    return this._state;
  }

  /**
   * Milliseconds until an open circuit auto-transitions to `half_open` (the next
   * `beforeRequest()` would probe). `0` when the circuit is not open, or already
   * eligible to half-open. A transient back-off can sleep this exact duration to
   * resume the instant the cool-down elapses — distinguishing a transient
   * provider-pressure trip ("slow down, then continue") from genuine budget
   * exhaustion ("stop"). PURE: reads only, never advances state.
   */
  remainingCooldownMs(): number {
    if (this._state !== "open" || this.openedAt == null) {
      return 0;
    }
    const elapsedOpenMs = Math.max(0, this.now() - this.openedAt);
    return Math.max(0, this.resetTimeoutMs - elapsedOpenMs);
  }

  private close(): void {
    this._state = "closed";
    this.openedAt = null;
    this.outcomes = [];
  }

  private open(): void {
    this._state = "open";
    this.openedAt = this.now();
  }

  private recordOutcome(ok: boolean): void {
    this.outcomes.push(ok);
    if (this.outcomes.length > this.windowSize) {
      this.outcomes.shift();
    }
  }
}

export interface ProviderBudgetOptions {
  circuitBreaker?: CircuitBreaker | CircuitBreakerOptions | false;
  pacing?: ProviderPacing | PacingOptions | false;
  /**
   * Whether pacing runs as the controller's own pre-flight wait (`"preflight"`,
   * default) or as a delay hint for a single external send governor
   * (`"signal"`, converged). See {@link ProviderBudgetPacingMode}. Has no effect
   * when `pacing` is disabled.
   */
  pacingMode?: ProviderBudgetPacingMode;
  retryBudget?: RetryBudget | RetryBudgetOptions | false;
  runBudget?: RunBudget | RunBudgetOptions | false;
}

export class ProviderBudgetController implements SendDelayHint {
  readonly circuitBreaker: CircuitBreaker | null;
  readonly pacing: ProviderPacing | null;
  readonly pacingMode: ProviderBudgetPacingMode;
  readonly retryBudget: RetryBudget | null;
  readonly runBudget: RunBudget | null;
  private readonly circuitTransitions: ProviderBudgetCircuitTransition[] = [];

  constructor(options: ProviderBudgetOptions = {}) {
    this.circuitBreaker = resolveCircuitBreaker(options.circuitBreaker);
    this.pacing = resolveProviderPacing(options.pacing);
    this.pacingMode = options.pacingMode ?? "preflight";
    this.retryBudget = resolveRetryBudget(options.retryBudget);
    this.runBudget = resolveRunBudget(options.runBudget);
  }

  async beforeRequest(): Promise<ProviderBudgetGate> {
    const runTrip = this.runBudget?.tripReason() ?? null;
    if (runTrip) {
      return this.stop(runTrip);
    }

    const previousCircuitState = this.circuitBreaker?.state ?? null;
    const circuitGate = this.circuitBreaker?.beforeRequest() ?? { ok: true };
    this.recordCircuitTransition(previousCircuitState, "before_request");
    if (!circuitGate.ok) {
      return this.stop("circuit_open");
    }

    // In `"signal"` (converged) mode the controller performs NO pre-flight wait:
    // pacing is handed to the single send governor via `pacingDelayHint()`. Only
    // legacy `"preflight"` mode sleeps here. This is the one line that decides
    // whether the controller is a second pre-flight gate.
    if (this.pacingMode === "preflight") {
      await this.pacing?.admit();
    }
    return { ok: true };
  }

  /**
   * The {@link SendDelayHint} the single send governor folds into its one
   * pre-flight wait. Computes pacing's owed delay and advances GCRA state
   * without sleeping. Returns 0 when pacing is disabled or in `"preflight"`
   * mode (where the controller already owns the wait, so handing a hint to the
   * governor too would re-create the stacking the convergence removes).
   */
  nextDelayMs(): number {
    if (this.pacingMode !== "signal") {
      return 0;
    }
    return this.pacing?.nextDelayMs() ?? 0;
  }

  /** Alias of {@link nextDelayMs} with a request-path-readable name. */
  pacingDelayHint(): number {
    return this.nextDelayMs();
  }

  /**
   * Operator-legible snapshot of the rate controller's live state, or null when
   * pacing is disabled. The connector persists `snapshot.intervalMs` for
   * warm-start across runs and surfaces the snapshot as redacted run-trace
   * progress. PURE: reads only, never advances GCRA state.
   */
  snapshotPacing(): PacingSnapshot | null {
    return this.pacing?.snapshot() ?? null;
  }

  /**
   * Milliseconds until an open circuit auto-transitions to `half_open`, or `0`
   * when the circuit is closed/half-open/absent. A `circuit_open` gate is a
   * TRANSIENT back-off, not budget exhaustion: a caller can sleep this exact
   * cool-down (bounded by its own remaining run budget) and re-admit, instead of
   * deferring all remaining work. PURE: reads only, never advances state.
   */
  circuitCooldownMs(): number {
    return this.circuitBreaker?.remainingCooldownMs() ?? 0;
  }

  recordRequest(): void {
    this.runBudget?.recordRequest();
  }

  /**
   * §10-D (SLVP-ideal): pass `{ suppressAdditiveIncrease: true }` when this
   * success fires from the cooldown-exempt recovery lane so the shared pacer
   * interval is not decreased (un-learning the back-off the cooldown protects).
   * Throttles still fire unconditionally — recovery may decelerate, never
   * accelerate the shared pacer during cooldown.
   */
  recordSuccess(opts?: { suppressAdditiveIncrease?: boolean }): void {
    this.retryBudget?.recordSuccess();
    this.pacing?.recordSuccess(opts);
    const previousCircuitState = this.circuitBreaker?.state ?? null;
    this.circuitBreaker?.recordSuccess();
    this.recordCircuitTransition(previousCircuitState, "success");
  }

  recordThrottle(signal: ThrottleSignal & { retryAfterAlreadySlept?: boolean } = {}): void {
    const pacingSignal = signal.retryAfterAlreadySlept ? {} : signal;
    this.pacing?.recordThrottle(pacingSignal);
    const previousCircuitState = this.circuitBreaker?.state ?? null;
    this.circuitBreaker?.recordFailure();
    this.recordCircuitTransition(previousCircuitState, "provider_throttle");
  }

  recordFailure(): void {
    const previousCircuitState = this.circuitBreaker?.state ?? null;
    this.circuitBreaker?.recordFailure();
    this.recordCircuitTransition(previousCircuitState, "provider_failure");
  }

  consumeRetry(): ProviderBudgetGate {
    if (this.retryBudget && !this.retryBudget.consume()) {
      return this.stop("retry_budget");
    }
    return { ok: true };
  }

  /**
   * Returns `true` when a retry budget is configured on this controller.
   * Each wait-out gate uses this to decide whether to consume a token or fall
   * back to the densityWaitCycles / circuitWaitCycle cycle cap:
   *
   * ```
   * const waitAllowed = providerBudget?.hasRetryBudget()
   *   ? providerBudget.tryConsumeRetryToken()
   *   : cycleFallback;
   * ```
   *
   * This ensures the cycle-cap fallback fires for BOTH "no controller" and
   * "controller present but no retryBudget" — the two cases that must behave
   * identically from the gate's perspective.
   */
  hasRetryBudget(): boolean {
    return this.retryBudget !== null;
  }

  /**
   * Consume one retry token from the budget for a wait-out attempt.
   * Returns `true` when the budget has tokens remaining, `false` when depleted.
   * ONLY call this after confirming `hasRetryBudget()` returns `true` — calling
   * without a budget is a logic error and will throw in development.
   */
  tryConsumeRetryToken(): boolean {
    if (!this.retryBudget) {
      // Guard against misuse: if hasRetryBudget() was checked first this branch
      // is unreachable. Fail closed so the gate does not allow infinite waits.
      return false;
    }
    return this.retryBudget.consume();
  }

  /**
   * Returns the number of retry tokens currently remaining, or `null` when no
   * retry budget is configured. Use this in progress messages to show the
   * actual governing give-up signal when the budget is active.
   */
  retryTokensRemaining(): number | null {
    return this.retryBudget ? this.retryBudget.remaining : null;
  }

  currentStop(reason: ProviderBudgetDeferReason): ProviderBudgetStop {
    return {
      ...(this.circuitBreaker ? { circuitState: this.circuitBreaker.state } : {}),
      elapsedMs: this.runBudget?.elapsedMs() ?? 0,
      reason,
      requestCount: this.runBudget?.count ?? 0,
      retryTokensRemaining: this.retryBudget?.remaining ?? Number.POSITIVE_INFINITY,
    };
  }

  drainCircuitTransitions(): ProviderBudgetCircuitTransition[] {
    return this.circuitTransitions.splice(0);
  }

  private stop(reason: ProviderBudgetDeferReason): ProviderBudgetGate {
    return { ok: false, ...this.currentStop(reason) };
  }

  private recordCircuitTransition(
    previousState: CircuitBreakerState | null,
    trigger: ProviderBudgetCircuitTransitionTrigger
  ): void {
    if (!this.circuitBreaker || previousState === null || previousState === this.circuitBreaker.state) {
      return;
    }
    this.circuitTransitions.push({
      elapsedMs: this.runBudget?.elapsedMs() ?? 0,
      previousState,
      reason: providerBudgetTransitionReason(trigger, previousState, this.circuitBreaker.state),
      requestCount: this.runBudget?.count ?? 0,
      retryTokensRemaining: this.retryBudget?.remaining ?? Number.POSITIVE_INFINITY,
      state: this.circuitBreaker.state,
      trigger,
    });
  }
}

export function retryBudgetCapacityFromRequestCap({
  maxRequests,
  minCapacity = 1,
  ratio = 0.2,
}: {
  maxRequests: number;
  minCapacity?: number;
  ratio?: number;
}): number {
  if (!Number.isFinite(maxRequests)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(Math.floor(minCapacity), Math.ceil(Math.max(0, maxRequests) * clampRatio(ratio)));
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}

function sanitizeNonNegative(value: number): number {
  if (value === Number.POSITIVE_INFINITY) {
    return value;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

function providerBudgetTransitionReason(
  trigger: ProviderBudgetCircuitTransitionTrigger,
  previousState: CircuitBreakerState,
  state: CircuitBreakerState
): ProviderBudgetCircuitTransition["reason"] {
  if (trigger === "before_request" && previousState === "open" && state === "half_open") {
    return "reset_timeout";
  }
  if (trigger === "provider_throttle") {
    return "provider_throttle";
  }
  if (trigger === "provider_failure") {
    return "provider_failure";
  }
  return "success";
}

function resolveCircuitBreaker(value: ProviderBudgetOptions["circuitBreaker"]): CircuitBreaker | null {
  if (value === false || value == null) {
    return null;
  }
  if (value instanceof CircuitBreaker) {
    return value;
  }
  return new CircuitBreaker(value);
}

function resolveProviderPacing(value: ProviderBudgetOptions["pacing"]): ProviderPacing | null {
  if (value === false || value == null) {
    return null;
  }
  if (value instanceof ProviderPacing) {
    return value;
  }
  return new ProviderPacing(value);
}

function resolveRetryBudget(value: ProviderBudgetOptions["retryBudget"]): RetryBudget | null {
  if (value === false || value == null) {
    return null;
  }
  if (value instanceof RetryBudget) {
    return value;
  }
  return new RetryBudget(value);
}

function resolveRunBudget(value: ProviderBudgetOptions["runBudget"]): RunBudget | null {
  if (value === false || value == null) {
    return null;
  }
  if (value instanceof RunBudget) {
    return value;
  }
  return new RunBudget(value);
}
