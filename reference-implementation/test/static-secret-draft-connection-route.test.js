// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { listSpineEventsPage } from '../lib/spine.ts';
import { getDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from '../server/stores/credential-encryption.js';
import { createSqliteConnectorInstanceCredentialStore } from '../server/stores/connector-instance-credential-store.js';

// Integration coverage for the owner-session static-secret DRAFT-connection
// route — the first-connection lifecycle that creates an invisible `draft`
// instead of a phantom active row. See
// add-static-secret-owner-session-connect-path design Decision 4.

const OWNER_PASSWORD = 'static-secret-draft-owner-password';
const OWNER_SUBJECT_ID = 'owner_local';
const TEST_KEY = 'static-secret-draft-test-key';
const SECRET = 'draft app password synthetic';

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function withCredentialKey(value, fn) {
  const old = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  if (value === null) {
    delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  } else {
    process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = value;
  }
  try {
    return await fn();
  } finally {
    if (old === undefined) {
      delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
    } else {
      process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = old;
    }
  }
}

// Permissive deterministic prober so capturing a probe-bearing connector (gmail)
// in these draft/capture mechanics tests does not trigger a real network probe.
// Synchronous validation rejection is proven separately in
// static-secret-credential-probe-route.test.js.
function permissiveProber() {
  return async ({ context }) => ({
    ok: true,
    identity: context?.setupFields?.account_email ?? 'synthetic@example.com',
    detail: null,
  });
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
    staticSecretCredentialProber: permissiveProber(),
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// Owner-auth-disabled harness for the first-ingest-activation tests, which need
// an owner BEARER token (device flow) in addition to the owner-session draft
// surface. With an empty owner password the default owner session is active
// (so `/_ref/...` cookie routes need no login) and `/device/approve` issues a
// bearer token without a CSRF-gated owner session — mirroring
// owner-connection-delete.test.js. The auth-rejection cases above keep the
// password-protected harness.
async function withOpenServer(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    autoEnrollEligibleSchedules: false,
    staticSecretCredentialProber: permissiveProber(),
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

function getRawSetCookieList(resp) {
  if (typeof resp.headers.getSetCookie === 'function') {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get('set-cookie');
  return single ? [single] : [];
}

function findSetCookiePair(setCookies, name) {
  for (const header of setCookies) {
    const firstPair = header.split(';')[0];
    if (firstPair.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html) {
  const match = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/);
  return match ? match[1] : null;
}

async function login(asUrl) {
  const getLogin = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: 'text/html' },
    redirect: 'manual',
  });
  const csrfCookie = findSetCookiePair(getRawSetCookieList(getLogin), 'pdpp_owner_csrf');
  const csrfField = extractCsrfFieldValue(await getLogin.text());
  const resp = await fetch(`${asUrl}/owner/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Cookie: csrfCookie || '',
    },
    body: new URLSearchParams({ password: OWNER_PASSWORD, return_to: '/', _csrf: csrfField || '' }).toString(),
    redirect: 'manual',
  });
  const sessionCookie = findSetCookiePair(getRawSetCookieList(resp), 'pdpp_owner_session');
  assert.ok(sessionCookie, `expected owner session cookie, got status ${resp.status}`);
  return sessionCookie;
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
  return { body, resp, status: resp.status, text };
}

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

async function issueOwnerToken(asUrl, subjectId = OWNER_SUBJECT_ID) {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
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

async function ingest(rsUrl, ownerToken, connectorId, connectionId, stream, records) {
  const lines = records
    .map((record) => JSON.stringify({ key: record.id, data: record, emitted_at: record.emitted_at }))
    .join('\n');
  const url =
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}` +
    `?connector_id=${encodeURIComponent(connectorId)}` +
    `&connector_instance_id=${encodeURIComponent(connectionId)}`;
  return fetchJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/x-ndjson' },
    body: lines,
  });
}

async function createDraft(asUrl, cookie, connectorId, setupFields = { account_email: 'owner@example.com' }) {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/draft-connection`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ setup_fields: setupFields }),
  });
}

async function getSetup(asUrl, cookie, connectorId) {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/static-secret-setup`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
}

async function listConnections(asUrl, cookie) {
  return fetchJson(`${asUrl}/_ref/connections`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
}

// The owner-facing dashboard/Sources/Syncs summary feed — deliberately
// DIFFERENT from `/_ref/connections` (see fix-pending-connection-discovery
// design): this is the one surface that includes `draft` rows, so a freshly
// created connection is discoverable before its first ingest.
async function listConnectors(asUrl, cookie) {
  return fetchJson(`${asUrl}/_ref/connectors`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
}

function findDraftAudit(resp, outcome) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'draft response should carry a trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find(
    (entry) => entry.event_type === 'owner.connection.static_secret_draft.create' && entry.status === outcome,
  );
  assert.ok(event, `expected static-secret draft.create audit (${outcome})`);
  return event;
}

test('owner creates an invisible draft, captures onto it, and it stays hidden until ingest', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);

      // Create a draft.
      const created = await createDraft(asUrl, cookie, 'gmail');
      assert.equal(created.status, 201);
      assert.equal(created.body.object, 'static_secret_draft_connection');
      assert.equal(created.body.connector_id, 'gmail');
      assert.equal(created.body.status, 'draft');
      assert.equal(created.body.credential_kind, 'app_password');
      assert.equal(created.body.display_name, 'Gmail - owner@example.com');
      assert.equal(created.body.next_step.kind, 'capture_static_secret_credential');
      const connectionId = created.body.connection_id;
      assert.ok(connectionId, 'draft has a connection_id');

      // Audit is non-secret and owner-session.
      const audit = findDraftAudit(created.resp, 'succeeded');
      assert.equal(audit.actor_type, 'owner_session');
      assert.equal(audit.data?.connection_id, connectionId);
      assert.equal(audit.data?.connector_id, 'gmail');

      // Invisible on the connection list.
      const list = await listConnections(asUrl, cookie);
      assert.equal(list.status, 200);
      assert.ok(
        !list.body.data.some((c) => c.connection_id === connectionId || c.connector_instance_id === connectionId),
        'draft must not appear on /_ref/connections',
      );

      // Owner-session capture seals a credential onto the draft.
      const captured = await fetchJson(
        `${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/static-secret-credential`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
          body: JSON.stringify({ credential_kind: 'app_password', secret: SECRET }),
        },
      );
      assert.equal(captured.status, 201, `capture onto draft should succeed: ${captured.text}`);
      assert.equal(captured.body.connection_id, connectionId);
      assert.ok(!captured.text.includes(SECRET), 'capture response must not echo the secret');

      // Still invisible after capture (no ingest yet).
      const afterCapture = await listConnections(asUrl, cookie);
      assert.ok(
        !afterCapture.body.data.some((c) => c.connection_id === connectionId),
        'draft stays invisible until first ingest',
      );

      // The secret is recoverable only with the operator key — never on a read.
      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const recovered = await store.recoverSecret({
        connectorInstanceId: connectionId,
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(recovered.secret, SECRET);
    });
  });
});

test('static-secret setup descriptor is manifest-authored and readiness-gated', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);
      const { status, body, text } = await getSetup(asUrl, cookie, 'gmail');
      assert.equal(status, 200, text);
      assert.equal(body.object, 'static_secret_setup');
      assert.equal(body.connector_id, 'gmail');
      assert.equal(body.credential_kind, 'app_password');
      assert.equal(body.deployment_readiness.state, 'ready');
      // Gmail has a synchronous credential probe, so the owner setup descriptor
      // advertises synchronous validation; the Console form reads this to render
      // the validate-then-activate flow generically.
      assert.equal(body.validation, 'synchronous');
      assert.ok(
        body.credential_capture.fields.some(
          (field) => field.name === 'account_email' && field.type === 'email' && field.secret === false,
        ),
        'Gmail manifest must declare the account email field',
      );
      assert.ok(
        body.credential_capture.fields.some(
          (field) =>
            field.name === 'secret' &&
            field.secret === true &&
            field.help_url === 'https://myaccount.google.com/apppasswords',
        ),
        'Gmail manifest must declare the app-password help URL',
      );
    });
  });
});

test('draft create blocks before row creation when credential key provider is missing', async () => {
  await withCredentialKey(null, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);
      const { status, body, text, resp } = await createDraft(asUrl, cookie, 'gmail');
      assert.equal(status, 503, text);
      assert.equal(body?.error?.code, 'credential_encryption_key_missing');
      const audit = findDraftAudit(resp, 'failed');
      assert.equal(audit.data?.error?.code, 'credential_encryption_key_missing');

      const list = await listConnections(asUrl, cookie);
      assert.equal(list.status, 200);
      assert.equal(list.body.data.length, 0, 'missing key provider must not create a draft');
      const rowCount = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
      assert.equal(rowCount, 0, 'missing key provider must not write a connector_instances row');
    });
  });
});

test('draft create validates manifest-declared non-secret setup fields', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);

      const missing = await createDraft(asUrl, cookie, 'gmail', {});
      assert.equal(missing.status, 400);
      assert.equal(missing.body?.error?.code, 'missing_setup_field');

      const unknown = await createDraft(asUrl, cookie, 'gmail', {
        account_email: 'owner@example.com',
        unexpected: 'value',
      });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.body?.error?.code, 'unknown_setup_field');

      const list = await listConnections(asUrl, cookie);
      assert.equal(list.body.data.length, 0, 'invalid setup fields must not create a draft');
    });
  });
});

test('two drafts for one connector are two distinct connection_ids', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);
      const a = await createDraft(asUrl, cookie, 'gmail');
      const b = await createDraft(asUrl, cookie, 'gmail');
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
      assert.notEqual(a.body.connection_id, b.body.connection_id);
      // Both invisible.
      const list = await listConnections(asUrl, cookie);
      assert.equal(list.body.data.length, 0, 'both drafts are hidden from the listing');
    });
  });
});

test('draft create is rejected for a non-static-secret connector', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'whatsapp');
      const cookie = await login(asUrl);
      const { status, body, resp } = await createDraft(asUrl, cookie, 'whatsapp');
      assert.equal(status, 409);
      assert.equal(body?.error?.code, 'static_secret_credential_unsupported');
      const audit = findDraftAudit(resp, 'failed');
      assert.equal(audit.data?.error?.code, 'static_secret_credential_unsupported');
    });
  });
});

test('owner-agent bearer without an owner session cannot create a draft', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const { status, body } = await fetchJson(`${asUrl}/_ref/connectors/gmail/draft-connection`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-agent-token-that-is-not-a-cookie',
          Accept: 'application/json',
        },
      });
      assert.equal(status, 401);
      assert.equal(body?.error?.code, 'owner_session_required');
    });
  });
});

test('first ingest with records flips the draft to active and makes it visible', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withOpenServer(async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = '';
      const created = await createDraft(asUrl, cookie, 'gmail');
      assert.equal(created.status, 201, `draft create: ${created.text}`);
      const connectionId = created.body.connection_id;

      const ownerToken = await issueOwnerToken(asUrl);
      const ingested = await ingest(rsUrl, ownerToken, 'gmail', connectionId, 'messages', [
        { id: 'm1', subject: 'hello', emitted_at: '2026-06-02T12:00:00.000Z' },
      ]);
      assert.equal(ingested.status, 200, `ingest into draft should succeed: ${ingested.text}`);
      assert.equal(ingested.body.records_accepted, 1);

      // The draft is now active and visible.
      const list = await listConnections(asUrl, cookie);
      const visible = list.body.data.find(
        (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId,
      );
      assert.ok(visible, 'connection is visible after first ingest');
      assert.equal(visible.status, 'active');
    });
  });
});

test('zero-record ingest leaves the draft invisible (no phantom active connection)', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withOpenServer(async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = '';
      const created = await createDraft(asUrl, cookie, 'gmail');
      assert.equal(created.status, 201, `draft create: ${created.text}`);
      const connectionId = created.body.connection_id;

      const ownerToken = await issueOwnerToken(asUrl);
      // Empty body → zero records accepted.
      const ingested = await ingest(rsUrl, ownerToken, 'gmail', connectionId, 'messages', []);
      assert.equal(ingested.status, 200);
      assert.equal(ingested.body.records_accepted, 0);

      // Still invisible; no active row.
      const list = await listConnections(asUrl, cookie);
      assert.ok(
        !list.body.data.some((c) => c.connection_id === connectionId || c.connector_instance_id === connectionId),
        'a zero-record ingest must not activate or reveal the draft',
      );
    });
  });
});

// ─── fix-pending-connection-discovery regression coverage ──────────────────
//
// Root cause: a freshly created draft connection was invisible on every
// owner-navigable list (Sources, Syncs, source-detail-by-id) until its first
// successful ingest, discoverable only via a push notification's run-scoped
// deep link. The fix keeps `/_ref/connections` (raw connection listing)
// hiding drafts exactly as before, but makes `/_ref/connectors` (the
// dashboard/Sources/Syncs summary feed) include them as an explicit
// `setup_in_progress` owner state — never healthy, never silently absent.
//
// These tests pin the pre-first-record (draft, just created) and the
// waiting-owner-action (draft, credential captured, no ingest yet) states on
// the real summary feed. The active-run / failed-run / success-promotion
// states for an ACTIVATED connection are covered by the owner-state.test.js
// exhaustive cross-product (collecting / system_degraded / needs_owner /
// healthy resolvers) and by this file's existing
// 'first ingest ... flips the draft to active and makes it visible' test —
// this file adds the piece that was missing: the draft itself must be
// discoverable, distinctly labeled, and never counted healthy.

test('pre-first-record: a freshly created draft is discoverable on /_ref/connectors as setup_in_progress, still hidden from /_ref/connections', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, 'gmail');
      assert.equal(created.status, 201, `draft create: ${created.text}`);
      const connectionId = created.body.connection_id;

      // Still hidden from the raw connection list (unchanged contract).
      const connections = await listConnections(asUrl, cookie);
      assert.ok(
        !connections.body.data.some((c) => c.connection_id === connectionId),
        'draft must still be hidden from /_ref/connections',
      );

      // Discoverable on the dashboard/Sources/Syncs summary feed.
      const connectors = await listConnectors(asUrl, cookie);
      assert.equal(connectors.status, 200);
      const row = connectors.body.data.find(
        (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId,
      );
      assert.ok(row, 'draft connection must be discoverable on /_ref/connectors before its first record');
      assert.equal(row.status, 'draft');
      assert.equal(row.owner_state?.resolver, 'setup_in_progress');
      assert.equal(row.owner_state?.owner_of_state, 'owner');
      // Never healthy, never a fabricated defect tone — the owner state is
      // the honest signal; the legacy verdict pill is not asserted here
      // (it may still read grey/unmeasured), only that owner_state is correct.
      assert.notEqual(row.owner_state?.resolver, 'healthy');
    });
  });
});

test('setup-status resolves a draft by its exact connection_id, not by connector-key fallback', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, 'gmail');
      assert.equal(created.status, 201, `draft create: ${created.text}`);
      const connectionId = created.body.connection_id;
      assert.notEqual(
        connectionId,
        'gmail',
        'the durable connection_id must differ from the bare connector key for this regression to be meaningful',
      );

      // The exact durable connection_id (what every in-app affordance links
      // with — Sources row, next-action, passport, Syncs card) resolves.
      const byExactId = await fetchJson(
        `${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/setup-status`,
        { headers: { Accept: 'application/json', Cookie: cookie } },
      );
      assert.equal(byExactId.status, 200, `exact connection_id must resolve: ${byExactId.text}`);
      assert.equal(byExactId.body.connection_id, connectionId);

      // The bare connector-key (a route selector some other route resolves via
      // connector-key fallback, e.g. the `/sources/:connector` records route)
      // is NOT a valid setup-status selector: this route only accepts an
      // explicit connector_instance_id, so it must 404 rather than silently
      // resolving against the wrong resource or a different draft. Any
      // in-app redirect into this route must therefore always carry the
      // resolved durable connection_id, never a raw connector-key route
      // segment (fix-pending-connection-discovery revision, Finding #1).
      const byConnectorKey = await fetchJson(`${asUrl}/_ref/connections/gmail/setup-status`, {
        headers: { Accept: 'application/json', Cookie: cookie },
      });
      assert.equal(byConnectorKey.status, 404, `bare connector-key must not resolve setup-status: ${byConnectorKey.text}`);
      assert.equal(byConnectorKey.body?.error?.code, 'connector_instance_not_found');
    });
  });
});

test('waiting owner action: credential captured but no ingest yet stays setup_in_progress on /_ref/connectors, not healthy or degraded', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, 'gmail');
      const connectionId = created.body.connection_id;

      const captured = await fetchJson(
        `${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/static-secret-credential`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
          body: JSON.stringify({ credential_kind: 'app_password', secret: SECRET }),
        },
      );
      assert.equal(captured.status, 201, `capture onto draft should succeed: ${captured.text}`);

      const connectors = await listConnectors(asUrl, cookie);
      const row = connectors.body.data.find(
        (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId,
      );
      assert.ok(row, 'draft with a captured credential but no run yet must still be discoverable');
      assert.equal(row.status, 'draft');
      assert.equal(row.owner_state?.resolver, 'setup_in_progress');
      assert.notEqual(row.owner_state?.resolver, 'healthy');
      assert.notEqual(row.owner_state?.resolver, 'system_degraded');
    });
  });
});

test('success promotion: first successful ingest flips owner_state from setup_in_progress to a real health resolver, and the connection stays visible', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withOpenServer(async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = '';
      const created = await createDraft(asUrl, cookie, 'gmail');
      const connectionId = created.body.connection_id;

      // Before ingest: setup_in_progress on the summary feed.
      const before = await listConnectors(asUrl, cookie);
      const beforeRow = before.body.data.find((c) => c.connection_id === connectionId);
      assert.equal(beforeRow?.owner_state?.resolver, 'setup_in_progress');

      const ownerToken = await issueOwnerToken(asUrl);
      const ingested = await ingest(rsUrl, ownerToken, 'gmail', connectionId, 'messages', [
        { id: 'm1', subject: 'hello', emitted_at: '2026-06-02T12:00:00.000Z' },
      ]);
      assert.equal(ingested.status, 200, `ingest into draft should succeed: ${ingested.text}`);
      assert.equal(ingested.body.records_accepted, 1, `expected 1 record accepted: ${ingested.text}`);

      // No manual cache surgery: `maybeActivateDraftAfterIngest`
      // (rs-mutation.ts) invalidates the dashboard/Sources/Syncs summary
      // cache itself as part of the real first-ingest activation path (same
      // invalidation every other connection-mutating route performs), so the
      // very next `/_ref/connectors` read below observes `active` immediately
      // — this proves that production invalidation, not a test workaround.

      // After ingest: active, visible on BOTH feeds, and owner_state has moved
      // off setup_in_progress (the connection now has real health evidence).
      const connections = await listConnections(asUrl, cookie);
      const connectionsRow = connections.body.data.find(
        (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId,
      );
      assert.ok(
        connectionsRow,
        `activated connection must be visible on /_ref/connections: ${JSON.stringify(connections.body)}`,
      );
      assert.equal(connectionsRow.status, 'active');

      const after = await listConnectors(asUrl, cookie);
      const afterRow = after.body.data.find((c) => c.connection_id === connectionId);
      assert.ok(afterRow, 'activated connection must still be visible on /_ref/connectors');
      assert.equal(afterRow.status, 'active');
      assert.notEqual(afterRow.owner_state?.resolver, 'setup_in_progress');
    });
  });
});
