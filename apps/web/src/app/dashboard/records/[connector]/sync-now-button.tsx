'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { runConnectorNowAction, type RunNowResult } from '../actions';

const RUNNING_POLL_MS = 3_000;

type Props = {
  connectorId: string;
  displayName: string;
  initialRunning: boolean;
};

export function SyncNowButton({ connectorId, displayName, initialRunning }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [optimisticRunning, setOptimisticRunning] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  const [toastTone, setToastTone] = React.useState<'info' | 'error'>('info');
  const running = initialRunning || optimisticRunning;

  // Poll while running so the detail page auto-updates when the run
  // terminates — matches the index row's behavior.
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => router.refresh(), RUNNING_POLL_MS);
    return () => clearInterval(id);
  }, [running, router]);

  React.useEffect(() => {
    if (optimisticRunning && initialRunning) setOptimisticRunning(false);
  }, [initialRunning, optimisticRunning]);

  React.useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5_000);
    return () => clearTimeout(id);
  }, [toast]);

  const handleClick = React.useCallback(() => {
    setToast(null);
    setOptimisticRunning(true);
    startTransition(async () => {
      const res: RunNowResult = await runConnectorNowAction(connectorId);
      if (res.ok === true) {
        router.refresh();
        return;
      }
      setOptimisticRunning(false);
      if (res.reason === 'already_running') {
        setToastTone('info');
        setToast('A sync is already in progress.');
        router.refresh();
        return;
      }
      setToastTone('error');
      setToast(res.message);
    });
  }, [connectorId, router]);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        onClick={handleClick}
        disabled={running || isPending}
        aria-label={running ? `Sync in progress for ${displayName}` : `Sync ${displayName} now`}
      >
        {running ? 'Syncing…' : 'Sync now'}
      </Button>
      {toast ? (
        <span
          role="status"
          aria-live="polite"
          className={
            toastTone === 'error'
              ? 'pdpp-caption text-destructive'
              : 'pdpp-caption text-muted-foreground'
          }
        >
          {toast}
        </span>
      ) : null}
    </div>
  );
}
