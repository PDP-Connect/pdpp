// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { emitSpineEvent } from "../lib/spine.ts";
import { configureNativeManifest, registerConnector } from "../server/auth.ts";
import {
  type ConnectorSchemaManifestStream,
  getConnectorFreshnessEvidence as getSchemaBuilderFreshnessEvidence,
} from "../server/connector-schema-builder.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

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

function withIsolatedPostgresJourney<T>(journey: (databaseUrl: string) => Promise<T>): Promise<T> {
  assert.ok(POSTGRES_URL, "PostgreSQL journeys require the dedicated test listener URL");
  return withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_sourcekind_${randomBytes(4).toString("hex")}_1`,
    },
    journey
  ) as Promise<T>;
}

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
    const runAt = new Date().toISOString();
    await emitSpineEvent({
      actor_id: connectorKey,
      actor_type: "runtime",
      data: {
        connector_instance_id: connectorInstanceId,
        source: { id: connectorKey, kind: "connector" },
      },
      event_type: "run.completed",
      object_id: `run_${suffix}`,
      object_type: "run",
      occurred_at: runAt,
      run_id: `run_${suffix}`,
      source_id: connectorKey,
      source_kind: "connector",
      status: "succeeded",
    });
    const schemaBuilderEvidence = await getSchemaBuilderFreshnessEvidence({
      manifest: runtimeManifest(connectorKey) as { capabilities?: unknown; streams: ConnectorSchemaManifestStream[] },
      storageBinding: { connector_id: connectorKey },
    });
    assert.deepEqual(
      schemaBuilderEvidence.lastRun,
      { last_at: runAt, status: "succeeded" },
      "connector-schema-builder must use the storage connector run"
    );

    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const oppositeKind: SourceKind = kind === "connector" ? "provider_native" : "connector";
    const mismatch = await fetchJson(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/runtime_neutrality_test",
            source: { id: sourceId, kind: oppositeKind },
            streams: [{ name: "items" }],
            type: "https://pdpp.dev/data-access",
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
            purpose_code: "https://pdpp.dev/purpose/runtime_neutrality_test",
            source: { id: sourceId, kind },
            streams: [{ fields: ["id", "label"], name: "items" }],
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_id: CLIENT_ID,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
    assert.ok(initiated.body.request_uri);

    const review = await fetchJson(`${asUrl}/consent/review`, {
      body: JSON.stringify({ request_uri: initiated.body.request_uri, subject_id: OWNER_ID }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(
      typeof review.body.approval_review_revision,
      "string",
      "consent review must return approval_review_revision"
    );
    const approved = await fetchJson(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: review.body.approval_review_revision,
        request_uri: initiated.body.request_uri,
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
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
    assert.equal(
      schema.body.connectors[0].streams[0].freshness.last_attempted_at,
      runAt,
      "schema freshness must use the storage connector run, not the source URI"
    );

    const connectors = await fetchJson(`${rsUrl}/v1/connectors`, {
      headers: { Authorization: `Bearer ${approved.body.token}` },
    });
    assert.equal(connectors.status, 200, JSON.stringify(connectors.body));
    assert.equal(
      connectors.body.data[0].streams[0].freshness.last_attempted_at,
      runAt,
      "connector discovery freshness must use the storage connector run"
    );

    const streamMetadata = await fetchJson(`${rsUrl}/v1/streams/items`, {
      headers: { Authorization: `Bearer ${approved.body.token}` },
    });
    assert.equal(streamMetadata.status, 200, JSON.stringify(streamMetadata.body));
    assert.equal(
      streamMetadata.body.freshness.last_attempted_at,
      runAt,
      "stream freshness must use the storage connector run"
    );

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

async function approveConfiguredDefault(backend: Backend, kind: SourceKind): Promise<unknown[]> {
  const sourceId = `https://sources.example/configured-default-${backend.name}`;
  const connectorKey = `configured_default_${backend.name}`;
  let server: TestServer | null = null;
  try {
    server = (await startServer({
      asPort: 0,
      ...(backend.databaseUrl ? { databaseUrl: backend.databaseUrl, storageBackend: "postgres" as const } : {}),
      dbPath: ":memory:",
      nativeManifest: localFulfillment(sourceId, kind, connectorKey),
      quiet: true,
      reconcilePolyfillManifests: false,
      rsPort: 0,
      startClientEventDeliveryWorker: false,
    })) as TestServer;

    const asUrl = `http://localhost:${server.asPort}`;
    const initiated = await fetchJson(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/configured_default_neutrality_test",
            source: { id: sourceId, kind },
            streams: [{ fields: ["id", "label"], name: "items" }],
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_id: CLIENT_ID,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(initiated.status, 201, JSON.stringify(initiated.body));

    const review = await fetchJson(`${asUrl}/consent/review`, {
      body: JSON.stringify({ request_uri: initiated.body.request_uri, subject_id: OWNER_ID }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    const reviewedInstanceIds = review.body.approval_review?.resolved_streams?.[0]?.instance_ids;
    assert.deepEqual(
      reviewedInstanceIds?.length,
      1,
      "review resolves the configured default without a stored instance"
    );

    const approved = await fetchJson(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: review.body.approval_review_revision,
        request_uri: initiated.body.request_uri,
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(
      approved.body.grant.streams[0].instance_ids,
      reviewedInstanceIds,
      "final issuance preserves the configured default selected at review"
    );
    return reviewedInstanceIds as unknown[];
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

test("configured fulfillment default is identical for connector and provider_native sources on SQLite", async () => {
  const connector = await approveConfiguredDefault({ name: "sqlite" }, "connector");
  const providerNative = await approveConfiguredDefault({ name: "sqlite" }, "provider_native");
  assert.deepEqual(providerNative, connector);
});

test("source.kind is provenance while local connector storage fulfills reads on PostgreSQL", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is required",
}, async (t) => {
  assert.ok(POSTGRES_URL);
  for (const kind of ["connector", "provider_native"] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: The runtime backend is process-global, so these journeys must be serialized.
    await t.test(kind, () =>
      withIsolatedPostgresJourney((databaseUrl) => runConsentGrantRead({ databaseUrl, name: "postgres" }, kind))
    );
  }
});

test("configured fulfillment default is identical for connector and provider_native sources on PostgreSQL", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is required",
}, async () => {
  assert.ok(POSTGRES_URL);
  const connector = await withIsolatedPostgresJourney((databaseUrl) =>
    approveConfiguredDefault({ databaseUrl, name: "postgres" }, "connector")
  );
  const providerNative = await withIsolatedPostgresJourney((databaseUrl) =>
    approveConfiguredDefault({ databaseUrl, name: "postgres" }, "provider_native")
  );
  assert.deepEqual(providerNative, connector);
});
