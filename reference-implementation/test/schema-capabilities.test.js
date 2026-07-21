/**
 * Unit tests for the pure schema-capability projection helpers.
 *
 * schema-capabilities.js is a pure module (no I/O) but had no co-named test
 * and none of its exports were touched elsewhere. These tests OBSERVE the
 * grant-derived capability flags without changing behavior. Coverage:
 *   - buildFieldCapabilities: exact/range/lexical/semantic/aggregation
 *     declared+usable flags, the field_not_granted reason, x_pdpp_type/role
 *     projection, and range operator surfacing,
 *   - buildExpandCapabilities: usable vs declared-unreadable relations with
 *     the related_stream_not_granted / related_stream_unknown reasons and the
 *     canonical + back-compat field aliases,
 *   - buildStreamDiscoveryCapabilities: URL construction, connector_id query
 *     encoding, and the aggregate/range/expand presence flags.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFieldCapabilities,
  buildExpandCapabilities,
  buildStreamDiscoveryCapabilities,
} from '../server/schema-capabilities.js';

function streamFixture() {
  return {
    name: 'messages',
    schema: {
      properties: {
        subject: { type: 'string', x_pdpp_type: 'headline', x_pdpp_role: 'title' },
        sent_at: { type: 'string', format: 'date-time' },
        priority: { type: 'integer' },
      },
    },
    query: {
      range_filters: { sent_at: ['gte', 'lte'] },
      search: { lexical_fields: ['subject'], semantic_fields: ['subject'] },
      aggregations: { count: true, sum: ['priority'], group_by: ['priority'], min: ['sent_at'] },
    },
  };
}

test('buildFieldCapabilities marks exact-filterable scalar fields declared+usable when granted', () => {
  const caps = buildFieldCapabilities(streamFixture());
  assert.equal(caps.subject.exact_filter.declared, true);
  assert.equal(caps.subject.exact_filter.usable, true);
  // Range declared only where range_filters lists the field, with operators surfaced.
  assert.equal(caps.sent_at.range_filter.declared, true);
  assert.deepEqual(caps.sent_at.range_filter.operators, ['gte', 'lte']);
  assert.equal(caps.subject.range_filter.declared, false);
});

test('buildFieldCapabilities projects lexical/semantic/aggregation declarations', () => {
  const caps = buildFieldCapabilities(streamFixture());
  assert.equal(caps.subject.lexical_search.declared, true);
  assert.equal(caps.subject.semantic_search.declared, true);
  assert.equal(caps.priority.aggregation.sum.declared, true);
  assert.equal(caps.priority.aggregation.group_by.declared, true);
  assert.equal(caps.priority.aggregation.max.declared, false);
  assert.equal(caps.sent_at.aggregation.min.declared, true);
});

test('buildFieldCapabilities surfaces x_pdpp_type/role on the entry', () => {
  const caps = buildFieldCapabilities(streamFixture());
  assert.equal(caps.subject.type, 'headline');
  assert.equal(caps.subject.role, 'title');
  // Fields without the extension omit type/role.
  assert.equal('type' in caps.priority, false);
  assert.equal('role' in caps.priority, false);
});

test('buildFieldCapabilities applies field_not_granted when the grant omits a field', () => {
  const grant = { fields: ['subject'] }; // sent_at, priority not granted
  const caps = buildFieldCapabilities(streamFixture(), grant);
  assert.equal(caps.subject.granted, true);
  assert.equal(caps.sent_at.granted, false);
  assert.equal(caps.sent_at.exact_filter.usable, false);
  assert.equal(caps.sent_at.range_filter.reason, 'field_not_granted');
  assert.equal(caps.priority.aggregation.sum.usable, false);
  assert.equal(caps.priority.aggregation.sum.reason, 'field_not_granted');
});

function expandStreamFixture() {
  return {
    relationships: [
      { name: 'items', stream: 'order_items', cardinality: 'has_many', foreign_key: 'order_id' },
      { name: 'buyer', stream: 'people', cardinality: 'has_one' },
      { name: 'ghost', stream: 'nonexistent', cardinality: 'has_one' },
    ],
    query: {
      expand: [
        { name: 'items', default_limit: 10, max_limit: 25 },
        { name: 'buyer' },
        { name: 'ghost' },
        { name: 'no_relationship' }, // capability with no backing relationship -> filtered out
      ],
    },
  };
}

test('buildExpandCapabilities returns usable relations and back-compat aliases', () => {
  const caps = buildExpandCapabilities(expandStreamFixture());
  const items = caps.find((c) => c.name === 'items');
  assert.equal(items.usable, true);
  assert.equal(items.stream, 'order_items');
  assert.equal(items.target_stream, 'order_items');
  assert.equal(items.child_parent_key_field, 'order_id');
  assert.equal(items.foreign_key, 'order_id');
  assert.equal(items.default_limit, 10);
  assert.equal(items.max_limit, 25);
  // The capability with no backing relationship is dropped.
  assert.equal(caps.find((c) => c.name === 'no_relationship'), undefined);
});

test('buildExpandCapabilities reasons: related_stream_not_granted vs related_stream_unknown', () => {
  const manifestStreamNames = new Set(['order_items', 'people']);
  const streamGrant = { grantStreams: [{ name: 'people' }] }; // order_items known but not granted
  const caps = buildExpandCapabilities(expandStreamFixture(), streamGrant, manifestStreamNames);

  const items = caps.find((c) => c.name === 'items');
  assert.equal(items.granted, false);
  assert.equal(items.usable, false);
  assert.equal(items.reason, 'related_stream_not_granted');

  const buyer = caps.find((c) => c.name === 'buyer');
  assert.equal(buyer.usable, true);

  const ghost = caps.find((c) => c.name === 'ghost');
  assert.equal(ghost.usable, false);
  assert.equal(ghost.reason, 'related_stream_unknown');
});

test('buildStreamDiscoveryCapabilities builds URLs and presence flags', () => {
  const stream = streamFixture();
  const caps = buildStreamDiscoveryCapabilities({ stream });
  assert.equal(caps.metadata_url, '/v1/streams/messages');
  assert.equal(caps.records_url, '/v1/streams/messages/records');
  assert.equal(caps.aggregate, true);
  assert.equal(caps.aggregate_url, '/v1/streams/messages/aggregate');
  assert.equal(caps.range_filters, true);
  assert.equal(caps.expand, false); // no query.expand in this fixture
  assert.equal(caps.changes_since, true);
});

test('buildStreamDiscoveryCapabilities encodes connector_id and omits aggregate_url without aggregations', () => {
  const stream = { name: 'a b', query: {} };
  const caps = buildStreamDiscoveryCapabilities({ connectorId: 'gmail/x', stream });
  assert.equal(caps.metadata_url, '/v1/streams/a%20b?connector_id=gmail%2Fx');
  // hasObjectEntries short-circuits to a falsy value when query has no
  // aggregations/range_filters object; assert falsy, matching real behavior.
  assert.ok(!caps.aggregate);
  assert.equal(caps.aggregate_url, null);
  assert.ok(!caps.range_filters);
});
