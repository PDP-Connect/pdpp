"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import {
  type AxisChip,
  type EvidenceTone,
  formatLastDurableProgress,
  formatProjectionFreshness,
  resolveRecordCountDisplay,
  summarizeAxisChips,
} from "../lib/connection-evidence.ts";
import { formatNextAction } from "../lib/next-action.ts";
import type { ConnectorOverview, ConnectorRunRef } from "../lib/rs-client.ts";
import { connectorHasPartialCoverageHint, normalizeKnownGaps } from "../lib/run-gaps.ts";
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
  const {
    connectionHealth,
    connectionId,
    connector,
    connectorDisplayName,
    connectorInstanceId,
    isRunning,
    lastRun,
    lastSuccessfulRun,
    streamCount,
    streams,
    totalRecords,
    totalRetainedBytes,
  } = overview;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Optimistic: if the user just clicked, treat as running until the next
  // server refresh tells us otherwise. This avoids the awkward gap between
  // action return and route revalidation.
  const [optimisticRunning, setOptimisticRunning] = useState(false);
  const [toast, setToast] = useState<ToastState>({ kind: "none" });
  const running = isRunning || optimisticRunning;
  const lastRunKnownGaps = normalizeKnownGaps(lastRun?.known_gaps);
  const hasPartialCoverageHint = connectorHasPartialCoverageHint({ lastRunKnownGaps, totalRecords });

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
  //
  // SSR-safe: we initialize `optimisticStart` lazily via an effect so the
  // server render and first client render agree on `null`. The optimistic
  // branch never fires during SSR (the user-click path that triggers it is
  // client-only), so the visible behavior is unchanged.
  const [optimisticStart, setOptimisticStart] = useState<number | null>(null);
  useEffect(() => {
    if (optimisticStart === null) {
      setOptimisticStart(Date.now());
    }
  }, [optimisticStart]);
  let effectiveStartIso: string | undefined;
  if (isRunning && lastRun) {
    effectiveStartIso = lastRun.first_at;
  } else if (optimisticStart !== null) {
    effectiveStartIso = new Date(optimisticStart).toISOString();
  }

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

  const routeId = connectionId ?? connectorInstanceId ?? connector.connector_id;
  const detailHref = `/dashboard/records/${encodeURIComponent(routeId)}`;
  const displayName = connector.display_name ?? connector.name ?? connector.connector_id;
  const typeName = connectorDisplayName ?? connector.name ?? connector.connector_id;
  const displayedStreamCount = streamCount ?? streams.length;
  const nextAction = formatNextAction(connectionHealth?.next_action ?? null);
  const recordCount = resolveRecordCountDisplay(overview);
  const axisChips = summarizeAxisChips(connectionHealth?.axes);
  const projectionFreshness = formatProjectionFreshness(connectionHealth);
  const durableProgress = formatLastDurableProgress({
    hasError: Boolean(overview.error),
    lastRun,
    lastSuccessfulRun,
    localDeviceProgress: overview.localDeviceProgress ?? null,
    totalRecords,
  });

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
            <span className="pdpp-caption truncate text-muted-foreground">
              {typeName}
              {connectorInstanceId ? (
                <>
                  {" "}
                  · <code className="font-mono">{connectorInstanceId}</code>
                </>
              ) : null}
            </span>
          </Link>
        </div>

        {/* Stats */}
        <div className="pdpp-caption flex shrink-0 flex-col gap-0.5 text-muted-foreground tabular-nums sm:items-end sm:text-right">
          <span>
            {recordCount.label === null ? (
              <span className="text-muted-foreground/70" data-testid="records-unavailable" title={recordCount.title}>
                Records unavailable
              </span>
            ) : (
              <span title={recordCount.title}>{recordCount.label} records</span>
            )}{" "}
            · {displayedStreamCount} stream
            {displayedStreamCount === 1 ? "" : "s"}
          </span>
          {typeof totalRetainedBytes === "number" ? (
            <span title={`${totalRetainedBytes.toLocaleString()} retained bytes`}>
              {formatBytes(totalRetainedBytes)} retained
            </span>
          ) : null}
          <ConnectorFreshnessLine
            hasError={Boolean(overview.error)}
            lastRun={lastRun}
            lastSuccessfulRun={lastSuccessfulRun}
            localDeviceProgress={overview.localDeviceProgress ?? null}
            totalRecords={totalRecords}
          />
          {hasPartialCoverageHint ? (
            <Link
              className="inline-flex items-center gap-1 text-[color:var(--warning)] underline-offset-2 hover:underline"
              href={`${runsHref}/${encodeURIComponent(lastRun?.run_id ?? "")}`}
              title="Latest run produced records but reported known source gaps"
            >
              Partial source coverage
            </Link>
          ) : null}
        </div>

        {/* Status + action */}
        <div className="flex shrink-0 items-center gap-2">
          <RunStatus
            connectionHealth={connectionHealth}
            hasRecords={totalRecords > 0}
            lastRun={lastRun}
            lastSuccessfulRun={lastSuccessfulRun}
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

      {axisChips.length > 0 ? (
        <div className="mx-3 mb-2 flex flex-wrap items-center gap-1.5" data-testid="axis-chip-strip">
          {axisChips.map((chip) => (
            <AxisChipBadge chip={chip} key={chip.label} />
          ))}
          {durableProgress.unavailable ? (
            <span
              className="pdpp-caption inline-flex items-center gap-1 border border-muted-foreground/40 border-dashed px-2 py-0.5 text-muted-foreground"
              data-testid="durable-progress-unavailable"
              title="Last durable progress could not be derived from current evidence."
            >
              {durableProgress.label}
            </span>
          ) : null}
        </div>
      ) : null}

      {projectionFreshness.unreliable ? (
        <div
          className="pdpp-caption mx-3 mb-2 border-l-2 border-l-muted-foreground/40 bg-muted/40 px-3 py-2 text-muted-foreground"
          data-testid="projection-unreliable"
          title={projectionFreshness.detail}
        >
          <span className="font-medium">Projection unreliable.</span> {projectionFreshness.detail}
        </div>
      ) : null}

      {nextAction ? <NextActionPill detailHref={detailHref} formatted={nextAction} /> : null}

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
  connectionHealth,
  hasRecords,
  running,
  runStart,
  lastRun,
  lastSuccessfulRun,
  runsHref,
}: {
  connectionHealth?: ConnectorOverview["connectionHealth"];
  hasRecords: boolean;
  running: boolean;
  runStart: string | undefined;
  lastRun: ConnectorRunRef | null;
  lastSuccessfulRun: ConnectorRunRef | null;
  runsHref: string;
}) {
  // Durable progress = any evidence that this connection has produced data
  // for the resource server, whether through a scheduler-managed run
  // (lastRun/lastSuccessfulRun) or a push-mode local-device exporter that
  // bypasses the scheduler entirely (hasRecords).
  const hasDurableProgress = Boolean(lastRun) || Boolean(lastSuccessfulRun) || hasRecords;
  if (connectionHealth) {
    return (
      <ConnectionHealthStatus
        hasDurableProgress={hasDurableProgress}
        health={connectionHealth}
        lastRun={lastRun}
        running={running}
        runStart={runStart}
        runsHref={runsHref}
      />
    );
  }

  const lastRunKnownGaps = normalizeKnownGaps(lastRun?.known_gaps);
  const hasPartialCoverageHint = connectorHasPartialCoverageHint({
    lastRunKnownGaps,
    totalRecords: hasRecords ? 1 : 0,
  });

  if (running) {
    return (
      <RunningBadge
        href={lastRun ? `${runsHref}/${encodeURIComponent(lastRun.run_id)}` : undefined}
        startedAt={runStart}
      />
    );
  }
  if (!lastRun) {
    if (hasRecords) {
      return (
        <span
          className="pdpp-caption inline-flex items-center gap-1 text-muted-foreground"
          title="records exist, but this database has no recorded sync run for this connector"
        >
          <StatusDot tone="neutral" />
          Data present
        </span>
      );
    }
    return (
      <span className="pdpp-caption inline-flex items-center gap-1 text-muted-foreground" title="never run">
        <StatusDot tone="neutral" />
        Never run
      </span>
    );
  }
  if (lastRun.status === "failed") {
    if (hasPartialCoverageHint) {
      return (
        <Link
          className="pdpp-caption inline-flex items-center gap-1 text-[color:var(--warning)] hover:underline"
          href={`${runsHref}/${encodeURIComponent(lastRun.run_id)}`}
          title={lastRun.failure_reason ?? "Run failed after producing partial data"}
        >
          <StatusDot shape="diamond" tone="warning" />
          Partial
        </Link>
      );
    }
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
  if (lastRun.status === "abandoned") {
    // Boot-time reconciliation marked this run as never-completing
    // (the controller that started it terminated mid-run). It's
    // terminal but distinct from a user-facing "failure" — the
    // connector itself never reported a result. See
    // docs/run-reconciliation-design-brief.md §3.7.
    return (
      <Link
        className="pdpp-caption inline-flex items-center gap-1 text-muted-foreground hover:underline"
        href={`${runsHref}/${encodeURIComponent(lastRun.run_id)}`}
        title="The controller terminated before this run finished. Re-running may succeed."
      >
        <StatusDot shape="diamond" tone="warning" />
        Abandoned
      </Link>
    );
  }
  if (lastRun.status === "succeeded" || lastRun.status === "success") {
    if (hasPartialCoverageHint) {
      return (
        <Link
          className="pdpp-caption inline-flex items-center gap-1 text-[color:var(--warning)] hover:underline"
          href={`${runsHref}/${encodeURIComponent(lastRun.run_id)}`}
          title="Idle, but the latest run reported known source gaps"
        >
          <StatusDot shape="diamond" tone="warning" />
          Partial
        </Link>
      );
    }
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

function ConnectionHealthStatus({
  hasDurableProgress,
  health,
  lastRun,
  running,
  runStart,
  runsHref,
}: {
  hasDurableProgress: boolean;
  health: NonNullable<ConnectorOverview["connectionHealth"]>;
  lastRun: ConnectorRunRef | null;
  running: boolean;
  runStart: string | undefined;
  runsHref: string;
}) {
  const { label, shape, tone, title } = connectionHealthDisplay(health, hasDurableProgress);
  const content = (
    <span className={`pdpp-caption inline-flex items-center gap-1 ${connectionHealthTextClass(tone)}`} title={title}>
      <StatusDot shape={shape} tone={tone} />
      {label}
    </span>
  );
  const healthPill = lastRun ? (
    <Link
      className="underline-offset-2 hover:text-foreground/80 hover:underline"
      href={`${runsHref}/${encodeURIComponent(lastRun.run_id)}`}
    >
      {content}
    </Link>
  ) : (
    content
  );

  if (running || health.badges.syncing) {
    return (
      <span className="inline-flex items-center gap-2">
        {healthPill}
        <RunningBadge
          href={lastRun ? `${runsHref}/${encodeURIComponent(lastRun.run_id)}` : undefined}
          startedAt={runStart}
        />
      </span>
    );
  }

  return healthPill;
}

function connectionHealthDisplay(
  health: NonNullable<ConnectorOverview["connectionHealth"]>,
  hasDurableProgress: boolean
): {
  label: string;
  shape?: "circle" | "diamond" | "triangle";
  title: string;
  tone: "success" | "danger" | "neutral" | "warning";
} {
  const reason = health.reason_code ? ` · ${health.reason_code}` : "";
  switch (health.state) {
    case "healthy":
      return { label: "Healthy", title: "Required coverage is current and complete", tone: "success" };
    case "needs_attention":
      return { label: "Needs attention", shape: "diamond", title: `Owner action required${reason}`, tone: "warning" };
    case "cooling_off":
      return { label: "Cooling off", shape: "diamond", title: `Waiting before retry${reason}`, tone: "warning" };
    case "blocked":
      return { label: "Blocked", shape: "triangle", title: `Cannot make progress${reason}`, tone: "danger" };
    case "degraded":
      return {
        label: health.axes.coverage === "gaps" || health.axes.coverage === "partial" ? "Partial" : "Degraded",
        shape: "diamond",
        title: `Useful data may exist, but coverage or freshness is incomplete${reason}`,
        tone: "warning",
      };
    case "idle":
      // "Never run" is only honest when there is no durable progress evidence
      // at all. A local-device exporter that pushes records without a
      // scheduler-managed run still has durable progress, and labeling it
      // "Never run" would contradict the record count next to it.
      return {
        label: hasDurableProgress ? "Idle" : "Never run",
        title: hasDurableProgress ? "No active work" : "No durable progress yet",
        tone: "neutral",
      };
    case "unknown":
      return {
        label: "Unknown",
        title:
          health.unknown_reasons.length > 0
            ? `Projection evidence missing: ${health.unknown_reasons.join(", ")}`
            : "Projection evidence is incomplete",
        tone: "neutral",
      };
  }
}

function connectionHealthTextClass(tone: "success" | "danger" | "neutral" | "warning"): string {
  if (tone === "danger") {
    return "text-destructive";
  }
  if (tone === "warning") {
    return "text-[color:var(--warning)]";
  }
  return "text-muted-foreground";
}

function AxisChipBadge({ chip }: { chip: AxisChip }) {
  return (
    <span
      className={`pdpp-caption inline-flex items-center gap-1 px-2 py-0.5 ${axisChipClass(chip.tone)}`}
      data-axis-tone={chip.tone}
      title={chip.title}
    >
      {chip.label}
    </span>
  );
}

function axisChipClass(tone: EvidenceTone): string {
  if (tone === "success") {
    return "border border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "warning") {
    return "border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/5 text-[color:var(--warning)]";
  }
  if (tone === "danger") {
    return "border border-destructive/40 bg-destructive/5 text-destructive";
  }
  return "border border-muted-foreground/30 bg-muted/40 text-muted-foreground";
}

function ConnectorFreshnessLine({
  hasError,
  lastRun,
  lastSuccessfulRun,
  localDeviceProgress,
  totalRecords,
}: {
  hasError: boolean;
  lastRun: ConnectorRunRef | null;
  lastSuccessfulRun: ConnectorRunRef | null;
  localDeviceProgress?: import("../lib/ref-client.ts").RefLocalDeviceProgress | null;
  totalRecords: number;
}) {
  if (hasError) {
    // Evidence collection failed. Refuse to render a false "0 events" /
    // "never" / "records present" — they would all be unfounded.
    return (
      <span
        className="text-muted-foreground/70"
        data-testid="freshness-unavailable"
        title="Run evidence could not be loaded."
      >
        last sync: unavailable
      </span>
    );
  }
  if (lastSuccessfulRun) {
    return (
      <span className="inline-flex items-center gap-1">
        <span>last success:</span>
        <Timestamp value={lastSuccessfulRun.last_at} />
        <span aria-hidden>·</span>
        <span>
          {lastSuccessfulRun.event_count.toLocaleString()} event
          {lastSuccessfulRun.event_count === 1 ? "" : "s"}
        </span>
      </span>
    );
  }

  if (lastRun) {
    return (
      <span className="inline-flex items-center gap-1">
        <span>last attempt:</span>
        <Timestamp value={lastRun.last_at} />
        <span aria-hidden>·</span>
        <span>{lastRun.status.replace(/_/g, " ")}</span>
      </span>
    );
  }

  // Push-mode local-device exporters bypass scheduler_run_history. When
  // the reference server has a trusted heartbeat row for THIS connection,
  // surface its evidence here rather than the generic "records present ·
  // no scheduler run yet" fallback. We render `last device ingest` when
  // the row has been ingested-updated and `last device heartbeat`
  // otherwise; either is honest durable progress.
  if (localDeviceProgress) {
    const ingestAt = localDeviceProgress.last_ingest_at;
    const heartbeatAt = localDeviceProgress.last_heartbeat_at;
    if (ingestAt) {
      return (
        <span className="inline-flex items-center gap-1" data-testid="freshness-device-ingest">
          <span>last device ingest:</span>
          <Timestamp value={ingestAt} />
        </span>
      );
    }
    if (heartbeatAt) {
      return (
        <span className="inline-flex items-center gap-1" data-testid="freshness-device-heartbeat">
          <span>last device heartbeat:</span>
          <Timestamp value={heartbeatAt} />
        </span>
      );
    }
  }

  if (totalRecords > 0) {
    return <span>records present · no scheduler run yet</span>;
  }

  return <span>last sync: never</span>;
}

function RunningBadge({ startedAt, href }: { startedAt: string | undefined; href?: string }) {
  // Elapsed-time ticker. Only active while this component is mounted —
  // mount happens only when the row is in a running state, so the
  // interval is cheap.
  //
  // Hydration note: `Date.now()` differs between server render and client
  // hydration (the wall clock advances in between), which would mismatch
  // the rendered `title` and elapsed text. We render an SSR-safe placeholder
  // ("Running") with no clock-derived attributes, then enrich on mount.
  const startedMs = useMemo(() => {
    if (!startedAt) {
      return null;
    }
    const t = Date.parse(startedAt);
    return Number.isFinite(t) ? t : null;
  }, [startedAt]);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const secs = now !== null && startedMs !== null ? Math.max(0, Math.floor((now - startedMs) / 1000)) : null;
  const content = (
    <span
      aria-live="polite"
      className="pdpp-caption inline-flex items-center gap-1 text-foreground"
      title={secs === null ? "running" : `running for ${secs} seconds`}
    >
      <StatusDot tone="running" />
      {secs === null ? "Running" : `Running · ${formatElapsed(secs)}`}
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  let rounded = value.toFixed(2);
  if (value >= 100) {
    rounded = String(Math.round(value));
  } else if (value >= 10) {
    rounded = value.toFixed(1);
  }
  return `${rounded} ${units[unitIndex]}`;
}

function NextActionPill({
  detailHref,
  formatted,
}: {
  detailHref: string;
  formatted: NonNullable<ReturnType<typeof formatNextAction>>;
}) {
  // We never link to the spine's `action_target` directly — it can carry
  // values the user shouldn't see, and the response shape is not a URL.
  // For SLVP, the always-safe target is the connector detail page, which
  // is where the structured action surface lives. When the formatter
  // tells us no actionable target was given (or this is a schedule
  // fallback, which is by definition imprecise), render plain text.
  const interactive = formatted.actionTarget !== null && formatted.variant === "structured";
  const labelEl = (
    <span className="pdpp-caption inline-flex items-center gap-1.5 text-foreground">
      <span aria-hidden className="inline-block h-2 w-2 rotate-45 bg-[color:var(--warning)]" />
      <span className="font-medium">{formatted.label}</span>
    </span>
  );
  return (
    <div
      className="mx-3 mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-l-2 border-l-[color:var(--warning)] bg-[color:var(--warning)]/5 px-3 py-2"
      data-next-action-source={formatted.variant}
      data-testid="next-action-pill"
    >
      {interactive ? (
        <Link className="underline-offset-2 hover:underline" href={detailHref}>
          {labelEl}
        </Link>
      ) : (
        labelEl
      )}
      {formatted.caveat ? (
        <span className="pdpp-caption text-muted-foreground" data-testid="next-action-caveat">
          {formatted.caveat}
        </span>
      ) : null}
      {formatted.notificationHint ? (
        <span
          className="pdpp-caption text-muted-foreground"
          data-testid="next-action-notification-hint"
        >
          {formatted.notificationHint}
        </span>
      ) : null}
    </div>
  );
}

function StatusDot({
  tone,
  shape = "circle",
}: {
  tone: "running" | "success" | "danger" | "neutral" | "warning";
  shape?: "circle" | "diamond" | "triangle";
}) {
  // Shape + color reinforce each other (a11y: color is never alone).
  if (shape === "diamond") {
    return <span aria-hidden className="inline-block h-2 w-2 rotate-45 bg-[color:var(--warning)]" />;
  }
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
  if (tone === "warning") {
    return <span aria-hidden className={`${base} bg-[color:var(--warning)]`} />;
  }
  return <span aria-hidden className={`${base} bg-muted-foreground/40`} />;
}
