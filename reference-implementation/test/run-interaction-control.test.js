/**
 * Tests for the owner-only reference control-plane run-interaction surface:
 *
 *   POST /_ref/runs/:runId/interaction
 *
 * Covers:
 *   - success response through _ref delivers an INTERACTION_RESPONSE and the
 *     run completes normally
 *   - cancelled response through _ref cancels the current pending interaction
 *   - stale interaction_id is rejected (409 interaction_id_mismatch)
 *   - no pending interaction is rejected (409 no_pending_interaction)
 *   - unknown / finished run is rejected (404 not_found)
 *   - submitted secret values do not appear in the run timeline payloads
 *   - contract validator knows the new operation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { validateRequest, listOperations } from '@pdpp/reference-contract';
import { canonicalConnectorKey } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: resp.status, body };
}

async function registerConnector(asUrl, manifest) {
  const registerResp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(registerResp.status, 201, 'register connector');
}

async function waitForPendingInteraction(asUrl, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    if (body && Array.isArray(body.data)) {
      const required = body.data.find((event) => event.event_type === 'run.interaction_required');
      const completed = body.data.find((event) => event.event_type === 'run.interaction_completed');
      if (required && !completed) return required;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for pending interaction on run ${runId}`);
}

async function waitForRunTerminal(asUrl, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    if (status === 200 && Array.isArray(body.data)) {
      const terminal = body.data.find((event) =>
        event.event_type === 'run.completed' || event.event_type === 'run.failed'
      );
      if (terminal) {
        return body;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

// Build a connector that echoes the INTERACTION_RESPONSE it receives back
// onto stderr as JSON so the test can inspect the payload the runtime
// delivered. stderr is captured by the connector harness but not by the
// spine, so the echo stays off the run timeline.
function buildEchoConnectorFixture(tmpDir, { cancelOnReceive = false } = {}) {
  const path = join(tmpDir, 'connector.mjs');
  writeFileSync(path, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
let started = false;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_echo_1',
      kind: 'credentials',
      message: 'Need credentials to continue.',
      schema: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          password: { type: 'string', format: 'password' },
        },
        required: ['username', 'password'],
      },
      timeout_seconds: 60,
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stderr.write('INTERACTION_RESPONSE_ECHO:' + JSON.stringify(msg) + '\\n');
    ${cancelOnReceive
      ? `process.stdout.write(JSON.stringify({ type: 'DONE', status: 'cancelled', records_emitted: 0 }) + '\\n');
         rl.close();
         process.exit(1);`
      : `process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
         rl.close();
         process.exit(0);`}
  }
});
`, 'utf8');
  return path;
}

function buildDelayedInteractionConnectorFixture(tmpDir, delayMs = 200) {
  const path = join(tmpDir, 'delayed-connector.mjs');
  writeFileSync(path, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
let started = false;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'START' && !started) {
    started = true;
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'INTERACTION',
        request_id: 'int_delayed_1',
        kind: 'otp',
        message: 'Need a code.',
        schema: {
          type: 'object',
          properties: {
            code: { type: 'string' },
          },
          required: ['code'],
        },
        timeout_seconds: 60,
      }) + '\\n');
    }, ${delayMs});
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`, 'utf8');
  return path;
}

async function withHarness(options, fn) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-ref-run-interaction-'));
  const connectorPath = buildEchoConnectorFixture(tmpDir, options || {});
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    connectorPathResolver: () => connectorPath,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  try {
    await registerConnector(asUrl, spotifyManifest);
    await fn({ server, asUrl, spotifyManifest });
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function withCustomHarness(connectorPath, fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    connectorPathResolver: () => connectorPath,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  try {
    await registerConnector(asUrl, spotifyManifest);
    await fn({ server, asUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function startRun(asUrl, connectorId) {
  const resp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/run`, {
    method: 'POST',
  });
  assert.equal(resp.status, 202);
  return resp.json();
}

test('POST /_ref/runs/:runId/interaction: success delivers response and run completes', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const resp = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        status: 'success',
        data: { username: 'alice', password: 's3cret' },
      }),
    });
    assert.equal(resp.status, 202);
    const ack = await resp.json();
    assert.equal(ack.object, 'run_interaction_ack');
    assert.equal(ack.run_id, started.run_id);
    assert.equal(ack.interaction_id, pending.interaction_id);
    assert.equal(ack.status, 'success');

    const timeline = await waitForRunTerminal(asUrl, started.run_id);
    const types = timeline.data.map((event) => event.event_type);
    assert.ok(types.includes('run.completed'), 'run should complete after interaction answered');
    const completedInteraction = timeline.data.find((event) => event.event_type === 'run.interaction_completed');
    assert.ok(completedInteraction, 'interaction_completed event should be recorded');
    assert.equal(completedInteraction.status, 'success');
  });
});

test('GET /_ref/inbox/:runId renders pending interaction HTML and JSON', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    try {
      const htmlResp = await fetch(`${asUrl}/_ref/inbox/${encodeURIComponent(started.run_id)}`);
      assert.equal(htmlResp.status, 200);
      assert.match(htmlResp.headers.get('content-type') || '', /text\/html/);
      const html = await htmlResp.text();
      assert.match(html, /Pending interaction/);
      assert.match(html, new RegExp(pending.interaction_id));
      assert.match(html, /Send success/);
      assert.match(html, /Cancel interaction/);

      const json = await fetchJson(`${asUrl}/_ref/inbox/${encodeURIComponent(started.run_id)}.json`);
      assert.equal(json.status, 200);
      assert.equal(json.body.object, 'ref_inbox_item');
      assert.deepEqual(json.body.data, {
        run_id: started.run_id,
        connector_id: canonicalConnectorKey(spotifyManifest.connector_id) ?? spotifyManifest.connector_id,
        interaction_id: pending.interaction_id,
        kind: 'credentials',
        stream: null,
      });
    } finally {
      await fetch(`${asUrl}/_ref/inbox/${encodeURIComponent(started.run_id)}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ interaction_id: pending.interaction_id }),
      });
      await waitForRunTerminal(asUrl, started.run_id);
    }
  });
});

test('POST /_ref/inbox/:runId/respond accepts minimal form success data', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const resp = await fetch(`${asUrl}/_ref/inbox/${encodeURIComponent(started.run_id)}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        interaction_id: pending.interaction_id,
        data_json: JSON.stringify({ code: '123456' }),
      }),
    });
    assert.equal(resp.status, 202);
    const ack = await resp.json();
    assert.equal(ack.object, 'run_interaction_ack');
    assert.equal(ack.status, 'success');

    const timeline = await waitForRunTerminal(asUrl, started.run_id);
    const completedInteraction = timeline.data.find((event) => event.event_type === 'run.interaction_completed');
    assert.ok(completedInteraction, 'interaction_completed event should be recorded');
    assert.equal(completedInteraction.status, 'success');
  });
});

test('POST /_ref/inbox/:runId/dismiss cancels the pending interaction', async () => {
  await withHarness({ cancelOnReceive: true }, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const resp = await fetch(`${asUrl}/_ref/inbox/${encodeURIComponent(started.run_id)}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ interaction_id: pending.interaction_id }),
    });
    assert.equal(resp.status, 202);
    const ack = await resp.json();
    assert.equal(ack.status, 'cancelled');

    const timeline = await waitForRunTerminal(asUrl, started.run_id);
    const completedInteraction = timeline.data.find((event) => event.event_type === 'run.interaction_completed');
    assert.ok(completedInteraction, 'interaction_completed event should be recorded for inbox cancel');
    assert.equal(completedInteraction.status, 'cancelled');
  });
});

test('POST /_ref/runs/:runId/interaction: cancelled cancels the pending interaction', async () => {
  await withHarness({ cancelOnReceive: true }, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const resp = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        status: 'cancelled',
      }),
    });
    assert.equal(resp.status, 202);
    const ack = await resp.json();
    assert.equal(ack.status, 'cancelled');

    const timeline = await waitForRunTerminal(asUrl, started.run_id);
    const completedInteraction = timeline.data.find((event) => event.event_type === 'run.interaction_completed');
    assert.ok(completedInteraction, 'interaction_completed event should be recorded for cancel');
    assert.equal(completedInteraction.status, 'cancelled');
  });
});

test('POST /_ref/runs/:runId/interaction: stale interaction_id is rejected with 409', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    await waitForPendingInteraction(asUrl, started.run_id);

    const resp = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: 'int_not_the_current_one',
        status: 'success',
        data: { username: 'alice', password: 's3cret' },
      }),
    });
    assert.equal(resp.status, 409);
    const body = await resp.json();
    assert.equal(body.error.code, 'interaction_id_mismatch');

    // Clean up the run so the harness doesn't hang on an abandoned run.
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        status: 'cancelled',
      }),
    });
    await waitForRunTerminal(asUrl, started.run_id);
  });
});

test('POST /_ref/runs/:runId/interaction: unknown run returns 404', async () => {
  await withHarness({}, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent('run_does_not_exist')}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interaction_id: 'int_nothing', status: 'success' }),
    });
    assert.equal(resp.status, 404);
    const body = await resp.json();
    assert.equal(body.error.code, 'not_found');
  });
});

test('POST /_ref/runs/:runId/interaction: active run with no pending interaction returns 409', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-ref-run-no-pending-'));
  const connectorPath = buildDelayedInteractionConnectorFixture(tmpDir, 250);
  try {
    await withCustomHarness(connectorPath, async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);

      const resp = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interaction_id: 'int_delayed_1',
          status: 'success',
          data: { code: '123456' },
        }),
      });
      assert.equal(resp.status, 409);
      const body = await resp.json();
      assert.equal(body.error.code, 'no_pending_interaction');

      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interaction_id: pending.interaction_id,
          status: 'success',
          data: { code: '123456' },
        }),
      });
      await waitForRunTerminal(asUrl, started.run_id);
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /_ref/runs/:runId/interaction: finished run returns 404', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    // Answer to let the run finish.
    await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        status: 'success',
        data: { username: 'alice', password: 's3cret' },
      }),
    });
    await waitForRunTerminal(asUrl, started.run_id);

    // Second attempt should no longer see an active run.
    const resp = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        status: 'success',
        data: { username: 'alice', password: 's3cret' },
      }),
    });
    assert.equal(resp.status, 404);
    const body = await resp.json();
    assert.equal(body.error.code, 'not_found');
  });
});

test('POST /_ref/runs/:runId/interaction: rejects invalid body', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    await waitForPendingInteraction(asUrl, started.run_id);

    const missing = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'success' }),
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, 'invalid_request');

    const badStatus = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interaction_id: 'int_x', status: 'nope' }),
    });
    assert.equal(badStatus.status, 400);
    assert.equal((await badStatus.json()).error.code, 'invalid_status');

    // Clean up run.
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interaction_id: pending.interaction_id, status: 'cancelled' }),
    });
    await waitForRunTerminal(asUrl, started.run_id);
  });
});

test('Submitted interaction secrets are never written to the run timeline', async () => {
  const SECRET_USERNAME = 'unique-username-sentinel-abc123';
  const SECRET_PASSWORD = 'unique-password-sentinel-xyz789';

  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const resp = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        status: 'success',
        data: { username: SECRET_USERNAME, password: SECRET_PASSWORD },
      }),
    });
    assert.equal(resp.status, 202);
    await waitForRunTerminal(asUrl, started.run_id);

    const timeline = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
    const raw = JSON.stringify(timeline.body);
    assert.ok(!raw.includes(SECRET_USERNAME), 'timeline must not contain submitted username');
    assert.ok(!raw.includes(SECRET_PASSWORD), 'timeline must not contain submitted password');
  });
});

test('reference-contract validator knows refRunInteraction', () => {
  const ops = listOperations();
  const ids = new Set(ops.map((op) => op.id));
  assert.ok(ids.has('refRunInteraction'), 'refRunInteraction must exist in reference manifests');

  const good = validateRequest('refRunInteraction', {
    params: { runId: 'run_abc' },
    body: { interaction_id: 'int_1', status: 'success', data: { username: 'alice' } },
  });
  assert.deepEqual(good, { ok: true });

  const missingStatus = validateRequest('refRunInteraction', {
    params: { runId: 'run_abc' },
    body: { interaction_id: 'int_1' },
  });
  assert.equal(missingStatus.ok, false);

  const badStatus = validateRequest('refRunInteraction', {
    params: { runId: 'run_abc' },
    body: { interaction_id: 'int_1', status: 'nope' },
  });
  assert.equal(badStatus.ok, false);
});
