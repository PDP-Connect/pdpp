// Pure derivation of a connection's device-side outbox axis and local-device
// progress from already-fetched source-instance heartbeat rows. Extracted from
// `ref-control.ts` so the god-file no longer carries the heartbeat-rollup
// taxonomy; the DB-bound reader that *fetches* the heartbeats
// (`getConnectorOutboxAxis`) stays in `ref-control.ts` and calls
// `projectConnectorOutboxAxisFromHeartbeats` / `projectLocalDeviceProgress`
// from here.
//
// `HeartbeatRow` is the shared row shape both this module and the fetcher read;
// it is owned here and imported back by `ref-control.ts`. The projection output
// types (`OutboxAxis`, `LocalDeviceProgress`, …) are imported type-only, so
// there is no runtime cycle with `ref-control.ts`.

import {
  deriveOutboxAxisFromHeartbeat,
  type OutboxAxis,
  type OutboxDiagnosticCounts,
  type OutboxStalledCause,
  rollupOutboxDiagnosticCounts,
} from "../runtime/connection-health.ts";
import type { LocalDeviceProgress } from "./ref-control.ts";

/**
 * Stale-heartbeat threshold used by the outbox axis derivation. A
 * heartbeat older than this window with pending work present is treated
 * as stalled rather than active, so a collector that died mid-drain
 * does not sit forever in `active`. Chosen as a conservative single
 * constant for the milestone; future work may tune per-connector once
 * connection-scoped policy lands.
 */
export const OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS = 30 * 60 * 1000;

export interface HeartbeatRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string | null;
  readonly deviceId: string;
  readonly deviceRevokedAt: string | null;
  readonly deviceStatus: string;
  readonly lastError?: unknown;
  readonly lastHeartbeatAt: string | null;
  readonly lastHeartbeatStatus: string | null;
  readonly lastIngestAt: string | null;
  readonly manifestGeneration: number | null;
  readonly outboxDiagnostics: OutboxDiagnosticCounts | null;
  readonly recordsPending: number | null;
  readonly sourceInstanceId: string;
  readonly sourceStatus: string;
  readonly updatedAt: string | null;
}

/**
 * Roll up per-source-instance heartbeat evidence into a single
 * connection outbox axis.
 *
 * - If no source instances exist for the connector, return `unknown`
 *   without marking the projection unreliable: the connector simply
 *   has no enrolled device-side collector, so no honest outbox claim
 *   can be made. The headline stays driven by the other axes.
 * - If at least one trusted source heartbeat exists, project each one
 *   and roll up: `stalled` dominates `active` dominates `idle`;
 *   any `unreliable: true` adds `outbox` to `unreliableSources`.
 */
interface OutboxAxisAccumulator {
  anyTrustedEvidence: boolean;
  anyUnreliable: boolean;
  sawTrustedIdle: boolean;
  sawTrustedUnknown: boolean;
  severity: "active" | "stalled" | null;
  stalledCause: OutboxStalledCause | null;
}

function escalateOutboxAxisSeverity(
  current: "active" | "stalled" | null,
  rowAxis: OutboxAxis
): "active" | "stalled" | null {
  if (rowAxis === "stalled") {
    return "stalled";
  }
  if (rowAxis === "active" && current !== "stalled") {
    return "active";
  }
  return current;
}

// When sources disagree, surface the most-actionable cause first:
// dead letters need a retry-then-rerun, a failed state read needs a rerun, and
// stale-pending also needs a rerun. Higher rank wins.
const STALLED_CAUSE_RANK: Record<OutboxStalledCause, number> = {
  dead_letter_backlog: 4,
  state_read_failed: 3,
  stale_pending: 2,
  stale_heartbeat: 1,
  transient_upload_failure: 0,
};

function escalateStalledCause(
  current: OutboxStalledCause | null,
  rowCause: OutboxStalledCause | null
): OutboxStalledCause | null {
  if (rowCause === null) {
    return current;
  }
  if (current === null) {
    return rowCause;
  }
  return STALLED_CAUSE_RANK[rowCause] > STALLED_CAUSE_RANK[current] ? rowCause : current;
}

function accumulateOutboxAxisRow(acc: OutboxAxisAccumulator, row: HeartbeatRow, nowIso: string): void {
  const trusted = row.deviceStatus === "active" && row.sourceStatus === "active" && row.deviceRevokedAt === null;
  if (trusted) {
    acc.anyTrustedEvidence = true;
  }
  const result = deriveOutboxAxisFromHeartbeat(
    {
      evidenceTrusted: trusted,
      lastHeartbeatAt: row.lastHeartbeatAt,
      lastHeartbeatStatus: normalizeHeartbeatStatusForAxis(row.lastHeartbeatStatus),
      recordsPending: row.recordsPending,
      deadLetterCount: row.outboxDiagnostics?.dead_letter ?? null,
      deadLetterErrorClasses: deadLetterErrorClassesFromHeartbeat(row.lastError),
    },
    {
      nowIso,
      staleHeartbeatThresholdMs: OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS,
    }
  );
  if (result.unreliable) {
    acc.anyUnreliable = true;
  }
  if (!trusted) {
    return;
  }
  acc.severity = escalateOutboxAxisSeverity(acc.severity, result.axis);
  acc.stalledCause = escalateStalledCause(acc.stalledCause, result.cause);
  if (result.axis === "idle") {
    acc.sawTrustedIdle = true;
  } else if (result.axis === "unknown") {
    acc.sawTrustedUnknown = true;
  }
}

export function projectConnectorOutboxAxisFromHeartbeats(
  heartbeats: readonly HeartbeatRow[],
  options: { readonly nowIso: string }
): { axis: OutboxAxis; cause: OutboxStalledCause | null; unreliable: boolean; hasEvidence: boolean } {
  if (heartbeats.length === 0) {
    return { axis: "unknown", cause: null, unreliable: false, hasEvidence: false };
  }
  // Track each trusted row's contribution separately. We can only claim
  // `idle` when every trusted row reports idle; a trusted row whose
  // heartbeat we have never observed (axis = unknown) must not be
  // silently treated as idle, or a dead collector with no record of life
  // would paint the connection green.
  const acc: OutboxAxisAccumulator = {
    anyUnreliable: false,
    anyTrustedEvidence: false,
    sawTrustedIdle: false,
    sawTrustedUnknown: false,
    severity: null,
    stalledCause: null,
  };
  for (const row of heartbeats) {
    accumulateOutboxAxisRow(acc, row, options.nowIso);
  }
  // If every row is untrusted (e.g. all sources/devices revoked), there
  // is no honest evidence — keep `unknown` rather than implying idle.
  if (!acc.anyTrustedEvidence) {
    return { axis: "unknown", cause: null, unreliable: acc.anyUnreliable, hasEvidence: false };
  }
  if (acc.severity !== null) {
    // Cause only travels with a stalled axis; an `active` rollup carries none.
    const cause = acc.severity === "stalled" ? acc.stalledCause : null;
    return { axis: acc.severity, cause, unreliable: acc.anyUnreliable, hasEvidence: true };
  }
  // No trusted instance is actively working or stalled. We can only
  // promise `idle` when every trusted instance reported idle — a missing
  // heartbeat on any trusted instance keeps the axis `unknown`.
  if (acc.sawTrustedIdle && !acc.sawTrustedUnknown) {
    return { axis: "idle", cause: null, unreliable: acc.anyUnreliable, hasEvidence: true };
  }
  return { axis: "unknown", cause: null, unreliable: acc.anyUnreliable, hasEvidence: acc.sawTrustedIdle };
}

function deadLetterErrorClassesFromHeartbeat(value: unknown): { count: number; error_class: string }[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { kind?: unknown; top_dead_letter_classes?: unknown };
  if (record.kind !== "dead_letter_backlog" || !Array.isArray(record.top_dead_letter_classes)) {
    return null;
  }
  const classes: { count: number; error_class: string }[] = [];
  for (const item of record.top_dead_letter_classes) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as { count?: unknown; error_class?: unknown };
    if (typeof row.error_class === "string" && typeof row.count === "number" && Number.isFinite(row.count)) {
      classes.push({ error_class: row.error_class, count: row.count });
    }
  }
  return classes.length > 0 ? classes : null;
}

function normalizeHeartbeatStatusForAxis(
  value: string | null
): "blocked" | "healthy" | "retrying" | "starting" | "stopped" | null {
  switch (value) {
    case "blocked":
    case "healthy":
    case "retrying":
    case "starting":
    case "stopped":
      return value;
    default:
      return null;
  }
}

/**
 * Project a single `LocalDeviceProgress` from already-collected heartbeat
 * rows. Pure — the caller (typically `getConnectorOutboxAxis`) is
 * responsible for scoping the rows to one `connector_instance_id`.
 *
 * Returns `null` when no trusted source rows exist; we do not surface
 * device-side progress derived solely from revoked / inactive rows.
 */
export function projectLocalDeviceProgress(heartbeats: readonly HeartbeatRow[]): LocalDeviceProgress | null {
  const trusted = heartbeats.filter(
    (row) => row.deviceStatus === "active" && row.sourceStatus === "active" && row.deviceRevokedAt === null
  );
  if (trusted.length === 0) {
    return null;
  }
  let lastHeartbeatAt: string | null = null;
  let lastHeartbeatStatus: string | null = null;
  let lastIngestAt: string | null = null;
  let recordsPending = 0;
  let sawPending = false;
  let manifestGeneration: number | null = null;
  for (const row of trusted) {
    if (row.lastHeartbeatAt !== null && (lastHeartbeatAt === null || row.lastHeartbeatAt > lastHeartbeatAt)) {
      lastHeartbeatAt = row.lastHeartbeatAt;
      lastHeartbeatStatus = row.lastHeartbeatStatus;
      manifestGeneration = row.manifestGeneration;
    }
    if (row.lastIngestAt !== null && (lastIngestAt === null || row.lastIngestAt > lastIngestAt)) {
      lastIngestAt = row.lastIngestAt;
    }
    if (typeof row.recordsPending === "number") {
      recordsPending += row.recordsPending;
      sawPending = true;
    }
  }
  return {
    last_heartbeat_at: lastHeartbeatAt,
    last_heartbeat_status: lastHeartbeatStatus,
    last_ingest_at: lastIngestAt,
    manifest_generation: manifestGeneration,
    // Roll up the per-source outbox diagnostics across the same trusted
    // rows we already use for `records_pending`, so the connection summary
    // can show the pending / dead-letter / stale-lease breakdown a stalled
    // remediation needs. Revoked / inactive rows are filtered out above, so
    // counts never leak from an untrusted device.
    outbox_counts: rollupOutboxDiagnosticCounts(trusted.map((row) => row.outboxDiagnostics)),
    records_pending: sawPending ? recordsPending : null,
    source_count: trusted.length,
  };
}
