// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation coverage for stream-level availability declarations.
 *
 * `availability` is reference/polyfill metadata used to distinguish connector
 * capability from run outcome. It keeps expected unsupported-in-mode streams
 * from being treated as selected-data loss.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
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

function makeManifest({ availability } = {}) {
  return {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.test/connectors/stream-availability',
    version: '0.1.0',
    display_name: 'Stream availability fixture',
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: 'items',
        semantics: 'mutable_state',
        ...(availability === undefined ? {} : { availability }),
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
}

test('valid unsupported-in-mode stream availability is accepted', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        availability: {
          state: 'unsupported_in_mode',
          mode: 'archive',
          reason: 'external archive does not expose this stream',
          future_modes: ['api'],
        },
      })
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test('unsupported-in-mode availability requires a mode', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        availability: {
          state: 'unsupported_in_mode',
          reason: 'missing mode should fail',
        },
      })
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /availability\.mode/);
  });
});

test('stream availability rejects unknown states and keys', async () => {
  await withHarness(async ({ asUrl }) => {
    const badState = await registerConnectorManifest(
      asUrl,
      makeManifest({
        availability: {
          state: 'maybe',
        },
      })
    );
    assert.equal(badState.status, 400);
    assert.match(badState.body.error.message, /availability\.state/);

    const unknownKey = await registerConnectorManifest(
      asUrl,
      makeManifest({
        availability: {
          state: 'supported',
          unsupported_reason: 'unknown key',
        },
      })
    );
    assert.equal(unknownKey.status, 400);
    assert.match(unknownKey.body.error.message, /unsupported keys/);
  });
});
