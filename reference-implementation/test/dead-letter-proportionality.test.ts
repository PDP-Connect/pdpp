// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proportionality of a local-collector dead-letter backlog, pinned across
 * magnitudes.
 *
 * The defect this file exists to prevent: ONE permanently-stuck record out of
 * 10,001 rendered a 2,511,513-record source RED and "Can't collect" — while
 * that same source was demonstrably still collecting. The owner read the row
 * and asked what it meant. A source that is collecting must not claim it
 * cannot collect (false red); a source that lost records must not hide the
 * loss (false green). This suite pins BOTH edges.
 *
 * The rule under test is a SEVERITY rule, never a visibility rule. At every
 * magnitude — 1 in 10,001 or 10,001 in 10,001 — the owner still gets the
 * verbatim "N of M" count, the same owner-addressed action, and a non-green
 * verdict. What the proportion changes is only whether the pill claims the
 * source is broken.
 *
 * Every case drives the REAL pipeline (`computeConnectionHealth` →
 * `synthesizeRenderedVerdict`), not a hand-assembled snapshot, so a change to
 * the derived headline `state` or the condition set cannot silently bypass
 * these assertions. That matters here specifically: a dead-letter stall
 * derives `state: "degraded"` by itself, and an earlier draft of the fix was
 * unreachable in production for exactly that reason.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ComputeConnectionHealthInput,
  type ConnectionHealthSnapshot,
  computeConnectionHealth,
  type OutboxDiagnosticCounts,
} from "../runtime/connection-health.ts";
import { type StreamRollup, synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";

const OBSERVED_AT = "2026-08-23T12:00:00.000Z";
const SUCCESS_AT = "2026-08-23T11:55:00.000Z";

const LOCAL_COLLECTOR_JARGON = /local collector/i;
const DEAD_LETTER_JARGON = /dead[- ]letter/i;
const PERMANENCE_CLAIM = /will not retry on their own/;
const MANUAL_STEP_CLAIM = /Recovering them is a manual step\./;

/** A connection whose ONLY defect is a dead-letter backlog of the given size. */
function deadLetterInput(counts: OutboxDiagnosticCounts | null): ComputeConnectionHealthInput {
  return {
    activity: { active: false },
    attention: null,
    backoff: null,
    coverage: { axis: "complete" },
    freshness: { axis: "fresh" },
    lastSuccessAt: SUCCESS_AT,
    observedAt: OBSERVED_AT,
    outbox: { axis: "stalled", cause: "dead_letter_backlog", counts },
    readiness: { axis: "ready" },
  } as unknown as ComputeConnectionHealthInput;
}

function completeStream(): StreamRollup {
  return {
    attention_open: false,
    collected: null,
    considered: null,
    coverage: "complete",
    gap_retryable: false,
    priority: "required",
    stream_id: "s1",
    unfillable_accounted: false,
  };
}

function verdictFor(counts: OutboxDiagnosticCounts | null) {
  const health: ConnectionHealthSnapshot = computeConnectionHealth(deadLetterInput(counts));
  return { health, verdict: synthesizeRenderedVerdict(health, [completeStream()], null, true) };
}

/**
 * The loss is VISIBLE at this magnitude: exact count, exact denominator, an
 * owner-addressed action, and a verdict that is never green. Asserted on every
 * case below regardless of severity — this is the anti-false-green floor, and
 * it is what makes the severity split safe.
 */
function assertLossStaysVisible(counts: OutboxDiagnosticCounts, expectedSummary: string) {
  const { verdict } = verdictFor(counts);
  const [action] = verdict.required_actions;
  assert.ok(action, "a dead-letter backlog always emits an owner action");
  assert.equal(action.audience, "owner", "the owner is always told");
  assert.equal(action.remediation?.cause, "dead_letter_backlog");
  assert.equal(action.remediation?.summary, expectedSummary, "the exact proportion is always rendered");
  assert.notEqual(verdict.pill.tone, "green", "a permanent loss is never green");
  assert.notEqual(verdict.pill.label, "Healthy");
}

// ─── Severity by proportion ─────────────────────────────────────────────────

test("minority backlog: the live 1-of-10,001 shape reads stuck, NOT 'Can't collect'", () => {
  // The exact production state the owner reported on his `/sources` row.
  const { verdict } = verdictFor({ dead_letter: 1, succeeded: 10_000, total: 10_001 });
  assert.equal(verdict.pill.tone, "amber", "a source that uploaded 10,000 of 10,001 records is collecting");
  assert.equal(verdict.pill.label, "Some records stuck");
  assert.notEqual(verdict.pill.label, "Can't collect");
  // ...and the loss is still fully visible at this, the smallest magnitude.
  assertLossStaysVisible(
    { dead_letter: 1, succeeded: 10_000, total: 10_001 },
    "1 of 10,001 records on the local collector's host failed to upload and will not retry on their own. Recovering them is a manual step."
  );
});

test("minority backlog: a large ABSOLUTE loss still reads stuck when it is a minority", () => {
  // 4,999 records is a large loss in absolute terms and must be sized
  // honestly, but the host still moved the majority — the source works.
  const { verdict } = verdictFor({ dead_letter: 4999, succeeded: 5002, total: 10_001 });
  assert.equal(verdict.pill.tone, "amber");
  assert.equal(verdict.pill.label, "Some records stuck");
  assertLossStaysVisible(
    { dead_letter: 4999, succeeded: 5002, total: 10_001 },
    "4,999 of 10,001 records on the local collector's host failed to upload and will not retry on their own. Recovering them is a manual step."
  );
});

test("majority backlog: a genuinely broken source still reads 'Can't collect'", () => {
  const { verdict } = verdictFor({ dead_letter: 8432, succeeded: 1569, total: 10_001 });
  assert.equal(verdict.pill.tone, "red", "most records never landed — the host is broken");
  assert.equal(verdict.pill.label, "Can't collect");
  assertLossStaysVisible(
    { dead_letter: 8432, succeeded: 1569, total: 10_001 },
    "8,432 of 10,001 records on the local collector's host failed to upload and will not retry on their own. Recovering them is a manual step."
  );
});

test("half-and-half backlog: exactly 50% is NOT a minority and stays red", () => {
  // The boundary is strict: `dead_letter * 2 < total`. At exactly half, the
  // host failed as much as it succeeded, which is not "some records".
  const { verdict } = verdictFor({ dead_letter: 5000, succeeded: 5000, total: 10_000 });
  assert.equal(verdict.pill.tone, "red");
  assert.equal(verdict.pill.label, "Can't collect");
});

test("total loss: every record stuck reads 'Can't collect'", () => {
  const { verdict } = verdictFor({ dead_letter: 10_001, succeeded: 0, total: 10_001 });
  assert.equal(verdict.pill.tone, "red", "nothing uploaded — the source truly cannot collect");
  assert.equal(verdict.pill.label, "Can't collect");
  assertLossStaysVisible(
    { dead_letter: 10_001, succeeded: 0, total: 10_001 },
    "10,001 of 10,001 records on the local collector's host failed to upload and will not retry on their own. Recovering them is a manual step."
  );
});

test("single-record total loss: 1 of 1 is a total loss, not a minority", () => {
  const { verdict } = verdictFor({ dead_letter: 1, succeeded: 0, total: 1 });
  assert.equal(verdict.pill.tone, "red");
  assert.equal(verdict.pill.label, "Can't collect");
});

// ─── Fail-closed: an unmeasured proportion never buys a gentler label ────────

test("an absent or partial count classifies conservatively as red", () => {
  // Unknown magnitude must never soften the verdict. A count the system did
  // not measure may not be read as "small" — that would be a fabricated
  // green-ward claim, the exact shape `deadLetterMagnitude` already refuses.
  for (const counts of [
    null,
    {},
    { total: 10_001 },
    { dead_letter: 1 },
    { dead_letter: 0, total: 10_001 },
    { dead_letter: 1, total: 0 },
  ] as const) {
    const { verdict } = verdictFor(counts as OutboxDiagnosticCounts | null);
    assert.equal(verdict.pill.tone, "red", `counts ${JSON.stringify(counts)} must not soften the tone`);
    assert.equal(verdict.pill.label, "Can't collect");
  }
});

test("a non-integer count is not a measurement and stays red", () => {
  const { verdict } = verdictFor({ dead_letter: 1.5, total: 10_001 } as unknown as OutboxDiagnosticCounts);
  assert.equal(verdict.pill.tone, "red");
});

// ─── The narrow label is forfeited when anything ELSE is also wrong ──────────

test("a minority backlog beside a real coverage gap reads the broader 'Missing data'", () => {
  // "Some records stuck" is a narrow claim — the source works, a subset did
  // not upload. With a required stream also in a gap, that claim would
  // under-report real trouble.
  const health = computeConnectionHealth({
    ...deadLetterInput({ dead_letter: 1, succeeded: 10_000, total: 10_001 }),
    coverage: { axis: "gaps" },
  } as unknown as ComputeConnectionHealthInput);
  const verdict = synthesizeRenderedVerdict(
    health,
    [{ ...completeStream(), coverage: "gaps", gap_retryable: true }],
    null,
    true
  );
  assert.notEqual(verdict.pill.label, "Some records stuck", "a coverage gap is separate trouble");
  assert.equal(verdict.pill.label, "Missing data");
});

// ─── Owner-facing wording (defect B) ────────────────────────────────────────

test("the recovery action names a machine and a stuck state, not internal jargon", () => {
  const { verdict } = verdictFor({ dead_letter: 1, succeeded: 10_000, total: 10_001 });
  const [action] = verdict.required_actions;
  assert.ok(action);
  assert.equal(action.cta, "Upload records stuck on your computer");
  assert.equal(action.remediation?.label, "Upload records stuck on your computer");
  // "local collector" is jargon for the program on the owner's own machine;
  // the owner does not think of his laptop that way.
  assert.doesNotMatch(action.cta, LOCAL_COLLECTOR_JARGON);
  // "dead letter" is queue-internal vocabulary and must never reach the owner.
  assert.doesNotMatch(action.cta, DEAD_LETTER_JARGON);
  // The summary keeps the permanence signal the label must not contradict.
  assert.match(action.remediation?.summary ?? "", PERMANENCE_CLAIM);
  assert.match(action.remediation?.summary ?? "", MANUAL_STEP_CLAIM);
});
