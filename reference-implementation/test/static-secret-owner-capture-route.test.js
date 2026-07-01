import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { listSpineEventsPage } from '../lib/spine.ts';
import { startServer } from '../server/index.js';
import {
  CREDENTIAL_ENCRYPTION_KEY_ENV,
} from '../server/stores/credential-encryption.js';
import {
  createSqliteConnectorInstanceCredentialStore,
} from '../server/stores/connector-instance-credential-store.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const OWNER_PASSWORD = 'static-secret-capture-owner-password';
const OWNER_SUBJECT_ID = 'owner_local';
const NOW = '2026-06-01T12:00:00.000Z';
const TEST_KEY = 'static-secret-owner-capture-test-key';
const PERSONAL_SECRET = 'personal app password synthetic';
const WORK_SECRET = 'work app password synthetic';
const ROTATED_SECRET = 'rotated app password synthetic';

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

// This suite exercises credential-capture MECHANICS (sealing, rotation, kind
// mismatch, fail-closed) — not the synchronous validation moment. Inject a
// permissive deterministic prober so a probe-bearing connector (gmail) does not
// trigger a real network probe; every synthetic secret validates. The dedicated
// probe-rejection behavior is proven in static-secret-credential-probe-route.test.js.
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
    staticSecretAutoResume: false,
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
    body: new URLSearchParams({
      password: OWNER_PASSWORD,
      return_to: '/',
      _csrf: csrfField || '',
    }).toString(),
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
  const manifest = loadManifest(name);
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201, `register ${name} failed: ${resp.status}`);
}

async function seedInstance({ connectorInstanceId, connectorId, ownerSubjectId = OWNER_SUBJECT_ID, displayName }) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId,
    ownerSubjectId,
    connectorId,
    displayName: displayName ?? connectorInstanceId,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey: connectorInstanceId,
    sourceBinding: { account_hint: connectorInstanceId },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function captureCredential(asUrl, sessionCookie, connectionId, secret, credentialKind = 'app_password') {
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/static-secret-credential`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify({ credential_kind: credentialKind, secret }),
  });
}

function findCaptureAuditEvent(resp) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'capture response should carry a trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === 'owner.connection.static_secret_credential.capture');
  assert.ok(event, 'expected static-secret capture audit event');
  assert.equal(event.request_id, resp.headers.get('Request-Id'));
  return event;
}

test('owner-session route seals a static secret and returns only non-secret metadata', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      await seedInstance({ connectorInstanceId: 'cin_gmail_personal', connectorId: 'gmail' });
      const cookie = await login(asUrl);

      const { status, body, resp, text } = await captureCredential(
        asUrl,
        cookie,
        'cin_gmail_personal',
        PERSONAL_SECRET,
      );
      assert.equal(status, 201);
      assert.equal(body.object, 'static_secret_credential_capture');
      assert.equal(body.connection_id, 'cin_gmail_personal');
      assert.equal(body.connector_id, 'gmail');
      assert.equal(body.credential.credential_kind, 'app_password');
      assert.equal(body.credential.status, 'active');
      assert.equal(body.credential.present, true);
      assert.ok(body.credential.fingerprint, 'response may expose a non-secret fingerprint');
      assert.equal(body.next_step.kind, 'run_connection');
      assert.ok(!text.includes(PERSONAL_SECRET), 'response must not contain the submitted secret');

      const audit = findCaptureAuditEvent(resp);
      assert.equal(audit.actor_type, 'owner_session');
      assert.equal(audit.status, 'succeeded');
      assert.equal(audit.data?.connection_id, 'cin_gmail_personal');
      assert.equal(audit.data?.credential_kind, 'app_password');
      assert.ok(!JSON.stringify(audit).includes(PERSONAL_SECRET), 'audit must not contain the secret');

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const recovered = await store.recoverSecret({
        connectorInstanceId: 'cin_gmail_personal',
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(recovered.secret, PERSONAL_SECRET);
    });
  });
});

test('capture is per-connection and rotation preserves the connection id', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      await seedInstance({ connectorInstanceId: 'cin_gmail_personal', connectorId: 'gmail' });
      await seedInstance({ connectorInstanceId: 'cin_gmail_work', connectorId: 'gmail' });
      const cookie = await login(asUrl);

      const first = await captureCredential(asUrl, cookie, 'cin_gmail_personal', PERSONAL_SECRET);
      const work = await captureCredential(asUrl, cookie, 'cin_gmail_work', WORK_SECRET);
      const rotated = await captureCredential(asUrl, cookie, 'cin_gmail_personal', ROTATED_SECRET);
      assert.equal(first.status, 201);
      assert.equal(work.status, 201);
      assert.equal(rotated.status, 200);
      assert.equal(rotated.body.connection_id, 'cin_gmail_personal');
      assert.ok(rotated.body.credential.rotated_at, 'rotation should stamp rotated_at');
      assert.notEqual(
        rotated.body.credential.fingerprint,
        first.body.credential.fingerprint,
        'rotation changes only the captured credential metadata',
      );

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const personal = await store.recoverSecret({
        connectorInstanceId: 'cin_gmail_personal',
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      const workRecovered = await store.recoverSecret({
        connectorInstanceId: 'cin_gmail_work',
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(personal.secret, ROTATED_SECRET);
      assert.equal(workRecovered.secret, WORK_SECRET);
      assert.notEqual(personal.secret, workRecovered.secret);
    });
  });
});

test('owner-agent bearer without an owner session cannot use the capture route', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      await seedInstance({ connectorInstanceId: 'cin_gmail_personal', connectorId: 'gmail' });

      const { status, body, text } = await fetchJson(
        `${asUrl}/_ref/connections/cin_gmail_personal/static-secret-credential`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer owner-agent-token-that-is-not-a-cookie',
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ credential_kind: 'app_password', secret: PERSONAL_SECRET }),
        },
      );
      assert.equal(status, 401);
      assert.equal(body?.error?.code, 'owner_session_required');
      assert.ok(!text.includes(PERSONAL_SECRET), 'auth failure must not echo the secret');

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(await store.getMetadata('cin_gmail_personal'), null);
    });
  });
});

test('capture fails closed when the operator encryption key is missing', async () => {
  await withCredentialKey(null, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      await seedInstance({ connectorInstanceId: 'cin_gmail_personal', connectorId: 'gmail' });
      const cookie = await login(asUrl);

      const { status, body, text, resp } = await captureCredential(
        asUrl,
        cookie,
        'cin_gmail_personal',
        PERSONAL_SECRET,
      );
      assert.equal(status, 503);
      assert.equal(body?.error?.code, 'credential_encryption_key_missing');
      assert.ok(!text.includes(PERSONAL_SECRET), 'error response must not contain the submitted secret');
      const audit = findCaptureAuditEvent(resp);
      assert.equal(audit.status, 'failed');
      assert.equal(audit.data?.error?.code, 'credential_encryption_key_missing');
      assert.ok(!JSON.stringify(audit).includes(PERSONAL_SECRET), 'failure audit must not contain the secret');

      const row = await createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      }).getMetadata('cin_gmail_personal');
      assert.equal(row, null, 'no credential row should be written without an encryption key');
    });
  });
});

test('capture rejects foreign and non-static-secret connections without storing credentials', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      await registerConnector(asUrl, 'anthropic');
      await seedInstance({
        connectorInstanceId: 'cin_gmail_foreign',
        connectorId: 'gmail',
        ownerSubjectId: 'owner_other',
      });
      await seedInstance({ connectorInstanceId: 'cin_anthropic_personal', connectorId: 'anthropic' });
      const cookie = await login(asUrl);

      const foreign = await captureCredential(asUrl, cookie, 'cin_gmail_foreign', PERSONAL_SECRET);
      assert.equal(foreign.status, 403);
      assert.equal(foreign.body?.error?.code, 'connector_instance_owner_mismatch');
      assert.ok(!foreign.text.includes(PERSONAL_SECRET));

      const nonStatic = await captureCredential(asUrl, cookie, 'cin_anthropic_personal', PERSONAL_SECRET);
      assert.equal(nonStatic.status, 409);
      assert.equal(nonStatic.body?.error?.code, 'static_secret_credential_unsupported');
      assert.ok(!nonStatic.text.includes(PERSONAL_SECRET));
      const nonStaticAudit = findCaptureAuditEvent(nonStatic.resp);
      assert.equal(nonStaticAudit.status, 'failed');
      assert.equal(nonStaticAudit.data?.error?.code, 'static_secret_credential_unsupported');
      assert.ok(!JSON.stringify(nonStaticAudit).includes(PERSONAL_SECRET));

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(await store.getMetadata('cin_gmail_foreign'), null);
      assert.equal(await store.getMetadata('cin_anthropic_personal'), null);
    });
  });
});

test('capture rejects wrong credential kind with a non-secret audit event', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      await seedInstance({ connectorInstanceId: 'cin_gmail_personal', connectorId: 'gmail' });
      const cookie = await login(asUrl);

      const { status, body, text, resp } = await captureCredential(
        asUrl,
        cookie,
        'cin_gmail_personal',
        PERSONAL_SECRET,
        'personal_access_token',
      );
      assert.equal(status, 400);
      assert.equal(body?.error?.code, 'credential_kind_mismatch');
      assert.ok(!text.includes(PERSONAL_SECRET), 'credential-kind failure must not echo the secret');

      const audit = findCaptureAuditEvent(resp);
      assert.equal(audit.status, 'failed');
      assert.equal(audit.data?.credential_kind, 'personal_access_token');
      assert.equal(audit.data?.error?.code, 'credential_kind_mismatch');
      assert.ok(!JSON.stringify(audit).includes(PERSONAL_SECRET), 'audit must not contain the secret');

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(await store.getMetadata('cin_gmail_personal'), null);
    });
  });
});
