"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button.tsx";
import { type RunNowResult, runConnectorNowAction } from "../actions.ts";

const RUNNING_POLL_MS = 3000;

interface Props {
  connectorId: string;
  displayName: string;
  initialRunning: boolean;
}

export function SyncNowButton({ connectorId, displayName, initialRunning }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [optimisticRunning, setOptimisticRunning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastTone, setToastTone] = useState<"info" | "error">("info");
  const running = initialRunning || optimisticRunning;

  // Poll while running so the detail page auto-updates when the run
  // terminates — matches the index row's behavior.
  useEffect(() => {
    if (!running) {
      return;
    }
    const id = setInterval(() => router.refresh(), RUNNING_POLL_MS);
    return () => clearInterval(id);
  }, [running, router]);

  useEffect(() => {
    if (optimisticRunning && initialRunning) {
      setOptimisticRunning(false);
    }
  }, [initialRunning, optimisticRunning]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const handleClick = useCallback(() => {
    setToast(null);
    setOptimisticRunning(true);
    startTransition(async () => {
      const res: RunNowResult = await runConnectorNowAction(connectorId);
      if (res.ok === true) {
        router.refresh();
        return;
      }
      setOptimisticRunning(false);
      if (res.reason === "already_running") {
        setToastTone("info");
        setToast("A sync is already in progress.");
        router.refresh();
        return;
      }
      setToastTone("error");
      setToast(res.message);
    });
  }, [connectorId, router]);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        aria-label={running ? `Sync in progress for ${displayName}` : `Sync ${displayName} now`}
        disabled={running || isPending}
        onClick={handleClick}
        size="sm"
      >
        {running ? "Syncing…" : "Sync now"}
      </Button>
      {toast ? (
        <span
          aria-live="polite"
          className={toastTone === "error" ? "pdpp-caption text-destructive" : "pdpp-caption text-muted-foreground"}
          role="status"
        >
          {toast}
        </span>
      ) : null}
    </div>
  );
}
