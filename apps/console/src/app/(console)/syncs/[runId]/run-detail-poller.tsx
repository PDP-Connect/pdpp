"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const RUN_DETAIL_POLL_MS = 3000;

export function RunDetailPoller({ enabled }: { enabled: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const id = setInterval(() => router.refresh(), RUN_DETAIL_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, router]);

  return null;
}
