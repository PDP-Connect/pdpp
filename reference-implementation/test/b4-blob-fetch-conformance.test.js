/**
 * B4 conformance — blob_ref / fetch_url replayable runbook proof.
 *
 * Verifies that the documented contract in:
 *   docs/operator/blob-fetch-runbook.md
 *
 * matches the actual behaviour of GET /v1/blobs/:blob_id.
 *
 * Tests mirror the runbook steps:
 *   1. Upload a blob (POST /v1/blobs)
 *   2. Seed the record that references it via blob_ref
 *   3. Issue a grant that includes the blob_ref field
 *   4. Query records → fetch_url is decorated on blob_ref
 *   5. GET /v1/blobs/:blob_id → documented headers + raw bytes
 *   6. Grant enforcement: blob_not_found when token cannot see the record
 *
 * Gate: all tests green; documented shapes match actual responses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLYFILL_MANIFESTS_DIR = join(
  __dirname,
  '..',
  '..',
  'packages',
  'polyfill-connectors',
  'manifests',
);

// ─── helpers ────────────────────────────────────────────────────────────────

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
  return { status: resp.status, body };
}

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      user_code: device.user_code,
      subject_id: subjectId,
    }).toString(),
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

/**
 * Upload a blob via POST /v1/blobs.
 * Returns the parsed JSON response: { blob_id, mime_type, size_bytes, sha256 }.
 */
async function uploadBlob(rsUrl, ownerToken, params, bytes, contentType) {
  const query = new URLSearchParams({
    connector_id: params.connector_id,
    stream: params.stream,
    record_key: params.record_key,
  });
  const { status, body } = await fetchJson(`${rsUrl}/v1/blobs?${query.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': contentType,
    },
    body: bytes,
  });
  assert.equal(status, 200, `upload blob ok: ${JSON.stringify(body)}`);
  return body;
}

/**
 * Seed records into a stream via NDJSON ingest.
 */
async function seedStream(rsUrl, ownerToken, connectorId, stream, records) {
  const ndjson = records
    .map((r) =>
      JSON.stringify({
        key: r.id,
        data: r,
        emitted_at: r.emitted_at || '2026-01-01T00:00:00Z',
      }),
    )
    .join('\n');
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: ndjson,
    },
  );
  assert.equal(resp.status, 200, `seed ${stream} ok`);
}

/**
 * Issue a grant-scoped client token via PAR + consent/approve.
 */
async function issueClientGrant(asUrl, subjectId, params) {
  const { body: par } = await fetchJson(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.client_id,
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          source: { kind: 'connector', id: params.connector_id },
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          access_mode: params.access_mode,
          streams: params.streams,
        },
      ],
    }),
  });
  const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_uri: par.request_uri,
      subject_id: subjectId,
    }),
  });
  return approved;
}

function readGmailManifest() {
  return JSON.parse(
    readFileSync(join(POLYFILL_MANIFESTS_DIR, 'gmail.json'), 'utf8'),
  );
}

async function withGmailHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  const manifest = readGmailManifest();
  const regResp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(regResp.status, 201, 'register gmail connector');

  try {
    await fn({ asUrl, rsUrl, connectorId: manifest.connector_id });
  } finally {
    await closeServer(server);
  }
}

// ─── B4.1 — full blob lifecycle: upload → record → grant → fetch ─────────────

test('blob lifecycle: upload → seed record → grant with blob_ref → fetch bytes (B4)', async () => {
  await withGmailHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'b4_lifecycle_owner');
    const bytes = Buffer.from('attachment content: invoice data for B4 test');
    const sha256Expected = createHash('sha256').update(bytes).digest('hex');

    // Step 1 — upload blob
    const blob = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, stream: 'attachments', record_key: 'msg-b4:2' },
      bytes,
      'application/pdf',
    );

    assert.ok(blob.blob_id.startsWith('blob_sha256_'), 'blob_id has expected prefix');
    assert.equal(blob.mime_type, 'application/pdf', 'mime_type echoed back');
    assert.equal(blob.size_bytes, bytes.length, 'size_bytes echoed back');
    assert.ok(blob.sha256, 'sha256 present');

    // Step 2 — seed parent message + attachment record with blob_ref
    await seedStream(rsUrl, ownerToken, connectorId, 'messages', [
      {
        id: 'msg-b4',
        thread_id: 'thread-b4',
        subject: 'B4 invoice',
        received_at: '2026-01-10T12:00:00Z',
        to: [],
        cc: [],
        bcc: [],
        reply_to: [],
        references: [],
        labels: [],
        is_draft: false,
        is_flagged: false,
        is_seen: true,
        is_answered: false,
        has_attachments: true,
        snippet: 'Invoice attached.',
      },
    ]);

    await seedStream(rsUrl, ownerToken, connectorId, 'attachments', [
      {
        id: 'msg-b4:2',
        message_id: 'msg-b4',
        filename: 'invoice.pdf',
        content_type: 'application/pdf',
        size_bytes: blob.size_bytes,
        content_id: null,
        is_inline: false,
        encoding: 'base64',
        part_index: '2',
        message_received_at: '2026-01-10T12:00:00Z',
        blob_ref: {
          blob_id: blob.blob_id,
          mime_type: blob.mime_type,
          size_bytes: blob.size_bytes,
          sha256: blob.sha256,
        },
        content_sha256: blob.sha256,
        hydration_status: 'hydrated',
        hydration_error: null,
      },
    ]);

    // Step 3 — issue client grant that includes blob_ref field
    const approved = await issueClientGrant(asUrl, 'b4_lifecycle_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'assist.export',
      purpose_description: 'Export Gmail attachment for B4 blob test.',
      access_mode: 'continuous',
      streams: [
        {
          name: 'messages',
          fields: ['id', 'thread_id', 'subject', 'received_at', 'has_attachments'],
        },
        {
          name: 'attachments',
          fields: ['id', 'message_id', 'filename', 'content_type', 'size_bytes', 'blob_ref'],
        },
      ],
    });

    // Step 4 — query attachments, assert fetch_url is decorated on blob_ref
    const { status: recStatus, body: recBody } = await fetchJson(
      `${rsUrl}/v1/streams/attachments/records?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );
    assert.equal(recStatus, 200, 'records query ok');
    const attachment = recBody.data.find((r) => r.id === 'msg-b4:2');
    assert.ok(attachment, 'attachment record found');
    assert.ok(attachment.data.blob_ref, 'blob_ref present on record');
    assert.equal(
      attachment.data.blob_ref.fetch_url,
      `/v1/blobs/${blob.blob_id}`,
      'fetch_url matches /v1/blobs/:blob_id shape',
    );

    // Step 5 — fetch blob bytes via fetch_url using the same client token
    const fetchUrl = `${rsUrl}${attachment.data.blob_ref.fetch_url}`;
    const blobResp = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(blobResp.status, 200, 'blob fetch returns 200');

    // Documented response headers
    assert.equal(
      blobResp.headers.get('Content-Type'),
      'application/pdf',
      'Content-Type = mime_type stored at upload time',
    );
    assert.equal(
      blobResp.headers.get('Cache-Control'),
      'private, no-store',
      'Cache-Control: private, no-store (always)',
    );
    assert.equal(
      blobResp.headers.get('Content-Length'),
      String(bytes.length),
      'Content-Length = exact size_bytes',
    );

    // Byte integrity
    const fetched = Buffer.from(await blobResp.arrayBuffer());
    assert.deepEqual(fetched, bytes, 'fetched bytes are byte-identical to uploaded bytes');
    const sha256Actual = createHash('sha256').update(fetched).digest('hex');
    assert.equal(sha256Actual, sha256Expected, 'sha256 of fetched bytes matches upload');
  });
});

// ─── B4.2 — grant enforcement: blob_not_found without matching grant ─────────

test('blob grant enforcement: blob_not_found when token lacks visibility to the record (B4)', async () => {
  await withGmailHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'b4_enforce_owner');
    const bytes = Buffer.from('secret content: must not be accessible without grant');

    const blob = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, stream: 'attachments', record_key: 'msg-enforce:2' },
      bytes,
      'application/octet-stream',
    );

    await seedStream(rsUrl, ownerToken, connectorId, 'messages', [
      {
        id: 'msg-enforce',
        thread_id: 'thread-enforce',
        subject: 'Enforcement test',
        received_at: '2026-01-11T12:00:00Z',
        to: [],
        cc: [],
        bcc: [],
        reply_to: [],
        references: [],
        labels: [],
        is_draft: false,
        is_flagged: false,
        is_seen: true,
        is_answered: false,
        has_attachments: true,
        snippet: '',
      },
    ]);

    await seedStream(rsUrl, ownerToken, connectorId, 'attachments', [
      {
        id: 'msg-enforce:2',
        message_id: 'msg-enforce',
        filename: 'secret.bin',
        content_type: 'application/octet-stream',
        size_bytes: blob.size_bytes,
        content_id: null,
        is_inline: false,
        encoding: 'base64',
        part_index: '2',
        message_received_at: '2026-01-11T12:00:00Z',
        blob_ref: {
          blob_id: blob.blob_id,
          mime_type: blob.mime_type,
          size_bytes: blob.size_bytes,
          sha256: blob.sha256,
        },
        content_sha256: blob.sha256,
        hydration_status: 'hydrated',
        hydration_error: null,
      },
    ]);

    // Issue a grant that does NOT include blob_ref in the attachments field projection
    const noBlob = await issueClientGrant(asUrl, 'b4_enforce_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'assist.summarize',
      purpose_description: 'B4 enforcement: no blob_ref in projection.',
      access_mode: 'continuous',
      streams: [
        {
          name: 'messages',
          fields: ['id', 'subject', 'received_at'],
        },
        {
          name: 'attachments',
          // blob_ref deliberately omitted from fields
          fields: ['id', 'message_id', 'filename', 'content_type'],
        },
      ],
    });

    // Attempt to fetch the blob with the grant that cannot see it
    const enforceResp = await fetch(`${rsUrl}/v1/blobs/${encodeURIComponent(blob.blob_id)}`, {
      headers: { Authorization: `Bearer ${noBlob.token}` },
    });

    assert.equal(
      enforceResp.status,
      404,
      'blob fetch returns 404 when grant does not expose blob_ref',
    );

    const enforceBody = await enforceResp.json();
    assert.equal(
      enforceBody.error?.code,
      'blob_not_found',
      'error code is blob_not_found (caller learns nothing about which connector owns the blob)',
    );
  });
});

// ─── B4.3 — fetch_url shape: relative path prepend RS base URL ───────────────

test('fetch_url is relative /v1/blobs/:blob_id — must prepend RS base URL (B4)', async () => {
  await withGmailHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'b4_fetchurl_owner');
    const bytes = Buffer.from('shape test bytes');

    const blob = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, stream: 'attachments', record_key: 'msg-shape:3' },
      bytes,
      'image/png',
    );

    await seedStream(rsUrl, ownerToken, connectorId, 'messages', [
      {
        id: 'msg-shape',
        thread_id: 'thread-shape',
        subject: 'Shape test',
        received_at: '2026-01-12T12:00:00Z',
        to: [],
        cc: [],
        bcc: [],
        reply_to: [],
        references: [],
        labels: [],
        is_draft: false,
        is_flagged: false,
        is_seen: true,
        is_answered: false,
        has_attachments: true,
        snippet: '',
      },
    ]);

    await seedStream(rsUrl, ownerToken, connectorId, 'attachments', [
      {
        id: 'msg-shape:3',
        message_id: 'msg-shape',
        filename: 'logo.png',
        content_type: 'image/png',
        size_bytes: blob.size_bytes,
        content_id: null,
        is_inline: true,
        encoding: 'base64',
        part_index: '3',
        message_received_at: '2026-01-12T12:00:00Z',
        blob_ref: {
          blob_id: blob.blob_id,
          mime_type: 'image/png',
          size_bytes: blob.size_bytes,
          sha256: blob.sha256,
        },
        content_sha256: blob.sha256,
        hydration_status: 'hydrated',
        hydration_error: null,
      },
    ]);

    const approved = await issueClientGrant(asUrl, 'b4_fetchurl_owner', {
      client_id: 'longview',
      connector_id: connectorId,
      purpose_code: 'assist.export',
      purpose_description: 'B4 fetch_url shape test.',
      access_mode: 'continuous',
      streams: [
        { name: 'messages', fields: ['id', 'subject'] },
        { name: 'attachments', fields: ['id', 'filename', 'blob_ref'] },
      ],
    });

    const { body: recBody } = await fetchJson(
      `${rsUrl}/v1/streams/attachments/records?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${approved.token}` } },
    );

    const rec = recBody.data.find((r) => r.id === 'msg-shape:3');
    assert.ok(rec, 'record found');

    const fetchUrl = rec.data.blob_ref?.fetch_url;
    assert.ok(fetchUrl, 'fetch_url is present');

    // Documented shape: relative path, starts with /v1/blobs/
    assert.ok(fetchUrl.startsWith('/v1/blobs/'), `fetch_url must start with /v1/blobs/, got: ${fetchUrl}`);
    assert.ok(!fetchUrl.startsWith('http'), 'fetch_url is relative (no scheme)');

    // Content-Type must reflect mime_type at upload time (image/png)
    const blobResp = await fetch(`${rsUrl}${fetchUrl}`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(blobResp.status, 200);
    assert.equal(blobResp.headers.get('Content-Type'), 'image/png', 'Content-Type = image/png');
    assert.equal(blobResp.headers.get('Cache-Control'), 'private, no-store');
  });
});
