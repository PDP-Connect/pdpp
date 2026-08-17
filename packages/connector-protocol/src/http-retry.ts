// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { stripForbiddenControlChars } from "./safe-text-preview.ts";

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
  consume: () => boolean;
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

/**
 * Bound for the transport detail folded into a thrown-error exhaustion message.
 * The message reaches a terminal DB row, so a pathological cause chain must not
 * bloat it. The runtime applies its own 300-char bound downstream; this one keeps
 * any single link short enough that the outer bound does not truncate away the
 * status/endpoint the caller appended.
 */
const THROWN_CAUSE_DETAIL_MAX = 120;

// ─── Redaction of third-party transport text ────────────────────────────────
//
// A cause link is an arbitrary string authored by a transport we do not control
// (undici, Node's TLS/DNS layers, a browser fetch shim). Those layers routinely
// embed the request URL in the message — and a URL can carry userinfo, an
// `access_token` query parameter, or a signed-URL signature. Bounding the length
// does not make that safe: truncation is not redaction, and slicing mid-token
// can leave a usable credential prefix behind.
//
// So the invariant "no URL or header reaches terminal text" is ENFORCED here
// rather than asserted in a doc comment. Redaction runs BEFORE truncation, so a
// secret can never survive as a partial fragment of a cut string.
//
// The rules are deliberately blunt and over-broad: for a transport diagnostic,
// losing a URL costs nothing (the caller attaches its own redacted endpoint,
// and the fault CLASS lives in the code) while leaking one costs a credential.
// What must survive is the transport vocabulary the operator and the connector's
// `retryablePattern` both read — `ECONNRESET`, `ENOTFOUND`,
// `UND_ERR_HEADERS_TIMEOUT` — and none of these rules touch a bare token like
// that.

/** `scheme://…` up to the first whitespace, quote, or closing bracket. Covers
 *  userinfo, query strings, and signed-URL signatures in one bite. */
const ABSOLUTE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]}]+/gi;
/** `Authorization: <scheme> <token>` — the scheme AND its token, since a rule
 *  that stopped at the first space would redact the word "Bearer" and leave the
 *  credential itself in the clear. Also bare `Bearer <token>` with no header. */
const AUTH_HEADER = /\bauthorization\s*[:=]\s*(?:[a-z]+\s+)?[^\s,;)\]}]+/gi;
const AUTH_SCHEME = /\b(?:bearer|basic|digest)\s+[^\s,;)\]}]+/gi;
/** `key=value` / `key: value` for secret-bearing key names, quoted or not. */
const SECRET_KEY_VALUE =
  /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|token|password|passwd|pwd|secret|cookie|set-cookie|session|auth)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&)]+)/gi;
const EMAIL_ADDRESS = /\b[^\s@,;:<>()[\]]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
/** Any run of whitespace (incl. the \t\n\r that control-stripping keeps) → one
 *  space, so a multi-line transport dump stays one legible DB row. */
const WHITESPACE_RUN = /\s+/g;

/**
 * Redact credential-bearing and identifying text out of one third-party cause
 * link. Applied to every link before it is bounded or joined.
 *
 * Order is load-bearing: URL first (so a token inside a URL is removed with the
 * whole URL rather than half-matched by a later rule), then explicit auth
 * headers/schemes, then loose `key=value` secrets, then emails. Control
 * characters go through the shared `stripForbiddenControlChars` primitive — this
 * module does not author a second control-char policy.
 */
export function redactTransportDetail(text: string): string {
  return stripForbiddenControlChars(text)
    .replace(ABSOLUTE_URL, "[redacted-url]")
    .replace(AUTH_HEADER, "[redacted-authorization]")
    .replace(AUTH_SCHEME, "[redacted-authorization]")
    .replace(SECRET_KEY_VALUE, "[redacted-secret]")
    .replace(EMAIL_ADDRESS, "[redacted-email]")
    .replace(WHITESPACE_RUN, " ")
    .trim();
}

/**
 * Describe a THROWN transport failure well enough to act on it.
 *
 * `fetch` reports every transport fault — DNS, TLS, reset socket, undici's
 * header/body timeouts — as the same contentless `TypeError: fetch failed`, and
 * puts the real fault on `.cause` (an `Error` with a `code` such as
 * `ECONNRESET`, `ENOTFOUND`, `UND_ERR_HEADERS_TIMEOUT`). Reporting only the
 * outer message makes a transient reset and a permanent DNS failure — which need
 * opposite operator responses — indistinguishable in `connector_error_json`.
 *
 * This is also load-bearing for RETRY CLASSIFICATION, not just legibility:
 * connectors declare a `retryablePattern` matching the transport vocabulary
 * (`/ECONN|ETIMEDOUT|fetch failed/i`). The runtime tests that pattern against the
 * terminal MESSAGE, so a message that drops the cause cannot match its own
 * connector's pattern, and a retryable blip terminals the run as permanent.
 *
 * Walks the `.cause` chain (bounded) because undici nests one level deep and a
 * future transport may nest further. Every link — including the outer message,
 * which is equally third-party text — is passed through
 * {@link redactTransportDetail} BEFORE it is bounded, so a URL, credential, or
 * email cannot reach terminal text either whole or as a truncated fragment. The
 * caller owns attaching its own redacted endpoint.
 */
export function describeThrownTransportError(error: unknown): string {
  if (!(error instanceof Error)) {
    return redactTransportDetail(String(error));
  }
  const parts: string[] = [redactTransportDetail(error.message)];
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 3 && cause instanceof Error; depth += 1) {
    const { code, message: causeMessage } = cause as Error & { code?: unknown };
    // Redact first, bound second: a mid-token slice of a secret is still a leak.
    const body = redactTransportDetail(causeMessage);
    const bounded = body.length > THROWN_CAUSE_DETAIL_MAX ? `${body.slice(0, THROWN_CAUSE_DETAIL_MAX)}…` : body;
    // The `code` is appended AFTER bounding and is never truncated: it is the
    // highest-value part of the link (it classifies the fault and is what the
    // connector's retryablePattern matches), so a long redacted message must not
    // be able to push it out of the string. Codes are short, fixed transport
    // constants (`ECONNRESET`, `UND_ERR_HEADERS_TIMEOUT`), never owner data.
    const codeSuffix = typeof code === "string" && code.length > 0 && !bounded.includes(code) ? ` (${code})` : "";
    const link = `${bounded}${codeSuffix}`.trim();
    if (link && !parts.includes(link)) {
      parts.push(link);
    }
    ({ cause } = cause);
  }
  return parts.filter((part) => part.length > 0).join(": ");
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
  // Fold the transport fault into the message. `originalCause` already carried
  // it, but nothing downstream reads that field, so the owner saw only the
  // generic sentence and the connector's retryablePattern could not match its
  // own transport vocabulary. See `describeThrownTransportError`.
  const detail = describeThrownTransportError(error);
  if (attempt >= maxAttempts) {
    return new RetryExhaustedError(`HTTP request failed after retry budget was exhausted: ${detail}`, attempt, error);
  }
  return retryBudgetGate(
    retryBudget,
    attempt,
    error,
    `HTTP request failed; ratio-based retry budget is exhausted: ${detail}`
  );
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
      const delayMs = jitteredExponentialDelayMs({
        attempt,
        baseDelayMs,
        maxDelayMs,
        random,
      });
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
      retryAfterMs === null
        ? jitteredExponentialDelayMs({
            attempt,
            baseDelayMs,
            maxDelayMs,
            random,
          })
        : Math.min(maxRetryAfterMs, retryAfterMs);
    const retryAttempt: HttpRetryAttempt<T> = {
      attempt,
      delayMs,
      maxAttempts,
      response,
    };
    if (retryAfterMs !== null) {
      retryAttempt.retryAfterMs = retryAfterMs;
    }
    await onRetry?.(retryAttempt);
    await sleep(delayMs);
  }

  // Loop fell through with retries left unspent (only reachable when the last
  // attempt slept rather than returned). `lastFailure` is a thrown error or a
  // retryable response; only the former carries transport detail worth folding.
  const trailingDetail = lastFailure instanceof Error ? `: ${describeThrownTransportError(lastFailure)}` : "";
  throw new RetryExhaustedError(
    `HTTP request failed after retry budget was exhausted${trailingDetail}`,
    maxAttempts,
    lastFailure
  );
}
