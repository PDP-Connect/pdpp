/**
 * Route-level regression for `GET /v1/blobs/:blob_id` after the
 * `BlobStore` extraction.
 *
 * Pins:
 *   - 200 + correct bytes / Content-Type / Content-Length when the actor's
 *     storage binding holds a record that references the blob.
 *   - 404 + `blob_not_found` envelope when the blob_id does not exist.
 *   - 404 + `blob_not_found` when the blob exists but no visible record under
 *     the actor's storage binding references it.
 *
 * The existing `query-contract.test.js` covers the success path
 * incidentally; this file focuses on the visibility/404 contract that the
 * extracted `BlobStore` capability must preserve.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';

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

async function withHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

function loadGmailManifest() {
  const path = join(
    REFERENCE_IMPL_DIR,
    '..',
    'packages',
    'polyfill-connectors',
    'manifests',
    'gmail.json',
  );
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function registerConnector(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  if (!resp.ok) {
    throw new Error(`register connector failed: ${resp.status} ${await resp.text()}`);
  }
}

test('GET /v1/blobs/:blob_id returns 404 blob_not_found for unknown blob_id', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = loadGmailManifest();
    await registerConnector(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);

    const resp = await fetch(
      `${rsUrl}/v1/blobs/blob_sha256_${'0'.repeat(64)}?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(resp.status, 404);
    const body = await resp.json();
    assert.equal(body.error?.code, 'blob_not_found');
  });
});

test('GET /v1/blobs/:blob_id returns 404 when blob exists but no visible record references it', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = loadGmailManifest();
    await registerConnector(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);

    // Upload a blob without a corresponding record. The blob row + binding
    // exist, but no record references it via blob_ref, so the visibility
    // check must fail.
    const uploadParams = new URLSearchParams({
      connector_id: manifest.connector_id,
      stream: 'attachments',
      record_key: 'orphan_attachment',
    });
    const upload = await fetch(`${rsUrl}/v1/blobs?${uploadParams.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    });
    assert.equal(upload.status, 200, `upload should succeed (got ${upload.status})`);
    const uploadBody = await upload.json();
    assert.equal(uploadBody.object, 'blob');
    assert.match(uploadBody.blob_id, /^blob_sha256_/);

    // Read the blob: visibility must fail because no record exposes
    // blob_ref.blob_id pointing at this upload.
    const readResp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(uploadBody.blob_id)}?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(readResp.status, 404);
    const readBody = await readResp.json();
    assert.equal(readBody.error?.code, 'blob_not_found');
  });
});

test('GET /v1/blobs/:blob_id returns 200 with bytes when a visible record references the blob', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = loadGmailManifest();
    await registerConnector(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);

    const bytes = Buffer.from('hello-world', 'utf8');
    const uploadParams = new URLSearchParams({
      connector_id: manifest.connector_id,
      stream: 'attachments',
      record_key: 'attach_1',
    });
    const upload = await fetch(`${rsUrl}/v1/blobs?${uploadParams.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'text/plain',
      },
      body: bytes,
    });
    assert.equal(upload.status, 200);
    const uploadBody = await upload.json();

    // Ingest a record that references this blob via blob_ref.
    const ndjson = `${JSON.stringify({
      key: 'attach_1',
      data: {
        message_id: 'msg_1',
        filename: 'hello.txt',
        mime_type: 'text/plain',
        size_bytes: bytes.byteLength,
        blob_ref: { blob_id: uploadBody.blob_id },
      },
      emitted_at: '2026-04-01T00:00:00Z',
    })}\n`;
    const ingestResp = await fetch(
      `${rsUrl}/v1/ingest/attachments?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: ndjson,
      },
    );
    assert.equal(ingestResp.status, 200);
    const ingestBody = await ingestResp.json();
    assert.equal(
      ingestBody.records_accepted,
      1,
      `ingest must accept the record (rejected=${ingestBody.records_rejected}, errors=${JSON.stringify(ingestBody.errors)})`,
    );

    // Read the blob: success, with correct headers and bytes.
    const readResp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(uploadBody.blob_id)}?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(readResp.status, 200);
    assert.equal(readResp.headers.get('content-type'), 'text/plain');
    assert.equal(readResp.headers.get('content-length'), String(bytes.byteLength));
    const buf = Buffer.from(await readResp.arrayBuffer());
    assert.deepEqual(buf, bytes);
  });
});
