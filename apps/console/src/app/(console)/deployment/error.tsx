"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { createRetryCounter, nextRetryDelayMs } from "../components/read-resilient-retry.ts";
import { DetailLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Deployment-segment error boundary (App Router convention) — SLVP bar:
 * Stripe, Linear, Vercel, and Plaid never tell an owner "we hit a transient
 * read interruption, retrying." The page renders, or it quietly shows
 * last-known state. The owner never learns the backend hiccuped.
 *
 * Root cause of the throw this boundary catches (`Error: The destination
 * stream closed early`): the read itself is fine — React's Flight/RSC
 * streaming writer reacting to the HTTP response closing before the stream
 * finished flushing. It is a client-transport race below the data layer, not
 * a backend outage — see `sources/error.tsx` for the full original writeup.
 *
 * `/deployment` has no client-cached last-known-read marker, so this
 * boundary shows the plain skeleton with no staleness caption rather than
 * fabricate a timestamp. It reuses `DetailLoadingSkeleton`, matching
 * `deployment/loading.tsx` (a detail surface, not a list).
 *
 * Self-contained on purpose: a `"use client"` boundary must not import
 * server-only modules, since the dashboard shell transitively pulls in
 * `lib/owner-token.ts` (`server-only`).
 */

/**
 * Consecutive-failure counter, held at MODULE scope rather than component
 * state — see `read-resilient-retry.ts` for why a `useState` counter would
 * silently reset every catch and never actually back off.
 */
const retryCounter = createRetryCounter();

export default function DeploymentError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Logged for operator diagnostics only — never surfaced to the owner.
    console.error(error);
  }, [error]);

  useEffect(() => {
    // Unbounded, capped backoff: every mount (i.e. every failed attempt)
    // schedules the next retry at a delay that grows with the module-scoped
    // counter. There is deliberately no ceiling on the counter itself — a
    // persistent failure degrades to a slow quiet heartbeat, never a dead end.
    const delay = nextRetryDelayMs(retryCounter.attempts);
    const id = setTimeout(() => {
      retryCounter.attempts += 1;
      reset();
    }, delay);
    return () => clearTimeout(id);
  }, [reset]);

  return (
    <div data-testid="deployment-read-recovering">
      <DetailLoadingSkeleton label="deployment status" />
    </div>
  );
}
