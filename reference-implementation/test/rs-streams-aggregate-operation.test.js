/**
 * Operation-level behavior tests for `rs.streams.aggregate`.
 *
 * Pins the `stream_aggregate` query-shape data block construction, the
 * owner-branch manifest-not-found visibility error, the validator-before-
 * aggregate ordering, and the verbatim aggregate-result passthrough plus
 * disclosure totals derived from the result.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  StreamsAggregateVisibilityError,
  executeStreamsAggregate,
} from '../operations/rs-streams-aggregate/index.ts';

function ownerInput(overrides = {}) {
  return {
    actor: { kind: 'owner', subject_id: 'sub_owner' },
    streamName: 'messages',
    requestParams: {},
    ...overrides,
  };
}

function clientInput(overrides = {}) {
  return {
    actor: {
      kind: 'client',
      subject_id: 'sub_owner',
      client_id: 'cli_1',
      grant_id: 'gnt_1',
    },
    streamName: 'messages',
    requestParams: {},
    ...overrides,
  };
}

function defaultDeps(overrides = {}) {
  return {
    getSourceDescriptor: () => null,
    hasManifestStream: () => true,
    validateRequest: () => {},
    aggregate: async () => ({
      metric: 'count',
      field: null,
      group_by: null,
      filtered_record_count: 0,
      groups: [],
    }),
    ...overrides,
  };
}

test('rs.streams.aggregate emits the stream_aggregate query-shape data block from request params', async () => {
  const out = await executeStreamsAggregate(
    ownerInput({
      requestParams: {
        metric: 'sum',
        field: 'amount',
        group_by: 'category',
        limit: '25',
      },
    }),
    defaultDeps(),
  );
  assert.deepEqual(out.queryData, {
    query_shape: 'stream_aggregate',
    metric: 'sum',
    field: 'amount',
    group_by: 'category',
    group_by_time: null,
    granularity: null,
    limit: 25,
  });
});

test('rs.streams.aggregate carries group_by_time and granularity in the query-data block', async () => {
  const out = await executeStreamsAggregate(
    ownerInput({
      requestParams: {
        metric: 'count',
        group_by_time: 'occurred_at',
        granularity: 'day',
      },
    }),
    defaultDeps(),
  );
  assert.equal(out.queryData.query_shape, 'stream_aggregate');
  assert.equal(out.queryData.group_by_time, 'occurred_at');
  assert.equal(out.queryData.granularity, 'day');
});

test('rs.streams.aggregate fills missing query-data fields with null', async () => {
  const out = await executeStreamsAggregate(ownerInput({ requestParams: {} }), defaultDeps());
  assert.deepEqual(out.queryData, {
    query_shape: 'stream_aggregate',
    metric: null,
    field: null,
    group_by: null,
    group_by_time: null,
    granularity: null,
    limit: null,
  });
});

test('rs.streams.aggregate ignores non-string metric/field/group_by values in the query data block', async () => {
  const out = await executeStreamsAggregate(
    ownerInput({
      requestParams: {
        metric: ['sum', 'avg'],
        field: { x: 1 },
        group_by: 42,
      },
    }),
    defaultDeps(),
  );
  assert.equal(out.queryData.metric, null);
  assert.equal(out.queryData.field, null);
  assert.equal(out.queryData.group_by, null);
});

test('rs.streams.aggregate owner branch throws StreamsAggregateVisibilityError when manifest is missing the stream', async () => {
  await assert.rejects(
    () =>
      executeStreamsAggregate(
        ownerInput({ streamName: 'unknown' }),
        defaultDeps({ hasManifestStream: () => false }),
      ),
    (err) => {
      assert.ok(err instanceof StreamsAggregateVisibilityError);
      assert.equal(err.code, 'not_found');
      assert.match(err.message, /Stream 'unknown' not found/);
      return true;
    },
  );
});

test('rs.streams.aggregate client branch does not consult hasManifestStream', async () => {
  let called = false;
  await executeStreamsAggregate(
    clientInput(),
    defaultDeps({
      hasManifestStream: () => {
        called = true;
        return false;
      },
    }),
  );
  assert.equal(called, false);
});

test('rs.streams.aggregate runs validator before aggregate', async () => {
  const order = [];
  await executeStreamsAggregate(
    ownerInput(),
    defaultDeps({
      validateRequest: () => {
        order.push('validate');
      },
      aggregate: async () => {
        order.push('aggregate');
        return { metric: 'count', filtered_record_count: 0, groups: [] };
      },
    }),
  );
  assert.deepEqual(order, ['validate', 'aggregate']);
});

test('rs.streams.aggregate propagates validator errors verbatim (no wrapping)', async () => {
  const validatorErr = new Error('bad field');
  validatorErr.code = 'invalid_request';
  await assert.rejects(
    () =>
      executeStreamsAggregate(
        ownerInput(),
        defaultDeps({
          validateRequest: () => {
            throw validatorErr;
          },
        }),
      ),
    (err) => {
      assert.strictEqual(err, validatorErr);
      return true;
    },
  );
});

test('rs.streams.aggregate returns the aggregate result verbatim', async () => {
  const aggregated = {
    metric: 'sum',
    field: 'amount',
    group_by: 'category',
    filtered_record_count: 12,
    groups: [{ key: 'a', value: 7 }, { key: 'b', value: 5 }],
    extra_passthrough: { ignored_by_op: true },
  };
  const out = await executeStreamsAggregate(
    ownerInput({ requestParams: { metric: 'sum', field: 'amount', group_by: 'category' } }),
    defaultDeps({ aggregate: async () => aggregated }),
  );
  assert.strictEqual(out.result, aggregated);
});

test('rs.streams.aggregate disclosure totals derive from the aggregate result', async () => {
  const out = await executeStreamsAggregate(
    ownerInput(),
    defaultDeps({
      aggregate: async () => ({
        metric: 'sum',
        field: 'amount',
        group_by: 'category',
        filtered_record_count: 12,
        groups: [1, 2, 3, 4],
      }),
    }),
  );
  assert.deepEqual(out.disclosureTotals, {
    metric: 'sum',
    field: 'amount',
    group_by: 'category',
    filtered_record_count: 12,
    group_count: 4,
  });
});

test('rs.streams.aggregate disclosure totals tolerate missing groups field with group_count: null', async () => {
  const out = await executeStreamsAggregate(
    ownerInput(),
    defaultDeps({
      aggregate: async () => ({
        metric: 'count',
        field: null,
        group_by: null,
        filtered_record_count: 0,
      }),
    }),
  );
  assert.equal(out.disclosureTotals.group_count, null);
});

test('rs.streams.aggregate propagates the dependency source descriptor', async () => {
  const source = { kind: 'connector', id: 'gmail' };
  const out = await executeStreamsAggregate(
    ownerInput(),
    defaultDeps({ getSourceDescriptor: () => source }),
  );
  assert.deepEqual(out.sourceDescriptor, source);
});
