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

async function createDraft(
  asUrl,
  cookie,
  connectorId,
  fileName = 'Timeline.json',
  body = VALID_TIMELINE_BODY,
  options = {},
) {
  const url = new URL(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-draft-connection`);
  url.searchParams.set('file_name', fileName);
  if (options.connectionId) {
    url.searchParams.set('connection_id', options.connectionId);
  }
  if (options.displayName) {
    url.searchParams.set('display_name', options.displayName);
  }
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

async function validateUpload(
  asUrl,
  cookie,
  connectorId,
  fileName = 'Timeline.json',
  body = VALID_TIMELINE_BODY,
  options = {},
) {
  const url = new URL(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-validation-preview`);
  url.searchParams.set('file_name', fileName);
  if (options.connectionId) {
    url.searchParams.set('connection_id', options.connectionId);
  }
  if (options.displayName) {
    url.searchParams.set('display_name', options.displayName);
  }
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

async function stageUpload(
  asUrl,
  cookie,
  connectorId,
  fileName = 'Timeline.json',
  body = VALID_TIMELINE_BODY,
  options = {},
) {
  const url = new URL(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-staged-artifact`);
  url.searchParams.set('file_name', fileName);
  if (options.connectionId) {
    url.searchParams.set('connection_id', options.connectionId);
  }
  if (options.displayName) {
    url.searchParams.set('display_name', options.displayName);
  }
  return fetchJson(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/vnd.pdpp.manual-upload',
      Cookie: cookie,
    },
    body,
  });
}

async function getArtifact(asUrl, cookie, artifactId) {
  return fetchJson(`${asUrl}/_ref/manual-upload/artifacts/${encodeURIComponent(artifactId)}`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
}

async function waitForArtifact(asUrl, cookie, artifactId, expectedStatuses) {
  const statuses = new Set(expectedStatuses);
  let latest = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    latest = await getArtifact(asUrl, cookie, artifactId);
    if (latest.status === 200 && statuses.has(latest.body.status)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return latest;
}

function makeStoredZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}

async function listConnections(asUrl, cookie) {
  return fetchJson(`${asUrl}/_ref/connections`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
}

function findManualUploadAudit(resp, outcome, operation = 'create') {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'manual-upload response should carry a trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find(
    (entry) => entry.event_type === `owner.connection.manual_upload_draft.${operation}` && entry.status === outcome,
  );
  assert.ok(event, `expected manual_upload_draft.${operation} audit (${outcome})`);
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
    assert.equal(body.max_file_bytes, 104857600);
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
    assert.equal(binding.acquisition_method, 'owner_artifact');
    assert.equal(binding.import_validation.status, 'valid');
    assert.equal(binding.import_validation.detected_format, 'legacy_records');
    assert.equal(binding.import_validation.estimated_points, 1);
    assert.equal(binding.uploaded_file_name, 'Timeline.json');
    assert.ok(binding.import_dir.startsWith(join(tmp, 'imports', 'google-maps')), binding.import_dir);
    assert.equal(readFileSync(join(binding.import_dir, 'Timeline.json'), 'utf8'), VALID_TIMELINE_BODY);

    const batch = getDb()
      .prepare(
        `SELECT acquisition_method, artifact_sha256, connector_instance_id, parsed_count, accepted_count, status
           FROM acquisition_batches
          WHERE connector_instance_id = ?`,
      )
      .get(connectionId);
    assert.equal(batch.acquisition_method, 'owner_artifact');
    assert.equal(batch.connector_instance_id, connectionId);
    assert.match(batch.artifact_sha256, /^[0-9a-f]{64}$/);
    assert.equal(batch.parsed_count, 1);
    assert.equal(batch.accepted_count, 0);
    assert.equal(batch.status, 'validated');
  });
});

test('owner upload preview validates without creating a draft or writing acquisition state', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);

    const preview = await validateUpload(asUrl, cookie, 'google-maps');
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.body.object, 'manual_upload_validation_preview');
    assert.equal(preview.body.connector_id, 'google-maps');
    assert.equal(preview.body.uploaded_file_name, 'Timeline.json');
    assert.equal(preview.body.validation.status, 'valid');
    assert.equal(preview.body.validation.estimated_points, 1);
    assert.equal(preview.body.duplicate, null);
    assert.equal(preview.body.next_step.kind, 'confirm_import');

    const connectionRows = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
    assert.equal(connectionRows, 0, 'validation preview must not create a draft connection');
    const batchRows = getDb().prepare('SELECT COUNT(*) AS count FROM acquisition_batches').get().count;
    assert.equal(batchRows, 0, 'validation preview must not create an acquisition batch');
    findManualUploadAudit(preview.resp, 'succeeded', 'validate');
  });
});

test('staged owner upload returns before validation and exposes durable artifact status', async () => {
  await withServer(async ({ asUrl, tmp }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);

    const staged = await stageUpload(asUrl, cookie, 'google-maps');
    assert.equal(staged.status, 202, staged.text);
    assert.equal(staged.body.object, 'manual_upload_artifact');
    assert.match(staged.body.artifact_id, /^mua_/);
    assert.equal(staged.body.connection_id, null);
    assert.equal(staged.body.status, 'uploaded');
    assert.equal(staged.body.next_step.kind, 'poll_artifact');
    assert.equal(Object.hasOwn(staged.body, 'import_dir'), false, 'staged response must not leak server paths');
    assert.ok(!staged.text.includes(tmp), 'staged response must not include server paths');

    const done = await waitForArtifact(asUrl, cookie, staged.body.artifact_id, ['staged']);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.status, 'staged');
    assert.match(done.body.connection_id, /^cin_/);
    assert.equal(done.body.validation.status, 'valid');
    assert.equal(done.body.next_step.kind, 'run_connection');

    const row = getDb()
      .prepare(
        `SELECT status, artifact_sha256, acquisition_batch_id
           FROM manual_upload_artifacts
          WHERE artifact_id = ?`,
      )
      .get(staged.body.artifact_id);
    assert.equal(row.status, 'staged');
    assert.match(row.artifact_sha256, /^[0-9a-f]{64}$/);
    assert.match(row.acquisition_batch_id, /^ab_/);

    const batch = getDb()
      .prepare(
        `SELECT status, connector_instance_id, uploaded_file_name
           FROM acquisition_batches
          WHERE batch_id = ?`,
      )
      .get(row.acquisition_batch_id);
    assert.equal(batch.status, 'validated');
    assert.equal(batch.connector_instance_id, done.body.connection_id);
    assert.equal(batch.uploaded_file_name, 'Timeline.json');
  });
});

test('staged uploads attach multiple files to one explicit manual-upload source', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'whatsapp');
    const cookie = await login(asUrl);

    const first = await stageUpload(
      asUrl,
      cookie,
      'whatsapp',
      'WhatsApp Chat - Ghazal.txt',
      '[6/5/24, 9:15:22 AM] Alice: Hello',
      { displayName: 'the owner WhatsApp' },
    );
    assert.equal(first.status, 202, first.text);
    const firstDone = await waitForArtifact(asUrl, cookie, first.body.artifact_id, ['staged']);
    assert.equal(firstDone.body.status, 'staged');
    assert.match(firstDone.body.connection_id, /^cin_/);

    const second = await stageUpload(
      asUrl,
      cookie,
      'whatsapp',
      'WhatsApp Chat - Family.txt',
      '[6/6/24, 10:15:22 AM] Alice: Second chat',
      { connectionId: firstDone.body.connection_id },
    );
    assert.equal(second.status, 202, second.text);
    assert.equal(second.body.connection_id, firstDone.body.connection_id);
    const secondDone = await waitForArtifact(asUrl, cookie, second.body.artifact_id, ['staged']);
    assert.equal(secondDone.body.status, 'staged');
    assert.equal(secondDone.body.connection_id, firstDone.body.connection_id);

    const rowCount = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
    assert.equal(rowCount, 1, 'explicit same-source staged uploads must not create another connection');
    const artifactCount = getDb()
      .prepare('SELECT COUNT(*) AS count FROM manual_upload_artifacts WHERE connector_instance_id = ?')
      .get(firstDone.body.connection_id).count;
    assert.equal(artifactCount, 2);
  });
});

test('staged invalid upload fails without creating a source', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);

    const staged = await stageUpload(asUrl, cookie, 'google-maps', 'Timeline.json', '{"not":"timeline"}');
    assert.equal(staged.status, 202, staged.text);
    assert.equal(staged.body.connection_id, null);

    const done = await waitForArtifact(asUrl, cookie, staged.body.artifact_id, ['failed']);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.status, 'failed');
    assert.equal(done.body.connection_id, null);
    assert.equal(done.body.error.code, 'import_file_unsupported');

    const rowCount = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
    assert.equal(rowCount, 0, 'invalid staged upload must not create a source');
    const batchCount = getDb().prepare('SELECT COUNT(*) AS count FROM acquisition_batches').get().count;
    assert.equal(batchCount, 0, 'invalid staged upload must not create an acquisition batch');
  });
});

test('staged duplicate upload points at the existing receipt without creating a source', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);

    const first = await stageUpload(asUrl, cookie, 'google-maps');
    const firstDone = await waitForArtifact(asUrl, cookie, first.body.artifact_id, ['staged']);
    assert.equal(firstDone.body.status, 'staged');
    assert.match(firstDone.body.connection_id, /^cin_/);

    const second = await stageUpload(asUrl, cookie, 'google-maps');
    assert.equal(second.status, 202, second.text);
    assert.equal(second.body.connection_id, null);
    const secondDone = await waitForArtifact(asUrl, cookie, second.body.artifact_id, ['duplicate']);
    assert.equal(secondDone.status, 200, secondDone.text);
    assert.equal(secondDone.body.status, 'duplicate');
    assert.equal(secondDone.body.connection_id, firstDone.body.connection_id);
    assert.equal(secondDone.body.next_step.kind, 'show_status');

    const rowCount = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
    assert.equal(rowCount, 1, 'duplicate staged upload must not create a second source');
    const batchCount = getDb().prepare('SELECT COUNT(*) AS count FROM acquisition_batches').get().count;
    assert.equal(batchCount, 1, 'duplicate staged upload must reuse the existing acquisition batch');
  });
});

test('repeated owner artifact returns the existing receipt without creating another draft', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);
    const first = await createDraft(asUrl, cookie, 'google-maps');
    assert.equal(first.status, 201, first.text);

    const second = await createDraft(asUrl, cookie, 'google-maps');
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.object, 'manual_upload_known_artifact');
    assert.equal(second.body.connection_id, first.body.connection_id);
    assert.equal(second.body.next_step.kind, 'show_status');
    assert.equal(second.body.validation.status, 'duplicate');

    const rowCount = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
    assert.equal(rowCount, 1, 'duplicate artifact must not create a second draft connection');
    const batchCount = getDb().prepare('SELECT COUNT(*) AS count FROM acquisition_batches').get().count;
    assert.equal(batchCount, 1, 'duplicate artifact must reuse the existing acquisition batch');

    const previewDuplicate = await validateUpload(asUrl, cookie, 'google-maps');
    assert.equal(previewDuplicate.status, 200, previewDuplicate.text);
    assert.equal(previewDuplicate.body.object, 'manual_upload_validation_preview');
    assert.equal(previewDuplicate.body.validation.status, 'duplicate');
    assert.equal(previewDuplicate.body.duplicate.connection_id, first.body.connection_id);
    assert.equal(previewDuplicate.body.next_step.kind, 'show_status');
  });
});

test('WhatsApp chat export is manifest-driven and accepts owner .txt artifacts', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'whatsapp');
    const cookie = await login(asUrl);

    const setup = await getSetup(asUrl, cookie, 'whatsapp');
    assert.equal(setup.status, 200, setup.text);
    assert.deepEqual(setup.body.accepted_file_extensions, ['.txt', '.zip']);
    assert.ok(setup.body.validation_expectations.some((item) => /messages/i.test(item)));

    const created = await createDraft(
      asUrl,
      cookie,
      'whatsapp',
      'WhatsApp Chat - Ghazal.txt',
      '[6/5/24, 9:15:22 AM] Alice: Hello\n[6/5/24, 9:16:00 AM] Bob: <Media omitted>',
    );
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.connector_id, 'whatsapp');
    assert.equal(created.body.display_name, 'WhatsApp - Ghazal');
    assert.equal(created.body.validation.status, 'valid');
    assert.equal(created.body.validation.detected_format, 'whatsapp_chat_export');
    assert.equal(created.body.validation.estimated_messages, 2);
    assert.equal(created.body.validation.estimated_attachments, 1);
    assert.equal(created.body.validation.source_identity.title, 'Ghazal');

    const batch = getDb()
      .prepare(
        `SELECT acquisition_method, source_format, parsed_count, media_coverage_json, warnings_json
           FROM acquisition_batches
          WHERE connector_instance_id = ?`,
      )
      .get(created.body.connection_id);
    assert.equal(batch.acquisition_method, 'owner_artifact');
    assert.equal(batch.source_format, 'whatsapp_chat_export');
    assert.equal(batch.parsed_count, 3);
    assert.equal(JSON.parse(batch.media_coverage_json).status, 'not_included');
    assert.match(JSON.parse(batch.warnings_json)[0], /media files are not included/i);
  });
});

test('WhatsApp zip export with media attaches to an existing manual-upload connection', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'whatsapp');
    const cookie = await login(asUrl);

    const first = await createDraft(
      asUrl,
      cookie,
      'whatsapp',
      'WhatsApp Chat - Ghazal.txt',
      '[6/5/24, 9:15:22 AM] Alice: Hello',
      { displayName: 'the owner WhatsApp' },
    );
    assert.equal(first.status, 201, first.text);
    assert.equal(first.body.display_name, 'the owner WhatsApp');

    const previewIntoExisting = await validateUpload(
      asUrl,
      cookie,
      'whatsapp',
      'WhatsApp Chat - Ghazal.txt',
      '[6/6/24, 10:15:22 AM] Alice: Checking target label',
      { connectionId: first.body.connection_id },
    );
    assert.equal(previewIntoExisting.status, 200, previewIntoExisting.text);
    assert.equal(previewIntoExisting.body.display_name, 'the owner WhatsApp');
    assert.equal(previewIntoExisting.body.next_step.kind, 'confirm_import');

    const zip = makeStoredZip([
      {
        name: 'WhatsApp Chat - Ghazal.txt',
        data: '[6/6/24, 10:15:22 AM] Alice: <attached: IMG-20240606-WA0001.jpg>',
      },
      { name: 'IMG-20240606-WA0001.jpg', data: Buffer.from([1, 2, 3]) },
    ]);
    const second = await createDraft(asUrl, cookie, 'whatsapp', 'WhatsApp Chat - Ghazal.zip', zip, {
      connectionId: first.body.connection_id,
    });
    assert.equal(second.status, 201, second.text);
    assert.equal(second.body.connection_id, first.body.connection_id);
    assert.equal(second.body.validation.detected_format, 'whatsapp_chat_export_zip');
    assert.equal(second.body.validation.media_coverage.status, 'included_for_import');
    assert.equal(second.body.validation.media_coverage.attached_media_files, 1);

    const rowCount = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
    assert.equal(rowCount, 1, 'adding another export to the same WhatsApp source must not create another connection');
    const batchCount = getDb().prepare('SELECT COUNT(*) AS count FROM acquisition_batches').get().count;
    assert.equal(batchCount, 2, 'each accepted export keeps its own acquisition-batch receipt');
  });
});

test('manual upload preview rejects an incompatible target connection before import', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    await registerConnector(asUrl, 'whatsapp');
    const cookie = await login(asUrl);

    const timeline = await createDraft(asUrl, cookie, 'google-maps');
    assert.equal(timeline.status, 201, timeline.text);

    const preview = await validateUpload(
      asUrl,
      cookie,
      'whatsapp',
      'WhatsApp Chat - Ghazal.txt',
      '[6/5/24, 9:15:22 AM] Alice: Hello',
      { connectionId: timeline.body.connection_id },
    );
    assert.equal(preview.status, 409, preview.text);
    assert.equal(preview.body?.error?.code, 'connector_instance_connector_mismatch');
    assert.equal(preview.body?.error?.param, 'connection_id');

    const whatsappRows = getDb()
      .prepare("SELECT COUNT(*) AS count FROM connector_instances WHERE connector_id = 'whatsapp'")
      .get().count;
    assert.equal(whatsappRows, 0, 'incompatible preview target must not create a WhatsApp draft');
  });
});

test('WhatsApp malformed zip is rejected before commit', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'whatsapp');
    const cookie = await login(asUrl);

    const malformed = Buffer.concat([Buffer.from('PK\u0003\u0004', 'binary'), Buffer.from('not a usable zip')]);
    const created = await createDraft(asUrl, cookie, 'whatsapp', 'WhatsApp Chat - Broken.zip', malformed);
    assert.equal(created.status, 400, created.text);
    assert.equal(created.body?.error?.code, 'import_file_unsupported');

    const rowCount = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
    assert.equal(rowCount, 0, 'malformed zip validation must not create a draft');
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

test('wrong-source account-report artifacts are rejected before commit instead of inferred as an account match', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    await registerConnector(asUrl, 'whatsapp');
    const cookie = await login(asUrl);

    const accountReportJson = JSON.stringify({
      account: { email: 'not-the-owner@example.com' },
      exportType: 'google_account_report',
    });
    const timelineWrongSource = await createDraft(asUrl, cookie, 'google-maps', 'Timeline.json', accountReportJson);
    assert.equal(timelineWrongSource.status, 400);
    assert.equal(timelineWrongSource.body?.error?.code, 'import_file_unsupported');
    assert.match(timelineWrongSource.body?.error?.message ?? '', /Timeline JSON export/);

    const whatsappAccountReport = await createDraft(
      asUrl,
      cookie,
      'whatsapp',
      'WhatsApp Chat - Account report.txt',
      'WhatsApp account information report\nPhone number: +1 555 0100',
    );
    assert.equal(whatsappAccountReport.status, 400);
    assert.equal(whatsappAccountReport.body?.error?.code, 'import_file_unsupported');
    assert.match(whatsappAccountReport.body?.error?.message ?? '', /chat export .*\.txt.*\.zip/i);

    const rowCount = getDb().prepare('SELECT COUNT(*) AS count FROM connector_instances').get().count;
    assert.equal(rowCount, 0, 'wrong-source artifacts must not create a draft or infer account identity');
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
