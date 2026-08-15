// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure render-model for the deployment-diagnostics database footprint.
//
// The `/_ref/deployment` `database` block carries a read-only physical
// on-disk footprint (Postgres-only). This module turns that raw block — plus
// the logical retained payload from `/_ref/dataset/summary` — into the display
// strings and states the operator console renders, with no JSX or I/O so it
// can be pinned by `.test.ts` unit tests.
//
// Invariants this enforces (from the spec delta):
//   - The physical footprint is NEVER aliased to, summed with, or replaced by
//     the logical retained payload (`total_retained_bytes`). They are two
//     separate measurements rendered as a labeled comparison.
//   - `physical_bytes === null` (SQLite / read failure / absent) renders as an
//     explicit unmeasured state (`—` + note), never a fabricated `0`.
//   - The relation composition is labeled approximate; the relations do not
//     sum to `physical_bytes`.
//
// Spec: openspec/changes/surface-database-physical-footprint/specs/
//       reference-implementation-architecture/spec.md

import type { DatasetSummary, DatasetSummaryProjectionMetadata, DeploymentDiagnostics } from "./ref-client.ts";

export interface StorageRelationRow {
  readonly bytes: number;
  readonly label: string;
  readonly name: string;
}

export interface StorageFootprintModel {
  // True when the backend produced a real physical size. False on SQLite, a
  // read failure, or a server that omits the fields entirely.
  readonly measured: boolean;
  // The on-disk database size, formatted (e.g. "51.2 GB"). "—" when unmeasured.
  readonly physicalLabel: string;
  // Bounded, ordered-largest-first relation rows. Empty when unmeasured or the
  // server returned no relations.
  readonly relations: readonly StorageRelationRow[];
  // The logical retained payload, formatted, or null when not supplied.
  readonly retainedLabel: string | null;
  // One-line note describing the unmeasured state, or null when measured.
  readonly unmeasuredNote: string | null;
}

function unmeasuredNote(backend: DeploymentDiagnostics["database"]["backend"]): string {
  if (backend === "postgres") {
    return "Postgres is authoritative for this deployment, but its read-only physical-size probe was unavailable.";
  }
  if (backend === "sqlite") {
    return "On-disk size is reported for Postgres backends only. This deployment is SQLite-backed.";
  }
  return "Storage backend is unknown; the read-only physical-size probe was unavailable.";
}

// Format a byte count into a compact size string (decimal/SI units, matching
// the "Retained" KPI on the overview hero). Returns "—" for a non-finite or
// negative input so callers never render a fabricated "0 B" for an unmeasured
// value — `null`/absence is handled before this is reached.
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  let rounded: string;
  if (value >= 100 || unitIndex === 0) {
    rounded = String(Math.round(value));
  } else if (value >= 10) {
    rounded = value.toFixed(1);
  } else {
    rounded = value.toFixed(2);
  }
  return `${rounded} ${units[unitIndex] ?? "B"}`;
}

function isFiniteNonNegative(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Extract the logical retained-payload figure from a `dataset_summary`
 * envelope, honoring the global projection's convergence state the same way
 * the per-connection read model already treats `retained_bytes_state`
 * (`connector-summary-read-model.ts`): a projection that has never
 * converged carries no measured value, so `total_retained_bytes` is the
 * schema default (`0`), not a real zero. `projection.computed_at` is the
 * global convergence signal — `null`/absent means "never measured" and the
 * number must not be trusted. Once a projection has converged at least once
 * (fresh/refreshing/stale/failed all carry a `computed_at`), its last-known
 * number is real and renders even while a refresh is in flight, matching the
 * physical-footprint "last known" precedent.
 */
export function retainedBytesFromDatasetSummary(summary: DatasetSummary): number | null {
  const hasConverged = summary.projection?.computed_at != null;
  return hasConverged && typeof summary.total_retained_bytes === "number" ? summary.total_retained_bytes : null;
}

export interface DatasetSummaryProjectionStatusModel {
  // True when the projection is not `fresh` and the operator should be
  // told why the retained-payload figure is missing or stale, with a way
  // to fix it. `refreshing`/`stale` (a rebuild already in flight, or a
  // last-known value the normal delta/reconcile paths keep moving) do not
  // surface an action -- the system is already handling those on its own.
  readonly needsAttention: boolean;
  // One-line, plain-language explanation of the current state. Never
  // claims convergence the projection does not have.
  readonly statusLine: string;
}

/**
 * Render-model for the dataset-summary projection status line on the
 * deployment page's storage section. The projection is reference/operator
 * surface (see `ref-dataset-summary` operation docs), so this is plain
 * language, not a raw state enum dump -- the operator asking "why is this
 * blank" should get an answer, not a string to look up.
 *
 * `null`/absent `projection` (summary read failed, or the operation ran
 * without the projection dependency at all) renders as unmeasured with no
 * action -- there is nothing to recompute if the read itself failed.
 */
export function buildDatasetSummaryProjectionStatusModel(
  projection: DatasetSummaryProjectionMetadata | null | undefined
): DatasetSummaryProjectionStatusModel {
  if (!projection) {
    return { needsAttention: false, statusLine: "Projection status unavailable." };
  }
  const { computed_at: computedAt, last_error: lastError, state } = projection;
  if (state === "fresh") {
    return { needsAttention: false, statusLine: "Up to date." };
  }
  if (state === "failed") {
    const reason = lastError ? ` Last error: ${lastError}` : "";
    return {
      needsAttention: true,
      statusLine: `Rebuild failed and stopped retrying automatically.${reason}`,
    };
  }
  if (computedAt === null || computedAt === undefined) {
    return {
      needsAttention: true,
      statusLine: "Never computed. This deployment has not rebuilt the dataset summary yet.",
    };
  }
  if (state === "refreshing" || state === "rebuilding") {
    return { needsAttention: false, statusLine: "Rebuilding now — showing the last known value." };
  }
  // "stale": a last-known value exists and normal delta/reconcile traffic
  // is expected to move it forward on its own; no action needed yet.
  return { needsAttention: false, statusLine: "Stale — catching up from recent activity." };
}

/**
 * Build the render-model for the database footprint.
 *
 * @param database the `/_ref/deployment` `database` block.
 * @param retainedBytes the logical `total_retained_bytes` from the dataset
 *   summary, or null/undefined when it could not be loaded. It is rendered as
 *   a SEPARATE labeled number and is never combined with the physical size.
 */
export function buildStorageFootprintModel(
  database: DeploymentDiagnostics["database"],
  retainedBytes: number | null | undefined
): StorageFootprintModel {
  const physical = database.physical_bytes;
  const retainedLabel = isFiniteNonNegative(retainedBytes) ? formatStorageBytes(retainedBytes) : null;

  if (!isFiniteNonNegative(physical)) {
    return {
      measured: false,
      physicalLabel: "—",
      relations: [],
      retainedLabel,
      unmeasuredNote: unmeasuredNote(database.backend ?? "unknown"),
    };
  }

  const rawRelations = Array.isArray(database.top_relations) ? database.top_relations : [];
  const relations: StorageRelationRow[] = [];
  for (const relation of rawRelations) {
    const name = typeof relation?.name === "string" && relation.name.length > 0 ? relation.name : null;
    if (name === null || !isFiniteNonNegative(relation?.bytes)) {
      continue;
    }
    relations.push({ bytes: relation.bytes, label: formatStorageBytes(relation.bytes), name });
  }

  return {
    measured: true,
    physicalLabel: formatStorageBytes(physical),
    relations,
    retainedLabel,
    unmeasuredNote: null,
  };
}
