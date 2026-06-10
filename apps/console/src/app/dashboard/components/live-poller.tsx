"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Shared refresh-poller for dashboard server components. When `enabled`,
 * calls `router.refresh()` on an interval so server-rendered state
 * (running runs, latest progress, pending interactions) updates without
 * a manual reload. The interval clears automatically when the poller is
 * disabled or unmounted.
 *
 * Callers set `enabled` from rendered state (e.g. any run is non-terminal
 * or has a pending interaction). Passing `enabled=false` makes the
 * component a no-op so it can be rendered unconditionally.
 */
export function LivePoller({ enabled, intervalMs = 3000 }: { enabled: boolean; intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, router]);

  return null;
}
