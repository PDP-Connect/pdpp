"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const ACTIVE_POLL_MS = 3000;

export function SchedulesPoller({ enabled }: { enabled: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const id = setInterval(() => router.refresh(), ACTIVE_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, router]);

  return null;
}
