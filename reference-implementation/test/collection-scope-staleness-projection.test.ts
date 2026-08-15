// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Does changing the declared collection scope actually DECLASSIFY previously
// committed coverage, in the real projection an owner reads?
//
// The prior round shipped a correct pure comparator with no production caller,
// and its unit test called that comparator directly with hand-built strings —
// so it proved the function worked while proving nothing about whether it was
// ever consulted. These tests go through `projectCollectionReport`, the same
// entry point the owner-facing connector summary uses, so a regression that
// unwires the check fails here.
//
// The adversarial scenario from the brief: an owner already has committed
// coverage for a full unscoped pass, then narrows the scope. The old evidence
// describes a region they are no longer asking about, so coverage must stop
// reading `complete` until a fresh run recomputes it.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCoverageDiagnosticsStateSnapshot,
  type CoverageRecord,
  LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR,
  parseCoverageDiagnosticsStateSnapshot,
} from "../../packages/polyfill-connectors/src/local-source-inventory.ts";
import { COLLECTION_SCOPE_STATE_KEY } from "../server/local-collection-scope.ts";
import { deriveLocalCoverageAxis, projectCollectionReport } from "../server/ref-control.ts";

const MANIFEST_STREAMS = [{ name: "sessions", required: true }];

/** A connector-state projection carrying an owner-declared boundary. */
function stateWithScope(since: string | null): Record<string, unknown> {
  // `fetched_at` is what makes the coverage axis reliable; without it the axis
  // reads `unknown` for unrelated reasons and every assertion below would pass
  // vacuously.
  const base: Record<string, unknown> = { fetched_at: "2026-08-08T00:00:00.000Z" };
  if (!since) {
    return base;
  }
  base[COLLECTION_SCOPE_STATE_KEY] = {
    declared_at: "2026-08-01T00:00:00.000Z",
    fingerprint: `since=${since}`,
    scope: { since },
  };
  return base;
}

/** A drained local-device connection whose every store was accounted for. */
function localCoverageAxis(state: Record<string, unknown>, measuredScope: string | null = null) {
  // Rows carry the boundary they were measured under, exactly as the connector
  // stamps them onto `coverage_diagnostics` records.
  const coverageRows = [
    {
      status: "collected",
      store: "projects",
      stream: "sessions",
      ...(measuredScope ? { collectionScope: measuredScope } : {}),
    },
  ];
  return deriveLocalCoverageAxis({
    duplicateStores: [],
    hasAuthoritativeInventory: true,
    hasCommittedSnapshot: true,
    malformed: false,
    manifestGeneration: 1,
    missingStores: [],
    nowIso: "2026-08-09T00:00:00.000Z",
    rows: coverageRows,
    state,
    stateManifestGeneration: 1,
    unexpectedStores: [],
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
}

const HEALTH = {
  axes: { attention: "none", freshness: "fresh" },
  conditions: [{ status: "true", type: "ProjectionReliable" }],
} as unknown as Parameters<typeof projectCollectionReport>[0]["connectionHealth"];

/**
 * Shaped EXACTLY like the production call in `ref-control.ts`: it does NOT pass
 * `localCoverageCollectionScope`. The prior version of this test fabricated
 * that argument, which masked a P1 — the real caller never supplies it, so a
 * correctly scoped complete run compared against `unscoped` and read `unknown`
 * forever. The projection must derive the measured boundary itself.
 */
function report(input: { declaredScope: string | null; evidenceScope: string | null }) {
  const state = stateWithScope(input.declaredScope);
  const measured = input.evidenceScope === null ? "unscoped" : `since=${input.evidenceScope}`;
  return projectCollectionReport({
    connectionHealth: HEALTH,
    lastRun: null,
    localCoverage: localCoverageAxis(state, measured),
    localDeviceBacked: true,
    manifestStreams: MANIFEST_STREAMS as never,
    refreshPolicy: null,
    schedule: null,
  });
}

test("the declared boundary is read from connector state, not from a caller-supplied guess", () => {
  // Proves the no-extra-query path: the axis derives the boundary from the same
  // state projection it is already built from.
  const axis = localCoverageAxis(stateWithScope("2026-06-01T00:00:00.000Z"));
  assert.equal(axis.declaredCollectionScope, "since=2026-06-01T00:00:00.000Z");
  assert.equal(localCoverageAxis({}).declaredCollectionScope, "unscoped");
});

test("coverage committed under the declared boundary reads complete", () => {
  const entries = report({ declaredScope: "2026-06-01T00:00:00.000Z", evidenceScope: "2026-06-01T00:00:00.000Z" });
  const sessions = entries.find((entry) => entry.stream === "sessions");
  assert.equal(sessions?.coverage_condition, "complete", "matching boundary keeps proof current");
});

test("narrowing the scope declassifies coverage committed under the old one", () => {
  // The adversarial scenario: full unscoped coverage already committed, then the
  // owner narrows. The old evidence describes a different region.
  const entries = report({ declaredScope: "2026-07-01T00:00:00.000Z", evidenceScope: null });
  const sessions = entries.find((entry) => entry.stream === "sessions");
  assert.notEqual(
    sessions?.coverage_condition,
    "complete",
    "evidence measured over the whole corpus must not read as proof of a narrowed boundary"
  );
  assert.equal(sessions?.coverage_condition, "unknown", "the honest verdict is unknown until a fresh run recomputes");
});

test("clearing the scope declassifies coverage committed under a bound", () => {
  const entries = report({ declaredScope: null, evidenceScope: "2026-06-01T00:00:00.000Z" });
  const sessions = entries.find((entry) => entry.stream === "sessions");
  assert.equal(
    sessions?.coverage_condition,
    "unknown",
    "clearing is a change to `unscoped`, so bounded proof no longer describes what is declared"
  );
});

test("a connection with no scope at all is unaffected", () => {
  const entries = report({ declaredScope: null, evidenceScope: null });
  const sessions = entries.find((entry) => entry.stream === "sessions");
  assert.equal(sessions?.coverage_condition, "complete", "unscoped evidence satisfies an unscoped declaration");
});

// The exact defect the re-gate found: the production call omits
// localCoverageCollectionScope, so anything that makes the projection depend on
// that argument leaves a correctly scoped complete run reading `unknown`
// forever. This pins the derived path directly.
test("a scoped complete run reads complete through the production call shape (no supplied argument)", () => {
  const state = stateWithScope("2026-06-01T00:00:00.000Z");
  const entries = projectCollectionReport({
    connectionHealth: HEALTH,
    lastRun: null,
    localCoverage: localCoverageAxis(state, "since=2026-06-01T00:00:00.000Z"),
    localDeviceBacked: true,
    manifestStreams: MANIFEST_STREAMS as never,
    refreshPolicy: null,
    schedule: null,
  });
  assert.equal(
    entries.find((entry) => entry.stream === "sessions")?.coverage_condition,
    "complete",
    "the measured boundary must be derived from the evidence, not supplied by the caller"
  );
});

// Crash / interruption counterweight. The measured fingerprint rides on the
// coverage rows, so it commits in the same ingest batch as the coverage it
// qualifies -- there is no second store and therefore no window in which a
// crash leaves them disagreeing. The one shape that CAN occur is a partially
// replaced row set spanning two runs (the stable `coverage:<store>` keys upsert
// per store), and that must never read as proof of either boundary.
test("coverage rows spanning two different boundaries never read as complete", () => {
  const state = stateWithScope("2026-06-01T00:00:00.000Z");
  const mixed = deriveLocalCoverageAxis({
    duplicateStores: [],
    hasAuthoritativeInventory: true,
    hasCommittedSnapshot: true,
    malformed: false,
    manifestGeneration: 1,
    missingStores: [],
    nowIso: "2026-08-09T00:00:00.000Z",
    rows: [
      { collectionScope: "since=2026-06-01T00:00:00.000Z", status: "collected", store: "projects", stream: "sessions" },
      { collectionScope: "unscoped", status: "collected", store: "skills", stream: "sessions" },
    ],
    state,
    stateManifestGeneration: 1,
    unexpectedStores: [],
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(
    mixed.measuredCollectionScope,
    null,
    "an ambiguous pairing has no single measured boundary and must not pick one"
  );
  const entries = projectCollectionReport({
    connectionHealth: HEALTH,
    lastRun: null,
    localCoverage: mixed,
    localDeviceBacked: true,
    manifestStreams: MANIFEST_STREAMS as never,
    refreshPolicy: null,
    schedule: null,
  });
  assert.equal(
    entries.find((entry) => entry.stream === "sessions")?.coverage_condition,
    "unknown",
    "a failure between runs must not be able to produce a false complete"
  );
});

test("evidence predating the scope contract satisfies only an unscoped declaration", () => {
  // No fingerprint on the rows at all: a pre-scope collector, which ran a full
  // pass. It must not be credited for a narrowed bound, nor stranded when the
  // connection declares nothing.
  const unscopedDeclared = projectCollectionReport({
    connectionHealth: HEALTH,
    lastRun: null,
    localCoverage: localCoverageAxis(stateWithScope(null), null),
    localDeviceBacked: true,
    manifestStreams: MANIFEST_STREAMS as never,
    refreshPolicy: null,
    schedule: null,
  });
  assert.equal(unscopedDeclared.find((e) => e.stream === "sessions")?.coverage_condition, "complete");

  const narrowedDeclared = projectCollectionReport({
    connectionHealth: HEALTH,
    lastRun: null,
    localCoverage: localCoverageAxis(stateWithScope("2026-06-01T00:00:00.000Z"), null),
    localDeviceBacked: true,
    manifestStreams: MANIFEST_STREAMS as never,
    refreshPolicy: null,
    schedule: null,
  });
  assert.equal(
    narrowedDeclared.find((e) => e.stream === "sessions")?.coverage_condition,
    "unknown",
    "unfingerprinted evidence cannot prove a boundary it never enforced"
  );
});

// FULL SERIALIZATION ROUND-TRIP through the REAL production path:
//
//   coverage record (as the connector emits it)
//     -> buildCoverageDiagnosticsStateSnapshot   (real builder)
//     -> JSON round-trip                          (what persistence does)
//     -> parseCoverageDiagnosticsStateSnapshot    (real parser, the trust gate
//                                                  readCommittedLocalCoverageDiagnostics uses)
//     -> LocalCoverageDiagnosticRow
//     -> deriveLocalCoverageAxis
//     -> projectCollectionReport                  (production call shape)
//
// Hand-built rows would skip the builder and parser, which is exactly where the
// fingerprint was being dropped. Nothing here is constructed by hand except the
// connector's own record.

/**
 * Coverage records as the connector emits them, with the measured boundary.
 * Covers claude_code's full declared store set: a partial snapshot is not a
 * committed one, so a short fixture would never reach `complete` and every
 * assertion below would pass vacuously.
 */
function coverageRecords(scope: string | null): CoverageRecord[] {
  return LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR.claude_code.map(
    (descriptor) =>
      ({
        id: `coverage:${descriptor.store}`,
        reason: "declared source",
        status: "collected",
        store: descriptor.store,
        stream: descriptor.stream,
        ...(scope ? { collection_scope: scope } : {}),
      }) as CoverageRecord
  );
}

/** Persisted snapshot exactly as the collector writes it (JSON, both backends). */
function persistedSnapshot(scope: string | null): unknown {
  return JSON.parse(
    JSON.stringify({
      fetched_at: "2026-08-08T00:00:00.000Z",
      stores: buildCoverageDiagnosticsStateSnapshot(coverageRecords(scope)),
    })
  );
}

function axisFromRealSnapshot(declaredScope: string | null, measuredScope: string | null) {
  const snapshot = persistedSnapshot(measuredScope);
  const parsed = parseCoverageDiagnosticsStateSnapshot("claude_code", snapshot);
  return deriveLocalCoverageAxis({
    duplicateStores: [...parsed.duplicateStores],
    hasAuthoritativeInventory: parsed.hasAuthoritativeInventory,
    hasCommittedSnapshot: parsed.hasCommittedSnapshot,
    malformed: parsed.malformed,
    manifestGeneration: 1,
    missingStores: [...parsed.missingStores],
    nowIso: "2026-08-09T00:00:00.000Z",
    rows: parsed.rows,
    // The axis reads the DECLARED boundary plus the snapshot's own fetched_at
    // (its reliability cursor) out of the coverage stream's persisted state.
    state: { ...(snapshot as Record<string, unknown>), ...stateWithScope(declaredScope) },
    stateManifestGeneration: 1,
    unexpectedStores: [...parsed.unexpectedStores],
    updatedAt: "2026-08-08T00:00:00.000Z",
  });
}

function reportFromRealSnapshot(declaredScope: string | null, measuredScope: string | null) {
  return projectCollectionReport({
    connectionHealth: HEALTH,
    lastRun: null,
    localCoverage: axisFromRealSnapshot(declaredScope, measuredScope),
    localDeviceBacked: true,
    manifestStreams: MANIFEST_STREAMS as never,
    refreshPolicy: null,
    schedule: null,
  });
}

test("the real snapshot builder preserves the measured boundary through JSON persistence", () => {
  const snapshot = persistedSnapshot("since=2026-06-01T00:00:00.000Z") as { stores: Array<Record<string, unknown>> };
  assert.equal(
    snapshot.stores[0]?.collection_scope,
    "since=2026-06-01T00:00:00.000Z",
    "the builder must not strip the boundary -- dropping it here blinds every downstream reader"
  );
  const parsed = parseCoverageDiagnosticsStateSnapshot("claude_code", snapshot);
  assert.equal(parsed.malformed, false, "the parser must accept the scoped entry shape, not fail closed on it");
  assert.equal(
    (parsed.rows.find((row) => row.store === "projects") as { collection_scope?: string } | undefined)
      ?.collection_scope,
    "since=2026-06-01T00:00:00.000Z"
  );
});

test("round-trip: a scoped complete run reads complete through builder, parser, axis, and projection", () => {
  const entries = reportFromRealSnapshot("2026-06-01T00:00:00.000Z", "since=2026-06-01T00:00:00.000Z");
  assert.equal(
    entries.find((entry) => entry.stream === "sessions")?.coverage_condition,
    "complete",
    "the boundary must survive the whole serialization chain"
  );
});

test("round-trip: narrowing the scope declassifies snapshot-persisted coverage", () => {
  const entries = reportFromRealSnapshot("2026-07-01T00:00:00.000Z", "unscoped");
  assert.equal(
    entries.find((entry) => entry.stream === "sessions")?.coverage_condition,
    "unknown",
    "a full-corpus snapshot must not read as proof of a narrowed boundary"
  );
});

test("round-trip: an old snapshot with no boundary stays backward-compatible", () => {
  // Written before the scope contract: it must still parse as proof (not
  // malformed) and satisfy an unscoped declaration, but nothing narrower.
  const legacy = persistedSnapshot(null) as { stores: Array<Record<string, unknown>> };
  assert.equal(
    "collection_scope" in (legacy.stores[0] ?? {}),
    false,
    "no boundary is written when the run declared none, keeping old snapshots byte-compatible"
  );
  assert.equal(parseCoverageDiagnosticsStateSnapshot("claude_code", legacy).malformed, false);

  assert.equal(
    reportFromRealSnapshot(null, null).find((entry) => entry.stream === "sessions")?.coverage_condition,
    "complete",
    "a legacy snapshot still proves an unscoped declaration"
  );
  assert.equal(
    reportFromRealSnapshot("2026-06-01T00:00:00.000Z", null).find((entry) => entry.stream === "sessions")
      ?.coverage_condition,
    "unknown",
    "a legacy snapshot cannot prove a boundary it never enforced"
  );
});
