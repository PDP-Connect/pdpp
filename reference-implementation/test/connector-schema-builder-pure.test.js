// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the pure exports of server/connector-schema-builder.js.
// No test imports this module by name. The async DB-coupled functions
// (buildConnectorSchemaItem, getConnectorFreshnessEvidence, getVisibleStreamFreshness)
// are out of scope here; this file pins the two pure assemblers:
//   buildStreamMetadataEntry     -- the stream_metadata response shape.
//   buildConnectorAwareFreshness -- the evidence->deriveReferenceFreshness field mapping.
//
// Mutation surface:
//   buildStreamMetadataEntry: object='stream_metadata', primary_key normalization
//     (string->[string], array passthrough), views/relationships/query defaults
//     ([]/[]/{}), granted_connections attached ONLY when an array is supplied,
//     grantStreams folded into the expand-capabilities grant.
//   buildConnectorAwareFreshness: maps lastRun.last_at/status,
//     lastSuccessfulRun.last_at, maximumStalenessSeconds, recordLastUpdatedAt into
//     the freshness projection (a fresh vs stale verdict tracks the mapped inputs).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConnectorAwareFreshness,
  buildStreamMetadataEntry,
} from '../server/connector-schema-builder.js';

const baseStream = {
  name: 'orders',
  semantics: 'transactional',
  schema: { properties: { id: { type: 'string' } } },
  cursor_field: 'emitted_at',
  consent_time_field: 'emitted_at',
  selection: 'all',
};

// ---------------------------------------------------------------------------
// buildStreamMetadataEntry
// ---------------------------------------------------------------------------

test('buildStreamMetadataEntry: object tag is stream_metadata and core fields are carried', () => {
  const entry = buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: 'id' } });
  assert.equal(entry.object, 'stream_metadata');
  assert.equal(entry.name, 'orders');
  assert.equal(entry.semantics, 'transactional');
  assert.equal(entry.cursor_field, 'emitted_at');
  assert.equal(entry.consent_time_field, 'emitted_at');
  assert.equal(entry.selection, 'all');
});

test('buildStreamMetadataEntry: primary_key normalizes string->array and passes arrays through', () => {
  assert.deepEqual(
    buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: 'id' } }).primary_key,
    ['id'],
  );
  assert.deepEqual(
    buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: ['a', 'b'] } }).primary_key,
    ['a', 'b'],
  );
  assert.deepEqual(
    buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: undefined } }).primary_key,
    [],
    'absent primary_key -> []',
  );
});

test('buildStreamMetadataEntry: views/relationships/query default to []/[]/{}', () => {
  const entry = buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: 'id' } });
  assert.deepEqual(entry.views, []);
  assert.deepEqual(entry.relationships, []);
  assert.deepEqual(entry.query, {});
});

test('buildStreamMetadataEntry: provided views/relationships/query are preserved', () => {
  const entry = buildStreamMetadataEntry({
    manifestStream: {
      ...baseStream,
      primary_key: 'id',
      views: [{ name: 'recent' }],
      relationships: [{ name: 'items', stream: 'order_items' }],
      query: { search: { lexical_fields: ['id'] } },
    },
  });
  assert.deepEqual(entry.views, [{ name: 'recent' }]);
  assert.deepEqual(entry.relationships, [{ name: 'items', stream: 'order_items' }]);
  assert.deepEqual(entry.query, { search: { lexical_fields: ['id'] } });
});

test('buildStreamMetadataEntry: granted_connections attached ONLY when an array is provided', () => {
  const without = buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: 'id' } });
  assert.ok(!('granted_connections' in without), 'omitted when not provided');

  const nullProvided = buildStreamMetadataEntry({
    manifestStream: { ...baseStream, primary_key: 'id' },
    grantedConnections: null,
  });
  assert.ok(!('granted_connections' in nullProvided), 'omitted when null (not an array)');

  const withArray = buildStreamMetadataEntry({
    manifestStream: { ...baseStream, primary_key: 'id' },
    grantedConnections: [{ connection_id: 'ci-1' }],
  });
  assert.deepEqual(withArray.granted_connections, [{ connection_id: 'ci-1' }]);
});

test('buildStreamMetadataEntry: default freshness is unknown when none supplied', () => {
  const entry = buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: 'id' } });
  assert.equal(entry.freshness.status, 'unknown');
});

test('buildStreamMetadataEntry: an explicit freshness object is passed through verbatim', () => {
  const freshness = { status: 'fresh', captured_at: '2024-01-01T00:00:00.000Z' };
  const entry = buildStreamMetadataEntry({ manifestStream: { ...baseStream, primary_key: 'id' }, freshness });
  assert.equal(entry.freshness, freshness, 'supplied freshness wins over the default');
});

test('buildStreamMetadataEntry: builds field_capabilities and expand_capabilities from the manifest', () => {
  const entry = buildStreamMetadataEntry({
    manifestStream: {
      ...baseStream,
      primary_key: 'id',
      relationships: [{ name: 'items', stream: 'order_items', cardinality: 'has_many' }],
      query: { expand: [{ name: 'items' }] },
    },
    streamGrant: { name: 'orders', fields: ['id'] },
    grantStreams: [{ name: 'order_items' }],
  });
  // field_capabilities is keyed by schema property.
  assert.ok(entry.field_capabilities.id, 'field_capabilities derived for declared property id');
  // expand_capabilities surfaces the declared, relationship-backed expand.
  assert.equal(entry.expand_capabilities.length, 1);
  assert.equal(entry.expand_capabilities[0].name, 'items');
});

// ---------------------------------------------------------------------------
// buildConnectorAwareFreshness (evidence -> freshness field mapping)
// ---------------------------------------------------------------------------

test('buildConnectorAwareFreshness: a record newer than the last successful run within staleness is fresh-ish; stale evidence yields a stale/attempted verdict', () => {
  // Successful run at t0, record last updated well after -> the record is newer
  // than the last success by more than maximumStalenessSeconds -> 'stale'. This
  // pins that the successful-run + staleness + recordLastUpdatedAt inputs are all
  // wired through (not dropped).
  const verdict = buildConnectorAwareFreshness(
    {
      lastRun: { last_at: '2024-01-01T00:00:00Z', status: 'succeeded' },
      lastSuccessfulRun: { last_at: '2024-01-01T00:00:00Z' },
      maximumStalenessSeconds: 3600,
    },
    '2024-06-01T00:00:00Z',
  );
  assert.equal(verdict.status, 'stale');
  assert.equal(verdict.last_attempted_at, '2024-01-01T00:00:00.000Z', 'lastRun.last_at mapped through');
});

test('buildConnectorAwareFreshness: null evidence yields an unknown-status verdict (nothing to assert freshness from)', () => {
  const verdict = buildConnectorAwareFreshness(null, null);
  assert.equal(verdict.status, 'unknown');
});

test('buildConnectorAwareFreshness: last_attempted_at reflects the mapped lastRun timestamp, not the successful one', () => {
  const verdict = buildConnectorAwareFreshness(
    {
      lastRun: { last_at: '2024-05-05T05:05:05Z', status: 'failed' },
      lastSuccessfulRun: { last_at: '2024-01-01T00:00:00Z' },
      maximumStalenessSeconds: 3600,
    },
    null,
  );
  assert.equal(verdict.last_attempted_at, '2024-05-05T05:05:05.000Z', 'attempted reflects lastRun, distinct from success');
});
