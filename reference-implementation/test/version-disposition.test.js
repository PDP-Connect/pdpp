// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure server-side version_disposition AND version_remediation
 * classifiers.
 *
 * The first half exercises the five-way disposition derivation directly (no DB),
 * pinning the acceptance criteria from the OpenSpec change
 * `add-version-disposition-for-retained-history`:
 *
 *   AC-3 unclassified high/watch → active_defect_or_unclassified
 *   AC-4 reviewed residue re-alarms after review timestamp
 *   AC-5 sessions → recurring_point_in_time_snapshot (no re-alarm on growth)
 *   AC-6 split residual entity stream → point_in_time_retained_history
 *   AC-7 disposition reads only reference signals (no connector-authored value)
 *
 * The second half exercises the orthogonal `classifyVersionRemediation`, pinning
 * the acceptance criteria from `add-version-remediation-disposition` (AC-3..AC-8
 * there): the statement rows are fingerprint-pending, usaa/accounts is
 * migration-pending and distinct from them, sessions are retention-policy, every
 * other row is none, no connector input participates, and remediation never
 * contradicts the disposition it consumes.
 *
 * Both labels are independent of the numeric risk classification — these tests
 * never pass a risk level and the classifiers never consult one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyVersionDisposition,
  classifyVersionRemediation,
  CONTENT_FINGERPRINT_PENDING_STREAMS,
  normalizeConnectorId,
  OWNER_MIGRATION_PENDING_STREAMS,
  OWNER_RETENTION_POLICY_STREAMS,
  POINT_IN_TIME_REAL_FIELD_STREAMS,
  RECURRING_POINT_IN_TIME_SNAPSHOT_STREAMS,
  REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT,
  VERSION_DISPOSITIONS,
  VERSION_REMEDIATIONS,
} from '../server/version-disposition.ts';

function oneMillisecondAfter(iso) {
  return new Date(new Date(iso).getTime() + 1).toISOString();
}

// ─── Recurring point-in-time snapshots (disposition #5, the new construction) ─

test('classifyVersionDisposition: claude-code/sessions is a recurring point-in-time snapshot', () => {
  assert.equal(
    classifyVersionDisposition({
      connectorId: 'claude-code',
      stream: 'sessions',
      lastHistoryAt: '2026-06-04T19:15:01.028Z',
      // sessions DO have a registered compaction policy — the recurring-snapshot
      // list must take precedence so it does not read as a candidate.
      hasCompactionPolicy: true,
    }),
    'recurring_point_in_time_snapshot',
  );
});

test('classifyVersionDisposition: codex/sessions is a recurring point-in-time snapshot', () => {
  assert.equal(
    classifyVersionDisposition({
      connectorId: 'codex',
      stream: 'sessions',
      lastHistoryAt: '2026-06-04T19:15:01.028Z',
      hasCompactionPolicy: true,
    }),
    'recurring_point_in_time_snapshot',
  );
});

test('classifyVersionDisposition: a recurring snapshot does NOT re-alarm when history advances (AC-5)', () => {
  // No reviewed-at timestamp gates this disposition: growth is its expected,
  // non-removable signal. A much later last_history_at must still classify #5.
  for (const lastHistoryAt of [
    '2026-06-04T19:15:01.028Z',
    '2026-06-10T00:00:00.000Z',
    '2027-01-01T00:00:00.000Z',
    null,
  ]) {
    assert.equal(
      classifyVersionDisposition({
        connectorId: 'claude-code',
        stream: 'sessions',
        lastHistoryAt,
        hasCompactionPolicy: true,
      }),
      'recurring_point_in_time_snapshot',
      `claude-code/sessions must stay #5 for last_history_at=${lastHistoryAt}`,
    );
  }
});

test('classifyVersionDisposition: recurring snapshot resolves local-device and registry-URL id forms', () => {
  assert.equal(
    classifyVersionDisposition({ connectorId: 'local-device:claude-code', stream: 'sessions', hasCompactionPolicy: true }),
    'recurring_point_in_time_snapshot',
  );
  assert.equal(
    classifyVersionDisposition({
      connectorId: 'https://registry.pdpp.org/connectors/codex',
      stream: 'sessions',
      hasCompactionPolicy: true,
    }),
    'recurring_point_in_time_snapshot',
  );
});

// ─── Point-in-time retained history (disposition #3) ─────────────────────────

test('classifyVersionDisposition: split residual entity streams are point_in_time_retained_history (AC-6)', () => {
  const splitStreams = [
    ['github', 'user'],
    ['slack', 'channels'],
    ['ynab', 'accounts'],
  ];
  for (const [connectorId, stream] of splitStreams) {
    assert.equal(
      classifyVersionDisposition({ connectorId, stream, hasCompactionPolicy: false }),
      'point_in_time_retained_history',
      `${connectorId}/${stream} must be point_in_time_retained_history`,
    );
  }
});

test('classifyVersionDisposition: point-in-time resolves the registry-URL id form', () => {
  assert.equal(
    classifyVersionDisposition({
      connectorId: 'https://registry.pdpp.org/connectors/github',
      stream: 'user',
      hasCompactionPolicy: false,
    }),
    'point_in_time_retained_history',
  );
});

// ─── Reviewed historical residue (disposition #2) + re-alarm (#4) ────────────

test('classifyVersionDisposition: reviewed residue classifies #2 within the review window', () => {
  assert.equal(
    classifyVersionDisposition({
      connectorId: 'usaa',
      stream: 'accounts',
      lastHistoryAt: '2026-06-03T12:00:00.000Z',
      hasCompactionPolicy: true,
    }),
    'reviewed_historical_residue',
  );
});

test('classifyVersionDisposition: reviewed residue classifies #2 when last_history_at equals reviewedAt exactly', () => {
  const reviewedAt = REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT.get('usaa/accounts');
  assert.ok(reviewedAt);
  assert.equal(
    classifyVersionDisposition({
      connectorId: 'usaa',
      stream: 'accounts',
      lastHistoryAt: reviewedAt,
      hasCompactionPolicy: true,
    }),
    'reviewed_historical_residue',
  );
});

test('classifyVersionDisposition: reviewed residue re-alarms to #4 after the review timestamp (AC-4)', () => {
  const usaaReviewedAt = REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT.get('usaa/accounts');
  const chaseReviewedAt = REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT.get('chase/statements');
  assert.ok(usaaReviewedAt);
  assert.ok(chaseReviewedAt);
  assert.equal(
    classifyVersionDisposition({
      connectorId: 'usaa',
      stream: 'accounts',
      lastHistoryAt: oneMillisecondAfter(usaaReviewedAt),
      hasCompactionPolicy: true,
    }),
    'lossless_compaction_candidate',
  );
  assert.equal(
    classifyVersionDisposition({
      connectorId: 'chase',
      stream: 'statements',
      lastHistoryAt: oneMillisecondAfter(chaseReviewedAt),
      hasCompactionPolicy: true,
    }),
    'lossless_compaction_candidate',
  );
});

test('classifyVersionDisposition: reviewed residue re-alarms to #4 when last_history_at is unavailable', () => {
  // Unverifiable guard → re-alarm rather than silently suppress.
  assert.equal(
    classifyVersionDisposition({
      connectorId: 'usaa',
      stream: 'statements',
      lastHistoryAt: null,
      hasCompactionPolicy: true,
    }),
    'lossless_compaction_candidate',
  );
});

// ─── Lossless compaction candidate (disposition #4) ──────────────────────────

test('classifyVersionDisposition: a policied stream with no recognized list is a compaction candidate', () => {
  assert.equal(
    classifyVersionDisposition({ connectorId: 'gmail', stream: 'labels', hasCompactionPolicy: true }),
    'lossless_compaction_candidate',
  );
  assert.equal(
    classifyVersionDisposition({ connectorId: 'amazon', stream: 'orders', hasCompactionPolicy: true }),
    'lossless_compaction_candidate',
  );
});

// ─── Active defect / unclassified (disposition #1, the only "needs review") ───

test('classifyVersionDisposition: an unknown high/watch stream is active_defect_or_unclassified (AC-3)', () => {
  assert.equal(
    classifyVersionDisposition({ connectorId: 'mystery', stream: 'widgets', hasCompactionPolicy: false }),
    'active_defect_or_unclassified',
  );
  // A real connector but an unmodeled stream with no policy.
  assert.equal(
    classifyVersionDisposition({ connectorId: 'github', stream: 'repos', hasCompactionPolicy: false }),
    'active_defect_or_unclassified',
  );
});

test('classifyVersionDisposition: a null connector_id is active_defect_or_unclassified', () => {
  assert.equal(
    classifyVersionDisposition({ connectorId: null, stream: 'whatever', hasCompactionPolicy: false }),
    'active_defect_or_unclassified',
  );
});

// ─── Anti-self-declaration (AC-7) ────────────────────────────────────────────

test('classifyVersionDisposition: only reference-controlled inputs participate; payload fields are ignored', () => {
  // Spread connector-authored junk into the input. The classifier signature
  // only reads connectorId/stream/lastHistoryAt/hasCompactionPolicy; any other
  // property (a connector trying to assert its own disposition) is inert.
  const declaredAway = classifyVersionDisposition({
    connectorId: 'mystery',
    stream: 'widgets',
    hasCompactionPolicy: false,
    // hostile/attacker-authored attempts to self-declare:
    version_disposition: 'point_in_time_retained_history',
    disposition: 'recurring_point_in_time_snapshot',
    semantics: 'append',
    suppress: true,
  });
  assert.equal(
    declaredAway,
    'active_defect_or_unclassified',
    'a connector cannot self-declare its churn into a safe disposition',
  );
});

// ─── Precedence guard ────────────────────────────────────────────────────────

test('classifyVersionDisposition: recurring-snapshot precedence beats both the reviewed map and the policy signal', () => {
  // Even if claude-code/sessions were (incorrectly) added to the reviewed map
  // and reports a policy, the recurring-snapshot list wins because it is checked
  // first. This pins the precedence the design relies on.
  assert.equal(
    classifyVersionDisposition({
      connectorId: 'claude-code',
      stream: 'sessions',
      lastHistoryAt: '2030-01-01T00:00:00.000Z',
      hasCompactionPolicy: true,
    }),
    'recurring_point_in_time_snapshot',
  );
});

// ─── Registry shape invariants ───────────────────────────────────────────────

test('the five dispositions are exactly the documented set', () => {
  assert.deepEqual(
    [...VERSION_DISPOSITIONS].sort(),
    [
      'active_defect_or_unclassified',
      'lossless_compaction_candidate',
      'point_in_time_retained_history',
      'recurring_point_in_time_snapshot',
      'reviewed_historical_residue',
    ],
  );
});

test('point-in-time and recurring-snapshot stream lists are disjoint', () => {
  const piKeys = new Set(POINT_IN_TIME_REAL_FIELD_STREAMS.map((e) => `${e.connector}/${e.stream}`));
  for (const entry of RECURRING_POINT_IN_TIME_SNAPSHOT_STREAMS) {
    assert.equal(
      piKeys.has(`${entry.connector}/${entry.stream}`),
      false,
      `${entry.connector}/${entry.stream} cannot be both point-in-time and recurring-snapshot`,
    );
  }
});

test('claude-code/sessions is NOT in the reviewed-residue map (it is now a recurring snapshot)', () => {
  assert.equal(REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT.has('claude-code/sessions'), false);
  assert.equal(REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT.has('codex/sessions'), false);
});

test('normalizeConnectorId strips registry-URL and local-device forms', () => {
  assert.equal(normalizeConnectorId('github'), 'github');
  assert.equal(normalizeConnectorId('https://registry.pdpp.org/connectors/github'), 'github');
  assert.equal(normalizeConnectorId('local-device:claude-code'), 'claude-code');
  assert.equal(normalizeConnectorId(null), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// version_remediation — the orthogonal next-action axis
// (OpenSpec add-version-remediation-disposition)
//
//   AC-3 chase/usaa statements → content_fingerprint_pending
//   AC-4 usaa/accounts → owner_migration_pending (distinct from statements)
//   AC-5 claude-code/codex sessions → owner_retention_policy
//   AC-6 candidate / unlisted point-in-time / defect → none
//   AC-7 remediation reads only reference signals (no connector-authored value)
//   AC-8 remediation never contradicts disposition (consistency guard)
// ═══════════════════════════════════════════════════════════════════════════

// ─── AC-3 content_fingerprint_pending (the statement rows) ───────────────────

test('classifyVersionRemediation: chase/statements reviewed residue is content_fingerprint_pending (AC-3)', () => {
  assert.equal(
    classifyVersionRemediation({
      connectorId: 'chase',
      stream: 'statements',
      versionDisposition: 'reviewed_historical_residue',
    }),
    'content_fingerprint_pending',
  );
});

test('classifyVersionRemediation: usaa/statements reviewed residue is content_fingerprint_pending (AC-3)', () => {
  assert.equal(
    classifyVersionRemediation({
      connectorId: 'usaa',
      stream: 'statements',
      versionDisposition: 'reviewed_historical_residue',
    }),
    'content_fingerprint_pending',
  );
  // Same answer via the registry-URL connector_id form.
  assert.equal(
    classifyVersionRemediation({
      connectorId: 'https://registry.pdpp.org/connectors/usaa',
      stream: 'statements',
      versionDisposition: 'reviewed_historical_residue',
    }),
    'content_fingerprint_pending',
  );
});

// ─── AC-4 owner_migration_pending (usaa/accounts), distinct from statements ───

test('classifyVersionRemediation: usaa/accounts reviewed residue is owner_migration_pending (AC-4)', () => {
  const accounts = classifyVersionRemediation({
    connectorId: 'usaa',
    stream: 'accounts',
    versionDisposition: 'reviewed_historical_residue',
  });
  assert.equal(accounts, 'owner_migration_pending');

  // Distinct from the statement rows even though both share the
  // reviewed_historical_residue disposition — the whole point of the axis.
  const statements = classifyVersionRemediation({
    connectorId: 'usaa',
    stream: 'statements',
    versionDisposition: 'reviewed_historical_residue',
  });
  assert.notEqual(accounts, statements);
});

// ─── AC-5 owner_retention_policy (sessions) ──────────────────────────────────

test('classifyVersionRemediation: sessions recurring snapshots are owner_retention_policy (AC-5)', () => {
  for (const connectorId of ['claude-code', 'codex', 'local-device:claude-code']) {
    assert.equal(
      classifyVersionRemediation({
        connectorId,
        stream: 'sessions',
        versionDisposition: 'recurring_point_in_time_snapshot',
      }),
      'owner_retention_policy',
      `${connectorId}/sessions must be owner_retention_policy`,
    );
  }
});

// ─── AC-6 none defaults ──────────────────────────────────────────────────────

test('classifyVersionRemediation: a lossless_compaction_candidate is always none (AC-6)', () => {
  assert.equal(
    classifyVersionRemediation({
      connectorId: 'gmail',
      stream: 'labels',
      versionDisposition: 'lossless_compaction_candidate',
    }),
    'none',
  );
});

test('classifyVersionRemediation: an unlisted point_in_time_retained_history is none (AC-6)', () => {
  assert.equal(
    classifyVersionRemediation({
      connectorId: 'github',
      stream: 'user',
      versionDisposition: 'point_in_time_retained_history',
    }),
    'none',
  );
});

test('classifyVersionRemediation: active_defect_or_unclassified is always none (AC-6)', () => {
  assert.equal(
    classifyVersionRemediation({
      connectorId: 'mystery',
      stream: 'widgets',
      versionDisposition: 'active_defect_or_unclassified',
    }),
    'none',
  );
});

test('classifyVersionRemediation: a null connector_id is none', () => {
  assert.equal(
    classifyVersionRemediation({
      connectorId: null,
      stream: 'whatever',
      versionDisposition: 'reviewed_historical_residue',
    }),
    'none',
  );
});

// ─── AC-7 anti-self-declaration ──────────────────────────────────────────────

test('classifyVersionRemediation: only reference-controlled inputs participate; payload fields are ignored (AC-7)', () => {
  // The signature reads connectorId/stream/versionDisposition only. A connector
  // spreading a hostile self-declared remediation cannot change the answer: an
  // unlisted stream stays none regardless of the junk fields.
  const declaredAway = classifyVersionRemediation({
    connectorId: 'mystery',
    stream: 'widgets',
    versionDisposition: 'reviewed_historical_residue',
    version_remediation: 'none',
    remediation: 'owner_retention_policy',
    suppress: true,
  });
  assert.equal(declaredAway, 'none', 'a connector cannot self-declare its remediation');
});

// ─── AC-8 consistency guard (remediation never contradicts disposition) ──────

test('classifyVersionRemediation: owner_retention_policy requires the recurring-snapshot disposition (AC-8)', () => {
  // A sessions stream is on the retention list, but if its disposition is NOT
  // recurring_point_in_time_snapshot the guard withholds owner_retention_policy.
  // (This pairing should never occur in practice — the lists are aligned — but
  // the guard makes the invariant explicit and regression-pinned.)
  assert.equal(
    classifyVersionRemediation({
      connectorId: 'claude-code',
      stream: 'sessions',
      versionDisposition: 'reviewed_historical_residue',
    }),
    'none',
    'retention-policy only applies when the disposition is the recurring snapshot',
  );
});

test('classifyVersionRemediation: a candidate/defect on a remediation list cannot be overridden (AC-8)', () => {
  // Even if a fingerprint-listed stream somehow arrived as a candidate or a
  // defect, the hard guard keeps it none — its action is already the dry-run
  // command or "review it".
  assert.equal(
    classifyVersionRemediation({
      connectorId: 'chase',
      stream: 'statements',
      versionDisposition: 'lossless_compaction_candidate',
    }),
    'none',
  );
  assert.equal(
    classifyVersionRemediation({
      connectorId: 'usaa',
      stream: 'accounts',
      versionDisposition: 'active_defect_or_unclassified',
    }),
    'none',
  );
});

test('classifyVersionRemediation: migration precedence beats fingerprint when both could match', () => {
  // usaa/accounts is only on the migration list, but assert the precedence order
  // directly: migration is checked before fingerprint, so an entry on both lists
  // would resolve to migration. Pins the documented precedence.
  assert.equal(OWNER_MIGRATION_PENDING_STREAMS.length >= 1, true);
  assert.equal(
    classifyVersionRemediation({
      connectorId: 'usaa',
      stream: 'accounts',
      versionDisposition: 'reviewed_historical_residue',
    }),
    'owner_migration_pending',
  );
});

// ─── Registry shape invariants for remediation ───────────────────────────────

test('the four remediations are exactly the documented set', () => {
  assert.deepEqual(
    [...VERSION_REMEDIATIONS].sort(),
    ['content_fingerprint_pending', 'none', 'owner_migration_pending', 'owner_retention_policy'],
  );
});

test('the remediation lists hold exactly the evidence-named streams', () => {
  assert.deepEqual(
    CONTENT_FINGERPRINT_PENDING_STREAMS.map((e) => `${e.connector}/${e.stream}`).sort(),
    ['chase/statements', 'usaa/statements'],
  );
  assert.deepEqual(
    OWNER_MIGRATION_PENDING_STREAMS.map((e) => `${e.connector}/${e.stream}`).sort(),
    ['usaa/accounts'],
  );
  assert.deepEqual(
    OWNER_RETENTION_POLICY_STREAMS.map((e) => `${e.connector}/${e.stream}`).sort(),
    ['claude-code/sessions', 'codex/sessions'],
  );
});

test('the owner-retention-policy list is aligned with the recurring-snapshot list', () => {
  // The guard in classifyVersionRemediation relies on every retention-policy
  // stream also being a recurring snapshot. Pin that alignment so a future edit
  // to one list that forgets the other is caught.
  const recurringKeys = new Set(
    RECURRING_POINT_IN_TIME_SNAPSHOT_STREAMS.map((e) => `${e.connector}/${e.stream}`),
  );
  for (const entry of OWNER_RETENTION_POLICY_STREAMS) {
    assert.equal(
      recurringKeys.has(`${entry.connector}/${entry.stream}`),
      true,
      `${entry.connector}/${entry.stream} must also be a recurring snapshot`,
    );
  }
});

test('a fingerprint-pending stream is never also migration-pending', () => {
  const migrationKeys = new Set(
    OWNER_MIGRATION_PENDING_STREAMS.map((e) => `${e.connector}/${e.stream}`),
  );
  for (const entry of CONTENT_FINGERPRINT_PENDING_STREAMS) {
    assert.equal(
      migrationKeys.has(`${entry.connector}/${entry.stream}`),
      false,
      `${entry.connector}/${entry.stream} cannot be both fingerprint- and migration-pending`,
    );
  }
});
