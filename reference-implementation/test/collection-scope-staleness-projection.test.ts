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
function localCoverageAxis(state: Record<string, unknown>) {
  return deriveLocalCoverageAxis({
    duplicateStores: [],
    hasAuthoritativeInventory: true,
    hasCommittedSnapshot: true,
    malformed: false,
    manifestGeneration: 1,
    missingStores: [],
    nowIso: "2026-08-09T00:00:00.000Z",
    rows: [{ status: "collected", store: "projects", stream: "sessions" }],
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

function report(input: { declaredScope: string | null; evidenceScope: string | null }) {
  const state = stateWithScope(input.declaredScope);
  return projectCollectionReport({
    connectionHealth: HEALTH,
    lastRun: null,
    localCoverage: localCoverageAxis(state),
    localCoverageCollectionScope: input.evidenceScope === null ? "unscoped" : `since=${input.evidenceScope}`,
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
