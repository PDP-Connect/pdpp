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

export interface HttpRetryOptions<T extends HttpRetryResponse> {
  baseDelayMs: number;
  maxAttempts: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  onRetry?: (attempt: HttpRetryAttempt<T>) => void | Promise<void>;
  random?: () => number;
  request: () => T | Promise<T>;
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

export async function retryHttp<T extends HttpRetryResponse>(options: HttpRetryOptions<T>): Promise<T> {
  const {
    baseDelayMs,
    maxAttempts,
    maxDelayMs,
    maxRetryAfterMs,
    onRetry,
    random = Math.random,
    request,
    shouldAbort = () => false,
    shouldKeepRetrying,
    shouldRetry = (response) =>
      response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504,
    sleep = DEFAULT_SLEEP,
  } = options;

  let lastFailure: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: T;
    try {
      response = await request();
    } catch (error) {
      lastFailure = error;
      if (attempt >= maxAttempts) {
        throw new RetryExhaustedError("HTTP request failed after retry budget was exhausted", attempt, error);
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
    if (shouldKeepRetrying && !shouldKeepRetrying({ attempt, maxAttempts, response, retryAfterMs })) {
      throw new RetryExhaustedError(
        `HTTP request got retryable status ${response.status}; connector source-pressure policy stopped retrying`,
        attempt,
        response
      );
    }
    if (attempt >= maxAttempts) {
      throw new RetryExhaustedError(
        `HTTP request got retryable status ${response.status} after retry budget was exhausted`,
        attempt,
        response
      );
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
