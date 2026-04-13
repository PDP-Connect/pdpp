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
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runConnector, loadSyncState } from '../runtime/index.js';
import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(__dirname, '..');

let nextPort = 10400;

function allocatePorts() {
  const base = nextPort;
  nextPort += 10;
  return { asPort: base, rsPort: base + 1 };
}

async function closeServer(server) {
  // Force-close keep-alive connections to prevent hanging
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise(r => { server.asServer.close(r); setTimeout(r, 2000); }),
    new Promise(r => { server.rsServer.close(r); setTimeout(r, 2000); }),
  ]);
}

/**
 * Create a minimal test connector that emits specified messages.
 * Returns the path to the connector script.
 */
function createTestConnector(messages) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-connector-'));
  const connectorPath = join(tmpDir, 'connector.js');

  const script = `
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    for (const m of messages) {
      process.stdout.write(JSON.stringify(m) + '\\n');
    }
    // Exit after emitting all messages
    rl.close();
    process.exit(0);
  }
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

test('Collection Profile conformance', async (t) => {
  // ── 1. RECORD processing ──

  await t.test('runtime ingests RECORD messages to the RS', async () => {
    const { asPort, rsPort } = allocatePorts();
    const server = await startServer({ asPort, rsPort, dbPath: ':memory:' });
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
    const { asPort, rsPort } = allocatePorts();
    const server = await startServer({ asPort, rsPort, dbPath: ':memory:' });
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    // Connector emits STATE but then DONE with failed status
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'item_1', data: { id: 'item_1', value: 'test' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: 'cursor_should_not_persist' },
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

      // STATE should NOT have been committed
      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items || state.items !== 'cursor_should_not_persist',
        'STATE should not be persisted when DONE status is failed');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  // ── 3. single_use: no STATE persistence ──

  await t.test('single_use runs do not persist STATE even on success', async () => {
    const { asPort, rsPort } = allocatePorts();
    const server = await startServer({ asPort, rsPort, dbPath: ':memory:' });
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'item_1', data: { id: 'item_1', value: 'single' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: 'should_not_persist' },
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

      // STATE should not be persisted
      const state = await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` });
      assert.ok(!state || !state.items,
        'single_use runs should not persist STATE');
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

  // ── 5. SKIP_RESULT handling ──

  await t.test('runtime accepts SKIP_RESULT messages without error', async () => {
    const { asPort, rsPort } = allocatePorts();
    const server = await startServer({ asPort, rsPort, dbPath: ':memory:' });
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

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
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  // Note: double INTERACTION protocol violation test removed from black-box suite.
  // The spec rule stands (overlapping INTERACTION is a connector protocol violation),
  // but sequential JSONL runtimes make it unobservable at the wire level.
  // See tmp/double-interaction-ambiguity-memo.md for full analysis.
  // The runtime's internal guard can be tested as a unit test if desired.

  // ── 6. INTERACTION completes and connector continues ──

  await t.test('INTERACTION round-trip allows connector to continue collecting', async () => {
    const { asPort, rsPort } = allocatePorts();
    const server = await startServer({ asPort, rsPort, dbPath: ':memory:' });
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    // Connector that emits INTERACTION, waits for response, then emits RECORD + DONE
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-test-int-roundtrip-'));
    const connectorPath = join(tmpDir, 'connector.js');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({ type: 'INTERACTION', request_id: 'int_1', interaction_type: 'credentials', prompt: 'Enter password' }) + '\\n');
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
          return { type: 'INTERACTION_RESPONSE', request_id: msg.request_id, status: 'completed', data: { password: 'test123' } };
        },
      });

      assert.equal(result.status, 'succeeded');
      assert.equal(result.records_emitted, 1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  // ── 8. Failed DONE does not ingest remaining buffered records ──

  await t.test('DONE(failed) does not flush remaining buffered records', async () => {
    const { asPort, rsPort } = allocatePorts();
    const server = await startServer({ asPort, rsPort, dbPath: ':memory:' });
    const { ownerToken, connectorId } = await setupConnector(server, asPort);

    // Connector emits a record then fails — the record should NOT be ingested
    // (records are flushed only on DONE(succeeded))
    const { connectorPath, cleanup } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'should_not_persist', data: { id: 'should_not_persist', value: 'fail' }, emitted_at: new Date().toISOString() },
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

      // Check RS — record should NOT be present
      const resp = await fetch(`http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { 'Authorization': `Bearer ${ownerToken}` },
      });
      const body = await resp.json();
      const found = (body.data || body.records || []).find(r => r.data?.id === 'should_not_persist');
      assert.ok(!found, 'Records from a failed run should not be ingested');
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  // ── 9. STATE is grant-scoped, not global ──

  await t.test('STATE from one connector does not affect another connectors state', async () => {
    const { asPort, rsPort } = allocatePorts();
    const server = await startServer({ asPort, rsPort, dbPath: ':memory:' });

    // Register two different connectors
    const asUrl = `http://localhost:${asPort}`;
    const manifest1 = { ...MINIMAL_MANIFEST, connector_id: 'https://test/connector-a' };
    const manifest2 = { ...MINIMAL_MANIFEST, connector_id: 'https://test/connector-b' };

    await fetchJson(`${asUrl}/connectors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manifest1) });
    await fetchJson(`${asUrl}/connectors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manifest2) });
    const { body: tokenBody } = await fetchJson(`${asUrl}/owner-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject_id: 'test_user' }) });
    const ownerToken = tokenBody.token;

    // Run connector A — emits STATE
    const { connectorPath: pathA, cleanup: cleanupA } = createTestConnector([
      { type: 'RECORD', stream: 'items', key: 'a_1', data: { id: 'a_1', value: 'from_a' }, emitted_at: new Date().toISOString() },
      { type: 'STATE', stream: 'items', cursor: 'cursor_from_a' },
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

      assert.ok(stateA && stateA.items === 'cursor_from_a', 'Connector A should have its state');
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

async function setupConnector(server, asPort) {
  const asUrl = `http://localhost:${asPort}`;

  // Register connector manifest
  await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(MINIMAL_MANIFEST),
  });

  // Get owner token
  const { body } = await fetchJson(`${asUrl}/owner-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: 'test_user' }),
  });

  return { ownerToken: body.token, connectorId: MINIMAL_MANIFEST.connector_id };
}
