// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { buildCollectionFacts, buildRecoveryGapClosureFacts } from "../runtime/connector-gap-bounding.ts";

type BuildCollectionFactsInput = Parameters<typeof buildCollectionFacts>[0];

interface BaseInputOverrides extends Partial<BuildCollectionFactsInput> {
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

function baseInput(overrides: BaseInputOverrides): BuildCollectionFactsInput {
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

test("a newer terminal skip cannot inherit an older continuation in terminal collection facts", () => {
  const facts = buildCollectionFacts(
    baseInput({
      knownGaps: [
        {
          continuation: {
            boundary: "uidvalidity-123",
            considered: 2,
            covered: 2,
            owner: "runtime",
            remaining: true,
            slice_end: 500,
            slice_start: 1,
          },
          kind: "skip_result",
          stream: "orders",
        },
        { kind: "skip_result", reason: "auth_failed", stream: "orders" },
      ],
      recoveryOnly: false,
    })
  );

  assert.ok(facts);
  const orders = facts.streams.find((stream) => (stream as { stream?: string }).stream === "orders") as
    | { skipped?: unknown; collection_scope?: unknown }
    | undefined;
  assert.deepEqual(orders?.skipped, { reason: "auth_failed" });
  assert.equal(orders?.collection_scope, undefined);
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

// buildRecoveryGapClosureFacts is the DISTINCT typed block that carries a
// recovery-only run's durable gap-closure count, separate from
// buildCollectionFacts's unconditional-null `collection_facts`. It never
// claims inventory (`considered`/`checkpoint`) — only "N previously-open
// gaps for this stream are now durably recovered" — sourced from the
// runtime's own `durableDetailGaps` store transitions, not any
// connector-declared DETAIL_COVERAGE number. See its doc comment in
// connector-gap-bounding.ts and the fold-side merge test in
// connector-summary-stream-facts.test.ts.

test("buildRecoveryGapClosureFacts: recoveryOnly=false returns null even with recovered gaps (block only exists for recovery-only runs)", () => {
  const facts = buildRecoveryGapClosureFacts({
    durableDetailGaps: [{ kind: "detail_gap", status: "recovered", stream: "transactions" }],
    recoveryOnly: false,
  });
  assert.equal(facts, null);
});

test("buildRecoveryGapClosureFacts: recoveryOnly=true with no recovered gaps returns null", () => {
  const facts = buildRecoveryGapClosureFacts({
    durableDetailGaps: [{ kind: "detail_gap", status: "pending", stream: "transactions" }],
    recoveryOnly: true,
  });
  assert.equal(facts, null);
});

test("buildRecoveryGapClosureFacts: recoveryOnly=true counts only status=recovered gaps, grouped per stream", () => {
  const facts = buildRecoveryGapClosureFacts({
    durableDetailGaps: [
      { gap_id: "gap-1", kind: "detail_gap", status: "recovered", stream: "transactions" },
      { gap_id: "gap-2", kind: "detail_gap", status: "recovered", stream: "transactions" },
      { gap_id: "gap-3", kind: "detail_gap", status: "pending", stream: "transactions" },
      { gap_id: "gap-4", kind: "detail_gap", status: "recovered", stream: "orders" },
      { gap_id: "gap-5", kind: "detail_gap", status: "terminal", stream: "orders" },
    ],
    recoveryOnly: true,
  });
  assert.ok(facts);
  const streams = facts.streams
    .map((s) => s as { recovered_count: number; stream: string })
    .sort((a, b) => a.stream.localeCompare(b.stream));
  assert.deepEqual(streams, [
    { recovered_count: 1, stream: "orders" },
    { recovered_count: 2, stream: "transactions" },
  ]);
});

test("buildRecoveryGapClosureFacts: never carries considered/covered/checkpoint fields (not an inventory claim)", () => {
  const facts = buildRecoveryGapClosureFacts({
    durableDetailGaps: [{ gap_id: "gap-1", kind: "detail_gap", status: "recovered", stream: "transactions" }],
    recoveryOnly: true,
  });
  assert.ok(facts);
  const entry = facts.streams[0] as Record<string, unknown>;
  assert.equal(Object.hasOwn(entry, "considered"), false);
  assert.equal(Object.hasOwn(entry, "covered"), false);
  assert.equal(Object.hasOwn(entry, "checkpoint"), false);
  assert.equal(Object.hasOwn(entry, "collected"), false);
});

test("buildRecoveryGapClosureFacts: deduplicates by stable gap_id (duplicate idempotent gap entries count once)", () => {
  const facts = buildRecoveryGapClosureFacts({
    durableDetailGaps: [
      { gap_id: "gap-1", kind: "detail_gap", status: "recovered", stream: "orders" },
      { gap_id: "gap-1", kind: "detail_gap", status: "recovered", stream: "orders" },
      { gap_id: "gap-2", kind: "detail_gap", status: "recovered", stream: "orders" },
      { gap_id: "gap-3", kind: "detail_gap", status: "recovered", stream: "transactions" },
      { gap_id: "gap-3", kind: "detail_gap", status: "recovered", stream: "transactions" },
      { gap_id: "gap-3", kind: "detail_gap", status: "recovered", stream: "transactions" },
      // Gap identity is global; a malformed duplicate must not count again
      // even if it claims a different stream.
      { gap_id: "gap-3", kind: "detail_gap", status: "recovered", stream: "orders" },
    ],
    recoveryOnly: true,
  });
  assert.ok(facts);
  const streams = facts.streams
    .map((s) => s as { recovered_count: number; stream: string })
    .sort((a, b) => a.stream.localeCompare(b.stream));
  assert.deepEqual(streams, [
    { recovered_count: 2, stream: "orders" },
    { recovered_count: 1, stream: "transactions" },
  ]);
});

test("buildRecoveryGapClosureFacts: malformed entries (no gap_id) are excluded from proof", () => {
  const facts = buildRecoveryGapClosureFacts({
    durableDetailGaps: [
      { gap_id: "gap-1", kind: "detail_gap", status: "recovered", stream: "orders" },
      { kind: "detail_gap", status: "recovered", stream: "orders" },
      { gap_id: "", kind: "detail_gap", status: "recovered", stream: "orders" },
      { gap_id: "gap-2", kind: "detail_gap", status: "recovered", stream: "orders" },
    ],
    recoveryOnly: true,
  });
  assert.ok(facts);
  const entry = facts.streams[0] as { recovered_count: number; stream: string };
  assert.deepEqual(entry, { recovered_count: 2, stream: "orders" });
});
