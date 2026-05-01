/**
 * Validation coverage for connector `runtime_requirements.bindings`.
 *
 * These declarations are reference/polyfill deployment metadata. The
 * registry should reject malformed requirements so operators do not discover
 * missing runtime capabilities only after a connector has started.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function withHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

async function registerConnectorManifest(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  const text = await resp.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: resp.status, body };
}

function makeManifest(runtimeRequirements) {
  return {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.test/connectors/runtime-requirements-fixture',
    version: '0.1.0',
    display_name: 'Runtime requirements fixture',
    runtime_requirements: runtimeRequirements,
    streams: [
      {
        name: 'notes',
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            received_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'received_at'],
        },
        primary_key: ['id'],
        cursor_field: 'received_at',
        selection: { fields: true, resources: true },
      },
    ],
  };
}

test('valid browser runtime binding is accepted', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ bindings: { network: { required: true }, browser: { required: true } } }),
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test('unsupported runtime binding is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ bindings: { toaster: { required: true } } }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /unsupported keys: toaster/u);
  });
});

test('runtime binding required flag must be boolean', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ bindings: { browser: { required: 'yes' } } }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /browser\.required must be a boolean/u);
  });
});
