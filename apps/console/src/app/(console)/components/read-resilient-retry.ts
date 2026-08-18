// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared unbounded-capped-backoff retry primitive for segment error
 * boundaries (App Router `error.tsx` convention).
 *
 * SLVP bar (Stripe, Linear, Vercel, Plaid): none of those products tell a
 * user "couldn't load X" with a Try again button because a stream hiccuped.
 * When a segment's server read throws `Error: The destination stream closed
 * early` — React's RSC streaming writer reacting to the HTTP response closing
 * while the Flight stream was still being written, not a failed data read —
 * the boundary must retry quietly and indefinitely rather than parking on a
 * failure card. See `sources/error.tsx` for the fully-annotated original of
 * this pattern; this module factors ONLY the backoff arithmetic, which is
 * byte-identical across every segment that adopts it. Each segment's own
 * skeleton and copy stay in that segment's `error.tsx` — factoring those out
 * too would hide the per-route visual contract behind a generic wrapper.
 *
 * The retry counter MUST live at module scope, never in React state: Next.js
 * remounts the error boundary fresh on every catch (a new error instance
 * re-enters the boundary), so a `useState` counter would silently reset to 0
 * on every failure and the backoff would never grow past its base delay. A
 * `RetryCounter` created by `createRetryCounter()` at each `error.tsx`
 * module's top level (NOT inside this shared module, and NOT shared between
 * routes) gives each segment boundary its own independent counter with
 * exactly the right lifetime: "how many times has this boundary caught in a
 * row since the page was last freshly loaded."
 */

/** First retry is near-immediate — long enough to dodge a tight synchronous loop. */
export const RETRY_BASE_DELAY_MS = 300;
/** Backoff ceiling: keep retrying at a calm, bounded cadence forever rather than escalating without limit. */
export const RETRY_MAX_DELAY_MS = 15_000;

/**
 * A single segment boundary's consecutive-failure counter. Create exactly one
 * of these per `error.tsx` module (at module scope, not inside the component)
 * and reuse it across every catch that module handles.
 */
export type RetryCounter = { attempts: number };

/** Create a fresh, independent module-scoped retry counter for one segment boundary. */
export function createRetryCounter(): RetryCounter {
  return { attempts: 0 };
}

/** Capped exponential backoff. Never returns a delay the owner would perceive as "given up". */
export function nextRetryDelayMs(attempt: number): number {
  const scaled = RETRY_BASE_DELAY_MS * 2 ** attempt;
  return Math.min(scaled, RETRY_MAX_DELAY_MS);
}
