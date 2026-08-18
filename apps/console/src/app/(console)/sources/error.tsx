"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";
import { readLastRecordsReadAt } from "./last-known-read.ts";

/**
 * Sources-segment error boundary (App Router convention) — SLVP bar: Stripe,
 * Linear, Vercel, and Plaid never tell an owner "we hit a transient read
 * interruption, retrying." The page renders, or it quietly shows last-known
 * state. The owner never learns the backend hiccuped.
 *
 * Root cause of the throw this boundary catches (`Error: The destination
 * stream closed early`, digest-stamped by Next): the read itself is fine. The
 * `/_ref/connectors` read this page depends on returns 200 in ~1.2s — the read
 * already succeeded. The throw is React's Flight/RSC streaming writer
 * (`react-server-dom-webpack-server`) reacting to the destination (the HTTP
 * response) closing before the stream finished flushing — e.g. a poll tick
 * from `records-page-poller.tsx` firing `router.refresh()` while a prior
 * refresh's stream is still in flight, or the tab backgrounding/throttling the
 * connection mid-render. It is a client-transport race below the data layer,
 * not a backend outage, so there is no "fix the read" available here — the
 * fetch already succeeded by the time this fires.
 *
 * Given that, this boundary NEVER renders owner-facing failure copy, at any
 * stage. It:
 *   - retries immediately and then on a capped exponential backoff,
 *     UNBOUNDED — there is no terminal "give up and show a Retry button"
 *     state, because a manual-retry dead end is itself the thing the owner
 *     complained about (parked on an error for an hour);
 *   - while retrying, renders the exact same skeleton `loading.tsx` uses, so
 *     a transient stream-teardown is visually indistinguishable from a normal
 *     page load — never a warning-colored card, never the words "error",
 *     "interruption", "retrying", "couldn't", or "failed";
 *   - once a last-good render has happened at least once, adds ONLY a quiet,
 *     dimmed "Updated Xs/Xm ago" caption under the skeleton — honest staleness
 *     signal, framed exactly like a normal freshness note elsewhere in the
 *     product, never framed as a failure.
 *
 * Self-contained on purpose (mirrors `dashboard/error.tsx`): a `"use client"`
 * boundary must not import server-only modules, since the dashboard shell
 * transitively pulls in `lib/owner-token.ts` (`server-only`). The last-known
 * timestamp therefore comes from a client-cached marker (`last-known-read.ts`),
 * never a server read inside the boundary. See
 * https://nextjs.org/docs/app/getting-started/error-handling.
 */

/** First retry is near-immediate — long enough to dodge a tight synchronous loop. */
const RETRY_BASE_DELAY_MS = 300;
/** Backoff ceiling: keep retrying at a calm, bounded cadence forever rather than escalating without limit. */
const RETRY_MAX_DELAY_MS = 15_000;

/**
 * Consecutive-failure counter, held at MODULE scope rather than component
 * state. React remounts this component fresh every time `reset()` triggers
 * another catch (a new error instance re-enters the boundary), so a
 * `useState` counter would silently reset to 0 on every failure and the
 * backoff would never actually grow past its base delay. A page navigation /
 * hard reload naturally resets this module's state, which is the right
 * lifetime: "how many times has this boundary caught in a row since the page
 * was last freshly loaded."
 */
let consecutiveAttempts = 0;

/** Capped exponential backoff. Never returns a delay the owner would perceive as "given up". */
function nextRetryDelayMs(attempt: number): number {
  const scaled = RETRY_BASE_DELAY_MS * 2 ** attempt;
  return Math.min(scaled, RETRY_MAX_DELAY_MS);
}

/** Quiet, second/minute-granularity "how long ago" — no day-scale rounding, this page polls every few seconds. */
function formatUpdatedAgo(at: number | null, nowMs: number): string | null {
  if (at === null) {
    return null;
  }
  const deltaMs = nowMs - at;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return null;
  }
  if (deltaMs < 5000) {
    return "Updated just now";
  }
  if (deltaMs < 60_000) {
    return `Updated ${Math.round(deltaMs / 1000)}s ago`;
  }
  const minutes = Math.round(deltaMs / 60_000);
  return `Updated ${minutes}m ago`;
}

export default function SourcesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [lastKnownAt, setLastKnownAt] = useState<number | null>(null);
  const [updatedAgoLabel, setUpdatedAgoLabel] = useState<string | null>(null);

  useEffect(() => {
    // Logged for operator diagnostics only — never surfaced to the owner.
    console.error(error);
    setLastKnownAt(readLastRecordsReadAt());
  }, [error]);

  useEffect(() => {
    // Unbounded, capped backoff: every mount (i.e. every failed attempt)
    // schedules the next retry at a delay that grows with the module-scoped
    // `consecutiveAttempts` counter. There is deliberately no ceiling on the
    // counter itself — a persistent failure degrades to a slow quiet
    // heartbeat, never to a dead end.
    const delay = nextRetryDelayMs(consecutiveAttempts);
    const id = setTimeout(() => {
      consecutiveAttempts += 1;
      reset();
    }, delay);
    return () => clearTimeout(id);
  }, [reset]);

  useEffect(() => {
    // Recompute the relative-time caption independently of the retry timer so
    // it stays live (e.g. "Updated 3s ago" ticking up) even between retries.
    if (lastKnownAt === null) {
      return;
    }
    const tick = () => setUpdatedAgoLabel(formatUpdatedAgo(lastKnownAt, Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastKnownAt]);

  return (
    <div data-testid="sources-read-recovering">
      <ListLoadingSkeleton label="Sources" rows={6} />
      {updatedAgoLabel ? (
        <p aria-live="polite" className="pdpp-caption mt-2 text-muted-foreground/60" role="status">
          {updatedAgoLabel}
        </p>
      ) : null}
    </div>
  );
}
