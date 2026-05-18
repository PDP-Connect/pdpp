import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '../server/db.js';
import { getRecord, ingestRecord, queryRecords } from '../server/records.js';

const CONNECTOR_ID = 'https://test.pdpp.org/connectors/instance-records';
const WORK_INSTANCE_ID = 'cin_test_records_work';
const PERSONAL_INSTANCE_ID = 'cin_test_records_personal';
const STREAM = 'messages';

const grant = {
  streams: [{ name: STREAM, fields: ['id', 'subject'] }],
};

const manifest = {
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
  } finally {
    teardown();
  }
});
