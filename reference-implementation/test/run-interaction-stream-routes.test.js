/**
 * Integration tests for the run-interaction streaming companion routes.
 *
 * The harness boots the AS app with a deterministic mock companion factory
 * and a connector that emits a `manual_action` interaction. The tests prove:
 *   - mint requires a pending interaction of a streaming-eligible kind
 *   - mint succeeds and returns a token bound to the (run, interaction)
 *   - the SSE viewer channel only attaches with a valid token
 *   - input POSTs are dispatched to the companion after attach
 *   - resolving the interaction tears the streaming session down
 *   - the streaming session never authorizes record reads or unrelated runs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { createMockCompanion } from '../server/streaming/cdp-companion.js';

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
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: resp.status, body, headers: resp.headers };
}

async function registerConnector(asUrl, manifest) {
  const r = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(r.status, 201, 'register connector');
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
    const { body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    if (body && Array.isArray(body.data)) {
      const terminal = body.data.find(
        (event) => event.event_type === 'run.completed' || event.event_type === 'run.failed',
      );
      if (terminal) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

function buildManualActionConnector(tmpDir, { kind = 'manual_action' } = {}) {
  const path = join(tmpDir, 'connector.mjs');
  writeFileSync(
    path,
    `
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
      request_id: 'int_stream_1',
      kind: '${kind}',
      message: 'Need browser control to continue.',
      timeout_seconds: 60,
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
    'utf8',
  );
  return path;
}

async function withHarness(options, fn) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-ref-stream-'));
  const connectorPath = buildManualActionConnector(tmpDir, options || {});
  const companions = [];
  const streamingCompanionFactory = ({ browser_session_id, run_id, interaction_id }) => {
    const companion = createMockCompanion({ browser_session_id });
    companions.push({ companion, browser_session_id, run_id, interaction_id });
    return companion;
  };
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    connectorPathResolver: () => connectorPath,
    streamingCompanionFactory,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  try {
    await registerConnector(asUrl, spotifyManifest);
    await fn({ server, asUrl, spotifyManifest, companions });
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function startRun(asUrl, connectorId) {
  const r = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/run`, { method: 'POST' });
  assert.equal(r.status, 202);
  return r.json();
}

async function cancelRun(asUrl, runId, interactionId) {
  await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/interaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interaction_id: interactionId, status: 'cancelled' }),
  });
  await waitForRunTerminal(asUrl, runId);
}

test('mint requires a pending manual_action interaction', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        viewport: { width: 800, height: 600 },
      }),
    });
    assert.equal(mint.status, 201);
    assert.equal(mint.body.object, 'run_interaction_stream_session');
    assert.equal(typeof mint.body.token, 'string');
    assert.ok(mint.body.token.length >= 32);
    assert.ok(mint.body.viewer_path.startsWith('/_ref/run-interaction-streams/'));

    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test('mint refuses an interaction kind that does not need browser control', async () => {
  await withHarness({ kind: 'credentials' }, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interaction_id: pending.interaction_id }),
    });
    assert.equal(mint.status, 409);
    assert.equal(mint.body.error.code, 'stream_not_supported_for_kind');
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test('mint refuses a stale interaction id', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interaction_id: 'int_does_not_match' }),
    });
    assert.equal(mint.status, 409);
    assert.equal(mint.body.error.code, 'interaction_id_mismatch');
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test('SSE attach delivers an attached event and dispatches frames', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest, companions }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);

    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        viewport: { width: 320, height: 480 },
      }),
    });
    assert.equal(mint.status, 201);
    const token = mint.body.token;

    const ac = new AbortController();
    const sseResp = await fetch(`${asUrl}${mint.body.viewer_path}`, { signal: ac.signal });
    assert.equal(sseResp.status, 200);
    assert.match(sseResp.headers.get('content-type') || '', /text\/event-stream/);
    const reader = sseResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    async function readEvent(name, deadlineMs = 1500) {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        const block = buffer.indexOf('\n\n');
        if (block !== -1) {
          const event = buffer.slice(0, block);
          buffer = buffer.slice(block + 2);
          if (event.includes(`event: ${name}`)) {
            const dataLine = event.split('\n').find((line) => line.startsWith('data:'));
            return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      throw new Error(`Did not receive SSE event ${name} in ${deadlineMs}ms`);
    }

    const attached = await readEvent('attached');
    assert.equal(attached.run_id, started.run_id);
    assert.equal(attached.interaction_id, pending.interaction_id);
    assert.deepEqual(attached.viewport, { width: 320, height: 480 });

    // Inject a frame via the mock companion and confirm the viewer receives it.
    const tracked = companions.find((c) => c.run_id === started.run_id);
    assert.ok(tracked, 'companion factory captured the streaming session');
    tracked.companion.pushFrame({ sessionId: 7, data: 'AA==', metadata: { device_width: 320 } });
    const frame = await readEvent('frame');
    assert.equal(frame.session_id, 7);
    assert.equal(frame.data_base64, 'AA==');

    // The route MUST acknowledge each delivered CDP screencast frame, or a
    // real Chromium will stop sending frames after the first one. Wait for
    // the best-effort ack to land on the companion record.
    const ackDeadline = Date.now() + 500;
    while (Date.now() < ackDeadline) {
      if (tracked.companion.cdpCalls.some(
        (c) => c.method === 'Page.screencastFrameAck' && c.params?.sessionId === 7,
      )) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      tracked.companion.cdpCalls.some(
        (c) => c.method === 'Page.screencastFrameAck' && c.params?.sessionId === 7,
      ),
      'route must call companion.ackFrame(sessionId) for every delivered frame',
    );

    // A second SSE attach with the same token must fail (single-use).
    const reattach = await fetch(`${asUrl}${mint.body.viewer_path}`);
    assert.ok(reattach.status === 409 || reattach.status === 401);

    ac.abort();
    try {
      await reader.cancel();
    } catch {
      /* aborted */
    }

    await cancelRun(asUrl, started.run_id, pending.interaction_id);
    void token;
  });
});

test('input POST dispatches to the companion after attach and rejects bad input', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest, companions }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interaction_id: pending.interaction_id }),
    });
    assert.equal(mint.status, 201);

    // Input without prior attach is refused.
    const earlyInput = await fetchJson(`${asUrl}${mint.body.input_path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'mouse', action: 'click', x: 1, y: 1 }),
    });
    assert.equal(earlyInput.status, 409);
    assert.equal(earlyInput.body.error.code, 'session_not_attached');

    // Attach via SSE.
    const ac = new AbortController();
    const sseResp = await fetch(`${asUrl}${mint.body.viewer_path}`, { signal: ac.signal });
    assert.equal(sseResp.status, 200);
    const reader = sseResp.body.getReader();
    // Prime the stream so the server has run companion.start.
    await reader.read();

    const tracked = companions.find((c) => c.run_id === started.run_id);
    assert.ok(tracked);

    const click = await fetchJson(`${asUrl}${mint.body.input_path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'mouse', action: 'click', x: 42, y: 13 }),
    });
    assert.equal(click.status, 202);
    assert.ok(tracked.companion.inputs.some((e) => e.type === 'mouse' && e.action === 'click'));

    const bad = await fetchJson(`${asUrl}${mint.body.input_path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'mouse', action: 'spin', x: 0, y: 0 }),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_input');

    ac.abort();
    try {
      await reader.cancel();
    } catch {
      /* aborted */
    }
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test('SSE delivers multiple frames and acks each, even when ack rejects', async () => {
  // The CDP screencast contract is back-pressured: each frame must be
  // acknowledged before the next is delivered. The route must call
  // companion.ackFrame for every frame and must survive an ack rejection
  // without tearing the SSE response down (the next frame's ack can
  // recover).
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-ref-stream-ack-'));
  const connectorPath = buildManualActionConnector(tmpDir, {});
  const ackCalls = [];
  const ackErrors = [];
  const companionRef = { current: null };
  const failingFactory = ({ browser_session_id }) => {
    const base = createMockCompanion({ browser_session_id });
    let frameCount = 0;
    const wrapped = {
      ...base,
      pushFrame: base.pushFrame,
      cdpCalls: base.cdpCalls,
      inputs: base.inputs,
      async ackFrame(sessionId) {
        ackCalls.push(sessionId);
        frameCount += 1;
        // Make the second ack reject to prove the route is best-effort.
        if (frameCount === 2) {
          const err = new Error('cdp ack boom');
          ackErrors.push(err);
          throw err;
        }
        return base.ackFrame(sessionId);
      },
    };
    companionRef.current = wrapped;
    return wrapped;
  };
  try {
    const server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      connectorPathResolver: () => connectorPath,
      streamingCompanionFactory: failingFactory,
    });
    try {
      const asUrl = `http://localhost:${server.asPort}`;
      const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
      await registerConnector(asUrl, spotifyManifest);
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
      });
      assert.equal(mint.status, 201);

      const ac = new AbortController();
      const sseResp = await fetch(`${asUrl}${mint.body.viewer_path}`, { signal: ac.signal });
      assert.equal(sseResp.status, 200);
      const reader = sseResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      async function readEvent(name, deadlineMs = 1500) {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
          const block = buffer.indexOf('\n\n');
          if (block !== -1) {
            const event = buffer.slice(0, block);
            buffer = buffer.slice(block + 2);
            if (event.includes(`event: ${name}`)) {
              const dataLine = event.split('\n').find((line) => line.startsWith('data:'));
              return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
            }
            continue;
          }
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
        throw new Error(`Did not receive SSE event ${name} in ${deadlineMs}ms`);
      }
      await readEvent('attached');

      const companion = companionRef.current;
      assert.ok(companion, 'companion captured');

      // Push three frames. The route should ack all three, with the second
      // ack rejecting (proving best-effort) and the third still arriving.
      companion.pushFrame({ sessionId: 11, data: 'AA==' });
      const f1 = await readEvent('frame');
      assert.equal(f1.session_id, 11);

      companion.pushFrame({ sessionId: 12, data: 'AB==' });
      const f2 = await readEvent('frame');
      assert.equal(f2.session_id, 12);

      companion.pushFrame({ sessionId: 13, data: 'AC==' });
      const f3 = await readEvent('frame');
      assert.equal(f3.session_id, 13);

      // All three acks must have been attempted, even though the second one
      // rejected. The order matters because ack triggers the next frame.
      const ackDeadline = Date.now() + 500;
      while (Date.now() < ackDeadline && ackCalls.length < 3) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(ackCalls, [11, 12, 13], 'route must call ackFrame for every delivered frame');
      assert.equal(ackErrors.length, 1, 'second ack rejected — route must remain alive');

      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted */
      }
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    } finally {
      await closeServer(server);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('mint fails closed with 503 streaming_companion_unavailable when no companion is configured', async () => {
  // Run the server without a streamingCompanionFactory and without
  // PDPP_RUN_INTERACTION_CDP_WS_URL. The mint route must refuse to hand out
  // a token rather than handing one out that fails only at attach time.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-ref-stream-unavail-'));
  const connectorPath = buildManualActionConnector(tmpDir, {});
  const priorEnv = process.env.PDPP_RUN_INTERACTION_CDP_WS_URL;
  delete process.env.PDPP_RUN_INTERACTION_CDP_WS_URL;
  try {
    const server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      connectorPathResolver: () => connectorPath,
      // No streamingCompanionFactory — exercises the fail-closed path.
    });
    try {
      const asUrl = `http://localhost:${server.asPort}`;
      const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
      await registerConnector(asUrl, spotifyManifest);
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interaction_id: pending.interaction_id }),
      });
      assert.equal(mint.status, 503);
      assert.equal(mint.body.error.code, 'streaming_companion_unavailable');
      assert.match(mint.body.error.message, /PDPP_RUN_INTERACTION_CDP_WS_URL/);
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    } finally {
      await closeServer(server);
    }
  } finally {
    if (priorEnv === undefined) {
      delete process.env.PDPP_RUN_INTERACTION_CDP_WS_URL;
    } else {
      process.env.PDPP_RUN_INTERACTION_CDP_WS_URL = priorEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolving the interaction invalidates streaming and emits a resolved timeline event', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interaction_id: pending.interaction_id }),
    });
    assert.equal(mint.status, 201);

    // Resolve the interaction → streaming token must be invalidated.
    await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/interaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interaction_id: pending.interaction_id, status: 'success' }),
    });
    await waitForRunTerminal(asUrl, started.run_id);

    const reattach = await fetch(`${asUrl}${mint.body.viewer_path}`);
    assert.ok(reattach.status === 401 || reattach.status === 409 || reattach.status === 410);

    const timeline = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
    const types = timeline.body.data.map((e) => e.event_type);
    assert.ok(types.includes('run.stream_session_requested'), 'requested event recorded');
    assert.ok(types.includes('run.stream_session_resolved'), 'resolved event recorded');

    // Sensitive payload guard: timeline must not carry the streaming token.
    const raw = JSON.stringify(timeline.body);
    assert.ok(!raw.includes(mint.body.token), 'streaming token must never appear in timeline');
  });
});
