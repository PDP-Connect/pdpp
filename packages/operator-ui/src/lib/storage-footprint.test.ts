// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * storage-footprint render-model — unit coverage for the operator console's
 * database-footprint comparison.
 *
 * Pins the must-hold display properties from:
 *   openspec/changes/surface-database-physical-footprint/
 *     specs/reference-implementation-architecture/spec.md
 *
 * 1. The physical footprint and the logical retained payload are rendered as
 *    two SEPARATE labeled numbers — never aliased, summed, or replaced.
 * 2. A null/absent physical size renders as an explicit unmeasured state
 *    (measured=false, "—", a note) — never a fabricated "0 B".
 * 3. The relation list is ordered, labeled, and carries only name + size; the
 *    composition is treated as approximate (no sum-equals-total claim).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { DeploymentDiagnostics } from "./ref-client.ts";
import { buildStorageFootprintModel, formatStorageBytes } from "./storage-footprint.ts";

type DatabaseBlock = DeploymentDiagnostics["database"];

function pgDatabase(overrides: Partial<DatabaseBlock> = {}): DatabaseBlock {
  return {
    path: "/var/lib/postgresql/data",
    physical_bytes: 51_000_000_000, // ~51 GB → "51.0 GB"
    top_relations: [
      { name: "lexical_search_fts", bytes: 21_000_000_000 },
      { name: "records", bytes: 9_000_000_000 },
      { name: "spine_events", bytes: 4_000_000_000 },
    ],
    ...overrides,
  };
}

// ─── formatStorageBytes ─────────────────────────────────────────────────────

test("formatStorageBytes renders decimal/SI units", () => {
  assert.equal(formatStorageBytes(0), "0 B");
  assert.equal(formatStorageBytes(512), "512 B");
  assert.equal(formatStorageBytes(4_560_000_000), "4.56 GB");
  assert.equal(formatStorageBytes(54_975_581_388), "55.0 GB");
});

test("formatStorageBytes returns — for non-finite or negative input, never a fake 0", () => {
  assert.equal(formatStorageBytes(Number.NaN), "—");
  assert.equal(formatStorageBytes(-1), "—");
  assert.equal(formatStorageBytes(Number.POSITIVE_INFINITY), "—");
});

// ─── measured Postgres model ────────────────────────────────────────────────

test("measured model renders physical and logical as two separate labeled numbers", () => {
  const model = buildStorageFootprintModel(pgDatabase(), 4_560_000_000);
  assert.equal(model.measured, true);
  assert.equal(model.physicalLabel, "51.0 GB");
  assert.equal(model.retainedLabel, "4.56 GB");
  // The physical and logical labels are distinct strings — the physical size
  // is never aliased to or replaced by the retained number.
  assert.notEqual(model.physicalLabel, model.retainedLabel);
  assert.equal(model.unmeasuredNote, null);
});

test("measured model never sums physical with retained", () => {
  const physical = 54_975_581_388;
  const retained = 4_555_000_000;
  const model = buildStorageFootprintModel(pgDatabase({ physical_bytes: physical }), retained);
  // The rendered physical label is the physical number alone, not the sum.
  assert.equal(model.physicalLabel, formatStorageBytes(physical));
  assert.notEqual(model.physicalLabel, formatStorageBytes(physical + retained));
});

test("measured model carries ordered relation rows with only name + size", () => {
  const model = buildStorageFootprintModel(pgDatabase(), 1000);
  assert.equal(model.relations.length, 3);
  const first = model.relations[0];
  if (!first) {
    throw new Error("expected at least one relation row");
  }
  assert.equal(first.name, "lexical_search_fts");
  assert.equal(first.label, "21.0 GB");
  // ordered largest-first
  let prev = Number.POSITIVE_INFINITY;
  for (const relation of model.relations) {
    assert.ok(relation.bytes <= prev, "relations are ordered largest-first");
    prev = relation.bytes;
    assert.deepEqual(Object.keys(relation).sort(), ["bytes", "label", "name"]);
  }
});

test("measured model drops malformed relation rows defensively", () => {
  // Deliberately malformed rows (an empty name, a NaN size) reach the model
  // typed as the real row shape — the runtime defends against a stale/broken
  // catalog read, so the test exercises the same runtime path.
  const malformed: NonNullable<DatabaseBlock["top_relations"]> = [
    { name: "records", bytes: 1000 },
    { name: "", bytes: 5 },
    { name: "bad", bytes: Number.NaN },
  ];
  const model = buildStorageFootprintModel(pgDatabase({ top_relations: malformed }), null);
  assert.equal(model.relations.length, 1, "empty-name and NaN-size rows are dropped");
  assert.equal(model.relations[0]?.name, "records");
});

// ─── unmeasured (SQLite / read failure / absent) ────────────────────────────

test("null physical size renders as unmeasured, never a fabricated 0", () => {
  const model = buildStorageFootprintModel(
    { path: "/tmp/test.sqlite", physical_bytes: null, top_relations: null },
    4_560_000_000
  );
  assert.equal(model.measured, false);
  assert.equal(model.physicalLabel, "—");
  assert.notEqual(model.physicalLabel, "0 B");
  assert.equal(model.relations.length, 0);
  assert.ok(model.unmeasuredNote && model.unmeasuredNote.length > 0, "carries an explanatory note");
  // The logical comparison still renders even when the physical side is
  // unmeasured — the operator keeps the number they had.
  assert.equal(model.retainedLabel, "4.56 GB");
});

test("absent physical fields (older server / sandbox) render as unmeasured", () => {
  // A `database` block that predates this change omits the fields entirely.
  const model = buildStorageFootprintModel({ path: "(sandbox)" } as DatabaseBlock, null);
  assert.equal(model.measured, false);
  assert.equal(model.physicalLabel, "—");
  assert.equal(model.retainedLabel, null, "no retained number supplied → hidden, not guessed");
  assert.equal(model.relations.length, 0);
});

test("missing retained payload hides the comparison rather than guessing", () => {
  const model = buildStorageFootprintModel(pgDatabase(), undefined);
  assert.equal(model.measured, true);
  assert.equal(model.retainedLabel, null, "undefined retained → null label, not 0");
});
