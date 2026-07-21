// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { ingestRecord } from '../server/records.js';
import { canonicalConnectorKey } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

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
  return { body, resp, status: resp.status };
}

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device, status: deviceStatus } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  assert.equal(deviceStatus, 200);

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody, status: tokenStatus } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  assert.equal(tokenStatus, 200);
  assert.ok(tokenBody.access_token, 'device exchange should issue an owner token');
  return tokenBody.access_token;
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

function loadSpotifyManifest() {
  const path = join(
    REFERENCE_IMPL_DIR,
    '..',
    'packages',
    'polyfill-connectors',
    'manifests',
    'spotify.json',
  );
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadNorthstarManifest() {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests', 'northstar-hr.json'), 'utf8'));
}

async function registerConnector(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201);
}

async function seedNorthstar(nativeManifest) {
  await ingestRecord(nativeManifest.storage_binding.connector_id, {
    stream: 'pay_statements',
    key: 'ps_owner_agent_1',
    data: {
      statement_id: 'ps_owner_agent_1',
      employer: 'Northstar HR',
      gross_pay: 5400,
      net_pay: 3912,
      currency: 'USD',
      employee_id: 'emp_123',
    },
    emitted_at: '2026-05-31T00:00:00Z',
  });
}

test('trusted owner-agent bearer reaches owner-visible REST discovery and read surfaces', async () => {
  const nativeManifest = loadNorthstarManifest();
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    nativeManifest,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    await seedNorthstar(nativeManifest);
    const ownerToken = await issueOwnerToken(asUrl, 'employee_1');
    const authHeaders = { Authorization: `Bearer ${ownerToken}` };

    const schema = await fetchJson(`${rsUrl}/v1/schema`, { headers: authHeaders });
    assert.equal(schema.status, 200);

    const streams = await fetchJson(`${rsUrl}/v1/streams`, { headers: authHeaders });
    assert.equal(streams.status, 200);
    assert.ok(streams.body.data.some((stream) => stream.name === 'pay_statements'));

    const streamMetadata = await fetchJson(`${rsUrl}/v1/streams/pay_statements`, { headers: authHeaders });
    assert.equal(streamMetadata.status, 200);

    const records = await fetchJson(`${rsUrl}/v1/streams/pay_statements/records?limit=1`, {
      headers: authHeaders,
    });
    assert.equal(records.status, 200);
    assert.equal(records.body.data?.[0]?.id, 'ps_owner_agent_1');

    const search = await fetchJson(`${rsUrl}/v1/search?q=Northstar&limit=1`, { headers: authHeaders });
    assert.equal(search.status, 200);
  } finally {
    await closeServer(server);
  }
});

test('trusted owner-agent bearer reaches connector-scoped blob read surface', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = loadGmailManifest();
    await registerConnector(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);
    const authHeaders = { Authorization: `Bearer ${ownerToken}` };

    const bytes = Buffer.from('owner-agent-blob', 'utf8');
    const uploadParams = new URLSearchParams({
      connector_id: manifest.connector_id,
      stream: 'attachments',
      record_key: 'owner_agent_attach_1',
    });
    const upload = await fetchJson(`${rsUrl}/v1/blobs?${uploadParams.toString()}`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'text/plain',
      },
      body: bytes,
    });
    assert.equal(upload.status, 200);

    const ndjson = `${JSON.stringify({
      key: 'owner_agent_attach_1',
      data: {
        message_id: 'owner_agent_msg_1',
        filename: 'owner-agent.txt',
        mime_type: 'text/plain',
        size_bytes: bytes.byteLength,
        blob_ref: { blob_id: upload.body.blob_id },
      },
      emitted_at: '2026-05-31T00:00:00Z',
    })}\n`;
    const ingest = await fetchJson(
      `${rsUrl}/v1/ingest/attachments?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/x-ndjson',
        },
        body: ndjson,
      },
    );
    assert.equal(ingest.status, 200);
    assert.equal(ingest.body.records_accepted, 1);

    const streams = await fetchJson(
      `${rsUrl}/v1/streams?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: authHeaders },
    );
    assert.equal(streams.status, 200);

    const ownerWideStreams = await fetchJson(`${rsUrl}/v1/streams`, { headers: authHeaders });
    assert.equal(ownerWideStreams.status, 200);
    const attachmentsStream = ownerWideStreams.body.data.find((stream) => stream.name === 'attachments');
    assert.ok(attachmentsStream, 'owner-wide stream discovery should include polyfill connector streams');
    assert.equal(attachmentsStream.connector_id, canonicalConnectorKey(manifest.connector_id));
    assert.deepEqual(attachmentsStream.source, {
      kind: 'connector',
      id: canonicalConnectorKey(manifest.connector_id),
    });
    assert.equal(typeof attachmentsStream.connection_id, 'string');
    assert.equal(attachmentsStream.connector_instance_id, attachmentsStream.connection_id);

    const spotifyManifest = loadSpotifyManifest();
    await registerConnector(asUrl, spotifyManifest);
    const connectionFilteredStreams = await fetchJson(
      `${rsUrl}/v1/streams?connection_id=${encodeURIComponent(attachmentsStream.connection_id)}`,
      { headers: authHeaders },
    );
    assert.equal(connectionFilteredStreams.status, 200);
    assert.ok(connectionFilteredStreams.body.data.some((stream) => stream.name === 'attachments'));
    assert.ok(!connectionFilteredStreams.body.data.some((stream) => stream.connector_id === canonicalConnectorKey(spotifyManifest.connector_id)));
    assert.ok(connectionFilteredStreams.body.data.every((stream) => stream.connection_id === attachmentsStream.connection_id));

    const streamMetadata = await fetchJson(
      `${rsUrl}/v1/streams/attachments?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: authHeaders },
    );
    assert.equal(streamMetadata.status, 200);

    const records = await fetchJson(
      `${rsUrl}/v1/streams/attachments/records?connector_id=${encodeURIComponent(manifest.connector_id)}&limit=1`,
      { headers: authHeaders },
    );
    assert.equal(records.status, 200);
    assert.equal(records.body.data?.[0]?.id, 'owner_agent_attach_1');

    const recordsByConnection = await fetchJson(
      `${rsUrl}/v1/streams/attachments/records?connection_id=${encodeURIComponent(attachmentsStream.connection_id)}&limit=1`,
      { headers: authHeaders },
    );
    assert.equal(recordsByConnection.status, 200);
    assert.equal(recordsByConnection.body.data?.[0]?.id, 'owner_agent_attach_1');

    const conflictingConnectionSelectors = await fetchJson(
      `${rsUrl}/v1/streams/attachments/records?connection_id=${encodeURIComponent(attachmentsStream.connection_id)}&connector_instance_id=cin_other&limit=1`,
      { headers: authHeaders },
    );
    assert.equal(conflictingConnectionSelectors.status, 400);
    assert.equal(conflictingConnectionSelectors.body.error?.code, 'invalid_argument');
    assert.equal(conflictingConnectionSelectors.body.error?.param, 'connector_instance_id');

    const search = await fetchJson(`${rsUrl}/v1/search?q=owner-agent&limit=1`, { headers: authHeaders });
    assert.equal(search.status, 200);

    const blobRead = await fetch(`${rsUrl}/v1/blobs/${encodeURIComponent(upload.body.blob_id)}?connector_id=${encodeURIComponent(manifest.connector_id)}`, {
      headers: authHeaders,
    });
    assert.equal(blobRead.status, 200);
    assert.equal(blobRead.headers.get('content-type'), 'text/plain');
    assert.deepEqual(Buffer.from(await blobRead.arrayBuffer()), bytes);
  } finally {
    await closeServer(server);
  }
});
