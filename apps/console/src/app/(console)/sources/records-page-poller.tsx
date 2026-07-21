// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { markRecordsReadFresh } from "./last-known-read.ts";
import { recordsPollIntervalMs } from "./records-poll-interval.ts";

/**
 * Always-on poller for the records dashboard. The route is `force-dynamic` +
 * `no-store`, so every soft `router.refresh()` re-render is as live as the API;
 * the only question is cadence (see `records-poll-interval.ts`):
 *
 * - `running=true`  → fast cadence (watch an active run land in near-real-time).
 * - `running=false` → slow idle heartbeat so a quiet page still reconciles with
 *   the live API instead of freezing until a manual reload. This covers state
 *   that changes with no active scheduler run — background health
 *   re-derivation, version-stats projection rebuilds, and push-mode
 *   local-device ingest (which by construction never has an active run).
 *
 * Intentional load tradeoff: this mounts unconditionally, so an idle dashboard
 * tab issues one soft refresh every idle interval. That is the deliberate price
 * of a self-reconciling quiet page — a soft refresh of a single `no-store`
 * route is cheap and React reconciles unchanged DOM with no visible flash.
 */
export function RecordsPagePoller({ running }: { running: boolean }) {
  const router = useRouter();

  // This component is part of the records server tree, so a mount (and every
  // re-render after a clean `router.refresh()`) is itself proof the data read
  // succeeded. Stamp the last-known-good time so the segment error boundary can
  // honestly tell the owner *when* the data it keeps showing was last live,
  // without itself reading any server-only module. See `last-known-read.ts`.
  useEffect(() => {
    markRecordsReadFresh();
  });

  useEffect(() => {
    // Re-armed whenever `running` flips: the cleanup clears the prior interval
    // before a new one starts, so a running→idle (or idle→running) transition
    // can never leak or double-stack timers.
    const id = setInterval(() => {
      // A soft revalidation must degrade gracefully: a synchronous throw from
      // `router.refresh()` should never escape the timer and become an
      // unhandled error. The re-render itself is what surfaces a transient read
      // failure to the boundary; this guard only protects the scheduling call.
      try {
        router.refresh();
      } catch {
        // Transient — the next tick retries; the boundary (if a render does
        // fail) shows last-known status rather than blanking the page.
      }
    }, recordsPollIntervalMs(running));
    return () => clearInterval(id);
  }, [running, router]);

  return null;
}
