/**
 * Reset-safe record-source checkpoint normalization + read.
 *
 * Pins the exact composite shape from
 * `openspec/changes/reconcile-active-summary-evidence/design.md`
 * ("Exact reset-safe record checkpoint"): unsigned base-10 strings with no
 * leading zeros, `streams` sorted by UTF-8 BYTE order (not JS UTF-16 code
 * unit order — these disagree for codepoints outside the BMP), and no
 * precision loss beyond `2^53 - 1` because every value crosses the
 * boundary as decimal text, never a JS `Number`.
 *
 * Falsifiability: sorting `streams` with plain `.sort()` (UTF-16 order)
 * instead of UTF-8 byte order would flip the astral-codepoint ordering
 * case; reading `max_version`/`reset_generation` through a JS `Number`
 * cast anywhere in the pipeline would corrupt the >2^53-1 fixture value
 * silently (JS doubles cannot represent it exactly).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeDb, getDb, initDb } from '../server/db.js';
import { deleteAllRecords, ingestRecord } from '../server/records.js';
import { canonicalConnectorKey } from '../server/connector-key.js';
import {
  normalizeRecordSourceCheckpoint,
  readRecordSourceCheckpoint,
  recordSourceCheckpointsEqual,
} from '../server/record-source-checkpoint.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const OWNER_SUBJECT_ID = 'owner_local';
const NOW = '2026-07-17T00:00:00.000Z';

const SPOTIFY_MANIFEST = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests', 'spotify.json'), 'utf8'));
const SPOTIFY_CONNECTOR_KEY = canonicalConnectorKey(SPOTIFY_MANIFEST.connector_id);
const SPOTIFY_STREAM = SPOTIFY_MANIFEST.streams[0].name;

function seedInstanceSqlite({ connectorInstanceId }) {
  getDb()
    .prepare('INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(SPOTIFY_CONNECTOR_KEY, JSON.stringify(SPOTIFY_MANIFEST), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, 'Spotify source', 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(connectorInstanceId, OWNER_SUBJECT_ID, SPOTIFY_CONNECTOR_KEY, connectorInstanceId, NOW, NOW);
}

function storageTargetFor(connectorInstanceId) {
  return { connector_id: SPOTIFY_CONNECTOR_KEY, connector_instance_id: connectorInstanceId };
}

test('normalization strips leading zeros without numeric coercion', () => {
  const checkpoint = normalizeRecordSourceCheckpoint({
    resetGeneration: '007',
    streams: [{ stream: 'messages', maxVersion: '00042' }],
  });
  assert.equal(checkpoint.reset_generation, '7');
  assert.equal(checkpoint.streams[0].max_version, '42');
});

test('normalization preserves a value beyond Number.MAX_SAFE_INTEGER exactly', () => {
  const beyondSafeInteger = '9007199254740993'; // 2^53 + 1
  const checkpoint = normalizeRecordSourceCheckpoint({
    resetGeneration: beyondSafeInteger,
    streams: [{ stream: 'messages', maxVersion: beyondSafeInteger }],
  });
  assert.equal(checkpoint.reset_generation, beyondSafeInteger, 'generation string is byte-exact, not Number-rounded');
  assert.equal(checkpoint.streams[0].max_version, beyondSafeInteger);
  assert.notEqual(
    String(Number(beyondSafeInteger)),
    beyondSafeInteger,
    'fixture: this value truly cannot round-trip through a JS Number cast',
  );
});

test('streams sort by UTF-8 byte order, not JS UTF-16 code unit order', () => {
  // A supplementary-plane character (U+10000, a surrogate pair in UTF-16,
  // 4-byte lead 0xF0 in UTF-8) versus a BMP character whose code unit sits
  // in the 0xE000-0xFFFF range (3-byte lead 0xEE in UTF-8). JS UTF-16
  // string comparison sorts by code UNIT, and a surrogate pair's leading
  // unit (0xD800-0xDBFF) is numerically LOWER than 0xE000-0xFFFF, so plain
  // `.sort()` places the astral character FIRST. UTF-8 byte comparison
  // sorts the other way: 0xEE < 0xF0, so the BMP character comes first.
  // This is the exact, provable divergence the spec's "UTF-8 byte sequence"
  // requirement exists to pin down.
  const astral = String.fromCodePoint(0x10000);
  const bmpHigh = String.fromCharCode(0xe000);
  assert.equal([astral, bmpHigh].sort()[0], astral, 'fixture: plain JS string sort puts the astral character first');

  const checkpoint = normalizeRecordSourceCheckpoint({
    resetGeneration: '0',
    streams: [
      { stream: astral, maxVersion: '1' },
      { stream: bmpHigh, maxVersion: '2' },
    ],
  });

  assert.deepEqual(
    checkpoint.streams.map((entry) => entry.stream),
    [bmpHigh, astral],
    'UTF-8 byte order puts the BMP character first — the opposite of plain JS string sort',
  );
});

test('recordSourceCheckpointsEqual compares by exact string value in sorted position', () => {
  const a = normalizeRecordSourceCheckpoint({
    resetGeneration: '1',
    streams: [{ stream: 'messages', maxVersion: '5' }],
  });
  const bSame = normalizeRecordSourceCheckpoint({
    resetGeneration: '01',
    streams: [{ stream: 'messages', maxVersion: '05' }],
  });
  const bDifferentGeneration = normalizeRecordSourceCheckpoint({
    resetGeneration: '2',
    streams: [{ stream: 'messages', maxVersion: '5' }],
  });
  assert.equal(recordSourceCheckpointsEqual(a, bSame), true, 'leading-zero-equivalent checkpoints compare equal');
  assert.equal(recordSourceCheckpointsEqual(a, bDifferentGeneration), false);
});

test('a reset advances the read checkpoint even though the bare version vector can collide', async () => {
  initDb();
  try {
    const instanceId = 'cin_checkpoint_read_reset';
    seedInstanceSqlite({ connectorInstanceId: instanceId });
    await ingestRecord(storageTargetFor(instanceId), {
      stream: SPOTIFY_STREAM,
      key: 'rec_1',
      data: { id: 'rec_1' },
      emitted_at: NOW,
    });
    const before = await readRecordSourceCheckpoint(instanceId);

    await deleteAllRecords(storageTargetFor(instanceId), SPOTIFY_STREAM);
    await ingestRecord(storageTargetFor(instanceId), {
      stream: SPOTIFY_STREAM,
      key: 'rec_1_reinserted',
      data: { id: 'rec_1_reinserted' },
      emitted_at: NOW,
    });
    const after = await readRecordSourceCheckpoint(instanceId);

    assert.equal(recordSourceCheckpointsEqual(before, after), false, 'checkpoint differs across the reset despite a colliding version vector');
    assert.notEqual(before.reset_generation, after.reset_generation);
  } finally {
    closeDb();
  }
});
