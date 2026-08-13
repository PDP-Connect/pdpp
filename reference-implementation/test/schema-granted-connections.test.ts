// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/v1/schema` per-stream `granted_connections` regression suite.
 *
 * Closes the deferred `granted_connections` sub-item under section 4.1 of
 * `openspec/changes/canonicalize-public-read-contract/tasks.md`. With storage
 * fan-in landed, the runtime can now advertise the discoverable set of
 * connections per granted stream so grant-authorized clients (and the
 * hosted MCP gateway / dashboard) can scope subsequent reads via
 * `connection_id` without trial-and-error.
 *
 * Covers:
 *
 *   - multi-connection owner scope returns every active connection;
 *   - grant constrained to one `connection_id` returns only that connection;
 *   - grant without `connection_id` constraint preserves fan-in across
 *     active connections;
 *   - owner-renamed `display_name` propagates to the next schema response;
 *   - storage placeholder labels (`legacy`, `default_account`, connector_id
 *     defaults) are omitted from the wire (no leakage of non-granted /
 *     placeholder connections).
 *
 * Stays on the SQLite reference path; the helper delegates to
 * `connector-instance-store.listActiveByConnector`, which has Postgres
 * parity tested by the same fan-in helpers in `storage-fan-in-read-contract.test.js`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { listGrantedConnectionsForStream as listGrantedConnectionsForStreamUntyped } from "../server/connection-identity.ts";
import { closeDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { ingestRecord } from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

interface GrantedConnection {
  connection_id: string;
  display_name?: string;
}

type ListGrantedConnectionsForStream = (args: {
  ownerSubjectId: string | null;
  connectorId: string | null;
  grantStreamConnectionId?: string | null;
}) => Promise<GrantedConnection[]>;

const listGrantedConnectionsForStream = listGrantedConnectionsForStreamUntyped as ListGrantedConnectionsForStream;

function at<T>(items: T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected an entry at index ${index}`);
  return item;
}

const CONNECTOR_ID = "schema-granted-connections";
const STREAM = "messages";

const INSTANCE_A = "cin_schema_account_a";
const INSTANCE_B = "cin_schema_account_b";

const baseManifest = {
  capabilities: { human_interaction: [] },
  connector_id: CONNECTOR_ID,
  display_name: "Schema Granted Connections Test Connector",
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: STREAM,
      primary_key: ["id"],
      query: {},
      schema: {
        properties: {
          id: { type: "string" },
          received_at: { format: "date-time", type: "string" },
          subject: { type: "string" },
        },
        required: ["id", "subject", "received_at"],
        type: "object",
      },
      selection: { fields: { mode: "explicit" } },
    },
  ],
  version: "1.0.0",
};

function target(instanceId: string) {
  return { connector_id: CONNECTOR_ID, connector_instance_id: instanceId };
}

function record(id: string, receivedAt: string) {
  return {
    data: { id, received_at: receivedAt, subject: `subj ${id}` },
    emitted_at: receivedAt,
    key: id,
    stream: STREAM,
  };
}

async function seedInstance(instanceId: string, displayName: string, sourceBindingKey: string): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: instanceId,
    createdAt: now,
    displayName,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

async function withDualConnectionDb(fn: () => Promise<void>): Promise<void> {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, "Account A", "a@example.com");
    await seedInstance(INSTANCE_B, "Account B", "b@example.com");
    await ingestRecord(target(INSTANCE_A), record("a-1", "2026-05-25T12:00:00.000Z"));
    await ingestRecord(target(INSTANCE_B), record("b-1", "2026-05-25T12:01:00.000Z"));
    await fn();
  } finally {
    closeDb();
  }
}

async function withSingleConnectionDb(fn: () => Promise<void>): Promise<void> {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, "Sole Account", "a@example.com");
    await ingestRecord(target(INSTANCE_A), record("a-1", "2026-05-25T12:00:00.000Z"));
    await fn();
  } finally {
    closeDb();
  }
}

async function withPlaceholderConnectionDb(fn: () => Promise<void>): Promise<void> {
  initDb();
  try {
    await registerConnector(baseManifest);
    // `default_account` is the legacy placeholder display_name the storage
    // layer assigns when no owner-meaningful label has been set. The wire
    // MUST omit `display_name` for this row rather than leak the placeholder.
    await seedInstance(INSTANCE_A, "default_account", "a@example.com");
    // A second connection whose label happens to equal the connector_id is
    // also a placeholder (the helper falls back to that string when no real
    // display_name exists). Verify it is omitted too.
    await seedInstance(INSTANCE_B, CONNECTOR_ID, "b@example.com");
    await fn();
  } finally {
    closeDb();
  }
}

// ─── Owner / multi-connection scope ───────────────────────────────────────

test("owner scope enumerates every active connection with meaningful display_name", async () => {
  await withDualConnectionDb(async () => {
    const granted = await listGrantedConnectionsForStream({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(granted.length, 2);
    // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
    const ids = granted.map((g) => g.connection_id).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
    // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
    const labels = granted.map((g) => g.display_name).sort();
    assert.deepEqual(labels, ["Account A", "Account B"]);
    for (const entry of granted) {
      assert.equal(Object.keys(entry).sort().join(","), "connection_id,display_name");
    }
  });
});

// ─── Grant constrained to one connection ──────────────────────────────────

test("grant constrained to one connection_id returns only that connection", async () => {
  await withDualConnectionDb(async () => {
    const granted = await listGrantedConnectionsForStream({
      connectorId: CONNECTOR_ID,
      grantStreamConnectionId: INSTANCE_B,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(granted.length, 1);
    assert.equal(at(granted, 0).connection_id, INSTANCE_B);
    assert.equal(at(granted, 0).display_name, "Account B");
  });
});

// ─── Grant without connection_id constraint preserves fan-in ─────────────

test("grant without connection_id constraint returns every active connection", async () => {
  await withDualConnectionDb(async () => {
    const granted = await listGrantedConnectionsForStream({
      connectorId: CONNECTOR_ID,
      grantStreamConnectionId: null,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
    const ids = granted.map((g) => g.connection_id).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
  });
});

// ─── display_name propagation after owner rename ──────────────────────────

test("owner-renamed display_name propagates to the next granted_connections list", async () => {
  await withDualConnectionDb(async () => {
    const store = createSqliteConnectorInstanceStore();
    await store.setDisplayName(INSTANCE_A, {
      displayName: "Personal Inbox",
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const granted = await listGrantedConnectionsForStream({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    const a = granted.find((g) => g.connection_id === INSTANCE_A);
    assert.equal(a?.display_name, "Personal Inbox");
  });
});

// ─── No leakage of storage placeholders ───────────────────────────────────

test("placeholder display_names are omitted from granted_connections", async () => {
  await withPlaceholderConnectionDb(async () => {
    const granted = await listGrantedConnectionsForStream({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(granted.length, 2);
    for (const entry of granted) {
      assert.equal(
        Object.hasOwn(entry, "display_name"),
        false,
        `expected placeholder display_name to be omitted, got ${entry.display_name}`
      );
      assert.ok(["cin_schema_account_a", "cin_schema_account_b"].includes(entry.connection_id));
    }
  });
});

// ─── No leakage of non-granted connections (different owners) ─────────────

test("non-granted connections under a different owner do not leak into granted_connections", async () => {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, "Account A", "a@example.com");
    // Seed an instance under a different owner — must not appear in the
    // owner's granted_connections enumeration.
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    await store.upsert({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: "cin_other_owner",
      createdAt: now,
      displayName: "Other Owner Account",
      ownerSubjectId: "other_owner_subject",
      sourceBinding: { account: "c@example.com" },
      sourceBindingKey: "c@example.com",
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    });

    const granted = await listGrantedConnectionsForStream({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(granted.length, 1);
    assert.equal(at(granted, 0).connection_id, INSTANCE_A);
  } finally {
    closeDb();
  }
});

// ─── Revoked (non-active) connections do not appear ───────────────────────

test("revoked connections do not appear in granted_connections", async () => {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, "Account A", "a@example.com");
    await seedInstance(INSTANCE_B, "Account B", "b@example.com");
    const store = createSqliteConnectorInstanceStore();
    await store.updateStatus(INSTANCE_B, {
      revokedAt: new Date().toISOString(),
      status: "revoked",
      updatedAt: new Date().toISOString(),
    });
    const granted = await listGrantedConnectionsForStream({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(granted.length, 1);
    assert.equal(at(granted, 0).connection_id, INSTANCE_A);
  } finally {
    closeDb();
  }
});

// ─── Single-connection deployment preserves canonical shape ──────────────

test("single-connection deployment returns one entry with display_name", async () => {
  await withSingleConnectionDb(async () => {
    const granted = await listGrantedConnectionsForStream({
      connectorId: CONNECTOR_ID,
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    });
    assert.equal(granted.length, 1);
    assert.equal(at(granted, 0).connection_id, INSTANCE_A);
    assert.equal(at(granted, 0).display_name, "Sole Account");
  });
});

// ─── Empty inputs yield empty array (defensive, not a throw) ──────────────

test("missing connectorId or ownerSubjectId returns an empty list", async () => {
  const noConnector = await listGrantedConnectionsForStream({
    connectorId: null,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
  });
  assert.deepEqual(noConnector, []);
  const noOwner = await listGrantedConnectionsForStream({
    connectorId: CONNECTOR_ID,
    ownerSubjectId: null,
  });
  assert.deepEqual(noOwner, []);
});

// ─── End-to-end HTTP wire-shape on /v1/schema ──────────────────────────────

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

interface JsonResult {
  body: Record<string, unknown> | string | null;
  status: number;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: JsonResult["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

function asRecord(body: JsonResult["body"]): Record<string, unknown> {
  assert.ok(typeof body === "object" && body !== null, "expected a JSON object body");
  return body;
}

type StartedServer = Awaited<ReturnType<typeof startServer>>;

function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  if (hasCloseAllConnections(server.asServer)) {
    server.asServer.closeAllConnections();
  }
  if (hasCloseAllConnections(server.rsServer)) {
    server.rsServer.closeAllConnections();
  }
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = asRecord(deviceBody);
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: String(device.user_code) }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBodyRaw } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: String(device.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenBody = asRecord(tokenBodyRaw);
  return String(tokenBody.access_token);
}

interface GrantApprovalParams {
  access_mode: string;
  client_id: string;
  connector_id?: string;
  purpose_code: string;
  purpose_description: string;
  source?: { kind: string; id: string };
  streams: unknown[];
}

async function approveGrant(
  asUrl: string,
  subjectId: string,
  params: GrantApprovalParams
): Promise<Record<string, unknown>> {
  const { body: initiateRaw } = await fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: params.source || { id: params.connector_id, kind: "connector" },
          streams: params.streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const initiate = asRecord(initiateRaw);
  if (!initiate.request_uri) {
    throw new Error(`startGrantRequest returned no request_uri: ${JSON.stringify(initiate)}`);
  }
  const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: subjectId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return asRecord(approved);
}

async function withHttpHarness(
  fn: (harness: { asUrl: string; rsUrl: string }) => Promise<void>,
  { seed }: { seed?: () => Promise<void> } = {}
): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(baseManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201, "register connector");
    if (seed) {
      await seed();
    }
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

interface WireStream {
  granted_connections?: GrantedConnection[];
  name: string;
}

interface WireConnector {
  connector_id: string;
  streams: WireStream[];
}

function findStream(connector: WireConnector, name: string): WireStream {
  const stream = connector.streams.find((s) => s.name === name);
  assert.ok(stream, `expected stream "${name}" to be present`);
  return stream;
}

test("GET /v1/schema emits granted_connections for multi-connection owner scope", async () => {
  await withHttpHarness(
    async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const { status, body: bodyRaw } = await fetchJson(
        `${rsUrl}/v1/schema?connector_id=${encodeURIComponent(CONNECTOR_ID)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(status, 200);
      const body = asRecord(bodyRaw);
      assert.equal(body.object, "schema");
      const connectors = body.connectors as WireConnector[];
      const connector = connectors.find((c) => c.connector_id === CONNECTOR_ID);
      assert.ok(connector, "connector item present");
      const stream = findStream(connector, STREAM);
      assert.ok(Array.isArray(stream.granted_connections), "granted_connections is an array");
      const grantedConnections = stream.granted_connections ?? [];
      assert.equal(grantedConnections.length, 2);
      const ids = grantedConnections.map((g) => g.connection_id).sort();
      assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
      const labels = grantedConnections.map((g) => g.display_name).sort();
      assert.deepEqual(labels, ["Account A", "Account B"]);
    },
    {
      seed: async () => {
        await seedInstance(INSTANCE_A, "Account A", "a@example.com");
        await seedInstance(INSTANCE_B, "Account B", "b@example.com");
        await ingestRecord(target(INSTANCE_A), record("a-1", "2026-05-25T12:00:00.000Z"));
        await ingestRecord(target(INSTANCE_B), record("b-1", "2026-05-25T12:01:00.000Z"));
      },
    }
  );
});

test("GET /v1/schema honors grant.streams[].connection_id constraint", async () => {
  await withHttpHarness(
    async ({ asUrl, rsUrl }) => {
      const approved = await approveGrant(asUrl, "owner_local", {
        access_mode: "continuous",
        client_id: "longview",
        purpose_code: "https://pdpp.dev/purpose/analytics",
        purpose_description: "granted_connections scope test",
        source: { id: CONNECTOR_ID, kind: "connector" },
        streams: [
          {
            connection_id: INSTANCE_B,
            fields: ["id", "subject", "received_at"],
            name: STREAM,
          },
        ],
      });
      assert.ok(approved.token, "expected client token");
      const { status, body: bodyRaw } = await fetchJson(`${rsUrl}/v1/schema`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(status, 200);
      const body = asRecord(bodyRaw);
      const connectors = body.connectors as WireConnector[];
      const connector = at(connectors, 0);
      const stream = findStream(connector, STREAM);
      const grantedConnections = stream.granted_connections ?? [];
      assert.equal(grantedConnections.length, 1);
      assert.equal(at(grantedConnections, 0).connection_id, INSTANCE_B);
      assert.equal(at(grantedConnections, 0).display_name, "Account B");
      // The non-granted connection MUST NOT appear anywhere in the body.
      const serialized = JSON.stringify(body);
      assert.equal(
        serialized.includes(INSTANCE_A),
        false,
        "non-granted connection_id leaked into client schema response"
      );
    },
    {
      seed: async () => {
        await seedInstance(INSTANCE_A, "Account A", "a@example.com");
        await seedInstance(INSTANCE_B, "Account B", "b@example.com");
        await ingestRecord(target(INSTANCE_A), record("a-1", "2026-05-25T12:00:00.000Z"));
        await ingestRecord(target(INSTANCE_B), record("b-1", "2026-05-25T12:01:00.000Z"));
      },
    }
  );
});

test("GET /v1/schema returns every active connection when grant omits connection_id", async () => {
  await withHttpHarness(
    async ({ asUrl, rsUrl }) => {
      const approved = await approveGrant(asUrl, "owner_local", {
        access_mode: "continuous",
        client_id: "longview",
        purpose_code: "https://pdpp.dev/purpose/analytics",
        purpose_description: "granted_connections fan-in test",
        source: { id: CONNECTOR_ID, kind: "connector" },
        streams: [{ fields: ["id", "subject", "received_at"], name: STREAM }],
      });
      assert.ok(approved.token, "expected client token");
      const { status, body: bodyRaw } = await fetchJson(`${rsUrl}/v1/schema`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(status, 200);
      const body = asRecord(bodyRaw);
      const connectors = body.connectors as WireConnector[];
      const stream = findStream(at(connectors, 0), STREAM);
      const ids = (stream.granted_connections ?? []).map((g) => g.connection_id).sort();
      assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
    },
    {
      seed: async () => {
        await seedInstance(INSTANCE_A, "Account A", "a@example.com");
        await seedInstance(INSTANCE_B, "Account B", "b@example.com");
        await ingestRecord(target(INSTANCE_A), record("a-1", "2026-05-25T12:00:00.000Z"));
        await ingestRecord(target(INSTANCE_B), record("b-1", "2026-05-25T12:01:00.000Z"));
      },
    }
  );
});
