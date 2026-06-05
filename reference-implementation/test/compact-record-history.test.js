/**
 * Tests for the compact-record-history operational tool.
 *
 * Two layers:
 *   1. Pure-helper tests (no DB): fingerprint stability, retention
 *      selector across the rule matrix, parseLimitKeys, registry shape.
 *   2. Postgres-backed integration tests (gated on PDPP_TEST_POSTGRES_URL):
 *      seeded fixture per acceptance scenario from design.md.
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  COMPACTION_POLICIES,
  applyCompaction,
  findPolicy,
  markScopeDirty,
  parseLimitKeys,
  planCompaction,
  recordFingerprint,
  selectRemovableVersions,
} from '../scripts/compact-record-history.mjs';
import {
  POINT_IN_TIME_REAL_FIELD_STREAMS as SERVER_POINT_IN_TIME_STREAMS,
  RECURRING_POINT_IN_TIME_SNAPSHOT_STREAMS as SERVER_RECURRING_SNAPSHOT_STREAMS,
} from '../server/version-disposition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'compact-record-history.mjs');

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// ─── Pure-helper tests ──────────────────────────────────────────────────

test('recordFingerprint is stable across key order', () => {
  const a = { a: 1, b: 2, c: [3, 4] };
  const b = { c: [3, 4], b: 2, a: 1 };
  assert.equal(recordFingerprint(a), recordFingerprint(b));
});

test('recordFingerprint drops excluded keys before hashing', () => {
  const a = { id: 'x', fetched_at: '2026-05-26T00:00:00Z', name: 'n' };
  const b = { id: 'x', fetched_at: '2026-05-26T00:00:01Z', name: 'n' };
  assert.notEqual(recordFingerprint(a), recordFingerprint(b));
  assert.equal(
    recordFingerprint(a, ['fetched_at']),
    recordFingerprint(b, ['fetched_at']),
  );
});

test('recordFingerprint changes when a non-excluded field changes', () => {
  const a = { id: 'x', name: 'A' };
  const b = { id: 'x', name: 'B' };
  assert.notEqual(recordFingerprint(a), recordFingerprint(b));
});

test('COMPACTION_POLICIES exposes the registered policies (short-name canonical form)', () => {
  const expected = [
    // connector-fingerprint family
    ['gmail', 'threads'],
    ['slack', 'workspace'],
    ['slack', 'users'],
    ['slack', 'files'],
    ['slack', 'channel_memberships'],
    ['ynab', 'payee_locations'],
    // run-clock / stored-body mirror family (forward gate added 2026-06-01)
    ['gmail', 'labels'],
    ['usaa', 'statements'],
    ['chase', 'accounts'],
    // chase/statements + chase/transactions carry only the run-clock
    // `fetched_at` over content-addressed / immutable bodies; only
    // `fetched_at` is excluded (forward gate added 2026-06-03)
    ['chase', 'statements'],
    ['chase', 'transactions'],
    // usaa/accounts + usaa/credit_card_billing post-split carry identity +
    // settings + run-clock `fetched_at` only (balances/per-cycle metrics moved
    // to the `_stats` observation streams, split-usaa-account-balance-
    // observation-streams); only `fetched_at` is excluded. (gate added
    // 2026-06-02; bodies narrowed by the balance split)
    ['usaa', 'accounts'],
    ['usaa', 'credit_card_billing'],
    ['ynab', 'budgets'],
    // usaa/transactions (CSV + PDF paths) + usaa/inbox_messages +
    // chase/current_activity carry only the run-clock `fetched_at` over
    // immutable bodies; only `fetched_at` is excluded (forward gate added
    // 2026-06-03). transactions/current_activity are partial scans (never
    // pruned); inbox_messages is a full-page scan (pruned).
    ['usaa', 'transactions'],
    ['usaa', 'inbox_messages'],
    ['chase', 'current_activity'],
    // amazon/orders carries only the run-clock `fetched_at` over an
    // immutable id/total; only `fetched_at` is excluded. Year-freezing
    // already bounds the churn window; this is a partial scan (never
    // pruned). order_items has no fetched_at and no policy. (2026-06-03)
    ['amazon', 'orders'],
    // chatgpt custom_instructions / shared_conversations re-emit a stable-id
    // body with NO run-clock field every run; the connector now gates emit
    // through a whole-body fingerprint cursor (excludeFromFingerprint []) and
    // this mirrors it with excludeKeys []. A no-op refresh collapses; a real
    // edit / new share is a boundary that survives. (2026-06-03)
    ['chatgpt', 'custom_instructions'],
    ['chatgpt', 'shared_conversations'],
    // exact stable-JSON identity family (codex)
    ['codex', 'messages'],
    ['codex', 'function_calls'],
    ['codex', 'sessions'],
    ['codex', 'skills'],
    ['codex', 'prompts'],
    ['codex', 'rules'],
    // exact stable-JSON identity family (claude-code)
    ['claude-code', 'messages'],
    ['claude-code', 'attachments'],
    ['claude-code', 'sessions'],
    ['claude-code', 'skills'],
    ['claude-code', 'memory_notes'],
    ['claude-code', 'slash_commands'],
    // inventory churn-gate family — inventory_only/defer metadata records
    // whose volatile mtime_epoch/size_bytes are excluded so an unchanged
    // store does not re-version on a file-stat tick. The inventory meaning
    // (path/type/classification/reason) stays a fingerprint boundary.
    // (forward gate added 2026-06-03)
    ['claude-code', 'backup_inventory'],
    ['claude-code', 'cache_inventory'],
    ['claude-code', 'config_inventory'],
    ['claude-code', 'file_history'],
    ['codex', 'history'],
    ['codex', 'session_index'],
    ['codex', 'shell_snapshots'],
    ['codex', 'config_inventory'],
    ['codex', 'cache_inventory'],
    ['codex', 'logs'],
  ];
  const actual = COMPACTION_POLICIES.map((p) => [p.connectorIds[0], p.stream]);
  assert.deepEqual(actual, expected);
});

test('findPolicy returns null for unknown streams', () => {
  assert.equal(findPolicy('slack', 'messages'), null);
  assert.equal(findPolicy('gmail', 'messages'), null);
  assert.equal(findPolicy('codex', 'unknown_stream'), null);
  assert.equal(findPolicy('claude-code', 'unknown_stream'), null);
  assert.equal(findPolicy('chatgpt', 'messages'), null);
});

test('findPolicy resolves codex and claude-code via short name or `local-device:` prefix', () => {
  for (const [short, prefixed] of [
    ['codex', 'local-device:codex'],
    ['claude-code', 'local-device:claude-code'],
  ]) {
    const streams = short === 'codex'
      ? ['messages', 'function_calls', 'sessions', 'skills', 'prompts', 'rules']
      : ['messages', 'attachments', 'sessions', 'skills', 'memory_notes', 'slash_commands'];
    for (const stream of streams) {
      const a = findPolicy(short, stream);
      const b = findPolicy(prefixed, stream);
      assert.ok(a, `findPolicy(${short}, ${stream}) returned null`);
      assert.ok(b, `findPolicy(${prefixed}, ${stream}) returned null`);
      assert.equal(a, b, `${short} and ${prefixed} must resolve to the same policy entry`);
      assert.deepEqual(a.excludeKeys, [], `${short}/${stream} must use exact stable-JSON identity (excludeKeys=[])`);
    }
  }
});

test('findPolicy matches both short name and registry URL form for connector_id', () => {
  const a = findPolicy('slack', 'workspace');
  const b = findPolicy('https://registry.pdpp.org/connectors/slack', 'workspace');
  assert.ok(a);
  assert.ok(b);
  assert.equal(a, b, 'short-name and URL lookups must resolve to the same policy entry');
});

test('findPolicy returns the registered policy for Slack workspace with excludeKeys=[fetched_at]', () => {
  const p = findPolicy('slack', 'workspace');
  assert.ok(p);
  assert.deepEqual(p.excludeKeys, ['fetched_at']);
});

test('findPolicy returns the registered policy for Slack channel_memberships with excludeKeys=[fetched_at]', () => {
  // Mirrors the connector-side gate (FINGERPRINT_EXCLUDE.channel_memberships
  // in connectors/slack/index.ts, proven by connectors/slack/fingerprint.test.ts).
  // Excluding only the run-clock `fetched_at` leaves the membership identity
  // (id, channel_id, user_id) inside the fingerprint, so a membership
  // appearing or disappearing always remains a version boundary.
  const short = findPolicy('slack', 'channel_memberships');
  const url = findPolicy('https://registry.pdpp.org/connectors/slack', 'channel_memberships');
  assert.ok(short, 'slack/channel_memberships policy must be registered');
  assert.deepEqual(short.excludeKeys, ['fetched_at']);
  assert.equal(short, url, 'short-name and URL lookups must resolve to the same policy entry');
});

// ─── Point-in-time real-field guardrail ─────────────────────────────────
//
// These streams version on a GENUINELY changing real field carried on the
// same record as a stable identity — not on a run clock. The accepted
// direction (design-notes/real-field-version-churn-point-in-time-streams-
// 2026-06-02.md) is to split the volatile observation into its own
// append-keyed point-in-time stream, NOT to register a compaction policy
// or a fingerprint exclusion that would collapse real history. Registering
// any policy for these (connector, stream) pairs would let
// `compact-record-history.mjs --apply` silently delete real
// point-in-time data. This test fails loudly the moment such a policy is
// added so the closeout's "needs design, not exclusion" boundary cannot be
// erased by accident.
//
// Both connector-id forms (short + registry URL) are checked because
// findPolicy resolves either.
const POINT_IN_TIME_REAL_FIELD_STREAMS = [
  { connector: 'github', stream: 'user', realField: 'follower/repo/gist counts' },
  { connector: 'slack', stream: 'channels', realField: 'num_members' },
  // ynab/accounts is the same class: the connector already split its balances
  // into the append-keyed `account_stats` observation stream
  // (split-ynab-account-balance-observation-stream), so the current entity
  // record no longer carries balance/cleared_balance/uncleared_balance. The
  // retained `accounts` history churns ONLY on those now-removed balance
  // fields (verified field-diff on the live proof DB: balance, cleared_balance,
  // uncleared_balance are the sole adjacent-version differences) — genuine
  // point-in-time observations that are the only surviving copy (the split
  // streams backfilled nothing). A compaction policy would delete real history.
  { connector: 'ynab', stream: 'accounts', realField: 'balance/cleared_balance/uncleared_balance' },
];

for (const { connector, stream, realField } of POINT_IN_TIME_REAL_FIELD_STREAMS) {
  test(`no compaction policy is registered for the point-in-time real-field stream ${connector}/${stream}`, () => {
    const short = findPolicy(connector, stream);
    const url = findPolicy(`https://registry.pdpp.org/connectors/${connector}`, stream);
    assert.equal(
      short,
      null,
      `${connector}/${stream} churns on a real field (${realField}); it must NOT have a compaction policy — split it into an append-keyed point-in-time stream instead (see design-notes/real-field-version-churn-point-in-time-streams-2026-06-02.md)`,
    );
    assert.equal(
      url,
      null,
      `${connector}/${stream} (registry-URL form) must also have no compaction policy`,
    );
  });
}

// USAA `accounts` and `credit_card_billing` are the subtle case. Post-split
// (split-usaa-account-balance-observation-streams) their volatile balance /
// per-cycle metrics moved to the `_stats` observation streams, so the entity
// bodies now carry a run-clock `fetched_at` plus: for `accounts`, identity
// only (id/type/name/last_four/status); for `credit_card_billing`, identity
// plus real SETTINGS state (credit_limit_cents, APRs, nickname, card_holders)
// whose changes are legitimate low-rate versions. Either way the policy must
// exclude ONLY `fetched_at`: excluding any retained body field would suppress
// real churn (a settings change on the card, an identity change on the
// account). This pins the cut line so a future edit can't widen excludeKeys
// past the run clock.
for (const stream of ['accounts', 'credit_card_billing']) {
  test(`usaa/${stream} compaction policy excludes the run clock only, never a real field`, () => {
    const policy = findPolicy('usaa', stream);
    assert.ok(policy, `usaa/${stream} policy must be registered`);
    assert.deepEqual(
      policy.excludeKeys,
      ['fetched_at'],
      `usaa/${stream} must exclude ONLY fetched_at; any real-field exclusion would compact real point-in-time history`,
    );
  });
}

// ─── Server disposition-registry in-sync guardrail ────────────────────────
//
// version_disposition is now DERIVED server-side
// (reference-implementation/server/version-disposition.js) from this script's
// COMPACTION_POLICIES registry plus two reference-maintained stream lists. The
// server module is intentionally `pg`-free, so this Node test imports it
// directly (no source-parsing of the browser bundle, which is what the prior
// console-mirror tests did before the lists moved server-side).
//
// These tests pin the structural invariants the derivation relies on:
//   - point-in-time split residuals must have NO compaction policy (a policy
//     would let `--apply` delete real history);
//   - recurring point-in-time snapshots (sessions) MUST have a compaction
//     policy — it is the regression safety net for a broken no-op gate — which
//     is exactly why the disposition cannot key on policy ABSENCE and must use
//     explicit list membership with precedence.

test('server point-in-time real-field streams have NO compaction policy (split, never compact)', () => {
  for (const { connector, stream } of SERVER_POINT_IN_TIME_STREAMS) {
    assert.equal(
      findPolicy(connector, stream),
      null,
      `${connector}/${stream} is a point-in-time split residual; it must NOT have a compaction policy`,
    );
    assert.equal(
      findPolicy(`https://registry.pdpp.org/connectors/${connector}`, stream),
      null,
      `${connector}/${stream} (registry-URL form) must also have no compaction policy`,
    );
  }
});

test('server point-in-time list matches this script\'s real-field guardrail list', () => {
  const serverSet = new Set(SERVER_POINT_IN_TIME_STREAMS.map(({ connector, stream }) => `${connector}/${stream}`));
  const scriptSet = new Set(
    POINT_IN_TIME_REAL_FIELD_STREAMS.map(({ connector, stream }) => `${connector}/${stream}`),
  );
  assert.deepEqual(
    [...serverSet].sort(),
    [...scriptSet].sort(),
    'server disposition point-in-time list and script real-field guardrail must list the same pairs',
  );
});

test('server recurring point-in-time snapshot streams DO have a registered compaction policy (regression safety net)', () => {
  // The design relies on this: sessions keep their policy as the catch for a
  // broken mtime gate, so the disposition must classify them by explicit list
  // membership with precedence, NOT by policy absence.
  for (const { connector, stream } of SERVER_RECURRING_SNAPSHOT_STREAMS) {
    assert.ok(
      findPolicy(connector, stream),
      `${connector}/${stream} is a recurring snapshot; it MUST keep a compaction policy as the no-op regression safety net`,
    );
  }
});

test('server recurring-snapshot list and point-in-time list are disjoint', () => {
  const piSet = new Set(SERVER_POINT_IN_TIME_STREAMS.map(({ connector, stream }) => `${connector}/${stream}`));
  for (const { connector, stream } of SERVER_RECURRING_SNAPSHOT_STREAMS) {
    assert.equal(
      piSet.has(`${connector}/${stream}`),
      false,
      `${connector}/${stream} cannot be both a recurring snapshot and a point-in-time split residual`,
    );
  }
});

test('parseLimitKeys accepts positive integers, rejects everything else', () => {
  assert.equal(parseLimitKeys('1'), 1);
  assert.equal(parseLimitKeys('42'), 42);
  assert.equal(parseLimitKeys(undefined), null);
  assert.equal(parseLimitKeys(null), null);
  assert.equal(parseLimitKeys(''), null);
  assert.equal(parseLimitKeys('0'), 'invalid');
  assert.equal(parseLimitKeys('-3'), 'invalid');
  assert.equal(parseLimitKeys('1.5'), 'invalid');
  assert.equal(parseLimitKeys('abc'), 'invalid');
  assert.equal(parseLimitKeys(true), 'invalid');
});

// selectRemovableVersions ───────────────────────────────────────────────

const WORKSPACE_POLICY = findPolicy('slack', 'workspace');
const THREADS_POLICY = findPolicy('gmail', 'threads');

function row(version, payload, { deleted = false } = {}) {
  return { version, record_json: payload, deleted };
}

test('selectRemovableVersions: empty history → nothing to remove', () => {
  assert.deepEqual(selectRemovableVersions([], 0, THREADS_POLICY), []);
});

test('selectRemovableVersions: single-version history → nothing to remove', () => {
  const rows = [row(1, { id: 'x', name: 'A' })];
  assert.deepEqual(selectRemovableVersions(rows, 1, THREADS_POLICY), []);
});

test('selectRemovableVersions: all distinct fingerprints → nothing to remove', () => {
  const rows = [
    row(1, { id: 'x', n: 1 }),
    row(2, { id: 'x', n: 2 }),
    row(3, { id: 'x', n: 3 }),
    row(4, { id: 'x', n: 4 }),
  ];
  assert.deepEqual(selectRemovableVersions(rows, 4, THREADS_POLICY), []);
});

test('selectRemovableVersions: adjacent same-fingerprint runs collapse to first; current and first retained', () => {
  // versions: 1 (first, A) 2 (A) 3 (A) 4 (B) 5 (current, B)
  const rows = [
    row(1, { id: 'x', kind: 'A' }),
    row(2, { id: 'x', kind: 'A' }),
    row(3, { id: 'x', kind: 'A' }),
    row(4, { id: 'x', kind: 'B' }),
    row(5, { id: 'x', kind: 'B' }),
  ];
  // 2 and 3 collapse to 1; 5 is current so retained; 4 is the most-recent-prior
  // with a different fingerprint from current (wait — 4 and 5 have the same
  // fingerprint so 4 is also same-as-current; the most-recent-differing-prior
  // is version 3, but 3 is being marked removable). Let's reason carefully:
  //   - current is v5, fingerprint B
  //   - most recent prior with different fingerprint = v3 (A) — must be retained
  //   - v1: first → retain
  //   - v2: prev surviving is v1 (A), same fp → remove
  //   - v3: prev surviving is v1 (A), same fp BUT v3 is pinned as the
  //         most-recent-differing-prior → retain
  //   - v4: prev surviving is v3 (A), different fp (B) → retain
  //   - v5: current → retain
  // Hold on — v3's fingerprint IS A, current is B, so v3 IS the most-recent
  // prior with different fingerprint. Retained. Result: [2].
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(removable.sort((a, b) => a - b), [2]);
});

test('selectRemovableVersions: long same-fingerprint run before current collapses to first', () => {
  // versions: 1 (A) 2 (A) 3 (A) 4 (A) 5 (current, A)
  const rows = [
    row(1, { id: 'x', kind: 'A' }),
    row(2, { id: 'x', kind: 'A' }),
    row(3, { id: 'x', kind: 'A' }),
    row(4, { id: 'x', kind: 'A' }),
    row(5, { id: 'x', kind: 'A' }),
  ];
  //   - current=5 (A); no prior version with different fp exists
  //   - v1: first → retain
  //   - v2, v3, v4: same fp as surviving anchor v1 → remove
  //   - v5: current → retain
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(removable.sort((a, b) => a - b), [2, 3, 4]);
});

test('selectRemovableVersions: tombstones bound compaction', () => {
  // versions: 1 (A) 2 (A) 3 (tombstone) 4 (A) 5 (current, A)
  const rows = [
    row(1, { id: 'x', kind: 'A' }),
    row(2, { id: 'x', kind: 'A' }),
    row(3, null, { deleted: true }),
    row(4, { id: 'x', kind: 'A' }),
    row(5, { id: 'x', kind: 'A' }),
  ];
  //   - v1: first → retain
  //   - v2: same fp as v1 → remove
  //   - v3: tombstone → retain (boundary)
  //   - v4: predecessor is a tombstone → retain (resurrection)
  //   - v5: current → retain
  // The "most recent prior with different fingerprint" from current is the
  // tombstone v3 (fingerprint != A); v3 is already retained.
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(removable.sort((a, b) => a - b), [2]);
});

test('selectRemovableVersions: workspace fetched_at-only churn collapses under fetched_at exclusion', () => {
  // versions whose only difference is fetched_at — the slack workspace
  // case the policy is designed for.
  const rows = [
    row(1, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:00:00Z' }),
    row(2, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:01:00Z' }),
    row(3, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:02:00Z' }),
    row(4, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:03:00Z' }),
    row(5, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:04:00Z' }),
  ];
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(removable.sort((a, b) => a - b), [2, 3, 4]);
});

test('selectRemovableVersions: channel_memberships fetched_at-only churn collapses, but a real membership field move is a boundary', () => {
  // The live offender shape: the membership identity {id, channel_id,
  // user_id} is stable across runs and only the run-clock `fetched_at`
  // moves, so under the fetched_at exclusion every version shares one
  // fingerprint and the intermediates collapse to the v1 anchor + current
  // pin. A version that changes a REAL membership field (here user_id, as
  // if the row were re-keyed) is a fingerprint boundary that survives.
  const MEMBERSHIPS_POLICY = findPolicy('slack', 'channel_memberships');
  assert.ok(MEMBERSHIPS_POLICY, 'slack/channel_memberships policy must be registered');
  const member = (userId, ts) => ({ id: `C1:${userId}`, channel_id: 'C1', user_id: userId, fetched_at: ts });
  const churnRows = [
    row(1, member('U1', '2026-05-26T00:00:00Z')),
    row(2, member('U1', '2026-05-26T00:01:00Z')),
    row(3, member('U1', '2026-05-26T00:02:00Z')),
    row(4, member('U1', '2026-05-26T00:03:00Z')),
  ];
  // All four share one fingerprint (fetched_at excluded) → 2,3 collapse to
  // v1; v4 is current → retained.
  assert.deepEqual(
    selectRemovableVersions(churnRows, 4, MEMBERSHIPS_POLICY).sort((a, b) => a - b),
    [2, 3],
  );
  // A real membership field move (user_id) is a fingerprint boundary that is
  // never collapsed — it is pinned as the most-recent-differing-prior.
  const boundaryRows = [
    row(1, member('U1', '2026-05-26T00:00:00Z')),
    row(2, member('U1', '2026-05-26T00:01:00Z')),
    row(3, member('U2', '2026-05-26T00:02:00Z')),
    row(4, member('U2', '2026-05-26T00:03:00Z')),
  ];
  // current = v4 (U2). most-recent prior with different fp = v2 (U1) → pinned.
  //   v1 first → retain; v2 differing-prior pin → retain; v3 different fp from
  //   v2 → retain; v4 current → retain. Nothing removable: the U1→U2 boundary
  //   and the only intermediate are all protected.
  assert.deepEqual(selectRemovableVersions(boundaryRows, 4, MEMBERSHIPS_POLICY), []);
});

test('selectRemovableVersions: workspace fetched_at-only churn does NOT collapse under threads policy (no exclude)', () => {
  // Same rows, but a hypothetical policy with no exclude would treat each
  // fetched_at change as a real fingerprint change.
  const rows = [
    row(1, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:00:00Z' }),
    row(2, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:01:00Z' }),
    row(3, { id: 'T1', name: 'W', fetched_at: '2026-05-26T00:02:00Z' }),
  ];
  // Gmail threads policy has excludeKeys: [] — every row's fp differs.
  const removable = selectRemovableVersions(rows, 3, THREADS_POLICY);
  assert.deepEqual(removable, []);
});

test('selectRemovableVersions: ynab budgets last_month/last_modified_on-only churn collapses under the budgets exclusion', () => {
  // The historical offender shape: every run re-emitted the budget with a
  // fresh last_month (calendar rollover) / last_modified_on (any in-budget
  // edit), none of which changed the budget-summary fields. Excluding both
  // fields, every version has the same fingerprint → intermediates collapse.
  const BUDGETS_POLICY = findPolicy('ynab', 'budgets');
  assert.ok(BUDGETS_POLICY, 'ynab/budgets policy must be registered');
  assert.deepEqual(BUDGETS_POLICY.excludeKeys, ['last_month', 'last_modified_on']);
  const budget = (lastMonth, lastModified) => ({
    id: 'b_1',
    name: 'My Budget',
    first_month: '2024-01-01',
    last_month: lastMonth,
    last_modified_on: lastModified,
    currency_iso_code: 'USD',
    date_format_string: 'MM/DD/YYYY',
    deleted: false,
  });
  const rows = [
    row(1, budget('2026-01-01', '2026-01-15T00:00:00Z')),
    row(2, budget('2026-02-01', '2026-02-03T00:00:00Z')),
    row(3, budget('2026-03-01', '2026-03-09T00:00:00Z')),
    row(4, budget('2026-04-01', '2026-04-21T00:00:00Z')),
    row(5, budget('2026-05-01', '2026-05-30T00:00:00Z')),
  ];
  // All five share one fingerprint → collapse to the v1 anchor and the
  // current pin (v5). No prior version differs from current, so no
  // most-recent-differing-prior pin exists.
  const removable = selectRemovableVersions(rows, 5, BUDGETS_POLICY);
  assert.deepEqual(removable.sort((a, b) => a - b), [2, 3, 4]);
});

test('selectRemovableVersions: ynab budgets genuine summary edit is a fingerprint boundary, not collapsed', () => {
  // A real edit to a projected field (rename) must remain a version
  // transition even though the calendar fields also moved.
  const BUDGETS_POLICY = findPolicy('ynab', 'budgets');
  const budget = (name, lastMonth) => ({
    id: 'b_1',
    name,
    first_month: '2024-01-01',
    last_month: lastMonth,
    last_modified_on: '2026-05-30T00:00:00Z',
    currency_iso_code: 'USD',
    date_format_string: 'MM/DD/YYYY',
    deleted: false,
  });
  const rows = [
    row(1, budget('Old Name', '2026-01-01')), // first → retain
    row(2, budget('Old Name', '2026-02-01')), // calendar-only churn after v1
    row(3, budget('New Name', '2026-03-01')), // genuine rename → boundary
    row(4, budget('New Name', '2026-04-01')), // calendar-only churn after rename
  ];
  // current = v4 (New Name = FP_B).
  //   most-recent prior with fp != FP_B is v2 ("Old Name" = FP_A) → pinned.
  //   v1 first → retain
  //   v2 is the most-recent-differing-prior pin → retain (NOT removable, even
  //      though it shares FP_A with v1; the pin wins over the collapse rule)
  //   v3 rename: predecessor surviving anchor is v2 (FP_A), v3 is FP_B,
  //      different fp → retain
  //   v4 current → retain
  // The genuine rename is preserved as a boundary and no real history is
  // collapsed; the only calendar-only intermediate (v2) is protected here by
  // the differing-prior pin rather than removed. Removable = [].
  const removable = selectRemovableVersions(rows, 4, BUDGETS_POLICY);
  assert.deepEqual(removable, []);
});

test('selectRemovableVersions: current-row pin holds even when current matches a removable run', () => {
  // versions: 1 (A) 2 (A) 3 (current, A) 4 (A)
  // (a possible state if compaction is run while a later equal-fingerprint row exists
  //  — shouldn't happen in practice but the selector must be robust)
  const rows = [
    row(1, { id: 'x', kind: 'A' }),
    row(2, { id: 'x', kind: 'A' }),
    row(3, { id: 'x', kind: 'A' }),
    row(4, { id: 'x', kind: 'A' }),
  ];
  const removable = selectRemovableVersions(rows, 3, WORKSPACE_POLICY);
  // v1 first, v3 current. v2 collapses into v1. v4 same fp as surviving
  // anchor (v3, current) → removable.
  assert.deepEqual(removable.sort((a, b) => a - b), [2, 4]);
});

// ─── Postgres-backed integration tests ──────────────────────────────────

if (!POSTGRES_URL) {
  test('compact-record-history DB tests (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  async function withFixture(fn) {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_compact_${suffix}`;
    const connectorId = `slack_compact_${suffix}`;
    const stream = 'workspace';
    const runId = `test_${suffix}`;
    const backupTable = `compact_record_history_backup_${runId}`;
    try {
      await fn({ pool, connectorInstanceId, connectorId, stream, runId, backupTable });
    } finally {
      try { await pool.query(`DROP TABLE IF EXISTS "${backupTable}"`); } catch {}
      await pool.query(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [connectorInstanceId]);
      try {
        await pool.query(`DELETE FROM retained_size_stream WHERE connector_instance_id = $1`, [connectorInstanceId]);
      } catch {}
      try {
        await pool.query(`DELETE FROM retained_size_connection WHERE connector_instance_id = $1`, [connectorInstanceId]);
      } catch {}
      await pool.end();
    }
  }

  async function seedWorkspaceChurn({ pool, connectorInstanceId, connectorId, stream, recordKey }) {
    // Seed the canonical churn shape — every version has the same
    // record_json modulo fetched_at, which is excluded from the slack
    // workspace fingerprint. v6 is the current row; the three
    // intermediates (v2, v3, v4) collapse into the v1 anchor; v5 is
    // retained because the selector pins the most-recent prior row
    // whose fingerprint differs from the current row when one exists.
    // In this fixture every row's fingerprint matches v6, so no such
    // pin exists and v5 collapses into v1 too — giving the canonical
    // shape: 6 versions in, removable = {2, 3, 4, 5}, retained = {1, 6}.
    //
    // We assert removableVersions === 4 (not 3) — the design.md hint of
    // "three intermediate, one fingerprint-differing" matches a different
    // shape that this test does not seed; the live offender (slack
    // workspace, 31k versions for a single fingerprint-stable record)
    // is closer to this seed.
    const payloadStable = (ts) => ({
      id: recordKey,
      name: 'Workspace',
      url: 'https://example.com/',
      fetched_at: ts,
    });
    const rows = [
      { v: 1, p: payloadStable('2026-05-26T00:00:00Z') },
      { v: 2, p: payloadStable('2026-05-26T00:01:00Z') },
      { v: 3, p: payloadStable('2026-05-26T00:02:00Z') },
      { v: 4, p: payloadStable('2026-05-26T00:03:00Z') },
      { v: 5, p: payloadStable('2026-05-26T00:04:00Z') },
      { v: 6, p: payloadStable('2026-05-26T00:05:00Z') },
    ];

    await pool.query(
      `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
       VALUES($1, $2, $3, $4)
       ON CONFLICT (connector_instance_id, stream) DO UPDATE SET max_version = EXCLUDED.max_version`,
      [connectorId, connectorInstanceId, stream, 6],
    );
    for (const r of rows) {
      await pool.query(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE)`,
        [connectorId, connectorInstanceId, stream, recordKey, r.v, JSON.stringify(r.p), '2026-05-26T00:00:00Z'],
      );
    }
    // Current row points at v6.
    await pool.query(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
       VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, $4)`,
      [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify(rows[5].p), '2026-05-26T00:05:00Z', 6],
    );
  }

  test('plan reports removableVersions=4 for the canonical workspace fetched_at-only churn fixture', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      const recordKey = 'T-AAA';
      await seedWorkspaceChurn({ pool, connectorInstanceId, connectorId, stream, recordKey });
      const policy = findPolicy('slack', 'workspace');
      const plan = await planCompaction({ pool, connectorInstanceId, stream, policy, limitKeys: null });
      assert.equal(plan.scannedKeys, 1);
      assert.equal(plan.scannedVersions, 6);
      assert.equal(plan.removableVersions, 4);
      assert.equal(plan.retainedVersionsAfter, 2);
      assert.ok(plan.estimatedRemovedBytes > 0, 'estimatedRemovedBytes should be positive');
    });
  });

  test('apply removes exactly the planned versions, populates backup, leaves current/version_counter untouched', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream, runId, backupTable }) => {
      const recordKey = 'T-BBB';
      await seedWorkspaceChurn({ pool, connectorInstanceId, connectorId, stream, recordKey });
      const policy = findPolicy('slack', 'workspace');

      // Snapshot the surviving rows + current + counter for byte-identity check.
      const beforeChanges = await pool.query(
        `SELECT version, record_json::text AS rj, emitted_at, deleted FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version`,
        [connectorInstanceId, stream],
      );
      const beforeRecord = await pool.query(
        `SELECT record_json::text AS rj, version FROM records WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      const beforeCounter = await pool.query(
        `SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );

      const plan = await planCompaction({ pool, connectorInstanceId, stream, policy, limitKeys: null });
      const result = await applyCompaction({ pool, plan, runId });

      assert.equal(result.deleted, 4);
      assert.equal(result.inserted, 4);
      assert.equal(result.backupTable, backupTable);

      // Backup table has exactly four rows.
      const backupRows = await pool.query(`SELECT COUNT(*)::int AS c FROM "${backupTable}"`);
      assert.equal(backupRows.rows[0].c, 4);

      // The retained versions are 1 (first) and 6 (current).
      const remainingVersions = (await pool.query(
        `SELECT version FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version`,
        [connectorInstanceId, stream],
      )).rows.map((r) => Number(r.version));
      assert.deepEqual(remainingVersions, [1, 6]);

      // Surviving rows are byte-identical to before (compare on the rows that remain).
      const afterChangesMap = new Map(
        (await pool.query(
          `SELECT version, record_json::text AS rj, emitted_at, deleted FROM record_changes
            WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version`,
          [connectorInstanceId, stream],
        )).rows.map((r) => [Number(r.version), r]),
      );
      for (const b of beforeChanges.rows) {
        const v = Number(b.version);
        if (![1, 6].includes(v)) continue;
        const a = afterChangesMap.get(v);
        assert.ok(a, `version ${v} must survive`);
        assert.equal(a.rj, b.rj, `version ${v} record_json must be byte-identical`);
        assert.equal(a.emitted_at, b.emitted_at);
        assert.equal(!!a.deleted, !!b.deleted);
      }

      // Current row untouched.
      const afterRecord = await pool.query(
        `SELECT record_json::text AS rj, version FROM records WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      assert.equal(afterRecord.rows[0].rj, beforeRecord.rows[0].rj);
      assert.equal(Number(afterRecord.rows[0].version), Number(beforeRecord.rows[0].version));

      // version_counter untouched.
      const afterCounter = await pool.query(
        `SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      assert.equal(
        Number(afterCounter.rows[0].max_version),
        Number(beforeCounter.rows[0].max_version),
      );
    });
  });

  test('markScopeDirty flips retained_size_stream.dirty for the scope', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      // Seed a retained_size_stream row in the clean state so we can
      // observe the flip.
      await pool.query(
        `INSERT INTO retained_size_stream
           (connector_instance_id, connector_id, stream,
            current_record_json_bytes, record_history_json_bytes, blob_bytes,
            record_count, record_history_count, blob_count,
            dirty, computed_at)
         VALUES($1, $2, $3, 0, 0, 0, 0, 0, 0, 0, NOW()::text)
         ON CONFLICT (connector_instance_id, stream) DO UPDATE
           SET dirty = 0`,
        [connectorInstanceId, connectorId, stream],
      );
      const before = await pool.query(
        `SELECT dirty FROM retained_size_stream
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      assert.equal(Number(before.rows[0].dirty), 0);

      await markScopeDirty({ pool, connectorInstanceId, stream });

      const after = await pool.query(
        `SELECT dirty FROM retained_size_stream
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      assert.equal(Number(after.rows[0].dirty), 1, 'markScopeDirty must flip dirty=1');
    });
  });

  test('CLI: unknown (connector_id, stream) pair refuses to run', () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--connector-instance-id=cin_unknown', '--stream=messages', '--connector-id=slack'],
      { env: { ...process.env, PDPP_TEST_POSTGRES_URL: POSTGRES_URL }, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0, 'must exit non-zero for unknown policy');
    assert.match(r.stderr + r.stdout, /no compaction policy registered/);
    assert.match(r.stderr + r.stdout, /Registered policies/);
  });

  test('CLI: unknown stream on a registered connector still refuses', () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--connector-instance-id=cin_unknown', '--stream=context_mode', '--connector-id=codex'],
      { env: { ...process.env, PDPP_TEST_POSTGRES_URL: POSTGRES_URL }, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0, 'must exit non-zero for unknown stream under a registered connector');
    assert.match(r.stderr + r.stdout, /no compaction policy registered/);
  });

  test('CLI: unknown connector (chatgpt) refuses even on a stream name that exists elsewhere', () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--connector-instance-id=cin_unknown', '--stream=messages', '--connector-id=chatgpt'],
      { env: { ...process.env, PDPP_TEST_POSTGRES_URL: POSTGRES_URL }, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /no compaction policy registered/);
  });

  test('CLI: --apply without database credentials refuses to run', () => {
    const env = { ...process.env };
    delete env.PDPP_DATABASE_URL;
    delete env.PDPP_TEST_POSTGRES_URL;
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--connector-instance-id=cin_anything', '--stream=workspace', '--connector-id=slack', '--apply'],
      { env, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0, 'must exit non-zero without DB creds');
    assert.match(r.stderr + r.stdout, /PDPP_DATABASE_URL/);
  });

  test('CLI: invalid --limit-keys refuses to run', () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--connector-instance-id=cin_x', '--stream=workspace', '--connector-id=slack', '--limit-keys=-3'],
      { env: { ...process.env, PDPP_TEST_POSTGRES_URL: POSTGRES_URL }, encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /--limit-keys must be a positive integer/);
  });

  test('exact-JSON identity policy compacts codex/messages adjacent duplicates and pins boundaries', async () => {
    // Seed a codex/messages key with the shape we see in the live DB:
    // adjacent versions whose record_json is byte-identical (no fetched_at
    // to exclude). The selector should collapse adjacent same-JSON runs
    // while pinning the first version, the current version, and the
    // most-recent prior version with a *different* fingerprint.
    const pool = new Pool({ connectionString: POSTGRES_URL });
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_compact_codex_${suffix}`;
    const connectorId = `local-device:codex`;
    const stream = 'messages';
    const recordKey = `session_${suffix}:1`;
    const runId = `test_${suffix}`;
    const backupTable = `compact_record_history_backup_${runId}`;
    try {
      // Sequence: A A A B B (current is v5)
      //   v1 first → retain
      //   v2 same fp as v1 surviving anchor → remove
      //   v3 same fp as v1 surviving anchor → remove
      //   v4: prev surviving is v1 (A), different fp (B) → retain
      //        (also: most-recent-prior-with-different-fp from v5 is v4? no —
      //         v4 has same fp (B) as current v5. The most-recent-prior with
      //         a *different* fp is v3 (A). v3 was marked removable above —
      //         but the selector pins it as most-recent-differing-prior, so
      //         it must be retained instead. So removable = [v2], retained
      //         = [v1, v3, v4, v5]).
      //   v5: current → retain
      const payloadA = {
        id: recordKey,
        session_id: `session_${suffix}`,
        role: 'user',
        type: 'user',
        content: 'hello',
        timestamp: '2026-05-26T10:00:00.000Z',
      };
      const payloadB = {
        ...payloadA,
        content: 'hello world',
      };
      const rows = [
        { v: 1, p: payloadA },
        { v: 2, p: payloadA },
        { v: 3, p: payloadA },
        { v: 4, p: payloadB },
        { v: 5, p: payloadB },
      ];
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, $4)
         ON CONFLICT (connector_instance_id, stream) DO UPDATE SET max_version = EXCLUDED.max_version`,
        [connectorId, connectorInstanceId, stream, 5],
      );
      for (const r of rows) {
        await pool.query(
          `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
           VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE)`,
          [connectorId, connectorInstanceId, stream, recordKey, r.v, JSON.stringify(r.p), '2026-05-26T10:00:00.000Z'],
        );
      }
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify(payloadB), '2026-05-26T10:00:05.000Z', 5],
      );

      const policy = findPolicy('codex', 'messages');
      assert.ok(policy, 'codex/messages policy must be registered');

      const plan = await planCompaction({ pool, connectorInstanceId, stream, policy, limitKeys: null });
      assert.equal(plan.scannedKeys, 1);
      assert.equal(plan.scannedVersions, 5);
      assert.equal(plan.removableVersions, 1, 'only v2 should be removable (v3 pinned as most-recent-differing-prior wrt B, v4 retained as different fp)');
      assert.ok(plan.connectorIdsSeen.includes('local-device:codex'));

      const result = await applyCompaction({ pool, plan, runId });
      assert.equal(result.deleted, 1);
      assert.equal(result.inserted, 1);
      assert.equal(result.backupTable, backupTable);

      const remaining = (await pool.query(
        `SELECT version FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version`,
        [connectorInstanceId, stream],
      )).rows.map((r) => Number(r.version));
      assert.deepEqual(remaining, [1, 3, 4, 5]);

      const backupRows = await pool.query(`SELECT version FROM "${backupTable}" ORDER BY version`);
      assert.deepEqual(backupRows.rows.map((r) => Number(r.version)), [2]);
    } finally {
      try { await pool.query(`DROP TABLE IF EXISTS "${backupTable}"`); } catch {}
      await pool.query(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [connectorInstanceId]);
      try { await pool.query(`DELETE FROM retained_size_stream WHERE connector_instance_id = $1`, [connectorInstanceId]); } catch {}
      try { await pool.query(`DELETE FROM retained_size_connection WHERE connector_instance_id = $1`, [connectorInstanceId]); } catch {}
      await pool.end();
    }
  });

  test('apply on an already-clean stream removes zero rows and creates no rows in backup', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream, runId }) => {
      const recordKey = 'T-CCC';
      // Seed only two distinct-fingerprint versions and current.
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 2)`,
        [connectorId, connectorInstanceId, stream],
      );
      for (const v of [
        { v: 1, p: { id: recordKey, name: 'A' } },
        { v: 2, p: { id: recordKey, name: 'B' } },
      ]) {
        await pool.query(
          `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
           VALUES($1, $2, $3, $4, $5, $6::jsonb, '2026-05-26T00:00:00Z', FALSE)`,
          [connectorId, connectorInstanceId, stream, recordKey, v.v, JSON.stringify(v.p)],
        );
      }
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, '2026-05-26T00:00:00Z', 2, FALSE, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify({ id: recordKey, name: 'B' })],
      );
      const policy = findPolicy('slack', 'workspace');
      const plan = await planCompaction({ pool, connectorInstanceId, stream, policy, limitKeys: null });
      assert.equal(plan.removableVersions, 0);
      const result = await applyCompaction({ pool, plan, runId });
      assert.equal(result.deleted, 0);
      assert.equal(result.inserted, 0);
      assert.equal(result.backupTable, null, 'no-op apply does not create a backup table');
    });
  });
}
