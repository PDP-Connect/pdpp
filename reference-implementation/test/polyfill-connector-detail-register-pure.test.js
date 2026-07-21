// Pure, no-DB unit tests for the polyfill connector detail + register operations
// in operations/as-polyfill-connector-detail/index.ts and
// operations/as-polyfill-connector-register/index.ts. Neither is imported by name.
// The store dependency is stubbed so we exercise the operations' presence-mapping,
// connector-key extraction, and outcome shapes without a catalog DB.
//
// Mutation surface:
//   executeAsPolyfillConnectorDetail -- missing manifest -> 404/not_found; present
//     -> success with the manifest as the envelope.
//   executeAsPolyfillConnectorRegister -- connector_key ?? connector_id extraction;
//     missing/non-string -> 400/invalid_request; success -> 201 with the registered
//     key (registerConnector result, else the extracted key) as connector_id + connector_key.

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAsPolyfillConnectorDetail } from '../operations/as-polyfill-connector-detail/index.ts';
import { executeAsPolyfillConnectorRegister } from '../operations/as-polyfill-connector-register/index.ts';

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

test('detail: a missing manifest is a 404 not_found', async () => {
  for (const manifest of [null, undefined]) {
    const out = await executeAsPolyfillConnectorDetail({ connectorId: 'ghost' }, { getConnectorManifest: () => manifest });
    assert.equal(out.outcome, 'failure');
    assert.equal(out.status, 404);
    assert.equal(out.errorCode, 'not_found');
    assert.equal(out.errorMessage, 'Connector not found');
  }
});

test('detail: a present manifest is returned as the success envelope', async () => {
  const manifest = { connector_id: 'amazon', streams: [] };
  let asked = null;
  const out = await executeAsPolyfillConnectorDetail(
    { connectorId: 'amazon' },
    { getConnectorManifest: (id) => { asked = id; return manifest; } },
  );
  assert.equal(asked, 'amazon', 'connectorId forwarded to the lookup');
  assert.equal(out.outcome, 'success');
  assert.equal(out.envelope, manifest, 'manifest is the envelope verbatim');
});

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

test('register: a manifest missing connector_key/connector_id is a 400 invalid_request', async () => {
  const out = await executeAsPolyfillConnectorRegister(
    { manifest: { streams: [] } },
    { registerConnector: () => 'should-not-be-called' },
  );
  assert.equal(out.outcome, 'failure');
  assert.equal(out.status, 400);
  assert.equal(out.errorCode, 'invalid_request');
  assert.equal(out.errorMessage, 'Missing connector_key or connector_id');
});

test('register: a non-object manifest is rejected', async () => {
  for (const manifest of [null, 'string', ['array']]) {
    const out = await executeAsPolyfillConnectorRegister({ manifest }, { registerConnector: () => 'x' });
    assert.equal(out.outcome, 'failure', `rejected: ${JSON.stringify(manifest)}`);
    assert.equal(out.status, 400);
  }
});

test('register: connector_key is preferred over connector_id for extraction', async () => {
  // registerConnector returns nothing -> the outcome falls back to the extracted key.
  const out = await executeAsPolyfillConnectorRegister(
    { manifest: { connector_key: 'canonical-key', connector_id: 'https://registry/connectors/amazon' } },
    { registerConnector: () => undefined },
  );
  assert.equal(out.outcome, 'success');
  assert.equal(out.status, 201);
  assert.equal(out.envelope.connector_id, 'canonical-key', 'connector_key wins');
  assert.equal(out.envelope.connector_key, 'canonical-key');
});

test('register: falls back to connector_id when connector_key is absent', async () => {
  const out = await executeAsPolyfillConnectorRegister(
    { manifest: { connector_id: 'amazon' } },
    { registerConnector: () => undefined },
  );
  assert.equal(out.envelope.connector_id, 'amazon');
});

test('register: the registerConnector return value (when a non-empty string) becomes the registered key', async () => {
  const out = await executeAsPolyfillConnectorRegister(
    { manifest: { connector_id: 'raw-id' } },
    { registerConnector: () => 'canonicalized-by-store' },
  );
  assert.equal(out.status, 201);
  assert.equal(out.envelope.connector_id, 'canonicalized-by-store', 'store-canonicalized key used');
  assert.equal(out.envelope.connector_key, 'canonicalized-by-store');
});
