/**
 * Mutation-killing unit tests for the pure `buildStreamMetadataEntry`
 * composer in `server/connector-schema-builder.js`. No test imports it by
 * name.
 *
 * It assembles the `stream_metadata` response object from a manifest stream:
 * the `object`/`name` tags, primary-key normalization, the
 * views/relationships/query DEFAULTING (`|| []` / `|| {}`), the freshness
 * fallback (`?? buildFreshness(null)`), and the CONDITIONAL
 * `granted_connections` (present only when an array is supplied).
 *
 * The defaulting and the conditional inclusion are the load-bearing bits: a
 * mutant that drops the `|| []` default (leaking `undefined` into the wire
 * shape) or unconditionally attaches `granted_connections` turns red here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildStreamMetadataEntry } from '../server/connector-schema-builder.js';

const BASE_STREAM = {
  name: 'messages',
  semantics: 'append_only',
  schema: { type: 'object', properties: { body: { type: 'string' } } },
  primary_key: ['message_id'],
  cursor_field: 'received_at',
  consent_time_field: 'received_at',
  selection: { mode: 'all' },
};

test('buildStreamMetadataEntry: tags, primary-key normalization, and views/relationships/query defaults', () => {
  const entry = buildStreamMetadataEntry({ manifestStream: BASE_STREAM });

  assert.equal(entry.object, 'stream_metadata');
  assert.equal(entry.name, 'messages');
  assert.equal(entry.semantics, 'append_only');
  assert.deepEqual(entry.primary_key, ['message_id']);
  assert.equal(entry.cursor_field, 'received_at');

  // Missing views / relationships / query default to [] / [] / {} (never undefined).
  assert.deepEqual(entry.views, []);
  assert.deepEqual(entry.relationships, []);
  assert.deepEqual(entry.query, {});

  // A freshness envelope is always present (the ?? fallback), even with no input.
  assert.ok(entry.freshness && typeof entry.freshness === 'object', 'freshness must default to an object');

  // No grantedConnections supplied -> the key is absent entirely.
  assert.ok(!('granted_connections' in entry), 'granted_connections must be omitted when not an array');
});

test('buildStreamMetadataEntry: passes through declared views/relationships/query and explicit freshness', () => {
  const stream = {
    ...BASE_STREAM,
    views: [{ name: 'recent' }],
    relationships: [{ name: 'thread', stream: 'threads' }],
    query: { search: { lexical_fields: ['body'] } },
  };
  const freshness = { state: 'fresh', as_of: '2026-03-01T00:00:00Z' };
  const entry = buildStreamMetadataEntry({ manifestStream: stream, freshness });

  assert.deepEqual(entry.views, [{ name: 'recent' }]);
  assert.deepEqual(entry.relationships, [{ name: 'thread', stream: 'threads' }]);
  assert.deepEqual(entry.query, { search: { lexical_fields: ['body'] } });
  // Explicit freshness wins over the fallback.
  assert.deepEqual(entry.freshness, freshness);

  // field_capabilities / expand_capabilities are always computed.
  assert.ok(entry.field_capabilities && typeof entry.field_capabilities === 'object');
  assert.ok(Array.isArray(entry.expand_capabilities));
});

test('buildStreamMetadataEntry: attaches granted_connections ONLY when an array is provided', () => {
  const conns = [{ connection_id: 'cin_1', display_name: 'Work' }];
  const withConns = buildStreamMetadataEntry({ manifestStream: BASE_STREAM, grantedConnections: conns });
  assert.deepEqual(withConns.granted_connections, conns);

  // A non-array (null) grantedConnections -> key omitted.
  const withNull = buildStreamMetadataEntry({ manifestStream: BASE_STREAM, grantedConnections: null });
  assert.ok(!('granted_connections' in withNull));
});

test('buildStreamMetadataEntry: normalizes a scalar primary_key into an array', () => {
  const entry = buildStreamMetadataEntry({ manifestStream: { ...BASE_STREAM, primary_key: 'id' } });
  assert.deepEqual(entry.primary_key, ['id'], 'scalar primary_key must normalize to a one-element array');
});
