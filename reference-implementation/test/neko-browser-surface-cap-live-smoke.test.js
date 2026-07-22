// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startServer } from '../server/index.js';

const MANAGED_A = 'https://registry.pdpp.org/connectors/neko-cap-smoke-a';
const MANAGED_B = 'https://registry.pdpp.org/connectors/neko-cap-smoke-b';
const PROFILE_KEY = 'neko-cap-smoke-profile';
const LIVE_CAP_ENABLED = process.env.PDPP_TEST_LIVE_NEKO_CAP === '1';
const DEFAULT_NEKO_BASE_URL = 'http://neko:8080/neko';
const DEFAULT_NEKO_CDP_HTTP_URL = 'http://neko:9223';

function manifest(connectorId) {
  return {
    connector_id: connectorId,
    name: connectorId.endsWith('-a') ? 'n.eko Cap Smoke A' : 'n.eko Cap Smoke B',
    version: '1.0.0',
    streams: [
      {
        name: 'items',
        description: 'Smoke-test records',
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
    capabilities: {
      browser_surface: {
        profile_key: PROFILE_KEY,
      },
    },
  };
}

async function closeServer(server) {
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
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: resp.status, body };
}

async function registerConnector(asUrl, connectorManifest) {
  const { status, body } = await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(connectorManifest),
  });
  assert.equal(status, 201, `register ${connectorManifest.connector_id}: ${JSON.stringify(body)}`);
}

async function startRun(asUrl, connectorId) {
  const { status, body } = await fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/run`, {
    method: 'POST',
  });
  assert.equal(status, 202, `start ${connectorId}: ${JSON.stringify(body)}`);
  return body;
}

async function postInteraction(asUrl, runId, interactionId) {
  const { status, body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/interaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      interaction_id: interactionId,
      status: 'success',
      data: { ok: true },
    }),
  });
  assert.equal(status, 202, `complete interaction ${interactionId}: ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

async function assertNekoReachable({ baseUrl, cdpHttpUrl }) {
  const uiUrl = ensureTrailingSlash(baseUrl);
  const cdpVersionUrl = new URL('/json/version', ensureTrailingSlash(cdpHttpUrl)).toString();
  const uiResponse = await fetch(uiUrl, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(
    uiResponse.status >= 200 && uiResponse.status < 500,
    `expected live n.eko UI at ${uiUrl}, got HTTP ${uiResponse.status}`,
  );

  const cdpResponse = await fetch(cdpVersionUrl, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(cdpResponse.status, 200, `expected live n.eko CDP at ${cdpVersionUrl}`);
}

function readSpawns(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

function buildBlockingConnector(tmpDir, spawnLogPath) {
  const connectorPath = join(tmpDir, 'blocking-managed-connector.mjs');
  writeFileSync(
    connectorPath,
    `
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const spawnLogPath = ${JSON.stringify(spawnLogPath)};
function appendSpawn(record) {
  let records = [];
  try { records = JSON.parse(readFileSync(spawnLogPath, 'utf8')); } catch {}
  records.push(record);
  writeFileSync(spawnLogPath, JSON.stringify(records, null, 2));
}

const rl = createInterface({ input: process.stdin, terminal: false });
let started = false;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'START' && !started) {
    started = true;
    appendSpawn({
      connector_id: process.env.PDPP_CONNECTOR_ID,
      required: process.env.PDPP_BROWSER_SURFACE_REQUIRED,
      lease_id: process.env.PDPP_BROWSER_SURFACE_LEASE_ID,
      profile_key: process.env.PDPP_BROWSER_SURFACE_PROFILE_KEY,
    });
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'release',
      kind: 'manual_action',
      message: 'Hold the managed n.eko lease until the smoke releases it.',
      timeout_seconds: 60
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
process.on('SIGTERM', () => process.exit(0));
rl.on('close', () => process.exit(0));
`,
    'utf8',
  );
  return connectorPath;
}

function withEnv(patch, fn) {
  const previous = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

test('Docker n.eko cap smoke: cap 1 queues second managed run before child spawn, then promotes it', {
  skip: LIVE_CAP_ENABLED ? false : 'set PDPP_TEST_LIVE_NEKO_CAP=1 inside the Docker reference service',
}, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-neko-cap-smoke-'));
  const spawnLogPath = join(tmpDir, 'spawns.json');
  const connectorPath = buildBlockingConnector(tmpDir, spawnLogPath);
  const nekoBaseUrl = process.env.PDPP_TEST_LIVE_NEKO_ORIGIN || process.env.PDPP_NEKO_BASE_URL || DEFAULT_NEKO_BASE_URL;
  const nekoCdpHttpUrl = process.env.PDPP_TEST_LIVE_NEKO_CDP_HTTP_URL
    || process.env.PDPP_NEKO_CDP_HTTP_URL
    || DEFAULT_NEKO_CDP_HTTP_URL;

  await withEnv(
    {
      PDPP_NEKO_MANAGED_CONNECTORS: `${MANAGED_A},${MANAGED_B}`,
      PDPP_NEKO_SURFACE_CAP: '1',
      PDPP_NEKO_STATIC_PROFILE_KEY: PROFILE_KEY,
      PDPP_NEKO_CDP_HTTP_URL: nekoCdpHttpUrl,
      PDPP_NEKO_BASE_URL: nekoBaseUrl,
      PDPP_NEKO_LEASE_WAIT_TIMEOUT_MS: '60000',
    },
    async () => {
      await assertNekoReachable({
        baseUrl: nekoBaseUrl,
        cdpHttpUrl: nekoCdpHttpUrl,
      });
      const server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath: ':memory:',
        storageBackend: 'sqlite',
        ownerAuthPassword: '',
        connectorPathResolver: () => connectorPath,
      });
      const asUrl = `http://localhost:${server.asPort}`;
      try {
        await registerConnector(asUrl, manifest(MANAGED_A));
        await registerConnector(asUrl, manifest(MANAGED_B));

        const first = await startRun(asUrl, MANAGED_A);
        assert.equal(first.status, 'started');
        await waitFor(() => readSpawns(spawnLogPath).length === 1, 'first managed run should spawn exactly one child');

        const second = await startRun(asUrl, MANAGED_B);
        assert.equal(second.status, 'waiting_for_browser_surface');
        assert.equal(second.browser_surface.browser_surface_wait_reason, 'capacity_full');
        assert.equal(readSpawns(spawnLogPath).length, 1, 'queued run must not spawn a connector child');

        const queuedTimeline = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(second.run_id)}/timeline`);
        assert.equal(queuedTimeline.status, 200);
        assert.equal(
          queuedTimeline.body.data.some((event) => event.event_type === 'run.started'),
          false,
          'queued run must not emit run.started before promotion',
        );
        assert.ok(
          queuedTimeline.body.data.some((event) => event.event_type === 'run.browser_surface_queued'),
          'queued run should expose browser-surface queueing',
        );

        await postInteraction(asUrl, first.run_id, 'release');
        await waitFor(() => readSpawns(spawnLogPath).length === 2, 'queued run should spawn after first lease release');
        const spawns = readSpawns(spawnLogPath);
        assert.deepEqual(
          spawns.map((spawn) => spawn.connector_id),
          [MANAGED_A, MANAGED_B],
        );
        assert.equal(spawns[0].required, 'neko');
        assert.equal(spawns[1].required, 'neko');
        assert.notEqual(spawns[0].lease_id, spawns[1].lease_id);

        await postInteraction(asUrl, second.run_id, 'release');
      } finally {
        await closeServer(server);
      }
    },
  ).finally(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
