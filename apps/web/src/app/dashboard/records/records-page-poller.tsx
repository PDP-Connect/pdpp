'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

const RUNNING_POLL_MS = 3_000;

export function RecordsPagePoller({ enabled }: { enabled: boolean }) {
  const router = useRouter();

  React.useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => router.refresh(), RUNNING_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, router]);

  return null;
}
