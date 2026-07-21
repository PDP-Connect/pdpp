/**
 * Canonical `ref.dataset.summary.streams` operation.
 *
 * Owns the envelope semantics for the reference-only owner-facing
 * per-`(connector_id, stream)` retained-size inspection endpoint that
 * powers `GET /_ref/dataset/summary/streams`. The host adapter (Fastify
 * route in `reference-implementation/server/index.js`) owns owner
 * authentication and response writing; the operation owns input
 * normalization and the response envelope.
 *
 * This is reference/operator surface, not PDPP protocol. The operation
 * MUST NOT be promoted into PDPP-stable wire semantics. `record_json_bytes`
 * remains an adapter-native operator diagnostic, consistent with the
 * existing `ref.dataset.summary` operation and
 * `define-reference-operation-environments` contract correction (4).
 *
 * Boundary rules (mirrors the existing `ref.dataset.summary` operation):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules,
 *   `reference-implementation/server/records.js`,
 *   `reference-implementation/server/index.js`, or `process`
 *   / `process.env`.
 * - All projection rows and metadata flow in through capability
 *   dependencies. The operation does not look at storage internals.
 *
 * What the operation owns:
 *   - input normalization: `connector_id` is trimmed and treated as
 *     `null` when empty;
 *   - per-row coercion: `record_count` and `record_json_bytes` are
 *     non-negative numbers; `dirty_record_time_bounds` is a boolean;
 *     missing time-bound fields stay `null` rather than being
 *     zero-filled;
 *   - envelope assembly: `object: 'dataset_summary_streams'`, the
 *     `streams` array (host-supplied order is preserved), and the
 *     `projection` metadata block (same shape as the existing
 *     `ref.dataset.summary` projection metadata).
 */

import type { RefDatasetSummaryProjectionMetadata } from "../ref-dataset-summary/index.ts";

export interface RefDatasetSummaryStreamRow {
  connector_id: string;
  stream: string;
  record_count: number;
  record_json_bytes: number;
  earliest_ingested_at: string | null;
  latest_ingested_at: string | null;
  earliest_record_time: string | null;
  latest_record_time: string | null;
  consent_time_field: string | null;
  dirty_record_time_bounds: boolean;
  computed_at: string | null;
}

export interface RefDatasetSummaryStreamsInput {
  readonly connector_id?: string | null;
}

export interface RefDatasetSummaryStreamsListInput {
  readonly connectorId: string | null;
}

export interface RefDatasetSummaryStreamsDependencies {
  /**
   * Read the per-`(connector_id, stream)` projection rows. The host
   * implementation reads `dataset_summary_stream_projection` directly
   * (SQLite) or the equivalent Postgres retained-size projection. The
   * operation owns the envelope assembly; the dependency owns the
   * substrate read and the deterministic sort by
   * `(connector_id, stream)`.
   */
  listStreams(
    input: RefDatasetSummaryStreamsListInput,
  ):
    | Promise<readonly RefDatasetSummaryStreamRow[]>
    | readonly RefDatasetSummaryStreamRow[];
  /**
   * Resolve the same projection-freshness metadata block the dashboard
   * already consumes from `ref.dataset.summary`. The operation does not
   * try to derive freshness from row state; the host returns the
   * authoritative metadata.
   */
  getProjectionMetadata():
    | Promise<RefDatasetSummaryProjectionMetadata>
    | RefDatasetSummaryProjectionMetadata;
}

export interface RefDatasetSummaryStreamsEnvelope {
  object: "dataset_summary_streams";
  streams: RefDatasetSummaryStreamRow[];
  filters: {
    connector_id: string | null;
  };
  projection: RefDatasetSummaryProjectionMetadata;
}

function normalizeConnectorIdFilter(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function coerceTimeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

function coerceNonNegativeNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function coerceRow(row: RefDatasetSummaryStreamRow): RefDatasetSummaryStreamRow {
  return {
    connector_id: String(row.connector_id),
    stream: String(row.stream),
    record_count: coerceNonNegativeNumber(row.record_count),
    record_json_bytes: coerceNonNegativeNumber(row.record_json_bytes),
    earliest_ingested_at: coerceTimeString(row.earliest_ingested_at),
    latest_ingested_at: coerceTimeString(row.latest_ingested_at),
    earliest_record_time: coerceTimeString(row.earliest_record_time),
    latest_record_time: coerceTimeString(row.latest_record_time),
    consent_time_field:
      typeof row.consent_time_field === "string" && row.consent_time_field.length > 0
        ? row.consent_time_field
        : null,
    dirty_record_time_bounds: Boolean(row.dirty_record_time_bounds),
    computed_at: coerceTimeString(row.computed_at),
  };
}

/**
 * Execute the canonical `ref.dataset.summary.streams` operation.
 *
 * Hosts pass capability-shaped dependencies; the operation normalizes
 * the input, calls `listStreams` + `getProjectionMetadata`, and
 * assembles the envelope. The operation has no notion of HTTP, owner
 * sessions, headers, or framework — it returns the envelope and lets
 * the host write the response.
 */
export async function executeRefDatasetSummaryStreams(
  input: RefDatasetSummaryStreamsInput,
  dependencies: RefDatasetSummaryStreamsDependencies,
): Promise<RefDatasetSummaryStreamsEnvelope> {
  const connectorId = normalizeConnectorIdFilter(input?.connector_id);
  const [rows, metadata] = await Promise.all([
    Promise.resolve(dependencies.listStreams({ connectorId })),
    Promise.resolve(dependencies.getProjectionMetadata()),
  ]);
  const streams = (rows || []).map(coerceRow);
  return {
    object: "dataset_summary_streams",
    streams,
    filters: {
      connector_id: connectorId,
    },
    projection: metadata,
  };
}
