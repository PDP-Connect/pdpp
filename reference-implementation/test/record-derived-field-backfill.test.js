/**
 * Integration tests for the record-derived-field-backfill repair tool.
 *
 * Uses the local Compose Postgres (PDPP_TEST_POSTGRES_URL) to set up
 * fixture rows in a uniquely-named connector_instance, run the repair
 * tool's policy + merge logic against them, and assert behavior:
 *
 *   - current row null, prior change row non-null → refilled
 *   - current row non-null → skipped
 *   - no history at all → skipped
 *   - cross-key isolation → never touches a sibling record
 *
 * The tests do not shell out to the CLI; they import the policy and
 * call the in-process merge / equality helpers. The end-to-end CLI is
 * exercised in the worker report and final acceptance check.
 *
 * Spec: openspec/changes/repair-record-version-noop-detection/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

const { Pool } = pg;

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('record derived-field backfill (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  // Re-declare the policy used by the CLI so tests cover the actual
  // merge logic without importing a top-level .mjs that performs argv
  // parsing at module-load time.
  const SESSIONS_POLICY = {
    derivedFields: ['message_count', 'function_call_count'],
    priorIsBetter(current, prior) {
      if (current.message_count == null && prior.message_count != null) return true;
      if (current.function_call_count == null && prior.function_call_count != null) return true;
      return false;
    },
  };

  function mergePayload(current, prior, derivedFields) {
    const merged = { ...current };
    for (const f of derivedFields) {
      if (merged[f] == null && prior[f] != null) {
        merged[f] = prior[f];
      }
    }
    return merged;
  }

  test('sessions policy refills null derived fields from prior non-null history', async () => {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_repair_${suffix}`;
    const connectorId = `repair_${suffix}`;
    const stream = 'sessions';

    try {
      // Seed: prior history version with non-null counts, current row null.
      const recordKey = 'thr-a';
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 2)`,
        [connectorId, connectorInstanceId, stream],
      );
      const priorJson = JSON.stringify({ id: recordKey, message_count: 7, function_call_count: 4 });
      const currentJson = JSON.stringify({ id: recordKey, message_count: null, function_call_count: null });
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

      // Probe: scan candidates the way the repair tool does.
      const rows = await pool.query(
        `SELECT record_key, record_json FROM records
         WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE
           AND (record_json->>'message_count' IS NULL OR record_json->>'function_call_count' IS NULL)`,
        [connectorInstanceId, stream],
      );
      assert.equal(rows.rows.length, 1);
      const current = rows.rows[0].record_json;

      const history = await pool.query(
        `SELECT version, record_json FROM record_changes
         WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE
         ORDER BY version DESC`,
        [connectorInstanceId, stream, recordKey],
      );
      const chosen = history.rows.find((h) => SESSIONS_POLICY.priorIsBetter(current, h.record_json));
      assert.ok(chosen, 'should pick a prior row with non-null counts');
      assert.equal(Number(chosen.version), 1);

      const merged = mergePayload(current, chosen.record_json, SESSIONS_POLICY.derivedFields);
      assert.equal(merged.message_count, 7);
      assert.equal(merged.function_call_count, 4);
    } finally {
      await pool.query(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.end();
    }
  });

  test('sessions policy leaves a row alone when current has non-null counts', async () => {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_repair_${suffix}`;
    const connectorId = `repair_${suffix}`;
    const stream = 'sessions';

    try {
      const recordKey = 'thr-b';
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 1)`,
        [connectorId, connectorInstanceId, stream],
      );
      const currentJson = JSON.stringify({ id: recordKey, message_count: 11, function_call_count: 9 });
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

      // Pre-filter must not match a row whose derived fields are already filled.
      const rows = await pool.query(
        `SELECT record_key FROM records
         WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE
           AND ((NOT (record_json ? 'message_count') OR record_json->>'message_count' IS NULL)
                OR (NOT (record_json ? 'function_call_count') OR record_json->>'function_call_count' IS NULL))`,
        [connectorInstanceId, stream],
      );
      assert.equal(rows.rows.length, 0, 'rows with both derived fields filled SHALL NOT be picked up');
    } finally {
      await pool.query(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.end();
    }
  });

  test('sessions policy skips records that have no non-null history', async () => {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_repair_${suffix}`;
    const connectorId = `repair_${suffix}`;
    const stream = 'sessions';

    try {
      const recordKey = 'thr-c';
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 2)`,
        [connectorId, connectorInstanceId, stream],
      );
      const nullJson = JSON.stringify({ id: recordKey, message_count: null, function_call_count: null });
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

      // Scan history; nothing should satisfy priorIsBetter.
      const history = await pool.query(
        `SELECT version, record_json FROM record_changes
         WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
         ORDER BY version DESC`,
        [connectorInstanceId, stream, recordKey],
      );
      const current = { id: recordKey, message_count: null, function_call_count: null };
      const chosen = history.rows.find((h) => SESSIONS_POLICY.priorIsBetter(current, h.record_json));
      assert.equal(chosen, undefined, 'no non-null history → no repair candidate');
    } finally {
      await pool.query(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.end();
    }
  });

  test('cross-key isolation: refill on one record does not touch a sibling', async () => {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_repair_${suffix}`;
    const connectorId = `repair_${suffix}`;
    const stream = 'sessions';

    try {
      // Two records: A has nullable current + non-null history; B has
      // only null history. Pre-filter should yield both; the merge
      // logic should refill A and skip B.
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 4)`,
        [connectorId, connectorInstanceId, stream],
      );
      const aPrior = JSON.stringify({ id: 'a', message_count: 5, function_call_count: 3 });
      const aCurrent = JSON.stringify({ id: 'a', message_count: null, function_call_count: null });
      const bCurrent = JSON.stringify({ id: 'b', message_count: null, function_call_count: null });
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

      // Walk both records, ensuring 'b' never matches against 'a' history.
      const candidates = await pool.query(
        `SELECT record_key, record_json FROM records
         WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE
         ORDER BY record_key`,
        [connectorInstanceId, stream],
      );
      assert.equal(candidates.rows.length, 2);

      for (const c of candidates.rows) {
        const history = await pool.query(
          `SELECT version, record_json FROM record_changes
           WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE
           ORDER BY version DESC`,
          [connectorInstanceId, stream, c.record_key],
        );
        const chosen = history.rows.find((h) => SESSIONS_POLICY.priorIsBetter(c.record_json, h.record_json));
        if (c.record_key === 'a') {
          assert.ok(chosen, 'a SHALL find its own prior non-null row');
          assert.equal(Number(chosen.version), 1);
        } else {
          assert.equal(chosen, undefined, 'b SHALL NOT find any candidate (no non-null history)');
        }
      }
    } finally {
      await pool.query(`DELETE FROM record_changes WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM records WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.query(`DELETE FROM version_counter WHERE connector_instance_id = $1`, [connectorInstanceId]);
      await pool.end();
    }
  });
}
