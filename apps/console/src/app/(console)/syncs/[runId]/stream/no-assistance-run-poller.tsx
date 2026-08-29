"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { SpineEvent } from "../../../lib/ref-client.ts";
import { getCurrentBrowserSurfaceAssistance } from "../../../lib/run-assistance.ts";
import {
  type BoundedRetryPolicy,
  createBoundedRetryState,
  nextRetryDecision,
  recordRetryAttempt,
} from "./bounded-retry.ts";

/**
 * Both loops below were bare `setInterval`s with no cap and no backoff — the
 * same defect class that froze the owner's machine from `stream-viewer.tsx`,
 * and worse here because this component runs TWO of them (a page refresh and a
 * timeline fetch). A run that never raises assistance kept both firing
 * forever. They now share the page's bounded-retry primitive.
 *
 * The budgets are larger than the resolution poll's because this poller
 * legitimately waits out long automatic collection with no owner present, but
 * they are budgets: they end.
 */
const NO_ASSISTANCE_REFRESH_POLICY: BoundedRetryPolicy = {
  backoffMs: [3000, 3000, 6000, 12_000, 30_000],
  maxAttempts: 40,
};
const ASSISTANCE_CHECK_POLICY: BoundedRetryPolicy = {
  backoffMs: [1500, 1500, 3000, 6000, 15_000],
  maxAttempts: 60,
};

function timelineEventsFrom(body: unknown): SpineEvent[] {
  const candidate = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const events = (candidate as { data?: unknown; events?: unknown }).data ?? (candidate as { events?: unknown }).events;
  return Array.isArray(events) ? (events as SpineEvent[]) : [];
}

async function browserSurfaceAssistanceIsReady(runId: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(`/_ref/runs/${encodeURIComponent(runId)}/timeline`, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) {
    return false;
  }
  const body = await response.json().catch(() => null);
  return getCurrentBrowserSurfaceAssistance(timelineEventsFrom(body)) !== null;
}

export function NoAssistanceRunPoller({ runId }: { runId: string }) {
  const router = useRouter();

  useEffect(() => {
    let state = createBoundedRetryState();
    let timer: number | null = null;
    let cancelled = false;

    function scheduleNext(): void {
      if (cancelled) {
        return;
      }
      const decision = nextRetryDecision(state, NO_ASSISTANCE_REFRESH_POLICY);
      if (!decision.shouldRetry) {
        return; // Budget spent — stop refreshing rather than hammer forever.
      }
      timer = window.setTimeout(() => {
        timer = null;
        if (cancelled) {
          return;
        }
        state = recordRetryAttempt(state, NO_ASSISTANCE_REFRESH_POLICY);
        router.refresh();
        scheduleNext();
      }, decision.delayMs);
    }

    scheduleNext();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
  }, [router]);

  useEffect(() => {
    const abort = new AbortController();
    let state = createBoundedRetryState();
    let timer: number | null = null;
    let cancelled = false;

    async function checkForBrowserAssistance() {
      try {
        if (await browserSurfaceAssistanceIsReady(runId, abort.signal)) {
          cancelled = true; // Assistance arrived: this loop is done for good.
          window.location.reload();
        }
      } catch {
        // The bounded router refresh above still keeps the page moving if this
        // owner-side probe loses a race with navigation or a transient read.
      }
    }

    function scheduleNext(): void {
      if (cancelled) {
        return;
      }
      const decision = nextRetryDecision(state, ASSISTANCE_CHECK_POLICY);
      if (!decision.shouldRetry) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        if (cancelled) {
          return;
        }
        state = recordRetryAttempt(state, ASSISTANCE_CHECK_POLICY);
        // Self-rescheduling AFTER the probe settles replaces the old
        // `inFlight` guard: a slow probe can no longer overlap itself.
        checkForBrowserAssistance()
          .catch(() => undefined)
          .finally(scheduleNext);
      }, decision.delayMs);
    }

    checkForBrowserAssistance()
      .catch(() => undefined)
      .finally(scheduleNext);
    return () => {
      cancelled = true;
      abort.abort();
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
  }, [runId]);

  return null;
}
