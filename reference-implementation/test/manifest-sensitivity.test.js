/**
 * Validation + resolution coverage for connector manifest `sensitivity`.
 *
 * `sensitivity: "standard" | "sensitive"` is the manifest-declared,
 * owner-facing source classification the batch consent ceremony reads for its
 * cumulative-risk header and approve-all suppression conditions (O5 owner
 * default in `implement-batch-consent-ceremony`). The registry accepts the
 * field, rejects malformed values, defaults absence to `standard`, and consults
 * no hardcoded source list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { resolveManifestSensitivity } from '../server/auth.js';

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

function makeManifest(extra = {}) {
  return {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.test/connectors/sensitivity-fixture',
    version: '0.1.0',
    display_name: 'Sensitivity fixture',
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
    ...extra,
  };
}

test('manifest declaring sensitivity "sensitive" is accepted', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ sensitivity: 'sensitive' }),
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test('manifest declaring sensitivity "standard" is accepted', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ sensitivity: 'standard' }),
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test('manifest omitting sensitivity is accepted (resolves to standard default)', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(asUrl, makeManifest());
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test('manifest with an unsupported sensitivity value is rejected', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ sensitivity: 'top_secret' }),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /sensitivity must be "standard" or "sensitive"/u);
  });
});

test('resolveManifestSensitivity defaults absence to standard and consults no hardcoded list', () => {
  // Absent → standard.
  assert.equal(resolveManifestSensitivity({}), 'standard');
  assert.equal(resolveManifestSensitivity({ sensitivity: undefined }), 'standard');
  // A connector whose name resembles a "sensitive" source is still standard
  // unless its manifest declares it — no hardcoded source list.
  assert.equal(resolveManifestSensitivity({ connector_key: 'gmail' }), 'standard');
  assert.equal(resolveManifestSensitivity({ connector_key: 'usaa' }), 'standard');
  // Declared sensitive → sensitive.
  assert.equal(resolveManifestSensitivity({ sensitivity: 'sensitive' }), 'sensitive');
  // Any non-`sensitive` value resolves to the standard default.
  assert.equal(resolveManifestSensitivity({ sensitivity: 'standard' }), 'standard');
});
