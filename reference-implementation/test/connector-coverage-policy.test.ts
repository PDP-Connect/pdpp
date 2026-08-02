// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMessagesCoverageMessage,
  buildMessagesDropSkipResult,
  type MessagesCoverage,
  newMessagesCoverage,
} from "../../packages/polyfill-connectors/connectors/gmail/index.ts";
import { deriveStreamCoverageCondition } from "../server/connector-coverage-policy.ts";
import type { RuntimeCollectionFact, RuntimeCollectionFactSkip } from "../server/ref-control.ts";

function fact(overrides: Partial<RuntimeCollectionFact> = {}): RuntimeCollectionFact {
  return {
    checkpoint: "committed",
    collected: 5,
    considered: 100,
    covered: null,
    pending_detail_gaps: 0,
    skipped: null,
    stream: "repositories",
    ...overrides,
  };
}

test("checkpoint-window streams treat collected as changed-record count, not coverage numerator", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact(), {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
    }),
    "complete"
  );
});

test("checkpoint-window streams remain partial until the boundary checkpoint is committed", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ checkpoint: "pending" }), {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
    }),
    "partial"
  );
});

test("parent-detail accounting still requires an accounted-for covered count", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact(), {
      coverage_strategy: "parent_detail_accounting",
      freshness_strategy: "scheduled_window",
    }),
    "partial"
  );

  assert.equal(
    deriveStreamCoverageCondition(fact({ collected: 0, considered: 1, covered: 1 }), {
      coverage_strategy: "parent_detail_accounting",
      freshness_strategy: "scheduled_window",
    }),
    "complete"
  );

  assert.equal(
    deriveStreamCoverageCondition(fact({ covered: 100 }), {
      coverage_strategy: "parent_detail_accounting",
      freshness_strategy: "scheduled_window",
    }),
    "complete"
  );
});

test("pending detail gaps outrank checkpoint strategy proof", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ pending_detail_gaps: 1 }), {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
    }),
    "retryable_gap"
  );
});

test("explicit maintainer skip remains terminal when a recoverable detail gap coexists", () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({
        pending_detail_gaps: 2,
        skipped: {
          reason: "credit_card_export_unverified",
          recovery_action: "update_selector",
        },
        stream: "transactions",
      }),
      { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window" }
    ),
    "terminal_gap"
  );
});

test("skip facts outrank checkpoint strategy proof", () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({
        skipped: {
          reason: "rate_limited",
          recovery_action: "retry_by_runtime",
        },
      }),
      {
        coverage_strategy: "checkpoint_window",
        freshness_strategy: "scheduled_window",
      }
    ),
    "retryable_gap"
  );
});

// Defensive normalization: the type contract is `considered: number | null`,
// but a caller that bypasses `readRuntimeCollectionFact`'s re-validation
// (this test constructs the fact directly, unchecked by TypeScript) could
// hand an `undefined` denominator. `undefined !== null` would otherwise read
// as a KNOWN denominator, and `0 < undefined` is `false`, so a zero-collected
// fact would wrongly read `complete` instead of `unknown`.
test("an undefined (not null) considered denominator still reads unknown, never fabricates complete", () => {
  assert.equal(
    // @ts-expect-error deliberately hands `considered: undefined`, a type
    // violation the runtime must still handle defensively per the comment
    // above — this IS the assertion, not a fixable input.
    deriveStreamCoverageCondition(fact({ checkpoint: "not_staged", collected: 0, considered: undefined }), {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
    }),
    "unknown"
  );
});

test("raw local coverage statuses defer accepted absence to manifest policy and retain true gaps", () => {
  const localFact = (coverage_statuses: readonly string[]): RuntimeCollectionFact =>
    fact({
      considered: null,
      coverage_statuses,
    });
  const accepted = (coverage_policy: "collect" | "deferred" | "inventory_only" | "unavailable" | "unsupported") => ({
    coverage_policy,
    required: false,
  });

  assert.equal(
    deriveStreamCoverageCondition(localFact(["collected"]), { coverage_strategy: "checkpoint_window" }),
    "complete"
  );
  assert.equal(
    deriveStreamCoverageCondition(localFact(["inventory_only"]), accepted("inventory_only")),
    "inventory_only"
  );
  assert.equal(deriveStreamCoverageCondition(localFact(["deferred"]), accepted("deferred")), "deferred");
  assert.equal(deriveStreamCoverageCondition(localFact(["unsupported"]), accepted("unsupported")), "unsupported");
  assert.equal(
    deriveStreamCoverageCondition(localFact(["excluded"]), accepted("inventory_only")),
    "inventory_only",
    "excluded follows its declared policy rather than a local status mapping"
  );
  assert.equal(
    deriveStreamCoverageCondition(localFact(["excluded"]), { coverage_strategy: "checkpoint_window" }),
    "unknown",
    "an undeclared excluded absence must not become complete"
  );
  assert.equal(
    deriveStreamCoverageCondition(localFact(["missing"]), { coverage_strategy: "checkpoint_window" }),
    "unknown",
    "raw status alone is not a gap; the handoff must supply concrete pending-gap evidence"
  );
  assert.equal(
    deriveStreamCoverageCondition(fact({ coverage_statuses: ["missing"], pending_detail_gaps: 1 }), {
      coverage_strategy: "checkpoint_window",
    }),
    "retryable_gap"
  );
  assert.equal(
    deriveStreamCoverageCondition(fact({ coverage_statuses: ["unaccounted"], pending_detail_gaps: 1 }), {
      coverage_strategy: "checkpoint_window",
    }),
    "retryable_gap"
  );
});

// ─── Gmail `messages`: dropped-row SKIP_RESULT closes the false-complete gap ─
//
// Unit D of the fleet evidence-contract gate (2026-07-31) found that a Gmail
// run containing ONLY metadata rows missing X-GM-MSGID, or ONLY per-message
// errors `emitMessagesPass` catches and swallows, populates neither
// `considered` nor `covered` in `MessagesCoverage` — those rows have no
// natural, non-fabricated id to record. A bare `considered: 0, covered: 0`
// fact plus a committed `messages` checkpoint would otherwise satisfy
// `deriveGapFreeStreamCoverageCondition`'s checkpoint-proves-coverage path
// (rule 4) and read `complete`, silently hiding real dropped rows.
//
// The fix mirrors Amazon's `unparseable_order_date` SKIP_RESULT
// (amazon/index.ts:1377-1390): `buildMessagesDropSkipResult` emits one
// bounded, count-only `SKIP_RESULT` for `stream: "messages"` whenever either
// drop class occurred. These tests drive the CONNECTOR'S ACTUAL EMITTED
// MESSAGE through the runtime's skip-fact shape and the real read-side
// policy function, proving the full projection — not just the connector's
// internal accumulator — never reads `complete` for either drop class alone,
// even with a committed checkpoint and a real (unrelated) considered/covered
// pair satisfied.

/**
 * Narrow the connector's actual `SKIP_RESULT` emission down to exactly the
 * fields the runtime's `handleSkipResultMessage` (reference-implementation/
 * runtime/index.ts) carries onto `RuntimeCollectionFactSkip` — `reason` and
 * an optional `recovery_action` sourced from `recovery_hint`. Gmail's
 * `buildMessagesDropSkipResult` sets no `recovery_hint`, matching Amazon's
 * `unparseable_order_date` emission, so there is no automatic retry path.
 */
function skipFactFromEmittedSkipResult(
  skipResult: ReturnType<typeof buildMessagesDropSkipResult>
): RuntimeCollectionFactSkip {
  assert.ok(skipResult, "expected the connector to emit a SKIP_RESULT for this drop");
  return { reason: skipResult.reason };
}

test("buildMessagesDropSkipResult: a droppedNoId-only run emits SKIP_RESULT with the dropped count, no fabricated id", () => {
  const coverage: MessagesCoverage = { ...newMessagesCoverage(), droppedNoId: 3 };
  const skipResult = buildMessagesDropSkipResult(coverage);
  assert.ok(skipResult);
  assert.equal(skipResult.type, "SKIP_RESULT");
  assert.equal(skipResult.stream, "messages");
  assert.deepEqual(skipResult.diagnostics, { caught_errors: 0, dropped_no_id: 3 });
  // No id/key field anywhere on the message — count-only, mirroring Amazon.
  assert.ok(!("id" in skipResult));
  assert.ok(!("record_key" in skipResult));
});

test("buildMessagesDropSkipResult: a caughtErrors-only run emits SKIP_RESULT with the caught-error count, no fabricated id", () => {
  const coverage: MessagesCoverage = { ...newMessagesCoverage(), caughtErrors: 2 };
  const skipResult = buildMessagesDropSkipResult(coverage);
  assert.ok(skipResult);
  assert.equal(skipResult.stream, "messages");
  assert.deepEqual(skipResult.diagnostics, { caught_errors: 2, dropped_no_id: 0 });
});

test("buildMessagesDropSkipResult: a clean run (nothing dropped) emits nothing", () => {
  assert.equal(buildMessagesDropSkipResult(newMessagesCoverage()), null);
});

test("end-to-end: an only-missing-ID run projects NOT complete despite a committed checkpoint and satisfied considered/covered", () => {
  // Satisfied denominator + committed checkpoint alone would read `complete`
  // (see the first test in this file) — this proves the dropped-row skip
  // fact is what changes the projection, not an unrelated shortfall.
  const coverage: MessagesCoverage = { ...newMessagesCoverage(), droppedNoId: 5 };
  const skipResult = buildMessagesDropSkipResult(coverage);
  const condition = deriveStreamCoverageCondition(
    fact({
      checkpoint: "committed",
      collected: 10,
      considered: 10,
      covered: 10,
      skipped: skipFactFromEmittedSkipResult(skipResult),
      stream: "messages",
    }),
    { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window" }
  );
  assert.notEqual(condition, "complete", "a run that dropped unaccounted rows must never read complete");
  assert.equal(condition, "terminal_gap", "no retryable/deferred/unavailable/unsupported reason pattern matches");
});

test("end-to-end: an only-caught-error run projects NOT complete despite a committed checkpoint and satisfied considered/covered", () => {
  const coverage: MessagesCoverage = { ...newMessagesCoverage(), caughtErrors: 4 };
  const skipResult = buildMessagesDropSkipResult(coverage);
  const condition = deriveStreamCoverageCondition(
    fact({
      checkpoint: "committed",
      collected: 10,
      considered: 10,
      covered: 10,
      skipped: skipFactFromEmittedSkipResult(skipResult),
      stream: "messages",
    }),
    { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window" }
  );
  assert.notEqual(condition, "complete", "a run with only caught-and-swallowed errors must never read complete");
  assert.equal(condition, "terminal_gap");
});

test("end-to-end: a zero-considered steady-state run with NO drops of either kind still reads complete", () => {
  // Regression guard for the opposite failure mode: the new SKIP_RESULT must
  // not fire on a genuinely clean run, or every honest zero-considered
  // `messages`-only run would wrongly stop projecting complete.
  const coverage = newMessagesCoverage();
  assert.equal(buildMessagesDropSkipResult(coverage), null, "a clean run emits no SKIP_RESULT");
  const condition = deriveStreamCoverageCondition(
    fact({
      checkpoint: "committed",
      collected: 0,
      considered: 0,
      covered: 0,
      skipped: null,
      stream: "messages",
    }),
    { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window" }
  );
  assert.equal(condition, "complete");
});

// ─── Unit D second follow-up: emitter-rejected rows must not inflate
// ─── `covered`, AND must not create a `covered < considered` gap that a
// ─── committed checkpoint silently papers over ─────────────────────────────
//
// The gate found that `processMessage` marked a message `covered` immediately
// after calling `emitRecord`, without checking its return value. `emitRecord`
// can reject a considered, in-scope, in-range message for two real reasons:
// an explicit `resources` selection scope excluded it, or schema validation
// failed. The fix is NOT simply "move the rejected id from covered to
// considered-but-not-covered" — this file's FIRST test already proves that
// `checkpoint_window` + a committed checkpoint reads `complete` from a mere
// `considered !== null` (deriveGapFreeStreamCoverageCondition's rule 1 fires
// BEFORE it ever compares `covered` against `considered`), so a bare
// `covered < considered` shortfall alone would still be silently masked.
// Instead: a rejection is excluded from `considered` ENTIRELY (the record
// was never owed under this run's declared scope), and the genuinely
// source-semantic failure reason (`schema_validation_failed`) already emits
// its own independent, unconditional `SKIP_RESULT` — which forces
// non-`complete` through the skip-precedence rule (rule 2 in
// `deriveStreamCoverageCondition`, checked before the checkpoint-proves-
// coverage path even runs), with no dependence on `considered`/`covered` at
// all.

test("end-to-end: a rejected emission excluded from considered still projects complete when the rest of the boundary is satisfied", () => {
  // The resources-scope-exclusion case: nothing went wrong, the record was
  // never owed under this run's declared scope, so the remaining (accepted)
  // boundary reading `complete` is the correct, non-over-corrected outcome —
  // proven against the connector's REAL buildMessagesCoverageMessage output.
  const coverage: MessagesCoverage = {
    caughtErrors: 0,
    considered: ["gmmsgid-ok-1", "gmmsgid-ok-2"], // the rejected id never entered this list
    covered: ["gmmsgid-ok-1", "gmmsgid-ok-2"],
    droppedNoId: 0,
    rejectedEmission: ["gmmsgid-rejected"], // tracked for diagnostics only
    timeRangeDropped: [],
  };
  const coverageMsg = buildMessagesCoverageMessage(coverage);
  assert.equal(coverageMsg.considered, 2, "the rejected id must not appear in the denominator at all");
  assert.equal(coverageMsg.covered, 2);

  const condition = deriveStreamCoverageCondition(
    fact({
      checkpoint: "committed",
      collected: 2,
      considered: coverageMsg.considered ?? null,
      covered: coverageMsg.covered ?? null,
      skipped: null,
      stream: "messages",
    }),
    { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window" }
  );
  assert.equal(condition, "complete", "an out-of-scope exclusion must not force the rest of the boundary non-complete");
});

test("end-to-end: schema_validation_failed's own independent SKIP_RESULT forces non-complete regardless of considered/covered", () => {
  // The schema-validation-failure case: makeEmitRecord already emits its own
  // SKIP_RESULT for this before returning false, entirely independent of
  // MessagesCoverage bookkeeping. This test proves that signal alone — with
  // no rejected-id accounting in considered/covered at all — is sufficient
  // to force non-complete, exactly like the two Unit D SKIP_RESULT tests
  // above for droppedNoId/caughtErrors, using the SAME precedence rule.
  const condition = deriveStreamCoverageCondition(
    fact({
      checkpoint: "committed",
      collected: 2,
      considered: 2,
      covered: 2,
      skipped: { reason: "schema_validation_failed" },
      stream: "messages",
    }),
    { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window" }
  );
  assert.notEqual(
    condition,
    "complete",
    "a satisfied considered/covered pair alone must not mask a real schema failure"
  );
  assert.equal(condition, "terminal_gap");
});

test("end-to-end: covered equal to considered (no rejections) still projects complete — the fix does not over-correct", () => {
  // Regression guard for the opposite failure mode: a genuinely fully
  // accepted run must not start reading partial just because rejection
  // accounting now exists.
  const coverage: MessagesCoverage = {
    caughtErrors: 0,
    considered: ["gmmsgid-1", "gmmsgid-2"],
    covered: ["gmmsgid-1", "gmmsgid-2"],
    droppedNoId: 0,
    rejectedEmission: [],
    timeRangeDropped: [],
  };
  const coverageMsg = buildMessagesCoverageMessage(coverage);
  const condition = deriveStreamCoverageCondition(
    fact({
      checkpoint: "committed",
      collected: 2,
      considered: coverageMsg.considered ?? null,
      covered: coverageMsg.covered ?? null,
      skipped: null,
      stream: "messages",
    }),
    { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window" }
  );
  assert.equal(condition, "complete");
});
