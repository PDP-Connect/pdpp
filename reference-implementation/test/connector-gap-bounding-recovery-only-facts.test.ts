// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { buildCollectionFacts } from "../runtime/connector-gap-bounding.ts";

interface BaseInputOverrides {
  committedStateStreams?: Set<string> | string[];
  detailCoverageByStateStream?: Map<string, { stream: string; considered: number; covered: number }[]>;
  durableDetailGaps?: { kind: string; stream: string; status: string }[];
  emittedByStream?: Map<string, number>;
  recoveryOnly: boolean;
}

// openspec/changes/fix-recovery-run-lifecycle: a `recovery_only` run only
// drains pending detail gaps (START.recovery_only); by definition it
// performs no forward/list inventory pass against the manifest scope, so it
// cannot produce a trustworthy per-stream inventory fact
// (checkpoint/considered/covered) for ANY stream — not even a stream it
// served or recovered a detail gap for, since gap hydration is not a
// list-pass measurement. `buildCollectionFacts` therefore returns `null`
// unconditionally for a recovery-only run. There is no exception: an
// earlier draft tried to admit a stream whose covering state_stream had a
// staged/committed STATE cursor, but no existing runtime contract proves
// that a STATE commit observed during a recovery-only run came from a
// genuine list-pass measurement rather than a detail-recovery cursor, so
// that exception was removed (see the recovery-evidence-provenance-audit
// finding this file's history documents).
//
// Downstream, this means: a recovery-only run's terminal event carries no
// collection_facts block at all, so the connector-summary-read-model fold
// and ref-control's collection-report projection both fall through
// entirely to the durable stored/prior evidence — with that evidence's own
// original provenance completely untouched. Current recovery/gap state
// comes from the live detail-gap store (`pendingDetailGaps` /
// `terminalDetailGapsByStream`), never from this block. See
// connector-summary-stream-facts.test.js and
// collection-report-projection.test.js for the fold/projection-level
// coverage of that invariant.

function baseInput(overrides: BaseInputOverrides) {
  return {
    committedStateStreams: new Set<string>(),
    detailCoverageByStateStream: new Map(),
    durableDetailGaps: [],
    emittedByStream: new Map(),
    knownGaps: [],
    manifestStateStreamByStream: new Map(),
    newState: null,
    persistState: true,
    scopeByStream: new Map([
      ["orders", { name: "orders" }],
      ["order_items", { name: "order_items" }],
    ]),
    ...overrides,
  };
}

test("recoveryOnly=false: every in-scope stream gets an entry, matching pre-existing behavior", () => {
  const facts = buildCollectionFacts(baseInput({ recoveryOnly: false }));
  assert.ok(facts, "expected a non-null collection-facts block");
  // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
  const streams = facts.streams.map((s) => (s as { stream: string }).stream).sort();
  assert.deepEqual(streams, ["order_items", "orders"]);
});

test("recoveryOnly=true: returns null even when the run emitted records for a stream", () => {
  const emittedByStream = new Map([["orders", 3]]);
  const facts = buildCollectionFacts(baseInput({ emittedByStream, recoveryOnly: true }));
  assert.equal(facts, null, "emitting a record during gap hydration is not a list-pass inventory measurement");
});

test("recoveryOnly=true: returns null even when the run recovered a pending detail gap", () => {
  const facts = buildCollectionFacts(
    baseInput({
      durableDetailGaps: [{ kind: "detail_gap", status: "recovered", stream: "order_items" }],
      recoveryOnly: true,
    })
  );
  assert.equal(facts, null, "recovering a gap is not a list-pass inventory measurement");
});

test("recoveryOnly=true: returns null even when the run has DETAIL_COVERAGE evidence", () => {
  const facts = buildCollectionFacts(
    baseInput({
      detailCoverageByStateStream: new Map([["order_items", [{ considered: 22, covered: 22, stream: "order_items" }]]]),
      recoveryOnly: true,
    })
  );
  assert.equal(facts, null);
});

test("recoveryOnly=true: returns null even when a state_stream has staged/committed STATE", () => {
  // A STATE commit observed during a recovery-only run is not provably a
  // genuine list-pass measurement (it could be a detail-recovery cursor) —
  // no exception is taken on this basis.
  const facts = buildCollectionFacts(
    baseInput({
      committedStateStreams: new Set(["orders"]),
      recoveryOnly: true,
    })
  );
  assert.equal(facts, null);
});

test("recoveryOnly=true: returns null with a completely empty run (no signals at all)", () => {
  const facts = buildCollectionFacts(baseInput({ recoveryOnly: true }));
  assert.equal(facts, null);
});
