// Pure recovery-decision helper coverage (OpenSpec
// `add-connector-neutral-recovery-governor`, tasks 1.2–1.5).
//
// These tests pin the connector-neutral classifier/admission decisions that the
// scheduler, controller, and console projection all read. They exercise the
// pure module in isolation — no store, no timers — against synthetic detail-gap
// row projections, exactly the "pure recovery decision functions and tests over
// synthetic detail-gap rows" the migration plan (design.md step 1) calls for.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PRESSURE_EVIDENCE_WINDOW_MS,
  classifyRecoveryGap,
  classifyRecoveryReason,
  hasEligibleNonPressureRecovery,
  hasFreshPressureEvidence,
  lastPressureAtForGap,
  partitionPressureEvidence,
  partitionRecoveryBacklog,
  providerWorkDomainForGap,
  providerWorkDomainKey,
  resolveRecoveryAdmission,
  sameWorkDomain,
} from '../runtime/recovery-decision.ts';

// ── Row factory ──────────────────────────────────────────────────────────────

function gapRow(overrides = {}) {
  return {
    connector_id: 'amazon',
    connector_instance_id: 'amazon:default',
    reason: 'retry_exhausted',
    status: 'pending',
    attempt_count: 1,
    next_attempt_after: null,
    detail_class: null,
    stream: 'order_items',
    ...overrides,
  };
}

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const NOW_MS = Date.parse('2026-07-06T00:00:00.000Z');

// ── classification basics ────────────────────────────────────────────────────

test('classifyRecoveryReason maps pressure reasons to a single provider_pressure class', () => {
  assert.equal(classifyRecoveryReason('rate_limited'), 'provider_pressure');
  assert.equal(classifyRecoveryReason('upstream_pressure'), 'provider_pressure');
});

test('classifyRecoveryReason keeps non-pressure recovery classes distinct', () => {
  assert.equal(classifyRecoveryReason('retry_exhausted'), 'retry_exhausted');
  assert.equal(classifyRecoveryReason('temporary_unavailable'), 'temporary_unavailable');
  assert.equal(classifyRecoveryReason('run_cap_deferred'), 'run_cap_deferred');
});

test('classifyRecoveryReason routes terminal + informational reasons off the retry path', () => {
  assert.equal(classifyRecoveryReason('auth_failure'), 'owner_required');
  assert.equal(classifyRecoveryReason('not_found'), 'connector_defect');
  assert.equal(classifyRecoveryReason('gone'), 'connector_defect');
  assert.equal(classifyRecoveryReason('permanent_forbidden'), 'connector_defect');
  assert.equal(classifyRecoveryReason('out_of_scope'), 'informational');
  assert.equal(classifyRecoveryReason(null), 'unknown');
  assert.equal(classifyRecoveryReason('some_novel_label'), 'unknown');
});

// ── Task 1.2: run-cap / retry-budget deferrals are NON-source-pressure ────────

test('1.2 run-cap deferral classifies as non-source-pressure recovery', () => {
  // A connector that reaches its per-run blast-radius cap emits the canonical
  // `retry_exhausted` reason but a `run_cap_deferred` detail.class. The class
  // must win so a planned cap is not confused with exhausted retries, and it
  // must NOT be treated as source pressure (design.md D4 / spec "Planned run
  // cap is not source pressure").
  const c = classifyRecoveryGap(gapRow({ reason: 'retry_exhausted', detail_class: 'run_cap_deferred' }));
  assert.equal(c.recoveryClass, 'run_cap_deferred');
  assert.equal(c.isSourcePressure, false);
  assert.equal(c.isNonPressureRecovery, true);
});

test('1.2 run-cap deferral reads the real durable last_error.class shape', () => {
  // Durable gap rows do not have a `detail_class` column; `rowToGap` exposes
  // connector-supplied neutral classes through `last_error.class`.
  const c = classifyRecoveryGap(
    gapRow({ reason: 'retry_exhausted', detail_class: null, last_error: { class: 'run_cap_deferred' } })
  );
  assert.equal(c.recoveryClass, 'run_cap_deferred');
  assert.equal(c.isSourcePressure, false);
  assert.equal(c.isNonPressureRecovery, true);
});

test('1.2 connector classes from last_error.class map into runtime recovery classes', () => {
  assert.equal(
    classifyRecoveryGap(
      gapRow({ reason: 'temporary_unavailable', detail_class: null, last_error: { class: 'owner_repair_required' } })
    ).recoveryClass,
    'owner_required'
  );
  assert.equal(
    classifyRecoveryGap(
      gapRow({ reason: 'temporary_unavailable', detail_class: null, last_error: { class: 'transient_no_progress' } })
    ).recoveryClass,
    'temporary_unavailable'
  );
  assert.equal(
    classifyRecoveryGap(
      gapRow({ reason: 'temporary_unavailable', detail_class: null, last_error: { class: 'provider_pressure' } })
    ).recoveryClass,
    'provider_pressure'
  );
  assert.equal(
    classifyRecoveryGap(
      gapRow({ reason: 'temporary_unavailable', detail_class: null, last_error: { class: 'connector_defect' } })
    ).recoveryClass,
    'connector_defect'
  );
});

test('1.2 retry-budget exhaustion is drainable non-pressure recovery, not pressure', () => {
  const c = classifyRecoveryGap(gapRow({ reason: 'retry_exhausted' }));
  assert.equal(c.recoveryClass, 'retry_exhausted');
  assert.equal(c.isSourcePressure, false);
  assert.equal(c.isNonPressureRecovery, true);
});

test('1.2 a run-cap deferral is admitted for recovery even under a domain cooldown', () => {
  // The domain cooldown gates only pressure work; a planned-cap deferral must
  // remain admissible so a per-run cap never becomes the cross-run drain gate.
  const admission = resolveRecoveryAdmission(
    gapRow({ reason: 'retry_exhausted', detail_class: 'run_cap_deferred' }),
    { nowMs: NOW_MS, domainCooldownActive: true, domainCooldownUntil: FUTURE }
  );
  assert.deepEqual(admission, {
    ok: true,
    mode: 'recover',
    workDomain: { connectorId: 'amazon', connectorInstanceId: 'amazon:default' },
  });
});

// ── Task 1.3: provider pressure blocks ordinary retry until next eligible time ─

test('1.3 provider-pressure gap with a future floor denies with cooldown + next eligible time', () => {
  const admission = resolveRecoveryAdmission(
    gapRow({ reason: 'rate_limited', next_attempt_after: FUTURE }),
    { nowMs: NOW_MS }
  );
  assert.deepEqual(admission, { ok: false, reason: 'cooldown', nextEligibleAt: FUTURE });
});

test('1.3 provider-pressure gap under an active domain cooldown denies with the cooldown-until time', () => {
  const admission = resolveRecoveryAdmission(
    gapRow({ reason: 'upstream_pressure', next_attempt_after: null }),
    { nowMs: NOW_MS, domainCooldownActive: true, domainCooldownUntil: FUTURE }
  );
  assert.deepEqual(admission, { ok: false, reason: 'cooldown', nextEligibleAt: FUTURE });
});

test('1.3 provider-pressure gap whose floor has passed and no active cooldown is admitted', () => {
  const admission = resolveRecoveryAdmission(
    gapRow({ reason: 'rate_limited', next_attempt_after: PAST }),
    { nowMs: NOW_MS, domainCooldownActive: false }
  );
  assert.equal(admission.ok, true);
});

test('1.3 owner_required and connector_defect never admit an ordinary retry', () => {
  assert.deepEqual(
    resolveRecoveryAdmission(gapRow({ reason: 'auth_failure', status: 'terminal' }), { nowMs: NOW_MS }),
    { ok: false, reason: 'owner_required' }
  );
  assert.deepEqual(
    resolveRecoveryAdmission(gapRow({ reason: 'not_found', status: 'terminal' }), { nowMs: NOW_MS }),
    { ok: false, reason: 'system_issue' }
  );
  assert.deepEqual(
    resolveRecoveryAdmission(
      gapRow({ reason: 'temporary_unavailable', last_error: { class: 'owner_repair_required' } }),
      { nowMs: NOW_MS }
    ),
    { ok: false, reason: 'owner_required' }
  );
});

// ── Task 1.4: unrelated provider work domains do not block each other ─────────

test('1.4 work domain is derived per connector instance', () => {
  const a = providerWorkDomainForGap(gapRow({ connector_id: 'amazon', connector_instance_id: 'amazon:default' }));
  const b = providerWorkDomainForGap(gapRow({ connector_id: 'chatgpt', connector_instance_id: 'chatgpt:default' }));
  assert.equal(providerWorkDomainKey(a), 'amazon::amazon:default');
  assert.equal(sameWorkDomain(a, b), false);
  assert.equal(sameWorkDomain(a, a), true);
});

test('1.4 instance id falls back to connector id when absent', () => {
  const domain = providerWorkDomainForGap(gapRow({ connector_id: 'github', connector_instance_id: null }));
  assert.deepEqual(domain, { connectorId: 'github', connectorInstanceId: 'github' });
});

test('1.4 a cooldown on domain A does not deny recovery in unrelated domain B', () => {
  // Domain A (chatgpt) is under a provider-pressure cooldown. Domain B (amazon)
  // has ordinary non-pressure recovery work. B's admission must be unaffected —
  // the caller scopes cooldown state per domain, and the classifier proves the
  // domains are distinct so B is never gated by A.
  const rows = [
    gapRow({ connector_id: 'chatgpt', connector_instance_id: 'chatgpt:default', reason: 'upstream_pressure' }),
    gapRow({ connector_id: 'amazon', connector_instance_id: 'amazon:default', reason: 'retry_exhausted' }),
  ];
  const backlog = partitionRecoveryBacklog(rows);
  assert.equal(backlog.size, 2);

  // Domain A cooling; a pressure gap in A is denied.
  const aAdmission = resolveRecoveryAdmission(rows[0], { nowMs: NOW_MS, domainCooldownActive: true, domainCooldownUntil: FUTURE });
  assert.equal(aAdmission.ok, false);

  // Domain B is not cooling (its own cooldown state is false) → admitted.
  const bAdmission = resolveRecoveryAdmission(rows[1], { nowMs: NOW_MS, domainCooldownActive: false });
  assert.equal(bAdmission.ok, true);
  assert.equal(bAdmission.mode, 'recover');
  assert.equal(bAdmission.workDomain.connectorId, 'amazon');
});

// ── Task 1.5: stale pressure rows must not starve non-pressure recovery ───────

test('1.5 a pressure minority does not make the non-pressure majority ineligible', () => {
  // The live 51-holds-942 shape: a handful of stale upstream_pressure gaps
  // alongside a large non-pressure backlog in the SAME domain. Even with the
  // domain cooldown active, the non-pressure recovery work must remain
  // eligible (spec "Source-pressure cooldown SHALL NOT starve non-pressure
  // recovery").
  const rows = [];
  for (let i = 0; i < 51; i++) {
    rows.push(gapRow({ reason: 'upstream_pressure', next_attempt_after: FUTURE, attempt_count: 9 }));
  }
  for (let i = 0; i < 942; i++) {
    rows.push(gapRow({ reason: 'retry_exhausted', record_key: `k${i}` }));
  }
  const backlog = partitionRecoveryBacklog(rows);
  const domainKey = providerWorkDomainKey({ connectorId: 'amazon', connectorInstanceId: 'amazon:default' });
  const entry = backlog.get(domainKey);
  assert.ok(entry);
  assert.equal(entry.pressure.length, 51);
  assert.equal(entry.nonPressure.length, 942);

  // With the domain cooldown active, non-pressure recovery is still eligible…
  assert.equal(hasEligibleNonPressureRecovery(entry, NOW_MS), true);
  // …and each non-pressure gap is individually admitted despite the cooldown.
  const admission = resolveRecoveryAdmission(rows[51], { nowMs: NOW_MS, domainCooldownActive: true, domainCooldownUntil: FUTURE });
  assert.equal(admission.ok, true);
  // …while a pressure gap in the same domain is still denied.
  const pressureAdmission = resolveRecoveryAdmission(rows[0], { nowMs: NOW_MS, domainCooldownActive: true, domainCooldownUntil: FUTURE });
  assert.equal(pressureAdmission.ok, false);
  assert.equal(pressureAdmission.reason, 'cooldown');
});

test('1.5 the classifier arms source pressure ONLY on pressure reasons (stale rows cannot re-arm via other classes)', () => {
  // Cooldown re-arming reads `isSourcePressure`. A residual non-pressure row —
  // even one that has been retried many times — must never report source
  // pressure, so it can never re-arm the domain cooldown. This is the classifier
  // half of the "stale pressure classifications do not re-arm cooldown"
  // invariant (the cooldown governor already ignores non-pressure reasons; this
  // proves the shared classifier agrees).
  for (const reason of ['retry_exhausted', 'temporary_unavailable', 'run_cap_deferred', 'not_found', 'auth_failure', null]) {
    const c = classifyRecoveryGap(gapRow({ reason, attempt_count: 40 }));
    assert.equal(c.isSourcePressure, false, `reason ${reason} must not be source pressure`);
  }
  // Only the two canonical pressure reasons arm it.
  assert.equal(classifyRecoveryGap(gapRow({ reason: 'rate_limited' })).isSourcePressure, true);
  assert.equal(classifyRecoveryGap(gapRow({ reason: 'upstream_pressure' })).isSourcePressure, true);
});

test('1.5 hasEligibleNonPressureRecovery respects per-item next-attempt floors', () => {
  // A non-pressure gap whose OWN floor is still in the future is not yet
  // eligible; one with a past/absent floor is. This keeps the anti-starvation
  // predicate honest — it reports eligibility, not mere existence.
  const futureOnly = partitionRecoveryBacklog([
    gapRow({ reason: 'retry_exhausted', next_attempt_after: FUTURE }),
  ]).get(providerWorkDomainKey({ connectorId: 'amazon', connectorInstanceId: 'amazon:default' }));
  assert.equal(hasEligibleNonPressureRecovery(futureOnly, NOW_MS), false);

  const mixed = partitionRecoveryBacklog([
    gapRow({ reason: 'retry_exhausted', next_attempt_after: FUTURE }),
    gapRow({ reason: 'retry_exhausted', next_attempt_after: PAST, record_key: 'other' }),
  ]).get(providerWorkDomainKey({ connectorId: 'amazon', connectorInstanceId: 'amazon:default' }));
  assert.equal(hasEligibleNonPressureRecovery(mixed, NOW_MS), true);
});

// ── Task 1.5: fresh-pressure re-arm guard ─────────────────────────────────────
// The temporal half of "stale pressure classifications do not re-arm cooldown":
// a pressure row whose last observation predates the evidence window is stale
// evidence, and stale rows on their own must not keep a domain in cooldown.

test('1.5 lastPressureAtForGap prefers last_attempt_at then falls back to updated_at', () => {
  assert.equal(
    lastPressureAtForGap(gapRow({ last_attempt_at: '2026-07-05T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z' })),
    '2026-07-05T00:00:00.000Z'
  );
  assert.equal(
    lastPressureAtForGap(gapRow({ last_attempt_at: null, updated_at: '2026-07-05T00:00:00.000Z' })),
    '2026-07-05T00:00:00.000Z'
  );
  assert.equal(lastPressureAtForGap(gapRow({ last_attempt_at: null, updated_at: null })), null);
});

test('1.5 recent pressure is fresh evidence and re-arms; window-old pressure is stale', () => {
  // One pressure row observed 1 minute ago (fresh) and one observed 7 hours ago
  // (older than the 6h default window → stale).
  const freshAt = new Date(NOW_MS - 60_000).toISOString();
  const staleAt = new Date(NOW_MS - 7 * 60 * 60 * 1000).toISOString();
  const rows = [
    gapRow({ reason: 'upstream_pressure', last_attempt_at: freshAt }),
    gapRow({ reason: 'rate_limited', last_attempt_at: staleAt, record_key: 'k2' }),
  ];
  const partition = partitionPressureEvidence(rows, NOW_MS);
  assert.equal(partition.fresh.length, 1);
  assert.equal(partition.stale.length, 1);
  assert.equal(hasFreshPressureEvidence(rows, NOW_MS), true);
});

test('1.5 the 51-stale-pressure residue reports NO fresh evidence (must not re-arm alone)', () => {
  // The live shape: 51 pressure rows all last observed well before the window,
  // plus 942 non-pressure rows. There is zero FRESH pressure evidence, so the
  // domain must not stay in cooldown on those residual rows — the arming seam
  // asks `hasFreshPressureEvidence`, which is false here.
  const staleAt = new Date(NOW_MS - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
  const rows = [];
  for (let i = 0; i < 51; i++) {
    rows.push(gapRow({ reason: 'upstream_pressure', last_attempt_at: staleAt, attempt_count: 9, record_key: `p${i}` }));
  }
  for (let i = 0; i < 942; i++) {
    rows.push(gapRow({ reason: 'retry_exhausted', record_key: `n${i}` }));
  }
  const partition = partitionPressureEvidence(rows, NOW_MS);
  assert.equal(partition.fresh.length, 0);
  assert.equal(partition.stale.length, 51);
  assert.equal(hasFreshPressureEvidence(rows, NOW_MS), false);
});

test('1.5 a pressure row with no observation timestamp is treated as stale, not fresh', () => {
  // Absent evidence is not fresh evidence: a pressure row that cannot prove a
  // recent observation must never re-arm the cooldown on its own.
  const rows = [gapRow({ reason: 'upstream_pressure', last_attempt_at: null, updated_at: null })];
  const partition = partitionPressureEvidence(rows, NOW_MS);
  assert.equal(partition.fresh.length, 0);
  assert.equal(partition.stale.length, 1);
  assert.equal(hasFreshPressureEvidence(rows, NOW_MS), false);
});

test('1.5 non-pressure rows are ignored by the pressure-evidence partition', () => {
  const freshAt = new Date(NOW_MS - 60_000).toISOString();
  const rows = [
    gapRow({ reason: 'retry_exhausted', last_attempt_at: freshAt }),
    gapRow({ reason: 'run_cap_deferred', last_attempt_at: freshAt, record_key: 'k2' }),
  ];
  const partition = partitionPressureEvidence(rows, NOW_MS);
  assert.equal(partition.fresh.length, 0);
  assert.equal(partition.stale.length, 0);
  assert.equal(hasFreshPressureEvidence(rows, NOW_MS), false);
});

test('1.5 the evidence window is configurable and defaults to the cooldown ceiling', () => {
  const observedAt = new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
  const rows = [gapRow({ reason: 'upstream_pressure', last_attempt_at: observedAt })];
  // Under the default 6h window, 2h-old pressure is still fresh…
  assert.equal(DEFAULT_PRESSURE_EVIDENCE_WINDOW_MS, 6 * 60 * 60 * 1000);
  assert.equal(hasFreshPressureEvidence(rows, NOW_MS), true);
  // …but under a tight 1h window it is stale.
  assert.equal(hasFreshPressureEvidence(rows, NOW_MS, 60 * 60 * 1000), false);
});
