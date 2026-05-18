import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '../server/db.js';
import { deleteAllRecordsForConnector, getRecord, ingestRecord, queryRecords } from '../server/records.js';
import { registerConnector } from '../server/auth.js';
import { lexicalIndexBackfillForManifest } from '../server/search.js';
import { buildSemanticSearchPlanForGrant } from '../server/search-semantic.js';

const CONNECTOR_ID = 'https://test.pdpp.org/connectors/instance-records';
const WORK_INSTANCE_ID = 'cin_test_records_work';
const PERSONAL_INSTANCE_ID = 'cin_test_records_personal';
const STREAM = 'messages';

const grant = {
  streams: [{ name: STREAM, fields: ['id', 'subject'] }],
};

const manifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Instance Records',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      schema: {
        type: 'object',
        required: ['id', 'subject'],
        properties: {
          id: { type: 'string' },
          subject: { type: 'string' },
        },
      },
      query: { search: { lexical_fields: ['subject'], semantic_fields: ['subject'] } },
    },
  ],
};

function setup() {
  initDb();
}

function teardown() {
  closeDb();
}

function target(connectorInstanceId) {
  return {
    connector_id: CONNECTOR_ID,
    connector_instance_id: connectorInstanceId,
  };
}

function upsert(subject) {
  return {
    stream: STREAM,
    key: 'same-key',
    data: {
      id: 'same-key',
      subject,
    },
    emitted_at: '2026-05-18T12:00:00.000Z',
  };
}

test('records with the same connector type, stream, and key are isolated by connector instance', async () => {
  setup();
  try {
    await registerConnector(manifest);
    const work = target(WORK_INSTANCE_ID);
    const personal = target(PERSONAL_INSTANCE_ID);

    await ingestRecord(work, upsert('work account'));
    await ingestRecord(personal, upsert('personal account'));
    await ingestRecord(work, upsert('work account updated'));

    const liveRows = getDb()
      .prepare(
        `SELECT connector_instance_id, record_json, version
           FROM records
          WHERE connector_id = ? AND stream = ? AND record_key = ?
          ORDER BY connector_instance_id`
      )
      .all(CONNECTOR_ID, STREAM, 'same-key');

    assert.equal(liveRows.length, 2);
    assert.deepEqual(
      liveRows.map((row) => [row.connector_instance_id, JSON.parse(row.record_json).subject, row.version]),
      [
        [PERSONAL_INSTANCE_ID, 'personal account', 1],
        [WORK_INSTANCE_ID, 'work account updated', 2],
      ],
    );

    const counters = getDb()
      .prepare(
        `SELECT connector_instance_id, max_version
           FROM version_counter
          WHERE connector_id = ? AND stream = ?
          ORDER BY connector_instance_id`
      )
      .all(CONNECTOR_ID, STREAM);

    assert.deepEqual(
      counters.map((row) => [row.connector_instance_id, row.max_version]),
      [
        [PERSONAL_INSTANCE_ID, 1],
        [WORK_INSTANCE_ID, 2],
      ],
    );

    const workChanges = await queryRecords(work, STREAM, grant, { changes_since: 'beginning' }, manifest);
    const personalChanges = await queryRecords(personal, STREAM, grant, { changes_since: 'beginning' }, manifest);

    assert.deepEqual(workChanges.data.map((row) => row.data.subject), ['work account updated']);
    assert.deepEqual(personalChanges.data.map((row) => row.data.subject), ['personal account']);
    assert.notEqual(workChanges.next_changes_since, personalChanges.next_changes_since);

    const workRecord = await getRecord(work, STREAM, 'same-key', grant, manifest);
    const personalRecord = await getRecord(personal, STREAM, 'same-key', grant, manifest);

    assert.equal(workRecord.data.subject, 'work account updated');
    assert.equal(personalRecord.data.subject, 'personal account');

    await lexicalIndexBackfillForManifest({
      manifest: { ...manifest, storage_binding: { connector_instance_id: WORK_INSTANCE_ID } },
    });
    await lexicalIndexBackfillForManifest({
      manifest: { ...manifest, storage_binding: { connector_instance_id: PERSONAL_INSTANCE_ID } },
    });

    const lexicalRows = getDb()
      .prepare(
        `SELECT connector_instance_id, record_key, field, text
          FROM lexical_search_index
          WHERE connector_id = ? AND stream = ? AND record_key = ?
            AND connector_instance_id IN (?, ?)
          ORDER BY connector_instance_id`
      )
      .all(CONNECTOR_ID, STREAM, 'same-key', PERSONAL_INSTANCE_ID, WORK_INSTANCE_ID);

    assert.deepEqual(
      lexicalRows.map((row) => [row.connector_instance_id, row.record_key, row.field, row.text]),
      [
        [PERSONAL_INSTANCE_ID, 'same-key', 'subject', 'personal account'],
        [WORK_INSTANCE_ID, 'same-key', 'subject', 'work account updated'],
      ],
    );

    const lexicalMeta = getDb()
      .prepare(
        `SELECT connector_instance_id, fields_fingerprint
          FROM lexical_search_meta
          WHERE connector_id = ? AND stream = ?
            AND connector_instance_id IN (?, ?)
          ORDER BY connector_instance_id`
      )
      .all(CONNECTOR_ID, STREAM, PERSONAL_INSTANCE_ID, WORK_INSTANCE_ID);

    assert.deepEqual(
      lexicalMeta.map((row) => [row.connector_instance_id, row.fields_fingerprint]),
      [
        [PERSONAL_INSTANCE_ID, '["subject"]'],
        [WORK_INSTANCE_ID, '["subject"]'],
      ],
    );
  } finally {
    teardown();
  }
});

test('semantic candidate planning scans connector instance namespace, not connector type namespace', async () => {
  setup();
  try {
    await registerConnector(manifest);
    const work = target(WORK_INSTANCE_ID);
    const personal = target(PERSONAL_INSTANCE_ID);

    await ingestRecord(work, upsert('work account'));
    await ingestRecord(personal, upsert('personal account'));

    const plan = buildSemanticSearchPlanForGrant({
      manifest,
      grant: {
        streams: [{
          name: STREAM,
          fields: ['id', 'subject'],
          resources: ['same-key'],
          time_range: {
            since: '2026-05-18T00:00:00.000Z',
            until: '2026-05-19T00:00:00.000Z',
          },
        }],
      },
      streamsFilter: null,
      connectorId: CONNECTOR_ID,
      connectorInstanceId: WORK_INSTANCE_ID,
    });

    assert.deepEqual(plan.map((entry) => entry.connectorInstanceId), [WORK_INSTANCE_ID]);
    assert.deepEqual(plan.map((entry) => entry.candidateRecordKeys), [['same-key']]);
  } finally {
    teardown();
  }
});

test('manifest reset cleanup leaves rows outside discovered record instance namespaces intact', async () => {
  setup();
  try {
    await registerConnector(manifest);
    await ingestRecord(target(WORK_INSTANCE_ID), upsert('work account'));

    const db = getDb();
    db.prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES(?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(CONNECTOR_ID, PERSONAL_INSTANCE_ID, STREAM, 'orphan-change', 1, JSON.stringify({ id: 'orphan-change' }), '2026-05-18T12:00:00.000Z');
    db.prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('blob_sha256_' + 'a'.repeat(64), CONNECTOR_ID, PERSONAL_INSTANCE_ID, STREAM, 'orphan-change', 'text/plain', 1, 'a'.repeat(64), Buffer.from('x'));
    db.prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES(?, ?, ?, ?, ?, ?)`
    ).run('blob_sha256_' + 'a'.repeat(64), CONNECTOR_ID, PERSONAL_INSTANCE_ID, STREAM, 'orphan-change', '@record');

    const result = await deleteAllRecordsForConnector(CONNECTOR_ID);

    assert.equal(result.deletedCount, 1);
    assert.deepEqual(result.streams, [STREAM]);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?').get(WORK_INSTANCE_ID).n,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM record_changes WHERE connector_instance_id = ?').get(PERSONAL_INSTANCE_ID).n,
      1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM blob_bindings WHERE connector_instance_id = ?').get(PERSONAL_INSTANCE_ID).n,
      1,
    );
  } finally {
    teardown();
  }
});
