// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerConnector as registerConnectorCatalog } from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { ingestRecord } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

interface CloseableHttpServer {
  close: (callback: () => void) => unknown;
  closeAllConnections?: () => void;
}

interface TestServer {
  asPort: number;
  asServer: CloseableHttpServer;
  rsPort: number;
  rsServer: CloseableHttpServer;
}

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(() => resolve(undefined))),
    new Promise((resolve) => server.rsServer.close(() => resolve(undefined))),
  ]);
}

interface FetchJsonResult<T> {
  body: T;
  resp: Response;
  status: number;
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body: body as T, resp, status: resp.status };
}

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}

interface TokenBody {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device, status: deviceStatus } = await fetchJson<DeviceAuthorizationBody>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  assert.equal(deviceStatus, 200);

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody, status: tokenStatus } = await fetchJson<TokenBody>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(tokenStatus, 200);
  assert.ok(tokenBody.access_token, "device exchange should issue an owner token");
  return tokenBody.access_token;
}

interface ConnectorManifest {
  connector_id: string;
  [extension: string]: unknown;
}

function loadGmailManifest(): ConnectorManifest {
  const path = join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors", "manifests", "gmail.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadSpotifyManifest(): ConnectorManifest {
  const path = join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors", "manifests", "spotify.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadNorthstarManifest(): NorthstarManifest {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests", "northstar-hr.json"), "utf8"));
}

async function registerConnector(asUrl: string, manifest: ConnectorManifest): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
}

interface NorthstarManifest {
  name: string;
  source_declaration: {
    protocol_version: string;
    streams: { name: string }[];
    [key: string]: unknown;
  };
  storage_binding: { connector_id: string };
  version: string;
  [key: string]: unknown;
}

interface StreamSummaryBody {
  connection_id?: string;
  connector_id?: string;
  connector_instance_id?: string;
  name: string;
  source?: { id: string; kind: string };
  [extension: string]: unknown;
}

interface StreamListBody {
  data: StreamSummaryBody[];
}

interface RecordSummaryBody {
  id: string;
  [extension: string]: unknown;
}

interface RecordListBody {
  data: RecordSummaryBody[];
}

interface ErrorEnvelopeBody {
  error?: { code?: string; param?: string };
}

interface BlobUploadBody {
  blob_id: string;
}

async function seedNorthstar(nativeManifest: NorthstarManifest, ownerSubjectId: string): Promise<void> {
  const connectorId = nativeManifest.storage_binding.connector_id;
  const connectorInstanceId = makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId);
  const now = new Date().toISOString();
  await registerConnectorCatalog(
    {
      connector_id: connectorId,
      display_name: nativeManifest.name,
      protocol_version: nativeManifest.source_declaration.protocol_version,
      source_declaration: nativeManifest.source_declaration,
      streams: nativeManifest.source_declaration.streams,
      version: nativeManifest.version,
    },
    { backfillRetrievalIndexes: false }
  );
  await createRequestConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId,
    createdAt: now,
    displayName: "Northstar HR",
    ownerSubjectId,
    sourceBinding: { fixture: "trusted-owner-agent-rest-boundary" },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  await ingestRecord(
    { connector_id: connectorId, connector_instance_id: connectorInstanceId },
    {
      data: {
        currency: "USD",
        employee_id: "emp_123",
        employer: "Northstar HR",
        gross_pay: 5400,
        net_pay: 3912,
        statement_id: "ps_owner_agent_1",
      },
      emitted_at: "2026-05-31T00:00:00Z",
      key: "ps_owner_agent_1",
      stream: "pay_statements",
    }
  );
}

test("trusted owner-agent bearer reaches owner-visible REST discovery and read surfaces", async () => {
  const nativeManifest = loadNorthstarManifest();
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    nativeManifest,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const ownerSubjectId = "employee_1";
    await seedNorthstar(nativeManifest, ownerSubjectId);
    const ownerToken = await issueOwnerToken(asUrl, ownerSubjectId);
    const authHeaders = { Authorization: `Bearer ${ownerToken}` };

    const schema = await fetchJson(`${rsUrl}/v1/schema`, { headers: authHeaders });
    assert.equal(schema.status, 200);

    const streams = await fetchJson<StreamListBody>(`${rsUrl}/v1/streams`, { headers: authHeaders });
    assert.equal(streams.status, 200, JSON.stringify(streams.body));
    assert.ok(streams.body.data.some((stream) => stream.name === "pay_statements"));

    const streamMetadata = await fetchJson(`${rsUrl}/v1/streams/pay_statements`, { headers: authHeaders });
    assert.equal(streamMetadata.status, 200, JSON.stringify(streamMetadata.body));

    const records = await fetchJson<RecordListBody>(`${rsUrl}/v1/streams/pay_statements/records?limit=1`, {
      headers: authHeaders,
    });
    assert.equal(records.status, 200, JSON.stringify(records.body));
    assert.equal(records.body.data?.[0]?.id, "ps_owner_agent_1");

    const search = await fetchJson(`${rsUrl}/v1/search?q=Northstar&limit=1`, { headers: authHeaders });
    assert.equal(search.status, 200, JSON.stringify(search.body));
  } finally {
    await closeServer(server);
  }
});

test("trusted owner-agent bearer reaches connector-scoped blob read surface", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = loadGmailManifest();
    await registerConnector(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);
    const authHeaders = { Authorization: `Bearer ${ownerToken}` };

    const bytes = Buffer.from("owner-agent-blob", "utf8");
    const uploadParams = new URLSearchParams({
      connector_id: manifest.connector_id,
      record_key: "owner_agent_attach_1",
      stream: "attachments",
    });
    const upload = await fetchJson<BlobUploadBody>(`${rsUrl}/v1/blobs?${uploadParams.toString()}`, {
      body: bytes,
      headers: {
        ...authHeaders,
        "Content-Type": "text/plain",
      },
      method: "POST",
    });
    assert.equal(upload.status, 200);

    const ndjson = `${JSON.stringify({
      data: {
        blob_ref: { blob_id: upload.body.blob_id },
        filename: "owner-agent.txt",
        message_id: "owner_agent_msg_1",
        mime_type: "text/plain",
        size_bytes: bytes.byteLength,
      },
      emitted_at: "2026-05-31T00:00:00Z",
      key: "owner_agent_attach_1",
    })}\n`;
    interface IngestBody {
      records_accepted: number;
    }

    const ingest = await fetchJson<IngestBody>(
      `${rsUrl}/v1/ingest/attachments?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      {
        body: ndjson,
        headers: {
          ...authHeaders,
          "Content-Type": "application/x-ndjson",
        },
        method: "POST",
      }
    );
    assert.equal(ingest.status, 200);
    assert.equal(ingest.body.records_accepted, 1);

    const streams = await fetchJson(`${rsUrl}/v1/streams?connector_id=${encodeURIComponent(manifest.connector_id)}`, {
      headers: authHeaders,
    });
    assert.equal(streams.status, 200);

    const ownerWideStreams = await fetchJson<StreamListBody>(`${rsUrl}/v1/streams`, { headers: authHeaders });
    assert.equal(ownerWideStreams.status, 200);
    const attachmentsStream = ownerWideStreams.body.data.find((stream) => stream.name === "attachments");
    assert.ok(attachmentsStream, "owner-wide stream discovery should include polyfill connector streams");
    assert.equal(attachmentsStream.connector_id, canonicalConnectorKey(manifest.connector_id));
    assert.deepEqual(attachmentsStream.source, {
      id: canonicalConnectorKey(manifest.connector_id),
      kind: "connector",
    });
    assert.equal(typeof attachmentsStream.connection_id, "string");
    assert.ok(attachmentsStream.connection_id, "attachmentsStream.connection_id must be a non-empty string");
    const attachmentsConnectionId = attachmentsStream.connection_id;
    assert.equal(attachmentsStream.connector_instance_id, attachmentsConnectionId);

    const spotifyManifest = loadSpotifyManifest();
    await registerConnector(asUrl, spotifyManifest);
    const connectionFilteredStreams = await fetchJson<StreamListBody>(
      `${rsUrl}/v1/streams?connection_id=${encodeURIComponent(attachmentsConnectionId)}`,
      { headers: authHeaders }
    );
    assert.equal(connectionFilteredStreams.status, 200);
    assert.ok(connectionFilteredStreams.body.data.some((stream) => stream.name === "attachments"));
    assert.ok(
      !connectionFilteredStreams.body.data.some(
        (stream) => stream.connector_id === canonicalConnectorKey(spotifyManifest.connector_id)
      )
    );
    assert.ok(connectionFilteredStreams.body.data.every((stream) => stream.connection_id === attachmentsConnectionId));

    const streamMetadata = await fetchJson(
      `${rsUrl}/v1/streams/attachments?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: authHeaders }
    );
    assert.equal(streamMetadata.status, 200);

    const records = await fetchJson<RecordListBody>(
      `${rsUrl}/v1/streams/attachments/records?connector_id=${encodeURIComponent(manifest.connector_id)}&limit=1`,
      { headers: authHeaders }
    );
    assert.equal(records.status, 200);
    assert.equal(records.body.data?.[0]?.id, "owner_agent_attach_1");

    const recordsByConnection = await fetchJson<RecordListBody>(
      `${rsUrl}/v1/streams/attachments/records?connection_id=${encodeURIComponent(attachmentsConnectionId)}&limit=1`,
      { headers: authHeaders }
    );
    assert.equal(recordsByConnection.status, 200);
    assert.equal(recordsByConnection.body.data?.[0]?.id, "owner_agent_attach_1");

    const conflictingConnectionSelectors = await fetchJson<ErrorEnvelopeBody>(
      `${rsUrl}/v1/streams/attachments/records?connection_id=${encodeURIComponent(attachmentsConnectionId)}&connector_instance_id=cin_other&limit=1`,
      { headers: authHeaders }
    );
    assert.equal(conflictingConnectionSelectors.status, 400);
    assert.equal(conflictingConnectionSelectors.body.error?.code, "invalid_argument");
    assert.equal(conflictingConnectionSelectors.body.error?.param, "connector_instance_id");

    const search = await fetchJson(`${rsUrl}/v1/search?q=owner-agent&limit=1`, { headers: authHeaders });
    assert.equal(search.status, 200);

    const blobRead = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(upload.body.blob_id)}?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      {
        headers: authHeaders,
      }
    );
    assert.equal(blobRead.status, 200);
    assert.equal(blobRead.headers.get("content-type"), "text/plain");
    assert.deepEqual(Buffer.from(await blobRead.arrayBuffer()), bytes);
  } finally {
    await closeServer(server);
  }
});
