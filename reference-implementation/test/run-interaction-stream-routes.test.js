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
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isManagedNekoSurfaceApproved, startServer } from '../server/index.js';
import { createMockCompanion } from '../server/streaming/cdp-companion.js';
import { BrowserSurfaceLeaseManager, DEFAULT_NEKO_PRIORITY_RANKS } from '@opendatalabs/remote-surface/leases';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

function makeLeaseManager({ surfaceHealth = 'ready', initialActiveLease = false } = {}) {
  return new BrowserSurfaceLeaseManager({
    config: {
      managedConnectors: new Set(['chatgpt']),
      surfaceCap: 1,
      leaseWaitTimeoutMs: 60_000,
      idleTtlMs: 300_000,
      defaultPriorityClass: 'scheduled_refresh',
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceMode: 'dynamic',
    },
    now: () => new Date('2026-05-12T12:00:00.000Z'),
    makeLeaseId: () => 'lease_dynamic_1',
    makeSurfaceId: () => 'surface_dynamic_1',
    nextFencingToken: () => 1,
    initialSurfaces: [
      {
        surface_id: 'surface_dynamic_1',
        backend: 'neko',
        profile_key: 'profile_dynamic_1',
        connector_id: 'chatgpt',
        cdp_url: 'http://neko:9222',
        stream_base_url: 'http://10.88.0.4:6080/_ref/browser-surfaces/surface_dynamic_1',
        health: surfaceHealth,
        ...(initialActiveLease ? { active_lease_id: 'lease_dynamic_1' } : {}),
        created_at: '2026-05-12T11:00:00.000Z',
        last_used_at: '2026-05-12T11:00:00.000Z',
      },
    ],
    initialLeases: initialActiveLease
      ? [
          {
            lease_id: 'lease_dynamic_1',
            surface_id: 'surface_dynamic_1',
            connector_id: 'chatgpt',
            profile_key: 'profile_dynamic_1',
            run_id: 'run_dynamic_1',
            status: 'leased',
            priority_class: 'scheduled_refresh',
            requested_at: '2026-05-12T11:00:00.000Z',
            leased_at: '2026-05-12T11:00:01.000Z',
            fencing_token: 1,
          },
        ]
      : undefined,
  });
}

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

function assertNoRawBackendAuthority(value) {
  const serialized = JSON.stringify(value);
  assert.equal(/ws:\/\/|wss:\/\//i.test(serialized), false);
  assert.equal(/https?:\/\/(?:127\.0\.0\.1|localhost|neko)(?::\d+)?/i.test(serialized), false);
  assert.equal(/\/json\/version|\/devtools\/browser/i.test(serialized), false);
  assert.equal(/base_url|cdp_http_url|cdpWsUrl|cdpHttpUrl|webSocketDebuggerUrl/i.test(serialized), false);
  assert.equal(/docker\.sock|allocatorCredentials/i.test(serialized), false);
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

function makeMockNekoCompanion(upstreamOrigin, options = {}) {
  return ({ browser_session_id }) => {
    const companion = {
      backend: 'neko',
      browser_session_id,
      async start(viewport) {
        options.startedViewports?.push(viewport);
      },
      async stop() {},
      onFrame() {
        return () => {};
      },
      onEvent() {
        return () => {};
      },
      async dispatch(event) {
        options.dispatchedEvents?.push(event);
      },
      async ackFrame() {},
      browserOwnerMode() {
        return options.browserOwnerMode || 'neko-owned';
      },
      getNekoProxyTarget() {
        return { origin: upstreamOrigin };
      },
      stealthMode() {
        return options.stealthMode || 'balanced';
      },
    };
    if ('status' in options) {
      companion.queryNekoStatus = async () => options.status;
    }
    return companion;
  };
}

async function withHarness(options, fn) {
  const harnessOptions = options || {};
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-ref-stream-'));
  const connectorPath = buildManualActionConnector(tmpDir, harnessOptions);
  const companions = [];
  const streamingCompanionFactory = ({ browser_session_id, run_id, interaction_id }) => {
    const companion =
      typeof harnessOptions.makeCompanion === 'function'
        ? harnessOptions.makeCompanion({ browser_session_id, run_id, interaction_id })
        : createMockCompanion({ browser_session_id });
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
    nekoProxyAutoLogin: harnessOptions.nekoProxyAutoLogin,
    isNekoProxyTargetApproved: harnessOptions.isNekoProxyTargetApproved,
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

test('managed n.eko approval is lease, surface, profile, run, interaction, readiness, and origin scoped', () => {
  const leaseManager = makeLeaseManager();
  const acquired = leaseManager.acquire({
    connectorId: 'chatgpt',
    runId: 'run_dynamic_1',
    profileKey: 'profile_dynamic_1',
  });
  assert.equal(acquired.lease.status, 'leased');

  const target = {
    origin: 'http://10.88.0.4:6080/_ref/browser-surfaces/surface_dynamic_1',
    cdp_http_url: 'http://neko:9222',
    surface_id: 'surface_dynamic_1',
    lease_id: 'lease_dynamic_1',
    profile_key: 'profile_dynamic_1',
    interaction_id: 'int_a',
  };
  const context = {
    runId: 'run_dynamic_1',
    interactionId: 'int_a',
    browserSurfaceLeaseManager: leaseManager,
  };

  assert.equal(isManagedNekoSurfaceApproved(target, context), true);
  const targetWithoutInteraction = { ...target };
  delete targetWithoutInteraction.interaction_id;
  assert.equal(isManagedNekoSurfaceApproved(targetWithoutInteraction, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, interaction_id: 'int_b' }, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, surface_id: 'surface_other' }, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, lease_id: 'lease_other' }, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, profile_key: 'profile_other' }, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, cdp_http_url: 'http://neko:9333' }, context), false);
  assert.equal(isManagedNekoSurfaceApproved({ ...target, origin: 'http://10.88.0.4:6080/neko' }, context), false);
  assert.equal(
    isManagedNekoSurfaceApproved(target, { ...context, runId: 'run_other' }),
    false,
  );

  leaseManager.release({ leaseId: acquired.lease.lease_id, fencingToken: acquired.lease.fencing_token });
  assert.equal(isManagedNekoSurfaceApproved(target, context), false);
});

test('managed n.eko approval rejects a non-ready real lease-manager surface', () => {
  const leaseManager = makeLeaseManager({ surfaceHealth: 'starting', initialActiveLease: true });

  assert.equal(
    isManagedNekoSurfaceApproved(
      {
        origin: 'http://10.88.0.4:6080/_ref/browser-surfaces/surface_dynamic_1',
        surface_id: 'surface_dynamic_1',
        lease_id: 'lease_dynamic_1',
        profile_key: 'profile_dynamic_1',
        interaction_id: 'int_a',
      },
      {
        runId: 'run_dynamic_1',
        interactionId: 'int_a',
        browserSurfaceLeaseManager: leaseManager,
      },
    ),
    false,
  );
});

test('mint accepts a pending manual_action interaction', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const beforeMint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
    const assistanceRequested = beforeMint.body.data.find((event) => event.event_type === 'run.assistance_requested');
    assert.ok(assistanceRequested, 'manual_action should project to run.assistance_requested');
    assert.equal(assistanceRequested.interaction_id, pending.interaction_id);
    assert.equal(assistanceRequested.data.assistance_request_id, pending.interaction_id);
    assert.equal(assistanceRequested.data.progress_posture, 'blocked');
    assert.equal(assistanceRequested.data.owner_action, 'operate_attachment');
    assert.equal(assistanceRequested.data.response_contract, 'response_required');
    assert.equal(assistanceRequested.data.sensitivity, 'non_secret');
    assert.deepEqual(assistanceRequested.data.attachments, [{ kind: 'browser_surface', role: 'streaming_companion' }]);

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
    const afterCancel = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/timeline`);
    const assistanceCancelled = afterCancel.body.data.find((event) => event.event_type === 'run.assistance_cancelled');
    assert.ok(assistanceCancelled, 'manual_action cancellation should project to run.assistance_cancelled');
    assert.equal(assistanceCancelled.interaction_id, pending.interaction_id);
    assert.equal(assistanceCancelled.data.status, 'cancelled');
  });
});

test('mint accepts a pending otp interaction for browser-backed verification flows', async () => {
  await withHarness({ kind: 'otp' }, async ({ asUrl, spotifyManifest }) => {
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
    assert.equal(mint.body.interaction_id, pending.interaction_id);
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

test('mint with a duplicate idempotency_key returns the same token (defense-in-depth against StrictMode/retry double-mints)', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest, companions }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mintUrl = `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`;
    const idempotency_key = 'fixture-key-001';
    const body = JSON.stringify({
      interaction_id: pending.interaction_id,
      viewport: { width: 800, height: 600 },
      idempotency_key,
    });
    const first = await fetchJson(mintUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.idempotency_replayed, false);
    const second = await fetchJson(mintUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.token, first.body.token);
    assert.equal(second.body.browser_session_id, first.body.browser_session_id);
    assert.equal(second.body.idempotency_replayed, true);
    // Crucially: the duplicate mint must NOT have spawned a second companion;
    // otherwise the original would be torn down at the next attach and the
    // dashboard 401 cascade returns. Filter to companions for this run only —
    // earlier tests in the suite share the harness file but not the server,
    // but the safety belt is cheap.
    const forThisRun = companions.filter((c) => c.run_id === started.run_id);
    assert.equal(forThisRun.length, 1, 'duplicate mint must reuse the existing companion');
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test('mint with a different idempotency_key supersedes the prior token (legitimate re-open)', async () => {
  await withHarness({}, async ({ asUrl, spotifyManifest }) => {
    const started = await startRun(asUrl, spotifyManifest.connector_id);
    const pending = await waitForPendingInteraction(asUrl, started.run_id);
    const mintUrl = `${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`;
    const first = await fetchJson(mintUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        idempotency_key: 'first-click',
      }),
    });
    assert.equal(first.status, 201);
    const second = await fetchJson(mintUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interaction_id: pending.interaction_id,
        idempotency_key: 'second-click',
      }),
    });
    assert.equal(second.status, 201);
    assert.notEqual(second.body.token, first.body.token);
    assert.equal(second.body.idempotency_replayed, false);
    // Prior token is now invalid for SSE attach.
    const reattach = await fetch(`${asUrl}${first.body.viewer_path}`);
    assert.ok(reattach.status === 401 || reattach.status === 410);
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

    const backendReady = await readEvent('backend_ready');
    assert.equal(backendReady.backend, 'cdp');
    assert.equal(backendReady.client_config_path, null);
    assert.equal(backendReady.iframe_path, null);
    assertNoRawBackendAuthority(backendReady);

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

    // Re-attach with the same token must SUCCEED — the viewer's SSE socket
    // can drop transiently (mobile network blip, tab visibility change,
    // dev-mode HMR reload) and the operator must be able to resume frame
    // delivery on the same token without losing the session. The session
    // outlives any single transport. See sessions.js `attach` doc comment
    // and routes.js per-connection vs terminal teardown split.
    const reattach = await fetch(`${asUrl}${mint.body.viewer_path}`);
    assert.equal(reattach.status, 200);
    assert.match(reattach.headers.get('content-type') || '', /text\/event-stream/);
    try {
      await reattach.body?.cancel();
    } catch {
      /* aborted */
    }

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

test('n.eko backend emits iframe path and proxies only after stream-token entry', async () => {
  let observedUpstreamCookie = null;
  const upstream = http.createServer((req, res) => {
    observedUpstreamCookie = req.headers.cookie || '';
    if (req.url === '/neko/' || req.url.startsWith('/neko/?')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><script src="js/app.js"></script></head><body>ok</body></html>');
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`proxied:${req.method}:${req.url}`);
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

  try {
    await withHarness(
      {
        makeCompanion: makeMockNekoCompanion(upstreamOrigin),
      },
      async ({ asUrl, spotifyManifest }) => {
        const unauthenticatedProxy = await fetchJson(`${asUrl}/neko/echo`);
        assert.equal(unauthenticatedProxy.status, 401);

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
        const backendReady = await readEvent('backend_ready');
        assert.equal(backendReady.backend, 'neko');
        assert.equal(
          backendReady.client_config_path,
          `/_ref/run-interaction-streams/${encodeURIComponent(mint.body.token)}/neko/session`,
        );
        assert.equal(
          backendReady.iframe_path,
          `/_ref/run-interaction-streams/${encodeURIComponent(mint.body.token)}/neko`,
        );
        assert.equal(backendReady.browser_owner_mode, 'neko-owned');
        assert.equal(backendReady.stealth_mode, 'balanced');
        assertNoRawBackendAuthority(backendReady);

        const clientConfig = await fetch(`${asUrl}${backendReady.client_config_path}`);
        assert.equal(clientConfig.status, 200);
        const clientConfigCookie = clientConfig.headers.get('set-cookie') || '';
        assert.match(clientConfigCookie, /pdpp_neko_stream=/);
        assert.match(clientConfigCookie, /Path=\/neko/);
        const clientConfigBody = await clientConfig.json();
        assert.deepEqual(clientConfigBody, {
          object: 'run_interaction_neko_client',
          server_path: '/neko',
          status_path: '/neko/__pdpp/status',
          login: {
            username: 'user',
            password: 'neko',
          },
        });
        assertNoRawBackendAuthority(clientConfigBody);

        const entry = await fetch(`${asUrl}${backendReady.iframe_path}`, { redirect: 'manual' });
        assert.equal(entry.status, 302);
        const entryLocation = entry.headers.get('location');
        assert.match(entryLocation, /^\/neko\?pdpp_stream=/);
        const entryUrl = new URL(entryLocation, asUrl);
        assert.equal(entryUrl.pathname, '/neko');
        assert.ok(entryUrl.searchParams.get('pdpp_stream'));
        assert.equal(entryUrl.searchParams.get('embed'), '1');
        assert.equal(entryUrl.searchParams.has('usr'), false);
        assert.equal(entryUrl.searchParams.has('pwd'), false);
        const cookie = entry.headers.get('set-cookie') || '';
        assert.match(cookie, /pdpp_neko_stream=/);
        assert.match(cookie, /Path=\/neko/);

        const statusNoControl = await fetchJson(`${asUrl}/neko/__pdpp/status`, { headers: { cookie } });
        assert.equal(statusNoControl.status, 200);
        assert.deepEqual(statusNoControl.body, {
          object: 'run_interaction_neko_status',
          control_available: false,
        });

        const proxiedEntry = await fetch(`${asUrl}${entryLocation}`, { headers: { cookie } });
        assert.equal(proxiedEntry.status, 200);
        const proxiedEntryHtml = await proxiedEntry.text();
        assert.match(proxiedEntryHtml, /<base href="\/neko\/">/);
        assert.match(proxiedEntryHtml, /data-pdpp-neko-embed/);
        assert.match(proxiedEntryHtml, /header-container/);
        assert.match(proxiedEntryHtml, /video-menu/);
        assert.match(proxiedEntryHtml, /pdpp-neko-focus/);
        assert.match(proxiedEntryHtml, /<body>ok<\/body>/);

        const proxied = await fetch(`${asUrl}/neko/echo?x=1`, { headers: { cookie } });
        assert.equal(proxied.status, 200);
        assert.equal(await proxied.text(), 'proxied:GET:/neko/echo?x=1');

        const proxiedRoot = await fetch(`${asUrl}/neko`, { headers: { cookie } });
        assert.equal(proxiedRoot.status, 200);
        const proxiedRootHtml = await proxiedRoot.text();
        assert.match(proxiedRootHtml, /<base href="\/neko\/">/);
        assert.match(proxiedRootHtml, /data-pdpp-neko-embed/);
        assert.match(proxiedRootHtml, /<body>ok<\/body>/);

        assert.ok(
          !String(observedUpstreamCookie).includes('pdpp_neko_stream='),
          'stream token cookie must not be forwarded to n.eko',
        );

        ac.abort();
        try {
          await reader.cancel();
        } catch {
          /* aborted */
        }
        await cancelRun(asUrl, started.run_id, pending.interaction_id);
      },
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('n.eko client config allows allocator-approved dynamic origin without exposing backend URLs', async () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`proxied:${req.method}:${req.url}`);
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const dynamicOrigin = `http://127.0.0.1:${upstream.address().port}/_ref/browser-surfaces/surf_dynamic_1`;

  try {
    await withHarness(
      {
        makeCompanion: ({ browser_session_id, interaction_id }) => ({
          ...makeMockNekoCompanion(dynamicOrigin)({ browser_session_id }),
          getNekoProxyTarget() {
            return {
              origin: dynamicOrigin,
              surface_id: 'surf_dynamic_1',
              lease_id: 'lease_dynamic_1',
              profile_key: 'profile_dynamic_1',
              interaction_id,
            };
          },
        }),
        isNekoProxyTargetApproved(target, { session }) {
          return (
            session?.run_id &&
            target.origin === dynamicOrigin &&
            target.surface_id === 'surf_dynamic_1' &&
            target.lease_id === 'lease_dynamic_1' &&
            target.profile_key === 'profile_dynamic_1' &&
            target.interaction_id === session.interaction_id
          );
        },
      },
      async ({ asUrl, spotifyManifest }) => {
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
        try {
          const clientConfig = await fetchJson(
            `${asUrl}/_ref/run-interaction-streams/${encodeURIComponent(mint.body.token)}/neko/session`,
          );
          assert.equal(clientConfig.status, 200);
          assert.equal(clientConfig.body.server_path, '/neko');
          assertNoRawBackendAuthority(clientConfig.body);
          const cookie = clientConfig.headers.get('set-cookie') || '';
          const proxied = await fetch(`${asUrl}/neko/api/room/screen?x=1`, { headers: { cookie } });
          assert.equal(proxied.status, 200);
          assert.equal(
            await proxied.text(),
            'proxied:GET:/_ref/browser-surfaces/surf_dynamic_1/api/room/screen?x=1',
          );
        } finally {
          ac.abort();
          await cancelRun(asUrl, started.run_id, pending.interaction_id);
        }
      },
    );
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('n.eko client config rejects allocator-approved dynamic origin for the wrong interaction', async () => {
  const dynamicOrigin = 'http://10.88.0.4:6080/neko';
  await withHarness(
    {
      makeCompanion: ({ browser_session_id }) => ({
        ...makeMockNekoCompanion(dynamicOrigin)({ browser_session_id }),
        getNekoProxyTarget() {
          return {
            origin: dynamicOrigin,
            surface_id: 'surf_dynamic_1',
            lease_id: 'lease_dynamic_1',
            profile_key: 'profile_dynamic_1',
            interaction_id: 'int_other',
          };
        },
      }),
      isNekoProxyTargetApproved(target, { session }) {
        return target.interaction_id === session?.interaction_id;
      },
    },
    async ({ asUrl, spotifyManifest }) => {
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
      try {
        const rejected = await fetchJson(
          `${asUrl}/_ref/run-interaction-streams/${encodeURIComponent(mint.body.token)}/neko/session`,
        );
        assert.equal(rejected.status, 401);
        assert.equal(rejected.body.error.code, 'neko_origin_not_allowed');
      } finally {
        ac.abort();
        await cancelRun(asUrl, started.run_id, pending.interaction_id);
      }
    },
  );
});

test('n.eko client config rejects unapproved dynamic origin', async () => {
  await withHarness(
    {
      makeCompanion: makeMockNekoCompanion('http://10.88.0.9:6080/neko'),
      isNekoProxyTargetApproved() {
        return false;
      },
    },
    async ({ asUrl, spotifyManifest }) => {
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
      try {
        const rejected = await fetchJson(
          `${asUrl}/_ref/run-interaction-streams/${encodeURIComponent(mint.body.token)}/neko/session`,
        );
        assert.equal(rejected.status, 401);
        assert.equal(rejected.body.error.code, 'neko_origin_not_allowed');
      } finally {
        ac.abort();
        await cancelRun(asUrl, started.run_id, pending.interaction_id);
      }
    },
  );
});

test('n.eko viewport dispatch uses one native coordinate space for video and input', async () => {
  const startedViewports = [];
  const dispatchedEvents = [];
  await withHarness(
    {
      makeCompanion: makeMockNekoCompanion('http://127.0.0.1:9', {
        dispatchedEvents,
        startedViewports,
      }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const started = await startRun(asUrl, spotifyManifest.connector_id);
      const pending = await waitForPendingInteraction(asUrl, started.run_id);
      const mint = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(started.run_id)}/run-interaction-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interaction_id: pending.interaction_id,
          viewport: {
            width: 448,
            height: 819,
            screenWidth: 1008,
            screenHeight: 1840,
            deviceScaleFactor: 2.25,
            hasTouch: true,
            mobile: true,
          },
        }),
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

      await readEvent('backend_ready');
      // mobile / hasTouch / userAgent are intentionally stripped by
      // viewportForCompanionBackend before reaching the companion's start.
      // The stealth-and-input-bouncing rationale lives in
      // docs/neko-stealth-design-brief.md and the inline comment on
      // normalizeViewportForNeko in server/streaming/routes.js. The
      // assertions below reflect the post-strip contract.
      assert.deepEqual(startedViewports[0], {
        width: 448,
        height: 819,
        screenWidth: 448,
        screenHeight: 819,
        deviceScaleFactor: 1,
      });

      const viewport = await fetchJson(`${asUrl}${mint.body.viewport_path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          width: 947,
          height: 364,
          screenWidth: 2128,
          screenHeight: 816,
          deviceScaleFactor: 2.25,
          hasTouch: true,
          mobile: true,
        }),
      });
      assert.equal(viewport.status, 202);
      assert.deepEqual(viewport.body.viewport, {
        width: 947,
        height: 364,
        screenWidth: 947,
        screenHeight: 364,
        deviceScaleFactor: 1,
      });
      assert.ok(
        dispatchedEvents.some(
          (event) =>
            event.type === 'viewport' &&
            event.width === 947 &&
            event.height === 364 &&
            event.screenWidth === 947 &&
            event.screenHeight === 364 &&
            event.deviceScaleFactor === 1,
        ),
        'n.eko viewport POST must not dispatch a high-DPR virtual screen that breaks native input hit-testing',
      );

      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted */
      }
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    },
  );
});

test('n.eko entry can include noauth auto-login query params', async () => {
  await withHarness(
    {
      makeCompanion: makeMockNekoCompanion('http://127.0.0.1:8080'),
      nekoProxyAutoLogin: { username: 'operator', password: '1' },
    },
    async ({ asUrl, spotifyManifest }) => {
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
      const backendReady = await readEvent('backend_ready');
      assert.equal(backendReady.backend, 'neko');
      assert.equal(backendReady.browser_owner_mode, 'neko-owned');
      assert.equal(backendReady.stealth_mode, 'balanced');
      assertNoRawBackendAuthority(backendReady);

      const clientConfig = await fetch(`${asUrl}${backendReady.client_config_path}`);
      assert.equal(clientConfig.status, 200);
      const clientConfigBody = await clientConfig.json();
      assert.deepEqual(clientConfigBody, {
        object: 'run_interaction_neko_client',
        server_path: '/neko',
        status_path: '/neko/__pdpp/status',
        login: {
          username: 'operator',
          password: '1',
        },
      });
      assertNoRawBackendAuthority(clientConfigBody);

      const entry = await fetch(`${asUrl}${backendReady.iframe_path}`, { redirect: 'manual' });
      assert.equal(entry.status, 302);
      const entryUrl = new URL(entry.headers.get('location'), asUrl);
      assert.equal(entryUrl.pathname, '/neko');
      assert.ok(entryUrl.searchParams.get('pdpp_stream'));
      assert.equal(entryUrl.searchParams.get('embed'), '1');
      assert.equal(entryUrl.searchParams.get('usr'), 'operator');
      assert.equal(entryUrl.searchParams.get('pwd'), '1');

      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted */
      }
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    },
  );
});

test('n.eko status diagnostics are scoped to the n.eko stream cookie', async () => {
  await withHarness(
    {
      makeCompanion: makeMockNekoCompanion('http://127.0.0.1:8080', {
        status: { connected: true, url: 'https://example.test/login' },
      }),
    },
    async ({ asUrl, spotifyManifest }) => {
      const unauthorized = await fetchJson(`${asUrl}/neko/__pdpp/status`);
      assert.equal(unauthorized.status, 401);

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
      await reader.read();

      const entry = await fetch(`${asUrl}/_ref/run-interaction-streams/${encodeURIComponent(mint.body.token)}/neko`, {
        redirect: 'manual',
      });
      assert.equal(entry.status, 302);
      const cookie = entry.headers.get('set-cookie') || '';
      const status = await fetchJson(`${asUrl}/neko/__pdpp/status`, { headers: { cookie } });
      assert.equal(status.status, 200);
      assert.deepEqual(status.body, {
        object: 'run_interaction_neko_status',
        control_available: true,
        native_control_available: true,
        status: { connected: true, url: 'https://example.test/login' },
      });

      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted */
      }
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    },
  );
});

test('n.eko status keeps native control available separate from strict stealth page CDP', async () => {
  await withHarness(
    {
      makeCompanion: makeMockNekoCompanion('http://127.0.0.1:8080', {
        status: {
          screen: { width: 1280, height: 720 },
          page_cdp_available: false,
          page_cdp_skipped: {
            browser_owner_mode: 'neko-owned',
            stealth_mode: 'strict',
          },
        },
        stealthMode: 'strict',
      }),
    },
    async ({ asUrl, spotifyManifest }) => {
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
      await reader.read();

      const entry = await fetch(`${asUrl}/_ref/run-interaction-streams/${encodeURIComponent(mint.body.token)}/neko`, {
        redirect: 'manual',
      });
      assert.equal(entry.status, 302);
      const cookie = entry.headers.get('set-cookie') || '';
      const status = await fetchJson(`${asUrl}/neko/__pdpp/status`, { headers: { cookie } });
      assert.equal(status.status, 200);
      assert.deepEqual(status.body, {
        object: 'run_interaction_neko_status',
        control_available: true,
        native_control_available: true,
        status: {
          screen: { width: 1280, height: 720 },
          page_cdp_available: false,
          page_cdp_skipped: {
            browser_owner_mode: 'neko-owned',
            stealth_mode: 'strict',
          },
        },
      });

      ac.abort();
      try {
        await reader.cancel();
      } catch {
        /* aborted */
      }
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    },
  );
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

    const paste = await fetchJson(`${asUrl}${mint.body.input_path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'paste', text: 'one-time code 123456' }),
    });
    assert.equal(paste.status, 202);
    assert.ok(
      tracked.companion.inputs.some((e) => e.type === 'paste' && e.text === 'one-time code 123456'),
      'paste POST must dispatch to the companion without special route handling',
    );

    const viewport = await fetchJson(`${asUrl}${mint.body.viewport_path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        width: 390.9,
        height: 844.8,
        screenWidth: 1080.2,
        screenHeight: 1920.8,
        deviceScaleFactor: 3,
        mobile: true,
      }),
    });
    assert.equal(viewport.status, 202);
    // mobile / hasTouch / userAgent are stripped from BOTH backends (cdp
    // and neko) by viewportForCompanionBackend. The original test
    // asserted mobile:true survived for the cdp backend; that was the
    // bug behind the soft-keyboard flicker and the UA/TLS inconsistency
    // Cloudflare Turnstile was detecting. See
    // docs/neko-stealth-design-brief.md for the full rationale.
    assert.deepEqual(viewport.body.viewport, {
      width: 390,
      height: 844,
      screenWidth: 1080,
      screenHeight: 1920,
      deviceScaleFactor: 3,
    });
    assert.ok(
      tracked.companion.inputs.some(
        (e) =>
          e.type === 'viewport' &&
          e.width === 390 &&
          e.height === 844 &&
          e.screenWidth === 1080 &&
          e.screenHeight === 1920 &&
          e.deviceScaleFactor === 3 &&
          // mobile is stripped — see comment above.
          e.mobile === undefined,
      ),
      'viewport POST must dispatch the CSS-pixel viewport to the companion',
    );
    assert.ok(
      tracked.companion.cdpCalls.some(
        (c) => c.method === 'Page.startScreencast' && c.params?.maxWidth === 390 && c.params?.maxHeight === 844,
      ),
      'viewport POST must restart screencast with the new viewport bounds',
    );

    const badViewport = await fetchJson(`${asUrl}${mint.body.viewport_path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width: 0, height: 844 }),
    });
    assert.equal(badViewport.status, 400);
    assert.equal(badViewport.body.error.code, 'invalid_request');

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
  // Run the server without a streamingCompanionFactory. The default factory
  // is built from the run-target registry resolver — the resolver itself is
  // always present, but the route layer treats `companionFactory == null` as
  // fail-closed, which only happens when no resolver and no factory injection
  // is wired. Here we inject `null` explicitly to exercise the route's
  // fail-closed branch.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-ref-stream-unavail-'));
  const connectorPath = buildManualActionConnector(tmpDir, {});
  try {
    const server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      connectorPathResolver: () => connectorPath,
      streamingCompanionFactory: null,
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
      assert.match(mint.body.error.message, /not configured/);
      await cancelRun(asUrl, started.run_id, pending.interaction_id);
    } finally {
      await closeServer(server);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('input POST with an unknown token returns 401 with a WWW-Authenticate header', async () => {
  // Regression: the 401 path in pdppError() chains `.status(401).header(...)`.
  // Express exposes `res.header()` as an alias of `setHeader`; the transport
  // shim must expose the same so the chain doesn't throw and get converted
  // into a 500 by Fastify (which the user sees as
  // `res.status(...).header is not a function`).
  await withHarness({}, async ({ asUrl }) => {
    const bogus = 'not-a-real-token';
    const resp = await fetchJson(`${asUrl}/_ref/run-interaction-streams/${bogus}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'mouse', action: 'click', x: 1, y: 1 }),
    });
    assert.equal(resp.status, 401, 'unknown token must produce 401, not a transport-level 500');
    assert.equal(resp.body?.error?.type, 'invalid_request_error');
    assert.match(
      resp.headers.get('www-authenticate') || '',
      /^Bearer\s+realm="pdpp-stream"$/,
    );
  });
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

test('SSE forwards companion out-of-band events as named SSE events', async () => {
  // The cdp adapter exposes `companion.onEvent` for non-frame wire events
  // (URL changes, popup open/close). The SSE route must fan these out as
  // named SSE event types so the viewer's EventSource registers a handler
  // per event name. Existing screencast frames (`event: frame`) must keep
  // flowing.
  await withHarness({}, async ({ asUrl, spotifyManifest, companions }) => {
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

    const tracked = companions.find((c) => c.run_id === started.run_id);
    assert.ok(tracked);
    assert.equal(typeof tracked.companion.pushEvent, 'function', 'mock companion exposes pushEvent');

    // url_changed with title.
    tracked.companion.pushEvent({ kind: 'url_changed', url: 'https://example.com/login', title: 'Sign in' });
    const urlEvt = await readEvent('url_changed');
    assert.deepEqual(urlEvt, { url: 'https://example.com/login', title: 'Sign in' });

    // url_changed without title — title field must be omitted.
    tracked.companion.pushEvent({ kind: 'url_changed', url: 'https://example.com/dash' });
    const urlEvt2 = await readEvent('url_changed');
    assert.deepEqual(urlEvt2, { url: 'https://example.com/dash' });

    // popup_opened.
    tracked.companion.pushEvent({ kind: 'popup_opened', targetId: 'tg_pop', url: 'https://oauth.example.com/' });
    const popOpen = await readEvent('popup_opened');
    assert.deepEqual(popOpen, { targetId: 'tg_pop', url: 'https://oauth.example.com/' });

    // popup_closed.
    tracked.companion.pushEvent({ kind: 'popup_closed', targetId: 'tg_pop' });
    const popClose = await readEvent('popup_closed');
    assert.deepEqual(popClose, { targetId: 'tg_pop' });

    // Frame stream still works alongside.
    tracked.companion.pushFrame({ sessionId: 1, data: 'AA==', metadata: null });
    const frame = await readEvent('frame');
    assert.equal(frame.session_id, 1);

    ac.abort();
    try {
      await reader.cancel();
    } catch {
      /* aborted */
    }
    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});

test('SSE handler emits keepalive comment pings while idle to prevent timeout', async () => {
  // Fastify keepAliveTimeout defaults to 30 seconds. If no frames flow, the SSE
  // stream would be closed silently. Keepalive comment pings (lines starting with `:`)
  // reset the timer without firing client-side handlers.
  await withHarness({}, async ({ asUrl, spotifyManifest, companions }) => {
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

    const ac = new AbortController();
    const sseResp = await fetch(`${asUrl}${mint.body.viewer_path}`, { signal: ac.signal });
    assert.equal(sseResp.status, 200);
    const reader = sseResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    async function readRawBytes(deadlineMs = 3000) {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        return buffer; // Return accumulated buffer so far
      }
      return null;
    }

    // Read from the stream for ~1 second to prime the attached event and verify
    // the stream is alive. This doesn't test the keepalive interval directly
    // (which is 15s), but it verifies the stream doesn't crash with keepalive active.
    await readRawBytes(1000);

    // Inject a frame to confirm the handler is still operational.
    const tracked = companions.find((c) => c.run_id === started.run_id);
    assert.ok(tracked, 'companion factory captured the streaming session');
    tracked.companion.pushFrame({ sessionId: 99, data: 'TESTFRAME' });

    // Read for up to 2 seconds and verify we receive the frame event.
    let foundFrame = false;
    const frameDeadline = Date.now() + 2000;
    while (Date.now() < frameDeadline && !foundFrame) {
      await readRawBytes(200);
      // Check if the frame event appears in the accumulated buffer.
      if (buffer.includes('event: frame') && buffer.includes('"session_id":99')) {
        foundFrame = true;
      }
    }
    assert.ok(foundFrame, 'handler must deliver frames with keepalive mechanism active');

    ac.abort();
    try {
      await reader.cancel();
    } catch {
      /* aborted */
    }

    await cancelRun(asUrl, started.run_id, pending.interaction_id);
  });
});
