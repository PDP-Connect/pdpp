// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring proof for `design-notes/source-state-truth-2026-08-18.md`'s
 * manual-import case, one layer beyond `connection-health-completed-import.test.ts`
 * (which proves the `Fresh` condition/healthy-predicate change in isolation).
 *
 * This test exercises the FULL owner-facing chain a real `/sources` render
 * takes: `computeConnectionHealth` (production `Fresh`/`not_applicable`
 * derivation) -> `synthesizeRenderedVerdict` (pill label/tone, annotation
 * text, forward statement) -> `deriveOwnerState` (the console work-group
 * resolver). Google Maps Timeline Import and WhatsApp-brennan — both
 * `source_kind = 'manual'`, zero rows in `run_history`, zero schedule — are
 * the real production rows this proves resolve honestly instead of getting
 * stuck at "Not measured" forever.
 *
 * The anti-false-green test at the bottom is the point of this file: a
 * source that merely LACKS a freshness answer (never ran, no schedule, same
 * shape as a completed import except `acquisition` is omitted) must keep
 * resolving `not_measured`/grey — never green, never "Import complete". That
 * is the safety property the design note's rule protects: inapplicability
 * may only come from durable evidence the question is meaningless, never
 * from an absent answer.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ComputeConnectionHealthInput } from "../runtime/connection-health.ts";
import { computeConnectionHealth } from "../runtime/connection-health.ts";
import { deriveOwnerState, type OwnerStateEvidence, scheduleModeFrom } from "../runtime/owner-state.ts";
import { type ScheduleEvidence, synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";

const NOW = "2026-08-18T12:00:00.000Z";

/** A finished manual import: complete coverage, no schedule, no run history — the real shape of both production rows. */
function completedImportInput(overrides: Partial<ComputeConnectionHealthInput> = {}): ComputeConnectionHealthInput {
  return {
    acquisition: { complete: true },
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

function fullChain(input: ComputeConnectionHealthInput) {
  const snap = computeConnectionHealth(input);
  const scheduleEvidence: ScheduleEvidence = {
    hasPriorSuccess: snap.last_success_at !== null,
    mode: scheduleModeFrom(null),
  };
  const verdict = synthesizeRenderedVerdict(snap, [], null, true, null, scheduleEvidence);
  const evidence: OwnerStateEvidence = {
    as_of: null,
    lifecycle: null,
    progress: { active: false },
    schedule_mode: scheduleEvidence.mode,
    source: "none",
  };
  const ownerState = deriveOwnerState(verdict, snap, evidence);
  return { evidence, ownerState, snap, verdict };
}

test("a completed one-time import (manual, no schedule, no runs) reaches a green pill labeled Import complete, not Not measured", () => {
  const { verdict } = fullChain(completedImportInput());
  assert.equal(verdict.pill.tone, "green");
  assert.equal(verdict.pill.label, "Import complete");
});

test("a completed one-time import's freshness annotation names the import, not unmeasured freshness", () => {
  const { verdict } = fullChain(completedImportInput());
  const freshnessAnnotation = verdict.annotations.find((a) => a.kind === "freshness");
  assert.ok(freshnessAnnotation, "a freshness annotation is present");
  assert.match(freshnessAnnotation.text, /one-time import/i);
  assert.doesNotMatch(freshnessAnnotation.text, /has not been measured/i);
});

test("a completed one-time import's forward statement says it finished, not that freshness is unmeasured", () => {
  const { verdict } = fullChain(completedImportInput());
  assert.match(verdict.forward_statement, /finished/i);
  assert.doesNotMatch(verdict.forward_statement, /has not been measured/i);
});

test("a completed one-time import resolves the owner-state resolver to healthy, not not_measured", () => {
  const { ownerState } = fullChain(completedImportInput());
  assert.equal(ownerState.resolver, "healthy");
  assert.notEqual(ownerState.resolver, "not_measured");
});

test("a completed import with incomplete coverage is NOT rescued to green — completeness buys freshness exemption only", () => {
  const { verdict, ownerState } = fullChain(completedImportInput({ coverage: { axis: "unknown" } }));
  assert.notEqual(verdict.pill.tone, "green");
  assert.notEqual(verdict.pill.label, "Import complete");
  assert.notEqual(ownerState.resolver, "healthy");
});

// ─── The safety property: absence of an answer must never look like this ──

test("ANTI-FALSE-GREEN: a source that merely lacks a freshness answer (no acquisition declaration) stays Not measured/grey, never Import complete", () => {
  // Byte-identical shape to the completed-import fixture — complete coverage,
  // no schedule, no run history — with ONLY the `acquisition` declaration
  // removed. This is the exact shape of a genuinely-never-run recurring
  // source (e.g. a freshly created account connector that has not had its
  // first collection yet): the question "is this fresh?" is still open, not
  // settled, so it must never resolve the same as a structurally-complete
  // import.
  const { verdict, ownerState, snap } = fullChain(completedImportInput({ acquisition: null }));

  const fresh = snap.conditions.find((c) => c.type === "Fresh");
  assert.equal(fresh?.status, "unknown", "freshness is a pending question here, not a settled one");

  assert.notEqual(verdict.pill.tone, "green", "an unanswered question must not tone as green");
  assert.notEqual(verdict.pill.label, "Import complete", "the honest label requires a settled not_applicable, not an absence");
  assert.equal(verdict.pill.label, "Not measured");

  assert.equal(ownerState.resolver, "not_measured", "the console work-group must not promote this to healthy");
  assert.notEqual(ownerState.resolver, "healthy");
});

test("ANTI-FALSE-GREEN: a recurring source that is genuinely stale is never rescued into Import complete", () => {
  const { verdict, ownerState } = fullChain(
    completedImportInput({ acquisition: null, freshness: { axis: "stale" }, schedule: { enabled: true } })
  );
  assert.notEqual(verdict.pill.label, "Import complete");
  assert.notEqual(verdict.pill.tone, "green");
  assert.notEqual(ownerState.resolver, "healthy");
});
