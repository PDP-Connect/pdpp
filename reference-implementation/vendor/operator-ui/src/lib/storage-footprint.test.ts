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

import type { DatasetSummary, DatasetSummaryProjectionMetadata, DeploymentDiagnostics } from "./ref-client.ts";
import {
  buildDatasetSummaryProjectionStatusModel,
  buildStorageFootprintModel,
  formatStorageBytes,
  retainedBytesFromDatasetSummary,
} from "./storage-footprint.ts";

const NEVER_COMPUTED_RE = /never computed/i;
const DISK_FULL_RE = /disk full/;

type DatabaseBlock = DeploymentDiagnostics["database"];

function datasetSummary(overrides: Partial<DatasetSummary> = {}): DatasetSummary {
  return {
    blob_bytes: 0,
    connector_count: 0,
    earliest_ingested_at: null,
    earliest_record_time: null,
    latest_ingested_at: null,
    latest_record_time: null,
    object: "dataset_summary",
    record_changes_json_bytes: 0,
    record_count: 0,
    record_json_bytes: 0,
    stream_count: 0,
    top_connectors: [],
    total_retained_bytes: 0,
    ...overrides,
  };
}

function pgDatabase(overrides: Partial<DatabaseBlock> = {}): DatabaseBlock {
  // Compile-level contract check: this fixture must accept the authoritative
  // reference backend discriminator through the shared input type.
  return {
    backend: "postgres",
    path: "/var/lib/postgresql/data",
    physical_bytes: 51_000_000_000, // ~51 GB → "51.0 GB"
    top_relations: [
      { bytes: 21_000_000_000, name: "lexical_search_fts" },
      { bytes: 9_000_000_000, name: "records" },
      { bytes: 4_000_000_000, name: "spine_events" },
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

test("split deployment trusts authoritative reference backend when physical probe is unavailable", () => {
  const model = buildStorageFootprintModel(pgDatabase({ physical_bytes: null, top_relations: null }), 4_800_000_000);
  assert.equal(model.measured, false);
  assert.match(model.unmeasuredNote ?? "", /Postgres is authoritative/);
  assert.doesNotMatch(model.unmeasuredNote ?? "", /SQLite-backed/);
});

test("unknown backend remains unknown instead of defaulting to SQLite", () => {
  const model = buildStorageFootprintModel(
    { path: "/remote/reference", physical_bytes: null, top_relations: null },
    null
  );
  assert.match(model.unmeasuredNote ?? "", /backend is unknown/);
  assert.doesNotMatch(model.unmeasuredNote ?? "", /SQLite-backed/);
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
  const [first] = model.relations;
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
    { bytes: 1000, name: "records" },
    { bytes: 5, name: "" },
    { bytes: Number.NaN, name: "bad" },
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

// ─── retainedBytesFromDatasetSummary (global projection convergence) ───────
//
// Live UAT: the global `dataset_summary_projection` had never converged
// (counts.record_count = 0, retained_bytes.* = 0) while the connector fleet
// held ~430k records. The deployment page rendered "0 B" for the logical
// retained payload — the same fabrication class already fixed at the
// per-connection grain (`connector-summary-read-model.ts`,
// `retained_bytes_state`). These pin the fix at the global grain.

test("unconverged projection (never computed) renders as unknown, never a fabricated 0", () => {
  // No `projection` block at all — an old server or a projection that has
  // never run. `total_retained_bytes` is still the schema default `0`.
  const summary = datasetSummary({ total_retained_bytes: 0 });
  assert.equal(
    retainedBytesFromDatasetSummary(summary),
    null,
    "a projection with no computed_at must not be trusted, even though the wire value is 0"
  );
});

test("projection explicitly rebuilding (computed_at null) renders as unknown", () => {
  const summary = datasetSummary({
    projection: {
      computed_at: null,
      last_error: null,
      rebuild_status: "running",
      stale_since: "2026-08-07T00:00:00.000Z",
      state: "rebuilding",
    },
    total_retained_bytes: 0,
  });
  assert.equal(retainedBytesFromDatasetSummary(summary), null);
});

test("converged-but-stale projection still renders its last-known real number", () => {
  // Matches the physical-footprint "last known" precedent: a projection
  // that HAS computed at least once keeps showing that number while stale,
  // rather than blanking a value the operator already had.
  const summary = datasetSummary({
    projection: {
      computed_at: "2026-08-01T00:00:00.000Z",
      last_error: null,
      rebuild_status: "idle",
      stale_since: "2026-08-06T00:00:00.000Z",
      state: "stale",
    },
    total_retained_bytes: 703_856_000,
  });
  assert.equal(retainedBytesFromDatasetSummary(summary), 703_856_000);
});

test("fresh converged projection with a genuine zero renders as measured 0, not suppressed", () => {
  // A real empty dataset (fresh install, no connectors yet) must still show
  // 0 B — blanket-suppressing every zero would be the opposite defect.
  const summary = datasetSummary({
    projection: {
      computed_at: "2026-08-07T00:00:00.000Z",
      last_error: null,
      rebuild_status: "idle",
      stale_since: null,
      state: "fresh",
    },
    total_retained_bytes: 0,
  });
  assert.equal(retainedBytesFromDatasetSummary(summary), 0);
});

test("end-to-end: unconverged summary renders the deployment page's 0 B fabrication as em-dash", () => {
  // Reproduces the exact owner-visible defect: feed the raw fabricated-0
  // summary through both stages the deployment page composes —
  // retainedBytesFromDatasetSummary then buildStorageFootprintModel — and
  // assert the rendered label is never "0 B".
  const summary = datasetSummary({ total_retained_bytes: 0 });
  const retainedBytes = retainedBytesFromDatasetSummary(summary);
  const model = buildStorageFootprintModel(pgDatabase(), retainedBytes);
  assert.notEqual(model.retainedLabel, "0 B");
  assert.equal(model.retainedLabel, null, "unmeasured global payload renders as hidden (—), not 0 B");
});

// ─── buildDatasetSummaryProjectionStatusModel (owner recovery affordance) ──
//
// The projection had exactly one caller (an owner-authenticated HTTP route
// with no boot hook, scheduler, or UI affordance) — a failed or
// never-converged projection was invisible and unrecoverable from the
// console. This pins the render-model that decides when to surface a
// status line + recovery action on the deployment page's storage section.

function projectionMetadata(
  overrides: Partial<DatasetSummaryProjectionMetadata> = {}
): DatasetSummaryProjectionMetadata {
  return {
    computed_at: "2026-08-07T00:00:00.000Z",
    last_error: null,
    rebuild_status: "idle",
    stale_since: null,
    state: "fresh",
    ...overrides,
  };
}

test("absent projection renders unmeasured with no recovery action", () => {
  const model = buildDatasetSummaryProjectionStatusModel(null);
  assert.equal(model.needsAttention, false);
});

test("fresh projection needs no attention", () => {
  const model = buildDatasetSummaryProjectionStatusModel(projectionMetadata({ state: "fresh" }));
  assert.equal(model.needsAttention, false);
});

test("never-converged projection (computed_at null) needs attention", () => {
  const model = buildDatasetSummaryProjectionStatusModel(
    projectionMetadata({ computed_at: null, rebuild_status: "running", state: "rebuilding" })
  );
  assert.equal(model.needsAttention, true);
  assert.match(model.statusLine, NEVER_COMPUTED_RE);
});

test("failed projection needs attention and surfaces the last error", () => {
  const model = buildDatasetSummaryProjectionStatusModel(
    projectionMetadata({
      last_error: "disk full",
      rebuild_status: "failed",
      state: "failed",
    })
  );
  assert.equal(model.needsAttention, true);
  assert.match(model.statusLine, DISK_FULL_RE);
});

test("refreshing/stale projections do not surface an action — the system is already handling them", () => {
  const refreshing = buildDatasetSummaryProjectionStatusModel(projectionMetadata({ state: "refreshing" }));
  const stale = buildDatasetSummaryProjectionStatusModel(
    projectionMetadata({ stale_since: "2026-08-07T00:00:00.000Z", state: "stale" })
  );
  assert.equal(refreshing.needsAttention, false);
  assert.equal(stale.needsAttention, false);
});
