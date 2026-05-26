/**
 * Parity test: compact-record-history.mjs:recordFingerprint
 * vs packages/polyfill-connectors/src/fingerprint-cursor.ts:recordFingerprint
 *
 * This script reimplements the canonical fingerprint shape locally
 * because it is a `.mjs` operational tool and importing the canonical
 * helper from `@pdpp/polyfill-connectors` would couple the tool to
 * either a TS build artifact or a runtime TS shim. The substitute for
 * that coupling is this test: drift between the two implementations
 * fails it loudly.
 *
 * Coverage:
 *   - Each of the five registered policies' representative payload
 *     shapes (workspace with `fetched_at` exclude, users, files,
 *     threads, payee_locations) hashes byte-identically under both
 *     implementations.
 *   - Adversarial payloads — nested objects, mixed key order, nested
 *     arrays of objects, `null` leaves, arrays of strings — also hash
 *     byte-identically.
 *
 * Run with:
 *   node --test --import tsx \
 *     reference-implementation/test/compact-record-history-fingerprint-parity.test.js
 *
 * This test is gated on tsx being available; without `--import tsx`
 * Node cannot resolve the canonical helper's `.ts` extension and the
 * test is skipped. The dependency-free pure-helper tests in
 * `compact-record-history.test.js` cover the script in isolation; this
 * test exists solely to lock the script's fingerprint shape against the
 * connector helper.
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_POLICIES,
  findPolicy,
  recordFingerprint as scriptRecordFingerprint,
} from '../scripts/compact-record-history.mjs';

let canonicalRecordFingerprint;
try {
  // Loaded via tsx — the canonical helper lives in TypeScript.
  const mod = await import(
    '../../packages/polyfill-connectors/src/fingerprint-cursor.ts'
  );
  canonicalRecordFingerprint = mod.recordFingerprint;
} catch (err) {
  // Without tsx the .ts extension cannot be resolved by Node directly.
  // We skip the suite rather than fail because the pure-helper tests in
  // compact-record-history.test.js still exercise this implementation
  // independently.
  test('compact-record-history fingerprint parity (skipped: tsx unavailable)', { skip: true }, () => {
    void err;
  });
}

function expectParity(payload, excludeKeys, label) {
  const a = scriptRecordFingerprint(payload, excludeKeys);
  const b = canonicalRecordFingerprint(payload, excludeKeys);
  assert.equal(
    a,
    b,
    `${label}: script ${a} != canonical ${b} — implementations drifted`,
  );
}

if (canonicalRecordFingerprint) {
  test('parity: gmail threads representative payload', () => {
    const policy = findPolicy('gmail', 'threads');
    expectParity(
      {
        id: 't_abc',
        snippet: 'hello world',
        message_count: 3,
        last_message_at: '2026-05-26T10:00:00Z',
        participants: ['alice@example.com', 'bob@example.com'],
        labels: ['INBOX', 'IMPORTANT'],
      },
      policy.excludeKeys,
      'gmail/threads',
    );
  });

  test('parity: slack workspace excludes fetched_at', () => {
    const policy = findPolicy('slack', 'workspace');
    const base = {
      id: 'T123',
      name: 'My Workspace',
      domain: 'my-ws',
      url: 'https://my-ws.slack.com/',
    };
    expectParity(
      { ...base, fetched_at: '2026-05-26T10:00:00Z' },
      policy.excludeKeys,
      'slack/workspace ts=10:00',
    );
    expectParity(
      { ...base, fetched_at: '2026-05-26T11:00:00Z' },
      policy.excludeKeys,
      'slack/workspace ts=11:00',
    );
    // And that the script and canonical helper both treat the
    // fetched_at-only delta as equal:
    const h1 = scriptRecordFingerprint(
      { ...base, fetched_at: '2026-05-26T10:00:00Z' },
      policy.excludeKeys,
    );
    const h2 = scriptRecordFingerprint(
      { ...base, fetched_at: '2026-05-26T11:00:00Z' },
      policy.excludeKeys,
    );
    assert.equal(h1, h2, 'fetched_at delta must not change the fingerprint');
  });

  test('parity: slack users representative payload', () => {
    const policy = findPolicy('slack', 'users');
    expectParity(
      {
        id: 'U999',
        name: 'asmith',
        real_name: 'Alice Smith',
        is_admin: false,
        profile: {
          email: 'alice@example.com',
          display_name: 'Alice',
          status_text: '',
        },
      },
      policy.excludeKeys,
      'slack/users',
    );
  });

  test('parity: slack files representative payload', () => {
    const policy = findPolicy('slack', 'files');
    expectParity(
      {
        id: 'F555',
        name: 'design.png',
        size: 12345,
        mimetype: 'image/png',
        channels: ['C1', 'C2'],
        thumb_url: 'https://files.slack.com/t/x',
      },
      policy.excludeKeys,
      'slack/files',
    );
  });

  test('parity: ynab payee_locations representative payload', () => {
    const policy = findPolicy('ynab', 'payee_locations');
    expectParity(
      {
        id: 'pl_abc',
        payee_id: 'p_xyz',
        latitude: '40.7',
        longitude: '-74.0',
      },
      policy.excludeKeys,
      'ynab/payee_locations',
    );
  });

  test('parity: nested objects with mixed key order', () => {
    const a = {
      id: 'x',
      meta: { z: 1, a: 2, m: { q: 'q', a: 'a' } },
      tags: ['b', 'a', 'c'],
    };
    const b = {
      tags: ['b', 'a', 'c'],
      meta: { a: 2, m: { a: 'a', q: 'q' }, z: 1 },
      id: 'x',
    };
    const hScript = scriptRecordFingerprint(a);
    const hCanonical = canonicalRecordFingerprint(a);
    assert.equal(hScript, hCanonical, 'top-level: nested objects');
    assert.equal(
      scriptRecordFingerprint(b),
      canonicalRecordFingerprint(b),
      'reordered: nested objects',
    );
    assert.equal(
      scriptRecordFingerprint(a),
      scriptRecordFingerprint(b),
      'script: stable across key order',
    );
  });

  test('parity: arrays of objects do not get re-sorted', () => {
    // Arrays preserve order; only object keys sort.
    const a = { id: 'x', items: [{ k: 1 }, { k: 2 }, { k: 3 }] };
    const b = { id: 'x', items: [{ k: 3 }, { k: 2 }, { k: 1 }] };
    assert.notEqual(
      scriptRecordFingerprint(a),
      scriptRecordFingerprint(b),
      'array order must matter',
    );
    assert.equal(
      scriptRecordFingerprint(a),
      canonicalRecordFingerprint(a),
      'parity on ordered arrays a',
    );
    assert.equal(
      scriptRecordFingerprint(b),
      canonicalRecordFingerprint(b),
      'parity on ordered arrays b',
    );
  });

  test('parity: null leaves and primitive values', () => {
    const payload = {
      id: 'x',
      a: null,
      b: 0,
      c: '',
      d: false,
      e: [null, 0, '', false],
      f: { g: null },
    };
    expectParity(payload, [], 'null+primitive leaves');
  });

  test('parity: exclude keys with no overlap is a no-op', () => {
    const payload = { id: 'x', name: 'n' };
    expectParity(payload, ['not_present'], 'noop exclude');
  });

  test('every registered policy has a parity-checked fixture above', () => {
    // Static guard: if a new policy is added without a parity fixture,
    // this assertion fails and points at the gap.
    const fixturedPairs = new Set([
      'gmail/threads',
      'slack/workspace',
      'slack/users',
      'slack/files',
      'ynab/payee_locations',
    ]);
    for (const p of COMPACTION_POLICIES) {
      const pair = `${p.connectorIds[0]}/${p.stream}`;
      assert.ok(
        fixturedPairs.has(pair),
        `policy ${pair} has no parity fixture in this test`,
      );
    }
  });
}
