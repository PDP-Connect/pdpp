// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the two UNTESTED pure exports of
 * `operations/rs-schema-get/compact-view.ts`:
 *
 *   - `projectSchemaStreamScope(response, {stream, connectionId})` — scopes the
 *     FULL (non-compact) `rs.schema.get` response to a single stream and/or a
 *     single configured source without dropping any per-field detail. Contract:
 *       * no stream + no connectionId => identity (same reference back);
 *       * `stream` keeps only connectors that still have a matching stream and
 *         recomputes `connector_count` / `stream_count`;
 *       * the outer envelope (`object`, `bearer`, unrelated keys) is preserved;
 *       * `connectionId` narrows both which streams survive and each surviving
 *         stream/connector's `granted_connections` to that connection.
 *
 *   - `schemaSourceOptions(response, {stream, connectionId})` — enumerates the
 *     concrete configured-source options a schema scope represents (used to
 *     reject exhaustive detail over an ambiguous stream). Contract:
 *       * prefers a stream's `granted_connections`, else the connector's, else
 *         falls back to stream/connector identity;
 *       * de-duplicates on (connection_id, connector_key, stream);
 *       * each option includes a key ONLY when its value is truthy (no
 *         `connection_id: undefined` holes).
 *
 * The sibling `rs-schema-compact-view.test.js` already covers
 * `projectSchemaCompactView` and `formatFieldCapabilityFlags`; this file pins
 * the scope/source-enumeration behavior those tests don't touch.
 *
 * Pure, no DB, no server.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectSchemaStreamScope,
  schemaSourceOptions,
} from '../operations/rs-schema-get/compact-view.ts';

// A canonical two-connector, multi-stream schema response with explicit
// per-connector granted_connections. Deliberately concrete so every assertion
// checks an exact shape.
function sampleResponse() {
  return {
    object: 'schema',
    bearer: { scopes: ['read'] },
    connector_count: 2,
    stream_count: 3,
    extra_marker: 'keep-me',
    connectors: [
      {
        connector_key: 'amazon',
        granted_connections: [
          { connection_id: 'conn-a1', display_name: 'Amazon Personal' },
          { connection_id: 'conn-a2', display_name: 'Amazon Work' },
        ],
        stream_count: 2,
        streams: [
          { name: 'orders', primary_key: 'id', field_detail: { amount: {} } },
          { name: 'returns', primary_key: 'id' },
        ],
      },
      {
        connector_key: 'gmail',
        granted_connections: [{ connection_id: 'conn-g1', display_name: 'Gmail Main' }],
        stream_count: 1,
        streams: [{ name: 'messages', primary_key: 'id' }],
      },
    ],
  };
}

test('projectSchemaStreamScope: no stream + no connectionId returns the SAME reference (identity)', () => {
  const response = sampleResponse();
  assert.equal(projectSchemaStreamScope(response), response, 'unscoped call must be pass-through by reference');
  assert.equal(
    projectSchemaStreamScope(response, {}),
    response,
    'empty options must also be pass-through by reference',
  );
});

test('projectSchemaStreamScope: stream scope keeps only matching connectors and recomputes counts', () => {
  const out = projectSchemaStreamScope(sampleResponse(), { stream: 'orders' });
  // Only the amazon connector has an "orders" stream.
  assert.equal(out.connectors.length, 1, `expected 1 connector, got ${out.connectors.length}`);
  assert.equal(out.connectors[0].connector_key, 'amazon');
  // Only the "orders" stream survives inside it.
  assert.deepEqual(
    out.connectors[0].streams.map((s) => s.name),
    ['orders'],
    `streams: ${JSON.stringify(out.connectors[0].streams.map((s) => s.name))}`,
  );
  // Counts recomputed from the scoped set.
  assert.equal(out.connector_count, 1, 'connector_count recomputed');
  assert.equal(out.stream_count, 1, 'stream_count recomputed');
  assert.equal(out.connectors[0].stream_count, 1, 'per-connector stream_count recomputed');
});

test('projectSchemaStreamScope: full per-field detail on the surviving stream is preserved verbatim', () => {
  const out = projectSchemaStreamScope(sampleResponse(), { stream: 'orders' });
  // Unlike the compact view, scoping must NOT strip per-field detail.
  assert.deepEqual(
    out.connectors[0].streams[0].field_detail,
    { amount: {} },
    'field_detail must survive full-detail scoping',
  );
  // And no `detail: "compact"` marker is added by the scope-only projection.
  assert.equal('detail' in out, false, 'scope-only projection must not add a compact marker');
});

test('projectSchemaStreamScope: outer envelope keys survive and non-matching connectors are dropped', () => {
  const out = projectSchemaStreamScope(sampleResponse(), { stream: 'messages' });
  assert.equal(out.object, 'schema', 'object preserved');
  assert.deepEqual(out.bearer, { scopes: ['read'] }, 'bearer preserved');
  assert.equal(out.extra_marker, 'keep-me', 'unrelated envelope key preserved');
  // messages lives only in gmail.
  assert.deepEqual(
    out.connectors.map((c) => c.connector_key),
    ['gmail'],
    `connectors: ${JSON.stringify(out.connectors.map((c) => c.connector_key))}`,
  );
});

test('projectSchemaStreamScope: unknown stream yields zero connectors and zero counts', () => {
  const out = projectSchemaStreamScope(sampleResponse(), { stream: 'does-not-exist' });
  assert.deepEqual(out.connectors, [], 'no connectors for an unknown stream');
  assert.equal(out.connector_count, 0);
  assert.equal(out.stream_count, 0);
});

test('projectSchemaStreamScope: connectionId narrows granted_connections on the surviving connector', () => {
  const out = projectSchemaStreamScope(sampleResponse(), { connectionId: 'conn-a1' });
  // Only amazon has conn-a1; gmail is dropped.
  assert.deepEqual(out.connectors.map((c) => c.connector_key), ['amazon']);
  // The connector's granted_connections is narrowed to just conn-a1.
  assert.deepEqual(
    out.connectors[0].granted_connections,
    [{ connection_id: 'conn-a1', display_name: 'Amazon Personal' }],
    `granted_connections: ${JSON.stringify(out.connectors[0].granted_connections)}`,
  );
});

test('schemaSourceOptions: enumerates one dedup option per (connection, connector, stream) from granted_connections', () => {
  const out = schemaSourceOptions(sampleResponse());
  // amazon: 2 connections x 2 streams = 4 ; gmail: 1 connection x 1 stream = 1 => 5
  assert.equal(out.length, 5, `expected 5 options, got ${out.length}: ${JSON.stringify(out)}`);
  // Spot-check the exact shape of one amazon/orders option.
  const ordersA1 = out.find(
    (o) => o.connection_id === 'conn-a1' && o.stream === 'orders',
  );
  assert.deepEqual(
    ordersA1,
    {
      connection_id: 'conn-a1',
      connector_key: 'amazon',
      stream: 'orders',
      display_name: 'Amazon Personal',
    },
    `orders/conn-a1 option: ${JSON.stringify(ordersA1)}`,
  );
});

test('schemaSourceOptions: scoping by stream restricts the enumerated options to that stream', () => {
  const out = schemaSourceOptions(sampleResponse(), { stream: 'messages' });
  assert.deepEqual(
    out,
    [
      {
        connection_id: 'conn-g1',
        connector_key: 'gmail',
        stream: 'messages',
        display_name: 'Gmail Main',
      },
    ],
    `options: ${JSON.stringify(out)}`,
  );
});

test('schemaSourceOptions: falls back to stream+connector identity entries when granted_connections is absent', () => {
  // No granted_connections anywhere; source identity is carried on the stream.
  // The fallback path is `[stream, connector].filter(has-identity)`, so BOTH
  // the stream (carries connection_id) and the connector (carries connector_key
  // but no connection_id) qualify as source entries. They dedupe on
  // (connection_id, connector_key, stream), which differs because only the
  // stream entry has a connection_id — so two distinct options result.
  const response = {
    object: 'schema',
    bearer: null,
    connector_count: 1,
    stream_count: 1,
    connectors: [
      {
        connector_key: 'plaid',
        streams: [
          { name: 'transactions', connection_id: 'conn-p1', display_name: 'Checking' },
        ],
      },
    ],
  };
  const out = schemaSourceOptions(response);
  assert.deepEqual(
    out,
    [
      {
        connection_id: 'conn-p1',
        connector_key: 'plaid',
        stream: 'transactions',
        display_name: 'Checking',
      },
      {
        connector_key: 'plaid',
        stream: 'transactions',
        display_name: 'Checking',
      },
    ],
    `fallback options: ${JSON.stringify(out)}`,
  );
});

test('schemaSourceOptions: omits connection_id when absent; display_name falls back to the stream name', () => {
  // A stream with only a connector_key and name — no connection identity.
  // displayNameOf() falls back to the stream's own `name`, so display_name is
  // populated from it, but connection_id stays absent (no falsy-value hole).
  const response = {
    object: 'schema',
    bearer: null,
    connectors: [
      {
        connector_key: 'localfs',
        streams: [{ name: 'files' }],
      },
    ],
  };
  const out = schemaSourceOptions(response);
  assert.equal(out.length, 1, `expected 1, got ${JSON.stringify(out)}`);
  assert.deepEqual(
    out[0],
    { connector_key: 'localfs', stream: 'files', display_name: 'files' },
    `option: ${JSON.stringify(out[0])}`,
  );
  assert.equal('connection_id' in out[0], false, 'no connection_id key when connection identity is absent');
});

test('schemaSourceOptions: de-dupes identical (connection, connector, stream) triples across duplicate grants', () => {
  // Same connection listed twice on the stream — must collapse to one option.
  const response = {
    object: 'schema',
    bearer: null,
    connectors: [
      {
        connector_key: 'amazon',
        streams: [
          {
            name: 'orders',
            granted_connections: [
              { connection_id: 'conn-a1', display_name: 'A' },
              { connection_id: 'conn-a1', display_name: 'A' },
            ],
          },
        ],
      },
    ],
  };
  const out = schemaSourceOptions(response);
  assert.equal(out.length, 1, `duplicate grants must collapse, got ${JSON.stringify(out)}`);
  assert.equal(out[0].connection_id, 'conn-a1');
});
