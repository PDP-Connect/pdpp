import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runConnector } from '../runtime/index.js';
import { startServer } from '../server/index.js';

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  return { status: resp.status, body: text ? JSON.parse(text) : null };
}

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      user_code: device.user_code,
      subject_id: subjectId,
    }).toString(),
  });
  assert.equal(approveResp.status, 200);

  const { body: token } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: device.device_code,
    }).toString(),
  });

  return token.access_token;
}

function makeManifest(connectorId = 'https://registry.pdpp.test/connectors/gap-severity') {
  return {
    protocol_version: '0.1.0',
    connector_id: connectorId,
    version: '0.1.0',
    display_name: 'Gap severity fixture',
    streams: [
      {
        name: 'items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        primary_key: ['id'],
      },
      {
        name: 'stars',
        availability: {
          state: 'unsupported_in_mode',
          mode: 'slackdump_archive',
          reason: 'archive mode does not expose stars',
          future_modes: ['api'],
        },
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
}

function createScopeAwareConnector(capturePath, { itemSkipReason = null } = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-gap-severity-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const capturePath = ${JSON.stringify(capturePath)};
const itemSkipReason = ${JSON.stringify(itemSkipReason)};
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  writeFileSync(capturePath, JSON.stringify(msg.scope, null, 2));
  const requested = new Set((msg.scope?.streams || []).map((stream) => stream.name));
  if (itemSkipReason && requested.has('items')) {
    process.stdout.write(JSON.stringify({
      type: 'SKIP_RESULT',
      stream: 'items',
      reason: itemSkipReason,
      message: 'items selected but unavailable',
    }) + '\\n');
  }
  if (requested.has('stars')) {
    process.stdout.write(JSON.stringify({
      type: 'SKIP_RESULT',
      stream: 'stars',
      reason: 'not_available',
      message: 'archive mode does not expose stars',
    }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    'utf8'
  );
  return { connectorPath, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

async function withRuntimeHarness(fn) {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = makeManifest();
  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, 'gap_severity_user');
    await fn({ manifest, ownerToken, rsUrl });
  } finally {
    await closeServer(server);
  }
}

test('default START.scope excludes unsupported-in-mode streams', async () => {
  await withRuntimeHarness(async ({ manifest, ownerToken, rsUrl }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-gap-scope-'));
    const capturePath = join(tmpDir, 'scope.json');
    const { connectorPath, cleanup } = createScopeAwareConnector(capturePath);
    try {
      const result = await runConnector({
        connectorPath,
        connectorId: manifest.connector_id,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl,
        onInteraction: async () => ({}),
      });

      const capturedScope = JSON.parse(readFileSync(capturePath, 'utf8'));
      assert.deepEqual(capturedScope.streams.map((stream) => stream.name), ['items']);
      assert.deepEqual(result.known_gaps, []);
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

test('explicit unsupported-in-mode stream skip is actionable', async () => {
  await withRuntimeHarness(async ({ manifest, ownerToken, rsUrl }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-gap-explicit-'));
    const capturePath = join(tmpDir, 'scope.json');
    const { connectorPath, cleanup } = createScopeAwareConnector(capturePath);
    try {
      const result = await runConnector({
        connectorPath,
        connectorId: manifest.connector_id,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'stars' }] },
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl,
        onInteraction: async () => ({}),
      });

      assert.equal(result.known_gaps.length, 1);
      assert.equal(result.known_gaps[0].stream, 'stars');
      assert.equal(result.known_gaps[0].reason, 'not_available');
      assert.equal(result.known_gaps[0].severity, 'actionable');
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

test('default-selected supported stream not_available stays actionable', async () => {
  await withRuntimeHarness(async ({ manifest, ownerToken, rsUrl }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-gap-supported-'));
    const capturePath = join(tmpDir, 'scope.json');
    const { connectorPath, cleanup } = createScopeAwareConnector(capturePath, { itemSkipReason: 'not_available' });
    try {
      const result = await runConnector({
        connectorPath,
        connectorId: manifest.connector_id,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl,
        onInteraction: async () => ({}),
      });

      assert.equal(result.known_gaps.length, 1);
      assert.equal(result.known_gaps[0].stream, 'items');
      assert.equal(result.known_gaps[0].reason, 'not_available');
      assert.equal(result.known_gaps[0].severity, 'actionable');
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

test('transient skip reasons are persisted with transient severity', async () => {
  await withRuntimeHarness(async ({ manifest, ownerToken, rsUrl }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-gap-transient-'));
    const capturePath = join(tmpDir, 'scope.json');
    const { connectorPath, cleanup } = createScopeAwareConnector(capturePath, { itemSkipReason: 'http_429' });
    try {
      const result = await runConnector({
        connectorPath,
        connectorId: manifest.connector_id,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl,
        onInteraction: async () => ({}),
      });

      assert.equal(result.known_gaps.length, 1);
      assert.equal(result.known_gaps[0].stream, 'items');
      assert.equal(result.known_gaps[0].severity, 'transient');
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
