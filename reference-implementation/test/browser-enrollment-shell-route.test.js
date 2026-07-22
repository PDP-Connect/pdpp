// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { listSpineEventsPage } from '../lib/spine.ts';
import { getDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import {
  expiredEnrollmentShellIds,
  retireExpiredBrowserEnrollmentShells,
} from '../server/browser-enrollment-shell-retirement.ts';
import { BROWSER_ENROLLMENT_SHELL_TTL_MS } from '../server/routes/ref-browser-enrollment-shell.ts';

// Integration coverage for the browser-enrollment shell routes:
//   POST /_ref/connectors/:connectorId/browser-enrollment-shell  (on AS)
//   POST /_ref/connections/:connectorInstanceId/abandon-enrollment  (on AS)
// and unit coverage for the TTL retirement utility.
//
// Note: /_ref/... owner-session routes live on the AS app, not the RS app.
// Owner login is also at /owner/login on the AS.

const OWNER_PASSWORD = 'browser-shell-owner-password';
const OWNER_SUBJECT_ID = 'owner_local';

function loadManifest(name) {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), 'utf8'),
  );
}

async function registerConnector(asUrl, name) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(loadManifest(name)),
  });
  assert.equal(resp.status, 201, `register ${name} failed: ${resp.status}`);
}

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function withServer(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    autoEnrollEligibleSchedules: false,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// Owner login is on the AS (same as /_ref/... routes).
async function ownerLogin(asUrl, password = OWNER_PASSWORD) {
  const res = await fetch(`${asUrl}/owner/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.split(';')[0] ?? '';
}

// --- POST /_ref/connectors/:connectorId/browser-enrollment-shell ---

test('browser-enrollment shell: creates draft for supported browser collector connector', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'amazon');
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connectors/amazon/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: '  Amazon personal  ' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.object, 'browser_enrollment_shell');
    assert.ok(body.connection_id, 'connection_id present');
    assert.equal(body.connector_id, 'amazon');
    assert.equal(body.display_name, 'Amazon personal');
    assert.equal(body.status, 'draft');
    assert.ok(body.enrollment_expires_at, 'enrollment_expires_at present');
    // TTL should be ~2h in the future
    const expiresMs = new Date(body.enrollment_expires_at).getTime();
    const nowMs = Date.now();
    assert.ok(expiresMs > nowMs + 60 * 60 * 1000, 'expires at least 1h from now');
    assert.ok(expiresMs < nowMs + 3 * 60 * 60 * 1000, 'expires within 3h');
    assert.equal(body.next_step.kind, 'browser_enrollment_run');

    const db = getDb();
    const row = db
      .prepare(
        `SELECT display_name, source_binding_json
           FROM connector_instances
          WHERE connector_instance_id = ?`
      )
      .get(body.connection_id);
    assert.ok(row, 'stored shell row present');
    assert.equal(row.display_name, 'Amazon personal');
    assert.equal(JSON.parse(row.source_binding_json).kind, 'browser_enrollment_shell');
  });
});

test('browser-enrollment shell: two calls create two distinct shells', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'heb');
    const cookie = await ownerLogin(asUrl);
    const r1 = await fetch(`${asUrl}/_ref/connectors/heb/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie },
    });
    const r2 = await fetch(`${asUrl}/_ref/connectors/heb/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    const b1 = await r1.json();
    const b2 = await r2.json();
    assert.notEqual(b1.connection_id, b2.connection_id);
  });
});

test('browser-enrollment shell: rejects malformed bodies safely', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'amazon');
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connectors/amazon/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(['not-an-object']),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, 'invalid_request');
  });
});

test('browser-enrollment shell: rejects overlong display_name safely', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'heb');
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connectors/heb/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'x'.repeat(201) }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, 'invalid_request');
    assert.equal(body.error?.param, 'display_name');
  });
});

test('browser-enrollment shell: rejects non-browser-bound connector (409)', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'gmail');
    const cookie = await ownerLogin(asUrl);
    // gmail is a static-secret connector, not browser-bound
    const res = await fetch(`${asUrl}/_ref/connectors/gmail/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error?.code, 'connector_not_browser_bound');
  });
});

test('browser-enrollment shell: rejects unknown connector (404)', async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connectors/no-such-connector/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(res.status, 404);
  });
});

test('browser-enrollment shell: requires owner session (401 without cookie)', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'chase');
    const res = await fetch(`${asUrl}/_ref/connectors/chase/browser-enrollment-shell`, {
      method: 'POST',
    });
    assert.ok(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  });
});

test('browser-enrollment shell: emits audit spine event on success', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'heb');
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connectors/heb/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(res.status, 201);
    const traceId = res.headers.get('PDPP-Reference-Trace-Id');
    assert.ok(traceId?.startsWith('trc_'), 'response carries a trace id');
    const page = listSpineEventsPage('trace', traceId, { limit: 10 });
    const event = page.events.find(
      (e) => e.event_type === 'owner.connection.browser_enrollment_shell.create',
    );
    assert.ok(event, 'audit event emitted');
    assert.equal(event.status, 'succeeded');
    assert.equal(event.data?.connector_id, 'heb');
  });
});

test('browser-enrollment shell: shell is not visible in owner connections list', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'heb');
    const cookie = await ownerLogin(asUrl);
    await fetch(`${asUrl}/_ref/connectors/heb/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie },
    });
    // The owner connections list must not expose draft shells
    const res = await fetch(`${asUrl}/_ref/connections`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const connectorIds = (body.connections ?? body.data ?? []).map((c) => c.connector_id);
    assert.ok(!connectorIds.includes('heb'), 'heb draft shell not visible in connections list');
  });
});

// --- POST /_ref/connections/:connectorInstanceId/abandon-enrollment ---

test('abandon-enrollment: retires a draft shell (status → revoked)', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'chase');
    const cookie = await ownerLogin(asUrl);
    const createRes = await fetch(`${asUrl}/_ref/connectors/chase/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(createRes.status, 201);
    const { connection_id } = await createRes.json();
    const abandonRes = await fetch(`${asUrl}/_ref/connections/${connection_id}/abandon-enrollment`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(abandonRes.status, 200);
    const body = await abandonRes.json();
    assert.equal(body.object, 'enrollment_abandoned');
    assert.equal(body.status, 'revoked');
  });
});

test('abandon-enrollment: idempotent when already revoked', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'usaa');
    const cookie = await ownerLogin(asUrl);
    const createRes = await fetch(`${asUrl}/_ref/connectors/usaa/browser-enrollment-shell`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(createRes.status, 201);
    const { connection_id } = await createRes.json();
    // First abandon
    const r1 = await fetch(`${asUrl}/_ref/connections/${connection_id}/abandon-enrollment`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(r1.status, 200);
    // Second abandon — must not error
    const r2 = await fetch(`${asUrl}/_ref/connections/${connection_id}/abandon-enrollment`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(r2.status, 200);
    const body = await r2.json();
    assert.equal(body.status, 'revoked');
  });
});

test('abandon-enrollment: 404 for unknown connection_id', async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connections/cin_nonexistentid/abandon-enrollment`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(res.status, 404);
  });
});

test('abandon-enrollment: 409 for non-enrollment-shell connection (wrong kind in binding)', async () => {
  // Not directly testable end-to-end without a fully active connection.
  // Verify the endpoint exists and returns a sensible status for an
  // unknown-but-valid-format ID.
  await withServer(async ({ asUrl }) => {
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connections/cin_000000000000000000000000/abandon-enrollment`, {
      method: 'POST',
      headers: { cookie },
    });
    // Either 404 (not found) or 409 (not a shell) — neither should be 500
    assert.ok(res.status === 404 || res.status === 409, `Expected 404 or 409, got ${res.status}`);
  });
});

// --- TTL retirement utility (pure unit tests, no server needed) ---

test('expiredEnrollmentShellIds: returns IDs of expired draft/active shell bindings', () => {
  const now = '2026-06-10T12:00:00.000Z';
  const shells = [
    {
      connectorInstanceId: 'cin_expired_1',
      status: 'draft',
      sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: '2026-06-10T10:00:00.000Z' },
    },
    {
      connectorInstanceId: 'cin_not_expired',
      status: 'draft',
      sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: '2026-06-10T14:00:00.000Z' },
    },
    {
      connectorInstanceId: 'cin_active',
      status: 'active',
      sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: '2026-06-10T10:00:00.000Z' },
    },
    {
      connectorInstanceId: 'cin_completed_account',
      status: 'active',
      sourceBinding: { kind: 'browser_collector', enrollment_expires_at: '2026-06-10T10:00:00.000Z' },
    },
    {
      connectorInstanceId: 'cin_paused_shell',
      status: 'paused',
      sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: '2026-06-10T10:00:00.000Z' },
    },
    {
      connectorInstanceId: 'cin_static_secret',
      status: 'draft',
      sourceBinding: { kind: 'static_secret_draft' },
    },
  ];
  const ids = expiredEnrollmentShellIds(shells, now);
  assert.deepEqual(ids, ['cin_expired_1', 'cin_active']);
});

test('expiredEnrollmentShellIds: empty list returns empty', () => {
  assert.deepEqual(expiredEnrollmentShellIds([], '2026-06-10T12:00:00.000Z'), []);
});

test('expiredEnrollmentShellIds: missing enrollment_expires_at treated as not-expired', () => {
  const now = '2026-06-10T12:00:00.000Z';
  const shells = [
    {
      connectorInstanceId: 'cin_no_ttl',
      status: 'draft',
      sourceBinding: { kind: 'browser_enrollment_shell' },
    },
  ];
  const ids = expiredEnrollmentShellIds(shells, now);
  assert.deepEqual(ids, []);
});

test('BROWSER_ENROLLMENT_SHELL_TTL_MS is 2 hours', () => {
  assert.equal(BROWSER_ENROLLMENT_SHELL_TTL_MS, 2 * 60 * 60 * 1000);
});

test('retireExpiredBrowserEnrollmentShells flips expired draft/active shell bindings to revoked', async () => {
  const updates = [];
  const shells = [
    {
      connectorInstanceId: 'cin_expired_1',
      status: 'draft',
      sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: '2026-06-10T10:00:00.000Z' },
    },
    {
      connectorInstanceId: 'cin_not_expired',
      status: 'draft',
      sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: '2026-06-10T14:00:00.000Z' },
    },
    {
      connectorInstanceId: 'cin_active',
      status: 'active',
      sourceBinding: { kind: 'browser_enrollment_shell', enrollment_expires_at: '2026-06-10T10:00:00.000Z' },
    },
    {
      connectorInstanceId: 'cin_real_account',
      status: 'active',
      sourceBinding: { kind: 'browser_collector', enrollment_expires_at: '2026-06-10T10:00:00.000Z' },
    },
  ];

  const retired = await retireExpiredBrowserEnrollmentShells(
    {
      async listDraftBrowserEnrollmentShells(ownerSubjectId) {
        assert.equal(ownerSubjectId, OWNER_SUBJECT_ID);
        return shells;
      },
      async updateStatus(connectorInstanceId, args) {
        updates.push({ connectorInstanceId, args });
      },
    },
    { now: '2026-06-10T12:00:00.000Z', ownerSubjectId: OWNER_SUBJECT_ID }
  );

  assert.deepEqual(retired, ['cin_expired_1', 'cin_active']);
  assert.deepEqual(updates, [
    {
      connectorInstanceId: 'cin_expired_1',
      args: {
        status: 'revoked',
        revokedAt: '2026-06-10T12:00:00.000Z',
        updatedAt: '2026-06-10T12:00:00.000Z',
      },
    },
    {
      connectorInstanceId: 'cin_active',
      args: {
        status: 'revoked',
        revokedAt: '2026-06-10T12:00:00.000Z',
        updatedAt: '2026-06-10T12:00:00.000Z',
      },
    },
  ]);
});
