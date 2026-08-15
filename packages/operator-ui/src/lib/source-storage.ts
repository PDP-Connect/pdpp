// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure render-model for the deployment page's per-source storage table.
//
// The deployment page's `database` block answers "how big is the database"
// and "which TABLES". It never answers "which SOURCE". This module turns the
// connector-summary list (`GET /_ref/connectors`) — which already carries
// `total_retained_bytes`, `total_records`/`total_records_state`, and the
// per-item `retained_bytes` breakdown — into the display strings the operator
// console renders, with no JSX or I/O so it can be pinned by `.test.ts` unit
// tests. No new endpoint, no new query, no contract change.
//
// Invariants this enforces:
//   - `total_retained_bytes === null` (evidence `unobserved`/`stale`/`failed`,
//     `ref-control.ts:755-763`) renders as `—`, never a fabricated `0 B`. A
//     source with no measured size sorts last and carries no breakdown.
//   - `total_records` is NOT rendered as authoritative unless
//     `total_records_state` reads `"known"`/`"known_zero"`
//     (`operations/ref-connectors-list/index.ts:88`). A `"stale"` count is a
//     hint and is labeled `(unverified)`; `"unobserved"`/`"unknown"` render
//     the unit as unavailable. Formatting routes through the shared
//     `formatTotalRecordsLabel` rather than re-deriving the branching here.
//   - These per-source bytes are LOGICAL. They are NEVER summed with, aliased
//     to, or compared against the physical `pg_database_size` in
//     `storage-footprint.ts` — indexes, `spine_events`, and page overhead are
//     not attributable to a source, so the two do not reconcile. The model
//     carries its own `logicalNote` so the table is labeled as separately as
//     `storage-footprint.ts:12-19` demands.

import { formatStorageBytes } from "./storage-footprint.ts";
import type { RefCountState } from "./total-records-label.ts";
import { formatTotalRecordsLabel } from "./total-records-label.ts";

/**
 * The structural slice of a connector-summary row this model needs. Declared
 * locally rather than importing `RefConnectorSummary` so the model stays
 * usable from both the console's fuller wire type and the operator-ui mirror
 * (the latter does not carry `total_records_state`).
 */
export interface SourceStorageInput {
  readonly connection_id: string;
  readonly connector_display_name?: string;
  /**
   * Present so the deployment view's stream-size disambiguator
   * ({@link StreamConnectionLabelInput} in `dataset-grains.ts`) can reuse
   * this same connector-summary list without a second fetch.
   */
  readonly connector_instance_id?: string | null;
  readonly display_name?: string;
  readonly retained_bytes?: {
    readonly blob_bytes?: number | null;
    readonly record_changes_json_bytes?: number | null;
    readonly record_json_bytes?: number | null;
  } | null;
  readonly revoked_at?: string | null;
  readonly total_records?: number;
  readonly total_records_state?: RefCountState;
  readonly total_retained_bytes?: number | null;
}

export interface SourceStorageRow {
  /** `current 4.5 MB · history 1.2 MB · blobs 900 KB`, or null when absent. */
  readonly breakdownLabel: string | null;
  /** Total retained bytes, or null when unmeasured. Null sorts last. */
  readonly bytes: number | null;
  /** Stable React key — the connection id, which is unique per row. */
  readonly connectionId: string;
  /** Operator-facing source name. */
  readonly label: string;
  /** State-aware record count, e.g. `1,204 records` / `12 records (unverified)`. */
  readonly recordsLabel: string;
  /** True when `total_records_state` proves the count exact. */
  readonly recordsMeasured: boolean;
  /** Formatted total, or `—` when unmeasured. Never a fabricated `0 B`. */
  readonly sizeLabel: string;
  /** True when a real byte total was measured for this source. */
  readonly sizeMeasured: boolean;
}

export interface SourceStorageModel {
  /**
   * One-line statement that these totals are logical payload bytes and do not
   * reconcile against the physical on-disk size rendered elsewhere on the
   * page. Always present — the two measurements share a surface.
   */
  readonly logicalNote: string;
  /** Rows ordered by bytes descending; unmeasured rows last, name-stable. */
  readonly rows: readonly SourceStorageRow[];
  /** True when at least one source reported a measured byte total. */
  readonly someMeasured: boolean;
}

const LOGICAL_NOTE =
  "Retained payload per source is a logical measurement — the JSON and blob byte length of that source's records, history, and blobs. It does not sum to the on-disk database size, which also holds indexes, the event log, and page overhead that belong to no single source.";

function isFiniteNonNegative(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Format the `current / history / blobs` secondary line for one source.
 *
 * A part is rendered only when it was measured. `current` renders at zero (a
 * source can legitimately hold no live records while retaining history);
 * `history`/`blobs` are omitted at zero to keep the line short, matching the
 * original `RetainedBytesLine` from `eb6b50677`. Returns `null` when the
 * breakdown block is absent or carries nothing renderable.
 *
 * Exported so the source detail header renders the identical string as the
 * deployment table instead of growing a second formatter.
 */
export function buildBreakdownLabel(retained: SourceStorageInput["retained_bytes"]): string | null {
  if (!retained) {
    return null;
  }
  const parts: string[] = [];
  if (isFiniteNonNegative(retained.record_json_bytes)) {
    parts.push(`current ${formatStorageBytes(retained.record_json_bytes)}`);
  }
  if (isFiniteNonNegative(retained.record_changes_json_bytes) && retained.record_changes_json_bytes > 0) {
    parts.push(`history ${formatStorageBytes(retained.record_changes_json_bytes)}`);
  }
  if (isFiniteNonNegative(retained.blob_bytes) && retained.blob_bytes > 0) {
    parts.push(`blobs ${formatStorageBytes(retained.blob_bytes)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function sourceLabel(item: SourceStorageInput): string {
  const display = typeof item.display_name === "string" && item.display_name.length > 0 ? item.display_name : null;
  if (display !== null) {
    return display;
  }
  const connector =
    typeof item.connector_display_name === "string" && item.connector_display_name.length > 0
      ? item.connector_display_name
      : null;
  return connector ?? item.connection_id;
}

/**
 * Build the render-model for the per-source storage table.
 *
 * @param items connector-summary rows as served by `GET /_ref/connectors`.
 *   Rows without a usable `connection_id` are dropped defensively rather than
 *   rendered under a fabricated key.
 */
export function buildSourceStorageModel(items: readonly SourceStorageInput[]): SourceStorageModel {
  const rows: SourceStorageRow[] = [];
  for (const item of items) {
    if (typeof item?.connection_id !== "string" || item.connection_id.length === 0) {
      continue;
    }
    const bytes = isFiniteNonNegative(item.total_retained_bytes) ? item.total_retained_bytes : null;
    const totalRecords = typeof item.total_records === "number" ? item.total_records : 0;
    rows.push({
      bytes,
      // A source with no measured total has no trustworthy breakdown to show.
      breakdownLabel: bytes === null ? null : buildBreakdownLabel(item.retained_bytes),
      connectionId: item.connection_id,
      label: sourceLabel(item),
      recordsLabel: formatTotalRecordsLabel(totalRecords, item.total_records_state, "records"),
      recordsMeasured:
        item.total_records_state === undefined ||
        item.total_records_state === "known" ||
        item.total_records_state === "known_zero",
      sizeLabel: bytes === null ? "—" : formatStorageBytes(bytes),
      sizeMeasured: bytes !== null,
    });
  }

  // Bytes descending. Unmeasured rows sort last as a block rather than being
  // treated as 0 — they are not the smallest sources, they are unknown ones.
  // Ties (including the all-unmeasured tail) break by label for a stable order.
  rows.sort((a, b) => {
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

  return {
    logicalNote: LOGICAL_NOTE,
    rows,
    someMeasured: rows.some((row) => row.sizeMeasured),
  };
}
