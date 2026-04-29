/**
 * Operation-level tests for `rs.records.list`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that the host-independent slice of behavior moved into the operation is
 * preserved:
 *   - the result envelope flows from the dependency's `queryRecords` result;
 *   - the source descriptor flows from the dependency to the output;
 *   - `query.received`-shaped data is `query_shape: 'record_list'` and
 *     surfaces `requested_view`, `has_changes_since`, and `limit`;
 *   - `disclosure.served`-shaped data is populated from the result counts;
 *   - owner manifest visibility raises `not_found`;
 *   - view/fields mutual exclusion raises `invalid_request`;
 *   - view → fields resolution sets `requestParams.fields` and clears
 *     `requestParams.view`;
 *   - a view referencing ungranted fields raises `field_not_granted`;
 *   - `decorateRecord` is applied to every returned record;
 *   - `validateRequestFields` is called with the resolved manifest stream.
 *
 * Host-mounted parity is covered by `pdpp.test.js` (native) and the
 * sandbox `_demo/routes.test.ts` suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RecordsListVisibilityError,
  executeRecordsList,
} from '../operations/rs-records-list/index.ts';

const ownerActor = { kind: 'owner', subject_id: 'subj_1' };
const clientActor = {
  kind: 'client',
  subject_id: 'subj_1',
  client_id: 'client_x',
  grant_id: 'grant_y',
};
const sourceDescriptor = { binding_kind: 'connector', connector_id: 'acme_payroll' };

function makeManifest(extra = {}) {
  return {
    streams: [
      {
        name: 'pay_statements',
        schema: { properties: { net_pay_minor: {}, gross_pay_minor: {}, employer: {} } },
        views: [
          { id: 'compact', fields: ['net_pay_minor', 'employer'] },
          { id: 'unauthorized', fields: ['secret_field'] },
        ],
        ...extra,
      },
    ],
  };
}

function makeDeps(overrides = {}) {
  return {
    getSourceDescriptor: () => sourceDescriptor,
    getManifest: () => makeManifest(),
    getGrant: () => ({ streams: [{ name: 'pay_statements' }] }),
    queryRecords: () =>
      Promise.resolve({
        object: 'list',
        data: [
          { object: 'record', id: 'r1', data: { net_pay_minor: 1 } },
          { object: 'record', id: 'r2', data: { net_pay_minor: 2 } },
        ],
        has_more: false,
      }),
    decorateRecord: (record) => record,
    validateRequestFields: () => undefined,
    ...overrides,
  };
}

test('rs.records.list returns the dependency result for owner shape', async () => {
  const result = await executeRecordsList(
    { actor: ownerActor, streamName: 'pay_statements', requestParams: {} },
    makeDeps(),
  );
  assert.equal(result.result.object, 'list');
  assert.equal(result.result.data.length, 2);
  assert.equal(result.result.data[0].id, 'r1');
  assert.deepEqual(result.sourceDescriptor, sourceDescriptor);
  assert.equal(result.queryData.query_shape, 'record_list');
  assert.equal(result.queryData.has_changes_since, false);
  assert.equal(result.queryData.limit, null);
  assert.equal('requested_view' in result.queryData, false);
  assert.deepEqual(result.disclosureData, {
    query_shape: 'record_list',
    record_count: 2,
    has_more: false,
    has_next_changes_since: false,
  });
  // Owner branch builds an owner read-grant scoped to the requested stream.
  assert.deepEqual(result.effectiveGrant, { streams: [{ name: 'pay_statements' }] });
});

test('rs.records.list throws not_found for owner when the manifest does not include the stream', async () => {
  await assert.rejects(
    () =>
      executeRecordsList(
        { actor: ownerActor, streamName: 'gone', requestParams: {} },
        makeDeps(),
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, 'not_found');
      assert.match(err.message, /'gone' not found/);
      return true;
    },
  );
});

test('rs.records.list does not 404 on missing manifest stream for client actors', async () => {
  // Client actors rely on the underlying `queryRecords` capability for
  // grant-shape rejection (the previous native route delegated to
  // `queryRecords` for that branch). The operation must not 404.
  let called = false;
  await executeRecordsList(
    { actor: clientActor, streamName: 'gone', requestParams: {} },
    makeDeps({
      getManifest: () => ({ streams: [] }),
      queryRecords: () => {
        called = true;
        return Promise.resolve({ object: 'list', data: [], has_more: false });
      },
    }),
  );
  assert.equal(called, true);
});

test('rs.records.list rejects when both view and fields are present', async () => {
  await assert.rejects(
    () =>
      executeRecordsList(
        {
          actor: ownerActor,
          streamName: 'pay_statements',
          requestParams: {},
          rawQueryView: 'compact',
          rawQueryFields: 'net_pay_minor',
        },
        makeDeps(),
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, 'invalid_request');
      assert.match(err.message, /mutually exclusive/);
      return true;
    },
  );
});

test('rs.records.list resolves a view by id, sets fields, and removes view from request params', async () => {
  let observedParams = null;
  await executeRecordsList(
    {
      actor: ownerActor,
      streamName: 'pay_statements',
      requestParams: { view: 'compact' },
      rawQueryView: 'compact',
    },
    makeDeps({
      queryRecords: (_stream, _grant, params) => {
        observedParams = { ...params };
        return Promise.resolve({ object: 'list', data: [], has_more: false });
      },
    }),
  );
  assert.deepEqual(observedParams.fields, ['net_pay_minor', 'employer']);
  assert.equal('view' in observedParams, false);
});

test('rs.records.list raises field_not_granted when the view names ungranted fields', async () => {
  await assert.rejects(
    () =>
      executeRecordsList(
        {
          actor: clientActor,
          streamName: 'pay_statements',
          requestParams: {},
          rawQueryView: 'unauthorized',
        },
        makeDeps({
          getGrant: () => ({
            streams: [
              { name: 'pay_statements', fields: ['net_pay_minor', 'employer'] },
            ],
          }),
        }),
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, 'field_not_granted');
      return true;
    },
  );
});

test('rs.records.list raises invalid_request when the view id is unknown', async () => {
  await assert.rejects(
    () =>
      executeRecordsList(
        {
          actor: ownerActor,
          streamName: 'pay_statements',
          requestParams: {},
          rawQueryView: 'no_such_view',
        },
        makeDeps(),
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, 'invalid_request');
      assert.match(err.message, /Unknown view/);
      return true;
    },
  );
});

test('rs.records.list does not resolve a view when validateRequestFields already promoted fields', async () => {
  let observedParams = null;
  await executeRecordsList(
    {
      actor: ownerActor,
      streamName: 'pay_statements',
      requestParams: { fields: 'net_pay_minor' },
      rawQueryView: 'compact',
    },
    makeDeps({
      // Mirror the native validator: if a `fields` param is present, it is
      // promoted to an array; the operation must then skip view resolution
      // (the previous native ordering).
      validateRequestFields: (params) => {
        if (typeof params.fields === 'string') {
          params.fields = params.fields.split(',').map((s) => s.trim());
        }
      },
      queryRecords: (_stream, _grant, params) => {
        observedParams = { ...params };
        return Promise.resolve({ object: 'list', data: [], has_more: false });
      },
    }),
  );
  // `fields` from the validator is preserved; the view is NOT resolved into
  // a different fields array.
  assert.deepEqual(observedParams.fields, ['net_pay_minor']);
});

test('rs.records.list applies decorateRecord to every returned record', async () => {
  const result = await executeRecordsList(
    { actor: ownerActor, streamName: 'pay_statements', requestParams: {} },
    makeDeps({
      decorateRecord: (record) => ({ ...record, decorated: true }),
    }),
  );
  for (const record of result.result.data) {
    assert.equal(record.decorated, true);
  }
});

test('rs.records.list passes the manifest stream to validateRequestFields', async () => {
  let observedStream = null;
  await executeRecordsList(
    { actor: ownerActor, streamName: 'pay_statements', requestParams: {} },
    makeDeps({
      validateRequestFields: (_params, stream) => {
        observedStream = stream;
      },
    }),
  );
  assert.equal(observedStream?.name, 'pay_statements');
  assert.ok(observedStream?.schema);
});

test('rs.records.list surfaces requested_view, has_changes_since, and limit on queryData', async () => {
  const result = await executeRecordsList(
    {
      actor: ownerActor,
      streamName: 'pay_statements',
      requestParams: { changes_since: '2026-04-01T00:00:00Z', limit: '10' },
      rawQueryView: 'compact',
    },
    makeDeps(),
  );
  assert.equal(result.queryData.requested_view, 'compact');
  assert.equal(result.queryData.has_changes_since, true);
  assert.equal(result.queryData.limit, 10);
});

test('rs.records.list awaits async dependency promises', async () => {
  let resolved = false;
  const result = await executeRecordsList(
    { actor: ownerActor, streamName: 'pay_statements', requestParams: {} },
    makeDeps({
      queryRecords: () =>
        new Promise((r) =>
          setImmediate(() => {
            resolved = true;
            r({ object: 'list', data: [], has_more: false });
          }),
        ),
    }),
  );
  assert.equal(resolved, true);
  assert.deepEqual(result.result.data, []);
});
