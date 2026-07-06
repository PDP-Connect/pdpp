/**
 * Per-item recovery quarantine + crash-honest attempt accounting.
 *
 * OpenSpec `add-connector-neutral-recovery-governor`:
 *   - task 1.6  - per-item quarantine helpers and tests: a poison item reaches
 *     its per-item threshold, is quarantined with evidence and a terminal class,
 *     remains visible in accounting, and siblings keep draining.
 *   - task 2.5  - idempotency + crash-accounting: a re-attempt after an
 *     interrupted attempt does not duplicate records; interrupted attempts count
 *     and repeated interruption escalates to a connector/system issue.
 *   - runtime part of task 3.4 - repeated transient no-progress becomes a durable
 *     connector/system issue rather than owner retry busywork.
 *
 * The pure decision (`evaluateQuarantine`) has no store; the effectful wrapper
 * (`maybeQuarantineGap`) mirrors `maybeTerminateGap` and terminalizes via the
 * existing durable `terminal` status with a distinct `quarantined` class. The
 * recovery-decision classifier routes `quarantined` to `connector_defect` /
 * `system_issue` (no owner retry).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDb, initDb } from '../server/db.js';
import { createSqliteConnectorDetailGapStore } from '../server/stores/connector-detail-gap-store.js';
import { maybeQuarantineGap } from '../server/stores/terminal-gap-classifier.js';
import {
  DEFAULT_QUARANTINE_POLICY,
  QUARANTINE_CLASS,
  evaluateQuarantine,
} from '../runtime/recovery-quarantine.ts';
import { classifyRecoveryGap, classifyRecoveryReason, resolveRecoveryAdmission } from '../runtime/recovery-decision.ts';

test('evaluateQuarantine: item under its no-progress budget is not quarantined', () => {
  const decision = evaluateQuarantine({ status: 'pending', attempt_count: 3 }, { maxNoProgressAttempts: 8 });
  assert.equal(decision.quarantine, false);
  assert.equal(decision.reason, 'under_budget');
});

test('evaluateQuarantine: item at its no-progress budget is quarantined with the crossing evidence', () => {
  const decision = evaluateQuarantine({ status: 'pending', attempt_count: 8 }, { maxNoProgressAttempts: 8 });
  assert.equal(decision.quarantine, true);
  assert.equal(decision.attemptCount, 8);
  assert.equal(decision.threshold, 8);
});

test('evaluateQuarantine: recovered / terminal items are never quarantined (recovery already concluded)', () => {
  assert.deepEqual(
    evaluateQuarantine({ status: 'recovered', attempt_count: 99 }, { maxNoProgressAttempts: 2 }),
    { quarantine: false, reason: 'recovered' },
  );
  assert.deepEqual(
    evaluateQuarantine({ status: 'terminal', attempt_count: 99 }, { maxNoProgressAttempts: 2 }),
    { quarantine: false, reason: 'already_terminal' },
  );
});

test('evaluateQuarantine: a finite positive budget is mandatory - a poison item can never opt out', () => {
  assert.throws(() => evaluateQuarantine({ status: 'pending', attempt_count: 1 }, { maxNoProgressAttempts: 0 }));
  assert.throws(() => evaluateQuarantine({ status: 'pending', attempt_count: 1 }, {}));
  assert.throws(() => evaluateQuarantine({ status: 'pending', attempt_count: 1 }, { maxNoProgressAttempts: -1 }));
});

test('DEFAULT_QUARANTINE_POLICY is a finite positive integer budget', () => {
  assert.ok(
    Number.isInteger(DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts)
      && DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts > 0,
  );
});

test('a quarantined gap classifies as connector_defect and is denied as a system_issue (no owner retry)', () => {
  const row = {
    connector_id: 'amazon',
    connector_instance_id: 'amazon:default',
    stream: 'order_items',
    status: 'terminal',
    reason: QUARANTINE_CLASS,
    attempt_count: 8,
  };
  assert.equal(classifyRecoveryGap(row).recoveryClass, 'connector_defect');
  const admission = resolveRecoveryAdmission(row);
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, 'system_issue');
});

test('quarantine gate: planned run-cap and provider-pressure re-defers are NOT quarantine-eligible; no-progress classes are', () => {
  const eligible = (reason) => {
    const c = classifyRecoveryReason(reason);
    return c !== 'run_cap_deferred' && c !== 'provider_pressure' && c !== 'owner_required' && c !== 'informational';
  };
  assert.equal(eligible('run_cap_deferred'), false);
  assert.equal(eligible('rate_limited'), false);
  assert.equal(eligible('upstream_pressure'), false);
  assert.equal(eligible('auth_failure'), false);
  assert.equal(eligible('out_of_scope'), false);
  assert.equal(eligible('temporary_unavailable'), true);
  assert.equal(eligible('retry_exhausted'), true);
  assert.equal(eligible(null), true, 'unknown/absent reason is treated as generic no-progress recovery work');
});

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-recovery-quarantine-'));
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const CONNECTOR_INSTANCE_ID = 'amazon:default';

async function seedGap(store, recordKey, overrides = {}) {
  return store.upsertPendingGap({
    connectorId: 'amazon',
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    grantId: 'grant_test',
    stream: 'order_items',
    recordKey,
    reason: 'temporary_unavailable',
    detailLocator: { kind: 'amazon.order', order_id: recordKey },
    ...overrides,
  });
}

test('maybeQuarantineGap: poison item reaches its per-item threshold -> terminal quarantined with evidence, still counted', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const gap = await seedGap(store, 'order_poison');
  const policy = { maxNoProgressAttempts: 3 };

  await store.markGapStatus(gap.gap_id, 'in_progress');
  await store.resetServedInProgressGaps([gap.gap_id]);
  await store.markGapStatus(gap.gap_id, 'in_progress');
  let outcome = await maybeQuarantineGap(store, gap.gap_id, { failure_class: 'transient_no_progress' }, policy);
  assert.equal(outcome.quarantined, false, 'below budget: not quarantined');
  await store.resetServedInProgressGaps([gap.gap_id]);
  assert.equal(
    (await store.listPendingGaps({ connectorId: 'amazon', connectorInstanceId: CONNECTOR_INSTANCE_ID, grantId: 'grant_test' })).length,
    1,
    'still fillable while under budget',
  );

  await store.markGapStatus(gap.gap_id, 'in_progress');
  outcome = await maybeQuarantineGap(store, gap.gap_id, { failure_class: 'transient_no_progress' }, policy);
  assert.equal(outcome.quarantined, true, 'budget crossed: quarantined');

  const quarantined = outcome.gap;
  assert.equal(quarantined.status, 'terminal', 'quarantine uses the durable terminal status');
  assert.equal(quarantined.reason, QUARANTINE_CLASS, 'durable class the classifier reads is `quarantined`');
  assert.equal(quarantined.last_error.class, 'quarantined', 'evidence trail carries the quarantine class');
  assert.equal(quarantined.last_error.attempt_count, 3, 'evidence records the crossing attempt count');
  assert.equal(quarantined.last_error.failure_class, 'transient_no_progress', 'evidence preserves the connector signal');

  assert.equal(await store.countGapsByStatusForConnector('amazon', { status: 'terminal' }), 1, 'quarantined item is counted');
  assert.equal(
    (await store.listPendingGaps({ connectorId: 'amazon', connectorInstanceId: CONNECTOR_INSTANCE_ID, grantId: 'grant_test' })).length,
    0,
    'not in fillable-pending',
  );
}));

test('maybeQuarantineGap: a poison item does not block its siblings - siblings keep draining', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const poison = await seedGap(store, 'order_poison');
  await seedGap(store, 'order_healthy_a');
  await seedGap(store, 'order_healthy_b');
  const policy = { maxNoProgressAttempts: 2 };

  await store.markGapStatus(poison.gap_id, 'in_progress');
  await store.markGapStatus(poison.gap_id, 'in_progress');
  const outcome = await maybeQuarantineGap(store, poison.gap_id, { failure_class: 'parse_missing' }, policy);
  assert.equal(outcome.quarantined, true);

  const pending = await store.listPendingGaps({ connectorId: 'amazon', connectorInstanceId: CONNECTOR_INSTANCE_ID, grantId: 'grant_test' });
  const keys = pending.map((g) => g.record_key).sort();
  assert.deepEqual(keys, ['order_healthy_a', 'order_healthy_b'], 'siblings keep draining; poison item quarantined out');

  await store.markGapStatus(pending[0].gap_id, 'recovered', { runId: 'run_ok' });
  assert.equal(await store.countGapsByStatusForConnector('amazon', { status: 'recovered' }), 1);
  assert.equal(await store.countGapsByStatusForConnector('amazon', { status: 'terminal' }), 1);
}));

test('maybeQuarantineGap: quarantine is sticky - re-upsert does not revive a quarantined item', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const gap = await seedGap(store, 'order_sticky');
  const policy = { maxNoProgressAttempts: 1 };

  await store.markGapStatus(gap.gap_id, 'in_progress');
  await maybeQuarantineGap(store, gap.gap_id, null, policy);
  assert.equal(await store.countGapsByStatusForConnector('amazon', { status: 'terminal' }), 1);

  await seedGap(store, 'order_sticky');
  assert.equal(
    (await store.listPendingGaps({ connectorId: 'amazon', connectorInstanceId: CONNECTOR_INSTANCE_ID, grantId: 'grant_test' })).length,
    0,
    'quarantined item not revived',
  );
  assert.equal(await store.countGapsByStatusForConnector('amazon', { status: 'terminal' }), 1);

  const again = await maybeQuarantineGap(store, gap.gap_id, null, policy);
  assert.equal(again.quarantined, false, 'terminal is sticky; no double-quarantine');
}));

test('interrupted attempts count: markGapStatus(in_progress) increments before the connector acts, and crash-reclaim does not decrement', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const gap = await seedGap(store, 'order_crash');

  for (let i = 0; i < 3; i++) {
    await store.markGapStatus(gap.gap_id, 'in_progress');
    await store.reclaimStrandedInProgressGaps({
      connectorId: 'amazon',
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      grantId: 'grant_test',
      currentRunId: `later_run_${i}`,
    });
  }

  const after = await store.getGapById(gap.gap_id);
  assert.equal(after.status, 'pending', 'reclaimed back to pending for the next attempt');
  assert.equal(after.attempt_count, 3, 'each interrupted attempt counted; reclaim did NOT decrement');
}));

test('repeated interruption escalates to quarantine exactly like repeated deterministic failure', withTempDb(async () => {
  const store = createSqliteConnectorDetailGapStore();
  const gap = await seedGap(store, 'order_crashloop');
  const policy = { maxNoProgressAttempts: 3 };

  for (let i = 0; i < policy.maxNoProgressAttempts; i++) {
    await store.markGapStatus(gap.gap_id, 'in_progress');
    await store.resetServedInProgressGaps([gap.gap_id]);
  }

  const outcome = await maybeQuarantineGap(store, gap.gap_id, { failure_class: 'interrupted' }, policy);
  assert.equal(outcome.quarantined, true, 'a crash loop converges to a connector/system issue, not infinite retry');
  assert.equal(outcome.gap.reason, QUARANTINE_CLASS);
}));

test('record emission is idempotent on durable identity: re-emitting the same key does not create a duplicate row', withTempDb(async () => {
  const { getDb } = await import('../server/db.js');
  const { ingestRecord } = await import('../server/records.js');
  const connectorId = 'https://test.pdpp.org/connectors/amazon';
  const stream = 'order_items';
  const record = {
    stream,
    key: 'order_dup',
    data: { id: 'order_dup', total: '10.00' },
    emitted_at: '2026-07-06T00:00:00.000Z',
    op: 'upsert',
  };

  const first = await ingestRecord(connectorId, record);
  assert.equal(first.changed, true, 'first emit writes the record');

  const second = await ingestRecord(connectorId, record);
  assert.equal(second.changed, false, 'byte-identical re-emit is a no-op, not a second row');

  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM records WHERE connector_id = ? AND stream = ? AND record_key = ?')
    .get(connectorId, stream, 'order_dup');
  assert.equal(row.n, 1, 're-attempt must not produce a duplicate record visible to reads');
}));
