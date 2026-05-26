/**
 * Integration tests for the record-derived-field-backfill repair tool.
 *
 * Uses the local Compose Postgres (PDPP_TEST_POSTGRES_URL) to set up
 * fixture rows in a uniquely-named connector_instance, run the repair
 * tool's policy + equivalence-guard logic against them, and assert
 * behavior:
 *
 *   - current row null, prior change row jsonb-equivalent + non-null → refilled
 *   - current row non-null → skipped (pre-filter)
 *   - no non-null history → skipped
 *   - cross-key isolation → never reaches across record_key
 *   - equivalence guard → a prior row with non-null derived fields but
 *     a different non-derived field is REJECTED as a refill source
 *   - --limit must be a positive integer
 *   - REPAIR_POLICIES refuses unknown streams
 *
 * These tests import the real policy + helpers from the script module
 * (CLI-arg parsing is skipped because the script only runs argv parsing
 * when invoked as a binary).
 *
 * Spec: openspec/changes/repair-record-version-noop-detection/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  REPAIR_POLICIES,
  evaluatePriorAsRefillSource,
  mergePayload,
  parseLimit,
  runRepair,
  stripDerivedFields,
} from '../scripts/repair/record-derived-field-backfill.mjs';

const { Pool } = pg;

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// ─── Argument-validation tests (no DB) ──────────────────────────────────

test('parseLimit accepts positive integers', () => {
  assert.equal(parseLimit('1'), 1);
  assert.equal(parseLimit('42'), 42);
  assert.equal(parseLimit(undefined), null);
  assert.equal(parseLimit(null), null);
  assert.equal(parseLimit(''), null);
});

test('parseLimit rejects non-positive-integer values', () => {
  assert.equal(parseLimit('0'), 'invalid');
  assert.equal(parseLimit('-3'), 'invalid');
  assert.equal(parseLimit('1.5'), 'invalid');
  assert.equal(parseLimit('abc'), 'invalid');
  assert.equal(parseLimit(true), 'invalid'); // bare --limit flag
});

test('REPAIR_POLICIES exposes only registered streams', () => {
  assert.deepEqual(Object.keys(REPAIR_POLICIES), ['sessions']);
  assert.deepEqual(REPAIR_POLICIES.sessions.derivedFields, [
    'message_count',
    'function_call_count',
  ]);
});

test('stripDerivedFields removes the listed keys without touching others', () => {
  const out = stripDerivedFields(
    { id: 'a', message_count: 5, function_call_count: 3, other: 1 },
    ['message_count', 'function_call_count'],
  );
  assert.deepEqual(out, { id: 'a', other: 1 });
});

// ─── DB-backed integration tests ────────────────────────────────────────

if (!POSTGRES_URL) {
  test('record derived-field backfill DB tests (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  const SESSIONS_POLICY = REPAIR_POLICIES.sessions;

  async function withFixture(fn) {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_repair_${suffix}`;
    const connectorId = `repair_${suffix}`;
    const stream = 'sessions';
    try {
      await fn({ pool, connectorInstanceId, connectorId, stream });
    } finally {
      await pool.query(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [
        connectorInstanceId,
      ]);
      await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [
        connectorInstanceId,
      ]);
      await pool.query(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [
        connectorInstanceId,
      ]);
      await pool.end();
    }
  }

  test('refills null derived fields from prior jsonb-equivalent non-null history (dry-run)', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      const recordKey = 'thr-a';
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 2)`,
        [connectorId, connectorInstanceId, stream],
      );
      const priorJson = JSON.stringify({
        id: recordKey,
        title: 'same',
        message_count: 7,
        function_call_count: 4,
      });
      const currentJson = JSON.stringify({
        id: recordKey,
        title: 'same',
        message_count: null,
        function_call_count: null,
      });
      await pool.query(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES($1, $2, $3, $4, 1, $5::jsonb, '2026-05-01T00:00:00Z', FALSE),
                ($1, $2, $3, $4, 2, $6::jsonb, '2026-05-02T00:00:00Z', FALSE)`,
        [connectorId, connectorInstanceId, stream, recordKey, priorJson, currentJson],
      );
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, '2026-05-02T00:00:00Z', 2, FALSE, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, currentJson],
      );

      const result = await runRepair({
        pool,
        connectorInstanceId,
        stream,
        recordKey: null,
        limit: null,
        policy: SESSIONS_POLICY,
        apply: false,
      });

      assert.equal(result.previews.length, 1);
      const p = result.previews[0];
      assert.equal(p.recordKey, recordKey);
      assert.equal(Number(p.sourceVersion), 1);
      assert.deepEqual(p.fieldsRefilled.sort(), ['function_call_count', 'message_count']);
      assert.equal(p.merged.message_count, 7);
      assert.equal(p.merged.function_call_count, 4);
    });
  });

  test('leaves a row alone when current has non-null derived fields', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      const recordKey = 'thr-b';
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 1)`,
        [connectorId, connectorInstanceId, stream],
      );
      const currentJson = JSON.stringify({
        id: recordKey,
        message_count: 11,
        function_call_count: 9,
      });
      await pool.query(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES($1, $2, $3, $4, 1, $5::jsonb, '2026-05-01T00:00:00Z', FALSE)`,
        [connectorId, connectorInstanceId, stream, recordKey, currentJson],
      );
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, '2026-05-01T00:00:00Z', 1, FALSE, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, currentJson],
      );

      const result = await runRepair({
        pool,
        connectorInstanceId,
        stream,
        recordKey: null,
        limit: null,
        policy: SESSIONS_POLICY,
        apply: false,
      });

      assert.equal(result.previews.length, 0, 'rows with non-null derived fields are pre-filtered out');
    });
  });

  test('skips records with no non-null history', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      const recordKey = 'thr-c';
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 2)`,
        [connectorId, connectorInstanceId, stream],
      );
      const nullJson = JSON.stringify({
        id: recordKey,
        message_count: null,
        function_call_count: null,
      });
      await pool.query(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES($1, $2, $3, $4, 1, $5::jsonb, '2026-05-01T00:00:00Z', FALSE),
                ($1, $2, $3, $4, 2, $5::jsonb, '2026-05-02T00:00:00Z', FALSE)`,
        [connectorId, connectorInstanceId, stream, recordKey, nullJson],
      );
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, '2026-05-02T00:00:00Z', 2, FALSE, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, nullJson],
      );

      const result = await runRepair({
        pool,
        connectorInstanceId,
        stream,
        recordKey: null,
        limit: null,
        policy: SESSIONS_POLICY,
        apply: false,
      });

      assert.equal(result.previews.length, 0);
    });
  });

  test('equivalence guard rejects a prior row whose non-derived fields differ', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      const recordKey = 'thr-guard';
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 2)`,
        [connectorId, connectorInstanceId, stream],
      );
      // Prior row carries non-null derived fields AND a different
      // non-derived field (`title`). The repair MUST refuse it.
      const priorJson = JSON.stringify({
        id: recordKey,
        title: 'old title',
        message_count: 7,
        function_call_count: 4,
      });
      const currentJson = JSON.stringify({
        id: recordKey,
        title: 'new title',
        message_count: null,
        function_call_count: null,
      });
      await pool.query(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES($1, $2, $3, $4, 1, $5::jsonb, '2026-05-01T00:00:00Z', FALSE),
                ($1, $2, $3, $4, 2, $6::jsonb, '2026-05-02T00:00:00Z', FALSE)`,
        [connectorId, connectorInstanceId, stream, recordKey, priorJson, currentJson],
      );
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, '2026-05-02T00:00:00Z', 2, FALSE, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, currentJson],
      );

      // Direct check against the helper.
      const guardResult = await evaluatePriorAsRefillSource(
        pool,
        JSON.parse(currentJson),
        JSON.parse(priorJson),
        SESSIONS_POLICY.derivedFields,
      );
      assert.equal(guardResult, null, 'guard SHALL reject prior with differing non-derived field');

      // End-to-end through runRepair: no preview.
      const result = await runRepair({
        pool,
        connectorInstanceId,
        stream,
        recordKey: null,
        limit: null,
        policy: SESSIONS_POLICY,
        apply: false,
      });
      assert.equal(result.previews.length, 0, 'runRepair SHALL skip when guard fails for every prior');
    });
  });

  test('equivalence guard accepts a prior whose only difference is the derived fields', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      const recordKey = 'thr-accept';
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 2)`,
        [connectorId, connectorInstanceId, stream],
      );
      const priorJson = JSON.stringify({
        id: recordKey,
        title: 'shared',
        nested: { a: 1, b: [1, 2, 3] },
        message_count: 12,
        function_call_count: 8,
      });
      // Same payload, derived fields null, *different key order on the
      // wire*. After removing derived fields, both are jsonb-equal.
      const currentJson = JSON.stringify({
        function_call_count: null,
        message_count: null,
        nested: { b: [1, 2, 3], a: 1 },
        title: 'shared',
        id: recordKey,
      });
      await pool.query(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES($1, $2, $3, $4, 1, $5::jsonb, '2026-05-01T00:00:00Z', FALSE),
                ($1, $2, $3, $4, 2, $6::jsonb, '2026-05-02T00:00:00Z', FALSE)`,
        [connectorId, connectorInstanceId, stream, recordKey, priorJson, currentJson],
      );
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, '2026-05-02T00:00:00Z', 2, FALSE, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, currentJson],
      );

      const result = await runRepair({
        pool,
        connectorInstanceId,
        stream,
        recordKey: null,
        limit: null,
        policy: SESSIONS_POLICY,
        apply: false,
      });

      assert.equal(result.previews.length, 1);
      assert.equal(Number(result.previews[0].sourceVersion), 1);
      assert.equal(result.previews[0].merged.message_count, 12);
      assert.equal(result.previews[0].merged.function_call_count, 8);
    });
  });

  test('cross-key isolation: repair never reaches across record_key', async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 4)`,
        [connectorId, connectorInstanceId, stream],
      );
      const aPrior = JSON.stringify({
        id: 'a',
        message_count: 5,
        function_call_count: 3,
      });
      const aCurrent = JSON.stringify({
        id: 'a',
        message_count: null,
        function_call_count: null,
      });
      const bCurrent = JSON.stringify({
        id: 'b',
        message_count: null,
        function_call_count: null,
      });
      await pool.query(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES
           ($1, $2, $3, 'a', 1, $4::jsonb, '2026-05-01T00:00:00Z', FALSE),
           ($1, $2, $3, 'a', 2, $5::jsonb, '2026-05-02T00:00:00Z', FALSE),
           ($1, $2, $3, 'b', 3, $6::jsonb, '2026-05-03T00:00:00Z', FALSE),
           ($1, $2, $3, 'b', 4, $6::jsonb, '2026-05-04T00:00:00Z', FALSE)`,
        [connectorId, connectorInstanceId, stream, aPrior, aCurrent, bCurrent],
      );
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, 'a', $4::jsonb, '2026-05-02T00:00:00Z', 2, FALSE, 'a'),
                ($1, $2, $3, 'b', $5::jsonb, '2026-05-04T00:00:00Z', 4, FALSE, 'b')`,
        [connectorId, connectorInstanceId, stream, aCurrent, bCurrent],
      );

      const result = await runRepair({
        pool,
        connectorInstanceId,
        stream,
        recordKey: null,
        limit: null,
        policy: SESSIONS_POLICY,
        apply: false,
      });

      // Only `a` qualifies: `b` has no prior with non-null derived
      // fields and cannot reach across to `a`'s history.
      assert.equal(result.previews.length, 1);
      assert.equal(result.previews[0].recordKey, 'a');
      assert.equal(Number(result.previews[0].sourceVersion), 1);
    });
  });

  test('mergePayload only writes the refillable fields', () => {
    const merged = mergePayload(
      { id: 'x', message_count: null, function_call_count: null, other: 'keep' },
      { id: 'x', message_count: 7, function_call_count: 4, other: 'overridden' },
      ['message_count', 'function_call_count'],
    );
    assert.deepEqual(merged, {
      id: 'x',
      message_count: 7,
      function_call_count: 4,
      other: 'keep',
    });
  });
}
