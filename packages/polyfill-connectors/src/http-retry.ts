export interface HttpRetryResponse {
  headers?: Record<string, string | undefined>;
  status: number;
}

export interface HttpRetryAttempt<T extends HttpRetryResponse> {
  attempt: number;
  delayMs: number;
  error?: unknown;
  maxAttempts: number;
  response?: T;
  retryAfterMs?: number;
}

export interface HttpRetryKeepRetryingInput<T extends HttpRetryResponse> {
  attempt: number;
  maxAttempts: number;
  response: T;
  retryAfterMs: number | null;
}

/**
 * A Finagle-style ratio-based retry budget: a token bucket that bounds total
 * retry *volume* across a run, distinct from the per-request `maxAttempts`
 * count. `consume()` returns false when the budget is empty — the retry layer
 * then stops retrying rather than spinning. Satisfied by the shared
 * `RetryBudget` (src/provider-budget.ts) so a connector adopting `retryHttp`
 * gets retry-storm protection without re-implementing it.
 */
export interface HttpRetryBudget {
  consume(): boolean;
}

export interface HttpRetryOptions<T extends HttpRetryResponse> {
  baseDelayMs: number;
  /**
   * Optional gate checked before every provider attempt. Unlike `request`, an
   * error from this hook is propagated immediately and is not retried.
   */
  beforeAttempt?: () => void | Promise<void>;
  maxAttempts: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  onRetry?: (attempt: HttpRetryAttempt<T>) => void | Promise<void>;
  random?: () => number;
  request: () => T | Promise<T>;
  /**
   * Optional Finagle-style ratio-based retry budget. When provided, a retry
   * token is consumed before each retry (after a retryable response or a thrown
   * request error). If the budget is empty, the retry loop stops immediately
   * with `RetryExhaustedError` — the same terminal shape as exhausting
   * `maxAttempts` — so a run with many failing requests defers rather than
   * amplifying load. Absent → only `maxAttempts` bounds retries (unchanged).
   */
  retryBudget?: HttpRetryBudget;
  shouldAbort?: (response: T) => boolean;
  /**
   * Optional early-stop hook for retryable responses. Called after a response
   * is classified retryable but before sleeping/continuing. Returning `false`
   * stops the retry loop immediately and throws `RetryExhaustedError` with the
   * current response as the cause — the same terminal path as exhausting
   * `maxAttempts`, so callers see one exhaustion shape regardless of whether the
   * budget ran out or a connector-defined source-pressure signal opened early.
   *
   * Use this to fast-open on a whole-bucket signal (e.g. a bare 429 with no
   * `Retry-After`) instead of burning the full per-request budget against an
   * upstream that is throttling the entire account. The default keeps retrying
   * until `maxAttempts`.
   */
  shouldKeepRetrying?: (input: HttpRetryKeepRetryingInput<T>) => boolean;
  shouldRetry?: (response: T) => boolean;
  sleep?: (ms: number) => void | Promise<void>;
}

export class TerminalHttpStatusError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TerminalHttpStatusError";
    this.status = status;
  }
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly originalCause: unknown;

  constructor(message: string, attempts: number, cause: unknown) {
    super(message);
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.originalCause = cause;
  }
}

const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) {
    return null;
  }
  return Math.max(0, dateMs - nowMs);
}

export function retryAfterMsFromHeaders(
  headers: Record<string, string | undefined> | undefined,
  nowMs = Date.now()
): number | null {
  if (!headers) {
    return null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "retry-after") {
      return parseRetryAfterMs(value, nowMs);
    }
  }
  return null;
}

export function jitteredExponentialDelayMs({
  attempt,
  baseDelayMs,
  maxDelayMs,
  random = Math.random,
}: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
}): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitterMultiplier = 0.5 + random();
  return Math.max(0, Math.min(maxDelayMs, Math.round(exponential * jitterMultiplier)));
}

/**
 * Consume one retry-budget token if a budget is configured. Returns a
 * `RetryExhaustedError` to throw when the budget is empty, or null to proceed.
 * Extracted so the retry loop stays within the cognitive-complexity bar.
 */
function retryBudgetGate(
  retryBudget: HttpRetryBudget | undefined,
  attempt: number,
  cause: unknown,
  message: string
): RetryExhaustedError | null {
  if (retryBudget && !retryBudget.consume()) {
    return new RetryExhaustedError(message, attempt, cause);
  }
  return null;
}

/**
 * Decide what a thrown request error means: rethrow on exhausted attempts or an
 * empty retry budget, otherwise proceed to backoff. Extracted from the loop's
 * catch block to keep `retryHttp` within the complexity bar.
 */
function classifyThrownRequestError(
  error: unknown,
  attempt: number,
  maxAttempts: number,
  retryBudget: HttpRetryBudget | undefined
): RetryExhaustedError | null {
  if (attempt >= maxAttempts) {
    return new RetryExhaustedError("HTTP request failed after retry budget was exhausted", attempt, error);
  }
  return retryBudgetGate(retryBudget, attempt, error, "HTTP request failed; ratio-based retry budget is exhausted");
}

/**
 * Decide whether a retryable response terminates the loop (source-pressure
 * policy fast-open, exhausted attempts, or empty retry budget) or proceeds to a
 * backoff sleep. Returns the error to throw, or null to keep retrying. Extracted
 * to keep `retryHttp` within the complexity bar.
 */
function classifyRetryableResponse<T extends HttpRetryResponse>(input: {
  attempt: number;
  maxAttempts: number;
  response: T;
  retryAfterMs: number | null;
  retryBudget: HttpRetryBudget | undefined;
  shouldKeepRetrying: HttpRetryOptions<T>["shouldKeepRetrying"];
}): RetryExhaustedError | null {
  const { attempt, maxAttempts, response, retryAfterMs, retryBudget, shouldKeepRetrying } = input;
  if (shouldKeepRetrying && !shouldKeepRetrying({ attempt, maxAttempts, response, retryAfterMs })) {
    return new RetryExhaustedError(
      `HTTP request got retryable status ${response.status}; connector source-pressure policy stopped retrying`,
      attempt,
      response
    );
  }
  if (attempt >= maxAttempts) {
    return new RetryExhaustedError(
      `HTTP request got retryable status ${response.status} after retry budget was exhausted`,
      attempt,
      response
    );
  }
  return retryBudgetGate(
    retryBudget,
    attempt,
    response,
    `HTTP request got retryable status ${response.status}; ratio-based retry budget is exhausted`
  );
}

export async function retryHttp<T extends HttpRetryResponse>(options: HttpRetryOptions<T>): Promise<T> {
  const {
    baseDelayMs,
    beforeAttempt,
    maxAttempts,
    maxDelayMs,
    maxRetryAfterMs,
    onRetry,
    random = Math.random,
    request,
    retryBudget,
    shouldAbort = () => false,
    shouldKeepRetrying,
    shouldRetry = (response) =>
      response.status === 429 || response.status === 408 || (response.status >= 500 && response.status < 600),
    sleep = DEFAULT_SLEEP,
  } = options;

  let lastFailure: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await beforeAttempt?.();
    let response: T;
    try {
      response = await request();
    } catch (error) {
      lastFailure = error;
      const fatal = classifyThrownRequestError(error, attempt, maxAttempts, retryBudget);
      if (fatal) {
        throw fatal;
      }
      const delayMs = jitteredExponentialDelayMs({ attempt, baseDelayMs, maxDelayMs, random });
      await onRetry?.({ attempt, delayMs, error, maxAttempts });
      await sleep(delayMs);
      continue;
    }

    if (shouldAbort(response)) {
      throw new TerminalHttpStatusError(`HTTP request got terminal status ${response.status}`, response.status);
    }

    if (!shouldRetry(response)) {
      return response;
    }

    lastFailure = response;
    const retryAfterMs = retryAfterMsFromHeaders(response.headers);
    const fatal = classifyRetryableResponse({
      attempt,
      maxAttempts,
      response,
      retryAfterMs,
      retryBudget,
      shouldKeepRetrying,
    });
    if (fatal) {
      throw fatal;
    }

    const delayMs =
      retryAfterMs == null
        ? jitteredExponentialDelayMs({ attempt, baseDelayMs, maxDelayMs, random })
        : Math.min(maxRetryAfterMs, retryAfterMs);
    const retryAttempt: HttpRetryAttempt<T> = { attempt, delayMs, maxAttempts, response };
    if (retryAfterMs != null) {
      retryAttempt.retryAfterMs = retryAfterMs;
    }
    await onRetry?.(retryAttempt);
    await sleep(delayMs);
  }

  throw new RetryExhaustedError("HTTP request failed after retry budget was exhausted", maxAttempts, lastFailure);
}
