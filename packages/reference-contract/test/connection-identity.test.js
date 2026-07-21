// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';

import { publicManifests } from '../src/public/index.ts';
import { validateRequest } from '../src/index.ts';

function findOperation(operationId) {
  const operation = publicManifests.find((manifest) => manifest.id === operationId);
  assert.ok(operation, `expected public manifest ${operationId}`);
  return operation;
}

function queryProperties(operationId) {
  const op = findOperation(operationId);
  return op.request?.query?.properties ?? {};
}

function responseSchema(operationId, status = 200) {
  const op = findOperation(operationId);
  return op.responses?.[status]?.schema ?? null;
}

const OPERATIONS_WITH_OPTIONAL_CONNECTION_INPUT = [
  'listStreams',
  'getStreamMetadata',
  'listRecords',
  'getRecord',
  'searchRecordsLexical',
  'searchRecordsSemantic',
  'searchRecordsHybrid',
  'getBlob',
];

test('every grant-authorized read operation accepts optional connection_id and connector_instance_id', () => {
  for (const id of OPERATIONS_WITH_OPTIONAL_CONNECTION_INPUT) {
    const props = queryProperties(id);
    assert.ok(props.connection_id, `${id} must accept connection_id`);
    assert.ok(props.connector_instance_id, `${id} must accept connector_instance_id alias`);
    // Neither field is required — these are additive optional filters.
    const required = findOperation(id).request?.query?.required ?? [];
    assert.ok(!required.includes('connection_id'), `${id}.connection_id must remain optional`);
    assert.ok(
      !required.includes('connector_instance_id'),
      `${id}.connector_instance_id must remain optional`,
    );
  }
});

test('stream list response items carry connection_id and display_name', () => {
  const schema = responseSchema('listStreams');
  const item = schema?.properties?.data?.items;
  assert.ok(item, 'listStreams 200 must declare data items');
  assert.ok(item.properties.connection_id, 'stream list item must declare connection_id');
  assert.ok(item.properties.display_name, 'stream list item must declare display_name');
  assert.ok(
    item.properties.connector_instance_id,
    'stream list item must declare deprecated connector_instance_id alias',
  );
});

test('record response carries connection_id and display_name', () => {
  // RecordSchema is shared by getRecord and listRecords data items.
  const recordSchema = responseSchema('getRecord');
  assert.ok(recordSchema?.properties?.connection_id, 'record schema must declare connection_id');
  assert.ok(recordSchema?.properties?.display_name, 'record schema must declare display_name');
  assert.ok(
    recordSchema?.properties?.connector_instance_id,
    'record schema must declare connector_instance_id alias',
  );
});

test('search result items carry connection_id and display_name on lexical/semantic/hybrid', () => {
  for (const id of ['searchRecordsLexical', 'searchRecordsSemantic', 'searchRecordsHybrid']) {
    const item = responseSchema(id)?.properties?.data?.items;
    assert.ok(item, `${id} 200 must declare data items`);
    assert.ok(item.properties.connection_id, `${id} hit must declare connection_id`);
    assert.ok(item.properties.display_name, `${id} hit must declare display_name`);
    assert.ok(
      item.properties.connector_instance_id,
      `${id} hit must declare connector_instance_id alias`,
    );
  }
});

test('getRecord and getBlob declare a typed ambiguous_connection 409 envelope', () => {
  for (const id of ['getRecord', 'getBlob']) {
    const op = findOperation(id);
    const response = op.responses?.['409'];
    assert.ok(response, `${id} must declare a 409 response`);
    const errorSchema = response.schema?.properties?.error;
    assert.ok(errorSchema, `${id} 409 must declare error envelope`);
    assert.equal(
      errorSchema.properties.code.const,
      'ambiguous_connection',
      `${id} 409 must use code "ambiguous_connection"`,
    );
    assert.ok(
      errorSchema.properties.available_connections,
      `${id} 409 must include available_connections`,
    );
    assert.ok(
      errorSchema.properties.retry_with,
      `${id} 409 must include retry_with`,
    );
    assert.equal(
      errorSchema.properties.retry_with.properties.field.const,
      'connection_id',
      `${id} retry_with.field must point at connection_id`,
    );
  }
});

test('list and search operations do NOT declare 409 — fan-in is the contract there', () => {
  for (const id of [
    'listStreams',
    'listRecords',
    'searchRecordsLexical',
    'searchRecordsSemantic',
    'searchRecordsHybrid',
  ]) {
    const op = findOperation(id);
    assert.equal(
      op.responses?.['409'],
      undefined,
      `${id} must NOT declare 409 — fan-in semantics, not ambiguous_connection`,
    );
  }
});

test('StreamSelection in grant scope accepts optional per-stream connection_id', () => {
  // The grant carries `streams: [{ name, ... }]`. Validate that PAR/consent
  // flow continues to accept entries without `connection_id` and that
  // additional `connection_id` is permitted.
  const baseline = validateRequest('createPushedAuthorizationRequest', {
    body: {
      client_id: 'longview',
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          source: { kind: 'connector', id: 'spotify' },
          purpose_code: 'https://pdpp.org/purpose/personalization',
          access_mode: 'continuous',
          streams: [{ name: 'top_artists', view: 'basic' }],
        },
      ],
    },
  });
  assert.deepEqual(baseline, { ok: true }, 'streams without connection_id must remain valid');

  const constrained = validateRequest('createPushedAuthorizationRequest', {
    body: {
      client_id: 'longview',
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          source: { kind: 'connector', id: 'spotify' },
          purpose_code: 'https://pdpp.org/purpose/personalization',
          access_mode: 'continuous',
          streams: [{ name: 'top_artists', view: 'basic', connection_id: 'cin_abc' }],
        },
      ],
    },
  });
  assert.deepEqual(
    constrained,
    { ok: true },
    'streams with optional connection_id constraint must validate',
  );
});

test('connection_id and connector_instance_id aliases validate together when supplied as request inputs', () => {
  // listRecords (the largest read surface) should accept either field on its
  // own and both at once — the runtime is responsible for rejecting
  // conflicting values; the schema layer just permits the shape.
  for (const query of [
    { connection_id: 'cin_abc' },
    { connector_instance_id: 'cin_abc' },
    { connection_id: 'cin_abc', connector_instance_id: 'cin_abc' },
  ]) {
    const result = validateRequest('listRecords', {
      headers: { authorization: 'Bearer t' },
      params: { stream: 'top_artists' },
      query,
    });
    assert.deepEqual(result, { ok: true }, `query ${JSON.stringify(query)} should validate`);
  }
});
