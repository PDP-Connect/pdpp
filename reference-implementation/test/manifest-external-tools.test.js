/**
 * Validation coverage for connector `runtime_requirements.external_tools`.
 *
 * External subprocess tools are static deployment/supply-chain metadata.
 * The registry validates the declaration shape but does not execute tool
 * detection commands in this slice.
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

function makeManifest(externalTools) {
  return {
    protocol_version: '0.1.0',
    connector_id: 'https://registry.pdpp.test/connectors/external-tools-fixture',
    version: '0.1.0',
    display_name: 'External tools fixture',
    runtime_requirements: {
      bindings: { network: { required: true } },
      external_tools: externalTools,
    },
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

test('valid external tool declaration is accepted', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest([
        {
          name: 'slackdump',
          license: 'AGPL-3.0',
          purpose: 'Session-token Slack archive export',
          install_hint: 'go install github.com/rusq/slackdump/v4/cmd/slackdump@latest',
          detect: { command: 'slackdump version', exit_code: 0 },
        },
      ]),
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test('external_tools must be an array', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(asUrl, makeManifest({ name: 'slackdump' }));
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /external_tools must be an array/u);
  });
});

test('external tool declarations require name license and purpose', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest([{ name: 'slackdump', license: 'AGPL-3.0' }]),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /purpose must be a non-empty string/u);
  });
});

test('external tool detect command must be a non-empty string', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest([
        {
          name: 'slackdump',
          license: 'AGPL-3.0',
          purpose: 'Session-token Slack archive export',
          detect: { command: '', exit_code: 0 },
        },
      ]),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.match(body.error.message, /detect\.command must be a non-empty string/u);
  });
});
