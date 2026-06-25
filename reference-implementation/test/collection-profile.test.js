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

function createEnvCaptureStateConnector(capturePath) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-env-state-capture-'));
  const connectorPath = join(tmpDir, 'connector.mjs');

  const script = `
import { createInterface } from 'readline';
import { writeFileSync } from 'node:fs';

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    connectorId: process.env.PDPP_CONNECTOR_ID || null,
    connectorInstanceId: process.env.PDPP_CONNECTOR_INSTANCE_ID || null,
  }, null, 2));
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'instance_item',
    data: { id: 'instance_item', value: 'instance value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'instance_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
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
  connector_id: 'test',
  version: '1.0.0',
  display_name: 'Test Connector',
  streams: [
    { name: 'items', semantics: 'append_only', schema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' } }, required: ['id'] }, primary_key: ['id'] },
  ],
};

function buildMultiStreamManifest(connectorId = 'test-multi-stream') {
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
      connector_id: 'test-start-field-normalization',
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
      connector_id: 'test-scope-branch',
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
      connector_id: 'test-scope-fields-branch',
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

  await t.test('loadSyncState includes connector_instance_id when provided', async () => {
    const connectorId = 'instance_state_connector';
    const connectorInstanceId = 'cin_instance_state_work';
    const ownerToken = 'owner_state_token';
    const requests = [];
    const rsServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({
        method: req.method,
        pathname: url.pathname,
        connectorInstanceId: url.searchParams.get('connector_instance_id'),
        grantId: url.searchParams.get('grant_id'),
        authorization: req.headers.authorization,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: { items: { cursor: 'loaded_instance_cursor' } } }));
    });

    await new Promise((resolve) => rsServer.listen(0, resolve));
    try {
      const state = await loadSyncState(connectorId, ownerToken, {
        rsUrl: `http://localhost:${rsServer.address().port}`,
        connectorInstanceId,
        grantId: 'grant_instance_state',
      });

      assert.deepEqual(state, { items: { cursor: 'loaded_instance_cursor' } });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'GET');
      assert.equal(requests[0].pathname, `/v1/state/${encodeURIComponent(connectorId)}`);
      assert.equal(requests[0].connectorInstanceId, connectorInstanceId);
      assert.equal(requests[0].grantId, 'grant_instance_state');
      assert.equal(requests[0].authorization, `Bearer ${ownerToken}`);
    } finally {
      await closeHttpServer(rsServer);
    }
  });

  await t.test('runConnector scopes ingest and checkpoint PUTs by connector_instance_id', async () => {
    const connectorId = 'instance_runtime_connector';
    const connectorInstanceId = 'cin_instance_runtime_work';
    const ownerToken = 'owner_runtime_token';
    const envCapturePath = join(mkdtempSync(join(tmpdir(), 'pdpp-env-capture-')), 'env.json');
    const { connectorPath, cleanup } = createEnvCaptureStateConnector(envCapturePath);
    const requests = [];

    const rsServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({
        method: req.method,
        pathname: url.pathname,
        connectorId: url.searchParams.get('connector_id'),
        connectorInstanceId: url.searchParams.get('connector_instance_id'),
      });

      if (req.method === 'POST' && url.pathname === '/v1/ingest/items') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ records_accepted: 1, records_rejected: 0 }));
        return;
      }

      if (req.method === 'PUT' && url.pathname === `/v1/state/${encodeURIComponent(connectorId)}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    await new Promise((resolve) => rsServer.listen(0, resolve));
    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        connectorInstanceId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl: `http://localhost:${rsServer.address().port}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const envCapture = JSON.parse(readFileSync(envCapturePath, 'utf-8'));
      assert.equal(envCapture.connectorId, connectorId);
      assert.equal(envCapture.connectorInstanceId, connectorInstanceId);

      const ingestRequest = requests.find((request) => request.method === 'POST');
      assert.ok(ingestRequest);
      assert.equal(ingestRequest.pathname, '/v1/ingest/items');
      assert.equal(ingestRequest.connectorId, connectorId);
      assert.equal(ingestRequest.connectorInstanceId, connectorInstanceId);

      const stateRequest = requests.find((request) => request.method === 'PUT');
      assert.ok(stateRequest);
      assert.equal(stateRequest.pathname, `/v1/state/${encodeURIComponent(connectorId)}`);
      assert.equal(stateRequest.connectorId, null);
      assert.equal(stateRequest.connectorInstanceId, connectorInstanceId);
    } finally {
      cleanup();
      rmSync(dirname(envCapturePath), { recursive: true, force: true });
      await closeHttpServer(rsServer);
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
    const manifest = buildMultiStreamManifest('test-multi-stream-state-boundary');
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
    const manifest = buildMultiStreamManifest('test-multi-stream-checkpoint-success');
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
    const manifest = buildMultiStreamManifest('test-multi-stream-checkpoint-failure');
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
    const connectorId = 'partial-checkpoint-commit';
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

  await t.test('runtime accepts RECORD messages within manifest-declared resource field', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const manifest = {
      ...MINIMAL_MANIFEST,
      connector_id: 'test-resource-field',
      streams: [
        {
          name: 'items',
          semantics: 'append_only',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              partition_id: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['id', 'partition_id'],
          },
          primary_key: ['id'],
          selection: { resources: true, resource_field: 'partition_id' },
        },
      ],
    };
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'RECORD',
        stream: 'items',
        key: 'item_2',
        data: { id: 'item_2', partition_id: 'partition_1', value: 'ok' },
        emitted_at: new Date().toISOString(),
      },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'items', resources: ['partition_1'] }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });
      assert.equal(result.records_emitted, 1);
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
      connector_id: 'test-time-range',
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

  // openspec/changes/propagate-skip-result-diagnostics: SKIP_RESULT.diagnostics
  // is connector-authored evidence about *why* the skip happened (USAA export
  // page state, response-queue candidates, etc.). The runtime SHALL propagate
  // a bounded, redacted projection to the run.stream_skipped spine event and
  // to the known_gap so the owner can diagnose the failure offline.
  await t.test('runtime forwards bounded SKIP_RESULT.diagnostics into the spine event and known gap', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const diagnostics = {
      phase: 'export_artifact_wait_failed',
      diag: {
        url: 'https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001',
        title: 'USAA Checking',
        dialogs_open: 1,
      },
      artifact: {
        cdpReady: true,
        cdpError: null,
        candidates: [
          { source: 'cdp', status: 200, reason: 'not_expected_body', contentType: 'text/html', bodyBytes: 1247 },
        ],
      },
      error: 'download_empty',
    };

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'SKIP_RESULT', stream: 'items', reason: 'export_no_download', message: 'export failed', diagnostics },
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

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const skippedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.stream_skipped');
      assert.ok(skippedEvent, 'expected run.stream_skipped event');
      assert.ok(skippedEvent.data.diagnostics, 'spine event should carry SKIP_RESULT.diagnostics');
      assert.equal(skippedEvent.data.diagnostics.phase, 'export_artifact_wait_failed');
      assert.equal(skippedEvent.data.diagnostics.diag.url, 'https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001');
      assert.equal(skippedEvent.data.diagnostics.artifact.cdpReady, true);
      assert.equal(skippedEvent.data.diagnostics.artifact.candidates[0].source, 'cdp');
      assert.equal(skippedEvent.data.diagnostics.error, 'download_empty');

      assert.ok(skippedEvent.data.known_gap.diagnostics, 'known_gap should carry diagnostics');
      assert.equal(skippedEvent.data.known_gap.diagnostics.phase, 'export_artifact_wait_failed');

      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      assert.ok(completedEvent.data.known_gaps[0].diagnostics, 'terminal known_gap should carry diagnostics');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime redacts secret-shaped strings inside SKIP_RESULT.diagnostics', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const diagnostics = {
      // password=… is a redaction trigger in boundGapString; 123456 is OTP-like.
      auth: 'password=supersecret token=abc123',
      otp_seen: 'observed 123456 in dialog',
      nested: { cookie: 'cookie=sess_abc123' },
    };

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'SKIP_RESULT', stream: 'items', reason: 'export_no_download', message: 'redacted-path', diagnostics },
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

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const skippedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.stream_skipped');
      const serialized = JSON.stringify(skippedEvent.data.diagnostics);
      assert.doesNotMatch(serialized, /supersecret/, 'password value must be redacted');
      assert.doesNotMatch(serialized, /sess_abc123/, 'nested cookie value must be redacted');
      assert.doesNotMatch(serialized, /\b123456\b/, '6-digit OTP must be redacted');
      assert.match(serialized, /\[REDACTED\]/);
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime replaces oversized SKIP_RESULT.diagnostics with a size_overflow sentinel', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    // 64 candidates × ~600 bytes JSON each ≈ 38 KiB > 8 KiB cap.
    const candidates = [];
    for (let i = 0; i < 64; i += 1) {
      candidates.push({
        source: 'cdp',
        status: 200,
        reason: 'not_expected_body',
        contentType: 'text/html',
        bodyBytes: 1024,
        url: `https://www.usaa.com/export/candidate/${i}?padding=${'X'.repeat(400)}`,
      });
    }
    const diagnostics = { phase: 'export_artifact_wait_failed', artifact: { candidates } };

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'SKIP_RESULT', stream: 'items', reason: 'export_no_download', message: 'huge', diagnostics },
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

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const skippedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.stream_skipped');
      assert.deepEqual(skippedEvent.data.diagnostics, { truncated: true, reason: 'size_overflow' });
      assert.deepEqual(skippedEvent.data.known_gap.diagnostics, { truncated: true, reason: 'size_overflow' });
      assert.equal(skippedEvent.data.reason, 'export_no_download', 'rest of SKIP_RESULT still propagates');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime drops non-object SKIP_RESULT.diagnostics without rejecting the message', async () => {
    for (const diagnostics of ['oops', [1, 2, 3], 123]) {
      const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
      const { asPort, rsPort } = server;
      const { ownerToken, connectorId } = await setupConnector(server, asPort);
      const asUrl = `http://localhost:${asPort}`;

      const { connectorPath, cleanup } = createTestConnector([
        {
          type: 'SKIP_RESULT',
          stream: 'items',
          reason: 'export_no_download',
          message: 'non-object diag',
          diagnostics,
        },
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
        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
        const skippedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.stream_skipped');
        assert.ok(skippedEvent, 'SKIP_RESULT with non-object diagnostics still propagates');
        assert.equal(skippedEvent.data.diagnostics, undefined, 'non-object diagnostics is dropped from spine payload');
        assert.equal(skippedEvent.data.known_gap.diagnostics, undefined, 'non-object diagnostics is dropped from known gap');
      } finally {
        cleanup();
        await closeServer(server);
      }
    }
  });

  // ── 5b. Optional connector-declared `considered` denominator ──
  //
  // openspec/changes/define-connector-progress-evidence-contract (task 2.1):
  // a connector may declare an optional bounded `considered` count on
  // DETAIL_COVERAGE and inside SKIP_RESULT.diagnostics so partial-vs-complete is
  // real, not gap-only. It is treated as evidence only: a trusted value is a safe
  // non-negative integer; anything malformed or outside JavaScript's precise
  // integer range is dropped to `unknown` (omitted) rather than fabricating a
  // completeness denominator.
  // This tranche carries the value onto the existing per-stream spine events only;
  // it introduces no collection_report / coverage_axis / forward_disposition.

  await t.test('runtime preserves a valid DETAIL_COVERAGE.considered count on the spine event', async () => {
    const manifest = buildMultiStreamManifest('considered-coverage');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'DETAIL_COVERAGE',
        reference_only: true,
        state_stream: 'items',
        stream: 'other_items',
        required_keys: ['k1', 'k2'],
        hydrated_keys: ['k1', 'k2'],
        considered: 42,
      },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const coverageEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.detail_coverage_declared');
      assert.ok(coverageEvent, 'expected run.detail_coverage_declared event');
      assert.equal(coverageEvent.data.stream, 'other_items');
      assert.equal(coverageEvent.data.required_keys, 2, 'existing coverage counts still emitted');
      assert.equal(coverageEvent.data.hydrated_keys, 2);
      assert.equal(coverageEvent.data.considered, 42, 'valid considered is preserved verbatim');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime drops malformed / unsafe DETAIL_COVERAGE.considered to unknown without rejecting', async () => {
    // Each value is NOT a safe non-negative integer, so none may be
    // trusted as a denominator: the field must be omitted (unknown), and the
    // run must still succeed (drop, don't reject) with its other coverage counts.
    for (const considered of [-1, 3.5, Number.NaN, Number.POSITIVE_INFINITY, '7', Number.MAX_SAFE_INTEGER + 1, null]) {
      const manifest = buildMultiStreamManifest('considered-coverage-bad');
      const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
      const { asPort, rsPort } = server;
      const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
      const asUrl = `http://localhost:${asPort}`;

      const { connectorPath, cleanup } = createTestConnector([
        {
          type: 'DETAIL_COVERAGE',
          reference_only: true,
          state_stream: 'items',
          stream: 'other_items',
          required_keys: ['k1'],
          hydrated_keys: ['k1'],
          considered,
        },
        { type: 'DONE', status: 'succeeded', records_emitted: 0 },
      ]);

      try {
        const result = await runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        });

        assert.equal(result.status, 'succeeded', `considered=${String(considered)} must not reject the run`);

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
        const coverageEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.detail_coverage_declared');
        assert.ok(coverageEvent, 'coverage event still emitted');
        assert.equal(
          coverageEvent.data.considered,
          undefined,
          `considered=${String(considered)} must drop to unknown (omitted), never a trusted count`,
        );
        assert.equal(coverageEvent.data.required_keys, 1, 'other coverage counts unaffected');
      } finally {
        cleanup();
        await closeServer(server);
      }
    }
  });

  await t.test('runtime accepts a boundary DETAIL_COVERAGE.considered of 0 and the max safe integer', async () => {
    for (const considered of [0, Number.MAX_SAFE_INTEGER]) {
      const manifest = buildMultiStreamManifest('considered-coverage-edge');
      const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
      const { asPort, rsPort } = server;
      const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
      const asUrl = `http://localhost:${asPort}`;

      const { connectorPath, cleanup } = createTestConnector([
        {
          type: 'DETAIL_COVERAGE',
          reference_only: true,
          state_stream: 'items',
          stream: 'other_items',
          required_keys: ['k1'],
          hydrated_keys: ['k1'],
          considered,
        },
        { type: 'DONE', status: 'succeeded', records_emitted: 0 },
      ]);

      try {
        const result = await runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        });

        assert.equal(result.status, 'succeeded');
        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
        const coverageEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.detail_coverage_declared');
        assert.equal(coverageEvent.data.considered, considered, `safe boundary considered=${considered} is trusted`);
      } finally {
        cleanup();
        await closeServer(server);
      }
    }
  });

  await t.test('existing DETAIL_COVERAGE with no considered stays unknown (no field) and unchanged', async () => {
    const manifest = buildMultiStreamManifest('considered-coverage-absent');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'DETAIL_COVERAGE',
        reference_only: true,
        state_stream: 'items',
        stream: 'other_items',
        required_keys: ['k1'],
        hydrated_keys: ['k1'],
        gap_keys: [],
        optional_skip_keys: [],
      },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const coverageEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.detail_coverage_declared');
      assert.ok(coverageEvent, 'coverage event emitted with prior shape');
      assert.equal(coverageEvent.data.considered, undefined, 'absence stays unknown — never inferred from collected');
      assert.equal(coverageEvent.data.required_keys, 1);
      assert.equal(coverageEvent.data.hydrated_keys, 1);
      assert.equal(coverageEvent.data.gap_keys, 0);
      assert.equal(coverageEvent.data.optional_skip_keys, 0);
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime preserves a valid SKIP_RESULT.diagnostics.considered count', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'SKIP_RESULT',
        stream: 'items',
        reason: 'partial_export',
        message: 'declared a considered inventory',
        diagnostics: { phase: 'inventory_counted', considered: 1200 },
      },
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
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const skippedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.stream_skipped');
      assert.ok(skippedEvent, 'expected run.stream_skipped event');
      assert.equal(skippedEvent.data.diagnostics.considered, 1200, 'valid considered preserved on spine diagnostics');
      assert.equal(skippedEvent.data.diagnostics.phase, 'inventory_counted', 'rest of diagnostics intact');
      assert.equal(skippedEvent.data.known_gap.diagnostics.considered, 1200, 'considered also on known_gap diagnostics');

      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      assert.equal(completedEvent.data.known_gaps[0].diagnostics.considered, 1200, 'considered survives to terminal known_gap');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime drops malformed / unsafe SKIP_RESULT.diagnostics.considered while keeping the rest of diagnostics', async () => {
    for (const considered of [-5, 2.5, '900', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
      const { asPort, rsPort } = server;
      const { ownerToken, connectorId } = await setupConnector(server, asPort);
      const asUrl = `http://localhost:${asPort}`;

      const { connectorPath, cleanup } = createTestConnector([
        {
          type: 'SKIP_RESULT',
          stream: 'items',
          reason: 'partial_export',
          message: 'bad considered',
          diagnostics: { phase: 'inventory_counted', considered, note: 'keep me' },
        },
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

        assert.equal(result.status, 'succeeded', `considered=${String(considered)} must not reject the run`);
        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
        const skippedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.stream_skipped');
        assert.ok(skippedEvent, 'skip event still emitted');
        assert.equal(
          skippedEvent.data.diagnostics.considered,
          undefined,
          `considered=${String(considered)} dropped to unknown, never trusted`,
        );
        assert.equal(skippedEvent.data.diagnostics.phase, 'inventory_counted', 'sibling diagnostics keys survive');
        assert.equal(skippedEvent.data.diagnostics.note, 'keep me', 'unrelated diagnostics preserved');
      } finally {
        cleanup();
        await closeServer(server);
      }
    }
  });

  // ── 5c. Tranche B — runtime collection-fact block (task 2.2a) ──
  //
  // openspec/changes/define-connector-progress-evidence-contract (task 2.2a):
  // the runtime attaches a per-stream `collection_facts` block to the terminal
  // event carrying ONLY objective run-local facts — per-stream collected count,
  // a declared considered value or `unknown` (never inferred from collected),
  // committed checkpoint status, the SKIP_RESULT reason, and the pending
  // recoverable detail-gap count. It does NOT carry a coverage condition or a
  // forward disposition — those are derived later by the control-plane
  // projection (Tranche C). The block is named `collection_facts` to keep it
  // distinct from the projection-derived `collection_report` the spec reserves
  // for the control-plane layer.

  await t.test('2.2a layer boundary: terminal collection_facts carries facts only, no coverage_axis / forward_disposition', async () => {
    // 2.7 layer-boundary guard, sharpened for Tranche B: the runtime NOW emits a
    // facts-only `collection_facts` block, but it must carry no coverage axis or
    // forward disposition — on the block OR on any per-stream entry. The
    // projection-derived `collection_report` key must remain absent on the
    // terminal event (that is Tranche C).
    const manifest = buildMultiStreamManifest('facts-block-layer-boundary');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'DETAIL_COVERAGE',
        reference_only: true,
        state_stream: 'items',
        stream: 'other_items',
        required_keys: ['k1'],
        hydrated_keys: ['k1'],
        considered: 9,
      },
      {
        type: 'SKIP_RESULT',
        stream: 'items',
        reason: 'partial_export',
        message: 'declared considered',
        diagnostics: { considered: 50 },
      },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      assert.ok(completedEvent, 'expected run.completed event');

      // The projection-derived report and the derived axes never appear on the
      // runtime terminal event.
      assert.equal(completedEvent.data.collection_report, undefined, 'no projection-derived collection_report on terminal event (Tranche C)');
      assert.equal(completedEvent.data.coverage_axis, undefined, 'no coverage_axis on the terminal event');
      assert.equal(completedEvent.data.forward_disposition, undefined, 'no forward_disposition on the terminal event');

      // The runtime facts block IS present, facts-only.
      const facts = completedEvent.data.collection_facts;
      assert.ok(facts, 'runtime collection_facts block present on terminal event');
      assert.equal(facts.reference_only, true, 'facts block is a reference-only projection');
      assert.ok(Array.isArray(facts.streams), 'facts block carries a per-stream array');
      assert.equal(facts.streams.length, 2, 'one entry per in-scope stream');

      // No derived axis appears on the block or on any per-stream entry — this
      // is the layer boundary Tranche C alone is allowed to cross.
      assert.equal('coverage' in facts, false, 'no coverage condition on the block');
      assert.equal('coverage_axis' in facts, false, 'no coverage_axis on the block');
      assert.equal('forward_disposition' in facts, false, 'no forward_disposition on the block');
      assert.equal('freshness' in facts, false, 'no freshness on the block');
      assert.equal('refresh' in facts, false, 'no refresh policy on the block');
      for (const entry of facts.streams) {
        assert.equal('coverage' in entry, false, `no coverage condition on entry ${entry.stream}`);
        assert.equal('coverage_axis' in entry, false, `no coverage_axis on entry ${entry.stream}`);
        assert.equal('forward_disposition' in entry, false, `no forward_disposition on entry ${entry.stream}`);
        assert.equal('freshness' in entry, false, `no freshness on entry ${entry.stream}`);
        assert.equal('refresh' in entry, false, `no refresh policy on entry ${entry.stream}`);
      }

      // The terminal known_gaps block (the existing carrier) is unchanged.
      assert.ok(Array.isArray(completedEvent.data.known_gaps), 'existing known_gaps block still present');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('2.2a: one collection_facts entry per in-scope stream, each with collected + checkpoint, no verdict', async () => {
    // A two-stream success: each requested stream gets exactly one entry with a
    // raw collected count and a checkpoint fact, and NO coverage verdict.
    const manifest = buildMultiStreamManifest('facts-per-in-scope-stream');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: new Date().toISOString() },
      { type: 'RECORD', stream: 'items', key: 'i2', data: { id: 'i2', value: 'b' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { last: 'i2' } },
      { type: 'RECORD', stream: 'other_items', key: 'o1', data: { id: 'o1', value: 'c' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'other_items', cursor: { last: 'o1' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 3 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'items' }, { name: 'other_items' }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const facts = completedEvent.data.collection_facts;
      assert.ok(facts, 'facts block present');

      const byStream = Object.fromEntries(facts.streams.map((entry) => [entry.stream, entry]));
      assert.deepEqual(Object.keys(byStream).sort(), ['items', 'other_items']);

      assert.equal(byStream.items.collected, 2, 'items collected count is the raw per-stream emitted total');
      assert.equal(byStream.items.checkpoint, 'committed', 'committed STATE for items checkpoints committed');
      assert.equal(byStream.items.pending_detail_gaps, 0);
      assert.equal(byStream.items.skipped, null, 'no skip for items');

      assert.equal(byStream.other_items.collected, 1, 'other_items collected count is per-stream');
      assert.equal(byStream.other_items.checkpoint, 'committed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('2.2a: a zero-record in-scope stream still gets an honest collected:0 entry, considered absent', async () => {
    // A stream the connector never emitted for is a fact (collected:0), not a
    // missing entry; and with no declared considered, the considered key is
    // absent (reads unknown) — never inferred to equal collected.
    const manifest = buildMultiStreamManifest('facts-zero-record-stream');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: new Date().toISOString() },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'items' }, { name: 'other_items' }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const facts = completedEvent.data.collection_facts;
      const byStream = Object.fromEntries(facts.streams.map((entry) => [entry.stream, entry]));

      assert.ok(byStream.other_items, 'zero-record in-scope stream still has an entry');
      assert.equal(byStream.other_items.collected, 0, 'honest collected:0 for a stream that emitted nothing');
      assert.equal('considered' in byStream.other_items, false, 'no declared considered -> considered key absent (unknown)');
      assert.equal(byStream.other_items.checkpoint, 'not_staged', 'no STATE staged for other_items -> not_staged');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('2.2a: a SKIP_RESULT stream carries the skip fact, no complete verdict', async () => {
    // The runtime states the skip fact; deciding unsupported/etc is the
    // projection's job (Tranche C). The entry must NOT carry a coverage verdict.
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'SKIP_RESULT', stream: 'items', reason: 'partial_export', message: 'could not export', recovery_hint: 'retry_by_runtime' },
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
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const facts = completedEvent.data.collection_facts;
      const itemsEntry = facts.streams.find((entry) => entry.stream === 'items');

      assert.ok(itemsEntry, 'items entry present');
      assert.ok(itemsEntry.skipped, 'skip fact recorded on the entry');
      assert.equal(itemsEntry.skipped.reason, 'partial_export', 'skip reason carried verbatim');
      assert.equal(itemsEntry.skipped.recovery_action, 'retry_by_runtime', 'normalized recovery action carried');
      // No coverage verdict: the runtime states the skip, the projection decides.
      assert.equal('coverage' in itemsEntry, false, 'no coverage condition on a skipped entry');
      assert.equal('forward_disposition' in itemsEntry, false, 'no forward_disposition on a skipped entry');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('2.2a: a pending DETAIL_GAP shows pending_detail_gaps>=1 by count, not restated locators', async () => {
    const manifest = buildMultiStreamManifest('facts-pending-detail-gap');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: new Date().toISOString() },
      {
        type: 'DETAIL_GAP',
        stream: 'other_items',
        parent_stream: 'items',
        record_key: 'i1',
        reason: 'temporary_unavailable',
        retryable: true,
      },
      // No STATE staged -> the commit-gate does not fire on the unsatisfied
      // detail coverage (none declared), so the run completes with the gap pending.
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'items' }, { name: 'other_items' }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const facts = completedEvent.data.collection_facts;
      const gapEntry = facts.streams.find((entry) => entry.stream === 'other_items');

      assert.ok(gapEntry, 'detail-gap stream has an entry');
      assert.equal(gapEntry.pending_detail_gaps, 1, 'pending recoverable detail gap counted on its stream');
      // The entry references the gap by count; per-item locators stay in the
      // existing detail_gaps block, not restated here.
      assert.equal('detail_locator' in gapEntry, false, 'no per-item locators restated on the facts entry');
      assert.equal('record_key' in gapEntry, false, 'no per-item record_key restated on the facts entry');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('2.2a: considered honesty — declared value carried, absence stays unknown, never set to collected', async () => {
    const manifest = buildMultiStreamManifest('facts-considered-honesty');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      // items collects records but declares NO considered.
      { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: new Date().toISOString() },
      { type: 'RECORD', stream: 'items', key: 'i2', data: { id: 'i2', value: 'b' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { last: 'i2' } },
      // other_items declares an explicit considered = 7 via DETAIL_COVERAGE,
      // larger than what it collected, so partial-vs-complete is real.
      {
        type: 'DETAIL_COVERAGE',
        reference_only: true,
        state_stream: 'items',
        stream: 'other_items',
        required_keys: ['k1', 'k2'],
        hydrated_keys: ['k1', 'k2'],
        considered: 7,
      },
      { type: 'DONE', status: 'succeeded', records_emitted: 2 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'items' }, { name: 'other_items' }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const facts = completedEvent.data.collection_facts;
      const byStream = Object.fromEntries(facts.streams.map((entry) => [entry.stream, entry]));

      // items: collected 2 records, declared no considered -> considered absent.
      assert.equal(byStream.items.collected, 2);
      assert.equal('considered' in byStream.items, false, 'no declared considered -> key absent (unknown)');

      // other_items: declared considered 7 wins, even though it collected 0.
      assert.equal(byStream.other_items.collected, 0, 'other_items emitted no records');
      assert.equal(byStream.other_items.considered, 7, 'declared DETAIL_COVERAGE.considered carried');
      assert.notEqual(byStream.other_items.considered, byStream.other_items.collected, 'considered is NEVER set to collected');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('2.2a: declared considered prefers DETAIL_COVERAGE.considered over required_keys.length', async () => {
    const manifest = buildMultiStreamManifest('facts-considered-priority');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'DETAIL_COVERAGE',
        reference_only: true,
        state_stream: 'items',
        stream: 'other_items',
        required_keys: ['k1', 'k2'], // length 2
        hydrated_keys: ['k1', 'k2'],
        considered: 200, // explicit declared denominator wins over length 2
      },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'items' }, { name: 'other_items' }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const facts = completedEvent.data.collection_facts;
      const other = facts.streams.find((entry) => entry.stream === 'other_items');
      assert.equal(other.considered, 200, 'declared considered wins over required_keys.length');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('2.2a: required_keys.length is the considered fallback when no considered is declared', async () => {
    const manifest = buildMultiStreamManifest('facts-considered-fallback');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'DETAIL_COVERAGE',
        reference_only: true,
        state_stream: 'items',
        stream: 'other_items',
        required_keys: ['k1', 'k2', 'k3'], // length 3 = fallback considered
        hydrated_keys: ['k1', 'k2', 'k3'],
      },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'items' }, { name: 'other_items' }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const facts = completedEvent.data.collection_facts;
      const other = facts.streams.find((entry) => entry.stream === 'other_items');
      assert.equal(other.considered, 3, 'required_keys.length used as the considered fallback');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('2.2a: a list-stream DETAIL_COVERAGE (empty keys + considered) declares the considered denominator without blocking commit (task 4.1 mechanism)', async () => {
    // The mechanism GitHub's list collectors use (task 4.1): a list stream that
    // has no detail-hydration phase declares its enumerated inventory as
    // `considered` by emitting a DETAIL_COVERAGE for the LIST stream itself
    // (state_stream === stream) with EMPTY required_keys/hydrated_keys and an
    // explicit `considered`. Empty required_keys means the pre-commit coverage
    // gate has nothing to mark missing, so the committed STATE still commits, and
    // the terminal facts block carries the declared considered for that stream.
    const manifest = buildMultiStreamManifest('facts-list-considered');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: new Date().toISOString() },
      { type: 'RECORD', stream: 'items', key: 'i2', data: { id: 'i2', value: 'b' }, emitted_at: new Date().toISOString() },
      // List-level considered declaration: the run enumerated 5 items in its
      // boundary and emitted 2 of them (the other 3 were considered-not-collected,
      // e.g. filtered). Empty key arrays => no detail-hydration claim.
      {
        type: 'DETAIL_COVERAGE',
        reference_only: true,
        state_stream: 'items',
        stream: 'items',
        required_keys: [],
        hydrated_keys: [],
        considered: 5,
      },
      { type: 'STATE', stream: 'items', cursor: { last: 'i2' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 2 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'items' }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      // The list-level coverage entry must NOT trip assertDetailCoverageSatisfiedBeforeCommit.
      assert.equal(result.status, 'succeeded', 'empty-key list coverage must not block the run');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const facts = completedEvent.data.collection_facts;
      const items = facts.streams.find((entry) => entry.stream === 'items');
      assert.ok(items, 'items entry present in the facts block');
      assert.equal(items.collected, 2, 'collected is the runtime emit count, not the declared considered');
      assert.equal(items.considered, 5, 'the list-level DETAIL_COVERAGE.considered is carried as the denominator');
      assert.equal(items.checkpoint, 'committed', 'the committed STATE still commits despite the coverage entry');
      assert.equal(items.pending_detail_gaps, 0, 'no detail gaps from an empty-key coverage entry');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('4.4: a steady-state list-considered DETAIL_COVERAGE carries `covered` onto the spine event AND the terminal facts block', async () => {
    // The steady-state full-sync shape (task 4.4): a fingerprint-suppressed stream
    // re-enumerated 5 items, emitted 0 (all unchanged), and declares
    // `considered: 5` with `covered: 5` (every item accounted for as
    // suppressed-unchanged). The runtime must carry BOTH the considered AND the
    // covered count through the spine event and onto the terminal facts block, so
    // the projection can read covered === considered → complete. `collected` is 0.
    const manifest = buildMultiStreamManifest('facts-list-covered');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      // No RECORDs: a steady-state run where every enumerated item was unchanged.
      {
        type: 'DETAIL_COVERAGE',
        reference_only: true,
        state_stream: 'items',
        stream: 'items',
        required_keys: [],
        hydrated_keys: [],
        considered: 5,
        covered: 5,
      },
      { type: 'STATE', stream: 'items', cursor: { last: 'i5' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 0 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'items' }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded', 'empty-key list coverage must not block the run');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);

      // Spine event carries covered alongside considered.
      const coverageEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.detail_coverage_declared');
      assert.ok(coverageEvent, 'expected run.detail_coverage_declared event');
      assert.equal(coverageEvent.data.considered, 5, 'considered carried on the spine event');
      assert.equal(coverageEvent.data.covered, 5, 'covered carried on the spine event');

      // Terminal facts block carries both, with collected 0.
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const facts = completedEvent.data.collection_facts;
      const items = facts.streams.find((entry) => entry.stream === 'items');
      assert.ok(items, 'items entry present in the facts block');
      assert.equal(items.collected, 0, 'collected is 0 — every item was suppressed-unchanged');
      assert.equal(items.considered, 5, 'considered carried onto the facts block');
      assert.equal(items.covered, 5, 'covered carried onto the facts block — the numerator the gate uses');
      assert.equal(items.checkpoint, 'committed', 'the committed STATE still commits');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('4.4: a malformed / unsafe DETAIL_COVERAGE.covered is dropped to unknown (omitted), considered preserved', async () => {
    // Same drop-don't-reject posture as considered: an unsafe covered count never
    // fabricates a numerator and never fails the run; it is simply omitted, and
    // the gate falls back to collected for that stream.
    for (const covered of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '4', Number.MAX_SAFE_INTEGER + 1]) {
      const manifest = buildMultiStreamManifest('facts-covered-bad');
      const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
      const { asPort, rsPort } = server;
      const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
      const asUrl = `http://localhost:${asPort}`;

      const { connectorPath, cleanup } = createTestConnector([
        {
          type: 'DETAIL_COVERAGE',
          reference_only: true,
          state_stream: 'items',
          stream: 'items',
          required_keys: [],
          hydrated_keys: [],
          considered: 5,
          covered,
        },
        { type: 'STATE', stream: 'items', cursor: { last: 'i5' } },
        { type: 'DONE', status: 'succeeded', records_emitted: 0 },
      ]);

      try {
        const result = await runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest,
          scope: { streams: [{ name: 'items' }] },
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
          onInteraction: async () => ({}),
        });

        assert.equal(result.status, 'succeeded', `covered=${String(covered)} must not reject the run`);
        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
        const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
        const items = completedEvent.data.collection_facts.streams.find((entry) => entry.stream === 'items');
        assert.equal(items.considered, 5, `considered preserved while covered=${String(covered)} dropped`);
        assert.equal(items.covered, undefined, `covered=${String(covered)} must drop to unknown (omitted)`);
      } finally {
        cleanup();
        await closeServer(server);
      }
    }
  });

  await t.test('2.2a: a RECORD/STATE/DONE-only connector still yields a valid facts block with unknown considered (task 2.6 at runtime scope)', async () => {
    // The portability floor: a connector that emits only RECORD/STATE/DONE — no
    // DETAIL_COVERAGE, no SKIP_RESULT — still produces a valid per-stream facts
    // block. Its considered axis is just absent (unknown); no derived axes.
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { last: 'i1' } },
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
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const facts = completedEvent.data.collection_facts;
      assert.ok(facts, 'facts block present for a RECORD/STATE/DONE-only connector');
      assert.equal(facts.streams.length, 1);
      const entry = facts.streams[0];
      assert.equal(entry.stream, 'items');
      assert.equal(entry.collected, 1);
      assert.equal(entry.checkpoint, 'committed');
      assert.equal('considered' in entry, false, 'no considered evidence -> unknown (absent)');
      assert.equal('coverage' in entry, false);
      assert.equal('forward_disposition' in entry, false);
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('2.2a (2.7 invariant): the facts block perturbs no existing terminal-event field', async () => {
    // Golden-payload regression: a representative success run still carries every
    // pre-existing terminal field with its prior shape; the only addition is the
    // additive collection_facts block.
    const manifest = buildMultiStreamManifest('facts-2-7-invariant');
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort, manifest);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { last: 'i1' } },
      { type: 'DONE', status: 'succeeded', records_emitted: 1 },
    ]);

    try {
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        scope: { streams: [{ name: 'items' }] },
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => ({}),
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      const data = completedEvent.data;

      // Pre-existing terminal fields keep their presence and shape.
      assert.equal(data.records_emitted, 1, 'records_emitted unchanged');
      assert.equal(data.records_flushed, 1, 'records_flushed unchanged');
      assert.equal(data.buffered_records_dropped, 0, 'buffered_records_dropped unchanged');
      assert.equal(data.persist_state, true, 'persist_state unchanged');
      assert.equal(data.checkpoint_mode, 'checkpointed_streaming', 'checkpoint_mode unchanged');
      assert.equal(data.checkpoint_commit_status, 'committed', 'checkpoint_commit_status unchanged');
      assert.equal(data.state_streams_staged, 1, 'state_streams_staged unchanged');
      assert.equal(data.state_streams_committed, 1, 'state_streams_committed unchanged');
      assert.equal(data.known_gaps, undefined, 'no known_gaps on a clean success (unchanged)');
      assert.equal(data.detail_gaps, undefined, 'no detail_gaps on a clean success (unchanged)');

      // The only new field is the additive facts block.
      assert.ok(data.collection_facts, 'collection_facts is the additive block');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('2.2a: the facts block also rides the run.failed terminal event, still facts-only', async () => {
    // buildRunTerminalData() composes the block for every terminal event; prove
    // it on a connector-reported failure too, with its collected/checkpoint facts
    // intact and still no derived axis.
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'i1', data: { id: 'i1', value: 'a' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: { last: 'i1' } },
      { type: 'DONE', status: 'failed', records_emitted: 1, error: { message: 'upstream 500', retryable: true } },
    ]);

    try {
      // A connector-reported DONE(failed) resolves with status 'failed' (it does
      // not reject — the runtime recorded a clean terminal event for it).
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
      assert.equal(result.status, 'failed', 'DONE(failed) resolves as failed');

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const failedEvent = (timeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed terminal event');

      const facts = failedEvent.data.collection_facts;
      assert.ok(facts, 'collection_facts present on the failed terminal event');
      const itemsEntry = facts.streams.find((entry) => entry.stream === 'items');
      assert.equal(itemsEntry.collected, 1, 'collected count recorded on a failed run');
      // The failed run staged but committed no checkpoint (commit gates on success).
      assert.equal(itemsEntry.checkpoint, 'not_committed', 'staged-but-not-committed checkpoint on a failed run');
      assert.equal('coverage' in itemsEntry, false, 'no coverage condition even on failure');
      assert.equal('forward_disposition' in itemsEntry, false, 'no forward_disposition even on failure');
      assert.equal(failedEvent.data.coverage_axis, undefined, 'no coverage_axis on the failed terminal event');
      assert.equal(failedEvent.data.forward_disposition, undefined, 'no forward_disposition on the failed terminal event');
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
    const providerBudget = {
      object: 'provider_budget_circuit_transition',
      circuit: {
        previous_state: 'open',
        state: 'half_open',
        trigger: 'before_request',
        reason: 'reset_timeout',
      },
      elapsed_ms: 1000,
      request_count: 2,
      retry_tokens_remaining: 'unbounded',
    };

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'PROGRESS',
        stream: 'items',
        message: 'Fetching first page',
        count: 1,
        total: 3,
        provider_budget: providerBudget,
      },
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
      assert.deepEqual(seenProgress[0].provider_budget, providerBudget);

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
      assert.deepEqual(progressEvent.data.provider_budget, providerBudget);
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('runtime persists collection_rate in spine events and terminal event', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;
    const seenProgress = [];
    const collectionRate = {
      object: 'collection_rate',
      ceiling_interval_ms: 1000,
      ceiling_rate_per_min: 60,
      current_interval_ms: 1500,
      effective_rate_per_min: 40,
      last_backoff: { at_interval_ms: 2000, reason: 'throttle' },
    };

    const { connectorPath, cleanup } = createTestConnector([
      {
        type: 'PROGRESS',
        stream: 'items',
        message: 'Collection rate 40/min (interval 1500ms; ceiling 60/min)',
        collection_rate: collectionRate,
      },
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
      assert.deepEqual(seenProgress[0].collection_rate, collectionRate);

      // collection_rate must appear in the run.progress_reported spine event.
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const progressEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.progress_reported');
      assert.ok(progressEvent, 'expected run.progress_reported event');
      assert.deepEqual(progressEvent.data.collection_rate, collectionRate,
        'collection_rate must be persisted in the spine event data');

      // collection_rate must also appear on the terminal event for post-run
      // projection (the reference→snapshot plumbing hop).
      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      assert.ok(completedEvent, 'expected run.completed event');
      assert.deepEqual(completedEvent.data.collection_rate, collectionRate,
        'collection_rate must be stamped on the terminal event for post-run snapshot derivation');

      // The connection health snapshot must surface the collection_rate field.
      const { body: connectorDetail } = await fetchJson(
        `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`
      );
      assert.ok(connectorDetail, 'connector detail must be accessible');
      const health = connectorDetail.connection_health;
      assert.ok(health, 'connection_health must be present');
      assert.deepEqual(health.collection_rate, {
        ceiling_interval_ms: collectionRate.ceiling_interval_ms,
        ceiling_rate_per_min: collectionRate.ceiling_rate_per_min,
        current_interval_ms: collectionRate.current_interval_ms,
        effective_rate_per_min: collectionRate.effective_rate_per_min,
        last_backoff: collectionRate.last_backoff,
      }, 'connection_health.collection_rate must reflect the latest rate-change event');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test('connection_health.collection_rate is null when no rate event has been emitted', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    // Run with a plain PROGRESS event that carries no collection_rate.
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'PROGRESS', stream: 'items', message: 'Fetching page', count: 1, total: 3 },
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
        onProgress: () => {},
      });

      assert.equal(result.status, 'succeeded');

      const { body: connectorDetail } = await fetchJson(
        `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`
      );
      assert.ok(connectorDetail, 'connector detail must be accessible');
      assert.equal(connectorDetail.connection_health?.collection_rate, null,
        'collection_rate must be null when no rate event was emitted (honest unknown, no false rate)');
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

      const assistanceRequested = (runTimeline.data || []).find((event) => event.event_type === 'run.assistance_requested');
      assert.ok(assistanceRequested, 'expected run.assistance_requested event');
      assert.equal(assistanceRequested.interaction_id, 'int_1');
      assert.equal(assistanceRequested.data.assistance_request_id, 'int_1');
      assert.equal(assistanceRequested.data.progress_posture, 'blocked');
      assert.equal(assistanceRequested.data.owner_action, 'provide_value');
      assert.equal(assistanceRequested.data.response_contract, 'response_required');
      assert.equal(assistanceRequested.data.sensitivity, 'secret');
      assert.equal(assistanceRequested.data.kind, 'credentials');
      assert.equal(assistanceRequested.data.message, 'Enter password');
      assert.deepEqual(assistanceRequested.data.input_schema, {
        type: 'object',
        properties: { password: { type: 'string', format: 'password' } },
        required: ['password'],
      });

      const interactionCompleted = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_completed');
      assert.ok(interactionCompleted, 'expected run.interaction_completed event');
      assert.equal(interactionCompleted.status, 'success');
      assert.equal(interactionCompleted.data.status, 'success');
      assert.equal(interactionCompleted.data.kind, 'credentials');
      assert.equal(interactionCompleted.data.stream, null);

      const assistanceResolved = (runTimeline.data || []).find((event) => event.event_type === 'run.assistance_resolved');
      assert.ok(assistanceResolved, 'expected run.assistance_resolved event');
      assert.equal(assistanceResolved.interaction_id, 'int_1');
      assert.equal(assistanceResolved.data.assistance_request_id, 'int_1');
      assert.equal(assistanceResolved.data.status, 'success');
      assert.equal(assistanceResolved.data.kind, 'credentials');

      const serializedTimeline = JSON.stringify(runTimeline.data || []);
      assert.ok(!serializedTimeline.includes('test123'), 'run timelines should not persist INTERACTION_RESPONSE secret values');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('browser-surface-backed otp INTERACTION projects streamable assistance with secret input', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-interaction-browser-otp-'));
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
      request_id: 'int_otp_browser',
      kind: 'otp',
      message: 'Enter code',
      schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      timeout_seconds: 300
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'items', key: 'after_otp', data: { id: 'after_otp', value: 'continued' }, emitted_at: new Date().toISOString() }) + '\\n');
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
        browserSurfaceEnv: {
          PDPP_BROWSER_SURFACE_REQUIRED: 'neko',
          PDPP_BROWSER_SURFACE_STREAM_BASE_URL: 'http://surface.example.test',
        },
        onInteraction: async (msg) => {
          assert.equal(msg.kind, 'otp');
          return { type: 'INTERACTION_RESPONSE', request_id: msg.request_id, status: 'success', data: { code: '123456' } };
        },
      });

      assert.equal(result.status, 'succeeded');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const assistanceRequested = (runTimeline.data || []).find((event) => event.event_type === 'run.assistance_requested');
      assert.ok(assistanceRequested, 'expected run.assistance_requested event');
      assert.equal(assistanceRequested.interaction_id, 'int_otp_browser');
      assert.equal(assistanceRequested.data.owner_action, 'operate_attachment');
      assert.equal(assistanceRequested.data.response_contract, 'response_required');
      assert.equal(assistanceRequested.data.sensitivity, 'secret');
      assert.equal(assistanceRequested.data.kind, 'otp');
      assert.deepEqual(assistanceRequested.data.attachments, [{ kind: 'browser_surface', role: 'streaming_companion' }]);
      assert.deepEqual(assistanceRequested.data.input_schema, {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
      });
      assert.ok(!JSON.stringify(runTimeline.data || []).includes('123456'), 'run timelines should not persist OTP values');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('nonblocking ASSISTANCE records assistance without interaction-required behavior', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-assistance-nonblocking-'));
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
      type: 'ASSISTANCE',
      assistance_request_id: 'asst_1',
      progress_posture: 'running',
      owner_action: 'act_elsewhere',
      response_contract: 'none',
      sensitivity: 'non_secret',
      message: 'Approve at https://example.com/sensitive?token=secret with qr_secret=raw-qr-secret.',
      timeout_seconds: 120,
      input_schema: {
        type: 'object',
        properties: {
          otp: { type: 'string', default: '654321' },
          password: { type: 'string', format: 'password', examples: ['durable-password'] },
          note: { type: 'string', default: 'safe-default-also-redacted' }
        }
      },
      attachments: [{
        kind: 'url',
        role: 'approval',
        label: 'Open approval page https://example.com/sensitive?token=label-secret',
        ref: 'approval_ref_1',
        url: 'https://example.com/sensitive?token=secret',
        cdp_url: 'ws://example.com/devtools/browser/secret'
      }, {
        kind: 'qr',
        role: 'approval',
        label: 'Scan QR qr_secret=label-qr-secret',
        ref: 'qr_ref_1',
        status: 'available qr_secret=status-qr-secret',
        payload: 'otpauth://totp/example?secret=RAWQRSECRET',
        image_data: 'data:image/png;base64,RAWQRSECRET'
      }]
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'ASSISTANCE_STATUS',
      assistance_request_id: 'asst_1',
      status: 'resolved',
      message: 'Approval accepted at https://example.com/done?bearer=secret.'
    }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'items', key: 'after_assistance', data: { id: 'after_assistance', value: 'continued' }, emitted_at: new Date().toISOString() }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`, 'utf-8');

    try {
      let onInteractionCalled = false;
      const result = await runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest: MINIMAL_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        onInteraction: async () => {
          onInteractionCalled = true;
          return { type: 'INTERACTION_RESPONSE', request_id: 'unexpected', status: 'success' };
        },
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.records_emitted, 1);
      assert.equal(onInteractionCalled, false, 'nonblocking ASSISTANCE must not wait for interaction input');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const assistanceRequested = (runTimeline.data || []).find((event) => event.event_type === 'run.assistance_requested');
      assert.ok(assistanceRequested, 'expected run.assistance_requested event');
      assert.equal(assistanceRequested.data.assistance_request_id, 'asst_1');
      assert.equal(assistanceRequested.data.progress_posture, 'running');
      assert.equal(assistanceRequested.data.owner_action, 'act_elsewhere');
      assert.equal(assistanceRequested.data.response_contract, 'none');
      assert.equal(assistanceRequested.data.message, 'Approve at [REDACTED_URL] with qr_secret=[REDACTED]');
      assert.deepEqual(assistanceRequested.data.attachments, [{
        kind: 'url',
        role: 'approval',
        label: 'Open approval page [REDACTED_URL]',
        ref: 'approval_ref_1',
      }, {
        kind: 'qr',
        role: 'approval',
        label: 'Scan QR qr_secret=[REDACTED]',
        ref: 'qr_ref_1',
        status: 'available qr_secret=[REDACTED]',
      }]);
      assert.deepEqual(assistanceRequested.data.input_schema, {
        type: 'object',
        properties: {
          otp: { type: 'string', default: '[REDACTED]' },
          password: { type: 'string', format: 'password', examples: '[REDACTED]' },
          note: { type: 'string', default: '[REDACTED]' },
        },
      });
      const assistanceResolved = (runTimeline.data || []).find((event) => event.event_type === 'run.assistance_resolved');
      assert.ok(assistanceResolved, 'expected run.assistance_resolved event');
      assert.equal(assistanceResolved.data.assistance_request_id, 'asst_1');
      assert.equal(assistanceResolved.data.status, 'resolved');
      assert.equal(assistanceResolved.data.message, 'Approval accepted at [REDACTED_URL]');
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_required'));
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.interaction_completed'));
      const serializedTimeline = JSON.stringify(runTimeline.data || []);
      assert.doesNotMatch(serializedTimeline, /token=secret|token=label-secret|devtools\/browser\/secret|RAWQRSECRET|raw-qr-secret|label-qr-secret|status-qr-secret|654321|durable-password|bearer=secret/);
      assert.ok(!assistanceRequested.data.attachments.some((attachment) => attachment.kind === 'browser_surface'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('runtime rejects response-required ASSISTANCE without compatibility path', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-assistance-response-required-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({
      type: 'ASSISTANCE',
      progress_posture: 'blocked',
      owner_action: 'provide_value',
      response_contract: 'response_required',
      message: 'Enter the code.'
    }) + '\\n');
  }
});
`, 'utf-8');

    try {
      let rejected = null;
      await assert.rejects(
        () => runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest: MINIMAL_MANIFEST,
          state: null,
          collectionMode: 'full_refresh',
          persistState: true,
          rsUrl: `http://localhost:${rsPort}`,
        }),
        (err) => {
          rejected = err;
          assert.equal(
            err.message,
            'Connector emitted unsupported ASSISTANCE.response_contract: response_required is not supported by the nonblocking ASSISTANCE path',
          );
          return true;
        },
      );

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      assert.ok(!(runTimeline.data || []).some((event) => event.event_type === 'run.assistance_requested'));
      assert.ok((runTimeline.data || []).some((event) => event.event_type === 'run.failed'));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('nonblocking ASSISTANCE records retry/backoff and explicit escalation transitions', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const { asPort, rsPort } = server;
    const { ownerToken, connectorId } = await setupConnector(server, asPort);
    const asUrl = `http://localhost:${asPort}`;

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-assistance-escalation-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({
      type: 'ASSISTANCE',
      assistance_request_id: 'asst_retry',
      progress_posture: 'waiting_retry',
      owner_action: 'none',
      response_contract: 'none',
      sensitivity: 'none',
      message: 'Waiting for upstream retry window.'
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'ASSISTANCE_STATUS',
      assistance_request_id: 'asst_retry',
      status: 'escalated',
      message: 'Retry window expired; owner action is now required.'
    }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
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
      });

      assert.equal(result.status, 'succeeded');

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const assistanceRequested = (runTimeline.data || []).find((event) => event.event_type === 'run.assistance_requested');
      assert.ok(assistanceRequested, 'expected run.assistance_requested event');
      assert.equal(assistanceRequested.data.progress_posture, 'waiting_retry');
      assert.equal(assistanceRequested.data.owner_action, 'none');
      assert.equal(assistanceRequested.data.response_contract, 'none');
      assert.ok(!('attachments' in assistanceRequested.data), 'retry/backoff assistance should not imply a browser attachment');

      const assistanceEscalated = (runTimeline.data || []).find((event) => event.event_type === 'run.assistance_escalated');
      assert.ok(assistanceEscalated, 'expected run.assistance_escalated event');
      assert.equal(assistanceEscalated.data.assistance_request_id, 'asst_retry');
      assert.equal(assistanceEscalated.data.progress_posture, 'waiting_retry');
      assert.equal(assistanceEscalated.data.owner_action, 'none');
      assert.equal(assistanceEscalated.data.response_contract, 'none');
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
    const manifest = buildMultiStreamManifest('test-multi-stream-done-failed');
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
    const connectorId = 'invalid-ingest-response';
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
    const manifest1 = { ...MINIMAL_MANIFEST, connector_id: 'connector-a' };
    const manifest2 = { ...MINIMAL_MANIFEST, connector_id: 'connector-b' };

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
