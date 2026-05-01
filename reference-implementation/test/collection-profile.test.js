/**
 * Collection Profile Conformance Tests
 *
 * Tests the connector runtime protocol against the normative requirements
 * in spec-collection-profile.md. These tests verify:
 *
 * 1. START message: runtime sends correct shape, connector receives it
 * 2. RECORD processing: records are ingested to the RS
 * 3. STATE handling: checkpoints committed only on successful DONE
 * 4. DONE message: runtime gates state persistence on DONE status
 * 5. Binding matching: runtime rejects connectors with unsatisfied bindings
 * 6. SKIP_RESULT: runtime handles intentional stream skips
 * 7. single_use: STATE not persisted for single_use runs
 * 8. Scope enforcement: START.scope does not exceed the grant
 *
 * Status: Normative conformance tests (derived from spec requirements)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runConnector, loadSyncState } from '../runtime/index.js';
import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

async function closeServer(server) {
  // Force-close keep-alive connections to prevent hanging.
  // Clear fallback timers when close callbacks win so the harness does not
  // retain stray timer handles after an otherwise clean shutdown.
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();

  const closeWithTimeout = (srv) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 2000);

    srv.close(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });

  await Promise.allSettled([
    closeWithTimeout(server.asServer),
    closeWithTimeout(server.rsServer),
  ]);
}

async function closeHttpServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

/**
 * Create a minimal test connector that emits specified messages.
 * Returns the path to the connector script.
 */
function createTestConnector(messages) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-connector-'));
  const connectorPath = join(tmpDir, 'connector.mjs');

  const script = `
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    const doneMessage = [...messages].reverse().find((message) => message.type === 'DONE') || null;
    const exitCode = !doneMessage
      ? 0
      : (doneMessage.status === 'succeeded' ? 0 : 1);
    for (const m of messages) {
      process.stdout.write(JSON.stringify(m) + '\\n');
    }
    // Exit after emitting all messages
    rl.close();
    process.exit(exitCode);
  }
});
`;

  writeFileSync(connectorPath, script, 'utf-8');
  return { connectorPath, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

function createStartCaptureConnector(capturePath) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-start-capture-'));
  const connectorPath = join(tmpDir, 'connector.mjs');

  const script = `
import { createInterface } from 'readline';
import { writeFileSync } from 'node:fs';

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(msg, null, 2));
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`;

  writeFileSync(connectorPath, script, 'utf-8');
  return { connectorPath, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

function createCollectionModeBranchConnector() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-collection-mode-branch-'));
  const connectorPath = join(tmpDir, 'connector.mjs');

  const script = `
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  const mode = msg.collection_mode;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'mode_' + mode,
    data: { id: 'mode_' + mode, value: mode },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`;

  writeFileSync(connectorPath, script, 'utf-8');
  return { connectorPath, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

function createScopeBranchConnector() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scope-branch-'));
  const connectorPath = join(tmpDir, 'connector.mjs');

  const script = `
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  const stream = msg.scope?.streams?.find((candidate) => candidate.name === 'items') || null;
  const resources = Array.isArray(stream?.resources) ? stream.resources : [];
  const since = stream?.time_range?.since || 'none';
  const recordId = resources[0] || 'scope_default';

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: recordId,
    data: {
      id: recordId,
      value: resources.join(','),
      since,
      source_updated_at: since,
    },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`;

  writeFileSync(connectorPath, script, 'utf-8');
  return { connectorPath, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

function createScopeFieldsBranchConnector() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-scope-fields-branch-'));
  const connectorPath = join(tmpDir, 'connector.mjs');

  const script = `
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  const stream = msg.scope?.streams?.find((candidate) => candidate.name === 'items') || null;
  const fields = Array.isArray(stream?.fields) ? stream.fields : [];
  const hasNormalizedFields =
    fields.includes('value')
    && fields.includes('id')
    && fields.includes('must_have')
    && fields.includes('source_updated_at');

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: hasNormalizedFields ? 'normalized_fields' : 'raw_fields',
    data: {
      id: hasNormalizedFields ? 'normalized_fields' : 'raw_fields',
      value: fields.join(','),
      must_have: hasNormalizedFields ? 'present' : 'missing',
      source_updated_at: '2026-01-01T00:00:00Z',
    },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`;

  writeFileSync(connectorPath, script, 'utf-8');
  return { connectorPath, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

const MINIMAL_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: 'https://registry.pdpp.org/connectors/test',
  version: '1.0.0',
  display_name: 'Test Connector',
  streams: [
    { name: 'items', semantics: 'append_only', schema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' } }, required: ['id'] }, primary_key: ['id'] },
  ],
};

function buildMultiStreamManifest(connectorId = 'https://registry.pdpp.org/connectors/test-multi-stream') {
  return {
    ...MINIMAL_MANIFEST,
    connector_id: connectorId,
    streams: [
      ...MINIMAL_MANIFEST.streams,
      {
        name: 'other_items',
        semantics: 'append_only',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id'],
        },
        primary_key: ['id'],
      },
    ],
  };
}

test('Collection Profile conformance', async (t) => {
  // ── 1. RECORD processing ──

  await t.test('runtime sends spec-shaped START with non-empty scope and no legacy config', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-start-capture-'));
    const capturePath = join(tmpDir, 'start.json');
    const { connectorPath, cleanup } = createStartCaptureConnector(capturePath);
    const scope = {
      streams: [
        { name: 'items', fields: ['id'], time_range: { since: '2026-01-01T00:00:00Z' } },
      ],
    };

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        scope,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
      assert.equal(captured.type, 'START');
      assert.deepEqual(captured.scope, scope);
      assert.equal(captured.collection_mode, 'incremental');
      assert.equal(captured.state, null);
      assert.deepEqual(captured.bindings, {
        network: {},
        filesystem: {},
        browser: {},
        interactive: {},
      });
      assert.ok(!('config' in captured), 'legacy START.config should be absent');
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('incremental runs pass prior state through START', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-start-state-capture-'));
    const capturePath = join(tmpDir, 'start.json');
    const { connectorPath, cleanup } = createStartCaptureConnector(capturePath);
    const previousState = { items: { cursor: '' } };

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        scope: { streams: [{ name: 'items' }] },
        state: previousState,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
      assert.equal(captured.type, 'START');
      assert.equal(captured.collection_mode, 'incremental');
      assert.deepEqual(captured.state, previousState);
      assert.ok(!('config' in captured), 'legacy START.config should be absent');
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('single_use runs ignore provided prior state and pass null through START', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-start-single-use-state-capture-'));
    const capturePath = join(tmpDir, 'start.json');
    const { connectorPath, cleanup } = createStartCaptureConnector(capturePath);
    const previousState = { items: { cursor: 'cursor_from_previous_run' } };

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        scope: { streams: [{ name: 'items' }] },
        state: previousState,
        collectionMode: 'incremental',
        persistState: false,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
      assert.equal(captured.type, 'START');
      assert.equal(captured.collection_mode, 'incremental');
      assert.equal(captured.state, null);
      assert.ok(!('config' in captured), 'legacy START.config should be absent');
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects explicitly empty START.scope instead of broadening to all manifest streams', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: { streams: [] },
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.scope must include a non-empty streams array/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime rejects wildcard stream names in explicit START.scope', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: {
            streams: [{ name: '*' }],
          },
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.scope must not include wildcard stream names/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime rejects explicit START.scope streams that do not exist in the manifest', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: {
            streams: [{ name: 'missing_stream' }],
          },
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.scope stream 'missing_stream' does not exist in the manifest/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime rejects invalid START.collection_mode values instead of passing them through', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: { streams: [{ name: 'items' }] },
          state: null,
          collectionMode: 'delta_sync',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.collection_mode must be 'full_refresh' or 'incremental'/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime rejects invalid START.state shapes instead of passing them through', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: { streams: [{ name: 'items' }] },
          state: ['not', 'a', 'state', 'object'],
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.state must be an object or null/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime rejects scalar START.state stream cursors instead of passing them through', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: { streams: [{ name: 'items' }] },
          state: { items: 'scalar_cursor' },
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.state stream 'items' must be an object or null/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime rejects malformed START.scope resources selectors instead of passing them through', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: {
            streams: [{ name: 'items', resources: [123] }],
          },
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.scope stream 'items' resources must be an array of strings/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime rejects malformed START.scope fields selectors instead of passing them through', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: {
            streams: [{ name: 'items', fields: ['id', ''] }],
          },
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.scope stream 'items' fields must be an array of non-empty field names/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime rejects malformed START.scope time_range selectors instead of passing them through', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: {
            streams: [{ name: 'items', time_range: { since: '' } }],
          },
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.scope stream 'items' time_range bounds must be non-empty strings/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime rejects unresolved START.scope view selectors instead of passing them through', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: {
            streams: [{ name: 'items', view: 'summary' }],
          },
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.scope stream 'items' must not include unresolved view names/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime rejects issuance-time START.scope necessity values instead of passing them through', async () => {
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: MINIMAL_MANIFEST,
          scope: {
            streams: [{ name: 'items', necessity: 'required' }],
          },
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /START\.scope stream 'items' must not include issuance-time necessity values/
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime normalizes START.scope fields to include schema-required, primary_key, and time_range fields', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const manifest = {
      ...MINIMAL_MANIFEST,
      connector_id: 'https://registry.pdpp.org/connectors/test-start-field-normalization',
      streams: [
        {
          name: 'items',
          semantics: 'append_only',
          consent_time_field: 'source_updated_at',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
              source_updated_at: { type: 'string' },
            },
            required: ['value'],
          },
          primary_key: ['id'],
        },
      ],
    };
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-start-field-normalization-'));
    const capturePath = join(tmpDir, 'start.json');
    const { connectorPath, cleanup } = createStartCaptureConnector(capturePath);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: {
          streams: [
            {
              name: 'items',
              fields: ['value'],
              time_range: { since: '2026-01-01T00:00:00Z' },
            },
          ],
        },
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
      assert.deepEqual(captured.scope, {
        streams: [
          {
            name: 'items',
            fields: ['value', 'id', 'source_updated_at'],
            time_range: { since: '2026-01-01T00:00:00Z' },
          },
        ],
      });
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('connectors can branch on START.collection_mode', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const { connectorPath, cleanup } = createCollectionModeBranchConnector();

    try {
      const incrementalResult = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: { items: { cursor: 'cursor_from_previous_run' } },
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      const refreshResult = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(incrementalResult.status, 'succeeded');
      assert.equal(refreshResult.status, 'succeeded');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const incrementalRecord = records.find((record) => record.data?.id === 'mode_incremental');
      const refreshRecord = records.find((record) => record.data?.id === 'mode_full_refresh');

      assert.equal(incrementalRecord?.data?.value, 'incremental');
      assert.equal(refreshRecord?.data?.value, 'full_refresh');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('connectors can branch on START.scope resources and time_range selectors', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const manifest = {
      ...MINIMAL_MANIFEST,
      connector_id: 'https://registry.pdpp.org/connectors/test-scope-branch',
      streams: [
        {
          name: 'items',
          semantics: 'append_only',
          consent_time_field: 'source_updated_at',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
              since: { type: 'string' },
              source_updated_at: { type: 'string' },
            },
            required: ['id'],
          },
          primary_key: ['id'],
        },
      ],
    };
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const { connectorPath, cleanup } = createScopeBranchConnector();

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: {
          streams: [
            {
              name: 'items',
              resources: ['item_1', 'item_2'],
              time_range: { since: '2026-01-01T00:00:00Z' },
            },
          ],
        },
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const scopedRecord = records.find((record) => record.data?.id === 'item_1');

      assert.equal(scopedRecord?.data?.value, 'item_1,item_2');
      assert.equal(scopedRecord?.data?.since, '2026-01-01T00:00:00Z');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('connectors can branch on normalized START.scope fields selectors', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const manifest = {
      ...MINIMAL_MANIFEST,
      connector_id: 'https://registry.pdpp.org/connectors/test-scope-fields-branch',
      streams: [
        {
          name: 'items',
          semantics: 'append_only',
          consent_time_field: 'source_updated_at',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
              must_have: { type: 'string' },
              source_updated_at: { type: 'string', format: 'date-time' },
            },
            required: ['id', 'must_have'],
          },
          primary_key: ['id'],
        },
      ],
    };
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const { connectorPath, cleanup } = createScopeFieldsBranchConnector();

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: {
          streams: [
            {
              name: 'items',
              fields: ['value'],
              time_range: { since: '2026-01-01T00:00:00Z' },
            },
          ],
        },
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');

      const recordsResp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=10`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(recordsResp.status, 200);
      const recordsBody = await recordsResp.json();
      const record = (recordsBody.data || recordsBody.records || []).find((candidate) => candidate.data?.id === 'normalized_fields');

      assert.ok(record, 'the connector should observe normalized START.scope.fields and branch onto the normalized path');
      assert.equal(record.data.must_have, 'present');
      assert.deepEqual(
        record.data.value.split(','),
        ['value', 'id', 'must_have', 'source_updated_at'],
        'START.scope.fields should include requested, primary-key, required, and time-range validation fields before delivery',
      );
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime ingests RECORD messages to the RS', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'item_1', data: { id: 'item_1', value: 'hello' }, emitted_at: new Date().toISOString() },
      { type: 'RECORD', stream: 'items', key: 'item_2', data: { id: 'item_2', value: 'world' }, emitted_at: new Date().toISOString() },
      { type: 'DONE', status: 'succeeded', records_emitted: 2 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.records_emitted, 2);
      assert.equal(result.checkpoint_summary.mode, 'checkpointed_streaming');
      assert.equal(result.checkpoint_summary.commit_status, 'committed');
      assert.equal(result.checkpoint_summary.records_flushed, 2);
      assert.equal(result.checkpoint_summary.buffered_records_dropped, 0);
      assert.equal(result.checkpoint_summary.state_streams_staged, 0);
      assert.equal(result.checkpoint_summary.state_streams_committed, 0);

      // Verify records are in the RS (owner queries need connector_id)
      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      assert.ok((body.data || body.records || []).length >= 2, 'RS should have at least 2 records');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  // ── 2. STATE gating on DONE ──

  await t.test('STATE is only committed when DONE status is succeeded', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    // Connector emits STATE but then DONE with failed status
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'item_1', data: { id: 'item_1', value: 'test' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'cursor_should_not_persist' } },
      { type: 'DONE', status: 'failed', records_emitted: 1 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.checkpoint_summary.mode, 'checkpointed_streaming');
      assert.equal(result.checkpoint_summary.commit_status, 'not_committed');
      assert.equal(result.checkpoint_summary.records_flushed, 1);
      assert.equal(result.checkpoint_summary.buffered_records_dropped, 0);
      assert.equal(result.checkpoint_summary.state_streams_staged, 1);
      assert.equal(result.checkpoint_summary.state_streams_committed, 0);

      // STATE should NOT have been committed
      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items || state.items.cursor !== 'cursor_should_not_persist',
        'STATE should not be persisted when DONE status is failed');

      const asUrl = `http://localhost:${asPort}`;
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.failed'));
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.equal(failedEvent.data.reason, 'connector_reported_failed');
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects scalar STATE.cursor values as protocol violations', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'STATE', stream: 'items', cursor: 'scalar_cursor' },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => ({}),
          });
        },
        /Connector emitted invalid STATE\.cursor: expected object or null/
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'invalid STATE.cursor values must not stage or persist checkpoints');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('the last STATE for a stream wins when a run stages multiple checkpoints', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'item_1', data: { id: 'item_1', value: 'first' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'cursor_1' } },
      { type: 'RECORD', stream: 'items', key: 'item_2', data: { id: 'item_2', value: 'second' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'cursor_2' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 2 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.checkpoint_summary.records_flushed, 2);
      assert.equal(result.checkpoint_summary.state_streams_staged, 1);
      assert.equal(result.checkpoint_summary.state_streams_committed, 1);

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.deepEqual(state.items, { cursor: 'cursor_2' }, 'the latest staged cursor should be the committed checkpoint');

      const asUrl = `http://localhost:${asPort}`;
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const stagedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_staged');
      assert.equal(stagedEvents.length, 2);
      assert.deepEqual(stagedEvents[0].data.cursor, { cursor: 'cursor_1' });
      assert.deepEqual(stagedEvents[1].data.cursor, { cursor: 'cursor_2' });

      const advancedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.state_advanced');
      assert.ok(advancedEvent);
      assert.deepEqual(advancedEvent.data.cursor, { cursor: 'cursor_2' });
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('STATE currently flushes and stages only the named stream when other streams still have buffered records', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const manifest = buildMultiStreamManifest('https://registry.pdpp.org/connectors/test-multi-stream-state-boundary');
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-cross-stream-state-boundary-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'stream_items_1',
    data: { id: 'stream_items_1', value: 'items value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'other_items',
    key: 'stream_other_1',
    data: { id: 'stream_other_1', value: 'other value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'cursor_items_1' },
  }) + '\\n');
  process.stderr.write('connector crashed after staging one stream checkpoint\\n');
  rl.close();
  process.exit(1);
});
`, 'utf-8');

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.exit_code, 1);
      assert.equal(result.checkpoint_summary.records_flushed, 1);
      assert.equal(result.checkpoint_summary.buffered_records_dropped, 1);
      assert.equal(result.checkpoint_summary.state_streams_staged, 1);
      assert.equal(result.checkpoint_summary.state_streams_committed, 0);

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || (!state.items && !state.other_items), 'no checkpoint should persist when the connector exits without DONE');

      const itemsResp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const itemsBody = await itemsResp.json();
      const itemsFound = (itemsBody.data || itemsBody.records || []).find((record) => record.data?.id === 'stream_items_1');
      assert.ok(itemsFound, 'the named stream should have been flushed when STATE was emitted');

      const otherResp = await fetch(`http://localhost:${rsPort}/v1/streams/other_items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const otherBody = await otherResp.json();
      const otherFound = (otherBody.data || otherBody.records || []).find((record) => record.data?.id === 'stream_other_1');
      assert.ok(!otherFound, 'other buffered streams should remain unflushed');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const stagedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_staged');
      assert.equal(stagedEvents.length, 1);
      assert.equal(stagedEvents[0].stream_id, 'items');
      assert.deepEqual(stagedEvents[0].data.cursor, { cursor: 'cursor_items_1' });

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent);
      assert.equal(failedEvent.data.reason, 'connector_exit_without_done');
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 1);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('multiple staged stream checkpoints commit successfully without requiring a cross-stream ordering guarantee', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const manifest = buildMultiStreamManifest('https://registry.pdpp.org/connectors/test-multi-stream-checkpoint-success');
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'stream_items_success', data: { id: 'stream_items_success', value: 'items success' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'cursor_items_success' } },
      { type: 'RECORD', stream: 'other_items', key: 'stream_other_success', data: { id: 'stream_other_success', value: 'other success' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'other_items', cursor: { cursor: 'cursor_other_success' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 2 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.checkpoint_summary.records_flushed, 2);
      assert.equal(result.checkpoint_summary.buffered_records_dropped, 0);
      assert.equal(result.checkpoint_summary.state_streams_staged, 2);
      assert.equal(result.checkpoint_summary.state_streams_committed, 2);

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.deepEqual(state.items, { cursor: 'cursor_items_success' });
      assert.deepEqual(state.other_items, { cursor: 'cursor_other_success' });

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const stagedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_staged');
      const advancedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_advanced');

      assert.equal(stagedEvents.length, 2);
      assert.equal(advancedEvents.length, 2);
      assert.deepEqual(
        new Set(stagedEvents.map((event) => `${event.stream_id}:${event.data.cursor.cursor}`)),
        new Set(['items:cursor_items_success', 'other_items:cursor_other_success']),
      );
      assert.deepEqual(
        new Set(advancedEvents.map((event) => `${event.stream_id}:${event.data.cursor.cursor}`)),
        new Set(['items:cursor_items_success', 'other_items:cursor_other_success']),
      );
      assert.deepEqual(
        advancedEvents
          .map((event) => event.data.state_streams_committed)
          .sort((a, b) => a - b),
        [1, 2],
      );
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('multiple staged stream checkpoints still commit nothing when the run fails after staging', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const manifest = buildMultiStreamManifest('https://registry.pdpp.org/connectors/test-multi-stream-checkpoint-failure');
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-multi-stream-checkpoint-failure-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'stream_items_failed_checkpoint',
    data: { id: 'stream_items_failed_checkpoint', value: 'items failed checkpoint' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'cursor_items_failed' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'other_items',
    key: 'stream_other_failed_checkpoint',
    data: { id: 'stream_other_failed_checkpoint', value: 'other failed checkpoint' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'other_items',
    cursor: { cursor: 'cursor_other_failed' },
  }) + '\\n');
  process.stderr.write('connector crashed after staging two stream checkpoints\\n');
  rl.close();
  process.exit(1);
});
`, 'utf-8');

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.exit_code, 1);
      assert.equal(result.checkpoint_summary.records_flushed, 2);
      assert.equal(result.checkpoint_summary.buffered_records_dropped, 0);
      assert.equal(result.checkpoint_summary.state_streams_staged, 2);
      assert.equal(result.checkpoint_summary.state_streams_committed, 0);

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || (!state.items && !state.other_items), 'no stream checkpoint should persist when the run exits without DONE');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const stagedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_staged');
      const advancedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_advanced');

      assert.equal(stagedEvents.length, 2);
      assert.equal(advancedEvents.length, 0);
      assert.deepEqual(
        new Set(stagedEvents.map((event) => `${event.stream_id}:${event.data.cursor.cursor}`)),
        new Set(['items:cursor_items_failed', 'other_items:cursor_other_failed']),
      );

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent);
      assert.equal(failedEvent.data.reason, 'connector_exit_without_done');
      assert.equal(failedEvent.data.records_flushed, 2);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 2);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('checkpoint persistence failures after DONE(succeeded) stay inspectable and expose partial commit counts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const asUrl = `http://localhost:${server.asPort}`;
    const connectorId = 'https://test/partial-checkpoint-commit';
    const manifest = {
      connector_id: connectorId,
      version: '0.1.0',
      streams: [
        {
          name: 'items',
          primary_key: ['id'],
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['id'],
          },
        },
        {
          name: 'other_items',
          primary_key: ['id'],
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['id'],
          },
        },
      ],
    };

    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, 'partial_checkpoint_user');

    let stateWriteCount = 0;
    const committedStates = [];
    const rsServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'POST' && url.pathname.startsWith('/v1/ingest/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ records_accepted: 1, records_rejected: 0 }));
        return;
      }

      if (req.method === 'PUT' && url.pathname === `/v1/state/${encodeURIComponent(connectorId)}`) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

        stateWriteCount += 1;
        if (stateWriteCount === 1) {
          committedStates.push(body.state);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated_state_write_failure' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    await new Promise((resolve) => rsServer.listen(0, resolve));
    const rsUrl = `http://localhost:${rsServer.address().port}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'partial_commit_item', data: { id: 'partial_commit_item', value: 'items value' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'items_cursor_partial_commit' } },
      { type: 'RECORD', stream: 'other_items', key: 'partial_commit_other_item', data: { id: 'partial_commit_other_item', value: 'other value' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'other_items', cursor: { cursor: 'other_items_cursor_partial_commit' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 2 },
    ]);

    try {
      let capturedError = null;
      try {
        await runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl,
          onInteraction: async () => ({}),
        });
        assert.fail('expected checkpoint persistence to fail on the second state commit');
      } catch (err) {
        capturedError = err;
      }

      assert.ok(capturedError, 'expected checkpoint persistence failure');
      assert.equal(capturedError.failure_reason, 'runtime_error');
      assert.equal(capturedError.terminal_reason, 'runtime_error');
      assert.equal(capturedError.checkpoint_summary.state_streams_staged, 2);
      assert.equal(capturedError.checkpoint_summary.state_streams_committed, 1);
      assert.equal(capturedError.checkpoint_summary.commit_status, 'partially_committed');
      assert.match(capturedError.message, /State persistence failed for other_items: 500/);
      assert.deepEqual(committedStates, [{ items: { cursor: 'items_cursor_partial_commit' } }]);

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(runTypes.includes('run.state_advanced'));
      assert.ok(runTypes.includes('run.state_commit_failed'));
      assert.ok(runTypes.includes('run.failed'));
      assert.ok(!runTypes.includes('run.completed'));

      const advancedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_advanced');
      assert.equal(advancedEvents.length, 1);
      assert.equal(advancedEvents[0].stream_id, 'items');
      assert.equal(advancedEvents[0].data.state_streams_committed, 1);

      const commitFailedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_commit_failed');
      assert.equal(commitFailedEvents.length, 1);
      assert.equal(commitFailedEvents[0].stream_id, 'other_items');
      assert.deepEqual(commitFailedEvents[0].data.cursor, { cursor: 'other_items_cursor_partial_commit' });
      assert.equal(commitFailedEvents[0].data.state_streams_staged, 2);
      assert.equal(commitFailedEvents[0].data.state_streams_committed, 1);
      assert.match(commitFailedEvents[0].data.error_message, /State persistence failed for other_items: 500/);

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted when checkpoint persistence fails after DONE');
      assert.equal(failedEvent.data.reason, 'runtime_error');
      assert.equal(failedEvent.data.state_streams_staged, 2);
      assert.equal(failedEvent.data.state_streams_committed, 1);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'partially_committed');
    } finally {
      cleanup();
      await closeHttpServer(rsServer);
      await closeServer(server);
    }
  });

  // ── 3. single_use: null START.state and no STATE persistence ──

  await t.test('single_use runs do not persist STATE even on success', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'item_1', data: { id: 'item_1', value: 'single' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'should_not_persist' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: false, // single_use
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.checkpoint_summary.mode, 'checkpointed_streaming');
      assert.equal(result.checkpoint_summary.commit_status, 'disabled');
      assert.equal(result.checkpoint_summary.records_flushed, 1);
      assert.equal(result.checkpoint_summary.buffered_records_dropped, 0);
      assert.equal(result.checkpoint_summary.state_streams_staged, 1);
      assert.equal(result.checkpoint_summary.state_streams_committed, 0);

      // STATE should not be persisted
      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items,
        'single_use runs should not persist STATE');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('grant-scoped STATE stays isolated from global state and other grants', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;
    const grantAId = await createGrant(asUrl, connectorId, 'test_user');
    const grantBId = await createGrant(asUrl, connectorId, 'test_user');

    const { connectorPath: grantPath, cleanup: cleanupGrant } = createTestConnector([
      { type: 'STATE', stream: 'items', cursor: { cursor: 'cursor_from_grant_a' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    const { connectorPath: globalPath, cleanup: cleanupGlobal } = createTestConnector([
      { type: 'STATE', stream: 'items', cursor: { cursor: 'cursor_from_global' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await runConnector({
        connectorPath: grantPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        grantId: grantAId,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      const grantAState = await loadSyncState(connectorId, ownerToken, {
        rsUrl: `http://localhost:${rsPort}`,
        grantId: grantAId,
      });
      const grantBState = await loadSyncState(connectorId, ownerToken, {
        rsUrl: `http://localhost:${rsPort}`,
        grantId: grantBId,
      });
      const globalBefore = await loadSyncState(connectorId, ownerToken, {
        rsUrl: `http://localhost:${rsPort}`,
      });

      assert.deepEqual(grantAState.items, { cursor: 'cursor_from_grant_a' }, 'grant A should see its own checkpoint');
      assert.ok(!grantBState || !grantBState.items, 'grant B should not see grant A state');
      assert.ok(!globalBefore || !globalBefore.items, 'global state should stay empty after a grant-scoped run');

      await runConnector({
        connectorPath: globalPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      const grantAAfterGlobal = await loadSyncState(connectorId, ownerToken, {
        rsUrl: `http://localhost:${rsPort}`,
        grantId: grantAId,
      });
      const globalAfter = await loadSyncState(connectorId, ownerToken, {
        rsUrl: `http://localhost:${rsPort}`,
      });

      assert.deepEqual(globalAfter.items, { cursor: 'cursor_from_global' }, 'global state should persist in the connector namespace');
      assert.deepEqual(grantAAfterGlobal.items, { cursor: 'cursor_from_grant_a' }, 'grant-scoped state should survive an unrelated global run');
    } finally {
      cleanupGrant();
      cleanupGlobal();
      await closeServer(server);
    }
  });

  await t.test('single_use with grant-scoped STATE still persists nothing', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;
    const grantId = await createGrant(asUrl, connectorId, 'test_user');

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'STATE', stream: 'items', cursor: { cursor: 'should_not_persist_grant_state' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'incremental',
        persistState: false,
        grantId,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      const grantState = await loadSyncState(connectorId, ownerToken, {
        rsUrl: `http://localhost:${rsPort}`,
        grantId,
      });
      const globalState = await loadSyncState(connectorId, ownerToken, {
        rsUrl: `http://localhost:${rsPort}`,
      });

      assert.ok(!grantState || !grantState.items, 'grant-scoped state should not persist for single_use runs');
      assert.ok(!globalState || !globalState.items, 'single_use grant runs should not leak into global state');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects RECORD messages outside declared START.scope', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'outside_scope', key: 'bad_1', data: { id: 'bad_1', value: 'oops' }, emitted_at: new Date().toISOString() },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          scope: { streams: [{ name: 'items' }] },
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        /undeclared stream/i
      );
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects RECORD messages outside declared START.scope resources', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'item_2', data: { id: 'item_2', value: 'oops' }, emitted_at: new Date().toISOString() },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          scope: { streams: [{ name: 'items', resources: ['item_1'] }] },
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        /outside declared resources/i
      );
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects RECORD messages with fields outside START.scope', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'item_1', data: { id: 'item_1', value: 'extra-field' }, emitted_at: new Date().toISOString() },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          scope: { streams: [{ name: 'items', fields: ['id'] }] },
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        /fields outside START\.scope/i
      );
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects RECORD messages outside declared START.scope time_range', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const manifest = {
      ...MINIMAL_MANIFEST,
      connector_id: 'https://registry.pdpp.org/connectors/test-time-range',
      streams: [
        {
          name: 'items',
          semantics: 'append_only',
          consent_time_field: 'source_updated_at',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              source_updated_at: { type: 'string' },
            },
            required: ['id', 'source_updated_at'],
          },
          primary_key: ['id'],
        },
      ],
    };
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'RECORD',
        stream: 'items',
        key: 'item_old',
        data: { id: 'item_old', source_updated_at: '2025-12-31T23:59:59Z' },
        emitted_at: new Date().toISOString(),
      },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest,
          scope: {
            streams: [
              {
                name: 'items',
                time_range: { since: '2026-01-01T00:00:00Z' },
              },
            ],
          },
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        /outside declared time_range/i
      );
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  // ── 4. Binding matching ──

  await t.test('runtime rejects connectors with unsatisfied required bindings', async () => {
    const manifestWithBinding = {
      ...MINIMAL_MANIFEST,
      runtime_requirements: {
        bindings: {
          browser_automation: { required: true },
        },
      },
    };

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId: 'test',
          ownerToken: 'test',
          manifest: manifestWithBinding,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: 'http://localhost:9999',
          onInteraction: async () => ({}),
        }),
        /binding/i,
        'Should reject when required binding is not available'
      );
    } finally {
      cleanup();
    }
  });

  await t.test('runtime satisfies required interactive bindings and advertises them in START', async () => {
    const manifestWithInteractiveBinding = {
      ...MINIMAL_MANIFEST,
      runtime_requirements: {
        bindings: {
          interactive: { required: true },
        },
      },
    };

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-interactive-binding-capture-'));
    const capturePath = join(tmpDir, 'start.json');
    const { connectorPath, cleanup } = createStartCaptureConnector(capturePath);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId: 'test',
        ownerToken: 'test',
        manifest: manifestWithInteractiveBinding,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: 'http://localhost:9999',
        onInteraction: async () => ({
          type: 'INTERACTION_RESPONSE',
          request_id: 'unused',
          status: 'success',
          data: {},
        }),
      });

      assert.equal(result.status, 'succeeded');
      const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
      assert.deepEqual(captured.bindings, {
        network: {},
        filesystem: {},
        browser: {},
        interactive: {},
      });
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('runtime omits interactive from START.bindings when interaction handling is explicitly disabled', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-no-interactive-binding-capture-'));
    const capturePath = join(tmpDir, 'start.json');
    const { connectorPath, cleanup } = createStartCaptureConnector(capturePath);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId: 'test',
        ownerToken: 'test',
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: 'http://localhost:9999',
        onInteraction: null,
      });

      assert.equal(result.status, 'succeeded');
      const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
      assert.deepEqual(captured.bindings, {
        network: {},
        filesystem: {},
        browser: {},
      });
    } finally {
      cleanup();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── 5. SKIP_RESULT handling ──

  await t.test('runtime accepts SKIP_RESULT messages without error', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'SKIP_RESULT', stream: 'items', reason: 'rate_limited', message: 'Platform returned 429' },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.records_emitted, 0);

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const skippedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.stream_skipped');
      assert.ok(skippedEvent, 'expected run.stream_skipped event');
      assert.equal(skippedEvent.status, 'skipped');
      assert.equal(skippedEvent.stream_id, 'items');
      assert.equal(skippedEvent.data.source?.kind, 'connector');
      assert.equal(skippedEvent.data.source?.id, connectorId);
      assert.equal(skippedEvent.data.reason, 'rate_limited');
      assert.equal(skippedEvent.data.message, 'Platform returned 429');
      assert.equal(skippedEvent.data.known_gap.kind, 'skip_result');
      assert.equal(skippedEvent.data.known_gap.recovery_hint.action, 'retry_by_runtime');

      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      assert.ok(completedEvent, 'expected run.completed event');
      assert.equal(completedEvent.data.known_gaps.length, 1);
      assert.equal(completedEvent.data.known_gaps[0].reason, 'rate_limited');
      assert.deepEqual(completedEvent.data.known_gaps_summary.by_reason, { rate_limited: 1 });
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime reports known gaps for partial flush then failed terminal state', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'RECORD',
        stream: 'items',
        key: 'partial_1',
        data: { id: 'partial_1', value: 'landed before failure' },
        emitted_at: new Date().toISOString(),
      },
      { type: 'STATE', stream: 'items', cursor: { last_id: 'partial_1' } },
      {
        type: 'DONE',
        status: 'failed',
        records_emitted: 1,
        error: { message: 'password=supersecret upstream 500', retryable: true },
      },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.records_emitted, 1);
      assert.ok(result.known_gaps.some((gap) => gap.kind === 'run_failed'));

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event');
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      assert.ok(failedEvent.data.known_gaps.some((gap) => gap.kind === 'run_failed'));
      assert.ok(failedEvent.data.known_gaps.some((gap) => gap.kind === 'checkpoint_commit'));
      const runFailedGap = failedEvent.data.known_gaps.find((gap) => gap.kind === 'run_failed');
      assert.match(runFailedGap.message, /\[REDACTED\]/);
      assert.doesNotMatch(JSON.stringify(failedEvent.data.known_gaps), /supersecret/);
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime reports manual-action known gaps without persisting interaction responses', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-manual-gap-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'manual_login',
      stream: 'items',
      kind: 'manual_action',
      message: 'Complete platform login',
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({
      type: 'DONE',
      status: 'cancelled',
      records_emitted: 0,
      error: { message: 'manual login cancelled', retryable: false },
    }) + '\\n');
    rl.close();
    process.exit(1);
  }
});
`, 'utf-8');

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({
          type: 'INTERACTION_RESPONSE',
          request_id: 'manual_login',
          status: 'cancelled',
          data: { password: 'supersecret', otp: '123456' },
        }),
      });

      assert.equal(result.status, 'cancelled');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for cancelled terminal status');
      const interactionGap = failedEvent.data.known_gaps.find((gap) => gap.kind === 'interaction_required');
      assert.ok(interactionGap, 'expected interaction-required known gap');
      assert.equal(interactionGap.recovery_hint.action, 'manual_action_required');
      assert.doesNotMatch(JSON.stringify(runTimeline.data), /supersecret|123456/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects malformed SKIP_RESULT envelopes as protocol violations', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'SKIP_RESULT', stream: 'items', reason: '', message: 'missing reason content should fail' },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /invalid SKIP_RESULT\.reason/);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.stream_skipped'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for malformed SKIP_RESULT envelopes');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects SKIP_RESULT for undeclared streams as a protocol violation', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'SKIP_RESULT', stream: 'undeclared_items', reason: 'rate_limited', message: 'wrong stream should fail' },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /SKIP_RESULT for undeclared stream/);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.stream_skipped'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for undeclared-stream SKIP_RESULT envelopes');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime accepts PROGRESS messages without error', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;
    const seenProgress = [];

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'PROGRESS', stream: 'items', message: 'Fetching first page', count: 1, total: 3 },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
        onProgress: (msg) => {
          if (msg.type === 'PROGRESS') seenProgress.push(msg);
        },
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(seenProgress.length, 1);
      assert.equal(seenProgress[0].stream, 'items');
      assert.equal(seenProgress[0].message, 'Fetching first page');
      assert.equal(seenProgress[0].count, 1);
      assert.equal(seenProgress[0].total, 3);

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const progressEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.progress_reported');
      assert.ok(progressEvent, 'expected run.progress_reported event');
      assert.equal(progressEvent.status, 'in_progress');
      assert.equal(progressEvent.stream_id, 'items');
      assert.equal(progressEvent.data.source?.kind, 'connector');
      assert.equal(progressEvent.data.source?.id, connectorId);
      assert.equal(progressEvent.data.message, 'Fetching first page');
      assert.equal(progressEvent.data.count, 1);
      assert.equal(progressEvent.data.total, 3);
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects malformed PROGRESS envelopes as protocol violations', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'PROGRESS', stream: 'items', message: 42 },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          return true;
        },
      );

      assert.ok(capturedError?.run_id, 'protocol-violation errors should expose run_id for reference inspection');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.progress_reported'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for malformed PROGRESS envelopes');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects malformed PROGRESS counters as protocol violations', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'PROGRESS', stream: 'items', message: 'Fetching page', count: -1, total: 3 },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /invalid PROGRESS\.count/);
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          return true;
        },
      );

      assert.ok(capturedError?.run_id, 'protocol-violation errors should expose run_id for reference inspection');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.progress_reported'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for malformed PROGRESS counters');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects malformed PROGRESS total counters as protocol violations', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'PROGRESS', stream: 'items', message: 'Fetching page', count: 1, total: -3 },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /invalid PROGRESS\.total/);
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          return true;
        },
      );

      assert.ok(capturedError?.run_id, 'protocol-violation errors should expose run_id for reference inspection');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.progress_reported'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for malformed PROGRESS totals');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects PROGRESS for undeclared streams as a protocol violation', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'PROGRESS', stream: 'undeclared_items', message: 'wrong stream should fail' },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /PROGRESS for undeclared stream/);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.progress_reported'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for undeclared-stream PROGRESS envelopes');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');

      // Structured violation shape (vertical slice: progress_for_undeclared_stream).
      // These assertions make the "what exactly violated" answer machine-readable
      // and persisted in the timeline artifact, not just an opaque reason.
      const violation = failedEvent.data.violation;
      assert.ok(violation, 'run.failed should carry a structured data.violation');
      assert.equal(violation.subtype, 'progress_for_undeclared_stream');
      assert.equal(violation.message_type, 'PROGRESS');
      assert.equal(violation.stream, 'undeclared_items');
      assert.equal(violation.received, 'undeclared_items');
      assert.ok(Array.isArray(violation.expected), 'violation.expected should be a list');
      assert.ok(
        violation.expected.includes('items'),
        `violation.expected should list declared streams; got ${JSON.stringify(violation.expected)}`,
      );
      assert.ok(
        !violation.expected.includes('undeclared_items'),
        'violation.expected must not include the offending stream',
      );
      // Anchor: the violation happened immediately after run.started (no other
      // events preceded it in this fixture).
      assert.equal(violation.last_valid_event_type, 'run.started');
      assert.ok(
        typeof violation.last_valid_event_id === 'string' && violation.last_valid_event_id.startsWith('evt_'),
        `violation.last_valid_event_id should be a spine event id; got ${violation.last_valid_event_id}`,
      );
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects unknown connector message types as protocol violations', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'UNKNOWN_EVENT', detail: 'not part of the Collection Profile' },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      assert.equal((body.data || body.records || []).length, 0, 'unknown messages should fail the run before any durable write');

      assert.ok(capturedError?.run_id, 'protocol-violation errors should expose run_id for reference inspection');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for unknown connector messages');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects invalid connector JSONL as a protocol violation', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-invalid-jsonl-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write('this is not valid jsonl\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      assert.equal((body.data || body.records || []).length, 0, 'invalid JSONL should fail the run before any durable write');

      assert.ok(capturedError?.run_id, 'invalid-JSONL errors should expose run_id for reference inspection');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for invalid connector JSONL');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  // ── 6. INTERACTION completes and connector continues ──

  await t.test('INTERACTION round-trip allows connector to continue collecting', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    // Connector that emits INTERACTION, waits for response, then emits RECORD + DONE
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-roundtrip-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({ type: 'INTERACTION', request_id: 'int_1', kind: 'credentials', message: 'Enter password', schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] }, timeout_seconds: 300 }) + '\\n');
  } else if (msg.type === 'INTERACTION_RESPONSE') {
    // Got the response, now collect data
    process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'items', key: 'post_int', data: { id: 'post_int', value: 'after_interaction' }, emitted_at: new Date().toISOString() }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`, 'utf-8');

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async (msg) => {
          assert.equal(msg.kind, 'credentials');
          assert.equal(msg.message, 'Enter password');
          assert.equal(msg.timeout_seconds, 300);
          return { type: 'INTERACTION_RESPONSE', request_id: msg.request_id, status: 'success', data: { password: 'test123' } };
        },
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.records_emitted, 1);

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const interactionRequired = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_required');
      assert.ok(interactionRequired, 'expected run.interaction_required event');
      assert.equal(interactionRequired.data.kind, 'credentials');
      assert.equal(interactionRequired.data.stream, null);
      assert.equal(interactionRequired.data.message, 'Enter password');
      assert.deepEqual(interactionRequired.data.schema, {
        type: 'object',
        properties: { password: { type: 'string', format: 'password' } },
        required: ['password'],
      });
      assert.equal(interactionRequired.data.timeout_seconds, 300);

      const interactionCompleted = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_completed');
      assert.ok(interactionCompleted, 'expected run.interaction_completed event');
      assert.equal(interactionCompleted.status, 'success');
      assert.equal(interactionCompleted.data.status, 'success');
      assert.equal(interactionCompleted.data.kind, 'credentials');
      assert.equal(interactionCompleted.data.stream, null);

      const serializedTimeline = JSON.stringify(runTimeline.data || []);
      assert.ok(!serializedTimeline.includes('test123'), 'run timelines should not persist INTERACTION_RESPONSE secret values');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects connector output emitted while waiting for INTERACTION_RESPONSE', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-blocked-output-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_blocked_1',
      kind: 'credentials',
      message: 'Enter password',
      schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'RECORD',
        stream: 'items',
        key: 'should_not_land',
        data: { id: 'should_not_land', value: 'protocol_violation' },
        emitted_at: new Date().toISOString()
      }) + '\\n');
    }, 10);
  }
});
`, 'utf-8');

    try {
      let rejected = null;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => new Promise(() => {}),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.message, 'Connector emitted RECORD while waiting for INTERACTION_RESPONSE');
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      assert.equal((body.data || body.records || []).length, 0, 'blocked interaction output should not be durably written');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.interaction_required'));
      assert.ok(!runTypes.includes('run.interaction_completed'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for blocked interaction protocol violation');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects STATE emitted while waiting for INTERACTION_RESPONSE and does not stage checkpoints', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-blocked-state-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_blocked_state_1',
      kind: 'credentials',
      message: 'Enter password',
      schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'STATE',
        stream: 'items',
        cursor: { after: 'should_not_stage_checkpoint' }
      }) + '\\n');
    }, 10);
  }
});
`, 'utf-8');

    try {
      let rejected = null;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => new Promise(() => {}),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.message, 'Connector emitted STATE while waiting for INTERACTION_RESPONSE');
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'blocked interaction state output should not stage or persist checkpoint state');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.interaction_required'));
      assert.ok(!runTypes.includes('run.interaction_completed'));
      assert.ok(!runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for blocked interaction state protocol violation');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects PROGRESS emitted while waiting for INTERACTION_RESPONSE and does not record progress artifacts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-blocked-progress-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_blocked_progress_1',
      kind: 'credentials',
      message: 'Enter password',
      schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'PROGRESS',
        stream: 'items',
        message: 'should_not_be_recorded'
      }) + '\\n');
    }, 10);
  }
});
`, 'utf-8');

    try {
      let rejected = null;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => new Promise(() => {}),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.message, 'Connector emitted PROGRESS while waiting for INTERACTION_RESPONSE');
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.interaction_required'));
      assert.ok(!runTypes.includes('run.interaction_completed'));
      assert.ok(!runTypes.includes('run.progress_reported'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for blocked interaction progress protocol violation');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects SKIP_RESULT emitted while waiting for INTERACTION_RESPONSE and does not record skip artifacts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-blocked-skip-result-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_blocked_skip_1',
      kind: 'credentials',
      message: 'Enter password',
      schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'SKIP_RESULT',
        stream: 'items',
        reason: 'should_not_be_recorded',
        message: 'blocked by pending interaction'
      }) + '\\n');
    }, 10);
  }
});
`, 'utf-8');

    try {
      let rejected = null;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => new Promise(() => {}),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.message, 'Connector emitted SKIP_RESULT while waiting for INTERACTION_RESPONSE');
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.interaction_required'));
      assert.ok(!runTypes.includes('run.interaction_completed'));
      assert.ok(!runTypes.includes('run.stream_skipped'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for blocked interaction skip-result protocol violation');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects a second INTERACTION emitted while waiting for INTERACTION_RESPONSE', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-overlap-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_overlap_1',
      kind: 'credentials',
      message: 'Enter password',
      schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'INTERACTION',
        request_id: 'int_overlap_2',
        kind: 'confirmation',
        message: 'Confirm retry',
        schema: { type: 'object' },
        timeout_seconds: 300
      }) + '\\n');
    }, 10);
  }
});
`, 'utf-8');

    try {
      let rejected = null;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => new Promise(() => {}),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.message, 'Connector emitted INTERACTION while waiting for INTERACTION_RESPONSE');
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const interactionRequiredEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_required');
      assert.equal(interactionRequiredEvents.length, 1, 'only the first interaction should be admitted to the run timeline');
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_completed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for overlapping interaction protocol violation');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects DONE emitted while waiting for INTERACTION_RESPONSE and does not record terminal artifacts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-blocked-done-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_blocked_done_1',
      kind: 'credentials',
      message: 'Enter password',
      schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'DONE',
        status: 'succeeded',
        records_emitted: 0
      }) + '\\n');
    }, 10);
  }
});
`, 'utf-8');

    try {
      let rejected = null;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => new Promise(() => {}),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.message, 'Connector emitted DONE while waiting for INTERACTION_RESPONSE');
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'blocked interaction DONE should not stage or persist checkpoint state');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.interaction_required'));
      assert.ok(!runTypes.includes('run.interaction_completed'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for blocked interaction terminal protocol violation');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects invalid JSONL emitted while waiting for INTERACTION_RESPONSE and does not record completion artifacts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-blocked-invalid-jsonl-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_blocked_invalid_jsonl_1',
      kind: 'credentials',
      message: 'Enter password',
      schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write('this is not valid jsonl while waiting\\n');
    }, 10);
  }
});
`, 'utf-8');

    try {
      let rejected = null;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => new Promise(() => {}),
          });
        },
        (err) => {
          rejected = err;
          assert.match(err.message, /Connector emitted invalid JSONL while waiting for INTERACTION_RESPONSE:/);
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'blocked invalid JSONL should not stage or persist checkpoint state');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.interaction_required'));
      assert.ok(!runTypes.includes('run.interaction_completed'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for blocked interaction invalid JSONL');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime returns INTERACTION timeout responses when the handler does not answer in time', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-timeout-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_timeout_1',
      kind: 'credentials',
      message: 'Enter password',
      schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] },
      timeout_seconds: 0.05
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({
      type: 'RECORD',
      stream: 'items',
      key: 'after_timeout',
      data: { id: 'after_timeout', value: msg.status },
      emitted_at: new Date().toISOString()
    }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`, 'utf-8');

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async (msg) => {
          assert.equal(msg.request_id, 'int_timeout_1');
          return new Promise(() => {});
        },
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.records_emitted, 1);

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const found = (body.data || body.records || []).find((record) => record.data?.id === 'after_timeout');
      assert.ok(found, 'connector should continue after receiving an INTERACTION timeout response');
      assert.equal(found.data.value, 'timeout');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const interactionCompleted = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_completed');
      assert.ok(interactionCompleted, 'expected run.interaction_completed event');
      assert.equal(interactionCompleted.status, 'timeout');
      assert.equal(interactionCompleted.data.status, 'timeout');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime returns INTERACTION cancelled responses when the handler aborts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-cancelled-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_cancelled_1',
      kind: 'credentials',
      message: 'Enter password',
      schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] },
      timeout_seconds: 300
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({
      type: 'RECORD',
      stream: 'items',
      key: 'after_cancelled',
      data: { id: 'after_cancelled', value: msg.status },
      emitted_at: new Date().toISOString()
    }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`, 'utf-8');

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async (msg) => {
          assert.equal(msg.request_id, 'int_cancelled_1');
          throw new Error('user aborted interaction');
        },
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.records_emitted, 1);

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const found = (body.data || body.records || []).find((record) => record.data?.id === 'after_cancelled');
      assert.ok(found, 'connector should continue after receiving an INTERACTION cancelled response');
      assert.equal(found.data.value, 'cancelled');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const interactionCompleted = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_completed');
      assert.ok(interactionCompleted, 'expected run.interaction_completed event');
      assert.equal(interactionCompleted.status, 'cancelled');
      assert.equal(interactionCompleted.data.status, 'cancelled');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('invalid INTERACTION_RESPONSE envelopes fail the run and record an explicit runtime reason', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-invalid-response-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_invalid_1',
      kind: 'credentials',
      message: 'Enter password',
      schema: { type: 'object', properties: { password: { type: 'string', format: 'password' } }, required: ['password'] },
      timeout_seconds: 300
    }) + '\\n');
  }
});
`, 'utf-8');

    try {
      let rejected;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async (msg) => ({
              type: 'NOT_INTERACTION_RESPONSE',
              request_id: msg.request_id,
              status: 'success',
            }),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.message, 'Interaction handler returned an invalid INTERACTION_RESPONSE envelope');
          assert.equal(err.failure_reason, 'interaction_handler_invalid_response');
          assert.ok(err.run_id, 'rejected run should expose run_id for reference inspection');
          assert.ok(err.trace_id, 'rejected run should expose trace_id for reference inspection');
          return true;
        }
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for invalid interaction handler response');
      assert.equal(failedEvent.data.reason, 'interaction_handler_invalid_response');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_completed'), 'invalid handler responses should fail before interaction completion is recorded');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('malformed INTERACTION envelopes fail the run before the interaction enters the durable timeline', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-invalid-envelope-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_invalid_envelope',
      kind: 'mystery',
      message: 'This should fail before entering the run timeline',
      schema: { type: 'object' },
      timeout_seconds: 300
    }) + '\\n');
  }
});
`, 'utf-8');

    try {
      let rejected;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => ({ type: 'INTERACTION_RESPONSE', request_id: 'int_invalid_envelope', status: 'success', data: {} }),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /invalid INTERACTION.kind/);
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_required'));
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_completed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for malformed INTERACTION envelopes');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('malformed INTERACTION timeout_seconds fail the run before the interaction enters the durable timeline', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'INTERACTION',
        request_id: 'int_invalid_timeout',
        kind: 'manual_action',
        message: 'This should fail before entering the durable interaction timeline',
        timeout_seconds: 0,
      },
    ]);

    try {
      let rejected;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => ({ type: 'INTERACTION_RESPONSE', request_id: 'int_invalid_timeout', status: 'success' }),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /invalid INTERACTION\.timeout_seconds/);
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_required'));
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_completed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for malformed INTERACTION timeout_seconds');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('malformed INTERACTION schema values fail the run before the interaction enters the durable timeline', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'INTERACTION',
        request_id: 'int_invalid_schema',
        kind: 'manual_action',
        message: 'This should fail before entering the durable interaction timeline',
        schema: ['not-an-object'],
        timeout_seconds: 300,
      },
    ]);

    try {
      let rejected;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => ({ type: 'INTERACTION_RESPONSE', request_id: 'int_invalid_schema', status: 'success' }),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /invalid INTERACTION\.schema/);
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_required'));
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_completed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for malformed INTERACTION schema values');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime rejects INTERACTION for undeclared streams as a protocol violation', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-undeclared-stream-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_undeclared_stream',
      stream: 'ghost',
      kind: 'manual_action',
      message: 'This should fail before entering the durable interaction timeline',
      timeout_seconds: 300
    }) + '\\n');
  }
});
`, 'utf-8');

    try {
      let rejected;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => ({ type: 'INTERACTION_RESPONSE', request_id: 'int_undeclared_stream', status: 'success' }),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /INTERACTION for undeclared stream/);
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_required'));
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_completed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for undeclared-stream INTERACTION');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects INTERACTION when START.bindings omit interactive and records no interaction artifacts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-without-binding-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_without_binding',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } } }
    }) + '\\n');
  }
});
`, 'utf8');

    try {
      let rejected;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest: MINIMAL_MANIFEST,
            state: null,
            collectionMode: 'full_refresh',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: null,
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /START\.bindings omitted interactive/);
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(!runTypes.includes('run.interaction_required'));
      assert.ok(!runTypes.includes('run.interaction_completed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted when INTERACTION arrives without an advertised interactive binding');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  // ── 8. Failed DONE does not ingest remaining buffered records ──

  await t.test('DONE(failed) does not flush remaining buffered records', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    // Connector emits a record then fails — the record should NOT be ingested
    // (records are flushed only on DONE(succeeded))
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'should_not_persist', data: { id: 'should_not_persist', value: 'fail' }, emitted_at: new Date().toISOString() },
      { type: 'DONE', status: 'failed', records_emitted: 1, error: { message: 'Upstream rate limit exceeded', retryable: true } },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.checkpoint_summary.mode, 'checkpointed_streaming');
      assert.equal(result.checkpoint_summary.commit_status, 'not_committed');
      assert.equal(result.checkpoint_summary.records_flushed, 0);
      assert.equal(result.checkpoint_summary.buffered_records_dropped, 1);
      assert.equal(result.checkpoint_summary.state_streams_staged, 0);
      assert.equal(result.checkpoint_summary.state_streams_committed, 0);
      assert.equal(result.terminal_reason, 'connector_reported_failed');
      assert.deepEqual(result.connector_error, {
        message: 'Upstream rate limit exceeded',
        retryable: true,
      });

      // Check RS — record should NOT be present
      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const found = (body.data || body.records || []).find(r => r.data?.id === 'should_not_persist');
      assert.ok(!found, 'Records from a failed run should not be ingested');

      const asUrl = `http://localhost:${asPort}`;
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted when the connector reports DONE(failed)');
      assert.equal(failedEvent.data.reason, 'connector_reported_failed');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 1);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      assert.equal(failedEvent.data.connector_error_message, 'Upstream rate limit exceeded');
      assert.equal(failedEvent.data.connector_error_retryable, true);
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('DONE(failed) after staging multiple stream checkpoints still commits none of them', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const manifest = buildMultiStreamManifest('https://registry.pdpp.org/connectors/test-multi-stream-done-failed');
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'stream_items_done_failed', data: { id: 'stream_items_done_failed', value: 'items done failed' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'cursor_items_done_failed' } },
      { type: 'RECORD', stream: 'other_items', key: 'stream_other_done_failed', data: { id: 'stream_other_done_failed', value: 'other done failed' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'other_items', cursor: { cursor: 'cursor_other_done_failed' } },
      { type: 'DONE', status: 'failed', records_emitted: 2 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.checkpoint_summary.records_flushed, 2);
      assert.equal(result.checkpoint_summary.buffered_records_dropped, 0);
      assert.equal(result.checkpoint_summary.state_streams_staged, 2);
      assert.equal(result.checkpoint_summary.state_streams_committed, 0);

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || (!state.items && !state.other_items), 'no stream checkpoint should persist after DONE(failed)');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const stagedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_staged');
      const advancedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_advanced');
      assert.equal(stagedEvents.length, 2);
      assert.equal(advancedEvents.length, 0);
      assert.deepEqual(
        new Set(stagedEvents.map((event) => `${event.stream_id}:${event.data.cursor.cursor}`)),
        new Set(['items:cursor_items_done_failed', 'other_items:cursor_other_done_failed']),
      );

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted when the connector reports DONE(failed)');
      assert.equal(failedEvent.data.reason, 'connector_reported_failed');
      assert.equal(failedEvent.data.records_flushed, 2);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 2);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('malformed DONE.error envelopes are rejected as protocol violations before terminal artifacts are recorded as connector failures', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'failed', records_emitted: 0, error: 'definitely_not_an_object' },
    ]);

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /Connector emitted invalid DONE\.error/);
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.terminal_reason, 'connector_protocol_violation');
          assert.equal(err.connector_error, null);
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for malformed DONE.error envelopes');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      assert.ok(!('connector_error_message' in failedEvent.data), 'malformed DONE.error data must not enter durable artifacts');
      assert.ok(!('connector_error_retryable' in failedEvent.data), 'malformed DONE.error data must not enter durable artifacts');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('DONE.error with unsupported fields is rejected as a protocol violation before terminal artifacts are recorded as connector failures', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'DONE', status: 'failed', records_emitted: 0, error: { message: 'rate limited', retryable: true, code: 'upstream_rate_limit' } },
    ]);

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /Connector emitted invalid DONE\.error: unsupported fields code/);
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.terminal_reason, 'connector_protocol_violation');
          assert.equal(err.connector_error, null);
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for DONE.error envelopes with unsupported fields');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      assert.ok(!('connector_error_message' in failedEvent.data), 'unsupported DONE.error fields must not enter durable artifacts');
      assert.ok(!('connector_error_retryable' in failedEvent.data), 'unsupported DONE.error fields must not enter durable artifacts');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('DONE(succeeded) with terminal error details is rejected as a protocol violation before success artifacts are recorded', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'DONE',
        status: 'succeeded',
        records_emitted: 0,
        error: { message: 'contradictory terminal detail', retryable: false },
      },
    ]);

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /succeeded runs must not include terminal error details/);
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.terminal_reason, 'connector_protocol_violation');
          assert.equal(err.connector_error, null);
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for contradictory DONE(succeeded)+error envelopes');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      assert.ok(!('connector_error_message' in failedEvent.data), 'contradictory DONE(succeeded)+error details must not enter durable artifacts');
      assert.ok(!('connector_error_retryable' in failedEvent.data), 'contradictory DONE(succeeded)+error details must not enter durable artifacts');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('DONE(cancelled) after staging a checkpoint commits nothing and records a cancelled terminal run', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'cancelled_terminal_record', data: { id: 'cancelled_terminal_record', value: 'before_cancelled_done' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'cursor_before_cancelled_done' } },
      {
        type: 'DONE',
        status: 'cancelled',
        records_emitted: 1,
        error: { message: 'User denied follow-up verification', retryable: false },
      },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'cancelled');
      assert.equal(result.exit_code, 1);
      assert.equal(result.checkpoint_summary.commit_status, 'not_committed');
      assert.equal(result.checkpoint_summary.records_flushed, 1);
      assert.equal(result.checkpoint_summary.buffered_records_dropped, 0);
      assert.equal(result.checkpoint_summary.state_streams_staged, 1);
      assert.equal(result.checkpoint_summary.state_streams_committed, 0);
      assert.deepEqual(result.connector_error, {
        message: 'User denied follow-up verification',
        retryable: false,
      });

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when DONE status is cancelled');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=10`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const found = records.find((record) => record.data?.id === 'cancelled_terminal_record');
      assert.ok(found, 'records flushed before DONE(cancelled) should remain durable under the checkpointed streaming model');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted when the connector reports DONE(cancelled)');
      assert.equal(failedEvent.status, 'cancelled');
      assert.equal(failedEvent.data.reason, 'connector_reported_cancelled');
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      assert.equal(failedEvent.data.exit_code, undefined);
      assert.equal(failedEvent.data.connector_error_message, 'User denied follow-up verification');
      assert.equal(failedEvent.data.connector_error_retryable, false);
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('DONE(cancelled) with an exit code of 0 is treated as a protocol violation and commits no checkpoints', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-done-cancelled-exit-mismatch-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'done_cancelled_exit_mismatch',
    data: { id: 'done_cancelled_exit_mismatch', value: 'before_cancelled_exit_mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'cursor_done_cancelled_exit_mismatch' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'cancelled',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 1);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 1);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when DONE(cancelled) exits with code 0');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=10`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const found = records.find((record) => record.data?.id === 'done_cancelled_exit_mismatch');
      assert.ok(found, 'records flushed before the DONE(cancelled) exit mismatch should remain durable');

      assert.ok(capturedError?.run_id, 'run_id should be attached to cancelled DONE/exit protocol violations');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for DONE(cancelled)/exit protocol violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.exit_code, 0);
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('DONE(cancelled) with mismatched records_emitted is treated as a protocol violation and still commits no checkpoints', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-done-cancelled-count-mismatch-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'done_cancelled_count_mismatch',
    data: { id: 'done_cancelled_count_mismatch', value: 'before_cancelled_count_mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'cursor_done_cancelled_count_mismatch' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'cancelled',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /Connector reported records_emitted 2 but runtime observed 1/);
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 1);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 1);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when DONE(cancelled) reports the wrong record count');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=10`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const found = records.find((record) => record.data?.id === 'done_cancelled_count_mismatch');
      assert.ok(found, 'records flushed before the cancelled terminal count mismatch should remain durable');

      assert.ok(capturedError?.run_id, 'run_id should be attached to cancelled DONE.records_emitted protocol violations');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for cancelled DONE.records_emitted protocol violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_emitted, 1);
      assert.equal(failedEvent.data.reported_records_emitted, 2);
      assert.equal(failedEvent.data.exit_code, 1);
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('messages after DONE are treated as protocol violations and prevent checkpoint commit', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-after-done-violation-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'before_done_violation',
    data: { id: 'before_done_violation', value: 'before_done' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'cursor_before_done_violation' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'after_done_violation',
    data: { id: 'after_done_violation', value: 'after_done' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 1);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 1);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when a post-DONE protocol violation invalidates the run');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=10`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const persistedIds = new Set(records.map((record) => record.data?.id));
      assert.ok(persistedIds.has('before_done_violation'), 'records flushed before the terminal violation should remain durable');
      assert.ok(!persistedIds.has('after_done_violation'), 'records emitted after DONE should never be durably written');

      assert.ok(capturedError?.run_id, 'run_id should be attached to protocol violation errors');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for post-DONE protocol violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('PROGRESS after DONE is treated as a protocol violation and never enters durable run artifacts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-post-done-progress-violation-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'items',
    message: 'after done should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.terminal_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when a post-DONE progress violation invalidates the run');

      assert.ok(capturedError?.run_id, 'run_id should be attached to protocol violation errors');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(!runTypes.includes('run.progress_reported'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for post-DONE progress violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('INTERACTION after DONE is treated as a protocol violation and never enters durable run artifacts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-post-done-interaction-violation-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'after_done_interaction',
    kind: 'manual_action',
    message: 'after done should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({
            type: 'INTERACTION_RESPONSE',
            request_id: 'after_done_interaction',
            status: 'success',
          }),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.terminal_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when a post-DONE interaction violation invalidates the run');

      assert.ok(capturedError?.run_id, 'run_id should be attached to protocol violation errors');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(!runTypes.includes('run.interaction_required'));
      assert.ok(!runTypes.includes('run.interaction_completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for post-DONE interaction violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('SKIP_RESULT after DONE is treated as a protocol violation and never enters durable run artifacts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-post-done-skip-result-violation-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'items',
    reason: 'after_done',
    message: 'after done should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.terminal_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when a post-DONE skip violation invalidates the run');

      assert.ok(capturedError?.run_id, 'run_id should be attached to protocol violation errors');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(!runTypes.includes('run.stream_skipped'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for post-DONE skip violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('STATE after DONE is treated as a protocol violation and never stages checkpoint artifacts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-post-done-state-violation-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { after: 'after_done_state' },
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.terminal_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE emitted after DONE should never persist');

      assert.ok(capturedError?.run_id, 'run_id should be attached to protocol violation errors');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(!runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for post-DONE state violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('invalid JSONL after DONE is treated as a protocol violation and never records completion artifacts', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-post-done-invalid-jsonl-violation-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write('this is not valid jsonl after done\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.terminal_reason, 'connector_protocol_violation');
          assert.match(err.message, /Connector emitted invalid JSONL after DONE:/);
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 0);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when post-DONE invalid JSONL invalidates the run');

      assert.ok(capturedError?.run_id, 'run_id should be attached to protocol violation errors');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for post-DONE invalid JSONL');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('DONE(succeeded) with a non-zero exit code is treated as a protocol violation and prevents checkpoint commit', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-done-succeeded-exit-mismatch-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'done_succeeded_exit_mismatch',
    data: { id: 'done_succeeded_exit_mismatch', value: 'before_exit_mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'cursor_done_succeeded_exit_mismatch' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 1);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 1);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when DONE(succeeded) exits non-zero');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=10`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const found = records.find((record) => record.data?.id === 'done_succeeded_exit_mismatch');
      assert.ok(found, 'records flushed before the terminal exit-code mismatch should remain durable');

      assert.ok(capturedError?.run_id, 'run_id should be attached to DONE/exit protocol violations');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for DONE/exit protocol violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.exit_code, 1);
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('DONE(failed) with an exit code of 0 is treated as a protocol violation and commits no checkpoints', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-done-failed-exit-mismatch-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'done_failed_exit_mismatch',
    data: { id: 'done_failed_exit_mismatch', value: 'before_failed_exit_mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'cursor_done_failed_exit_mismatch' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 1);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 1);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when DONE(failed) exits with code 0');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=10`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const found = records.find((record) => record.data?.id === 'done_failed_exit_mismatch');
      assert.ok(found, 'records flushed before the DONE(failed) exit mismatch should remain durable');

      assert.ok(capturedError?.run_id, 'run_id should be attached to failed-DONE/exit protocol violations');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for DONE/exit protocol violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.exit_code, 0);
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('DONE(succeeded) with mismatched records_emitted is treated as a protocol violation and prevents checkpoint commit', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-done-succeeded-count-mismatch-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'done_succeeded_count_mismatch',
    data: { id: 'done_succeeded_count_mismatch', value: 'before_count_mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'cursor_done_succeeded_count_mismatch' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /Connector reported records_emitted 2 but runtime observed 1/);
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 1);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 1);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when DONE.records_emitted mismatches the observed record count');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=10`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const found = records.find((record) => record.data?.id === 'done_succeeded_count_mismatch');
      assert.ok(found, 'records flushed before the terminal count mismatch should remain durable');

      assert.ok(capturedError?.run_id, 'run_id should be attached to DONE.records_emitted protocol violations');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for DONE.records_emitted protocol violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_emitted, 1);
      assert.equal(failedEvent.data.reported_records_emitted, 2);
      assert.equal(failedEvent.data.exit_code, 0);
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('DONE(failed) with mismatched records_emitted is treated as a protocol violation and still commits no checkpoints', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-done-failed-count-mismatch-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'done_failed_count_mismatch',
    data: { id: 'done_failed_count_mismatch', value: 'before_failed_count_mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'cursor_done_failed_count_mismatch' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /Connector reported records_emitted 2 but runtime observed 1/);
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 1);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 1);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when DONE(failed) reports the wrong record count');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=10`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const found = records.find((record) => record.data?.id === 'done_failed_count_mismatch');
      assert.ok(found, 'records flushed before the failed terminal count mismatch should remain durable');

      assert.ok(capturedError?.run_id, 'run_id should be attached to failed DONE.records_emitted protocol violations');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for failed DONE.records_emitted protocol violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_emitted, 1);
      assert.equal(failedEvent.data.reported_records_emitted, 2);
      assert.equal(failedEvent.data.exit_code, 1);
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('DONE with an invalid status is treated as a protocol violation and commits no checkpoints', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-done-invalid-status-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'done_invalid_status',
    data: { id: 'done_invalid_status', value: 'before_invalid_done' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'cursor_done_invalid_status' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'mystery',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`, 'utf-8');

    try {
      let capturedError = null;
      await assert.rejects(
        runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'incremental',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        }),
        (err) => {
          capturedError = err;
          assert.equal(err.failure_reason, 'connector_protocol_violation');
          assert.match(err.message, /Connector emitted invalid DONE status: mystery/);
          assert.equal(err.checkpoint_summary.mode, 'checkpointed_streaming');
          assert.equal(err.checkpoint_summary.commit_status, 'not_committed');
          assert.equal(err.checkpoint_summary.records_flushed, 1);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 0);
          assert.equal(err.checkpoint_summary.state_streams_staged, 1);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          return true;
        },
      );

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when DONE.status is invalid');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=10`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const found = records.find((record) => record.data?.id === 'done_invalid_status');
      assert.ok(found, 'records flushed before the invalid DONE status should remain durable');

      assert.ok(capturedError?.run_id, 'run_id should be attached to invalid DONE.status protocol violations');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(capturedError.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));
      assert.ok(runTypes.includes('run.failed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted for invalid DONE.status protocol violations');
      assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
      assert.equal(failedEvent.data.records_emitted, 1);
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('unexpected connector exit before STATE fails the run, preserves no state, and leaves buffered records unflushed', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-crash-connector-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'items', key: 'crash_before_state', data: { id: 'crash_before_state', value: 'before_state' }, emitted_at: new Date().toISOString() }) + '\\n');
    process.stderr.write('connector crashed unexpectedly\\n');
    rl.close();
    process.exit(1);
  }
});
`, 'utf-8');

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.exit_code, 1);

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when the connector exits without DONE');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const found = (body.data || body.records || []).find(r => r.data?.id === 'crash_before_state');
      assert.ok(!found, 'Buffered records should remain unflushed when the connector exits before STATE');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('unexpected connector exit after STATE fails the run, preserves no state, and records run.failed', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-crash-after-state-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'items', key: 'crash_after_state', data: { id: 'crash_after_state', value: 'after_state' }, emitted_at: new Date().toISOString() }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'items', cursor: { cursor: 'cursor_before_crash' } }) + '\\n');
    process.stderr.write('connector crashed unexpectedly\\n');
    rl.close();
    process.exit(1);
  }
});
`, 'utf-8');

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.exit_code, 1);

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when the connector exits without DONE');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const found = (body.data || body.records || []).find(r => r.data?.id === 'crash_after_state');
      assert.ok(found, 'Records flushed by STATE may already be durably ingested before the connector exits');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.failed'));
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(!runTypes.includes('run.state_advanced'));
      assert.ok(!runTypes.includes('run.completed'));

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.equal(failedEvent.data.reason, 'connector_exit_without_done');
      assert.equal(failedEvent.data.exit_code, 1);
      assert.equal(failedEvent.data.records_flushed, 1);
      assert.equal(failedEvent.data.buffered_records_dropped, 0);
      assert.equal(failedEvent.data.state_streams_staged, 1);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('graceful connector exit without DONE still fails the run and records run.failed', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-graceful-exit-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'items', key: 'graceful_exit_no_done', data: { id: 'graceful_exit_no_done', value: 'graceful_exit' }, emitted_at: new Date().toISOString() }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`, 'utf-8');

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.exit_code, 0);

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'STATE should not persist when the connector exits without DONE');

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const found = (body.data || body.records || []).find(r => r.data?.id === 'graceful_exit_no_done');
      assert.ok(!found, 'Buffered records should remain unflushed when the connector exits cleanly without DONE');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted when the connector exits without DONE');
      assert.equal(failedEvent.data.reason, 'connector_exit_without_done');
      assert.equal(failedEvent.data.exit_code, 0);
      assert.equal(failedEvent.data.records_flushed, 0);
      assert.equal(failedEvent.data.buffered_records_dropped, 1);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('invalid ingest response at STATE fails specifically and preserves dropped-tail accounting', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort } = server;
    const asUrl = `http://localhost:${asPort}`;
    const connectorId = 'https://registry.pdpp.org/connectors/invalid-ingest-response';
    const manifest = {
      ...MINIMAL_MANIFEST,
      connector_id: connectorId,
      streams: [
        ...MINIMAL_MANIFEST.streams,
        {
          name: 'bodies',
          semantics: 'append_only',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['id'],
          },
          primary_key: ['id'],
        },
      ],
    };
    const previousBatchSize = process.env.PDPP_RUNTIME_BATCH_SIZE;
    process.env.PDPP_RUNTIME_BATCH_SIZE = '3';
    const itemBatchSizes = [];
    let bodiesFlushAttempted = false;

    const rsServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter((line) => line.trim());

      if (req.method === 'POST' && url.pathname === '/v1/ingest/items') {
        itemBatchSizes.push(lines.length);
        if (itemBatchSizes.length === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ records_accepted: lines.length, records_rejected: 0 }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('accepted but not json');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/ingest/bodies') {
        bodiesFlushAttempted = true;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bodies_should_remain_buffered' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'item_1', data: { id: 'item_1', value: 'one' }, emitted_at: new Date().toISOString() },
      { type: 'RECORD', stream: 'items', key: 'item_2', data: { id: 'item_2', value: 'two' }, emitted_at: new Date().toISOString() },
      { type: 'RECORD', stream: 'items', key: 'item_3', data: { id: 'item_3', value: 'three' }, emitted_at: new Date().toISOString() },
      { type: 'RECORD', stream: 'bodies', key: 'body_1', data: { id: 'body_1', value: 'body one' }, emitted_at: new Date().toISOString() },
      { type: 'RECORD', stream: 'bodies', key: 'body_2', data: { id: 'body_2', value: 'body two' }, emitted_at: new Date().toISOString() },
      { type: 'RECORD', stream: 'items', key: 'item_4', data: { id: 'item_4', value: 'four' }, emitted_at: new Date().toISOString() },
      { type: 'RECORD', stream: 'items', key: 'item_5', data: { id: 'item_5', value: 'five' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'after_item_5' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 7 },
    ]);

    try {
      await new Promise((resolve) => rsServer.listen(0, resolve));
      const rsPort = rsServer.address().port;

      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.equal(registerResp.status, 201);
      const ownerToken = await issueOwnerToken(asUrl, 'invalid_ingest_response_user');

      let rejected = null;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId,
            ownerToken,
            manifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => ({}),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.failure_reason, 'ingest_response_invalid');
          assert.equal(err.terminal_reason, 'ingest_response_invalid');
          assert.equal(err.checkpoint_summary.records_flushed, 3);
          assert.equal(err.checkpoint_summary.buffered_records_dropped, 4);
          assert.equal(err.checkpoint_summary.state_streams_staged, 0);
          assert.equal(err.checkpoint_summary.state_streams_committed, 0);
          assert.match(err.message, /Ingest response for items was invalid after HTTP 200/);
          return true;
        },
      );

      assert.deepEqual(itemBatchSizes, [3, 2]);
      assert.equal(bodiesFlushAttempted, false, 'sibling buffered streams should not be flushed after the ingest response failure');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent);
      assert.equal(failedEvent.data.reason, 'ingest_response_invalid');
      assert.equal(failedEvent.data.records_emitted, 7);
      assert.equal(failedEvent.data.records_flushed, 3);
      assert.equal(failedEvent.data.buffered_records_dropped, 4);
      assert.deepEqual(failedEvent.data.ingest_failure, {
        stream: 'items',
        batch_size: 2,
        http_status: 200,
        phase: 'parse_response',
        response_content_type: 'application/json',
        response_body_bytes: 21,
      });
    } finally {
      if (previousBatchSize == null) {
        delete process.env.PDPP_RUNTIME_BATCH_SIZE;
      } else {
        process.env.PDPP_RUNTIME_BATCH_SIZE = previousBatchSize;
      }
      cleanup();
      await closeHttpServer(rsServer);
      await closeServer(server);
    }
  });

  await t.test('unexpected connector exit after a batch flush preserves flushed records but drops the remaining buffered tail', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const previousBatchSize = process.env.PDPP_RUNTIME_BATCH_SIZE;
    process.env.PDPP_RUNTIME_BATCH_SIZE = '50';

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-partial-flush-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;

  for (let i = 1; i <= 51; i += 1) {
    process.stdout.write(JSON.stringify({
      type: 'RECORD',
      stream: 'items',
      key: 'partial_flush_' + i,
      data: { id: 'partial_flush_' + i, value: 'record_' + i },
      emitted_at: new Date().toISOString(),
    }) + '\\n');
  }

  process.stderr.write('connector crashed after crossing one ingest batch boundary\\n');
  rl.close();
  process.exit(1);
});
`, 'utf-8');

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.exit_code, 1);

      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=100`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const records = body.data || body.records || [];
      const persistedIds = new Set(records.map((record) => record.data?.id));

      for (let i = 1; i <= 50; i += 1) {
        assert.ok(persistedIds.has(`partial_flush_${i}`), `record ${i} should already be durable after the batch flush`);
      }
      assert.ok(!persistedIds.has('partial_flush_51'), 'the buffered tail after the flush boundary should remain unflushed');

      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items, 'no checkpoint should persist when the connector exits without DONE');

      const asUrl = `http://localhost:${asPort}`;
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run.failed should be emitted when the connector exits after a batch flush');
      assert.equal(failedEvent.data.reason, 'connector_exit_without_done');
      assert.equal(failedEvent.data.records_flushed, 50);
      assert.equal(failedEvent.data.buffered_records_dropped, 1);
      assert.equal(failedEvent.data.state_streams_staged, 0);
      assert.equal(failedEvent.data.state_streams_committed, 0);
      assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
    } finally {
      if (previousBatchSize == null) {
        delete process.env.PDPP_RUNTIME_BATCH_SIZE;
      } else {
        process.env.PDPP_RUNTIME_BATCH_SIZE = previousBatchSize;
      }
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  // ── 9. STATE remains connector-scoped across different connectors ──

  await t.test('STATE from one connector does not affect another connectors state', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;

    // Register two different connectors
    const asUrl = `http://localhost:${asPort}`;
    const manifest1 = { ...MINIMAL_MANIFEST, connector_id: 'https://test/connector-a' };
    const manifest2 = { ...MINIMAL_MANIFEST, connector_id: 'https://test/connector-b' };

    await fetchJson(`${asUrl}/connectors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manifest1) });
    await fetchJson(`${asUrl}/connectors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manifest2) });
    const ownerToken = await issueOwnerToken(asUrl, 'test_user');

    // Run connector A — emits STATE
    const { connectorPath: pathA, cleanup: cleanupA } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'a_1', data: { id: 'a_1', value: 'from_a' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { cursor: 'cursor_from_a' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      await runConnector({
        connectorPath: pathA, connectorId: manifest1.connector_id, ownerToken, manifest: manifest1,
        state: null, collectionMode: 'full_refresh', persistState: true,
        rsUrl: `http://localhost:${rsPort}`, onInteraction: async () => ({}),
      });

      // Check connector A's state
      const stateA = await loadSyncState(manifest1.connector_id, ownerToken, { rsUrl: `http://localhost:${rsPort}` });

      // Check connector B's state — should be independent
      const stateB = await loadSyncState(manifest2.connector_id, ownerToken, { rsUrl: `http://localhost:${rsPort}` });

      assert.deepEqual(stateA?.items, { cursor: 'cursor_from_a' }, 'Connector A should have its state');
      assert.ok(!stateB || !stateB.items, 'Connector B should not have state from Connector A');
    } finally {
      cleanupA();
      await closeServer(server);
    }
  });
});

// ── Helpers ──

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { status: resp.status, body };
}

async function startGrantRequest(asUrl, params) {
  return fetchJson(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'longview',
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          source: { kind: 'connector', id: params.connectorId },
          purpose_code: 'https://pdpp.org/purpose/personalization',
          purpose_description: 'Collection Profile conformance test grant',
          access_mode: 'continuous',
          streams: [{ name: 'items' }],
        },
      ],
    }),
  });
}

async function approveGrantRequest(asUrl, requestUri, subjectId) {
  return fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
  });
}

async function createGrant(asUrl, connectorId, subjectId) {
  const { status: requestStatus, body: requestBody } = await startGrantRequest(asUrl, { connectorId });
  assert.ok([200, 201].includes(requestStatus), `expected successful PAR status, got ${requestStatus}`);
  assert.ok(requestBody.request_uri, 'expected request_uri from PAR');

  const { status: approvalStatus, body: approvalBody } = await approveGrantRequest(asUrl, requestBody.request_uri, subjectId);
  assert.ok([200, 201].includes(approvalStatus), `expected successful approval status, got ${approvalStatus}`);
  assert.ok(approvalBody.grant_id, 'expected issued grant_id');

  return approvalBody.grant_id;
}

async function setupConnector(server, asPort, manifest = MINIMAL_MANIFEST) {
  const asUrl = `http://localhost:${asPort}`;

  // Register connector manifest
  await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });

  const ownerToken = await issueOwnerToken(asUrl, 'test_user');

  return { ownerToken, connectorId: manifest.connector_id };
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

  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });

  return tokenBody.access_token;
}
