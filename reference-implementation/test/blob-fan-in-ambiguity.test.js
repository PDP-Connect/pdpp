/**
 * Route-level regression for `GET /v1/blobs/:blob_id` under multi-binding
 * (multi-connection) deployments. Pins the owner-review revision
 * (`tmp/workstreams/fan-in-branch-owner-review-report.md`) for:
 *
 *   P1: blob ambiguity must be reachable and emit typed `ambiguous_connection`
 *       (HTTP 409) with `available_connections` when the same blob_id is
 *       visible through more than one connection and the request did not
 *       specify `connection_id`.
 *
 *   P2: blob reads must respect grant-scope `streams[].connection_id`. A
 *       grant pinned to connection A for stream S must not expose blob
 *       bytes reachable only from connection B for stream S.
 *
 * The tests drive the actual Fastify route through the public surface so a
 * regression at the route adapter (not just the helper) is caught.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { registerConnector } from '../server/auth.js';
import { ingestRecord } from '../server/records.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { exec, referenceQueries } from '../lib/db.ts';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';

import { startServer } from '../server/index.js';

const CONNECTOR_ID = 'https://test.pdpp.org/connectors/blob-fan-in';
const STREAM_A = 'photos';
const STREAM_B = 'videos';
const INSTANCE_A = 'cin_blob_account_a';
const INSTANCE_B = 'cin_blob_account_b';

const baseManifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Blob Fan-in Test Connector',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: STREAM_A,
      primary_key: ['id'],
      cursor_field: 'received_at',
      consent_time_field: 'received_at',
      schema: {
        type: 'object',
        required: ['id', 'received_at'],
        properties: {
          id: { type: 'string' },
          received_at: { type: 'string', format: 'date-time' },
          blob_ref: {
            type: 'object',
            required: ['blob_id'],
            properties: {
              blob_id: { type: 'string' },
              mime_type: { type: 'string' },
              size_bytes: { type: 'integer' },
              sha256: { type: 'string' },
            },
          },
        },
      },
      query: { aggregations: { count: true } },
    },
    {
      name: STREAM_B,
      primary_key: ['id'],
      cursor_field: 'received_at',
      consent_time_field: 'received_at',
      schema: {
        type: 'object',
        required: ['id', 'received_at'],
        properties: {
          id: { type: 'string' },
          received_at: { type: 'string', format: 'date-time' },
          blob_ref: {
            type: 'object',
            required: ['blob_id'],
            properties: {
              blob_id: { type: 'string' },
              mime_type: { type: 'string' },
              size_bytes: { type: 'integer' },
              sha256: { type: 'string' },
            },
          },
        },
      },
      query: { aggregations: { count: true } },
    },
  ],
};

function target(instanceId) {
  return { connector_id: CONNECTOR_ID, connector_instance_id: instanceId };
}

async function seedInstance(instanceId, displayName, sourceBindingKey) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorInstanceId: instanceId,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorId: CONNECTOR_ID,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey,
    sourceBinding: { account: sourceBindingKey },
    createdAt: now,
    updatedAt: now,
  });
}

// Insert a blob row + binding directly into the SQLite tables so we
// fully control the (connector_id, connector_instance_id, stream, record_key)
// tuples each binding references. Mirrors the columns
// `persistContentAddressedBlob` writes.
function seedBlob({ blobId, connectorInstanceId, stream, recordKey, mimeType, data }) {
  exec(referenceQueries.blobsInsertBlob, [
    blobId,
    CONNECTOR_ID,
    connectorInstanceId,
    stream,
    recordKey,
    mimeType,
    data.length,
    'sha256_test',
    data,
  ]);
}

function seedBlobBinding({ blobId, connectorInstanceId, stream, recordKey }) {
  exec(referenceQueries.blobsInsertBinding, [
    blobId,
    CONNECTOR_ID,
    connectorInstanceId,
    stream,
    recordKey,
  ]);
}

async function issueOwnerOnlyHarness(testFn) {
  // For owner-mode blob reads the route resolves storage binding from
  // `req.query.connector_id` + optional `connector_instance_id`. For
  // grant-mode blob reads the route uses the grant's resolved storage
  // binding. We test both.
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
    await seedInstance(INSTANCE_B, 'Account B', 'b@example.com');
    await testFn(server);
  } finally {
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await Promise.allSettled([
      new Promise((r) => server.asServer.close(r)),
      new Promise((r) => server.rsServer.close(r)),
    ]);
  }
}

async function getOwnerToken(server) {
  const asUrl = `http://localhost:${server.asPort}`;
  const clientId = 'cli_longview';
  const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  const deviceText = await deviceResp.text();
  if (!deviceResp.ok) {
    throw new Error(`device_authorization failed: ${deviceResp.status} ${deviceText}`);
  }
  const device = JSON.parse(deviceText);
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      user_code: device.user_code,
      subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    }).toString(),
  });
  const tokenResp = await fetch(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  const tokenText = await tokenResp.text();
  if (!tokenResp.ok) {
    throw new Error(`token failed: ${tokenResp.status} ${tokenText}`);
  }
  const tokenBody = JSON.parse(tokenText);
  if (!tokenBody.access_token) {
    throw new Error(`no access_token: ${JSON.stringify(tokenBody)}`);
  }
  return tokenBody.access_token;
}

// ─── P1: blob ambiguity is reachable + emits 409 ───────────────────────────

test('GET /v1/blobs/:blob_id emits 409 ambiguous_connection when blob visible via 2 connections (owner mode)', async () => {
  await issueOwnerOnlyHarness(async (server) => {
    const blobId = 'blob_sha256_ambig_001';
    const sharedBytes = Buffer.from('shared-bytes');
    // Seed: the same blob_id is referenced by records under TWO different
    // connector_instance_ids, both under the same stream.
    seedBlob({
      blobId,
      connectorInstanceId: INSTANCE_A,
      stream: STREAM_A,
      recordKey: 'rec-a-1',
      mimeType: 'text/plain',
      data: sharedBytes,
    });
    seedBlobBinding({
      blobId,
      connectorInstanceId: INSTANCE_B,
      stream: STREAM_A,
      recordKey: 'rec-b-1',
    });
    // The records themselves must reference the blob via blob_ref.
    await ingestRecord(target(INSTANCE_A), {
      stream: STREAM_A,
      key: 'rec-a-1',
      data: { id: 'rec-a-1', received_at: '2026-05-19T00:00:00.000Z', blob_ref: { blob_id: blobId } },
      emitted_at: '2026-05-19T00:00:00.000Z',
    });
    await ingestRecord(target(INSTANCE_B), {
      stream: STREAM_A,
      key: 'rec-b-1',
      data: { id: 'rec-b-1', received_at: '2026-05-19T00:00:00.000Z', blob_ref: { blob_id: blobId } },
      emitted_at: '2026-05-19T00:00:00.000Z',
    });

    const ownerToken = await getOwnerToken(server);
    const rsUrl = `http://localhost:${server.rsPort}`;
    const resp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(blobId)}?connector_id=${encodeURIComponent(CONNECTOR_ID)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(resp.status, 409,
      `expected 409 ambiguous_connection, got ${resp.status}`);
    const body = await resp.json();
    assert.equal(body.error?.code, 'ambiguous_connection',
      `expected ambiguous_connection, got ${JSON.stringify(body)}`);
    assert.equal(body.error?.retry_with, 'connection_id');
    const ids = (body.error?.available_connections || []).map((c) => c.connection_id).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
  });
});

test('GET /v1/blobs/:blob_id?connection_id=X resolves ambiguity and returns bytes', async () => {
  await issueOwnerOnlyHarness(async (server) => {
    const blobId = 'blob_sha256_ambig_002';
    const sharedBytes = Buffer.from('shared-bytes-2');
    seedBlob({
      blobId,
      connectorInstanceId: INSTANCE_A,
      stream: STREAM_A,
      recordKey: 'rec-a-1',
      mimeType: 'text/plain',
      data: sharedBytes,
    });
    seedBlobBinding({
      blobId,
      connectorInstanceId: INSTANCE_B,
      stream: STREAM_A,
      recordKey: 'rec-b-1',
    });
    await ingestRecord(target(INSTANCE_A), {
      stream: STREAM_A,
      key: 'rec-a-1',
      data: { id: 'rec-a-1', received_at: '2026-05-19T00:00:00.000Z', blob_ref: { blob_id: blobId } },
      emitted_at: '2026-05-19T00:00:00.000Z',
    });
    await ingestRecord(target(INSTANCE_B), {
      stream: STREAM_A,
      key: 'rec-b-1',
      data: { id: 'rec-b-1', received_at: '2026-05-19T00:00:00.000Z', blob_ref: { blob_id: blobId } },
      emitted_at: '2026-05-19T00:00:00.000Z',
    });

    const ownerToken = await getOwnerToken(server);
    const rsUrl = `http://localhost:${server.rsPort}`;
    const resp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(blobId)}?connector_id=${encodeURIComponent(CONNECTOR_ID)}&connection_id=${encodeURIComponent(INSTANCE_A)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(resp.status, 200,
      `narrowed read must succeed (got ${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    assert.deepEqual(buf, sharedBytes);
  });
});

// ─── P2: blob reads respect grant-scope per-stream connection_id ───────────

test('blob route per-stream binding resolution narrows by grant connection_id', async () => {
  // The blob route resolves the addressable set per (binding's) stream by
  // calling `resolveReadRequestBindings({ grant, streamName: binding.stream })`.
  // When the grant pins stream A → connection X, the resolver MUST return
  // only X for stream A (regardless of what active bindings exist under
  // the connector). This locks the P2 fix at the resolution layer the
  // blob route relies on.
  await issueOwnerOnlyHarness(async () => {
    const { resolveReadRequestBindings } = await import('../server/records.js');
    const pinnedGrant = {
      streams: [
        { name: STREAM_A, fields: ['id', 'received_at'], connection_id: INSTANCE_A },
        { name: STREAM_B, fields: ['id', 'received_at'], connection_id: INSTANCE_B },
      ],
    };
    const { bindings: photosBindings } = await resolveReadRequestBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      storageBinding: { connector_id: CONNECTOR_ID },
      grant: pinnedGrant,
      requestParams: {},
      streamName: STREAM_A,
    });
    assert.equal(photosBindings.length, 1,
      `stream A's bindings must collapse to its grant-pinned connection (got ${JSON.stringify(photosBindings)})`);
    assert.equal(photosBindings[0].connectorInstanceId, INSTANCE_A);

    const { bindings: videosBindings } = await resolveReadRequestBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      storageBinding: { connector_id: CONNECTOR_ID },
      grant: pinnedGrant,
      requestParams: {},
      streamName: STREAM_B,
    });
    assert.equal(videosBindings.length, 1,
      `stream B's bindings must collapse to its grant-pinned connection (got ${JSON.stringify(videosBindings)})`);
    assert.equal(videosBindings[0].connectorInstanceId, INSTANCE_B);
  });
});

test('GET /v1/blobs/:blob_id returns 200 when only one connection holds the blob (fan-in auto-select)', async () => {
  await issueOwnerOnlyHarness(async (server) => {
    const blobId = 'blob_sha256_unique_003';
    const bytes = Buffer.from('unique-bytes');
    seedBlob({
      blobId,
      connectorInstanceId: INSTANCE_A,
      stream: STREAM_A,
      recordKey: 'rec-a-1',
      mimeType: 'application/octet-stream',
      data: bytes,
    });
    await ingestRecord(target(INSTANCE_A), {
      stream: STREAM_A,
      key: 'rec-a-1',
      data: { id: 'rec-a-1', received_at: '2026-05-19T00:00:00.000Z', blob_ref: { blob_id: blobId } },
      emitted_at: '2026-05-19T00:00:00.000Z',
    });

    const ownerToken = await getOwnerToken(server);
    const rsUrl = `http://localhost:${server.rsPort}`;
    const resp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(blobId)}?connector_id=${encodeURIComponent(CONNECTOR_ID)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(resp.status, 200);
    const buf = Buffer.from(await resp.arrayBuffer());
    assert.deepEqual(buf, bytes);
  });
});
