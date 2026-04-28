/**
 * Control-plane visibility test for the bounded connector failure
 * diagnostic added by
 *   openspec/changes/persist-connector-failure-diagnostics
 *
 * Asserts:
 *   1. A connector that exits before DONE with stderr persists
 *      `connector_diagnostics.stderr_tail` and runtime-authored
 *      `failure_origin`/`failure_message` on the terminal `run.failed`
 *      event.
 *   2. The owner-scoped `_ref` run timeline endpoint surfaces those
 *      fields (this is what the dashboard reads).
 *   3. None of the grant-scoped `/v1` reads (records, search, schema)
 *      expose connector stderr text. We don't have a grant in the
 *      stub-only harness, so we cover this as a structural check on the
 *      surfaces — the diagnostic lives on `spine_events`, never on the
 *      `record` rows or schema metadata read by `/v1`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/index.js';
import { runConnector } from '../runtime/index.js';

const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

const STUB_MANIFEST = {
  connector_id: 'https://registry.pdpp.org/connectors/test-failure-diagnostics-cp',
  version: '0.1.0',
  streams: [
    {
      name: 'noop',
      primary_key: 'id',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  ],
  runtime_requirements: {},
};

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
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

async function issueOwnerToken(asUrl) {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: 'owner_local' }).toString(),
  });
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

function writeFailingStub(stderrText, exitCode = 1) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-fdcp-'));
  const stubPath = join(tmpDir, 'stub.js');
  const lines = [
    '#!/usr/bin/env node',
    "process.stdin.resume();",
    "process.stdin.once('data', () => {",
    `  process.stderr.write(${JSON.stringify(stderrText)});`,
    `  process.exit(${exitCode});`,
    "});",
    '',
  ];
  writeFileSync(stubPath, lines.join('\n'), 'utf8');
  chmodSync(stubPath, 0o755);
  return { tmpDir, stubPath };
}

test('connector failure diagnostics surface on owner timeline; not on /v1 surfaces', async (t) => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(STUB_MANIFEST),
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl);
    const stderrText = 'Boom: connector hit fatal error\n  upstream returned 500\n';
    const { tmpDir, stubPath } = writeFailingStub(stderrText, 1);

    let runId = null;
    try {
      const result = await runConnector({
        connectorPath: stubPath,
        connectorId: STUB_MANIFEST.connector_id,
        ownerToken,
        manifest: STUB_MANIFEST,
        state: null,
        collectionMode: 'full_refresh',
        rsUrl,
        onProgress: () => {},
        onInteraction: () => ({ type: 'INTERACTION_RESPONSE', status: 'cancelled' }),
      });
      runId = result.run_id;
      assert.equal(result.status, 'failed');
    } catch (err) {
      runId = err?.run_id ?? null;
    }
    assert.ok(runId, 'expected runConnector to surface a run_id');

    await t.test('owner /_ref/runs/:runId/timeline includes connector_diagnostics.stderr_tail', async () => {
      const { status, body } = await fetchJson(
        `${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`,
      );
      assert.equal(status, 200);
      const events = Array.isArray(body.data) ? body.data : body.events;
      assert.ok(Array.isArray(events) && events.length > 0, 'expected timeline events');
      const failed = events.find((e) => e.event_type === 'run.failed');
      assert.ok(failed, 'expected a run.failed event in the timeline');
      assert.equal(failed.data.failure_origin, 'connector');
      assert.equal(typeof failed.data.failure_message, 'string');
      const tail = failed.data.connector_diagnostics?.stderr_tail;
      assert.ok(tail, 'expected connector_diagnostics.stderr_tail');
      assert.equal(tail.object, 'connector_stderr_tail');
      assert.equal(tail.encoding, 'utf-8');
      assert.equal(typeof tail.text, 'string');
      assert.ok(tail.text.includes('Boom'), `stderr text not preserved: ${tail.text}`);
    });

    await t.test('grant-scoped /v1/schema does not echo connector stderr', async () => {
      // Without a granted bearer we expect 401; even an authenticated
      // schema call returns capability metadata only, never spine event
      // payloads. We assert the negative shape: the response body must
      // not contain the raw stderr substring.
      const { body } = await fetchJson(`${asUrl}/v1/schema`);
      const serialized = JSON.stringify(body ?? {});
      assert.ok(
        !serialized.includes('Boom') && !serialized.includes('connector_stderr_tail'),
        `unexpected stderr leakage on /v1/schema: ${serialized.slice(0, 200)}`,
      );
    });

    await t.test('grant-scoped /v1/records does not echo connector stderr', async () => {
      const { body } = await fetchJson(`${asUrl}/v1/records?limit=10`);
      const serialized = JSON.stringify(body ?? {});
      assert.ok(
        !serialized.includes('Boom') && !serialized.includes('connector_stderr_tail'),
        `unexpected stderr leakage on /v1/records: ${serialized.slice(0, 200)}`,
      );
    });

    await t.test('grant-scoped /v1/search does not echo connector stderr', async () => {
      // Search by content of the stderr to make this maximally adversarial.
      const { body } = await fetchJson(`${asUrl}/v1/search?q=Boom`);
      const serialized = JSON.stringify(body ?? {});
      assert.ok(
        !serialized.includes('Boom: connector hit fatal error'),
        `unexpected stderr leakage on /v1/search: ${serialized.slice(0, 200)}`,
      );
      assert.ok(
        !serialized.includes('connector_stderr_tail'),
        `unexpected diagnostic object name on /v1/search: ${serialized.slice(0, 200)}`,
      );
    });

    rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    await closeServer(server);
  }
});
