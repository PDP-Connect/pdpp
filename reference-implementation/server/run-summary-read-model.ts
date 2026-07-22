// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getRunTerminalEvent, listSpineCorrelations, type SpineSummary } from "../lib/spine.ts";

export interface RuntimeCollectionFactSkip {
  readonly reason: string;
  readonly recovery_action?: string;
}

/**
 * One per-stream entry of the runtime `collection_facts` block (Tranche B). These
 * are OBJECTIVE run-local facts only: the runtime stamps NO coverage condition or
 * forward disposition (those are derived on read by `buildCollectionReport`).
 * `considered` is `null` when the connector declared no considered denominator —
 * the projection reads `null` as `unknown` and NEVER infers `complete` from
 * `collected` alone.
 */
export interface RuntimeCollectionFact {
  readonly checkpoint: string | null;
  readonly collected: number;
  readonly considered: number | null;
  /**
   * Optional connector-declared `covered` count: the in-boundary items the run
   * accounted for (emitted + suppressed-because-unchanged), or `null` when the
   * connector declared none. When non-null the coverage gate compares `considered`
   * against this instead of `collected`, so a steady-state full-sync run that
   * suppressed every unchanged record reads `complete` rather than a false
   * `partial`. NEVER inferred from `collected`; a weighed-but-dropped item is in
   * neither count, so a real shortfall still reads `partial`.
   */
  readonly covered: number | null;
  readonly pending_detail_gaps: number;
  readonly skipped: RuntimeCollectionFactSkip | null;
  readonly stream: string;
}

/** The runtime `collection_facts` terminal-event block, parsed defensively. */
export interface RuntimeCollectionFacts {
  readonly streams: readonly RuntimeCollectionFact[];
}

export interface ConnectorRunSummary {
  /**
   * The runtime `collection_facts` block read off this run's terminal event, or
   * `null` for a run that predates Tranche B, exited before the terminal builder
   * ran, or carried a malformed block. Source evidence for the derived
   * `collection_report`; never final coverage truth.
   */
  readonly collection_facts: RuntimeCollectionFacts | null;
  readonly event_count: number;
  readonly failure_reason: string | null;
  readonly finished_at: string | null;
  readonly first_at: string;
  readonly known_gaps: unknown[];
  readonly last_at: string;
  readonly run_id: string | undefined;
  readonly started_at: string;
  readonly status: string;
}

// Extraction contract anchor — the raw-row shape the prior SQL SELECT produced.
// Kept as the canonical schema reference and used below to normalize the spine
// helper's parsed result back through the same null-checking / decode path.
interface RunTerminalEventRow {
  readonly data_json: string | null;
  readonly event_type?: string;
}

function decodeRunTerminalEventRow(row: RunTerminalEventRow): Record<string, unknown> | null {
  if (!row.data_json) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.data_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readRunTerminalEventData(runId: string): Promise<Record<string, unknown> | null> {
  const event = await getRunTerminalEvent(runId);
  if (!event) {
    return null;
  }
  const row: RunTerminalEventRow = {
    data_json: event.data == null ? null : JSON.stringify(event.data),
    event_type: event.event_type,
  };
  return decodeRunTerminalEventRow(row);
}

function readKnownGapsFromTerminalData(data: Record<string, unknown> | null): unknown[] {
  if (data && Array.isArray(data.known_gaps)) {
    return data.known_gaps;
  }
  return [];
}

function readSafeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readRuntimeCollectionFact(raw: unknown): RuntimeCollectionFact | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.stream !== "string" || !entry.stream) {
    return null;
  }
  return {
    checkpoint: typeof entry.checkpoint === "string" ? entry.checkpoint : null,
    collected: readFiniteNumber(entry.collected, 0),
    // `considered` and `covered` are OMITTED upstream when unknown. Re-validate
    // defensively: anything not a safe non-negative integer reads as absent,
    // never as a fabricated denominator or numerator.
    considered: readSafeNonNegativeInteger(entry.considered),
    covered: readSafeNonNegativeInteger(entry.covered),
    pending_detail_gaps: readFiniteNumber(entry.pending_detail_gaps, 0),
    skipped: readCollectionFactSkip(entry.skipped),
    stream: entry.stream,
  };
}

/**
 * Read the runtime `collection_facts` block (the Tranche B per-stream fact
 * block) off a terminal-event payload. The runtime attaches only objective,
 * run-local facts here (collected count, considered-or-`unknown`, checkpoint,
 * skip, pending-detail-gap count) and stamps NO coverage condition or forward
 * disposition — those are derived on read by the control-plane projection
 * (`buildCollectionReport`). Returns `null` for an old run that predates the
 * block, a `run.failed` that exited before the terminal builder ran, or any
 * malformed payload — absence reads as "no facts", never as `complete`.
 */
function readCollectionFactsFromTerminalData(data: Record<string, unknown> | null): RuntimeCollectionFacts | null {
  if (!data) {
    return null;
  }
  const block = data.collection_facts;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return null;
  }
  const { streams } = (block as { streams?: unknown });
  if (!Array.isArray(streams)) {
    return null;
  }
  const entries: RuntimeCollectionFact[] = [];
  for (const raw of streams) {
    const fact = readRuntimeCollectionFact(raw);
    if (fact) {
      entries.push(fact);
    }
  }
  return { streams: entries };
}

function readCollectionFactSkip(value: unknown): RuntimeCollectionFactSkip | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const skip = value as Record<string, unknown>;
  const reason = typeof skip.reason === "string" ? skip.reason : null;
  if (reason === null) {
    return null;
  }
  const recoveryAction = typeof skip.recovery_action === "string" ? skip.recovery_action : null;
  return { reason, ...(recoveryAction ? { recovery_action: recoveryAction } : {}) };
}

export async function toConnectorRunSummary(summary: SpineSummary | null): Promise<ConnectorRunSummary | null> {
  if (!summary) {
    return null;
  }
  const runId = summary.id || summary.run_id || null;
  const terminalData = runId ? await readRunTerminalEventData(runId) : null;
  const browserSurfaceFailureReason =
    summary.status === "surface_failed"
      ? summary.browser_surface_wait_reason || summary.browser_surface_status || "browser_surface_failed"
      : null;
  return {
    run_id: runId || undefined,
    status: summary.status,
    started_at: summary.first_at,
    finished_at: summary.status === "pending" ? null : summary.last_at,
    first_at: summary.first_at,
    last_at: summary.last_at,
    event_count: summary.event_count,
    failure_reason: summary.failure?.reason || browserSurfaceFailureReason,
    known_gaps: readKnownGapsFromTerminalData(terminalData),
    collection_facts: readCollectionFactsFromTerminalData(terminalData),
  };
}

function runSummaryMatchesConnection(
  summary: SpineSummary,
  connectorInstanceId: string,
  browserSurfaceProfileKey: string | null
): boolean {
  if (summary.browser_surface_profile_key) {
    return summary.browser_surface_profile_key === (browserSurfaceProfileKey ?? connectorInstanceId);
  }

  const data = summary as SpineSummary & { connector_instance_id?: unknown; connection_id?: unknown };
  return data.connector_instance_id === connectorInstanceId || data.connection_id === connectorInstanceId;
}

export function canUseConnectorWideRunSummaryFallback(input: {
  readonly activeVisibleConnectionCount: number;
  readonly browserSurfaceProfileKey: string | null;
  readonly connectorInstanceId: string;
  readonly summary: SpineSummary;
}): boolean {
  if (input.activeVisibleConnectionCount !== 1) {
    return false;
  }
  if (runSummaryMatchesConnection(input.summary, input.connectorInstanceId, input.browserSurfaceProfileKey)) {
    return true;
  }
  // Browser-backed runs carry a profile key when the runtime knows which
  // browser identity produced the run. A mismatched profile belongs to a sibling
  // or an expired setup shell and must not be borrowed by a singleton fallback.
  if (input.summary.browser_surface_profile_key) {
    return false;
  }
  // Legacy API/static/manual connectors often emitted connector-wide run events
  // before connection_id existed on the spine. When there is exactly one active
  // visible connection for that connector type, the connector-wide run is the
  // only honest source of last-run/freshness evidence for that row.
  return true;
}

export async function getLatestRunSummary(
  connectorId: string,
  status: string | null = null
): Promise<ConnectorRunSummary | null> {
  const filters = status
    ? { sourceKind: "connector", sourceId: connectorId, status, limit: 1 }
    : { sourceKind: "connector", sourceId: connectorId, limit: 1 };
  const { summaries } = await listSpineCorrelations("run", filters);
  return toConnectorRunSummary(summaries[0] ?? null);
}

export async function getLatestRunSummaryForConnection({
  activeVisibleConnectionCount,
  browserSurfaceProfileKey,
  connectorId,
  connectorInstanceId,
  listRunSummariesForConnector,
  status = null,
}: {
  readonly activeVisibleConnectionCount: number;
  readonly browserSurfaceProfileKey: string | null;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly listRunSummariesForConnector: (
    connectorId: string,
    status?: string | null
  ) => Promise<readonly SpineSummary[]>;
  readonly status?: string | null;
}): Promise<ConnectorRunSummary | null> {
  const summaries = await listRunSummariesForConnector(connectorId, status);
  const match = summaries.find((summary) =>
    runSummaryMatchesConnection(summary, connectorInstanceId, browserSurfaceProfileKey)
  );
  const fallback =
    match ??
    summaries.find((summary) =>
      canUseConnectorWideRunSummaryFallback({
        activeVisibleConnectionCount,
        browserSurfaceProfileKey,
        connectorInstanceId,
        summary,
      })
    ) ??
    null;
  return toConnectorRunSummary(fallback);
}
