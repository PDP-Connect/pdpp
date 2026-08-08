// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure render-models for the deployment page's stream-grain and
// record/blob top-N storage sections.
//
// Both grains are already computed by the retained-size projection and
// already exposed at `GET /_ref/dataset/size?grain=stream` and
// `GET /_ref/dataset/top?scope=record|blob&measure=...` — this module only
// turns those already-bounded server responses into display strings, with
// no JSX or I/O, so it can be pinned by `.test.ts` unit tests. No new
// endpoint, no client-side pagination: `top` rows are already capped
// server-side at `MAX_TOP_LIMIT` (25, `retained-size-read-model.ts:129`).
//
// Invariants this enforces (same class as `source-storage.ts`):
//   - A missing/non-finite byte value renders as `—`, never a fabricated
//     `0 B`.
//   - These are LOGICAL bytes (JSON/blob byte length), never summed with or
//     compared to the physical on-disk footprint rendered elsewhere on the
//     page.

import { formatStorageBytes } from "./storage-footprint.ts";

export interface DatasetStreamSizeInput {
  readonly blob_bytes?: number | null;
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  readonly current_record_json_bytes?: number | null;
  readonly stream?: string | null;
  readonly total_retained_bytes?: number | null;
}

/**
 * The `connector_instance_id -> human connection label` lookup this module
 * needs to disambiguate stream rows. Built by the caller from the same
 * connector-summary list (`GET /_ref/connectors`) that already backs
 * `buildSourceStorageModel` — no new endpoint. Declared locally (not
 * importing `RefConnectorSummary`) for the same reuse reason as
 * `SourceStorageInput`.
 */
export interface StreamConnectionLabelInput {
  readonly connector_instance_id?: string | null;
  readonly display_name?: string | null;
  readonly revoked_at?: string | null;
}

/**
 * Build a `connector_instance_id -> label` map for disambiguating stream
 * rows that share a `connector_id`. Falls back to the bare
 * `connector_instance_id` when a connection has no display name — never a
 * fabricated or guessed label. A revoked connection is marked "(revoked)" so
 * a duplicate `chatgpt / messages` row doesn't read as three equally-live
 * connections when two are gone.
 */
export function buildStreamConnectionLabels(
  connections: readonly StreamConnectionLabelInput[]
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const connection of connections) {
    if (typeof connection.connector_instance_id !== "string" || connection.connector_instance_id.length === 0) {
      continue;
    }
    const display =
      typeof connection.display_name === "string" && connection.display_name.length > 0
        ? connection.display_name
        : connection.connector_instance_id;
    const label = connection.revoked_at ? `${display} (revoked)` : display;
    labels.set(connection.connector_instance_id, label);
  }
  return labels;
}

export interface DatasetStreamSizeRow {
  /** Stable React key. */
  readonly key: string;
  readonly label: string;
  /** Formatted total, or `—` when unmeasured. Never a fabricated `0 B`. */
  readonly sizeLabel: string;
  readonly sizeMeasured: boolean;
}

export interface DatasetStreamSizeModel {
  readonly rows: readonly DatasetStreamSizeRow[];
  readonly someMeasured: boolean;
}

function isFiniteNonNegative(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function streamLabel(item: DatasetStreamSizeInput): string {
  const connector =
    typeof item.connector_id === "string" && item.connector_id.length > 0 ? item.connector_id : "unknown";
  const stream = typeof item.stream === "string" && item.stream.length > 0 ? item.stream : "unknown";
  return `${connector} / ${stream}`;
}

/**
 * Build the render-model for the stream-grain size table
 * (`GET /_ref/dataset/size?grain=stream`).
 *
 * `connectionLabels` (from {@link buildStreamConnectionLabels}) disambiguates
 * rows that would otherwise share an identical `connector / stream` label —
 * e.g. three ChatGPT connections all producing a `chatgpt / messages` row.
 * The connection label is appended ONLY when the base label is a real
 * duplicate within this row set, so a stream with just one connection stays
 * as clean as before. Rows whose `connector_instance_id` isn't in the map
 * (connector deleted, or map omitted) fall back to the bare
 * `connector_instance_id` — never fabricated, never silently merged.
 */
export function buildDatasetStreamSizeModel(
  rows: readonly DatasetStreamSizeInput[],
  connectionLabels?: ReadonlyMap<string, string>
): DatasetStreamSizeModel {
  const baseLabelCounts = new Map<string, number>();
  for (const row of rows) {
    const label = streamLabel(row);
    baseLabelCounts.set(label, (baseLabelCounts.get(label) ?? 0) + 1);
  }

  const withBytes = rows.map((row, index) => {
    const base = streamLabel(row);
    const isDuplicate = (baseLabelCounts.get(base) ?? 0) > 1;
    const instanceId = typeof row.connector_instance_id === "string" ? row.connector_instance_id : null;
    let disambiguator: string | null = null;
    if (isDuplicate && instanceId) {
      disambiguator = connectionLabels?.get(instanceId) ?? instanceId;
    }
    return {
      bytes: isFiniteNonNegative(row.total_retained_bytes) ? row.total_retained_bytes : null,
      key: `${row.connector_instance_id ?? row.connector_id ?? "unknown"}::${row.stream ?? "unknown"}::${index}`,
      label: disambiguator ? `${base} (${disambiguator})` : base,
    };
  });

  // Bytes descending; unmeasured rows sort last as a block. Ties (including
  // the all-unmeasured tail) break by label for a stable order, matching
  // `buildSourceStorageModel`.
  withBytes.sort((a, b) => {
    if (a.bytes === null && b.bytes === null) {
      return a.label.localeCompare(b.label);
    }
    if (a.bytes === null) {
      return 1;
    }
    if (b.bytes === null) {
      return -1;
    }
    return b.bytes - a.bytes || a.label.localeCompare(b.label);
  });

  const built: DatasetStreamSizeRow[] = withBytes.map((row) => ({
    key: row.key,
    label: row.label,
    sizeLabel: row.bytes === null ? "—" : formatStorageBytes(row.bytes),
    sizeMeasured: row.bytes !== null,
  }));

  return {
    rows: built,
    someMeasured: built.some((row) => row.sizeMeasured),
  };
}

export interface DatasetTopRowInput {
  readonly blob_bytes?: number | null;
  readonly blob_id?: string | null;
  readonly connector_id?: string | null;
  readonly current_record_json_bytes?: number | null;
  readonly grain_key?: string;
  readonly measure?: string;
  readonly rank?: number;
  readonly record_key?: string | null;
  readonly stream?: string | null;
  readonly total_retained_bytes?: number | null;
}

export interface DatasetTopRow {
  readonly key: string;
  readonly label: string;
  readonly rank: number;
  readonly sizeLabel: string;
  readonly sizeMeasured: boolean;
}

export interface DatasetTopModel {
  readonly rows: readonly DatasetTopRow[];
  readonly someMeasured: boolean;
}

function topRowLabel(row: DatasetTopRowInput, scope: "record" | "blob"): string {
  const connector = typeof row.connector_id === "string" && row.connector_id.length > 0 ? row.connector_id : null;
  const stream = typeof row.stream === "string" && row.stream.length > 0 ? row.stream : null;
  const prefix = connector && stream ? `${connector} / ${stream}` : (connector ?? stream ?? "unknown source");
  if (scope === "record") {
    const key = typeof row.record_key === "string" && row.record_key.length > 0 ? row.record_key : "unknown";
    return `${prefix} · ${key}`;
  }
  const id = typeof row.blob_id === "string" && row.blob_id.length > 0 ? row.blob_id : "unknown";
  return `${prefix} · ${id}`;
}

/**
 * Build the render-model for a top-N leaderboard
 * (`GET /_ref/dataset/top?scope=record|blob&measure=...`). Rows arrive
 * already bounded (server-capped at 25) and already ranked; this only
 * formats bytes and a display label. `measure` selects which byte field a
 * row's `sizeLabel` reads (the same measure the caller requested).
 */
export function buildDatasetTopModel(
  rows: readonly DatasetTopRowInput[],
  scope: "record" | "blob",
  measure: "total_retained_bytes" | "current_record_json_bytes" | "blob_bytes" = "total_retained_bytes"
): DatasetTopModel {
  const built: DatasetTopRow[] = rows.map((row, index) => {
    const raw =
      measure === "current_record_json_bytes"
        ? row.current_record_json_bytes
        : measure === "blob_bytes"
          ? row.blob_bytes
          : row.total_retained_bytes;
    const bytes = isFiniteNonNegative(raw) ? raw : null;
    return {
      key: row.grain_key ?? `${scope}-${index}`,
      label: topRowLabel(row, scope),
      rank: typeof row.rank === "number" ? row.rank : index + 1,
      sizeLabel: bytes === null ? "—" : formatStorageBytes(bytes),
      sizeMeasured: bytes !== null,
    };
  });

  return {
    rows: built,
    someMeasured: built.some((row) => row.sizeMeasured),
  };
}
