// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reset-safe record-source checkpoint: `connector_instances.record_reset_generation`.
 *
 * Pins the ABA-safety union rule from
 * `openspec/changes/reconcile-active-summary-evidence/design.md`
 * ("Exact reset-safe record checkpoint"): a supported stream or
 * connector-wide reset advances the generation by the count of distinct
 * stream namespaces whose PRE-RESET state held a `version_counter` row OR a
 * live canonical record — the union covers a stream whose counter was
 * already lost but still has live records (recoverable counter drift). A
 * reset that touches neither input for any candidate stream is a checkpoint
 * no-op. Both backends must agree exactly.
 *
 * Falsifiability: dropping the union's live-record probe (checking only
 * `version_counter`) makes the counterless-live-record case fail to advance;
 * dropping the no-op guard makes the neither-input case advance by 0-but-write
 * an UPDATE regardless (still passes value assertions, but the point of the
 * guard is avoiding an unconditional write — covered by the exact-count
 * assertions here rather than a write-count spy).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeDb, getDb, initDb } from '../server/db.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import { deleteAllRecords, deleteAllRecordsForConnector, ingestRecord } from '../server/records.js';
import { canonicalConnectorKey } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const OWNER_SUBJECT_ID = 'owner_local';
const NOW = '2026-07-17T00:00:00.000Z';
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const SPOTIFY_MANIFEST = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests', 'spotify.json'), 'utf8'));
const SPOTIFY_CONNECTOR_KEY = canonicalConnectorKey(SPOTIFY_MANIFEST.connector_id);
const SPOTIFY_STREAM = SPOTIFY_MANIFEST.streams[0].name;
const SECOND_STREAM = SPOTIFY_MANIFEST.streams[1]?.name ?? 'saved_tracks';

function seedInstanceSqlite({ connectorInstanceId, displayName = 'Spotify source' }) {
  getDb()
    .prepare('INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(SPOTIFY_CONNECTOR_KEY, JSON.stringify(SPOTIFY_MANIFEST), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(connectorInstanceId, OWNER_SUBJECT_ID, SPOTIFY_CONNECTOR_KEY, displayName, connectorInstanceId, NOW, NOW);
}

function storageTargetFor(connectorInstanceId) {
  return { connector_id: SPOTIFY_CONNECTOR_KEY, connector_instance_id: connectorInstanceId };
}

function readGenerationSqlite(connectorInstanceId) {
  const row = getDb()
    .prepare('SELECT record_reset_generation FROM connector_instances WHERE connector_instance_id = ?')
    .get(connectorInstanceId);
  return Number(row.record_reset_generation);
}

test('per-stream reset advances the generation by 1 when a version_counter row exists', async () => {
  initDb();
  try {
    const instanceId = 'cin_reset_gen_counter';
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    await ingestRecord(storageTargetFor(instanceId), {
      stream: SPOTIFY_STREAM,
      key: 'rec_1',
      data: { id: 'rec_1' },
      emitted_at: NOW,
    });
    assert.equal(readGenerationSqlite(instanceId), 0, 'generation starts at zero');

    await deleteAllRecords(storageTargetFor(instanceId), SPOTIFY_STREAM);

    assert.equal(readGenerationSqlite(instanceId), 1, 'reset with a live counter row advances by exactly 1');
  } finally {
    closeDb();
  }
});

test('per-stream reset advances the generation for a counterless live record (ABA-safety union rule)', async () => {
  initDb();
  try {
    const instanceId = 'cin_reset_gen_counterless';
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    // Directly construct a live canonical record with NO version_counter row —
    // the exact recoverable-drift shape the union rule exists to cover.
    getDb()
      .prepare(
        `INSERT INTO records(
           connector_id, connector_instance_id, stream, record_key, record_json,
           emitted_at, semantic_time, version, deleted
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`,
      )
      .run(
        SPOTIFY_CONNECTOR_KEY,
        instanceId,
        SPOTIFY_STREAM,
        'rec_orphaned',
        JSON.stringify({ id: 'rec_orphaned' }),
        NOW,
        NOW,
      );
    const counterRow = getDb()
      .prepare('SELECT 1 FROM version_counter WHERE connector_instance_id = ? AND stream = ?')
      .get(instanceId, SPOTIFY_STREAM);
    assert.equal(counterRow, undefined, 'fixture precondition: no counter row exists');

    await deleteAllRecords(storageTargetFor(instanceId), SPOTIFY_STREAM);

    assert.equal(
      readGenerationSqlite(instanceId),
      1,
      'a counterless live record still advances the generation (union rule)',
    );
  } finally {
    closeDb();
  }
});

test('reset with neither a counter nor a live record is a checkpoint no-op', async () => {
  initDb();
  try {
    const instanceId = 'cin_reset_gen_noop';
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    assert.equal(readGenerationSqlite(instanceId), 0);

    await deleteAllRecords(storageTargetFor(instanceId), SPOTIFY_STREAM);

    assert.equal(readGenerationSqlite(instanceId), 0, 'a reset touching no input is a checkpoint no-op');
  } finally {
    closeDb();
  }
});

test('connector-wide reset sums the generation over every touched stream namespace', async () => {
  initDb();
  try {
    const instanceId = 'cin_reset_gen_connector_wide';
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    await ingestRecord(storageTargetFor(instanceId), {
      stream: SPOTIFY_STREAM,
      key: 'rec_1',
      data: { id: 'rec_1' },
      emitted_at: NOW,
    });
    await ingestRecord(storageTargetFor(instanceId), {
      stream: SECOND_STREAM,
      key: 'rec_2',
      data: { id: 'rec_2' },
      emitted_at: NOW,
    });
    assert.equal(readGenerationSqlite(instanceId), 0);

    await deleteAllRecordsForConnector(SPOTIFY_CONNECTOR_KEY);

    assert.equal(
      readGenerationSqlite(instanceId),
      2,
      'connector-wide reset advances once per distinct touched stream namespace',
    );
  } finally {
    closeDb();
  }
});

test(
  'connector-wide reset discovers and clears a counter-only namespace (Sol third-verdict P2.2): a stream with ONLY a version_counter row and no live records is not silently skipped',
  async () => {
    initDb();
    try {
      const instanceId = 'cin_reset_gen_counter_only';
      seedInstanceSqlite({ connectorInstanceId: instanceId });
      // Directly seed a version_counter row with ZERO live canonical
      // records for the stream — the exact counter-only namespace Sol's
      // verdict reproduced ("a live connection with ONLY version_counter
      // ... and no records"). A real ingest+deleteAllRecords round-trip
      // does NOT reproduce this state: deleteAllRecords already clears
      // version_counter for the stream it targets (see
      // deleteAllRecordsWithinCoordinator), so this fixture models the
      // genuine drift case directly — a counter that survives some other
      // path without a corresponding live record ever landing through the
      // normal ingest flow this test can drive.
      getDb()
        .prepare(
          'INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version) VALUES (?, ?, ?, ?)',
        )
        .run(SPOTIFY_CONNECTOR_KEY, instanceId, SPOTIFY_STREAM, 1);
      const counterBefore = getDb()
        .prepare('SELECT max_version FROM version_counter WHERE connector_instance_id = ? AND stream = ?')
        .get(instanceId, SPOTIFY_STREAM);
      assert.ok(counterBefore, 'fixture: the version_counter row genuinely survives a per-stream record delete');
      assert.equal(counterBefore.max_version, 1);
      const liveRecordCount = getDb()
        .prepare(
          'SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ? AND stream = ? AND deleted = 0',
        )
        .get(instanceId, SPOTIFY_STREAM).n;
      assert.equal(liveRecordCount, 0, 'fixture: genuinely zero live records for this stream');
      const generationBeforeConnectorReset = readGenerationSqlite(instanceId);

      const result = await deleteAllRecordsForConnector(SPOTIFY_CONNECTOR_KEY);

      assert.ok(
        result.streams.includes(SPOTIFY_STREAM),
        'the counter-only stream must be discovered and reported, not silently invisible to the connector-wide reset',
      );
      const counterAfter = getDb()
        .prepare('SELECT max_version FROM version_counter WHERE connector_instance_id = ? AND stream = ?')
        .get(instanceId, SPOTIFY_STREAM);
      assert.equal(counterAfter, undefined, 'the counter-only namespace\'s version_counter row must actually be deleted');
      assert.equal(
        readGenerationSqlite(instanceId),
        generationBeforeConnectorReset + 1,
        'record_reset_generation advances for the counter-only stream — before this fix it stayed unchanged (silently skipped)',
      );
    } finally {
      closeDb();
    }
  },
);

test('reinsertion after reset can never reproduce the earlier composite checkpoint (ABA)', async () => {
  initDb();
  try {
    const instanceId = 'cin_reset_gen_aba';
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    await ingestRecord(storageTargetFor(instanceId), {
      stream: SPOTIFY_STREAM,
      key: 'rec_1',
      data: { id: 'rec_1' },
      emitted_at: NOW,
    });
    const counterBefore = getDb()
      .prepare('SELECT max_version FROM version_counter WHERE connector_instance_id = ? AND stream = ?')
      .get(instanceId, SPOTIFY_STREAM);
    const generationBefore = readGenerationSqlite(instanceId);

    await deleteAllRecords(storageTargetFor(instanceId), SPOTIFY_STREAM);
    await ingestRecord(storageTargetFor(instanceId), {
      stream: SPOTIFY_STREAM,
      key: 'rec_1_reinserted',
      data: { id: 'rec_1_reinserted' },
      emitted_at: NOW,
    });
    const counterAfter = getDb()
      .prepare('SELECT max_version FROM version_counter WHERE connector_instance_id = ? AND stream = ?')
      .get(instanceId, SPOTIFY_STREAM);
    const generationAfter = readGenerationSqlite(instanceId);

    // The bare version vector CAN reproduce identically (both start a fresh
    // counter at version 1) — that is the exact ABA collision the composite
    // checkpoint exists to prevent. The generation component must differ.
    assert.equal(counterBefore.max_version, counterAfter.max_version, 'fixture: bare version vector DOES collide');
    assert.notEqual(
      generationBefore,
      generationAfter,
      'the reset_generation component makes the composite checkpoint differ despite the colliding version vector',
    );
  } finally {
    closeDb();
  }
});

test(
  'real disposable PostgreSQL reset-generation matches the SQLite union-rule contract',
  { skip: !POSTGRES_URL },
  async () => {
    const connectorId = SPOTIFY_CONNECTOR_KEY;
    const instanceId = 'cin_reset_gen_pg';
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await postgresQuery('DELETE FROM connector_instances WHERE connector_instance_id = $1', [instanceId]);
      await postgresQuery(
        `INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)
           ON CONFLICT (connector_id) DO NOTHING`,
        [connectorId, JSON.stringify(SPOTIFY_MANIFEST), NOW],
      );
      await postgresQuery(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
        [instanceId, OWNER_SUBJECT_ID, connectorId, 'Spotify source', NOW],
      );
      // Counterless live record, same ABA-safety fixture shape as the SQLite case.
      await postgresQuery(
        `INSERT INTO records(
           connector_id, connector_instance_id, stream, record_key, record_json,
           emitted_at, semantic_time, version, deleted, primary_key_text
         ) VALUES($1, $2, $3, $4, $5::jsonb, $6, $6, 1, FALSE, $4)`,
        [connectorId, instanceId, SPOTIFY_STREAM, 'rec_orphaned', JSON.stringify({ id: 'rec_orphaned' }), NOW],
      );

      await deleteAllRecords({ connector_id: connectorId, connector_instance_id: instanceId }, SPOTIFY_STREAM);

      const result = await postgresQuery(
        'SELECT record_reset_generation FROM connector_instances WHERE connector_instance_id = $1',
        [instanceId],
      );
      assert.equal(
        Number(result.rows[0]?.record_reset_generation),
        1,
        'PostgreSQL advances the generation for a counterless live record exactly like SQLite',
      );
    } finally {
      await postgresQuery('DELETE FROM connector_instances WHERE connector_instance_id = $1', [instanceId]);
      await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
    }
  },
);

test(
  'real disposable PostgreSQL: connector-wide reset discovers and clears a counter-only namespace on production connector invalidation (Sol third-verdict P2.2)',
  { skip: !POSTGRES_URL },
  async () => {
    const connectorId = SPOTIFY_CONNECTOR_KEY;
    const instanceId = 'cin_reset_gen_counter_only_pg';
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await postgresQuery('DELETE FROM connector_instances WHERE connector_instance_id = $1', [instanceId]);
      await postgresQuery(
        `INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)
           ON CONFLICT (connector_id) DO NOTHING`,
        [connectorId, JSON.stringify(SPOTIFY_MANIFEST), NOW],
      );
      await postgresQuery(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
        [instanceId, OWNER_SUBJECT_ID, connectorId, 'Spotify source', NOW],
      );
      // A live version_counter row with ZERO records/record_changes/
      // blob_bindings for the stream — the exact counter-only namespace
      // Sol's verdict reproduced on SQLite, proven here on real PostgreSQL.
      await postgresQuery(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 1)`,
        [connectorId, instanceId, SPOTIFY_STREAM],
      );
      const generationBefore = Number(
        (
          await postgresQuery('SELECT record_reset_generation FROM connector_instances WHERE connector_instance_id = $1', [
            instanceId,
          ])
        ).rows[0]?.record_reset_generation,
      );

      const result = await deleteAllRecordsForConnector(connectorId);

      assert.ok(
        result.streams.includes(SPOTIFY_STREAM),
        'the counter-only stream must be discovered and reported on real PostgreSQL, not silently invisible',
      );
      const counterAfter = (
        await postgresQuery('SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2', [
          instanceId,
          SPOTIFY_STREAM,
        ])
      ).rows[0];
      assert.equal(counterAfter, undefined, 'the counter-only namespace\'s version_counter row must actually be deleted');
      const generationAfter = Number(
        (
          await postgresQuery('SELECT record_reset_generation FROM connector_instances WHERE connector_instance_id = $1', [
            instanceId,
          ])
        ).rows[0]?.record_reset_generation,
      );
      assert.equal(
        generationAfter,
        generationBefore + 1,
        'record_reset_generation advances for the counter-only stream on real PostgreSQL — before this fix it stayed unchanged',
      );
    } finally {
      await postgresQuery('DELETE FROM version_counter WHERE connector_instance_id = $1', [instanceId]);
      await postgresQuery('DELETE FROM connector_instances WHERE connector_instance_id = $1', [instanceId]);
      await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
    }
  },
);
