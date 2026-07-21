/**
 * Operation-level behavior tests for `rs.records.ingest`.
 *
 * Pins:
 *   - line splitting / non-empty filter and submittedRecordCount.
 *   - invalid_request when connector_id is missing.
 *   - not_found when the manifest does not declare the stream.
 *   - sequential per-line ingest (preserves durable write order; no
 *     parallelism).
 *   - one-line failures are isolated: increment records_rejected, append the
 *     error message, do NOT roll back earlier accepted records, do NOT halt.
 *   - the response envelope shape `{ stream, records_accepted,
 *     records_rejected, errors }`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RecordsIngestInvalidRequestError,
  RecordsIngestNotFoundError,
  executeRecordsIngest,
  parseLines,
} from '../operations/rs-records-ingest/index.ts';

function defaultDeps(overrides = {}) {
  return {
    hasManifestStream: () => true,
    ingestRecord: () => undefined,
    ...overrides,
  };
}

function defaultInput(overrides = {}) {
  return {
    connectorId: 'gmail',
    streamName: 'messages',
    body: '{"id":"r1"}\n{"id":"r2"}',
    ...overrides,
  };
}

test('parseLines splits NDJSON, filters empty lines, returns empty for null/undefined', () => {
  assert.deepEqual(parseLines(null), []);
  assert.deepEqual(parseLines(undefined), []);
  assert.deepEqual(parseLines(''), []);
  assert.deepEqual(parseLines('\n\n'), []);
  assert.deepEqual(parseLines('a\n\nb\n   \n'), ['a', 'b']);
});

test('rs.records.ingest reports submittedRecordCount derived from non-empty lines', async () => {
  const out = await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\n\n{"id":"r2"}\n   ' }),
    defaultDeps(),
  );
  assert.equal(out.submittedRecordCount, 2);
});

test('rs.records.ingest rejects null connector_id with invalid_request', async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({ connectorId: null }),
        defaultDeps(),
      ),
    (err) => {
      assert.ok(err instanceof RecordsIngestInvalidRequestError);
      assert.equal(err.code, 'invalid_request');
      return true;
    },
  );
});

test('rs.records.ingest raises not_found when manifest is missing the stream', async () => {
  await assert.rejects(
    () =>
      executeRecordsIngest(
        defaultInput({ streamName: 'unknown' }),
        defaultDeps({ hasManifestStream: () => false }),
      ),
    (err) => {
      assert.ok(err instanceof RecordsIngestNotFoundError);
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
});

test('rs.records.ingest invokes ingestRecord sequentially in line order', async () => {
  const seen = [];
  await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\n{"id":"r2"}\n{"id":"r3"}' }),
    defaultDeps({
      ingestRecord: async (cid, _cin, record) => {
        seen.push(record.id);
      },
    }),
  );
  assert.deepEqual(seen, ['r1', 'r2', 'r3']);
});

test('rs.records.ingest forwards { ...record, stream } to the dependency', async () => {
  let captured;
  await executeRecordsIngest(
    defaultInput({ connectorInstanceId: 'cin_gmail_work', body: '{"id":"r1","x":1}' }),
    defaultDeps({
      ingestRecord: (cid, cin, record) => {
        captured = { cid, cin, record };
      },
    }),
  );
  assert.equal(captured.cid, 'gmail');
  assert.equal(captured.cin, 'cin_gmail_work');
  assert.deepEqual(captured.record, { id: 'r1', x: 1, stream: 'messages' });
});

test('rs.records.ingest counts accepted vs rejected and collects error messages', async () => {
  const out = await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\nNOT_JSON\n{"id":"r3"}' }),
    defaultDeps({
      ingestRecord: async (cid, _cin, record) => {
        if (record.id === 'r3') throw new Error('store down');
      },
    }),
  );
  assert.equal(out.envelope.records_accepted, 1);
  assert.equal(out.envelope.records_rejected, 2);
  assert.equal(out.envelope.errors.length, 2);
  assert.match(out.envelope.errors[1], /store down/);
});

test('rs.records.ingest envelope echoes the stream name', async () => {
  const out = await executeRecordsIngest(defaultInput(), defaultDeps());
  assert.equal(out.envelope.stream, 'messages');
});

test('rs.records.ingest empty body yields zero counts and no errors', async () => {
  const out = await executeRecordsIngest(defaultInput({ body: '' }), defaultDeps());
  assert.deepEqual(out.envelope, {
    stream: 'messages',
    records_accepted: 0,
    records_rejected: 0,
    errors: [],
  });
  assert.equal(out.submittedRecordCount, 0);
});

test('rs.records.ingest does not halt on a failing line; subsequent lines still ingest', async () => {
  let lateCalled = false;
  const out = await executeRecordsIngest(
    defaultInput({ body: '{"id":"r1"}\n{"id":"r2"}' }),
    defaultDeps({
      ingestRecord: async (cid, _cin, record) => {
        if (record.id === 'r1') throw new Error('first failed');
        lateCalled = true;
      },
    }),
  );
  assert.equal(lateCalled, true, 'second line must still be attempted after first fails');
  assert.equal(out.envelope.records_accepted, 1);
  assert.equal(out.envelope.records_rejected, 1);
});
