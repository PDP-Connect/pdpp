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

import type { DeploymentDiagnostics } from "./ref-client.ts";

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

const UNMEASURED_NOTE =
  "On-disk size is reported for Postgres backends only. This deployment is SQLite-backed or the size read was unavailable.";

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
      retainedLabel,
      relations: [],
      unmeasuredNote: UNMEASURED_NOTE,
    };
  }

  const rawRelations = Array.isArray(database.top_relations) ? database.top_relations : [];
  const relations: StorageRelationRow[] = [];
  for (const relation of rawRelations) {
    const name = typeof relation?.name === "string" && relation.name.length > 0 ? relation.name : null;
    if (name === null || !isFiniteNonNegative(relation?.bytes)) {
      continue;
    }
    relations.push({ name, bytes: relation.bytes, label: formatStorageBytes(relation.bytes) });
  }

  return {
    measured: true,
    physicalLabel: formatStorageBytes(physical),
    retainedLabel,
    relations,
    unmeasuredNote: null,
  };
}
