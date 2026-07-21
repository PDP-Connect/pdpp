// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { SpineEvent } from "../../../lib/ref-client.ts";
import { getCurrentBrowserSurfaceAssistance } from "../../../lib/run-assistance.ts";

const NO_ASSISTANCE_REFRESH_MS = 3000;
const ASSISTANCE_CHECK_MS = 1500;

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
    const timer = window.setInterval(() => {
      router.refresh();
    }, NO_ASSISTANCE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  useEffect(() => {
    const abort = new AbortController();
    let inFlight = false;

    async function checkForBrowserAssistance() {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        if (await browserSurfaceAssistanceIsReady(runId, abort.signal)) {
          window.location.reload();
        }
      } catch {
        // The generic router refresh above still keeps the page moving if this
        // owner-side probe loses a race with navigation or a transient read.
      } finally {
        inFlight = false;
      }
    }

    checkForBrowserAssistance().catch(() => undefined);
    const timer = window.setInterval(() => {
      checkForBrowserAssistance().catch(() => undefined);
    }, ASSISTANCE_CHECK_MS);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [runId]);

  return null;
}
