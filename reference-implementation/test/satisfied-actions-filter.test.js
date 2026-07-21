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

import assert from 'node:assert/strict';
import test from 'node:test';

import { satisfiedActions } from '../runtime/satisfaction-watcher.ts';

function action(id, kind) {
  return { id, audience: 'owner', satisfied_when: { kind }, terminal: false };
}

// A mixed set: "none" always satisfied; the other two depend on evidence.
function mixedActions() {
  return [
    action('always', 'none'),
    action('needs-run', 'confirming_run_succeeded'),
    action('needs-sched', 'schedule_attached_and_enabled'),
  ];
}

test('satisfiedActions: array input keeps only actions whose contract holds', () => {
  const out = satisfiedActions(mixedActions(), { lastRun: { status: 'succeeded' }, schedule: { enabled: true } });
  assert.deepEqual(out.map((a) => a.id), ['always', 'needs-run', 'needs-sched'], 'all three satisfied');
});

test('satisfiedActions: array input with no evidence keeps only the always-satisfied ("none") action', () => {
  const out = satisfiedActions(mixedActions(), {});
  assert.deepEqual(out.map((a) => a.id), ['always'], 'only kind:none survives an empty evidence bag');
});

test('satisfiedActions: partial evidence satisfies only the matching contracts', () => {
  const out = satisfiedActions(mixedActions(), { schedule: { enabled: true } });
  assert.deepEqual(out.map((a) => a.id), ['always', 'needs-sched'], 'schedule-enabled satisfies sched but not run');
});

test('satisfiedActions: VERDICT input reads required_actions and filters the same way', () => {
  const verdict = { required_actions: mixedActions() };
  const out = satisfiedActions(verdict, { schedule: { enabled: true } });
  assert.deepEqual(out.map((a) => a.id), ['always', 'needs-sched'], 'verdict form matches array form');
});

test('satisfiedActions: an empty action array returns an empty result', () => {
  assert.deepEqual(satisfiedActions([], {}), [], 'no actions => []');
  assert.deepEqual(satisfiedActions({ required_actions: [] }, {}), [], 'verdict with no actions => []');
});

test('satisfiedActions: returns the ORIGINAL action objects (references), not copies', () => {
  const actions = mixedActions();
  const out = satisfiedActions(actions, { lastRun: { status: 'succeeded' }, schedule: { enabled: true } });
  // Each returned element is the same reference that came in.
  for (const a of out) {
    assert.ok(actions.includes(a), `returned action ${a.id} must be an original reference`);
  }
});
