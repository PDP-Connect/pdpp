"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { syncStartFailureLead } from "../../lib/connection-evidence.ts";
import { type RunNowResult, runConnectorNowAction } from "../actions.ts";
import {
  markSyncStartToast,
  readSyncStartToast,
  syncStartToastDismissDelayMs,
} from "../last-known-sync-start.ts";

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
  expiresAt?: number;
  message: string;
  runId?: string;
  tone: "info" | "error" | "warning";
}

// operator-ui's "outline" weight maps to Ink Carbon's "ghost".
type IcButtonVariant = "default" | "destructive" | "ghost";
function toIcVariant(v: "default" | "destructive" | "outline"): IcButtonVariant {
  return v === "outline" ? "ghost" : v;
}

function syncRunHref(runId: string | undefined): string | null {
  const normalizedRunId = runId?.trim();
  return normalizedRunId ? `/syncs/${encodeURIComponent(normalizedRunId)}` : null;
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
  const syncToastScopeId = connectionId ?? connectorId;
  const toastRunHref = syncRunHref(toast?.runId);
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
    const id = setTimeout(() => setToast(null), syncStartToastDismissDelayMs(toast));
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    const restored = readSyncStartToast(syncToastScopeId);
    if (restored) {
      setToast(restored);
    }
  }, [syncToastScopeId]);

  const handleClick = useCallback(() => {
    setToast(null);
    startTransition(async () => {
      const res: RunNowResult = await runConnectorNowAction(connectorId, connectionId, { force });
      if (res.ok === true) {
        const runId =
          "run_id" in res && typeof res.run_id === "string" && res.run_id.trim().length > 0
            ? res.run_id.trim()
            : undefined;
        const expiresAt = Date.now() + TOAST_TTL_MS;
        const nextToast = {
          expiresAt,
          message: "Sync started.",
          runId,
          tone: "info",
        } satisfies SyncToast;
        setToast(nextToast);
        markSyncStartToast(
          syncToastScopeId,
          { message: nextToast.message, runId: nextToast.runId, tone: nextToast.tone },
          TOAST_TTL_MS
        );
        router.refresh();
        return;
      }
      if (res.reason === "already_running") {
        const runId =
          "run_id" in res && typeof res.run_id === "string" && res.run_id.trim().length > 0
            ? res.run_id.trim()
            : undefined;
        const expiresAt = Date.now() + TOAST_TTL_MS;
        const nextToast = {
          expiresAt,
          message: "A sync is already in progress.",
          runId,
          tone: "info",
        } satisfies SyncToast;
        setToast(nextToast);
        markSyncStartToast(
          syncToastScopeId,
          { message: nextToast.message, runId: nextToast.runId, tone: nextToast.tone },
          TOAST_TTL_MS
        );
        router.refresh();
        return;
      }
      // Stay on this connection and say whether the request reached the server.
      setToast({
        message: `${syncStartFailureLead(res.phase)} ${res.message}`.trim(),
        tone: res.phase === "before_server" ? "warning" : "error",
      });
    });
  }, [connectionId, connectorId, force, router, syncToastScopeId]);

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
          {toastRunHref ? (
            <Link className="underline underline-offset-2" href={toastRunHref}>
              View sync →
            </Link>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
