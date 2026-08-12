// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { configureNativeManifest, registerConnector } from "../server/auth.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";

type SourceKind = "connector" | "provider_native";

interface Backend {
  databaseUrl?: string;
  name: "postgres" | "sqlite";
}

interface JsonObject {
  [key: string]: any;
}

interface TestServer {
  asPort: number;
  asServer: import("node:http").Server;
  rsPort: number;
  rsServer: import("node:http").Server;
}

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CLIENT_ID = "concert_recommendation_app";
const OWNER_ID = "owner_local";

function runtimeManifest(connectorKey: string): JsonObject {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorKey,
    connector_key: connectorKey,
    display_name: "Source kind runtime neutrality",
    manifest_uri: `https://implementations.example/connectors/${connectorKey}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: { id: { type: "string" }, label: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

function localFulfillment(sourceId: string, kind: SourceKind, connectorKey: string): JsonObject {
  const runtime = runtimeManifest(connectorKey);
  return {
    source_declaration: {
      declaration_version: `runtime-neutrality-${kind}-v1`,
      display: { name: `Runtime neutrality ${kind}` },
      extensions: {},
      protocol_version: "0.1.0",
      publisher: { id: "https://publishers.example/pdpp-test" },
      source: { id: sourceId, kind },
      streams: runtime.streams,
    },
    storage_binding: { connector_id: connectorKey },
    streams: runtime.streams,
  };
}

async function fetchJson(url: string, options: RequestInit = {}): Promise<{ body: JsonObject; status: number }> {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    body: text ? (JSON.parse(text) as JsonObject) : {},
    status: response.status,
  };
}

async function closeServer(server: TestServer | null): Promise<void> {
  if (!server) {
    return;
  }
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

async function runConsentGrantRead(backend: Backend, kind: SourceKind): Promise<void> {
  const suffix = `${backend.name}_${kind}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const connectorKey = `source_kind_${suffix}`;
  const connectorInstanceId = `cin_${suffix}`;
  const sourceId = `https://sources.example/${suffix}`;
  const fulfillment = localFulfillment(sourceId, kind, connectorKey);
  let server: TestServer | null = null;
  try {
    server = (await startServer({
      asPort: 0,
      ...(backend.databaseUrl ? { databaseUrl: backend.databaseUrl, storageBackend: "postgres" as const } : {}),
      dbPath: ":memory:",
      nativeManifest: fulfillment,
      quiet: true,
      reconcilePolyfillManifests: false,
      rsPort: 0,
      startClientEventDeliveryWorker: false,
    })) as TestServer;

    await registerConnector(runtimeManifest(connectorKey));
    const now = new Date().toISOString();
    await createRequestConnectorInstanceStore().upsert({
      connectorId: connectorKey,
      connectorInstanceId,
      createdAt: now,
      displayName: `Runtime neutrality ${kind}`,
      ownerSubjectId: OWNER_ID,
      sourceBinding: { fixture: suffix },
      sourceBindingKey: suffix,
      sourceKind: "manual",
      status: "active",
      updatedAt: now,
    });
    await ingestRecord(
      { connector_id: connectorKey, connector_instance_id: connectorInstanceId },
      {
        data: { id: `item-${suffix}`, label: `${kind} through connector storage` },
        key: `item-${suffix}`,
        stream: "items",
      }
    );

    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const oppositeKind: SourceKind = kind === "connector" ? "provider_native" : "connector";
    const mismatch = await fetchJson(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.org/purpose/runtime_neutrality_test",
            source: { id: sourceId, kind: oppositeKind },
            streams: [{ name: "items" }],
            type: "https://pdpp.org/data-access",
          },
        ],
        client_id: CLIENT_ID,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(mismatch.status, 400, "request kind must match the retained declaration");
    assert.equal(mismatch.body.error.code, "invalid_request");

    const initiated = await fetchJson(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.org/purpose/runtime_neutrality_test",
            source: { id: sourceId, kind },
            streams: [{ fields: ["id", "label"], name: "items" }],
            type: "https://pdpp.org/data-access",
          },
        ],
        client_id: CLIENT_ID,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
    assert.ok(initiated.body.request_uri);

    const approved = await fetchJson(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ request_uri: initiated.body.request_uri, subject_id: OWNER_ID }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.ok(approved.body.token);
    assert.deepEqual(approved.body.grant.source, { id: sourceId, kind });
    assert.deepEqual(approved.body.grant.streams[0].instance_ids, [connectorInstanceId]);
    assert.equal("storage_binding" in approved.body.grant, false);
    assert.equal(JSON.stringify(approved.body.grant).includes(connectorKey), false);

    const revokedAt = new Date().toISOString();
    await createRequestConnectorInstanceStore().updateStatus(connectorInstanceId, {
      revokedAt,
      status: "revoked",
      updatedAt: revokedAt,
    });

    const schema = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${approved.body.token}` },
    });
    assert.equal(schema.status, 200, JSON.stringify(schema.body));
    assert.deepEqual(schema.body.connectors[0].source, { id: sourceId, kind });
    assert.deepEqual(schema.body.connectors[0].streams[0].granted_connections, [
      {
        connection_id: connectorInstanceId,
        display_name: `Runtime neutrality ${kind}`,
      },
    ]);

    const records = await fetchJson(`${rsUrl}/v1/streams/items/records`, {
      headers: { Authorization: `Bearer ${approved.body.token}` },
    });
    assert.equal(records.status, 200, JSON.stringify(records.body));
    assert.equal(records.body.data.length, 1);
    assert.deepEqual(records.body.data[0].data, {
      id: `item-${suffix}`,
      label: `${kind} through connector storage`,
    });
  } finally {
    await closeServer(server);
    configureNativeManifest(null);
    await closePostgresStorage();
    closeDb();
  }
}

test("source.kind is provenance while local connector storage fulfills reads on SQLite", async (t) => {
  for (const kind of ["connector", "provider_native"] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: The runtime backend is process-global, so these journeys must be serialized.
    await t.test(kind, () => runConsentGrantRead({ name: "sqlite" }, kind));
  }
});

test("source.kind is provenance while local connector storage fulfills reads on PostgreSQL", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is required",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  for (const kind of ["connector", "provider_native"] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: The runtime backend is process-global, so these journeys must be serialized.
    await t.test(kind, () => runConsentGrantRead({ databaseUrl: POSTGRES_URL, name: "postgres" }, kind));
  }
});
