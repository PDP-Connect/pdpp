"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button.tsx";
import { syncStartFailureLead } from "../../lib/connection-evidence.ts";
import { type RunNowResult, runConnectorNowAction } from "../actions.ts";

const RUNNING_POLL_MS = 3000;

function syncToastToneClass(tone: "info" | "error" | "warning"): string {
  if (tone === "error") {
    return "text-destructive";
  }
  if (tone === "warning") {
    return "text-[color:var(--warning)]";
  }
  return "text-muted-foreground";
}

interface Props {
  connectionId: string | null;
  connectorId: string;
  displayName: string;
  initialRunning: boolean;
}

export function SyncNowButton({ connectionId, connectorId, displayName, initialRunning }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [optimisticRunning, setOptimisticRunning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastTone, setToastTone] = useState<"info" | "error" | "warning">("info");
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
      const res: RunNowResult = await runConnectorNowAction(connectorId, connectionId);
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
      // Stay on this connection and say whether the request reached the server.
      setToastTone(res.phase === "before_server" ? "warning" : "error");
      setToast(`${syncStartFailureLead(res.phase)} ${res.message}`.trim());
    });
  }, [connectionId, connectorId, router]);

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
          className={`pdpp-caption max-w-[18rem] text-right ${syncToastToneClass(toastTone)}`}
          data-toast-tone={toastTone}
          role="status"
        >
          {toast}
        </span>
      ) : null}
    </div>
  );
}
