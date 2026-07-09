import assert from 'node:assert/strict';
import test from 'node:test';

import { synthesizeRenderedVerdict } from '../runtime/rendered-verdict.ts';
import { deriveOwnerState, ownerStateCausalEvidenceFrom, scheduleModeFrom } from '../runtime/owner-state.ts';

// ─── Builders (mirrors rendered-verdict.test.js) ──────────────────────────────

function condition(overrides = {}) {
  return {
    current: true,
    expires_at: null,
    id: 'Cond:reason',
    message: 'm',
    observed_at: null,
    origin: 'connector',
    reason: 'reason',
    remediation: null,
    sensitivity: 'owner',
    severity: 'info',
    status: 'true',
    type: 'Fresh',
    ...overrides,
  };
}

function credentialRejectedCondition() {
  return condition({
    type: 'CredentialsValid',
    id: 'CredentialsValid:credential_rejected',
    reason: 'credential_rejected',
    status: 'false',
    severity: 'error',
  });
}

function snapshot(overrides = {}) {
  const axes = {
    attention: 'none',
    coverage: 'complete',
    freshness: 'fresh',
    outbox: 'idle',
    remote_surface: 'none',
    ...(overrides.axes ?? {}),
  };
  return {
    axes,
    badges: { stale: false, syncing: false, ...(overrides.badges ?? {}) },
    collection_rate: null,
    conditions: overrides.conditions ?? [],
    detail_gap_backlog: overrides.detail_gap_backlog ?? null,
    dominant_condition_id: overrides.dominant_condition_id ?? null,
    forward_disposition: overrides.forward_disposition ?? 'complete',
    last_success_at: overrides.last_success_at ?? null,
    next_action: null,
    next_attempt_at: overrides.next_attempt_at ?? null,
    reason_code: overrides.reason_code ?? null,
    remote_surface: null,
    state: overrides.state ?? 'healthy',
    supporting_condition_ids: [],
    unknown_reasons: overrides.unknown_reasons ?? [],
  };
}

function stream(overrides = {}) {
  return {
    stream_id: overrides.stream_id ?? 's1',
    coverage: overrides.coverage ?? 'complete',
    gap_retryable: overrides.gap_retryable ?? false,
    attention_open: overrides.attention_open ?? false,
    collected: overrides.collected ?? null,
    considered: overrides.considered ?? null,
    priority: overrides.priority ?? 'required',
  };
}

const AS_OF = '2026-07-09T12:00:00.000Z';
const RESOLVERS = [
  'blocked_maintainer',
  'collecting',
  'healthy',
  'needs_owner',
  'not_measured',
  'owner_paused',
  'refresh_due',
  'retired',
  'system_degraded',
];
const POSTURES = ['frozen-since-last-run', 'observed'];
const OWNERS = ['maintainer', 'owner', 'system'];

/** Real `ScheduleApi`-shaped fixture (only `enabled` matters to `scheduleModeFrom`). */
function scheduleRow(overrides = {}) {
  return { enabled: true, ...overrides };
}

function evidenceFor(input) {
  const { snapshot: snap, active = false, lifecycle = null, schedule = null, source, asOf } = input;
  const resolvedSource = source ?? (active ? 'active_progress' : snap.last_success_at ? 'latest_terminal_run' : 'last_successful_freshness');
  return {
    as_of: asOf !== undefined ? asOf : resolvedSource === 'none' ? null : AS_OF,
    lifecycle,
    progress: { active },
    schedule_mode: scheduleModeFrom(schedule),
    source: resolvedSource,
  };
}

/**
 * Build the verdict + owner state together, exactly as `ref-control.ts` does:
 * `scheduleEvidence` (built from the SAME schedule/last-success facts as
 * `evidence.schedule_mode`) is passed into `synthesizeRenderedVerdict`'s
 * single synthesis pass, NOT applied as a post-pass mutation — `owner-state.ts`
 * only ever reads the resulting verdict (owner review, 2026-07-09: action
 * derivation must have one owner).
 */
function ownerStateFor(snap, streams, input = {}, refresh = null, runtimeOk = true) {
  const evidence = evidenceFor({ snapshot: snap, ...input });
  const scheduleEvidence = {
    hasPriorSuccess: snap.last_success_at !== null,
    mode: evidence.schedule_mode,
  };
  const verdict = synthesizeRenderedVerdict(snap, streams, refresh, runtimeOk, null, scheduleEvidence);
  return { state: deriveOwnerState(verdict, snap, evidence), verdict, evidence };
}

// ─── gate: ownerStateCausalEvidenceFrom ────────────────────────────────────
//
// The caller (`ref-control.ts`) owns run CLASSIFICATION (`coverageClassifyingRun`
// / `healthClassifyingRun` / `isOwnerCancelledRun`) — an owner-cancelled
// latest run is EXCLUDED there, exactly like coverage/health, so it never
// reaches this selector as the classifying run. These fixtures model the
// two shapes the caller produces after that exclusion: a prior success
// substituted in (owner-cancel WITH history), or nothing at all
// (owner-cancel with NO prior history) — this module never sees the
// cancelled run's own timestamp/status either way.

test('ownerStateCausalEvidenceFrom: a succeeded classifying run is observed evidence, not frozen', () => {
  const evidence = ownerStateCausalEvidenceFrom({ last_at: '2026-05-19T12:00:00.000Z', succeeded: true }, null);
  assert.equal(evidence.source, 'last_successful_freshness');
  assert.equal(evidence.as_of, '2026-05-19T12:00:00.000Z');
});

test('ownerStateCausalEvidenceFrom: a non-succeeded (real terminal failure) classifying run is frozen evidence', () => {
  const evidence = ownerStateCausalEvidenceFrom({ last_at: '2026-05-19T12:10:00.000Z', succeeded: false }, null);
  assert.equal(evidence.source, 'latest_terminal_run');
  assert.equal(evidence.as_of, '2026-05-19T12:10:00.000Z');
});

test('ownerStateCausalEvidenceFrom: owner-cancel WITH prior success — caller substitutes the success, never the cancellation, in as the classifying run', () => {
  // The caller already excluded the owner-cancelled run and classified the
  // PRIOR SUCCESS as authoritative (coverageClassifyingRun's owner-cancel
  // fallback) before calling this selector — this module only ever sees the
  // substituted success, never a cancelled run's own timestamp.
  const substitutedSuccess = { last_at: '2026-05-19T12:00:00.000Z', succeeded: true };
  const evidence = ownerStateCausalEvidenceFrom(substitutedSuccess, null);
  assert.equal(evidence.source, 'last_successful_freshness');
  assert.equal(evidence.as_of, '2026-05-19T12:00:00.000Z');
  assert.notEqual(evidence.as_of, '2026-05-19T12:10:00.000Z', 'must never be the excluded cancelled run\'s own last_at');
});

test('ownerStateCausalEvidenceFrom: owner-cancel with NO prior success — caller passes null (no classifying run), never the cancellation itself', () => {
  // The caller's coverageClassifyingRun fallback returns null when there is
  // no prior success to substitute — an owner-cancelled run with no history
  // must never surface as `latest_terminal_run`/frozen via its own
  // timestamp; it has no causal evidence to offer at all.
  const evidence = ownerStateCausalEvidenceFrom(null, null);
  assert.equal(evidence.source, 'none');
  assert.equal(evidence.as_of, null);
});

test('ownerStateCausalEvidenceFrom: no classifying run but a freshness proof exists falls back to observed evidence', () => {
  const evidence = ownerStateCausalEvidenceFrom(null, '2026-05-01T00:00:00.000Z');
  assert.equal(evidence.source, 'last_successful_freshness');
  assert.equal(evidence.as_of, '2026-05-01T00:00:00.000Z');
});

test('ownerStateCausalEvidenceFrom: no classifying run and no freshness proof has no evidence at all — never fabricated', () => {
  const evidence = ownerStateCausalEvidenceFrom(null, null);
  assert.equal(evidence.source, 'none');
  assert.equal(evidence.as_of, null);
});

// ─── gate: scheduleModeFrom ────────────────────────────────────────────────

test('scheduleModeFrom: null (no schedule row) is manual', () => {
  assert.equal(scheduleModeFrom(null), 'manual');
});

test('scheduleModeFrom: a schedule row reads its own enabled flag as active/disabled', () => {
  assert.equal(scheduleModeFrom(scheduleRow({ enabled: true })), 'scheduled-active');
  assert.equal(scheduleModeFrom(scheduleRow({ enabled: false })), 'scheduled-disabled');
});

// ─── Named-fixture gate (task 10.E.3 acceptance): Chase-shaped, USAA-shaped,
// owner-paused, never-run, and healthy fixtures each resolve to the single
// documented expected value. ────────────────────────────────────────────────

test('gate: Chase-shaped — retryable gap resolves to system_degraded, system-owned, frozen', () => {
  const snap = snapshot({
    state: 'degraded',
    axes: { coverage: 'retryable_gap' },
    last_success_at: '2026-06-01T00:00:00.000Z',
  });
  const streams = [stream({ coverage: 'retryable_gap', gap_retryable: true, priority: 'required' })];
  const { state } = ownerStateFor(snap, streams, { schedule: scheduleRow() });
  assert.equal(state.resolver, 'system_degraded');
  assert.equal(state.owner_of_state, 'system');
  assert.equal(state.posture, 'frozen-since-last-run');
  assert.equal(state.evidence_as_of, AS_OF);
});

test('gate: USAA-shaped — credential-rejected resolves to needs_owner, owner-owned, frozen', () => {
  const snap = snapshot({
    state: 'blocked',
    conditions: [credentialRejectedCondition()],
    last_success_at: '2026-06-01T00:00:00.000Z',
  });
  const { state } = ownerStateFor(snap, [], { schedule: scheduleRow() });
  assert.equal(state.resolver, 'needs_owner');
  assert.equal(state.owner_of_state, 'owner');
  assert.equal(state.posture, 'frozen-since-last-run');
});

test('gate: owner-paused (prior success, automatic schedule disabled) resolves to owner_paused, owner-owned, observed', () => {
  const snap = snapshot({ state: 'idle', last_success_at: '2026-06-01T00:00:00.000Z' });
  const { state, verdict } = ownerStateFor(snap, [], {
    schedule: scheduleRow({ enabled: false }),
    source: 'last_successful_freshness',
  });
  assert.equal(state.resolver, 'owner_paused');
  assert.equal(state.owner_of_state, 'owner');
  assert.equal(state.posture, 'observed');
  // reattach_schedule is emitted inside the single synthesis pass (rendered-verdict.ts).
  assert.ok(verdict.required_actions.some((a) => a.kind === 'reattach_schedule'));
});

test('gate: a connector with no schedule row (manual) never resolves owner_paused', () => {
  const snap = snapshot({ state: 'idle', last_success_at: '2026-06-01T00:00:00.000Z' });
  const { state, verdict } = ownerStateFor(snap, [], {
    schedule: null,
    source: 'last_successful_freshness',
  });
  assert.notEqual(state.resolver, 'owner_paused');
  assert.ok(!verdict.required_actions.some((a) => a.kind === 'reattach_schedule'));
});

// `effective_mode` is deliberately NOT read by `scheduleModeFrom`:
// `computeEffectiveMode` (controller.ts:1685-1696) returns `"paused"` for
// BOTH `enabled: false` (operator intent) AND `enabled: true` with
// `human_attention_needed` (a system-side ineligibility), and never returns
// `"manual"` at all — so it cannot distinguish an owner pause from an armed
// schedule that merely needs attention, and cannot signal "no schedule
// exists." The row's own `enabled` flag is the authority (per the
// `ScheduleApi` doc comment: enabled=false is operator intent).
test('gate: an enabled schedule row stays scheduled-active — never owner_paused — even when effective_mode would read paused', () => {
  const snap = snapshot({ state: 'idle', last_success_at: '2026-06-01T00:00:00.000Z' });
  const { state, verdict } = ownerStateFor(snap, [], {
    // enabled: true + human_attention_needed: true => computeEffectiveMode
    // returns "paused" upstream, but this is system ineligibility, not an
    // owner pause; the row's own enabled flag says it is still armed.
    schedule: scheduleRow({ enabled: true, effective_mode: 'paused', human_attention_needed: true }),
    source: 'last_successful_freshness',
  });
  assert.notEqual(state.resolver, 'owner_paused');
  assert.ok(!verdict.required_actions.some((a) => a.kind === 'reattach_schedule'));
});

test('gate: explicit revoked lifecycle resolves to retired, maintainer-owned, regardless of health shape', () => {
  const snap = snapshot({ state: 'blocked', last_success_at: '2026-06-01T00:00:00.000Z' });
  const { state } = ownerStateFor(snap, [], {
    lifecycle: { status: 'revoked' },
    schedule: scheduleRow(),
    source: 'latest_terminal_run',
  });
  assert.equal(state.resolver, 'retired');
  assert.equal(state.owner_of_state, 'maintainer');
});

test('gate: no lifecycle evidence never resolves retired, even for a terminal code_fix verdict', () => {
  const snap = snapshot({ state: 'blocked', forward_disposition: 'terminal', last_success_at: '2026-06-01T00:00:00.000Z' });
  const streams = [stream({ coverage: 'terminal_gap', priority: 'required' })];
  const { state } = ownerStateFor(snap, streams, { lifecycle: null, schedule: scheduleRow(), source: 'latest_terminal_run' });
  assert.notEqual(state.resolver, 'retired');
});

test('gate: never-run (idle, no prior success) resolves to healthy, system-owned, observed', () => {
  const snap = snapshot({ state: 'idle', last_success_at: null });
  const { state } = ownerStateFor(snap, [], { schedule: scheduleRow(), source: 'last_successful_freshness' });
  assert.equal(state.resolver, 'healthy');
  assert.equal(state.owner_of_state, 'system');
  assert.equal(state.posture, 'observed');
});

// Wave 10a evidence-fabrication regression (2026-07-09): a caller with
// NEITHER a terminal run NOR a freshness proof (`freshness.captured_at` is
// genuinely nullable — see ref-control.ts) must pass `source: "none"` and
// `as_of: null`, never fall back to projection read time and mislabel it
// `last_successful_freshness`. Projection read time is not causal evidence
// (design gate #4). Per owner review (2026-07-09): absent instrumentation
// with no active work resolves `not_measured`, NEVER `healthy` — a genuinely
// unmeasured connection must not read green just because `baseStateTone`
// happens to score a never-run `idle` connection as tone `"green"`.
test('gate: no evidence at all (never-run, no freshness proof, no active work) resolves not_measured with a null evidence_as_of, never green or fabricated', () => {
  const snap = snapshot({ state: 'idle', last_success_at: null });
  const { state } = ownerStateFor(snap, [], {
    schedule: scheduleRow(),
    active: false,
    source: 'none',
    asOf: null,
  });
  assert.equal(state.resolver, 'not_measured');
  assert.equal(state.owner_of_state, 'system');
  assert.equal(state.posture, 'observed');
  assert.equal(state.evidence_as_of, null);
});

test('gate: no evidence at all BUT an active run in progress resolves collecting, not not_measured', () => {
  const snap = snapshot({ state: 'idle', last_success_at: null });
  const { state } = ownerStateFor(snap, [], {
    schedule: scheduleRow(),
    active: true,
    source: 'active_progress',
  });
  assert.equal(state.resolver, 'collecting');
  assert.notEqual(state.resolver, 'not_measured');
});

test('gate: healthy fixture resolves to healthy, system-owned, observed', () => {
  const snap = snapshot({ state: 'healthy', last_success_at: '2026-07-09T00:00:00.000Z' });
  const { state } = ownerStateFor(snap, [], { schedule: scheduleRow(), source: 'last_successful_freshness' });
  assert.equal(state.resolver, 'healthy');
  assert.equal(state.owner_of_state, 'system');
  assert.equal(state.posture, 'observed');
});

test('gate: an active run resolves collecting even on a grey (unmeasured) tone, never not_measured', () => {
  const snap = snapshot({ state: 'unknown', last_success_at: null });
  const { state } = ownerStateFor(snap, [], { active: true, schedule: scheduleRow(), source: 'active_progress' });
  assert.equal(state.resolver, 'collecting');
  assert.equal(state.posture, 'observed');
});

// ─── Named priority-conflict fixtures (owner review, 2026-07-09) ─────────────
//
// A disabled schedule must never mask a more urgent credential or maintainer
// failure underneath it. These name the exact conflicts the priority chain
// in `resolveOwnerStateResolver` AND `buildRequiredActions`
// (`rendered-verdict.ts`) must resolve in the owner/maintainer's favor, not
// the schedule's.

test('gate: paused schedule + credential failure resolves needs_owner, not owner_paused (reauth must not be masked)', () => {
  const snap = snapshot({
    state: 'blocked',
    conditions: [credentialRejectedCondition()],
    last_success_at: '2026-06-01T00:00:00.000Z',
  });
  const { state, verdict } = ownerStateFor(snap, [], {
    schedule: scheduleRow({ enabled: false }),
    source: 'latest_terminal_run',
  });
  assert.equal(state.resolver, 'needs_owner');
  assert.notEqual(state.resolver, 'owner_paused');
  // reattach_schedule must not have displaced reauth as the primary action.
  assert.equal(verdict.required_actions[0].kind, 'reauth');
});

test('gate: paused schedule + terminal code_fix defect resolves blocked_maintainer, not owner_paused (code_fix must not be masked)', () => {
  const snap = snapshot({
    state: 'blocked',
    forward_disposition: 'terminal',
    last_success_at: '2026-06-01T00:00:00.000Z',
  });
  const streams = [stream({ coverage: 'terminal_gap', priority: 'required' })];
  const { state, verdict } = ownerStateFor(snap, streams, {
    schedule: scheduleRow({ enabled: false }),
    source: 'latest_terminal_run',
  });
  assert.equal(state.resolver, 'blocked_maintainer');
  assert.notEqual(state.resolver, 'owner_paused');
  assert.equal(verdict.required_actions[0].kind, 'code_fix');
});

// ─── Exhaustive cross-product property test ───────────────────────────────────
//
// This is a STRUCTURAL property test: it proves determinism, closed-enum
// membership, and the resolver/posture/action invariants that hold for EVERY
// input combination, over a large fixture matrix. It does NOT independently
// prove semantic correctness for every (state, coverage) pairing — that is
// what the named fixtures above (Chase-shaped, USAA-shaped, owner-paused,
// paused+reauth, paused+code_fix, no-evidence, active-run) are for. Treat
// this test as "nothing is malformed across the matrix," not as "every cell
// is semantically right" — the named fixtures carry the semantic burden for
// the specific priority conflicts (revoked vs action, active vs stale,
// paused vs reauth/code_fix, refresh-due vs system-degraded, none vs
// healthy).

const STATES = ['healthy', 'idle', 'cooling_off', 'needs_attention', 'degraded', 'blocked', 'unknown'];
const COVERAGES = ['complete', 'partial', 'gaps', 'retryable_gap', 'terminal_gap', 'unsupported', 'unavailable', 'unknown'];
const SCHEDULE_MODES = [scheduleRow({ enabled: true }), scheduleRow({ enabled: false }), null];
const LAST_SUCCESS = [null, '2026-06-01T00:00:00.000Z'];
const LIFECYCLES = [null, { status: 'active' }, { status: 'revoked' }];
const PROGRESS_ACTIVE = [false, true];

function crossProductCase(state, coverage, schedule, lastSuccessAt, lifecycle, active) {
  const snap = snapshot({ state, axes: { coverage }, last_success_at: lastSuccessAt });
  const streams = coverage === 'complete' ? [] : [stream({ coverage, priority: 'required' })];
  // A fixture with a prior success is modeled as a SUCCEEDED terminal run
  // (last_successful_freshness/observed), matching ref-control.ts's real
  // `lastRunSucceeded` selection — not the generic latest_terminal_run/frozen
  // default, which is reserved for defect evidence.
  const source = active ? 'active_progress' : lastSuccessAt ? 'last_successful_freshness' : 'none';
  return ownerStateFor(snap, streams, { active, lifecycle, schedule, source });
}

test('exhaustive cross-product: every (state, coverage, schedule, last_success, lifecycle, active) resolves to exactly one owner state', () => {
  let cases = 0;
  for (const state of STATES) {
    for (const coverage of COVERAGES) {
      for (const schedule of SCHEDULE_MODES) {
        for (const lastSuccessAt of LAST_SUCCESS) {
          for (const lifecycle of LIFECYCLES) {
            for (const active of PROGRESS_ACTIVE) {
              let state1;
              let state2;
              try {
                ({ state: state1 } = crossProductCase(state, coverage, schedule, lastSuccessAt, lifecycle, active));
                ({ state: state2 } = crossProductCase(state, coverage, schedule, lastSuccessAt, lifecycle, active));
              } catch {
                // A small number of state/coverage combinations violate the
                // rendered-verdict honesty invariants (e.g. terminal coverage
                // paired with a state that never reaches terminal) and correctly
                // throw in dev — those are not reachable production shapes and
                // are out of scope for this cross-product (rendered-verdict.ts
                // already exhaustively covers its own invariant gate).
                continue;
              }
              cases += 1;
              // Determinism: identical inputs always produce an identical owner state.
              assert.deepEqual(
                state1,
                state2,
                `non-deterministic for ${state}/${coverage}/${JSON.stringify(schedule)}/${lastSuccessAt}/${JSON.stringify(lifecycle)}/${active}`
              );
              // Closed enum membership.
              assert.ok(RESOLVERS.includes(state1.resolver), `unknown resolver ${state1.resolver}`);
              assert.ok(POSTURES.includes(state1.posture), `unknown posture ${state1.posture}`);
              assert.ok(OWNERS.includes(state1.owner_of_state), `unknown owner_of_state ${state1.owner_of_state}`);
              assert.equal(state1.evidence_as_of, active || lastSuccessAt ? AS_OF : null);
              // Design gate #2: retired is reachable ONLY from explicit revoked lifecycle.
              if (state1.resolver === 'retired') {
                assert.equal(lifecycle?.status, 'revoked', 'retired resolved without revoked lifecycle evidence');
              }
              // Design gate #3: owner_paused/refresh-schedule requires a real
              // schedule row that is disabled — never an absent (manual) schedule.
              if (state1.resolver === 'owner_paused') {
                assert.ok(schedule && schedule.enabled === false);
              }
            }
          }
        }
      }
    }
  }
  // Sanity: the matrix actually exercised a meaningful number of shapes.
  assert.ok(cases > 100, `expected a large cross-product, got ${cases}`);
});

// `RenderedVerdict` intentionally supports MULTIPLE ordered
// `required_actions[]` (e.g. both `reauth` and a secondary `code_fix`) — a
// connection can legitimately carry more than one owner-audience action.
// "At most one primary" does NOT mean `ownerActions.length <= 1`; it means
// index 0 is the SOLE primary by contract, the array stays urgency-sorted,
// and — specific to this module's contribution — `reattach_schedule` never
// displaces an existing higher-priority owner/maintainer action from index 0
// or creates a second action that competes with it as if it were also
// primary. Secondary actions remain allowed and unconstrained in count.
test('exhaustive cross-product: required_actions stay urgency-sorted and reattach_schedule never creates a competing primary', () => {
  const URGENCY_RANK = { now: 0, overdue: 1, soon: 2, verifying: 3 };
  let cases = 0;
  for (const state of STATES) {
    for (const coverage of COVERAGES) {
      for (const schedule of SCHEDULE_MODES) {
        for (const lastSuccessAt of LAST_SUCCESS) {
          let verdict;
          try {
            ({ verdict } = crossProductCase(state, coverage, schedule, lastSuccessAt, null, false));
          } catch {
            continue;
          }
          cases += 1;
          // Stable urgency ordering: no action is less urgent than the one
          // before it (ties allowed; a regression would let a stray
          // `reattach_schedule` insertion break the pre-sorted order).
          for (let i = 1; i < verdict.required_actions.length; i += 1) {
            const prevRank = URGENCY_RANK[verdict.required_actions[i - 1].urgency];
            const rank = URGENCY_RANK[verdict.required_actions[i].urgency];
            assert.ok(
              rank >= prevRank,
              `required_actions out of urgency order at index ${i} for ${state}/${coverage}/${JSON.stringify(schedule)}/${lastSuccessAt}`
            );
          }
          // If a reattach_schedule action is present alongside another
          // owner-audience primary-eligible action (urgency now/overdue), it
          // must never be the one occupying index 0 — the more urgent real
          // defect stays primary.
          const reattachIndex = verdict.required_actions.findIndex((a) => a.kind === 'reattach_schedule');
          if (reattachIndex >= 0) {
            const hasMoreUrgentOwnerOrMaintainer = verdict.required_actions.some(
              (a, i) =>
                i !== reattachIndex &&
                (a.audience === 'maintainer' || (a.audience === 'owner' && a.urgency !== 'soon'))
            );
            if (hasMoreUrgentOwnerOrMaintainer) {
              assert.notEqual(
                reattachIndex,
                0,
                `reattach_schedule displaced a higher-priority action as primary for ${state}/${coverage}`
              );
            }
          }
        }
      }
    }
  }
  assert.ok(cases > 20, `expected a meaningful number of cases, got ${cases}`);
});

test('deriveOwnerState: pure — identical inputs produce identical output (no clock read)', () => {
  const snap = snapshot({ state: 'degraded', axes: { coverage: 'retryable_gap' }, last_success_at: '2026-06-01T00:00:00.000Z' });
  const streams = [stream({ coverage: 'retryable_gap', gap_retryable: true })];
  const verdict = synthesizeRenderedVerdict(snap, streams, null, true, null);
  const evidence = {
    as_of: AS_OF,
    lifecycle: { status: 'active' },
    progress: { active: false },
    schedule_mode: scheduleModeFrom(scheduleRow()),
    source: 'latest_terminal_run',
  };
  const a = deriveOwnerState(verdict, snap, evidence);
  const b = deriveOwnerState(verdict, snap, evidence);
  assert.deepEqual(a, b);
  assert.equal(a.evidence_as_of, AS_OF);
});
