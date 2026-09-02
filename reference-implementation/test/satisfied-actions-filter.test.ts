// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the UNTESTED `satisfiedActions` dispatch/filter wrapper in
 * `runtime/satisfaction-watcher.ts`.
 *
 * `satisfiedActions(verdictOrActions, evidence)` returns the subset of required
 * actions whose satisfaction contract holds against the evidence bag. It accepts
 * EITHER a bare `RequiredAction[]` OR a `RenderedVerdict` (reading
 * `.required_actions`), and filters via `evaluateSatisfactionContract`.
 *
 * The sibling `controller-satisfaction-watcher.test.js` covers the per-kind
 * contract matrix via `evaluateSatisfactionContract`; this file pins the wrapper
 * itself — its two input forms and the filter semantics — which no test touches.
 *
 * Pure — no DB, no server, no fixtures.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RenderedVerdict, RequiredAction, SatisfactionContract } from "../runtime/rendered-verdict.ts";
import { satisfiedActions } from "../runtime/satisfaction-watcher.ts";

// A test-only fixture: a real RequiredAction plus an `id` tag so assertions
// can identify which fixture action survived the filter by name instead of
// by (fragile) structural equality.
type IdentifiedAction = RequiredAction & { id: string };

function action(id: string, kind: SatisfactionContract["kind"]): IdentifiedAction {
  return {
    affects: [],
    audience: "owner",
    cta: `cta-${id}`,
    id,
    kind: "wait",
    satisfied_when: { kind } as SatisfactionContract,
    terminal: false,
    urgency: "soon",
  };
}

// A mixed set: "none" always satisfied; the other two depend on evidence.
function mixedActions(): IdentifiedAction[] {
  return [
    action("always", "none"),
    action("needs-run", "confirming_run_succeeded"),
    action("needs-sched", "schedule_attached_and_enabled"),
  ];
}

// `satisfiedActions` is typed to return `RequiredAction[]`, discarding the
// test-only `id` tag. The filtered elements are always the SAME references
// that went in (see the "returns the ORIGINAL action objects" test below),
// so this narrows them back to `IdentifiedAction` for assertions.
function isIdentifiedAction(a: RequiredAction): a is IdentifiedAction {
  return "id" in a;
}

function ids(actions: readonly RequiredAction[]): string[] {
  return actions.filter(isIdentifiedAction).map((a) => a.id);
}

// Minimal but fully valid `RenderedVerdict` fixture — only `required_actions`
// matters to `satisfiedActions`, but the wrapper's declared input type is the
// whole verdict, so every other field gets an innocuous stub value.
function verdictWithActions(actions: readonly RequiredAction[]): RenderedVerdict {
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
      mode: "scheduled",
      records_committed_last_run: null,
      retained_records: null,
    },
    required_actions: actions,
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

test("satisfiedActions: array input keeps only actions whose contract holds", () => {
  const out = satisfiedActions(mixedActions(), { lastRun: { status: "succeeded" }, schedule: { enabled: true } });
  assert.deepEqual(ids(out), ["always", "needs-run", "needs-sched"], "all three satisfied");
});

test('satisfiedActions: array input with no evidence keeps only the always-satisfied ("none") action', () => {
  const out = satisfiedActions(mixedActions(), {});
  assert.deepEqual(ids(out), ["always"], "only kind:none survives an empty evidence bag");
});

test("satisfiedActions: partial evidence satisfies only the matching contracts", () => {
  const out = satisfiedActions(mixedActions(), { schedule: { enabled: true } });
  assert.deepEqual(ids(out), ["always", "needs-sched"], "schedule-enabled satisfies sched but not run");
});

test("satisfiedActions: VERDICT input reads required_actions and filters the same way", () => {
  const verdict = verdictWithActions(mixedActions());
  const out = satisfiedActions(verdict, { schedule: { enabled: true } });
  assert.deepEqual(ids(out), ["always", "needs-sched"], "verdict form matches array form");
});

test("satisfiedActions: an empty action array returns an empty result", () => {
  assert.deepEqual(satisfiedActions([], {}), [], "no actions => []");
  assert.deepEqual(satisfiedActions(verdictWithActions([]), {}), [], "verdict with no actions => []");
});

test("satisfiedActions: returns the ORIGINAL action objects (references), not copies", () => {
  const actions = mixedActions();
  const out = satisfiedActions(actions, { lastRun: { status: "succeeded" }, schedule: { enabled: true } });
  // Each returned element is the same reference that came in.
  for (const a of out) {
    assert.ok(
      actions.some((original) => original === a),
      `returned action ${isIdentifiedAction(a) ? a.id : "?"} must be an original reference`
    );
  }
});
