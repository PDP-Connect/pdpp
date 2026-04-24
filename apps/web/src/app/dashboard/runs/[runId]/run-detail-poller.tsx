'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

const RUN_DETAIL_POLL_MS = 3_000;

export function RunDetailPoller({ enabled }: { enabled: boolean }) {
  const router = useRouter();

  React.useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => router.refresh(), RUN_DETAIL_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, router]);

  return null;
}
