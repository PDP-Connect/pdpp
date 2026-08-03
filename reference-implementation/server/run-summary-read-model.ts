// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getRunTerminalEvent, listSpineCorrelations, type SpineSummary } from "../lib/spine.ts";
import type { RuntimeCollectionFacts } from "./ref-control.ts";
import { readCollectionFactsFromTerminalData } from "./runtime-collection-facts.ts";

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
    data_json: event.data === null ? null : JSON.stringify(event.data),
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
    collection_facts: readCollectionFactsFromTerminalData(terminalData),
    event_count: summary.event_count,
    failure_reason: summary.failure?.reason || browserSurfaceFailureReason,
    finished_at: summary.status === "pending" ? null : summary.last_at,
    first_at: summary.first_at,
    known_gaps: readKnownGapsFromTerminalData(terminalData),
    last_at: summary.last_at,
    run_id: runId || undefined,
    started_at: summary.first_at,
    status: summary.status,
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
    ? { limit: 1, sourceId: connectorId, sourceKind: "connector", status }
    : { limit: 1, sourceId: connectorId, sourceKind: "connector" };
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
