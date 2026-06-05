/**
 * Unit tests for the pure server-side version_disposition classifier.
 *
 * These exercise the five-way derivation directly (no DB), pinning the
 * acceptance criteria from the OpenSpec change
 * `add-version-disposition-for-retained-history`:
 *
 *   AC-3 unclassified high/watch → active_defect_or_unclassified
 *   AC-4 reviewed residue re-alarms after review timestamp
 *   AC-5 sessions → recurring_point_in_time_snapshot (no re-alarm on growth)
 *   AC-6 split residual entity stream → point_in_time_retained_history
 *   AC-7 disposition reads only reference signals (no connector-authored value)
 *
 * The disposition is independent of the numeric risk classification — these
 * tests never pass a risk level and the classifier never consults one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyVersionDisposition,
  normalizeConnectorId,
  POINT_IN_TIME_REAL_FIELD_STREAMS,
  RECURRING_POINT_IN_TIME_SNAPSHOT_STREAMS,
  REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT,
  VERSION_DISPOSITIONS,
} from '../server/version-disposition.js';

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
