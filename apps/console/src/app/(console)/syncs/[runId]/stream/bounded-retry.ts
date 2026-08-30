// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded retry policy — ONE primitive for every client retry loop on the
 * stream page.
 *
 * Why this exists (P1, 2026-08-29): the resolution poll in `stream-viewer.tsx`
 * was a bare `setInterval(() => router.refresh(), 2500)` with no cap, no
 * backoff, and no terminal guard. Each `router.refresh()` re-runs the whole
 * server page loader, so a dead/reaped session — where the resolved state never
 * arrives — hammered the server forever and froze the owner's machine. The
 * EventSource path next door was already disciplined (exponential backoff,
 * hard attempt cap); the poll simply never got the same treatment.
 *
 * The fix is deliberately a shared primitive rather than a second hand-rolled
 * backoff. Three duplicated skip-lists caused a separate bug in this codebase
 * on the same day; a fourth copy of "retry, but carefully" would be the same
 * mistake. Any future retry site that routes through `nextRetryDecision` is
 * bounded by construction — a site that forgets to add its own cap is the
 * failure mode this primitive removes.
 *
 * Two independent stop conditions, both of which must be honored:
 *
 *   1. TERMINAL — the state machine has reached an absorbing state
 *      (`resolved` / `reaped`). Terminal beats everything: no attempt is ever
 *      scheduled from a terminal state, regardless of remaining budget. This
 *      is the owner's acceptance criterion ("zero further network attempts").
 *   2. EXHAUSTED — the attempt budget ran out. A hard stop, not a slow poll:
 *      after `maxAttempts` the caller must stop and show a calm terminal
 *      message rather than degrade to a low-frequency hammer.
 *
 * The module is intentionally pure and free of React/DOM/timer imports so the
 * lifecycle is directly testable by counting decisions rather than by asserting
 * a flag flipped.
 */

/**
 * Lifecycle of a stream-page retry loop.
 *
 * `resolved` and `reaped` are ABSORBING: once entered, no transition leaves
 * them and no attempt is ever scheduled again. They are distinct because the
 * owner-facing copy differs (a resolved assist succeeded; a reaped surface was
 * torn down server-side while collection continues elsewhere), but they are
 * identical with respect to transport shutdown.
 */
export type RetryLifecycle = "active" | "exhausted" | "reaped" | "resolved";

export interface BoundedRetryPolicy {
  /** Backoff ladder in ms. The last entry is the sustained ceiling. */
  readonly backoffMs: readonly number[];
  /** Hard cap on attempts. Reaching it is a full stop, not a slower poll. */
  readonly maxAttempts: number;
}

export interface BoundedRetryState {
  /** Attempts already made. Never exceeds `policy.maxAttempts`. */
  readonly attempts: number;
  readonly lifecycle: RetryLifecycle;
}

/**
 * A retry decision. `shouldRetry: false` carries the reason so a caller can
 * distinguish "we succeeded, stand down" from "we gave up" in its copy without
 * re-deriving the lifecycle.
 */
export type RetryDecision =
  | { readonly delayMs: number; readonly shouldRetry: true }
  | { readonly reason: "exhausted" | "reaped" | "resolved"; readonly shouldRetry: false };

/**
 * Resolution poll policy. The cadence still opens at 2.5s so a normal assist
 * resolves as promptly as it always did — the change is that the interval now
 * decays and STOPS. The ladder reaches its 20s ceiling after ~1 minute and the
 * 12-attempt budget spans a little over three minutes of wall clock, which is
 * far beyond the time a live controller needs to publish a resolution, and far
 * short of "forever".
 */
export const RESOLUTION_POLL_POLICY: BoundedRetryPolicy = {
  backoffMs: [2500, 2500, 5000, 5000, 10_000, 20_000],
  maxAttempts: 12,
};

/** Terminal states are absorbing: nothing schedules work from them. */
export function isTerminalLifecycle(lifecycle: RetryLifecycle): boolean {
  return lifecycle === "resolved" || lifecycle === "reaped" || lifecycle === "exhausted";
}

export function createBoundedRetryState(): BoundedRetryState {
  return { attempts: 0, lifecycle: "active" };
}

/**
 * Decide whether the caller may make another attempt.
 *
 * Order matters and is load-bearing: the terminal check runs BEFORE the budget
 * check, so a resolved/reaped loop reports its own reason rather than the
 * generic "exhausted", and — more importantly — a terminal state can never be
 * talked into an attempt by having budget left.
 */
export function nextRetryDecision(state: BoundedRetryState, policy: BoundedRetryPolicy): RetryDecision {
  if (state.lifecycle === "resolved" || state.lifecycle === "reaped") {
    return { reason: state.lifecycle, shouldRetry: false };
  }
  if (state.lifecycle === "exhausted" || state.attempts >= policy.maxAttempts) {
    return { reason: "exhausted", shouldRetry: false };
  }
  const ladder = policy.backoffMs;
  const delayMs = ladder[Math.min(state.attempts, ladder.length - 1)] ?? ladder.at(-1) ?? 0;
  return { delayMs, shouldRetry: true };
}

/**
 * Record that an attempt was made. Transitions to `exhausted` at the cap so
 * the stop is a state, not merely a comparison the next caller must repeat.
 *
 * A terminal state absorbs the call unchanged — a late timer that fires after
 * resolution cannot resurrect the loop or inflate the attempt count.
 */
export function recordRetryAttempt(state: BoundedRetryState, policy: BoundedRetryPolicy): BoundedRetryState {
  if (isTerminalLifecycle(state.lifecycle)) {
    return state;
  }
  const attempts = state.attempts + 1;
  return { attempts, lifecycle: attempts >= policy.maxAttempts ? "exhausted" : "active" };
}

/**
 * Enter an absorbing terminal state. Idempotent, and never downgrades: once
 * `resolved`/`reaped`, a later `exhausted` cannot overwrite the more specific
 * (and more reassuring) outcome the owner is looking at.
 */
export function enterTerminalLifecycle(
  state: BoundedRetryState,
  lifecycle: Extract<RetryLifecycle, "reaped" | "resolved">
): BoundedRetryState {
  if (state.lifecycle === "resolved" || state.lifecycle === "reaped") {
    return state;
  }
  return { attempts: state.attempts, lifecycle };
}

/**
 * Owner-facing copy for a stopped loop. Deliberately calm and free of protocol
 * vocabulary: the owner's machine froze once already, and the message they get
 * afterwards should tell them the work continues without them.
 */
export function terminalRetryMessage(reason: "exhausted" | "reaped" | "resolved"): string {
  if (reason === "resolved") {
    return "Collection is continuing — you can close this page.";
  }
  if (reason === "reaped") {
    return "This browser session has ended. Collection is continuing — you can close this page.";
  }
  return "Stopped checking for updates. Collection is continuing — you can close this page.";
}
