"use client";

import { IcButton } from "@pdpp/brand-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { syncStartFailureLead } from "../../lib/connection-evidence.ts";
import { type RunNowResult, runConnectorNowAction } from "../actions.ts";

const RUNNING_POLL_MS = 3000;
const TOAST_TTL_MS = 15_000;

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
  force?: boolean;
  idleLabel?: string;
  initialRunning: boolean;
  runningLabel?: string;
  title?: string;
  variant?: "default" | "destructive" | "outline";
}

interface SyncToast {
  message: string;
  runHref?: string;
  tone: "info" | "error" | "warning";
}

// operator-ui's "outline" weight maps to Ink Carbon's "ghost".
type IcButtonVariant = "default" | "destructive" | "ghost";
function toIcVariant(v: "default" | "destructive" | "outline"): IcButtonVariant {
  return v === "outline" ? "ghost" : v;
}

export function SyncNowButton({
  connectionId,
  connectorId,
  displayName,
  force = false,
  idleLabel = "Sync now",
  initialRunning,
  runningLabel = "Syncing…",
  title,
  variant = "default",
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<SyncToast | null>(null);
  const running = initialRunning;
  const busy = running || isPending;
  let buttonLabel = idleLabel;
  if (running) {
    buttonLabel = runningLabel;
  } else if (isPending) {
    buttonLabel = "Starting…";
  }

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
    if (!toast) {
      return;
    }
    const id = setTimeout(() => setToast(null), TOAST_TTL_MS);
    return () => clearTimeout(id);
  }, [toast]);

  const handleClick = useCallback(() => {
    setToast(null);
    startTransition(async () => {
      const res: RunNowResult = await runConnectorNowAction(connectorId, connectionId, { force });
      if (res.ok === true) {
        setToast({
          message: "Sync started.",
          runHref: res.run_id ? `/syncs/${encodeURIComponent(res.run_id)}` : undefined,
          tone: "info",
        });
        router.refresh();
        return;
      }
      if (res.reason === "already_running") {
        setToast({
          message: "A sync is already in progress.",
          runHref: res.run_id ? `/syncs/${encodeURIComponent(res.run_id)}` : undefined,
          tone: "info",
        });
        router.refresh();
        return;
      }
      // Stay on this connection and say whether the request reached the server.
      setToast({
        message: `${syncStartFailureLead(res.phase)} ${res.message}`.trim(),
        tone: res.phase === "before_server" ? "warning" : "error",
      });
    });
  }, [connectionId, connectorId, force, router]);

  return (
    <div className="flex flex-col items-end gap-1">
      <IcButton
        aria-label={`${buttonLabel} for ${displayName}`}
        disabled={busy}
        onClick={handleClick}
        size="sm"
        title={title}
        variant={toIcVariant(variant)}
      >
        {buttonLabel}
      </IcButton>
      {toast ? (
        <span
          aria-live="polite"
          className={`pdpp-caption max-w-[18rem] text-right ${syncToastToneClass(toast.tone)}`}
          data-toast-tone={toast.tone}
          role="status"
        >
          {toast.message}{" "}
          {toast.runHref ? (
            <Link className="underline underline-offset-2" href={toast.runHref}>
              Open sync
            </Link>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
