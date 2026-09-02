// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Proof-of-concept for `design-notes/source-state-truth-2026-08-18.md`.
//
// A finished one-time import (Google Maps Timeline Import: 299,248 records;
// WhatsApp-brennan: 120,042 records) will never refresh again. Both are
// `source_kind = 'manual'` with zero rows in `run_history`. Under the shipped
// model they render "Not measured · Freshness has not been measured yet"
// forever, because `isHealthyConditionSet` demands `Fresh === "true"` and a
// completed import has no recurring capture to age.
//
// The rule under test: for a source whose data acquisition is COMPLETE by
// design, `Fresh` is `not_applicable` — a settled answer — not `unknown`, and
// a not-applicable freshness axis must not veto the healthy verdict.

import assert from "node:assert/strict";
import test from "node:test";

import type { ComputeConnectionHealthInput } from "../runtime/connection-health.ts";
import { computeConnectionHealth } from "../runtime/connection-health.ts";

const NOW = "2026-08-18T12:00:00.000Z";

/** A finished manual import: complete coverage, no schedule, no run history. */
function completedImport(overrides: Partial<ComputeConnectionHealthInput> = {}): ComputeConnectionHealthInput {
  return {
    acquisition: { complete: true, freshnessNotApplicable: true },
    activity: null,
    attention: null,
    backoff: null,
    coverage: { axis: "complete" },
    freshness: null,
    observedAt: NOW,
    outbox: null,
    projection: null,
    run: null,
    schedule: null,
    ...overrides,
  };
}

test("a completed one-time import reports Fresh as not_applicable, not unknown", () => {
  const snap = computeConnectionHealth(completedImport());
  const fresh = snap.conditions.find((item) => item.type === "Fresh");
  assert.equal(fresh?.status, "not_applicable");
  assert.equal(fresh?.reason, "freshness_not_applicable_complete");
  assert.equal(fresh?.severity, "info");
});

test("a completed one-time import is healthy without a Fresh=true proof", () => {
  const snap = computeConnectionHealth(completedImport());
  assert.equal(snap.state, "healthy");
});

test("a completed import still needs complete coverage to be healthy", () => {
  const snap = computeConnectionHealth(completedImport({ coverage: { axis: "unknown" } }));
  assert.notEqual(snap.state, "healthy");
});

test("a completed import with a terminal coverage gap is not healthy", () => {
  const snap = computeConnectionHealth(completedImport({ coverage: { axis: "terminal_gap" } }));
  assert.notEqual(snap.state, "healthy");
});

test("acquisition completeness does not leak into recurring sources", () => {
  // The same shape WITHOUT the completeness declaration must keep the shipped
  // behavior exactly: no freshness evidence stays `unknown` and cannot be green.
  const snap = computeConnectionHealth(completedImport({ acquisition: null }));
  const fresh = snap.conditions.find((item) => item.type === "Fresh");
  assert.equal(fresh?.status, "unknown");
  assert.notEqual(snap.state, "healthy");
});

test("a recurring source that is genuinely stale is never rescued by this path", () => {
  const snap = computeConnectionHealth(
    completedImport({ acquisition: null, freshness: { axis: "stale" }, schedule: { enabled: true } })
  );
  assert.notEqual(snap.state, "healthy");
});

// `complete` and `freshnessNotApplicable` are deliberately separate facts on
// `ConnectionAcquisitionEvidence` (see its doc comment): a manual source_kind
// alone proves freshness does not apply, but proves NOTHING about whether an
// import actually finished. `CollectionSucceeded` SHALL require the
// receipt-gated `complete` fact, never a bare `freshnessNotApplicable: true`.

test("a never-run manual connector does not get CollectionSucceeded=true from source-kind alone", () => {
  const snap = computeConnectionHealth(
    completedImport({ acquisition: { complete: false, freshnessNotApplicable: true } })
  );
  const collectionSucceeded = snap.conditions.find((item) => item.type === "CollectionSucceeded");
  assert.notEqual(collectionSucceeded?.status, "true");
  assert.notEqual(snap.state, "healthy");
});

test("a never-run manual connector still reports Fresh as not_applicable (freshness and completion are independent)", () => {
  const snap = computeConnectionHealth(
    completedImport({ acquisition: { complete: false, freshnessNotApplicable: true } })
  );
  const fresh = snap.conditions.find((item) => item.type === "Fresh");
  assert.equal(fresh?.status, "not_applicable");
});

test("a manual connector with a real successful-import receipt gets CollectionSucceeded=true", () => {
  const snap = computeConnectionHealth(
    completedImport({ acquisition: { complete: true, freshnessNotApplicable: true } })
  );
  const collectionSucceeded = snap.conditions.find((item) => item.type === "CollectionSucceeded");
  assert.equal(collectionSucceeded?.status, "true");
  assert.equal(collectionSucceeded?.reason, "collection_succeeded_import_complete");
});
