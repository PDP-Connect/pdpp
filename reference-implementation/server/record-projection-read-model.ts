// Read model: retained-bytes / record-projection cluster.
//
// Owns the 5 projection functions, 4 private interfaces, 2 exported types
// (StreamRecordSummary, RetainedBytesBreakdown), and buildFreshness (module-private).
// ref-control.ts is a facade consumer; this module must NOT import it.

import { deriveReferenceFreshness, type ReferenceFreshness } from "./freshness.ts";
import { listRetainedSizeConnections, listRetainedSizeStreams } from "./retained-size-read-model.js";

type Freshness = ReferenceFreshness;

// ─── Private interfaces ──────────────────────────────────────────────────────

interface RecordProjection {
  readonly byStream: Map<string, StreamProjection>;
  readonly freshness: Freshness;
  readonly retainedBytes: RetainedBytesBreakdown | null;
  readonly totalRecords: number;
}

interface StreamProjection {
  readonly freshness: Freshness;
  readonly last_updated: string | null;
  readonly record_count: number;
}

interface RecordProjectionRow {
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  readonly last_updated: string | null;
  readonly record_count: number | string | null;
  readonly stream: string;
}

interface RetainedSizeConnectionProjectionRow {
  readonly blob_bytes?: number | string | null;
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  readonly current_record_json_bytes?: number | string | null;
  readonly record_history_json_bytes?: number | string | null;
}

// Narrow structural shape for the snapshot — no import from ref-control needed.
interface RetainedSizeSnapshotLike {
  readonly connectionsByInstanceId: ReadonlyMap<string, RetainedSizeConnectionProjectionRow>;
  readonly streamsByConnectorId: ReadonlyMap<string, readonly RecordProjectionRow[]>;
  readonly streamsByInstanceId: ReadonlyMap<string, readonly RecordProjectionRow[]>;
}

// ─── Exported types ───────────────────────────────────────────────────────────

export interface StreamRecordSummary {
  readonly last_updated: string | null;
  readonly record_count: number;
  readonly stream: string;
}

export interface RetainedBytesBreakdown {
  readonly blob_bytes: number;
  readonly record_changes_json_bytes: number;
  readonly record_json_bytes: number;
  readonly total_bytes: number;
}

// ─── Module-private helpers ───────────────────────────────────────────────────

function buildFreshness(lastUpdated: string | null = null): Freshness {
  return deriveReferenceFreshness({ recordLastUpdatedAt: lastUpdated });
}

// ─── Exported functions ───────────────────────────────────────────────────────

async function getRetainedBytesForConnection(connectorInstanceId: string): Promise<RetainedBytesBreakdown | null> {
  const row = (await listRetainedSizeConnections({ connectorInstanceId }))[0] as
    | {
        current_record_json_bytes?: number;
        record_history_json_bytes?: number;
        blob_bytes?: number;
      }
    | undefined;
  if (!row) {
    return null;
  }
  const recordJsonBytes = Number(row.current_record_json_bytes || 0);
  const recordChangesJsonBytes = Number(row.record_history_json_bytes || 0);
  const blobBytes = Number(row.blob_bytes || 0);
  return {
    blob_bytes: blobBytes,
    record_changes_json_bytes: recordChangesJsonBytes,
    record_json_bytes: recordJsonBytes,
    total_bytes: recordJsonBytes + recordChangesJsonBytes + blobBytes,
  };
}

function retainedBytesFromConnectionRow(
  row: RetainedSizeConnectionProjectionRow | undefined
): RetainedBytesBreakdown | null {
  if (!row) {
    return null;
  }
  const recordJsonBytes = Number(row.current_record_json_bytes || 0);
  const recordChangesJsonBytes = Number(row.record_history_json_bytes || 0);
  const blobBytes = Number(row.blob_bytes || 0);
  return {
    blob_bytes: blobBytes,
    record_changes_json_bytes: recordChangesJsonBytes,
    record_json_bytes: recordJsonBytes,
    total_bytes: recordJsonBytes + recordChangesJsonBytes + blobBytes,
  };
}

function buildRecordProjectionFromRetainedRows(input: {
  readonly retainedBytes: RetainedBytesBreakdown | null;
  readonly rows: readonly RecordProjectionRow[];
}): RecordProjection {
  const byStream = new Map<string, StreamProjection>();
  let latest: string | null = null;
  for (const row of input.rows) {
    const recordCount = Number(row.record_count || 0);
    const lastUpdated = row.last_updated || null;
    byStream.set(row.stream, {
      record_count: recordCount,
      last_updated: lastUpdated,
      freshness: buildFreshness(lastUpdated),
    });
    if (lastUpdated && (!latest || lastUpdated > latest)) {
      latest = lastUpdated;
    }
  }
  return {
    byStream,
    freshness: buildFreshness(latest),
    retainedBytes: input.retainedBytes,
    totalRecords: input.rows.reduce((sum, row) => sum + Number(row.record_count || 0), 0),
  };
}

function projectStreamRecordSummaries(byStream: ReadonlyMap<string, StreamProjection>): StreamRecordSummary[] {
  return [...byStream.entries()]
    .map(([stream, projection]) => ({
      stream,
      record_count: projection.record_count,
      last_updated: projection.last_updated,
    }))
    .sort((a, b) => a.stream.localeCompare(b.stream));
}

async function getConnectorRecordProjection(
  connectorId: string,
  connectorInstanceId?: string,
  snapshot?: RetainedSizeSnapshotLike
): Promise<RecordProjection> {
  let rows: RecordProjectionRow[];
  if (connectorInstanceId && snapshot) {
    rows = [...(snapshot.streamsByInstanceId.get(connectorInstanceId) ?? [])];
    return buildRecordProjectionFromRetainedRows({
      rows,
      retainedBytes: retainedBytesFromConnectionRow(snapshot.connectionsByInstanceId.get(connectorInstanceId)),
    });
  }
  if (!connectorInstanceId && snapshot) {
    rows = [...(snapshot.streamsByConnectorId.get(connectorId) ?? [])];
    return buildRecordProjectionFromRetainedRows({ rows, retainedBytes: null });
  }
  if (connectorInstanceId) {
    rows = (await listRetainedSizeStreams({ connectorInstanceId })).map(
      (row: { connector_id?: string; connector_instance_id?: string; stream: string; record_count?: number }) => ({
        connector_id: row.connector_id,
        connector_instance_id: row.connector_instance_id,
        stream: row.stream,
        record_count: Number(row.record_count || 0),
        last_updated: null,
      })
    ) as RecordProjectionRow[];
  } else {
    rows = (await listRetainedSizeStreams({}))
      .filter((row: { connector_id?: string }) => row.connector_id === connectorId)
      .map((row: { connector_id?: string; connector_instance_id?: string; stream: string; record_count?: number }) => ({
        connector_id: row.connector_id,
        connector_instance_id: row.connector_instance_id,
        stream: row.stream,
        record_count: Number(row.record_count || 0),
        last_updated: null,
      })) as RecordProjectionRow[];
  }
  return buildRecordProjectionFromRetainedRows({
    rows,
    retainedBytes: connectorInstanceId ? await getRetainedBytesForConnection(connectorInstanceId) : null,
  });
}

export {
  buildRecordProjectionFromRetainedRows,
  getConnectorRecordProjection,
  getRetainedBytesForConnection,
  projectStreamRecordSummaries,
  retainedBytesFromConnectionRow,
};
