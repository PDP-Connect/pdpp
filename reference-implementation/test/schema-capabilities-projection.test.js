// Pure, no-DB unit tests for the schema-capability PROJECTION functions in
// server/schema-capabilities.js. No test imports this module by name today; all
// three exports (buildFieldCapabilities, buildExpandCapabilities,
// buildStreamDiscoveryCapabilities) were unpinned at the unit level.
//
// The route-level query-contract.test.js asserts related_stream_not_granted
// through the HTTP surface; this file pins the projection directly and, in
// particular, the related_stream_unknown branch (known ? not_granted : unknown)
// which had ZERO coverage anywhere.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExpandCapabilities,
  buildFieldCapabilities,
  buildStreamDiscoveryCapabilities,
} from '../server/schema-capabilities.js';

// ---------------------------------------------------------------------------
// buildFieldCapabilities: granted flag + usable derivation + reason
// ---------------------------------------------------------------------------

function streamWith(properties, extras = {}) {
  return { schema: { properties }, ...extras };
}

test('buildFieldCapabilities: scalar field is exact_filterable when declared', () => {
  const caps = buildFieldCapabilities(streamWith({ status: { type: 'string' } }));
  assert.equal(caps.status.exact_filter.declared, true);
  assert.equal(caps.status.granted, true, 'no grant scoping -> granted');
  assert.equal(caps.status.exact_filter.usable, true);
});

test('buildFieldCapabilities: object-typed field is NOT exact_filterable', () => {
  const caps = buildFieldCapabilities(streamWith({ payload: { type: 'object' } }));
  assert.equal(caps.payload.exact_filter.declared, false, 'non-scalar cannot be exact-filtered');
});

test('buildFieldCapabilities: ungranted field is declared-but-not-usable with field_not_granted reason', () => {
  const caps = buildFieldCapabilities(
    streamWith({ status: { type: 'string' }, secret: { type: 'string' } }),
    { fields: ['status'] }, // grant only exposes `status`
  );
  assert.equal(caps.status.granted, true);
  assert.equal(caps.secret.granted, false);
  assert.equal(caps.secret.exact_filter.declared, true, 'schema still declares it filterable');
  assert.equal(caps.secret.exact_filter.usable, false, 'but not usable without grant');
  assert.equal(caps.secret.exact_filter.reason, 'field_not_granted');
});

test('buildFieldCapabilities: range_filter surfaces declared operators from manifest', () => {
  const caps = buildFieldCapabilities(
    streamWith({ amount: { type: 'integer' } }, { query: { range_filters: { amount: ['gte', 'lte'] } } }),
  );
  assert.equal(caps.amount.range_filter.declared, true);
  assert.deepEqual(caps.amount.range_filter.operators, ['gte', 'lte']);
});

test('buildFieldCapabilities: aggregation flags reflect declared sum/group_by membership', () => {
  const caps = buildFieldCapabilities(
    streamWith({ amount: { type: 'number' }, category: { type: 'string' } }, {
      query: { aggregations: { sum: ['amount'], group_by: ['category'] } },
    }),
  );
  assert.equal(caps.amount.aggregation.sum.declared, true);
  assert.equal(caps.amount.aggregation.group_by.declared, false);
  assert.equal(caps.category.aggregation.group_by.declared, true);
  assert.equal(caps.category.aggregation.sum.declared, false);
});

// ---------------------------------------------------------------------------
// buildExpandCapabilities: reachability projection (the two reason codes)
// ---------------------------------------------------------------------------

function expandStream() {
  return {
    relationships: [
      { name: 'items', stream: 'order_items', cardinality: 'has_many', foreign_key: 'order_id' },
    ],
    query: { expand: [{ name: 'items', default_limit: 10, max_limit: 25 }] },
  };
}

test('buildExpandCapabilities: usable entry when target stream is known and granted', () => {
  const out = buildExpandCapabilities(
    expandStream(),
    { grantStreams: [{ name: 'order_items' }] },
    new Set(['orders', 'order_items']),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'items');
  assert.equal(out[0].target_stream, 'order_items');
  assert.equal(out[0].stream, 'order_items', 'back-compat alias present');
  assert.equal(out[0].cardinality, 'has_many');
  assert.equal(out[0].child_parent_key_field, 'order_id');
  assert.equal(out[0].foreign_key, 'order_id', 'back-compat alias');
  assert.equal(out[0].granted, true);
  assert.equal(out[0].usable, true);
  assert.equal(out[0].reason, undefined, 'usable entries carry no reason');
});

test('buildExpandCapabilities: known-but-not-granted -> reason related_stream_not_granted', () => {
  const out = buildExpandCapabilities(
    expandStream(),
    { grantStreams: [{ name: 'something_else' }] }, // order_items NOT granted
    new Set(['orders', 'order_items']), // but it IS in the manifest (known)
  );
  assert.equal(out[0].usable, false);
  assert.equal(out[0].granted, false);
  assert.equal(out[0].reason, 'related_stream_not_granted');
});

test('buildExpandCapabilities: unknown target stream -> reason related_stream_unknown', () => {
  const out = buildExpandCapabilities(
    expandStream(),
    { grantStreams: [{ name: 'order_items' }] }, // grant would allow it
    new Set(['orders']), // but order_items is NOT in the loaded manifest (unknown)
  );
  assert.equal(out[0].usable, false);
  assert.equal(out[0].reason, 'related_stream_unknown', 'unknown target must be distinguished from not_granted');
});

test('buildExpandCapabilities: capability without a backing relationship is dropped', () => {
  const stream = {
    relationships: [], // no relationship backs the 'items' capability
    query: { expand: [{ name: 'items' }] },
  };
  const out = buildExpandCapabilities(stream, null, null);
  assert.deepEqual(out, [], 'unbacked capability filtered out');
});

test('buildExpandCapabilities: null grant + null manifest names => everything known is granted', () => {
  const out = buildExpandCapabilities(expandStream(), null, null);
  assert.equal(out[0].granted, true, 'no grant scoping => granted');
  assert.equal(out[0].usable, true);
});

// ---------------------------------------------------------------------------
// buildStreamDiscoveryCapabilities: URL + boolean projection
// ---------------------------------------------------------------------------

test('buildStreamDiscoveryCapabilities: aggregate flag/url present only when aggregations declared', () => {
  const withAgg = buildStreamDiscoveryCapabilities({
    connectorId: 'amazon',
    stream: { name: 'orders', query: { aggregations: { sum: ['total'] } } },
  });
  assert.equal(withAgg.aggregate, true);
  assert.equal(withAgg.aggregate_url, '/v1/streams/orders/aggregate?connector_id=amazon');

  // hasObjectEntries short-circuits on a falsy input, so an ABSENT aggregations
  // key yields a falsy `undefined` (not a literal false); the aggregate_url is
  // still null. Pin both so a mutant that hard-codes aggregate:true is caught.
  const noAgg = buildStreamDiscoveryCapabilities({ connectorId: 'amazon', stream: { name: 'orders', query: {} } });
  assert.ok(!noAgg.aggregate, 'absent aggregations -> falsy aggregate flag');
  assert.equal(noAgg.aggregate_url, null, 'no aggregate URL when no aggregations');
  // An explicit EMPTY aggregations object also yields a falsy flag.
  const emptyAgg = buildStreamDiscoveryCapabilities({ stream: { name: 'orders', query: { aggregations: {} } } });
  assert.equal(emptyAgg.aggregate, false, 'empty aggregations object -> false');
  assert.equal(emptyAgg.aggregate_url, null);
});

test('buildStreamDiscoveryCapabilities: range_filters flag reflects non-empty declaration', () => {
  const withRange = buildStreamDiscoveryCapabilities({
    stream: { name: 'orders', query: { range_filters: { total: ['gte'] } } },
  });
  assert.equal(withRange.range_filters, true);
  const noRange = buildStreamDiscoveryCapabilities({ stream: { name: 'orders', query: { range_filters: {} } } });
  assert.equal(noRange.range_filters, false, 'empty range_filters object is not a capability');
});

test('buildStreamDiscoveryCapabilities: expand flag true only for a non-empty expand array', () => {
  const withExpand = buildStreamDiscoveryCapabilities({
    stream: { name: 'orders', query: { expand: [{ name: 'items' }] } },
  });
  assert.equal(withExpand.expand, true);
  const emptyExpand = buildStreamDiscoveryCapabilities({ stream: { name: 'orders', query: { expand: [] } } });
  assert.equal(emptyExpand.expand, false);
});

test('buildStreamDiscoveryCapabilities: encodes stream name and omits connector query when no connector', () => {
  const caps = buildStreamDiscoveryCapabilities({ stream: { name: 'weird/name', query: {} } });
  assert.equal(caps.metadata_url, '/v1/streams/weird%2Fname', 'stream name URL-encoded, no connector query');
  assert.equal(caps.records_url, '/v1/streams/weird%2Fname/records');
  assert.equal(caps.stream_metadata, true);
  assert.equal(caps.records, true);
  assert.equal(caps.changes_since, true);
  assert.equal(caps.exact_filters, true);
});
