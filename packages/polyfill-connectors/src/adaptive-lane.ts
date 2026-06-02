import { AsyncLocalStorage } from "node:async_hooks";
import PQueue from "p-queue";

export type AdaptiveLaneOutcomeKind = "ok" | "retryable" | "rate_limited" | "terminal";
export type AdaptiveLanePressureKind = "rate_limited" | "transient_error";

export interface AdaptiveLanePressure {
  /**
   * Set when the reporting task has *already* slept `delayMs` itself before
   * reporting (e.g. a per-request retry loop that sleeps and then succeeds on
   * a later attempt). In that case the lane still reduces concurrency and emits
   * the pressure event, but does NOT mirror the same wait into the next launch
   * cooldown — that would double-pay the backoff the request already absorbed.
   *
   * Leave unset (the default) when the next launch genuinely still owes the
   * wait, i.e. the reporting task observed pressure without sleeping for it.
   */
  absorbedByRequestWait?: boolean;
  delayMs?: number;
  kind: AdaptiveLanePressureKind;
  retryAfterMs?: number;
}

export interface AdaptiveLaneOutcome {
  kind: AdaptiveLaneOutcomeKind;
  reason?: string;
  retryAfterMs?: number;
}

export interface AdaptiveLaneSnapshot {
  activeCount: number;
  concurrency: number;
  maxConcurrency: number;
  minConcurrency: number;
  name: string;
  pendingCount: number;
  queueSize: number;
}

export interface AdaptiveLaneEvent extends AdaptiveLaneSnapshot {
  attempt?: number;
  delayMs?: number;
  errorName?: string;
  outcome?: AdaptiveLaneOutcomeKind;
  reason?: string;
  retryAfterMs?: number;
  type:
    | "queued"
    | "started"
    | "completed"
    | "retry_scheduled"
    | "cooldown"
    | "concurrency_decreased"
    | "concurrency_increased"
    | "cancelled"
    | "queue_rejected";
}

type AdaptiveLaneEventInput = Omit<AdaptiveLaneEvent, keyof AdaptiveLaneSnapshot>;

export interface AdaptiveLaneRunContext {
  attempt: number;
  reportPressure: (pressure: AdaptiveLanePressure) => Promise<void>;
  signal?: AbortSignal;
}

export interface AdaptiveLaneRunOptions {
  onBeforeStart?: () => void;
  onFailure?: (error: unknown) => void;
  signal?: AbortSignal;
}

export interface AdaptiveLaneOptions<T> {
  attemptTimeoutMs?: number;
  classifyOutcome: (input: { error?: unknown; result?: T }) => AdaptiveLaneOutcome;
  emitProgress?: (event: AdaptiveLaneEvent) => void | Promise<void>;
  emitTelemetry?: (event: AdaptiveLaneEvent) => void | Promise<void>;
  initialConcurrency: number;
  maxAttempts?: number;
  maxConcurrency: number;
  maxDelayMs: number;
  maxQueueSize: number;
  minConcurrency: number;
  minDelayMs: number;
  name: string;
  pressureMaxDelayMs?: number;
  pressureMinDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => void | Promise<void>;
  successWindow?: number;
}

export interface AdaptiveLane<T> {
  cancel(reason?: string): void;
  readonly name: string;
  run(task: (context: AdaptiveLaneRunContext) => T | Promise<T>, options?: AdaptiveLaneRunOptions): Promise<T>;
  runAll<I>(
    items: readonly I[],
    task: (item: I, context: AdaptiveLaneRunContext) => T | Promise<T>,
    options?: AdaptiveLaneRunOptions
  ): Promise<T[]>;
  snapshot(): AdaptiveLaneSnapshot;
}

export class AdaptiveLaneQueueFullError extends Error {
  constructor(name: string, maxQueueSize: number) {
    super(`adaptive lane ${name} queue is full (maxQueueSize=${maxQueueSize})`);
    this.name = "AdaptiveLaneQueueFullError";
  }
}

export class AdaptiveLaneCancelledError extends Error {
  constructor(name: string, reason = "cancelled") {
    super(`adaptive lane ${name} cancelled: ${reason}`);
    this.name = "AdaptiveLaneCancelledError";
  }
}

export class AdaptiveLaneAttemptTimeoutError extends Error {
  readonly attempt: number;

  constructor(name: string, attempt: number, timeoutMs: number) {
    super(`adaptive lane ${name} attempt ${attempt} timed out after ${timeoutMs}ms`);
    this.name = "AdaptiveLaneAttemptTimeoutError";
    this.attempt = attempt;
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const runContextStorage = new AsyncLocalStorage<AdaptiveLaneRunContext>();

export function currentAdaptiveLaneRunContext(): AdaptiveLaneRunContext | undefined {
  return runContextStorage.getStore();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeOutcome(outcome: AdaptiveLaneOutcome | AdaptiveLaneOutcomeKind): AdaptiveLaneOutcome {
  return typeof outcome === "string" ? { kind: outcome } : outcome;
}

export function createAdaptiveLane<T>(options: AdaptiveLaneOptions<T>): AdaptiveLane<T> {
  const minConcurrency = Math.max(1, Math.floor(options.minConcurrency));
  const maxConcurrency = Math.max(minConcurrency, Math.floor(options.maxConcurrency));
  const initialConcurrency = clampInt(options.initialConcurrency, minConcurrency, maxConcurrency);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));
  const successWindow = Math.max(1, Math.floor(options.successWindow ?? Math.max(3, maxConcurrency)));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const pressureMinDelayMs = Math.max(0, Math.floor(options.pressureMinDelayMs ?? options.minDelayMs));
  const pressureMaxDelayMs = Math.max(pressureMinDelayMs, Math.floor(options.pressureMaxDelayMs ?? options.maxDelayMs));
  const queue = new PQueue({ concurrency: initialConcurrency });
  let currentConcurrency = initialConcurrency;
  let cleanSuccesses = 0;
  let launchCount = 0;
  let pendingLaunchCooldownMs = 0;
  let cancelled: AdaptiveLaneCancelledError | null = null;
  const laneController = new AbortController();
  const queued = new Set<{ reject: (error: unknown) => void; started: boolean }>();

  const snapshot = (): AdaptiveLaneSnapshot => ({
    activeCount: queue.pending,
    concurrency: currentConcurrency,
    maxConcurrency,
    minConcurrency,
    name: options.name,
    pendingCount: queue.pending,
    queueSize: queue.size,
  });

  const emit = async (event: AdaptiveLaneEventInput): Promise<void> => {
    const fullEvent = { ...snapshot(), ...event };
    await options.emitTelemetry?.(fullEvent);
    await options.emitProgress?.(fullEvent);
  };

  const emitSafely = (event: AdaptiveLaneEventInput): void => {
    emit(event).catch(() => undefined);
  };

  const ensureNotCancelled = (signal?: AbortSignal): void => {
    if (cancelled) {
      throw cancelled;
    }
    if (signal?.aborted) {
      throw new AdaptiveLaneCancelledError(options.name, "signal aborted");
    }
  };

  const wait = async (ms: number, signal?: AbortSignal): Promise<void> => {
    ensureNotCancelled(signal);
    if (ms <= 0) {
      return;
    }
    const abort = (): never => {
      throw cancelled ?? new AdaptiveLaneCancelledError(options.name, "signal aborted");
    };
    let rejectAbort!: (error: unknown) => void;
    const abortPromise = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = (): void =>
      rejectAbort(cancelled ?? new AdaptiveLaneCancelledError(options.name, "signal aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    laneController.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted || laneController.signal.aborted) {
        abort();
      }
      await Promise.race([Promise.resolve(sleep(ms)), abortPromise]);
      ensureNotCancelled(signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      laneController.signal.removeEventListener("abort", onAbort);
    }
  };

  const boundedDelay = (
    outcome: AdaptiveLaneOutcome,
    minDelayMs = options.minDelayMs,
    maxDelayMs = options.maxDelayMs
  ): number => {
    const retryAfterMs = outcome.retryAfterMs;
    if (retryAfterMs != null) {
      return clampInt(retryAfterMs, minDelayMs, maxDelayMs);
    }
    const span = Math.max(0, maxDelayMs - minDelayMs);
    return minDelayMs + Math.floor(random() * (span + 1));
  };

  const boundedExplicitDelay = (delayMs: number): number => clampInt(delayMs, pressureMinDelayMs, pressureMaxDelayMs);

  const launchDelay = (): number => {
    if (launchCount === 0) {
      return 0;
    }
    const span = Math.max(0, options.maxDelayMs - options.minDelayMs);
    return options.minDelayMs + Math.floor(random() * (span + 1));
  };

  const decreaseConcurrency = async (reason: string): Promise<void> => {
    const next =
      reason === "rate_limited" ? minConcurrency : Math.max(minConcurrency, Math.floor(currentConcurrency / 2));
    cleanSuccesses = 0;
    if (next !== currentConcurrency) {
      currentConcurrency = next;
      queue.concurrency = next;
      await emit({ reason, type: "concurrency_decreased" });
    }
  };

  const pressureOutcome = (pressure: AdaptiveLanePressure): AdaptiveLaneOutcome => {
    const outcome: AdaptiveLaneOutcome = {
      kind: pressure.kind === "rate_limited" ? "rate_limited" : "retryable",
      reason: pressure.kind,
    };
    if (pressure.retryAfterMs != null) {
      outcome.retryAfterMs = pressure.retryAfterMs;
    }
    return outcome;
  };

  const reportPressure = async (
    pressure: AdaptiveLanePressure,
    attempt: number,
    signal?: AbortSignal
  ): Promise<void> => {
    ensureNotCancelled(signal);
    const outcome = pressureOutcome(pressure);
    await decreaseConcurrency(outcome.kind);
    const delayMs =
      pressure.delayMs == null
        ? boundedDelay(outcome, pressureMinDelayMs, pressureMaxDelayMs)
        : boundedExplicitDelay(pressure.delayMs);
    // When the reporting task already slept `delayMs` inside its own retry loop
    // and then succeeded, mirroring the same wait into the next-launch cooldown
    // double-pays the backoff. Reduce concurrency and surface the event, but
    // skip the cooldown — the normal inter-launch pace (launchDelay) still
    // applies, so this removes duplicated waiting without becoming aggressive.
    if (!pressure.absorbedByRequestWait) {
      pendingLaunchCooldownMs = Math.max(pendingLaunchCooldownMs, delayMs);
    }
    await emit(
      outcomeEvent({
        attempt,
        delayMs,
        outcome,
        type: outcome.kind === "rate_limited" ? "cooldown" : "retry_scheduled",
      })
    );
  };

  const maybeIncreaseConcurrency = async (): Promise<void> => {
    cleanSuccesses += 1;
    if (cleanSuccesses < successWindow || currentConcurrency >= maxConcurrency) {
      return;
    }
    cleanSuccesses = 0;
    currentConcurrency += 1;
    queue.concurrency = currentConcurrency;
    await emit({ reason: "clean_success_window", type: "concurrency_increased" });
  };

  const cancel = (reason = "cancelled"): void => {
    if (cancelled) {
      return;
    }
    cancelled = new AdaptiveLaneCancelledError(options.name, reason);
    laneController.abort(cancelled);
    queue.clear();
    for (const entry of queued) {
      if (!entry.started) {
        entry.reject(cancelled);
      }
    }
    queued.clear();
    emitSafely({ reason, type: "cancelled" });
  };

  const runContext = (attempt: number, signal?: AbortSignal): AdaptiveLaneRunContext => {
    const context: AdaptiveLaneRunContext = {
      attempt,
      reportPressure: (pressure) => reportPressure(pressure, attempt, signal),
    };
    if (signal) {
      context.signal = signal;
    }
    return context;
  };

  const runAttempt = (
    task: (context: AdaptiveLaneRunContext) => T | Promise<T>,
    attempt: number,
    signal?: AbortSignal
  ): Promise<T> => {
    const context = runContext(attempt, signal);
    const attemptPromise = runContextStorage.run(context, () => Promise.resolve(task(context)));
    if (options.attemptTimeoutMs == null) {
      return attemptPromise;
    }
    return Promise.race([
      attemptPromise,
      wait(options.attemptTimeoutMs, signal).then(() => {
        throw new AdaptiveLaneAttemptTimeoutError(options.name, attempt, options.attemptTimeoutMs ?? 0);
      }),
    ]);
  };

  const outcomeEvent = (event: {
    attempt: number;
    delayMs?: number;
    error?: unknown;
    outcome: AdaptiveLaneOutcome;
    type: AdaptiveLaneEventInput["type"];
  }): AdaptiveLaneEventInput => {
    const base: AdaptiveLaneEventInput = {
      attempt: event.attempt,
      outcome: event.outcome.kind,
      type: event.type,
    };
    if (event.delayMs != null) {
      base.delayMs = event.delayMs;
    }
    if (event.error !== undefined) {
      base.errorName = errorName(event.error);
    }
    if (event.outcome.reason != null) {
      base.reason = event.outcome.reason;
    }
    if (event.outcome.retryAfterMs != null) {
      base.retryAfterMs = event.outcome.retryAfterMs;
    }
    return base;
  };

  const handlePressure = async (
    outcome: AdaptiveLaneOutcome,
    attempt: number,
    signal: AbortSignal | undefined,
    error?: unknown
  ): Promise<"retry" | "stop"> => {
    if (outcome.kind === "terminal" || attempt >= maxAttempts) {
      await decreaseConcurrency(outcome.kind);
      await emit(outcomeEvent({ attempt, error, outcome, type: "completed" }));
      return "stop";
    }
    await decreaseConcurrency(outcome.kind);
    const delayMs = boundedDelay(outcome);
    await emit(
      outcomeEvent({
        attempt,
        delayMs,
        error,
        outcome,
        type: outcome.kind === "rate_limited" ? "cooldown" : "retry_scheduled",
      })
    );
    await wait(delayMs, signal);
    return "retry";
  };

  const runAttempts = async (
    task: (context: AdaptiveLaneRunContext) => T | Promise<T>,
    signal?: AbortSignal
  ): Promise<T> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await runAttempt(task, attempt, signal);
        const outcome = normalizeOutcome(options.classifyOutcome({ result }));
        if (outcome.kind === "ok") {
          await maybeIncreaseConcurrency();
          await emit({ attempt, outcome: outcome.kind, type: "completed" });
          return result;
        }
        if ((await handlePressure(outcome, attempt, signal)) === "stop") {
          return result;
        }
      } catch (error) {
        const outcome = normalizeOutcome(options.classifyOutcome({ error }));
        if (outcome.kind === "ok") {
          throw error;
        }
        if ((await handlePressure(outcome, attempt, signal, error)) === "stop") {
          throw error;
        }
      }
    }
    throw new Error(`adaptive lane ${options.name} exhausted without terminal outcome`);
  };

  const startQueuedTask = async (
    entry: { reject: (error: unknown) => void; started: boolean },
    task: (context: AdaptiveLaneRunContext) => T | Promise<T>,
    runOptions: AdaptiveLaneRunOptions,
    signal?: AbortSignal
  ): Promise<T> => {
    try {
      entry.started = true;
      queued.delete(entry);
      ensureNotCancelled(signal);
      runOptions.onBeforeStart?.();
      const delayMs = launchDelay();
      const cooldownMs = pendingLaunchCooldownMs;
      pendingLaunchCooldownMs = 0;
      const launchWaitMs = Math.max(delayMs, cooldownMs);
      launchCount += 1;
      if (launchWaitMs > 0) {
        await wait(launchWaitMs, signal);
      }
      await emit({ type: "started" });
      return await runAttempts(task, signal);
    } catch (error) {
      runOptions.onFailure?.(error);
      throw error;
    }
  };

  const run = (
    task: (context: AdaptiveLaneRunContext) => T | Promise<T>,
    runOptions: AdaptiveLaneRunOptions = {}
  ): Promise<T> => {
    const signal = runOptions.signal;
    ensureNotCancelled(signal);
    if (options.maxQueueSize >= 0 && queue.size + queue.pending >= options.maxQueueSize) {
      const error = new AdaptiveLaneQueueFullError(options.name, options.maxQueueSize);
      emitSafely({ errorName: error.name, type: "queue_rejected" });
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      const entry = { reject, started: false };
      queued.add(entry);
      const onAbort = (): void => {
        reject(new AdaptiveLaneCancelledError(options.name, "signal aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      emitSafely({ type: "queued" });
      queue
        .add(() => startQueuedTask(entry, task, runOptions, signal))
        .then(resolve, reject)
        .finally(() => {
          signal?.removeEventListener("abort", onAbort);
          queued.delete(entry);
        });
    });
  };

  return {
    name: options.name,
    cancel,
    run,
    runAll: async <I>(
      items: readonly I[],
      task: (item: I, context: AdaptiveLaneRunContext) => T | Promise<T>,
      runOptions?: AdaptiveLaneRunOptions
    ): Promise<T[]> => {
      let firstFailure: unknown = null;
      const sharedRunOptions: AdaptiveLaneRunOptions = {
        onBeforeStart: () => {
          if (firstFailure) {
            throw firstFailure;
          }
        },
        onFailure: (error) => {
          firstFailure ??= error;
        },
      };
      if (runOptions?.signal) {
        sharedRunOptions.signal = runOptions.signal;
      }
      const runs = items.map((item) => run((context) => task(item, context), sharedRunOptions));
      try {
        return await Promise.all(runs);
      } catch (error) {
        firstFailure ??= error;
        await Promise.allSettled(runs);
        throw firstFailure;
      }
    },
    snapshot,
  };
}
