"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type { ConnectorOverview, ConnectorRunRef } from "../lib/rs-client.ts";
import { type RunNowResult, runConnectorNowAction } from "./actions.ts";

// Elapsed-time tick for the in-progress label. Separate from the poll
// cadence: the counter should feel alive even between polls.
const ELAPSED_TICK_MS = 1000;

interface RowProps {
  overview: ConnectorOverview;
  /** Relative href to the runs page, used for failure drill-in. */
  runsHref: string;
}

type ToastState = { kind: "none" } | { kind: "already_running" } | { kind: "error"; message: string };

export function ConnectorRow({ overview, runsHref }: RowProps) {
  const { connector, totalRecords, streams, lastRun, lastSuccessfulRun, isRunning } = overview;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Optimistic: if the user just clicked, treat as running until the next
  // server refresh tells us otherwise. This avoids the awkward gap between
  // action return and route revalidation.
  const [optimisticRunning, setOptimisticRunning] = useState(false);
  const [toast, setToast] = useState<ToastState>({ kind: "none" });
  const running = isRunning || optimisticRunning;

  // Clear the optimistic flag once server-side state agrees the run
  // started (isRunning from props) or terminated (a new lastRun with
  // a terminal status newer than the one we had).
  useEffect(() => {
    if (!optimisticRunning) {
      return;
    }
    if (isRunning) {
      setOptimisticRunning(false);
    }
  }, [isRunning, optimisticRunning]);

  // When the user just optimistically started a run, we don't yet know
  // the server-side started_at. Using the stale lastRun.first_at would
  // produce nonsense like "Running · 3731m 45s" (i.e. the elapsed since
  // the PREVIOUS run). Clamp to "now" for the optimistic window; once
  // the server confirms the real active run, lastRun.first_at is the
  // fresh run's timestamp and we use it.
  const [optimisticStart] = useState(() => Date.now());
  const effectiveStartIso = isRunning && lastRun ? lastRun.first_at : new Date(optimisticStart).toISOString();

  // Auto-clear non-error toasts after a few seconds.
  useEffect(() => {
    if (toast.kind === "none") {
      return;
    }
    const id = setTimeout(() => setToast({ kind: "none" }), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const handleSync = useCallback(() => {
    setToast({ kind: "none" });
    setOptimisticRunning(true);
    startTransition(async () => {
      const res: RunNowResult = await runConnectorNowAction(connector.connector_id);
      if (res.ok === true) {
        // Success: leave optimistic running on; the next poll/refresh
        // will flip to server-authoritative state.
        router.refresh();
        return;
      }
      setOptimisticRunning(false);
      if (res.reason === "already_running") {
        setToast({ kind: "already_running" });
        router.refresh();
        return;
      }
      setToast({ kind: "error", message: res.message });
    });
  }, [connector.connector_id, router]);

  const detailHref = `/dashboard/records/${encodeURIComponent(connector.connector_id)}`;
  const displayName = connector.display_name ?? connector.name ?? connector.connector_id;

  return (
    <li>
      <div className="flex flex-col gap-3 px-3 py-3 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        {/* Identity */}
        <div className="min-w-0 flex-1">
          <Link
            aria-label={`Open ${displayName} detail`}
            className="group flex flex-col gap-0.5 focus:outline-none"
            href={detailHref}
          >
            <span className="pdpp-body font-medium text-foreground group-hover:underline">{displayName}</span>
            <span className="pdpp-caption truncate font-mono text-muted-foreground">{connector.connector_id}</span>
          </Link>
        </div>

        {/* Stats */}
        <div className="pdpp-caption flex shrink-0 flex-col gap-0.5 text-muted-foreground tabular-nums sm:items-end sm:text-right">
          <span>
            {totalRecords.toLocaleString()} records · {streams.length} stream
            {streams.length === 1 ? "" : "s"}
          </span>
          <span className="inline-flex items-center gap-1">
            <span>last sync:</span>
            {lastSuccessfulRun ? <Timestamp value={lastSuccessfulRun.last_at} /> : <span>never</span>}
            {lastSuccessfulRun ? <span aria-hidden>·</span> : null}
            {lastSuccessfulRun ? (
              <span>
                {lastSuccessfulRun.event_count.toLocaleString()} event
                {lastSuccessfulRun.event_count === 1 ? "" : "s"}
              </span>
            ) : null}
          </span>
        </div>

        {/* Status + action */}
        <div className="flex shrink-0 items-center gap-2">
          <RunStatus
            lastRun={lastRun}
            running={running}
            runStart={running ? effectiveStartIso : lastRun?.first_at}
            runsHref={runsHref}
          />
          <Button
            aria-label={running ? `Sync in progress for ${displayName}` : `Sync ${displayName} now`}
            disabled={running || isPending}
            onClick={handleSync}
            size="sm"
          >
            {running ? "Syncing…" : "Sync now"}
          </Button>
        </div>
      </div>

      {/* Toasts rendered inline so they don't obscure other rows. */}
      {toast.kind === "none" ? null : (
        <div
          aria-live="polite"
          className={
            toast.kind === "error"
              ? "pdpp-caption mx-3 mb-2 border-l-2 border-l-destructive bg-destructive/5 px-3 py-2 text-destructive"
              : "pdpp-caption mx-3 mb-2 bg-muted/60 px-3 py-2 text-muted-foreground"
          }
          role="status"
        >
          {toast.kind === "already_running" ? "A sync for this connector is already in progress." : toast.message}
        </div>
      )}
    </li>
  );
}

function RunStatus({
  running,
  runStart,
  lastRun,
  runsHref,
}: {
  running: boolean;
  runStart: string | undefined;
  lastRun: ConnectorRunRef | null;
  runsHref: string;
}) {
  if (running) {
    return (
      <RunningBadge
        href={lastRun ? `${runsHref}/${encodeURIComponent(lastRun.run_id)}` : undefined}
        startedAt={runStart}
      />
    );
  }
  if (!lastRun) {
    return (
      <span className="pdpp-caption inline-flex items-center gap-1 text-muted-foreground" title="never run">
        <StatusDot tone="neutral" />
        Never run
      </span>
    );
  }
  if (lastRun.status === "failed") {
    return (
      <Link
        className="pdpp-caption inline-flex items-center gap-1 text-destructive hover:underline"
        href={`${runsHref}/${encodeURIComponent(lastRun.run_id)}`}
        title={lastRun.failure_reason ?? "Run failed"}
      >
        <StatusDot shape="triangle" tone="danger" />
        Failed
      </Link>
    );
  }
  if (lastRun.status === "succeeded" || lastRun.status === "success") {
    return (
      <span
        className="pdpp-caption inline-flex items-center gap-1 text-muted-foreground"
        title="idle, last run succeeded"
      >
        <StatusDot tone="success" />
        Idle
      </span>
    );
  }
  // Unknown or skipped — still idle from the user's perspective.
  return (
    <span
      className="pdpp-caption inline-flex items-center gap-1 text-muted-foreground"
      title={`idle, last run ${lastRun.status}`}
    >
      <StatusDot tone="neutral" />
      {lastRun.status.replace(/_/g, " ")}
    </span>
  );
}

function RunningBadge({ startedAt, href }: { startedAt: string | undefined; href?: string }) {
  // Elapsed-time ticker. Only active while this component is mounted —
  // mount happens only when the row is in a running state, so the
  // interval is cheap.
  const startedMs = useMemo(() => {
    if (!startedAt) {
      return Date.now();
    }
    const t = Date.parse(startedAt);
    return Number.isFinite(t) ? t : Date.now();
  }, [startedAt]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedMs) / 1000));
  const content = (
    <span
      aria-live="polite"
      className="pdpp-caption inline-flex items-center gap-1 text-foreground"
      title={`running for ${secs} seconds`}
    >
      <StatusDot tone="running" />
      Running · {formatElapsed(secs)}
    </span>
  );
  if (!href) {
    return content;
  }
  return (
    <Link className="underline-offset-2 hover:text-foreground/80 hover:underline" href={href}>
      {content}
    </Link>
  );
}

function formatElapsed(secs: number): string {
  if (secs < 60) {
    return `${secs}s`;
  }
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function StatusDot({
  tone,
  shape = "circle",
}: {
  tone: "running" | "success" | "danger" | "neutral";
  shape?: "circle" | "triangle";
}) {
  // Shape + color reinforce each other (a11y: color is never alone).
  if (shape === "triangle") {
    return (
      <span
        aria-hidden
        className="inline-block h-0 w-0 border-x-[4px] border-x-transparent border-b-[7px]"
        style={{ borderBottomColor: "var(--color-destructive, #dc2626)" }}
      />
    );
  }
  const base = "inline-block h-2 w-2 rounded-full";
  if (tone === "running") {
    return <span aria-hidden className={`${base} animate-pulse bg-blue-500`} />;
  }
  if (tone === "success") {
    return <span aria-hidden className={`${base} bg-emerald-500`} />;
  }
  if (tone === "danger") {
    return <span aria-hidden className={`${base} bg-destructive`} />;
  }
  return <span aria-hidden className={`${base} bg-muted-foreground/40`} />;
}
