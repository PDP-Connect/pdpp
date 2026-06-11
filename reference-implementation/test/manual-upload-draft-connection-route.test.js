import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listSpineEventsPage } from '../lib/spine.ts';
import { getDb } from '../server/db.js';
import { startServer } from '../server/index.js';

const OWNER_PASSWORD = 'manual-upload-owner-password';
const OWNER_SUBJECT_ID = 'owner_local';

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
  const tmp = mkdtempSync(join(tmpdir(), 'pdpp-manual-upload-'));
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: join(tmp, 'pdpp.sqlite'),
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    autoEnrollEligibleSchedules: false,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl, tmp });
  } finally {
    await closeServer(server);
    rmSync(tmp, { force: true, recursive: true });
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

async function getSetup(asUrl, cookie, connectorId) {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-setup`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
}

const VALID_TIMELINE_BODY = JSON.stringify({
  locations: [
    {
      timestampMs: '1717595122000',
      latitudeE7: 377_749_000,
      longitudeE7: -1_224_194_000,
    },
  ],
});

async function createDraft(asUrl, cookie, connectorId, fileName = 'Timeline.json', body = VALID_TIMELINE_BODY) {
  const url = new URL(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-draft-connection`);
  url.searchParams.set('file_name', fileName);
  return fetchJson(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      Cookie: cookie,
    },
    body,
  });
}

async function listConnections(asUrl, cookie) {
  return fetchJson(`${asUrl}/_ref/connections`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
}

function findManualUploadAudit(resp, outcome) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'manual-upload response should carry a trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find(
    (entry) => entry.event_type === 'owner.connection.manual_upload_draft.create' && entry.status === outcome,
  );
  assert.ok(event, `expected manual_upload_draft.create audit (${outcome})`);
  return event;
}

test('manual/upload setup descriptor is manifest-authored', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);
    const { status, body, text } = await getSetup(asUrl, cookie, 'google-maps');
    assert.equal(status, 200, text);
    assert.equal(body.object, 'manual_upload_setup');
    assert.equal(body.connector_id, 'google-maps');
    assert.equal(body.display_name, 'Google Maps Timeline Import');
    assert.equal(body.label, 'Google Maps Timeline export file');
    assert.ok(body.acquisition_methods.some((method) => method.platform === 'android' && method.posture === 'primary'));
    assert.ok(body.acquisition_methods.some((method) => method.platform === 'ios' && method.posture === 'primary'));
    assert.ok(body.accepted_file_names.includes('Timeline.json'));
    assert.ok(body.help_url.startsWith('https://support.google.com/maps/'));
    assert.ok(body.large_file_fallback.includes('import-folder'));
    assert.ok(body.validation_expectations.includes('Detected Timeline format'));
    assert.equal(Object.hasOwn(body, 'import_dir'), false, 'setup response must not leak server paths');
    assert.equal(Object.hasOwn(body, 'import_dir_env_var'), false, 'setup response must not expose env-var plumbing');
  });
});

test('owner upload creates an invisible draft with connection-scoped import binding', async () => {
  await withServer(async ({ asUrl, tmp }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);
    const created = await createDraft(asUrl, cookie, 'google-maps');
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.object, 'manual_upload_draft_connection');
    assert.equal(created.body.connector_id, 'google-maps');
    assert.equal(created.body.status, 'draft');
    assert.equal(created.body.uploaded_file_name, 'Timeline.json');
    assert.equal(created.body.validation.status, 'valid');
    assert.equal(created.body.validation.detected_format, 'legacy_records');
    assert.equal(created.body.validation.estimated_points, 1);
    assert.equal(created.body.validation.date_range.start, '2024-06-05T13:45:22.000Z');
    assert.equal(created.body.next_step.kind, 'run_connection');
    assert.equal(Object.hasOwn(created.body, 'import_dir'), false, 'create response must not leak server paths');
    assert.ok(!created.text.includes(tmp), 'create response must not include the data directory path');

    const connectionId = created.body.connection_id;
    assert.ok(connectionId?.startsWith('cin_'), 'draft has a connection_id');
    const audit = findManualUploadAudit(created.resp, 'succeeded');
    assert.equal(audit.actor_type, 'owner_session');
    assert.equal(audit.data?.connection_id, connectionId);
    assert.equal(audit.data?.connector_id, 'google-maps');

    const list = await listConnections(asUrl, cookie);
    assert.equal(list.status, 200);
    assert.equal(
      list.body.data.some((connection) => connection.connection_id === connectionId),
      false,
      'manual upload draft must stay hidden until first ingest',
    );

    const row = getDb()
      .prepare(
        `SELECT source_kind, source_binding_key, source_binding_json
           FROM connector_instances
          WHERE connector_instance_id = ?`,
      )
      .get(connectionId);
    assert.equal(row.source_kind, 'manual');
    assert.match(row.source_binding_key, /^manual_upload_draft_/);
    const binding = JSON.parse(row.source_binding_json);
    assert.equal(binding.kind, 'manual_upload_draft');
    assert.equal(binding.import_dir_env_var, 'GOOGLE_MAPS_TIMELINE_DIR');
    assert.equal(binding.acquisition_method, 'owner_upload');
    assert.equal(binding.import_validation.status, 'valid');
    assert.equal(binding.import_validation.detected_format, 'legacy_records');
    assert.equal(binding.import_validation.estimated_points, 1);
    assert.equal(binding.uploaded_file_name, 'Timeline.json');
    assert.ok(binding.import_dir.startsWith(join(tmp, 'imports', 'google-maps')), binding.import_dir);
    assert.equal(readFileSync(join(binding.import_dir, 'Timeline.json'), 'utf8'), VALID_TIMELINE_BODY);
  });
});

test('Timeline manual upload records coverage-safe validation without fixed refresh cooldown', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);
    const created = await createDraft(asUrl, cookie, 'google-maps');
    assert.equal(created.status, 201, created.text);

    const bindingJson = getDb()
      .prepare(
        `SELECT source_binding_json
           FROM connector_instances
          WHERE connector_instance_id = ?`,
      )
      .get(created.body.connection_id).source_binding_json;
    const binding = JSON.parse(bindingJson);
    assert.equal(binding.import_validation.status, 'valid');
    assert.equal(binding.import_validation.date_range.end, '2024-06-05T13:45:22.000Z');
    assert.equal(Object.hasOwn(binding, 'cooldown_until'), false);
    assert.equal(Object.hasOwn(binding, 'next_allowed_import_at'), false);
    assert.equal(Object.hasOwn(binding, 'takeout_cadence'), false);
  });
});

test('unsafe or unsupported file names are rejected before a draft row is created', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);

    const traversal = await createDraft(asUrl, cookie, 'google-maps', '../Timeline.json');
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body?.error?.code, 'import_file_name_rejected');
    findManualUploadAudit(traversal.resp, 'failed');

    const wrong = await createDraft(asUrl, cookie, 'google-maps', 'passwords.csv');
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body?.error?.code, 'import_file_name_rejected');

    const rowCount = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
    assert.equal(rowCount, 0, 'invalid upload inputs must not create a draft');
  });
});

test('Timeline validation rejects unsupported and empty files before a draft row is created', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);

    const unsupported = await createDraft(asUrl, cookie, 'google-maps', 'Timeline.json', '{"archive_jobs":[]}');
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.body?.error?.code, 'import_file_unsupported');
    assert.match(unsupported.body?.error?.message ?? '', /Timeline JSON export/);

    const empty = await createDraft(asUrl, cookie, 'google-maps', 'Timeline.json', '{"timelineObjects":[]}');
    assert.equal(empty.status, 400);
    assert.equal(empty.body?.error?.code, 'import_file_empty');
    assert.match(empty.body?.error?.message ?? '', /does not contain importable/);

    const rowCount = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
    assert.equal(rowCount, 0, 'validation failures must not create a draft');
  });
});

test('manual/upload setup refuses non-manual connectors and bearer-only callers', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'gmail');
    const cookie = await login(asUrl);

    const unsupported = await getSetup(asUrl, cookie, 'gmail');
    assert.equal(unsupported.status, 409);
    assert.equal(unsupported.body?.error?.code, 'manual_upload_unsupported');

    const bearerUrl = new URL(`${asUrl}/_ref/connectors/gmail/manual-upload-draft-connection`);
    bearerUrl.searchParams.set('file_name', 'Timeline.json');
    const bearerOnly = await fetchJson(bearerUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer owner-agent-token-that-is-not-a-cookie',
        'Content-Type': 'application/octet-stream',
      },
      body: '{}',
    });
    assert.equal(bearerOnly.status, 401);
    assert.equal(bearerOnly.body?.error?.code, 'owner_session_required');
  });
});
