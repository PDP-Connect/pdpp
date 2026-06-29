/**
 * Syncs view-model — the pure mapping from real reference data to the
 * Recordroom "Syncs" surface (the reskin of the Runs route).
 *
 * The canonical design (docs/design/ink-carbon/project/recordroom/rr-syncs.jsx)
 * shows three regions:
 *   1. a health stat band (streams on schedule / need-your-hand),
 *   2. failure CARDS for connections in a non-healthy state, and
 *   3. per-connection sync GROUPS, each a table of per-stream "sync rows"
 *      (stream · cadence · Rhythm sparkline · last result · next).
 *
 * This module is the single source of truth for how the three real contracts
 * — `RunSummary` (the runs feed), `RefConnectorSummary.rendered_verdict`,
 * `.connection_health` / `.schedule` (per-connection health + cadence), and
 * `RefSchedule` — collapse into that view-model. It is JSX-free and free of
 * `Date.now()` so it stays deterministically unit-testable.
 *
 * The hardest correctness requirement lives here: a connection that the source
 * is throttling (a self-resolving source-pressure cooldown) must read as
 * self-handled — NEVER a false "reconnect / log in again" prompt. We do NOT
 * invent that copy: current references bind the card to the server-owned
 * `RenderedVerdict.forward_statement` and `required_actions[]`; the legacy
 * health-snapshot path exists only for older references.
 */

import { formatConnectorNameForDisplay, isFallbackConnectionLabel } from "@pdpp/operator-ui/lib/connector-display";
import { indexCollectionReportByStream } from "../lib/collection-report.ts";
import { deriveFailureSummary, type FailureSummary } from "../lib/connection-evidence.ts";
import type {
  RefCollectionReportEntry,
  RefConnectorSummary,
  RefRenderedVerdict,
  RefSchedule,
  RunSummary,
} from "../lib/ref-client.ts";
import { verdictRequiresOwnerNow } from "../lib/source-actionability.ts";

// ─── Rhythm tick type (mirrors the kit's RhythmTick) ──────────────────────────
//
// Imported structurally rather than from the component module so this pure
// model never pulls a `.tsx` (and therefore React/CSS) into a node test.
export type SyncRhythmTick = "ok" | "fail";

/** A connection's effective health, reduced to the binary the group dot needs. */
export type SyncGroupHealth = "ok" | "failing";

/** One stream's row inside a sync group. */
export interface SyncRow {
  /** Deep link to browse this stream's records for this connection. */
  browseHref: string;
  /** Human cadence phrase, e.g. "every 15 min" / "daily" / "manual". */
  cadence: string;
  /**
   * Per-stream collected count from the last run's collection_report entry.
   * Null when the reference does not emit collection_report (pre-Tranche C
   * instances). Do NOT fall back to the connection-level event_count here.
   */
  collectedThisRun: number | null;
  /**
   * Per-stream coverage condition from the last run's collection_report entry,
   * e.g. "complete", "partial", "unknown". Null when collection_report absent.
   */
  coverageCondition: string | null;
  /** True when the last run for this stream failed (held cursor). */
  failed: boolean;
  /** Next-due phrase or ISO; "held" when the connection is paused/holding. */
  next: string;
  /** Next-due ISO timestamp when one is scheduled, else null. */
  nextAt: string | null;
  /** Stream name (the record stream this row tracks). */
  stream: string;
  /**
   * True when the collection_report entry reports this stream was skipped.
   * False when collection_report is absent (honest default).
   */
  streamSkipped: boolean;
}

/** One connection's group of sync rows. */
export interface SyncGroup {
  /** Durable connection identity (`connection_id`). */
  connectionId: string;
  /** Connector key, for the browse link. */
  connectorId: string;
  /** Reduced health driving the group dot. */
  health: SyncGroupHealth;
  /**
   * ISO timestamp of the last run for this connection. Null when no run yet.
   * Shown once in the group header rather than repeated on every stream row.
   */
  lastRunAt: string | null;
  /**
   * Connection-level last-run delta phrase moved here from per-row. True for
   * all streams in the group (it is derived from event_count, a cross-stream
   * total). Null when there is no terminal run on record.
   */
  lastRunDelta: string | null;
  /**
   * Connection-level last-run duration phrase moved here from per-row.
   * Null when unknown.
   */
  lastRunDuration: string | null;
  /**
   * Connection-level Rhythm sparkline ticks (oldest to newest). Moved to the
   * group header because the ticks represent the connection's run history, not
   * an individual stream's history.
   */
  lastRunRhythm: SyncRhythmTick[];
  /** Connection display name. */
  name: string;
  /** The per-stream rows. */
  streams: SyncRow[];
  /** Total stream count for this connection. */
  totalStreamCount: number;
}

/**
 * A failure card. `summary` is the verbatim {@link FailureSummary} from the
 * server-owned rendered verdict. The card is a panel with an action/status, NOT
 * a row — the canonical design treats owner work as an explicit affordance and
 * self-handled work as calm/detail-only.
 */
export interface FailureCard {
  /** Durable connection identity. */
  connectionId: string;
  /** Connector key, for the reconnect deep link. */
  connectorId: string;
  /** Connection display name (the card title prefix). */
  name: string;
  /** The honest, pre-derived failure summary (prose + cta + trigger label). */
  summary: FailureSummary;
}

/**
 * Several active same-type sources can still carry fallback labels ("Amazon").
 * Syncs is an operational overview, so it collapses those indistinguishable
 * shells exactly like Sources does: no data is hidden, but the owner is sent to
 * label/revoke/retry each concrete source instead of reading ten identical
 * cards.
 */
export interface DuplicateSyncGroup {
  /** How many of the collapsed sources currently carry a rendered verdict card. */
  advisoryCount: number;
  /** Connector key shared by this duplicate set. */
  connectorId: string;
  /** First concrete connection for a direct review link. */
  firstConnectionId: string;
  /** Human connector kind, e.g. "Amazon". */
  kind: string;
  /** How many collapsed sources need the owner's hand. */
  ownerActionCount: number;
  /** Streams represented by the collapsed duplicate set. */
  streamCount: number;
  /** Number of active fallback-labeled sources in the collapsed set. */
  total: number;
}

/** The health stat band at the top of the Syncs view. */
export interface HealthBand {
  /** True when there are no visible review/action cards — show the all-clear note. */
  allClear: boolean;
  /** Count of visible cards that need review, including advisory/code-fix cards. */
  needsReview: number;
  /** Count of connections that need an owner's hand (genuine reconnect/attention). */
  needYourHand: number;
  /** Count of streams whose connection is healthy / on schedule. */
  onSchedule: number;
}

/** The whole Syncs view-model. */
export interface SyncsViewModel {
  band: HealthBand;
  duplicateGroups: DuplicateSyncGroup[];
  failureCards: FailureCard[];
  groups: SyncGroup[];
  totalGroupCount: number;
  totalReviewCardCount: number;
  totalStreamCount: number;
}

const HEALTHY_RUN_STATUSES = new Set(["succeeded", "success", "completed", "succeeded_with_gaps"]);
const FAILED_RUN_STATUSES = new Set(["failed", "rejected", "cancelled", "error"]);
const DUPLICATE_SYNC_GROUP_MIN_UNNAMED = 3;
const RECENT_RUN_LIMIT = 7;

/**
 * Reduce a run status to a Rhythm tick. Partial (`succeeded_with_gaps`) counts
 * as `ok` for run-history rhythm; the rendered verdict separately owns whether
 * any remaining gap needs owner attention. Non-terminal runs are skipped by the
 * caller.
 */
function runTick(status: string): SyncRhythmTick {
  if (FAILED_RUN_STATUSES.has(status)) {
    return "fail";
  }
  return "ok";
}

function isTerminalRunStatus(status: string): boolean {
  return HEALTHY_RUN_STATUSES.has(status) || status === "failed" || status === "rejected" || status === "cancelled";
}

/** Stable connector key for a run, used to bucket runs under a connection. */
function runConnectorKey(run: RunSummary): string | null {
  return run.connector_id ?? run.source?.id ?? null;
}

function exactRunConnectionIds(run: RunSummary): Set<string> {
  const ids = new Set<string>();
  for (const value of [run.connection_id, run.connector_instance_id, run.source?.connection_id, run.source?.id]) {
    if (typeof value === "string" && value.length > 0) {
      ids.add(value);
    }
  }
  const profileKey = run.browser_surface_profile_key;
  if (typeof profileKey === "string" && profileKey.length > 0) {
    ids.add(profileKey);
    const suffix = profileKey.split(":").at(-1);
    if (suffix) {
      ids.add(suffix);
    }
  }
  return ids;
}

function runMatchesConnection(run: RunSummary, connector: RefConnectorSummary): boolean {
  const connectionIds = [connector.connection_id, connector.connector_instance_id].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  if (connectionIds.length === 0) {
    return false;
  }
  const exactIds = exactRunConnectionIds(run);
  if (!connectionIds.some((id) => exactIds.has(id))) {
    return false;
  }
  const connectorKey = runConnectorKey(run);
  return connectorKey === null || connectorKey === connector.connector_id || connectionIds.includes(connectorKey);
}

function connectorRunToRunSummary(
  connector: RefConnectorSummary,
  run: NonNullable<RefConnectorSummary["last_run"]>
): RunSummary {
  return {
    connection_id: connector.connection_id,
    connector_id: connector.connector_id,
    connector_instance_id: connector.connector_instance_id ?? connector.connection_id,
    event_count: run.event_count,
    failure_reason: run.failure_reason,
    first_at: run.first_at,
    grant_id: null,
    kinds: [],
    last_at: run.last_at,
    needs_input: false,
    object: "run_summary",
    run_id: run.run_id,
    status: run.status,
  };
}

function connectionRunHistory(input: { connector: RefConnectorSummary; runs: readonly RunSummary[] }): RunSummary[] {
  const exactRuns = input.runs.filter((run) => runMatchesConnection(run, input.connector));
  const keyed = new Map<string, RunSummary>();
  for (const run of exactRuns) {
    keyed.set(run.run_id, run);
  }
  for (const run of [input.connector.last_run, input.connector.last_successful_run]) {
    if (run && !keyed.has(run.run_id)) {
      keyed.set(run.run_id, connectorRunToRunSummary(input.connector, run));
    }
  }
  return Array.from(keyed.values()).sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at));
}

/**
 * Build the Rhythm ticks for a connection from its recent terminal runs,
 * oldest→newest, capped at {@link RECENT_RUN_LIMIT}. Non-terminal runs are
 * skipped so the sparkline reflects settled outcomes only.
 */
export function deriveConnectionRhythm(runs: readonly RunSummary[]): SyncRhythmTick[] {
  const terminal = runs.filter((r) => isTerminalRunStatus(r.status));
  // `runs` arrive newest-first from the feed; reverse to oldest-first and cap.
  const recent = terminal.slice(0, RECENT_RUN_LIMIT).reverse();
  return recent.map((r) => runTick(r.status));
}

/**
 * Legacy fallback: without `rendered_verdict`, a connection's health is "ok"
 * unless `deriveFailureSummary` produced a card for it.
 */
function connectionHealth(summary: FailureSummary | null): SyncGroupHealth {
  return summary ? "failing" : "ok";
}

function renderedVerdictGroupHealth(verdict: RefRenderedVerdict | null | undefined): SyncGroupHealth | null {
  if (!verdict) {
    return null;
  }
  return verdict.pill.tone === "amber" || verdict.pill.tone === "red" ? "failing" : "ok";
}

function connectorKind(connector: RefConnectorSummary): string {
  return formatConnectorNameForDisplay({
    connectorId: connector.connector_id,
    displayName: connector.connector_display_name,
    name: connector.connector_display_name,
  });
}

function hasFallbackConnectionLabel(connector: RefConnectorSummary): boolean {
  return isFallbackConnectionLabel({
    connectorId: connector.connector_id,
    displayName: connector.display_name,
    name: connector.connector_display_name,
  });
}

/**
 * Humanize a schedule into a short cadence phrase for a sync row.
 * Mirrors the canonical mock's "every 15 min" / "daily" / "manual" voice.
 */
export function describeCadence(schedule: RefSchedule | null | undefined): string {
  if (!schedule) {
    return "on demand";
  }
  if (schedule.effective_mode === "paused" || !schedule.enabled) {
    return "paused";
  }
  if (schedule.effective_mode === "manual") {
    return "manual";
  }
  const seconds = schedule.interval_seconds;
  if (!seconds || seconds <= 0) {
    return "automatic";
  }
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `every ${minutes} min`;
  }
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600);
    return hours === 1 ? "hourly" : `every ${hours} h`;
  }
  const days = Math.round(seconds / 86_400);
  if (days === 1) {
    return "daily";
  }
  if (days === 7) {
    return "weekly";
  }
  if (days >= 360 && days <= 370) {
    return "yearly";
  }
  return `every ${days} d`;
}

/** Format an event-count delta into a row phrase. */
export function describeDelta(input: { failed: boolean; eventCount: number | null }): string {
  if (input.failed) {
    return "sync failed";
  }
  const count = input.eventCount;
  if (count == null) {
    return "no recent run";
  }
  if (count <= 0) {
    return "no change";
  }
  return `+${count.toLocaleString()} record${count === 1 ? "" : "s"}`;
}

/**
 * Format a duration between two ISO timestamps as a short phrase ("6 s",
 * "2 m 4 s"), or null when either bound is missing/unparseable.
 */
export function describeDuration(firstAt: string | null, lastAt: string | null): string | null {
  if (!(firstAt && lastAt)) {
    return null;
  }
  const start = Date.parse(firstAt);
  const end = Date.parse(lastAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  const totalSeconds = Math.round((end - start) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} m` : `${minutes} m ${seconds} s`;
}

/** Build the deep link to browse one stream's records for a connection. */
export function browseStreamHref(connectionId: string, stream: string): string {
  const params = new URLSearchParams({ connection: connectionId, stream });
  return `/dashboard/explore?${params.toString()}`;
}

/** Pick the connection-level "next" phrase from the schedule. */
function describeNext(input: { schedule: RefSchedule | null | undefined; failing: boolean }): {
  next: string;
  nextAt: string | null;
} {
  if (input.failing) {
    // A failing/holding connection has no honest forward "next" — the cursor is
    // held until it resumes. The canonical mock shows "held" here.
    const backoffAt = input.schedule?.scheduler_backoff?.next_run_at ?? null;
    if (backoffAt) {
      return { next: backoffAt, nextAt: backoffAt };
    }
    return { next: "held", nextAt: null };
  }
  const dueAt = input.schedule?.next_due_at ?? null;
  if (dueAt) {
    return { next: dueAt, nextAt: dueAt };
  }
  if (input.schedule?.effective_mode === "manual") {
    return { next: "on demand", nextAt: null };
  }
  return { next: "—", nextAt: null };
}

/**
 * Build the per-connection sync rows. Each declared stream becomes one row.
 *
 * Connection-level run facts (delta, duration, lastAt, rhythm) have moved to
 * SyncGroup so they render once in the group header rather than being repeated
 * identically on every stream row. Per-stream facts come from the
 * collection_report the reference already emits (Tranche C). When
 * collection_report is absent (older reference instances), per-stream fields
 * are null/false — never the connection total.
 */
function buildSyncRows(input: {
  connector: RefConnectorSummary;
  connectionRuns: readonly RunSummary[];
  failing: boolean;
}): { rows: SyncRow[]; lastFailed: boolean; lastRun: RunSummary | null } {
  const { connector, connectionRuns, failing } = input;
  const schedule = connector.schedule;
  const cadence = describeCadence(schedule);
  const lastRun = connectionRuns.find((r) => isTerminalRunStatus(r.status)) ?? connectionRuns[0] ?? null;
  const lastFailed = lastRun ? FAILED_RUN_STATUSES.has(lastRun.status) : false;
  const { next, nextAt } = describeNext({ schedule, failing });

  // Index collection_report by stream name for O(1) per-row lookup.
  const reportByStream: Map<string, RefCollectionReportEntry> = indexCollectionReportByStream(
    connector.collection_report
  );

  const streams = connector.streams.length > 0 ? connector.streams : [connector.connector_id];
  const rows = streams.map((stream): SyncRow => {
    const reportEntry = reportByStream.get(stream) ?? null;
    return {
      stream,
      cadence,
      next,
      nextAt,
      // `failed` is the connection-level last-run outcome, used only as a
      // fallback for streams that have NO per-stream report. When a stream
      // has its own collection_report entry, that per-stream truth governs
      // its display, so the connection-level failure must not override it.
      failed: lastFailed && reportEntry === null,
      browseHref: browseStreamHref(connector.connection_id, stream),
      // Per-stream facts from collection_report. Null when absent (honest
      // empty state for pre-Tranche-C references).
      collectedThisRun: reportEntry !== null && Number.isFinite(reportEntry.collected) ? reportEntry.collected : null,
      coverageCondition: reportEntry === null ? null : reportEntry.coverage_condition,
      streamSkipped: reportEntry !== null && reportEntry.skipped !== null,
    };
  });
  return { rows, lastFailed, lastRun };
}

/**
 * Build the health stat band. "On schedule" counts streams under healthy
 * connections. "Need your hand" counts ONLY connections whose rendered verdict
 * says the owner is the sole resolution. Advisory refresh/retry accelerants and
 * source-pressure waits do not inflate that number.
 */
function buildHealthBand(input: { groups: SyncGroup[]; failureCards: FailureCard[] }): HealthBand {
  const onSchedule = input.groups.filter((g) => g.health === "ok").reduce((sum, g) => sum + g.totalStreamCount, 0);
  const needYourHand = input.failureCards.filter((c) => c.summary.ownerActionRequired).length;
  const needsReview = input.failureCards.length;
  return {
    onSchedule,
    needYourHand,
    needsReview,
    allClear: needsReview === 0,
  };
}

interface SyncProjection {
  connector: RefConnectorSummary;
  failing: boolean;
  group: SyncGroup;
  lastAtMs: number;
  summary: FailureSummary | null;
}

function groupPriority(projection: SyncProjection): number {
  if (verdictRequiresOwnerNow(projection.connector.rendered_verdict ?? null)) {
    return 0;
  }
  if (projection.summary?.ownerActionRequired) {
    return 1;
  }
  if (projection.summary) {
    return 2;
  }
  if (projection.failing) {
    return 3;
  }
  return 4;
}

function compareProjection(a: SyncProjection, b: SyncProjection): number {
  return (
    groupPriority(a) - groupPriority(b) ||
    b.lastAtMs - a.lastAtMs ||
    a.group.name.localeCompare(b.group.name) ||
    a.group.connectionId.localeCompare(b.group.connectionId)
  );
}

function collapseDuplicateFallbackProjections(projections: readonly SyncProjection[]): {
  duplicateGroups: DuplicateSyncGroup[];
  visible: SyncProjection[];
} {
  const byConnector = new Map<string, SyncProjection[]>();
  for (const projection of projections) {
    if (!hasFallbackConnectionLabel(projection.connector)) {
      continue;
    }
    const bucket = byConnector.get(projection.connector.connector_id);
    if (bucket) {
      bucket.push(projection);
    } else {
      byConnector.set(projection.connector.connector_id, [projection]);
    }
  }

  const collapsedIds = new Set<string>();
  const duplicateGroups: DuplicateSyncGroup[] = [];
  for (const [connectorId, bucket] of byConnector) {
    if (bucket.length < DUPLICATE_SYNC_GROUP_MIN_UNNAMED) {
      continue;
    }
    const sortedBucket = [...bucket].sort(compareProjection);
    for (const projection of sortedBucket) {
      collapsedIds.add(projection.connector.connection_id);
    }
    const first = sortedBucket[0];
    if (!first) {
      continue;
    }
    duplicateGroups.push({
      advisoryCount: sortedBucket.filter((projection) => projection.summary !== null).length,
      connectorId,
      firstConnectionId: first.connector.connection_id,
      kind: connectorKind(first.connector),
      ownerActionCount: sortedBucket.filter((projection) => projection.summary?.ownerActionRequired).length,
      streamCount: sortedBucket.reduce((sum, projection) => sum + projection.group.totalStreamCount, 0),
      total: sortedBucket.length,
    });
  }

  return {
    duplicateGroups: duplicateGroups.sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind)),
    visible: projections.filter((projection) => !collapsedIds.has(projection.connector.connection_id)),
  };
}

/** Maps a SyncProjection to the FailureCard shape used in the view-model. */
function toFailureCard(projection: SyncProjection): FailureCard {
  return {
    name: projection.connector.display_name,
    connectionId: projection.connector.connection_id,
    connectorId: projection.connector.connector_id,
    summary: projection.summary as FailureSummary,
  };
}

/**
 * Build the entire Syncs view-model from the three real contracts.
 *
 * @param connectors per-connection summaries (`_ref/connectors`), the source of
 *   health + schedule + stream list. The list defines which connections render.
 * @param runs the runs feed (`_ref/runs`), newest-first, used for Rhythm ticks
 *   and the last-result delta/when per connection.
 */
export function buildSyncsViewModel(input: {
  connectors: readonly RefConnectorSummary[];
  runs: readonly RunSummary[];
}): SyncsViewModel {
  const projections: SyncProjection[] = [];

  for (const connector of input.connectors) {
    // Revoked connections are not active syncs; skip them from the live surface.
    if (connector.revoked_at) {
      continue;
    }
    const summary = deriveFailureSummary(connector.connection_health, connector.rendered_verdict ?? null);
    const renderedHealth = renderedVerdictGroupHealth(connector.rendered_verdict ?? null);
    const failing = (renderedHealth ?? connectionHealth(summary)) === "failing";
    const connectionRuns = connectionRunHistory({ connector, runs: input.runs });
    const { rows, lastFailed, lastRun } = buildSyncRows({ connector, connectionRuns, failing });
    const lastAt = lastRun?.last_at ?? connector.last_run?.last_at ?? connector.last_successful_run?.last_at ?? null;
    const lastAtMs = lastAt ? Date.parse(lastAt) : 0;
    const eventCount = lastRun ? lastRun.event_count : null;
    const lastRunDelta = lastRun === null ? null : describeDelta({ failed: lastFailed, eventCount });
    const lastRunDuration = describeDuration(lastRun?.first_at ?? null, lastRun?.last_at ?? null);
    const lastRunRhythm = deriveConnectionRhythm(connectionRuns);

    projections.push({
      connector,
      failing,
      lastAtMs: Number.isNaN(lastAtMs) ? 0 : lastAtMs,
      summary,
      group: {
        name: connector.display_name,
        connectionId: connector.connection_id,
        connectorId: connector.connector_id,
        health: failing ? "failing" : "ok",
        lastRunDelta,
        lastRunDuration,
        lastRunAt: lastAt,
        lastRunRhythm,
        streams: rows,
        totalStreamCount: rows.length,
      },
    });
  }

  // --- dedup / sort ---
  const { duplicateGroups, visible } = collapseDuplicateFallbackProjections(projections);
  const ordered = [...visible].sort(compareProjection);

  // --- shape output ---
  // All groups and all streams are shown — no truncation. The full catalogue
  // tops out at ~134 stream rows across 33 connectors, well under any
  // virtualization threshold.
  const groups = ordered.map((projection) => projection.group);
  // visible subset (display)
  const failureCards = ordered.filter((projection) => projection.summary !== null).map(toFailureCard);
  const allGroups = projections.map((projection) => projection.group);
  // full population (counts)
  const allFailureCards = projections.filter((projection) => projection.summary !== null).map(toFailureCard);
  // --- compute totals + return ---
  const totalStreamCount = allGroups.reduce((sum, group) => sum + group.totalStreamCount, 0);
  // The band must count the failure cards that are actually RENDERED below it
  // (`failureCards`), not the full population (`allFailureCards`). Advisories on
  // duplicate groups that were collapsed away are surfaced separately through
  // the duplicate-group panel, so counting them here would tell the owner to
  // "review the cards below" when no such card is visible.
  const band = buildHealthBand({ groups: allGroups, failureCards });
  return {
    band,
    duplicateGroups,
    failureCards,
    groups,
    totalGroupCount: projections.length,
    totalReviewCardCount: allFailureCards.length,
    totalStreamCount,
  };
}
