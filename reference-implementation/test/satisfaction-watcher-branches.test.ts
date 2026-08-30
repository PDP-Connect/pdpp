// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing coverage for the NEGATIVE (unsatisfied) branches of
 * `runtime/satisfaction-watcher.ts`. The existing
 * `controller-satisfaction-watcher.test.js` asserts only the `true` outcome
 * for each contract kind, so a mutant that always returns true, inverts a
 * sub-condition, or drops one clause of an AND would survive.
 *
 * This pins the false path (and the branch structure) of every private
 * predicate through the public `evaluateSatisfactionContract`, plus the
 * `ownerSatisfiableActions` filter and the RenderedVerdict-object input path
 * of `satisfiedActions`.
 *
 * The satisfaction contract only READS durable evidence (it does not fetch
 * provider state or enforce scope); `credential_present_and_unrejected`
 * inspects credential-presence evidence but performs no credential/consent
 * enforcement. No source is changed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectionHealthCondition, DetailGapBacklog } from "../runtime/connection-health.ts";
import type { RenderedVerdict, RequiredAction, SatisfactionContract } from "../runtime/rendered-verdict.ts";
import {
  evaluateSatisfactionContract,
  ownerSatisfiableActions,
  satisfiedActions,
} from "../runtime/satisfaction-watcher.ts";

function action(overrides: Partial<RequiredAction> = {}): RequiredAction {
  return {
    affects: [],
    audience: "owner",
    cta: "Reconnect",
    kind: "reauth",
    satisfied_when: { kind: "credential_present_and_unrejected" },
    terminal: false,
    urgency: "now",
    ...overrides,
  };
}

function withKind(kind: SatisfactionContract["kind"], overrides: Partial<RequiredAction> = {}): RequiredAction {
  return action({ satisfied_when: { kind }, ...overrides });
}

const OPEN_OWNER_CONDITION: ConnectionHealthCondition = {
  current: true,
  expires_at: null,
  id: "test-condition",
  message: "Owner attention required.",
  observed_at: null,
  origin: "connector",
  reason: "attention_required",
  reason_code: null,
  remediation: null,
  sensitivity: "owner",
  severity: "warning",
  status: "false",
  type: "AttentionClear",
};

function detailGapBacklog(pending: number): DetailGapBacklog {
  return {
    max_attempt_count: 0,
    next_attempt_at: null,
    pending,
    pending_is_floor: false,
    pending_other: 0,
    pending_other_is_floor: false,
    recovered: null,
    terminal: null,
  };
}

// A minimal-but-fully-typed RenderedVerdict wrapper: only `required_actions`
// varies per test; every other field is a valid, inert default so the
// verdict-object input path of `satisfiedActions` can be exercised without
// fabricating a new type.
function renderedVerdict(requiredActions: readonly RequiredAction[]): RenderedVerdict {
  return {
    annotations: [],
    channel: "calm",
    detail: {
      acknowledged_loss: null,
      collection_rate: null,
      conditions: [],
      coverage_horizons: [],
      detail_gap_backlog: null,
      dominant_condition_id: null,
      forward_disposition: "complete",
      next_attempt_at: null,
      reason_code: null,
      state: "healthy",
      suppressed: [],
    },
    forward_statement: "",
    pill: { label: "Healthy", tone: "green" },
    progress: {
      gaps_drained_last_run: null,
      headline: "",
      last_refreshed_at: null,
      mode: "manual",
      records_committed_last_run: null,
      retained_records: null,
    },
    required_actions: requiredActions,
    streams: [],
    trace: {
      channel_cause: "",
      detail_destinations: [],
      primary_action_kind: null,
      runtime_capped: false,
      satisfied_when: null,
      suppressed_evidence: [],
      tone_cause: "green",
      tone_inputs: [],
    },
  };
}

// ─── credential_present_and_unrejected ───────────────────────────────────

test("credential contract is unsatisfied without credential evidence", () => {
  assert.equal(evaluateSatisfactionContract(action(), {}), false);
  assert.equal(evaluateSatisfactionContract(action(), { credential: null }), false);
});

test("credential contract is unsatisfied when not present or explicitly rejected", () => {
  assert.equal(evaluateSatisfactionContract(action(), { credential: { present: false } }), false);
  assert.equal(evaluateSatisfactionContract(action(), { credential: { present: true, rejected: true } }), false);
});

test("credential contract is unsatisfied for a non-active credential status", () => {
  assert.equal(
    evaluateSatisfactionContract(action(), { credential: { present: true, rejected: false, status: "expired" } }),
    false
  );
});

test("credential contract is satisfied for present+unrejected with active/absent status", () => {
  assert.equal(
    evaluateSatisfactionContract(action(), { credential: { present: true, rejected: false, status: "active" } }),
    true
  );
  assert.equal(evaluateSatisfactionContract(action(), { credential: { present: true, rejected: false } }), true);
  assert.equal(
    evaluateSatisfactionContract(action(), { credential: { present: true, rejected: false, status: null } }),
    true
  );
});

// ─── attention_resolved (conditionIsOpenOwnerAttention clauses) ──────────

test("attention_resolved is false while an open owner-attention condition remains", () => {
  assert.equal(
    evaluateSatisfactionContract(withKind("attention_resolved"), { conditions: [OPEN_OWNER_CONDITION] }),
    false
  );
});

test("attention_resolved is true with no conditions or only resolved ones", () => {
  assert.equal(evaluateSatisfactionContract(withKind("attention_resolved"), {}), true);
  assert.equal(
    evaluateSatisfactionContract(withKind("attention_resolved"), {
      conditions: [{ ...OPEN_OWNER_CONDITION, status: "true" }],
    }),
    true
  );
});

test("attention_resolved ignores non-owner, info-severity, and not-current conditions", () => {
  // Each single clause of conditionIsOpenOwnerAttention, negated, must make
  // the condition NOT count as open attention -> resolved === true.
  assert.equal(
    evaluateSatisfactionContract(withKind("attention_resolved"), {
      conditions: [{ ...OPEN_OWNER_CONDITION, sensitivity: "public" }],
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(withKind("attention_resolved"), {
      conditions: [{ ...OPEN_OWNER_CONDITION, severity: "info" }],
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(withKind("attention_resolved"), {
      conditions: [{ ...OPEN_OWNER_CONDITION, current: false }],
    }),
    true
  );
});

// ─── confirming_run_succeeded ────────────────────────────────────────────

test("confirming_run_succeeded accepts the three success synonyms", () => {
  for (const status of ["succeeded", "completed", "success"]) {
    assert.equal(
      evaluateSatisfactionContract(withKind("confirming_run_succeeded"), { lastRun: { status } }),
      true,
      status
    );
  }
});

test("confirming_run_succeeded is false for a failed or missing run", () => {
  assert.equal(
    evaluateSatisfactionContract(withKind("confirming_run_succeeded"), { lastRun: { status: "failed" } }),
    false
  );
  assert.equal(evaluateSatisfactionContract(withKind("confirming_run_succeeded"), {}), false);
});

// ─── schedule_attached_and_enabled ───────────────────────────────────────

test("schedule_attached_and_enabled requires enabled === true", () => {
  assert.equal(
    evaluateSatisfactionContract(withKind("schedule_attached_and_enabled"), { schedule: { enabled: true } }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(withKind("schedule_attached_and_enabled"), { schedule: { enabled: false } }),
    false
  );
  assert.equal(evaluateSatisfactionContract(withKind("schedule_attached_and_enabled"), {}), false);
});

// ─── gap_recovered (stream recovery + detail-gap-backlog fallback) ───────

test("gap_recovered is satisfied when every affected stream has recovered coverage", () => {
  for (const coverage of ["complete", "accepted_absence", "optional"]) {
    assert.equal(
      evaluateSatisfactionContract(withKind("gap_recovered", { affects: ["messages"] }), {
        streams: [{ coverage, stream_id: "messages" }],
      }),
      true,
      coverage
    );
  }
});

test("gap_recovered is false when an affected stream is not recovered", () => {
  assert.equal(
    evaluateSatisfactionContract(withKind("gap_recovered", { affects: ["messages"] }), {
      streams: [{ coverage: "partial", stream_id: "messages" }],
    }),
    false
  );
});

test("gap_recovered falls back to the detail-gap backlog when no stream evidence applies", () => {
  // No affected streams -> affectedStreamsRecovered returns null -> backlog fallback.
  assert.equal(
    evaluateSatisfactionContract(withKind("gap_recovered"), { detailGapBacklog: detailGapBacklog(0) }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(withKind("gap_recovered"), { detailGapBacklog: detailGapBacklog(3) }),
    false
  );
  assert.equal(evaluateSatisfactionContract(withKind("gap_recovered"), {}), false);
});

// ─── backfill_window_covered ─────────────────────────────────────────────

test("backfill_window_covered short-circuits on the explicit covered flag", () => {
  assert.equal(
    evaluateSatisfactionContract(withKind("backfill_window_covered"), { backfillWindowCovered: true }),
    true
  );
});

test("backfill_window_covered falls through to affected-stream recovery", () => {
  assert.equal(
    evaluateSatisfactionContract(withKind("backfill_window_covered", { affects: ["messages"] }), {
      streams: [{ coverage: "complete", stream_id: "messages" }],
    }),
    true
  );
  assert.equal(
    evaluateSatisfactionContract(withKind("backfill_window_covered", { affects: ["messages"] }), {
      streams: [{ coverage: "partial", stream_id: "messages" }],
    }),
    false
  );
});

// ─── none ────────────────────────────────────────────────────────────────

test("none contract is terminally satisfied", () => {
  assert.equal(evaluateSatisfactionContract(withKind("none"), {}), true);
});

// ─── ownerSatisfiableActions filter ──────────────────────────────────────

test("ownerSatisfiableActions keeps only owner, non-none, non-terminal actions", () => {
  const actions = [
    action({ audience: "owner", satisfied_when: { kind: "credential_present_and_unrejected" } }),
    action({ audience: "none", satisfied_when: { kind: "credential_present_and_unrejected" } }),
    action({ audience: "owner", satisfied_when: { kind: "none" } }),
    action({ audience: "owner", satisfied_when: { kind: "credential_present_and_unrejected" }, terminal: true }),
  ];
  const kept = ownerSatisfiableActions(actions);
  assert.equal(kept.length, 1);
  const [keptAction] = kept;
  if (!keptAction) {
    throw new Error("expected ownerSatisfiableActions to keep exactly one action");
  }
  assert.equal(keptAction.audience, "owner");
  assert.notEqual(keptAction.satisfied_when.kind, "none");
  assert.notEqual(keptAction.terminal, true);
});

// ─── satisfiedActions accepts a RenderedVerdict object ───────────────────

test("satisfiedActions unwraps required_actions from a verdict object", () => {
  const verdict = renderedVerdict([
    action({ satisfied_when: { kind: "none" } }),
    action({ satisfied_when: { kind: "credential_present_and_unrejected" } }),
  ]);
  // Only the 'none' action is satisfied under empty evidence.
  const satisfied = satisfiedActions(verdict, {});
  assert.equal(satisfied.length, 1);
  const [satisfiedAction] = satisfied;
  if (!satisfiedAction) {
    throw new Error("expected satisfiedActions to keep exactly one action");
  }
  assert.equal(satisfiedAction.satisfied_when.kind, "none");
});

test("satisfiedActions also accepts a bare action array", () => {
  const satisfied = satisfiedActions([action({ satisfied_when: { kind: "none" } })], {});
  assert.equal(satisfied.length, 1);
});
