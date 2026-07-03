"use client";

import { buttonVariants, IcButton, IcTimestamp } from "@pdpp/brand-react";
import { StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { CONNECTION_HEALTH_VOCABULARY } from "@pdpp/operator-ui/components/status-vocabularies";
import { formatConnectorNameForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  type AxisChip,
  type ConnectionStatusDisplay,
  deriveConnectionNextStep,
  deriveConnectionStatusDisplay,
  derivePrimaryRowAction,
  type EvidenceTone,
  formatDominantCondition,
  formatLastDurableProgress,
  formatProjectionFreshness,
  type NextStepGuidance,
  type PrimaryRowAction,
  resolveRecordCountDisplay,
  summarizeAxisChips,
  syncActionIdleLabel,
  syncStartFailureLead,
  synthesizeConnectionVerdict,
} from "../lib/connection-evidence.ts";
import { formatNextAction } from "../lib/next-action.ts";
import { isRevokedConnection } from "../lib/records-list-classification.ts";
import type { ConnectorOverview, ConnectorRunRef } from "../lib/rs-client.ts";
import { normalizeKnownGaps, resolvePartialCoverageCue } from "../lib/run-gaps.ts";
import { type RunNowResult, runConnectorNowAction } from "./actions.ts";

// Elapsed-time tick for the in-progress label. Separate from the poll
// cadence: the counter should feel alive even between polls.
const ELAPSED_TICK_MS = 1000;

interface RowProps {
  /**
   * Whether to surface the "Label needed — rename" hint. Decided by the list,
   * not the row, because it depends on sibling connections: a fallback label
   * ("Amazon") is only ambiguous — and thus worth renaming — when two or more
   * unnamed connections of the same connector type exist. A lone connection of
   * a type keeps its honest type name with no nag. See
   * `ambiguousFallbackLabelKeys` in lib/connection-label-ambiguity.ts.
   */
  labelNeeded: boolean;
  overview: ConnectorOverview;
  /** Relative href to the runs page, used for failure drill-in. */
  runsHref: string;
}

type ToastState =
  | { kind: "none" }
  | { kind: "already_running" }
  | { kind: "error"; message: string; phase: "before_server" | "after_server" };

type RowPrimaryAction =
  | PrimaryRowAction
  | {
      detail: string;
      href: string;
      // A new-setup start (revoked row → add-source picker). Secondary-weight,
      // because the verb leads to a NEW setup, not a repair of this connection.
      kind: "new_setup";
      label: string;
    };

function addSourceHrefForConnector(connectorId: string): string {
  return `/sources/add?source_q=${encodeURIComponent(connectorId)}`;
}

function resolveEffectiveStartIso({
  isRunning,
  lastRun,
  optimisticStart,
}: {
  isRunning: boolean;
  lastRun: ConnectorRunRef | null;
  optimisticStart: number | null;
}): string | undefined {
  if (isRunning && lastRun) {
    return lastRun.first_at;
  }
  if (optimisticStart !== null) {
    return new Date(optimisticStart).toISOString();
  }
  return;
}

function setupStatusHrefForRow({
  connectionId,
  connectorInstanceId,
  detailHref,
  routeId,
}: {
  connectionId?: string;
  connectorInstanceId?: string;
  detailHref: string;
  routeId: string;
}): string {
  if (!(connectionId || connectorInstanceId)) {
    return detailHref;
  }
  return `/connect/status/${encodeURIComponent(connectionId ?? connectorInstanceId ?? routeId)}`;
}

function deriveRevokedAwareRowAction({
  connectorId,
  primaryAction,
  revoked,
}: {
  connectorId: string;
  primaryAction: PrimaryRowAction;
  revoked: boolean;
}): RowPrimaryAction {
  if (!revoked) {
    return primaryAction;
  }
  return {
    kind: "new_setup",
    href: addSourceHrefForConnector(connectorId),
    label: "Start new setup",
    detail:
      "This connection is revoked: future collection is stopped while retained records stay visible. Starting a new setup begins the supported setup path for this source — it does not re-authorize the revoked connection.",
  };
}

function useConnectorSyncState({
  connectionId,
  connectorId,
  connectorInstanceId,
  isRunning,
}: {
  connectionId?: string;
  connectorId: string;
  connectorInstanceId?: string;
  isRunning: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Optimistic: if the user just clicked, treat as running until the next
  // server refresh tells us otherwise. This avoids the awkward gap between
  // action return and route revalidation.
  const [optimisticRunning, setOptimisticRunning] = useState(false);
  const [toast, setToast] = useState<ToastState>({ kind: "none" });

  useEffect(() => {
    if (optimisticRunning && isRunning) {
      setOptimisticRunning(false);
    }
  }, [isRunning, optimisticRunning]);

  const [optimisticStart, setOptimisticStart] = useState<number | null>(null);
  useEffect(() => {
    if (optimisticStart === null) {
      setOptimisticStart(Date.now());
    }
  }, [optimisticStart]);

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
      const res: RunNowResult = await runConnectorNowAction(connectorId, connectionId ?? connectorInstanceId ?? null);
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
      setToast({ kind: "error", message: res.message, phase: res.phase });
    });
  }, [connectionId, connectorId, connectorInstanceId, router]);

  return {
    handleSync,
    isPending,
    optimisticStart,
    running: isRunning || optimisticRunning,
    toast,
  };
}

export function ConnectorRow({ labelNeeded, overview, runsHref }: RowProps) {
  const {
    connectionHealth,
    connectionId,
    connector,
    connectorDisplayName,
    connectorInstanceId,
    isRunning,
    lastRun,
    lastSuccessfulRun,
    retainedBytes,
    streamCount,
    streams,
    totalRecords,
    totalRetainedBytes,
  } = overview;
  const revoked = isRevokedConnection(overview);
  const { handleSync, isPending, optimisticStart, running, toast } = useConnectorSyncState({
    connectionId,
    connectorId: connector.connector_id,
    connectorInstanceId,
    isRunning,
  });
  const lastRunKnownGaps = normalizeKnownGaps(lastRun?.known_gaps);
  // Prefer the reference's server-projected per-stream Collection Report
  // (`define-connector-progress-evidence-contract`) for the partial-coverage
  // cue, so the row reads the same authoritative `coverage_condition` the
  // connection headline and the detail-page stream chips do. The legacy
  // `known_gaps` reconstruction is used only when the reference returns no
  // report (a deployment predating Tranche C); see `resolvePartialCoverageCue`.
  const hasPartialCoverageHint = resolvePartialCoverageCue({
    collectionReport: overview.collectionReport ?? null,
    lastRunKnownGaps,
    totalRecords,
  });
  const effectiveStartIso = resolveEffectiveStartIso({ isRunning, lastRun, optimisticStart });

  const routeId = connectionId ?? connectorInstanceId ?? connector.connector_id;
  const detailHref = `/sources/${encodeURIComponent(routeId)}`;
  const setupStatusHref = setupStatusHrefForRow({ connectionId, connectorInstanceId, detailHref, routeId });
  const displayName = formatConnectorNameForDisplay({
    connectorId: connector.connector_id,
    displayName: connector.display_name,
    name: connector.name,
  });
  const typeName = formatConnectorNameForDisplay({
    connectorId: connector.connector_id,
    displayName: connectorDisplayName,
    name: connector.name,
  });
  // `labelNeeded` is decided by the list (it depends on sibling connections):
  // a fallback label is only "needed" when the bare connector type is ambiguous
  // — two or more unnamed connections of the same type. A lone connection keeps
  // its honest type name. When true, surface a gentle prompt linking to the
  // detail page where the rename control lives. The stable `connection_id`
  // stays the routing key; the label is a human alias only.
  const displayedStreamCount = streamCount ?? streams.length;
  const nextAction = formatNextAction(connectionHealth?.next_action ?? null);
  const recordCount = resolveRecordCountDisplay(overview);
  // The outbox axis is only meaningful for local/device-backed connections.
  // `localDeviceProgress` is populated by the reference exactly for
  // `sourceKind === "local_device"`, so it is the honest console-side signal:
  // pass it so non-local connections never render "Outbox · unknown".
  const axisChips = summarizeAxisChips(connectionHealth?.axes, {
    isLocalDeviceBacked: Boolean(overview.localDeviceProgress),
  });
  const projectionFreshness = formatProjectionFreshness(connectionHealth);
  const dominantCondition = formatDominantCondition(connectionHealth);
  // Per-state "what next" guidance for non-green states the structured
  // next_action doesn't already cover. Suppressed when a structured CTA is
  // present (one next step per row) or when a dominant-condition notice already
  // explains a blocked / needs_attention row. Push-mode local-collector
  // connections (those with device progress) are never told to "Sync now".
  const nextStep = deriveConnectionNextStep({
    hasDominantCondition: dominantCondition !== null,
    hasStructuredNextAction: nextAction !== null,
    health: connectionHealth,
    localDeviceProgress: overview.localDeviceProgress ?? null,
    supportsOwnerSync: !overview.localDeviceProgress,
  });
  // The primary row action is modality-aware: existing owner-runnable
  // connections, including browser-bound runs that may ask for manual browser
  // assistance after start, get a clickable sync action. Push-mode
  // local-collector connections still render non-clickable guidance because
  // the dashboard cannot remotely pull from the operator's device.
  const primaryAction: PrimaryRowAction = derivePrimaryRowAction({
    connectorId: connector.connector_id,
    health: connectionHealth ?? null,
    hasLocalDeviceProgress: Boolean(overview.localDeviceProgress),
  });
  const syncIdleLabel = syncActionIdleLabel(lastRun?.status);
  const rowAction = deriveRevokedAwareRowAction({
    connectorId: connector.connector_id,
    primaryAction,
    revoked,
  });
  const durableProgress = formatLastDurableProgress({
    hasError: Boolean(overview.error),
    lastRun,
    lastSuccessfulRun,
    localDeviceProgress: overview.localDeviceProgress ?? null,
    totalRecords,
  });
  const importReceipt = formatAcquisitionReceipt(overview.acquisitionCoverage ?? null);

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
            <span className="pdpp-caption truncate text-muted-foreground">{typeName}</span>
          </Link>
          {labelNeeded ? (
            <Link
              className="pdpp-caption mt-0.5 inline-flex w-fit items-center gap-1 text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
              data-testid="label-needed-hint"
              href={detailHref}
              title="This connection uses a fallback label. Open the connection to give it an owner-meaningful name."
            >
              Label needed — rename
            </Link>
          ) : null}
        </div>

        <ConnectorStats
          displayedStreamCount={displayedStreamCount}
          hasError={Boolean(overview.error)}
          lastRun={lastRun}
          lastSuccessfulRun={lastSuccessfulRun}
          localDeviceProgress={overview.localDeviceProgress ?? null}
          recordCount={recordCount}
          retainedBytes={retainedBytes ?? null}
          totalRecords={totalRecords}
          totalRetainedBytes={totalRetainedBytes ?? null}
        />

        {/* Status + action */}
        <div className="flex shrink-0 items-center gap-2">
          <RunStatus
            collectionReport={overview.collectionReport ?? null}
            connectionHealth={connectionHealth}
            hasRecords={totalRecords > 0}
            lastRun={lastRun}
            localDeviceProgress={overview.localDeviceProgress ?? null}
            revoked={revoked}
            revokedAt={overview.revokedAt ?? null}
            running={running}
            runStart={running ? effectiveStartIso : lastRun?.first_at}
            runsHref={runsHref}
          />
          <PrimaryRowActionControl
            action={rowAction}
            displayName={displayName}
            idleLabel={syncIdleLabel}
            isPending={isPending}
            onSync={handleSync}
            running={running}
          />
        </div>
      </div>

      <ConnectorRowEvidence
        axisChips={axisChips}
        detailHref={detailHref}
        dominantCondition={dominantCondition}
        durableProgress={durableProgress}
        importReceipt={importReceipt}
        importReceiptHref={setupStatusHref}
        nextAction={nextAction}
        nextStep={nextStep}
        partialCoverageHref={hasPartialCoverageHint ? `${runsHref}/${encodeURIComponent(lastRun?.run_id ?? "")}` : null}
        projectionFreshness={projectionFreshness}
        revoked={revoked}
        runbook={connectionHealth ? synthesizeConnectionVerdict(connectionHealth).runbook : null}
        toast={toast}
      />
    </li>
  );
}

/**
 * The honest primary action for the row.
 *
 * Owner-runnable connectors get the clickable sync button. Push-mode
 * local-collector connections render compact, non-clickable guidance because
 * their data arrives when the paired device pushes it. The guidance is inert
 * text (not a `<button>`), so it can never reach `runConnectorNowAction`.
 */
function PrimaryRowActionControl({
  action,
  displayName,
  isPending,
  idleLabel,
  onSync,
  running,
}: {
  action: RowPrimaryAction;
  displayName: string;
  isPending: boolean;
  idleLabel: string;
  onSync: () => void;
  running: boolean;
}) {
  if (action.kind === "new_setup") {
    // Secondary/outline weight: a new-setup start is NOT a primary repair. The
    // imperative filled button is reserved for true owner-action states (Sync /
    // a detail-page reconnect). The label's verb matches its destination.
    return (
      <Link
        aria-label={`${action.label} for ${displayName}`}
        className={buttonVariants({ variant: "ghost", size: "sm" })}
        href={action.href}
        title={action.detail}
      >
        {action.label}
      </Link>
    );
  }
  if (action.kind === "sync") {
    return (
      <IcButton
        aria-label={running ? `Sync in progress for ${displayName}` : `${idleLabel} for ${displayName}`}
        disabled={running || isPending}
        onClick={onSync}
        size="sm"
      >
        {running ? "Syncing…" : idleLabel}
      </IcButton>
    );
  }
  return (
    <span
      className="pdpp-caption max-w-[16rem] text-right text-muted-foreground"
      data-testid="row-action-device-wait"
      title={action.detail}
    >
      {action.label}
    </span>
  );
}

function ConnectorStats({
  displayedStreamCount,
  hasError,
  lastRun,
  lastSuccessfulRun,
  localDeviceProgress,
  recordCount,
  retainedBytes,
  totalRecords,
  totalRetainedBytes,
}: {
  displayedStreamCount: number;
  hasError: boolean;
  lastRun: ConnectorRunRef | null;
  lastSuccessfulRun: ConnectorRunRef | null;
  localDeviceProgress: ConnectorOverview["localDeviceProgress"];
  recordCount: ReturnType<typeof resolveRecordCountDisplay>;
  retainedBytes: ConnectorOverview["retainedBytes"] | null;
  totalRecords: number;
  totalRetainedBytes: number | null;
}) {
  // The secondary-metrics slot [SLVP §1.2 slot 3]: last-success + record count
  // in 13px tabular secondary. It carries NO colored link — the
  // partial-coverage cue moved into the peek so it never competes with the one
  // StatusBadge as a second row-level color [Defect 8].
  return (
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
      <RetainedBytesLine retainedBytes={retainedBytes} totalRetainedBytes={totalRetainedBytes} />
      <ConnectorFreshnessLine
        hasError={hasError}
        lastRun={lastRun}
        lastSuccessfulRun={lastSuccessfulRun}
        localDeviceProgress={localDeviceProgress ?? null}
        totalRecords={totalRecords}
      />
    </div>
  );
}

function formatAcquisitionReceipt(acquisitionCoverage: ConnectorOverview["acquisitionCoverage"]) {
  const batch = acquisitionCoverage?.latest_batch;
  if (!batch) {
    return null;
  }
  const accepted = batch.accepted_count ?? 0;
  const duplicates = batch.duplicate_count ?? 0;
  const parsed = batch.parsed_count ?? null;
  const countParts = [
    accepted > 0 ? `${accepted.toLocaleString()} accepted` : null,
    duplicates > 0 ? `${duplicates.toLocaleString()} duplicates` : null,
    accepted === 0 && duplicates === 0 && parsed !== null ? `${parsed.toLocaleString()} parsed` : null,
  ].filter((part): part is string => part !== null);
  const range =
    batch.date_range.start || batch.date_range.end
      ? `${batch.date_range.start ?? "unknown"} to ${batch.date_range.end ?? "unknown"}`
      : null;
  return {
    countLabel: countParts.length > 0 ? countParts.join(" · ") : null,
    fileName: batch.uploaded_file_name,
    format: batch.detected_format,
    range,
    status: batch.status,
    warningCount: batch.warnings.length,
  };
}

function AcquisitionReceiptLine({
  href,
  receipt,
}: {
  href: string;
  receipt: NonNullable<ReturnType<typeof formatAcquisitionReceipt>>;
}) {
  const parts = [receipt.status, receipt.countLabel, receipt.range].filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );
  const title = [
    receipt.fileName ? `File: ${receipt.fileName}` : null,
    receipt.format ? `Format: ${receipt.format}` : null,
    receipt.warningCount > 0 ? `${receipt.warningCount} warning${receipt.warningCount === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link
      className="pdpp-caption inline-flex w-fit items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      data-testid="acquisition-receipt-link"
      href={href}
      title={title || "Latest import coverage receipt"}
    >
      Import receipt
      {parts.length > 0 ? <span className="text-muted-foreground/80">· {parts.join(" · ")}</span> : null}
    </Link>
  );
}

function ConnectorRowEvidence({
  axisChips,
  detailHref,
  dominantCondition,
  durableProgress,
  importReceipt,
  importReceiptHref,
  nextAction,
  nextStep,
  partialCoverageHref,
  projectionFreshness,
  revoked,
  runbook,
  toast,
}: {
  axisChips: AxisChip[];
  detailHref: string;
  dominantCondition: ReturnType<typeof formatDominantCondition>;
  durableProgress: ReturnType<typeof formatLastDurableProgress>;
  importReceipt: ReturnType<typeof formatAcquisitionReceipt>;
  importReceiptHref: string;
  nextAction: ReturnType<typeof formatNextAction>;
  nextStep: NextStepGuidance | null;
  /** Run-detail href for the partial-coverage cue, or null when none. */
  partialCoverageHref: string | null;
  projectionFreshness: ReturnType<typeof formatProjectionFreshness>;
  revoked: boolean;
  /** The synthesized one-line "handling it" runbook (peek summary), or null. */
  runbook: string | null;
  toast: ToastState;
}) {
  // The revoked notice and the action toast stay ALWAYS-VISIBLE: a revoked
  // connection is a standing fact, and a toast is a transient action result.
  if (revoked) {
    return (
      <>
        <RevokedConnectionNotice />
        <ConnectorRowToast toast={toast} />
      </>
    );
  }

  // The row's ONE peek [SLVP §1.2]: everything that used to stack as siblings
  // (axis chips, dominant-condition notice, next-action pill, next-step
  // guidance, projection-unreliable notice, partial-coverage link) now lives
  // inside a single `<details>` disclosure whose `<summary>` is the synthesized
  // one-sentence runbook. The row stays singular; depth is one click (or the
  // badge tooltip) away. No client JS — native disclosure, keyboard-activatable.
  const hasAxisChips = axisChips.length > 0;
  const hasPeekBody =
    hasAxisChips ||
    durableProgress.unavailable ||
    importReceipt !== null ||
    projectionFreshness.unreliable ||
    dominantCondition !== null ||
    nextAction !== null ||
    nextStep !== null ||
    partialCoverageHref !== null;

  // Nothing to disclose and no runbook → a clean (green/ready) row shows no
  // peek at all, exactly per the "healthy rows render no extra" rule.
  if (!(hasPeekBody || runbook)) {
    return <ConnectorRowToast toast={toast} />;
  }

  return (
    <>
      <details className="group mx-3 mb-2" data-testid="connector-row-peek">
        <summary
          className="pdpp-caption flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground underline-offset-2 hover:text-foreground"
          data-testid="connector-row-peek-summary"
        >
          <span aria-hidden className="inline-block transition-transform group-open:rotate-90">
            ▸
          </span>
          <span className="min-w-0 truncate">{runbook ?? "Status detail"}</span>
        </summary>
        {hasPeekBody ? (
          <ConnectorPeekBody
            axisChips={axisChips}
            detailHref={detailHref}
            dominantCondition={dominantCondition}
            durableProgress={durableProgress}
            hasAxisChips={hasAxisChips}
            importReceipt={importReceipt}
            importReceiptHref={importReceiptHref}
            nextAction={nextAction}
            nextStep={nextStep}
            partialCoverageHref={partialCoverageHref}
            projectionFreshness={projectionFreshness}
          />
        ) : null}
      </details>
      <ConnectorRowToast toast={toast} />
    </>
  );
}

function RevokedConnectionNotice() {
  return (
    <div
      className="pdpp-caption mx-3 mb-2 border-l-2 border-l-muted-foreground/40 bg-muted/30 px-3 py-2 text-muted-foreground"
      data-testid="connection-revoked-notice"
    >
      Future collection is stopped. Retained records stay visible; use Start new setup to begin a fresh setup path for
      this source.
    </div>
  );
}

function ConnectorPeekBody({
  axisChips,
  detailHref,
  dominantCondition,
  durableProgress,
  hasAxisChips,
  importReceipt,
  importReceiptHref,
  nextAction,
  nextStep,
  partialCoverageHref,
  projectionFreshness,
}: {
  axisChips: AxisChip[];
  detailHref: string;
  dominantCondition: ReturnType<typeof formatDominantCondition>;
  durableProgress: ReturnType<typeof formatLastDurableProgress>;
  hasAxisChips: boolean;
  importReceipt: ReturnType<typeof formatAcquisitionReceipt>;
  importReceiptHref: string;
  nextAction: ReturnType<typeof formatNextAction>;
  nextStep: NextStepGuidance | null;
  partialCoverageHref: string | null;
  projectionFreshness: ReturnType<typeof formatProjectionFreshness>;
}) {
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="connector-row-peek-body">
      {hasAxisChips ? <AxisChipStrip axisChips={axisChips} durableProgress={durableProgress} /> : null}
      {projectionFreshness.unreliable ? <ProjectionUnreliableNotice projectionFreshness={projectionFreshness} /> : null}
      {dominantCondition ? <DominantConditionNotice condition={dominantCondition} /> : null}
      {importReceipt ? <AcquisitionReceiptLine href={importReceiptHref} receipt={importReceipt} /> : null}
      {nextAction ? <NextActionPill detailHref={detailHref} formatted={nextAction} /> : null}
      {nextStep ? <NextStepGuidanceRow detailHref={detailHref} guidance={nextStep} /> : null}
      {partialCoverageHref ? <PartialCoverageLink href={partialCoverageHref} /> : null}
    </div>
  );
}

function AxisChipStrip({
  axisChips,
  durableProgress,
}: {
  axisChips: AxisChip[];
  durableProgress: ReturnType<typeof formatLastDurableProgress>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="axis-chip-strip">
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
  );
}

function ProjectionUnreliableNotice({
  projectionFreshness,
}: {
  projectionFreshness: ReturnType<typeof formatProjectionFreshness>;
}) {
  return (
    <div
      className="pdpp-caption border-l-2 border-l-muted-foreground/40 bg-muted/40 px-3 py-2 text-muted-foreground"
      data-testid="projection-unreliable"
      title={projectionFreshness.detail}
    >
      <span className="font-medium">Projection unreliable.</span> {projectionFreshness.detail}
    </div>
  );
}

function PartialCoverageLink({ href }: { href: string }) {
  return (
    <Link
      className="pdpp-caption inline-flex w-fit items-center gap-1 text-[color:var(--warning)] underline-offset-2 hover:underline"
      data-testid="partial-coverage-link"
      href={href}
      title="Latest run produced records but reported known source gaps"
    >
      Partial source coverage
    </Link>
  );
}

function ConnectorRowToast({ toast }: { toast: ToastState }) {
  if (toast.kind === "none") {
    return null;
  }
  if (toast.kind === "already_running") {
    return (
      <div
        aria-live="polite"
        className="pdpp-caption mx-3 mb-2 bg-muted/60 px-3 py-2 text-muted-foreground"
        role="status"
      >
        A sync for this connector is already in progress.
      </div>
    );
  }
  // Error: keep the owner on this connection's row and say whether the
  // run-start request reached the reference server, so they know whether to
  // check their deployment (before) or read the server's reason (after).
  const isBeforeServer = toast.phase === "before_server";
  const lead = syncStartFailureLead(toast.phase);
  return (
    <div
      aria-live="polite"
      className={
        isBeforeServer
          ? "pdpp-caption mx-3 mb-2 border-l-2 border-l-[color:var(--warning)] bg-[color:var(--warning)]/5 px-3 py-2 text-[color:var(--warning)]"
          : "pdpp-caption mx-3 mb-2 border-l-2 border-l-destructive bg-destructive/5 px-3 py-2 text-destructive"
      }
      data-sync-error-phase={toast.phase}
      data-testid="sync-now-error"
      role="status"
    >
      <span className="font-medium">{lead}</span> {toast.message}
    </div>
  );
}

function RunStatus({
  collectionReport,
  connectionHealth,
  hasRecords,
  running,
  runStart,
  lastRun,
  localDeviceProgress,
  revoked,
  revokedAt,
  runsHref,
}: {
  collectionReport: ConnectorOverview["collectionReport"];
  connectionHealth?: ConnectorOverview["connectionHealth"];
  hasRecords: boolean;
  running: boolean;
  runStart: string | undefined;
  lastRun: ConnectorRunRef | null;
  localDeviceProgress: ConnectorOverview["localDeviceProgress"];
  revoked: boolean;
  revokedAt: string | null;
  runsHref: string;
}) {
  // Durable progress = any evidence that this connection has produced data
  // for the resource server, whether through a scheduler-managed run
  // (lastRun/lastSuccessfulRun) or a push-mode local-device exporter that
  // bypasses the scheduler entirely (hasRecords).
  const hasDurableProgress = hasRecords;
  if (revoked) {
    return (
      <span
        className="pdpp-caption inline-flex items-center gap-1 text-muted-foreground"
        data-testid="connection-status-revoked"
        title="Future collection is stopped. Already-collected records stay retained."
      >
        <StatusDot tone="neutral" />
        Revoked
        {revokedAt ? (
          <>
            <span aria-hidden>·</span>
            <IcTimestamp value={revokedAt} />
          </>
        ) : null}
      </span>
    );
  }
  if (connectionHealth) {
    return (
      <ConnectionHealthStatus
        hasDurableProgress={hasDurableProgress}
        health={connectionHealth}
        lastRun={lastRun}
        localDeviceProgress={localDeviceProgress ?? null}
        running={running}
        runStart={runStart}
        runsHref={runsHref}
      />
    );
  }

  return (
    <LegacyRunStatus
      collectionReport={collectionReport}
      hasRecords={hasRecords}
      lastRun={lastRun}
      running={running}
      runStart={runStart}
      runsHref={runsHref}
    />
  );
}

function LegacyRunStatus({
  collectionReport,
  hasRecords,
  lastRun,
  running,
  runStart,
  runsHref,
}: {
  collectionReport: ConnectorOverview["collectionReport"];
  hasRecords: boolean;
  lastRun: ConnectorRunRef | null;
  running: boolean;
  runStart: string | undefined;
  runsHref: string;
}) {
  // No connection-health projection (a reference predating it). The "Partial"
  // badge still prefers the server-projected Collection Report when one is
  // present, and only reconstructs from the last run's raw `known_gaps` when no
  // report is available — the same rule the row's coverage cue uses.
  const lastRunKnownGaps = normalizeKnownGaps(lastRun?.known_gaps);
  const hasPartialCoverageHint = resolvePartialCoverageCue({
    collectionReport,
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
    return <NoRecordedRunStatus hasRecords={hasRecords} />;
  }
  const runHref = `${runsHref}/${encodeURIComponent(lastRun.run_id)}`;
  if (lastRun.status === "failed") {
    return <FailedRunStatus hasPartialCoverageHint={hasPartialCoverageHint} href={runHref} lastRun={lastRun} />;
  }
  if (lastRun.status === "abandoned") {
    return <AbandonedRunStatus href={runHref} />;
  }
  if (lastRun.status === "succeeded" || lastRun.status === "success") {
    return <SucceededRunStatus hasPartialCoverageHint={hasPartialCoverageHint} href={runHref} />;
  }
  // Unknown or skipped — report the run status without inventing a health verdict.
  return (
    <span
      className="pdpp-caption inline-flex items-center gap-1 text-muted-foreground"
      title={`Latest run status: ${lastRun.status}`}
    >
      <StatusDot tone="neutral" />
      {lastRun.status.replace(/_/g, " ")}
    </span>
  );
}

function NoRecordedRunStatus({ hasRecords }: { hasRecords: boolean }) {
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

function FailedRunStatus({
  hasPartialCoverageHint,
  href,
  lastRun,
}: {
  hasPartialCoverageHint: boolean;
  href: string;
  lastRun: ConnectorRunRef;
}) {
  if (hasPartialCoverageHint) {
    return (
      <Link
        className="pdpp-caption inline-flex items-center gap-1 text-[color:var(--warning)] hover:underline"
        href={href}
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
      href={href}
      title={lastRun.failure_reason ?? "Run failed"}
    >
      <StatusDot shape="triangle" tone="danger" />
      Failed
    </Link>
  );
}

function AbandonedRunStatus({ href }: { href: string }) {
  // Boot-time reconciliation marked this run as never-completing
  // (the controller that started it terminated mid-run). It's
  // terminal but distinct from a user-facing "failure" — the
  // connector itself never reported a result. See
  // docs/run-reconciliation-design-brief.md §3.7.
  return (
    <Link
      className="pdpp-caption inline-flex items-center gap-1 text-muted-foreground hover:underline"
      href={href}
      title="The controller terminated before this run finished. Re-running may succeed."
    >
      <StatusDot shape="diamond" tone="warning" />
      Abandoned
    </Link>
  );
}

function SucceededRunStatus({ hasPartialCoverageHint, href }: { hasPartialCoverageHint: boolean; href: string }) {
  if (hasPartialCoverageHint) {
    return (
      <Link
        className="pdpp-caption inline-flex items-center gap-1 text-[color:var(--warning)] hover:underline"
        href={href}
        title="Latest run succeeded but reported known source gaps"
      >
        <StatusDot shape="diamond" tone="warning" />
        Partial
      </Link>
    );
  }
  return (
    <span
      className="pdpp-caption inline-flex items-center gap-1 text-muted-foreground"
      title="Latest run succeeded; connection-health evidence is unavailable"
    >
      <StatusDot tone="success" />
      Last sync succeeded
    </span>
  );
}

function ConnectionHealthStatus({
  hasDurableProgress,
  health,
  lastRun,
  localDeviceProgress,
  running,
  runStart,
  runsHref,
}: {
  hasDurableProgress: boolean;
  health: NonNullable<ConnectorOverview["connectionHealth"]>;
  lastRun: ConnectorRunRef | null;
  localDeviceProgress: import("../lib/ref-client.ts").RefLocalDeviceProgress | null;
  running: boolean;
  runStart: string | undefined;
  runsHref: string;
}) {
  const display: ConnectionStatusDisplay = deriveConnectionStatusDisplay({
    hasDurableProgress,
    health,
    localDeviceProgress,
  });
  // Single-voice synthesis [SLVP §1.3]: the badge renders the EFFECTIVE state,
  // which suppresses `blocked` → `cooling_off` when the root cause is a
  // source-pressure cooldown, so a rate-limited connection reads "handling it"
  // (warning), not "broken" (danger). The synthesized one-line runbook is the
  // badge tooltip — the sub-second pressure valve — so depth needs no
  // navigation. A genuinely blocked connection keeps its danger badge.
  const verdict = synthesizeConnectionVerdict(health);
  const title = verdict.runbook || display.title;
  const badge = (
    <span title={title}>
      <StatusBadge status={verdict.badgeState} vocabulary={CONNECTION_HEALTH_VOCABULARY} />
    </span>
  );
  const healthPill = lastRun ? (
    <Link className="underline-offset-2 hover:opacity-80" href={`${runsHref}/${encodeURIComponent(lastRun.run_id)}`}>
      {badge}
    </Link>
  ) : (
    badge
  );

  // RunningBadge surfaces a scheduler-run elapsed-time counter; the headline
  // pill stays focused on the derived connection verdict.
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

function DominantConditionNotice({ condition }: { condition: ReturnType<typeof formatDominantCondition> }) {
  if (!condition) {
    return null;
  }
  return (
    <div
      className={`pdpp-caption border-l-2 px-3 py-2 ${conditionNoticeClass(condition.tone)}`}
      data-testid="dominant-condition"
      title={condition.title}
    >
      {condition.label}
    </div>
  );
}

function conditionNoticeClass(tone: EvidenceTone): string {
  if (tone === "danger") {
    return "border-l-destructive bg-destructive/5 text-destructive";
  }
  if (tone === "warning") {
    return "border-l-[color:var(--warning)] bg-[color:var(--warning)]/5 text-[color:var(--warning)]";
  }
  return "border-l-muted-foreground/40 bg-muted/40 text-muted-foreground";
}

function AxisChipBadge({ chip }: { chip: AxisChip }) {
  return (
    <span
      className={`pdpp-caption inline-flex items-center gap-0 px-2 py-0.5 ${axisChipClass(chip.tone)}`}
      data-axis-tone={chip.tone}
      title={chip.title}
    >
      <span className="sr-only">{chip.label}</span>
      <span aria-hidden className="opacity-60">
        {chip.dimension}
      </span>
      <span aria-hidden className="mx-1 opacity-40">
        ·
      </span>
      <span aria-hidden className="font-medium">
        {chip.value}
      </span>
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

function RetainedBytesLine({
  retainedBytes,
  totalRetainedBytes,
}: {
  retainedBytes: ConnectorOverview["retainedBytes"] | null;
  totalRetainedBytes: number | null;
}) {
  if (typeof totalRetainedBytes !== "number") {
    return null;
  }
  const currentBytes = retainedBytes?.record_json_bytes ?? null;
  const historyBytes = retainedBytes?.record_changes_json_bytes ?? null;
  const blobBytes = retainedBytes?.blob_bytes ?? null;
  const hasBreakdown = currentBytes !== null || historyBytes !== null || blobBytes !== null;
  const detailParts = [
    typeof currentBytes === "number" ? `current ${formatBytes(currentBytes)}` : null,
    typeof historyBytes === "number" && historyBytes > 0 ? `history ${formatBytes(historyBytes)}` : null,
    typeof blobBytes === "number" && blobBytes > 0 ? `blobs ${formatBytes(blobBytes)}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <>
      <span
        title={
          hasBreakdown
            ? `${totalRetainedBytes.toLocaleString()} retained bytes (${detailParts.join(", ")})`
            : `${totalRetainedBytes.toLocaleString()} retained bytes`
        }
      >
        {formatBytes(totalRetainedBytes)} retained
      </span>
      {detailParts.length > 1 ? (
        <span className="text-muted-foreground/70" data-testid="retained-bytes-breakdown">
          {detailParts.join(" · ")}
        </span>
      ) : null}
    </>
  );
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
        <IcTimestamp value={lastSuccessfulRun.last_at} />
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
        <IcTimestamp value={lastRun.last_at} />
        <span aria-hidden>·</span>
        <span>{lastRun.status.replace(/_/g, " ")}</span>
      </span>
    );
  }

  // Push-mode local-device exporters bypass scheduler_run_history. When
  // the reference server has a trusted heartbeat row for THIS connection,
  // surface its evidence here. Distinguishing "last checked" (heartbeat)
  // from "last ingest" (batch outcome) is important: a collector that
  // checked in recently but found nothing new is fresh, not stale.
  if (localDeviceProgress) {
    const ingestAt = localDeviceProgress.last_ingest_at;
    const heartbeatAt = localDeviceProgress.last_heartbeat_at;
    if (heartbeatAt && ingestAt) {
      return (
        <span className="inline-flex items-center gap-1" data-testid="freshness-device-both">
          <span>last checked:</span>
          <IcTimestamp value={heartbeatAt} />
          <span aria-hidden>·</span>
          <span>last ingest:</span>
          <IcTimestamp value={ingestAt} />
        </span>
      );
    }
    if (ingestAt) {
      return (
        <span className="inline-flex items-center gap-1" data-testid="freshness-device-ingest">
          <span>last ingest:</span>
          <IcTimestamp value={ingestAt} />
        </span>
      );
    }
    if (heartbeatAt) {
      return (
        <span className="inline-flex items-center gap-1" data-testid="freshness-device-heartbeat">
          <span>last checked:</span>
          <IcTimestamp value={heartbeatAt} />
        </span>
      );
    }
    // Device row exists (enrollment complete) but no push received yet.
    return (
      <span className="text-muted-foreground/70" data-testid="freshness-device-no-push">
        no push received yet
      </span>
    );
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
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-l-2 border-l-[color:var(--warning)] bg-[color:var(--warning)]/5 px-3 py-2"
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
        <span className="pdpp-caption text-muted-foreground" data-testid="next-action-notification-hint">
          {formatted.notificationHint}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Per-state "what next" guidance row.
 *
 * Rendered only when the spine did NOT supply a structured `next_action` for a
 * non-green state, so it never competes with `NextActionPill`. The whole row is
 * a link to the connection detail page — the always-safe target where the
 * structured action surface (Sync now, rename, diagnostics, host remediation)
 * lives. We never link to a raw `action_target`. The tone mirrors the derived
 * severity so a blocked/stalled connection reads danger and a stale/degraded
 * one reads warning.
 */
function NextStepGuidanceRow({ detailHref, guidance }: { detailHref: string; guidance: NextStepGuidance }) {
  const danger = guidance.tone === "danger";
  const accent = danger
    ? "border-l-destructive bg-destructive/5"
    : "border-l-[color:var(--warning)] bg-[color:var(--warning)]/5";
  const marker = danger ? "bg-destructive" : "bg-[color:var(--warning)]";
  const labelColor = danger ? "text-destructive" : "text-foreground";
  return (
    <Link
      className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 border-l-2 px-3 py-2 underline-offset-2 hover:underline ${accent}`}
      data-next-step-tone={guidance.tone}
      data-testid="next-step-guidance"
      href={detailHref}
    >
      <span className="pdpp-caption inline-flex items-center gap-1.5">
        <span aria-hidden className={`inline-block h-2 w-2 rotate-45 ${marker}`} />
        <span className={`font-medium ${labelColor}`}>{guidance.label}</span>
      </span>
      <span className="pdpp-caption text-muted-foreground">{guidance.detail}</span>
      {guidance.scale ? (
        <span
          className="pdpp-caption text-muted-foreground tabular-nums"
          data-testid="next-step-outbox-scale"
          title="How much retryable work is stuck on the local collector. Open the connection for the host command to clear it."
        >
          Stuck on the device: {guidance.scale}
        </span>
      ) : null}
      {guidance.backlogScale ? (
        <span
          className="pdpp-caption text-muted-foreground tabular-nums"
          data-testid="next-step-backlog-scale"
          title="How much retryable detail the source is still throttling. The captured records stay valid; this resumes on its own — it is not an error to clear."
        >
          Source-pressure backlog: {guidance.backlogScale}
        </span>
      ) : null}
    </Link>
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
