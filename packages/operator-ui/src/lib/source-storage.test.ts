// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * source-storage render-model — unit coverage for the deployment page's
 * per-source storage table.
 *
 * Pins the three invariants the restoration must carry (docs/inbox/
 * findings-storage-stats.md §6):
 *
 * 1. Never fabricate `0`. `total_retained_bytes` is `null` when the evidence
 *    state is unobserved/stale/failed (`ref-control.ts:755-763`); that renders
 *    as `—`, never `0 B`, and carries no breakdown.
 * 2. Respect `total_records_state`. `operations/ref-connectors-list/
 *    index.ts:88` — a client MUST NOT render `total_records` as authoritative
 *    unless the state reads `"known"`/`"known_zero"`. A `"stale"` count is a
 *    labeled hint.
 * 3. Do not sum logical and physical bytes. Per-source retained bytes are
 *    logical; the model carries its own note saying so and never totals its
 *    rows into a figure comparable to `pg_database_size`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildSourceStorageModel, type SourceStorageInput } from "./source-storage.ts";
import { formatStorageBytes } from "./storage-footprint.ts";

const UNTRUSTED_NUMBER_RE = /99/;
const LOGICAL_WORD_RE = /logical/i;
const DOES_NOT_SUM_RE = /does not sum/i;

function source(overrides: Partial<SourceStorageInput> = {}): SourceStorageInput {
  return {
    connection_id: "conn_gmail",
    display_name: "Gmail",
    retained_bytes: {
      blob_bytes: 900_000,
      record_changes_json_bytes: 1_200_000,
      record_json_bytes: 4_500_000,
    },
    total_records: 1204,
    total_records_state: "known",
    total_retained_bytes: 6_600_000,
    ...overrides,
  };
}

// ─── invariant 1: null bytes → em-dash, never a fabricated 0 ────────────────

test("null total_retained_bytes renders an em-dash, never a fabricated 0", () => {
  const model = buildSourceStorageModel([source({ total_retained_bytes: null })]);
  const [row] = model.rows;
  assert.ok(row);
  assert.equal(row.sizeLabel, "—");
  assert.notEqual(row.sizeLabel, "0 B");
  assert.equal(row.bytes, null);
  assert.equal(row.sizeMeasured, false);
});

test("absent total_retained_bytes (older server) renders unmeasured, not 0", () => {
  const model = buildSourceStorageModel([source({ total_retained_bytes: undefined })]);
  assert.equal(model.rows[0]?.sizeLabel, "—");
  assert.equal(model.rows[0]?.sizeMeasured, false);
});

test("an unmeasured source shows no breakdown — an untrusted total has no trusted parts", () => {
  const model = buildSourceStorageModel([source({ total_retained_bytes: null })]);
  assert.equal(model.rows[0]?.breakdownLabel, null);
});

test("a genuinely empty source still renders 0 B — measured zero is not unmeasured", () => {
  // The em-dash is reserved for "we do not know". A real, evidence-backed
  // zero must stay a number or the two states become indistinguishable.
  const model = buildSourceStorageModel([
    source({
      retained_bytes: { blob_bytes: 0, record_changes_json_bytes: 0, record_json_bytes: 0 },
      total_retained_bytes: 0,
    }),
  ]);
  assert.equal(model.rows[0]?.sizeLabel, "0 B");
  assert.equal(model.rows[0]?.sizeMeasured, true);
});

test("someMeasured is false when no source reported a byte total", () => {
  const model = buildSourceStorageModel([
    source({ connection_id: "a", total_retained_bytes: null }),
    source({ connection_id: "b", total_retained_bytes: null }),
  ]);
  assert.equal(model.someMeasured, false);
});

// ─── invariant 2: total_records_state gates authority ───────────────────────

test("a stale record count is labeled as unverified, never rendered bare", () => {
  const model = buildSourceStorageModel([source({ total_records: 12, total_records_state: "stale" })]);
  const [row] = model.rows;
  assert.ok(row);
  assert.equal(row.recordsLabel, "12 records (unverified)");
  assert.equal(row.recordsMeasured, false);
  assert.notEqual(row.recordsLabel, "12 records");
});

test("unobserved/unknown states render the unit as unavailable, not a number", () => {
  for (const state of ["unobserved", "unknown"] as const) {
    const model = buildSourceStorageModel([source({ total_records: 99, total_records_state: state })]);
    assert.equal(model.rows[0]?.recordsLabel, "records unavailable", state);
    assert.equal(model.rows[0]?.recordsMeasured, false, state);
    assert.doesNotMatch(
      model.rows[0]?.recordsLabel ?? "",
      UNTRUSTED_NUMBER_RE,
      `${state} never leaks the untrusted number`
    );
  }
});

test("known and known_zero render the exact count as authoritative", () => {
  const known = buildSourceStorageModel([source({ total_records: 1204, total_records_state: "known" })]);
  assert.equal(known.rows[0]?.recordsLabel, "1,204 records");
  assert.equal(known.rows[0]?.recordsMeasured, true);

  const zero = buildSourceStorageModel([source({ total_records: 0, total_records_state: "known_zero" })]);
  assert.equal(zero.rows[0]?.recordsLabel, "0 records");
  assert.equal(zero.rows[0]?.recordsMeasured, true);
});

test("an omitted state (reference predating the field) keeps the prior numeric rendering", () => {
  const model = buildSourceStorageModel([source({ total_records: 7, total_records_state: undefined })]);
  assert.equal(model.rows[0]?.recordsLabel, "7 records");
  assert.equal(model.rows[0]?.recordsMeasured, true);
});

test("a stale ZERO is still labeled unverified rather than shown as an empty source", () => {
  const model = buildSourceStorageModel([source({ total_records: 0, total_records_state: "stale" })]);
  assert.equal(model.rows[0]?.recordsLabel, "0 records (unverified)");
});

// ─── invariant 3: logical bytes are never summed with physical ─────────────

test("the model carries a note distinguishing logical payload from on-disk size", () => {
  const model = buildSourceStorageModel([source()]);
  assert.ok(model.logicalNote.length > 0);
  assert.match(model.logicalNote, LOGICAL_WORD_RE);
  assert.match(model.logicalNote, DOES_NOT_SUM_RE);
});

test("the model exposes no total — rows are never folded into one comparable figure", () => {
  // Summing per-source logical bytes and presenting the result beside
  // pg_database_size is exactly the conflation storage-footprint.ts:12-19
  // forbids, so the model deliberately offers no such field to render.
  const model = buildSourceStorageModel([source({ connection_id: "a" }), source({ connection_id: "b" })]);
  assert.deepEqual(Object.keys(model).sort(), ["logicalNote", "rows", "someMeasured"]);
});

// ─── ordering ───────────────────────────────────────────────────────────────

test("rows sort by bytes descending", () => {
  const model = buildSourceStorageModel([
    source({ connection_id: "small", display_name: "Slack", total_retained_bytes: 1000 }),
    source({ connection_id: "big", display_name: "Gmail", total_retained_bytes: 900_000_000 }),
    source({ connection_id: "mid", display_name: "Amazon", total_retained_bytes: 5_000_000 }),
  ]);
  assert.deepEqual(
    model.rows.map((row) => row.label),
    ["Gmail", "Amazon", "Slack"]
  );
  let prev = Number.POSITIVE_INFINITY;
  for (const row of model.rows) {
    assert.ok(row.bytes !== null && row.bytes <= prev, "ordered largest-first");
    prev = row.bytes;
  }
});

test("unmeasured rows sort last as a block — unknown is not the same as smallest", () => {
  const model = buildSourceStorageModel([
    source({ connection_id: "unknown", display_name: "YNAB", total_retained_bytes: null }),
    source({ connection_id: "tiny", display_name: "Slack", total_retained_bytes: 1 }),
    source({ connection_id: "big", display_name: "Gmail", total_retained_bytes: 900_000_000 }),
  ]);
  assert.deepEqual(
    model.rows.map((row) => row.label),
    ["Gmail", "Slack", "YNAB"]
  );
  assert.equal(model.rows.at(-1)?.sizeMeasured, false);
});

test("equal byte totals break ties by label for a stable order", () => {
  const model = buildSourceStorageModel([
    source({ connection_id: "b", display_name: "Zulip", total_retained_bytes: 500 }),
    source({ connection_id: "a", display_name: "Amazon", total_retained_bytes: 500 }),
  ]);
  assert.deepEqual(
    model.rows.map((row) => row.label),
    ["Amazon", "Zulip"]
  );
});

// ─── breakdown + labels ─────────────────────────────────────────────────────

test("the breakdown renders current/history/blobs through the shared formatter", () => {
  const model = buildSourceStorageModel([source()]);
  assert.equal(
    model.rows[0]?.breakdownLabel,
    `current ${formatStorageBytes(4_500_000)} · history ${formatStorageBytes(1_200_000)} · blobs ${formatStorageBytes(900_000)}`
  );
});

test("zero history and blobs are omitted, keeping the line to what exists", () => {
  const model = buildSourceStorageModel([
    source({ retained_bytes: { blob_bytes: 0, record_changes_json_bytes: 0, record_json_bytes: 4_500_000 } }),
  ]);
  assert.equal(model.rows[0]?.breakdownLabel, `current ${formatStorageBytes(4_500_000)}`);
});

test("an absent breakdown block renders no secondary line rather than zeros", () => {
  const model = buildSourceStorageModel([source({ retained_bytes: null })]);
  assert.equal(model.rows[0]?.breakdownLabel, null);
  assert.equal(model.rows[0]?.sizeLabel, formatStorageBytes(6_600_000), "the total still renders");
});

test("the label falls back from display name to connector name to connection id", () => {
  const named = buildSourceStorageModel([source({ display_name: "My Gmail" })]);
  assert.equal(named.rows[0]?.label, "My Gmail");

  const connectorOnly = buildSourceStorageModel([source({ connector_display_name: "Gmail", display_name: undefined })]);
  assert.equal(connectorOnly.rows[0]?.label, "Gmail");

  const idOnly = buildSourceStorageModel([source({ connector_display_name: undefined, display_name: undefined })]);
  assert.equal(idOnly.rows[0]?.label, "conn_gmail");
});

test("rows without a usable connection id are dropped rather than keyed on a guess", () => {
  const malformed = [source(), { ...source(), connection_id: "" }] as SourceStorageInput[];
  const model = buildSourceStorageModel(malformed);
  assert.equal(model.rows.length, 1);
});

test("an empty source list yields no rows and claims nothing measured", () => {
  const model = buildSourceStorageModel([]);
  assert.equal(model.rows.length, 0);
  assert.equal(model.someMeasured, false);
});
