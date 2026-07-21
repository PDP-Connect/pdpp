// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for the schema read-model capability builders
// (server/schema-capabilities.js) that the MCP `schema` tool advertises.
// buildExpandCapabilities and buildStreamDiscoveryCapabilities are pure
// shape-assembly (the expand builder was explicitly decomplected so its
// reachability inputs are passed, not captured) yet have ZERO by-name coverage.
// They emit the public `related_stream_not_granted` / `related_stream_unknown`
// reason enums and the discovery URL/flags a console reads. No DB.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExpandCapabilities,
  buildStreamDiscoveryCapabilities,
} from '../server/schema-capabilities.js';

test('buildExpandCapabilities emits usable/granted/reason per relation reachability', () => {
  const manifestStream = {
    relationships: [
      { name: 'account', stream: 'accounts', cardinality: 'many_to_one', foreign_key: 'account_id' },
      { name: 'stmt', stream: 'statements', cardinality: 'one_to_many' },
      { name: 'ghost', stream: 'ghosts', cardinality: 'one_to_many' },
    ],
    query: {
      expand: [
        { name: 'account', default_limit: 10, max_limit: 50 },
        { name: 'stmt' },
        { name: 'ghost' },
        { name: 'undeclared_rel' }, // no backing relationship -> filtered out
      ],
    },
  };
  const grant = { grantStreams: [{ name: 'accounts' }] }; // only accounts granted
  const manifestStreamNames = new Set(['accounts', 'statements']); // ghosts is unknown

  const caps = buildExpandCapabilities(manifestStream, grant, manifestStreamNames);

  // undeclared_rel (no relationship) is dropped; the three backed relations remain.
  assert.equal(caps.length, 3);

  // Granted + known -> usable, with the foreign-key canonical + alias and limits.
  assert.deepEqual(caps[0], {
    name: 'account',
    stream: 'accounts',
    target_stream: 'accounts',
    cardinality: 'many_to_one',
    granted: true,
    usable: true,
    child_parent_key_field: 'account_id',
    foreign_key: 'account_id',
    default_limit: 10,
    max_limit: 50,
  });

  // Known but not granted -> related_stream_not_granted.
  assert.equal(caps[1].name, 'stmt');
  assert.equal(caps[1].granted, false);
  assert.equal(caps[1].usable, false);
  assert.equal(caps[1].reason, 'related_stream_not_granted');
  assert.ok(!('foreign_key' in caps[1]), 'a relation without a foreign_key omits it');

  // Unknown target stream -> related_stream_unknown.
  assert.equal(caps[2].name, 'ghost');
  assert.equal(caps[2].usable, false);
  assert.equal(caps[2].reason, 'related_stream_unknown');
});

test('buildExpandCapabilities: a null grant (owner/unfiltered) makes every known relation usable', () => {
  const manifestStream = {
    relationships: [{ name: 'account', stream: 'accounts', cardinality: 'many_to_one' }],
    query: { expand: [{ name: 'account' }] },
  };
  // grant=null, manifestStreamNames=null => no scoping in effect.
  const caps = buildExpandCapabilities(manifestStream, null, null);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].granted, true);
  assert.equal(caps[0].usable, true);
  assert.ok(!('reason' in caps[0]), 'a usable relation carries no reason');
});

test('buildStreamDiscoveryCapabilities encodes the stream, scopes URLs by connector, and reflects query flags', () => {
  const caps = buildStreamDiscoveryCapabilities({
    connectorId: 'c1',
    stream: {
      name: 'ord ers',
      query: { range_filters: { amount: ['gte'] }, aggregations: { count: ['x'] }, expand: [{ name: 'r' }] },
    },
  });
  assert.equal(caps.metadata_url, '/v1/streams/ord%20ers?connector_id=c1');
  assert.equal(caps.records_url, '/v1/streams/ord%20ers/records?connector_id=c1');
  assert.equal(caps.aggregate, true);
  assert.equal(caps.aggregate_url, '/v1/streams/ord%20ers/aggregate?connector_id=c1');
  assert.equal(caps.range_filters, true);
  assert.equal(caps.expand, true);
  assert.equal(caps.exact_filters, true);
  assert.equal(caps.changes_since, true);
});

test('buildStreamDiscoveryCapabilities omits the connector query and nulls aggregate_url when unsupported', () => {
  const caps = buildStreamDiscoveryCapabilities({ stream: { name: 'plain' } });
  assert.equal(caps.metadata_url, '/v1/streams/plain'); // no ?connector_id
  // hasObjectEntries(undefined) short-circuits to a falsy undefined (not false)
  // when the stream declares no aggregations/range_filters.
  assert.ok(!caps.aggregate);
  assert.equal(caps.aggregate_url, null);
  assert.ok(!caps.range_filters);
  assert.equal(caps.expand, false); // expand uses Array.isArray(...) && length>0 => strict false
});
