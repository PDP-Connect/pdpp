// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Console-side guard against the "Holding 0 records." defect class.
 *
 * `getConnectorOverview` used to aggregate per-stream counts with
 * `streams.reduce((sum, s) => sum + (s.record_count ?? 0), 0)` and returned no
 * `totalRecordsState`. Both halves were needed to make the lie:
 *
 *   1. `record_count` is `null` when the server could NOT measure a stream
 *      (its own contract: "rendered as unavailable, never fabricated as 0"),
 *      and `?? 0` turned every such stream into a confident zero.
 *   2. `isTotalRecordsAuthoritative(undefined) === true`, so omitting the state
 *      told the renderer the resulting number was fully trustworthy.
 *
 * Together, a connection whose streams were never measured rendered
 * "0 records ingested" with `reliable: true` — the same false statement the
 * server-side fix removed from the rendered verdict.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isTotalRecordsAuthoritative } from "@pdpp/operator-ui/lib/total-records-label";
import { aggregateStreamRecordCounts, type StreamRecordCountEvidence } from "./stream-record-count-aggregate.ts";

function streamSummary(overrides: Partial<StreamRecordCountEvidence>): StreamRecordCountEvidence {
  return { record_count: null, ...overrides };
}

test("aggregate: an UNMEASURED stream never contributes a fabricated zero to an authoritative total", () => {
  // The live shape: the server could not measure this stream, so it sent null.
  const out = aggregateStreamRecordCounts([streamSummary({ count_state: "unobserved", record_count: null })]);
  assert.strictEqual(
    isTotalRecordsAuthoritative(out.totalRecordsState),
    false,
    "an unmeasured connection must not report an authoritative count"
  );
  assert.strictEqual(out.totalRecordsState, "unobserved");
});

test("aggregate: a legacy reference (no count_state) still treats null record_count as unmeasured", () => {
  // Older references omit count_state; `record_count === null` is the
  // documented legacy "unavailable" signal and must be honored.
  const out = aggregateStreamRecordCounts([streamSummary({ record_count: null })]);
  assert.strictEqual(isTotalRecordsAuthoritative(out.totalRecordsState), false);
  assert.strictEqual(out.totalRecordsState, "unobserved");
});

test("aggregate: a PARTIALLY measured connection reports a non-authoritative total, not a confident one", () => {
  // 500 counted, one stream never measured. The sum is real but incomplete, so
  // it must never render as this connection's authoritative holdings.
  const out = aggregateStreamRecordCounts([
    streamSummary({ count_state: "known", record_count: 500 }),
    streamSummary({ count_state: "unobserved", record_count: null }),
  ]);
  assert.strictEqual(out.totalRecords, 500, "the measured part is still reported");
  assert.strictEqual(
    isTotalRecordsAuthoritative(out.totalRecordsState),
    false,
    "a partial sum must not claim to be the total"
  );
});

test("aggregate: a fully measured connection reports its real count authoritatively", () => {
  const out = aggregateStreamRecordCounts([
    streamSummary({ count_state: "known", record_count: 246_559 }),
    streamSummary({ count_state: "known", record_count: 52_689 }),
  ]);
  assert.strictEqual(out.totalRecords, 299_248);
  assert.strictEqual(out.totalRecordsState, "known");
  assert.strictEqual(isTotalRecordsAuthoritative(out.totalRecordsState), true);
});

test("aggregate: a PROVEN zero is authoritative (a measured zero is a real fact)", () => {
  const out = aggregateStreamRecordCounts([streamSummary({ count_state: "known_zero", record_count: 0 })]);
  assert.strictEqual(out.totalRecords, 0);
  assert.strictEqual(out.totalRecordsState, "known_zero");
  assert.strictEqual(
    isTotalRecordsAuthoritative(out.totalRecordsState),
    true,
    "a proven zero must stay authoritative; only UNMEASURED zeros are the lie"
  );
});

test("aggregate: a stale stream keeps the total non-authoritative", () => {
  const out = aggregateStreamRecordCounts([streamSummary({ count_state: "stale", record_count: 42 })]);
  assert.strictEqual(out.totalRecordsState, "stale");
  assert.strictEqual(isTotalRecordsAuthoritative(out.totalRecordsState), false);
});

test("aggregate: no streams at all claims nothing rather than a measured zero", () => {
  const out = aggregateStreamRecordCounts([]);
  assert.strictEqual(out.totalRecords, 0);
  assert.strictEqual(
    isTotalRecordsAuthoritative(out.totalRecordsState),
    false,
    "an empty stream list is an absence of evidence, not a measured zero"
  );
});
