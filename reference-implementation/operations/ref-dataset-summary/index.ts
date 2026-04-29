/**
 * Canonical `ref.dataset.summary` operation.
 *
 * Owns the envelope semantics for the reference-only operator-console hero
 * band that powers `GET /_ref/dataset/summary` (native Fastify) and
 * `GET /sandbox/_ref/dataset/summary` (Next sandbox). Both hosts mount this
 * operation; the host adapter still owns owner authentication, response
 * writing, and capability dependency wiring.
 *
 * This is reference/operator surface, not PDPP protocol. The operation MUST
 * NOT be promoted into PDPP-stable wire semantics — relabeling
 * `record_json_bytes` (currently a SQLite-native operator diagnostic per
 * `define-reference-operation-environments` contract correction (4)) is a
 * separate `_ref/dataset/summary` contract change. The operation deliberately
 * preserves the legacy field name and meaning rather than presenting it as a
 * portable / protocol-stable metric.
 *
 * Boundary rules (see openspec/changes/mount-ref-dataset-summary-operation):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres, a
 *   raw SQL handle, sandbox modules, `reference-implementation/server/records.js`,
 *   `reference-implementation/server/index.js`, or `process` / `process.env`.
 * - All counts, byte sums, time bounds, and top-connector candidates flow in
 *   through capability dependencies. The operation does not look at adapter
 *   internals.
 * - The operation owns envelope assembly: `object: 'dataset_summary'`,
 *   `total_retained_bytes` derivation, top-connector sort/tiebreak/limit,
 *   `dataset_connector_summary` envelope wrapping, and the empty-corpus
 *   collapse rule for record-time and ingest-time bounds.
 *
 * What the operation owns:
 *   - envelope shape (every field name and the `object` discriminator);
 *   - `total_retained_bytes` = `record_json_bytes + record_changes_json_bytes
 *     + blob_bytes`, three concepts kept separately labeled so callers can
 *     disambiguate;
 *   - `top_connectors` slot: sort candidates by `record_count` descending
 *     with a tiebreak on `connector_id` ascending, take at most three, wrap
 *     each as `{object: 'dataset_connector_summary', connector_id,
 *     record_count}`;
 *   - empty-corpus collapse: when `record_count === 0`, emit
 *     `earliest_record_time`, `latest_record_time`, `earliest_ingested_at`,
 *     and `latest_ingested_at` as `null` and skip the time-bound dependency
 *     calls. This matches the previous native `getDatasetSummary` short-
 *     circuit and the previous sandbox `buildLiveDatasetSummary` behavior.
 */

export interface RefDatasetSummaryCounts {
  /**
   * Distinct connector identifiers contributing to the live records
   * substrate. Adapter-defined ("distinct (connector_id) in records WHERE
   * deleted = 0" on the native SQLite side; `DEMO_CONNECTORS.length` on the
   * sandbox side).
   */
  connector_count: number;
  /**
   * Distinct `(connector_id, stream)` observations in the live records
   * substrate. Not a manifest-declared count; it reflects what was actually
   * ingested.
   */
  stream_count: number;
  /** Live record count (excludes soft-deleted rows on the native side). */
  record_count: number;
}

export interface RefDatasetSummaryRetainedBytes {
  /**
   * Sum of live record JSON bytes. Adapter-native operator diagnostic; not a
   * PDPP-stable metric. Preserve this label until a future
   * `_ref/dataset/summary` contract change relabels or namespaces it.
   */
  record_json_bytes: number;
  /**
   * Sum of `record_changes` JSON bytes (historical versions retained for
   * change tracking on the native side; `0` on the sandbox side).
   */
  record_changes_json_bytes: number;
  /** Sum of `blobs` table bytes (`0` on the sandbox side). */
  blob_bytes: number;
}

export interface RefDatasetSummaryTimeBounds {
  /** Earliest ISO timestamp observed, or `null` when no values exist. */
  earliest: string | null;
  /** Latest ISO timestamp observed, or `null` when no values exist. */
  latest: string | null;
}

export interface RefDatasetSummaryConnectorCandidate {
  connector_id: string;
  record_count: number;
}

export interface RefDatasetSummaryDependencies {
  /**
   * Aggregate counts (connectors, streams, records) over the live records
   * substrate. The operation calls this once per execution.
   */
  getCounts(): Promise<RefDatasetSummaryCounts> | RefDatasetSummaryCounts;
  /**
   * Three byte sums kept separately labeled so the operator can disambiguate
   * the substrate's storage footprint. The operation calls this once per
   * execution; the operation derives `total_retained_bytes` from the result.
   */
  getRetainedBytes():
    | Promise<RefDatasetSummaryRetainedBytes>
    | RefDatasetSummaryRetainedBytes;
  /**
   * Real-world record-time bounds across streams the manifest declares as
   * temporally meaningful (`consent_time_field`). The operation calls this
   * only when `record_count > 0`; adapters MAY assume that gate.
   */
  getRecordTimeBounds():
    | Promise<RefDatasetSummaryTimeBounds>
    | RefDatasetSummaryTimeBounds;
  /**
   * Substrate ingest-time bounds (`emitted_at`). The operation calls this
   * only when `record_count > 0`; adapters MAY assume that gate.
   */
  getIngestedTimeBounds():
    | Promise<RefDatasetSummaryTimeBounds>
    | RefDatasetSummaryTimeBounds;
  /**
   * Candidate connectors for the top-N slot. Adapters MAY return more
   * candidates than the operation's emit limit (the operation owns the
   * limit). Order is not required from the dependency — the operation
   * sorts by `record_count` descending with a `connector_id` ascending
   * tiebreak so both adapters cannot drift.
   */
  listTopConnectorCandidates():
    | Promise<RefDatasetSummaryConnectorCandidate[]>
    | RefDatasetSummaryConnectorCandidate[];
}

export interface RefDatasetSummaryConnectorEntry {
  object: "dataset_connector_summary";
  connector_id: string;
  record_count: number;
}

export interface RefDatasetSummaryEnvelope {
  object: "dataset_summary";
  connector_count: number;
  stream_count: number;
  record_count: number;
  record_json_bytes: number;
  record_changes_json_bytes: number;
  blob_bytes: number;
  total_retained_bytes: number;
  earliest_record_time: string | null;
  latest_record_time: string | null;
  earliest_ingested_at: string | null;
  latest_ingested_at: string | null;
  top_connectors: RefDatasetSummaryConnectorEntry[];
}

const TOP_CONNECTOR_LIMIT = 3;

function sortAndLimitTopConnectors(
  candidates: RefDatasetSummaryConnectorCandidate[],
): RefDatasetSummaryConnectorEntry[] {
  const sorted = [...candidates].sort((a, b) => {
    if (b.record_count !== a.record_count) {
      return b.record_count - a.record_count;
    }
    return a.connector_id.localeCompare(b.connector_id);
  });
  return sorted.slice(0, TOP_CONNECTOR_LIMIT).map((entry) => ({
    object: "dataset_connector_summary" as const,
    connector_id: entry.connector_id,
    record_count: entry.record_count,
  }));
}

/**
 * Execute the canonical `ref.dataset.summary` operation.
 *
 * Hosts pass capability-shaped dependencies; the operation assembles the
 * `dataset_summary` envelope. The operation has no notion of HTTP, owner
 * sessions, headers, or framework — it returns the envelope and lets the
 * host write the response.
 */
export async function executeRefDatasetSummary(
  dependencies: RefDatasetSummaryDependencies,
): Promise<RefDatasetSummaryEnvelope> {
  const counts = await dependencies.getCounts();
  const bytes = await dependencies.getRetainedBytes();
  const candidates = await dependencies.listTopConnectorCandidates();

  const recordCount = counts.record_count;
  const recordTimeBounds: RefDatasetSummaryTimeBounds =
    recordCount > 0
      ? await dependencies.getRecordTimeBounds()
      : { earliest: null, latest: null };
  const ingestedTimeBounds: RefDatasetSummaryTimeBounds =
    recordCount > 0
      ? await dependencies.getIngestedTimeBounds()
      : { earliest: null, latest: null };

  const totalRetainedBytes =
    bytes.record_json_bytes +
    bytes.record_changes_json_bytes +
    bytes.blob_bytes;

  return {
    object: "dataset_summary",
    connector_count: counts.connector_count,
    stream_count: counts.stream_count,
    record_count: recordCount,
    record_json_bytes: bytes.record_json_bytes,
    record_changes_json_bytes: bytes.record_changes_json_bytes,
    blob_bytes: bytes.blob_bytes,
    total_retained_bytes: totalRetainedBytes,
    earliest_record_time: recordTimeBounds.earliest,
    latest_record_time: recordTimeBounds.latest,
    earliest_ingested_at: ingestedTimeBounds.earliest,
    latest_ingested_at: ingestedTimeBounds.latest,
    top_connectors: sortAndLimitTopConnectors(candidates),
  };
}
