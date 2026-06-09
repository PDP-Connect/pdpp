/**
 * Operation-level tests for `rs.records.get`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that:
 *   - the dependency record flows through `decorateRecord` to the output;
 *   - the source descriptor flows from the dependency to the output;
 *   - `query.received`-shaped data is `query_shape: 'record_detail'` with
 *     the requested record id and fixed `has_changes_since: false` /
 *     `limit: null`;
 *   - `disclosure.served`-shaped data is populated with `record_count: 1`
 *     and `requested_record_id`;
 *   - owner actors receive an owner read-grant scoped to the stream;
 *   - `getRecord` is called with the resolved manifest and grant;
 *   - a null `getRecord` result raises `not_found`.
 *
 * Host-mounted parity is covered by `pdpp.test.js` (native) and the
 * sandbox `_demo/routes.test.ts` suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RecordDetailVisibilityError,
  executeRecordDetail,
} from '../operations/rs-records-detail/index.ts';

const ownerActor = { kind: 'owner', subject_id: 'subj_1' };
const clientActor = {
  kind: 'client',
  subject_id: 'subj_1',
  client_id: 'client_x',
  grant_id: 'grant_y',
};
const sourceDescriptor = { kind: 'connector', id: 'acme_payroll' };

function makeDeps(overrides = {}) {
  return {
    getSourceDescriptor: () => sourceDescriptor,
    getManifest: () => ({ streams: [{ name: 'pay_statements' }] }),
    getGrant: () => ({ streams: [{ name: 'pay_statements' }] }),
    getRecord: (stream, recordId) =>
      Promise.resolve({ object: 'record', id: recordId, stream }),
    decorateRecord: (record) => record,
    ...overrides,
  };
}

test('rs.records.get returns the dependency record for owner shape', async () => {
  const result = await executeRecordDetail(
    {
      actor: ownerActor,
      streamName: 'pay_statements',
      recordId: 'rec_1',
    },
    makeDeps(),
  );
  assert.equal(result.record.object, 'record');
  assert.equal(result.record.id, 'rec_1');
  assert.equal(result.record.stream, 'pay_statements');
  assert.deepEqual(result.sourceDescriptor, sourceDescriptor);
  assert.deepEqual(result.queryData, {
    query_shape: 'record_detail',
    requested_record_id: 'rec_1',
    has_changes_since: false,
    limit: null,
  });
  assert.deepEqual(result.disclosureData, {
    query_shape: 'record_detail',
    record_count: 1,
    has_more: false,
    has_next_changes_since: false,
    requested_record_id: 'rec_1',
  });
  // Owner branch builds an owner read-grant scoped to the requested stream.
  assert.deepEqual(result.effectiveGrant, { streams: [{ name: 'pay_statements' }] });
});

test('rs.records.get throws not_found when the dependency returns null', async () => {
  await assert.rejects(
    () =>
      executeRecordDetail(
        {
          actor: ownerActor,
          streamName: 'pay_statements',
          recordId: 'missing',
        },
        makeDeps({ getRecord: () => Promise.resolve(null) }),
      ),
    (err) => {
      assert.ok(err instanceof RecordDetailVisibilityError);
      assert.equal(err.code, 'not_found');
      assert.match(err.message, /'missing'/);
      assert.match(err.message, /'pay_statements'/);
      return true;
    },
  );
});

test('rs.records.get does not call decorateRecord when the dependency returns null', async () => {
  let decorated = false;
  await assert.rejects(() =>
    executeRecordDetail(
      { actor: ownerActor, streamName: 'pay_statements', recordId: 'missing' },
      makeDeps({
        getRecord: () => Promise.resolve(null),
        decorateRecord: (record) => {
          decorated = true;
          return record;
        },
      }),
    ),
  );
  assert.equal(decorated, false);
});

test('rs.records.get applies decorateRecord to the returned record', async () => {
  const result = await executeRecordDetail(
    { actor: ownerActor, streamName: 'pay_statements', recordId: 'rec_1' },
    makeDeps({
      decorateRecord: (record) => ({ ...record, decorated: true }),
    }),
  );
  assert.equal(result.record.decorated, true);
});

test('rs.records.get applies request projection after lower driver returns full payload', async () => {
  const result = await executeRecordDetail(
    {
      actor: ownerActor,
      streamName: 'pay_statements',
      recordId: 'rec_1',
      expandOptions: { fields: ['id'] },
    },
    makeDeps({
      getRecord: () =>
        Promise.resolve({
          object: 'record',
          id: 'rec_1',
          data: {
            id: 'rec_1',
            channel_id: 'C1',
            ts: '123.456',
            text: 'unrequested',
          },
        }),
    }),
  );

  assert.deepEqual(result.record.data, { id: 'rec_1' });
});

test('rs.records.get forwards expand options to the dependency', async () => {
  let observed = null;
  await executeRecordDetail(
    {
      actor: ownerActor,
      streamName: 'pay_statements',
      recordId: 'rec_1',
      expandOptions: { expand: 'related_grants', expand_limit: '10' },
    },
    makeDeps({
      getRecord: (_stream, _id, _grant, _manifest, options) => {
        observed = options;
        return Promise.resolve({ object: 'record', id: 'rec_1' });
      },
    }),
  );
  assert.equal(observed?.expand, 'related_grants');
  assert.equal(observed?.expand_limit, '10');
});

test('rs.records.get passes the manifest and grant to the dependency', async () => {
  const manifest = { streams: [{ name: 'pay_statements', extra: 'value' }] };
  let observedManifest = null;
  let observedGrant = null;
  await executeRecordDetail(
    { actor: clientActor, streamName: 'pay_statements', recordId: 'rec_1' },
    makeDeps({
      getManifest: () => manifest,
      getGrant: () => ({ streams: [{ name: 'pay_statements', fields: ['id'] }] }),
      getRecord: (_stream, _id, grant, m) => {
        observedManifest = m;
        observedGrant = grant;
        return Promise.resolve({ object: 'record', id: 'rec_1' });
      },
    }),
  );
  assert.deepEqual(observedManifest, manifest);
  assert.deepEqual(observedGrant, { streams: [{ name: 'pay_statements', fields: ['id'] }] });
});

test('rs.records.get does not overwrite the grant for client actors', async () => {
  const result = await executeRecordDetail(
    { actor: clientActor, streamName: 'pay_statements', recordId: 'rec_1' },
    makeDeps({
      getGrant: () => ({ streams: [{ name: 'pay_statements', fields: ['employer'] }] }),
    }),
  );
  assert.deepEqual(result.effectiveGrant, {
    streams: [{ name: 'pay_statements', fields: ['employer'] }],
  });
});

test('rs.records.get awaits async dependency promises', async () => {
  let resolved = false;
  const result = await executeRecordDetail(
    { actor: ownerActor, streamName: 'pay_statements', recordId: 'rec_1' },
    makeDeps({
      getRecord: (stream, recordId) =>
        new Promise((r) =>
          setImmediate(() => {
            resolved = true;
            r({ object: 'record', id: recordId, stream });
          }),
        ),
    }),
  );
  assert.equal(resolved, true);
  assert.equal(result.record.id, 'rec_1');
});
