// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client expansion closure oracles.
 *
 * A resolved v0.1 grant does not freeze relationship authority. Client reads
 * must therefore reject expand[] and expand_limit[...] before consulting the
 * current SourceDeclaration. Owner reads retain current-capability expansion.
 *
 * Valid expandable foreign keys are required schema fields, and issuance adds
 * required fields to the resolved grant. These tests pin that fact instead of
 * reproducing the review's invalid hidden-FK premise. They then prove the real
 * closure defect: current metadata can repoint the same relationship name.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { configureNativeManifest, registerConnector } from "../server/auth.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";

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

const CLIENT_ID = "concert_recommendation_app";
const OWNER_ID = "client_expand_closure_owner";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function runtimeManifest(connectorKey: string): JsonObject {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorKey,
    connector_key: connectorKey,
    display_name: "Client expansion closure",
    manifest_uri: `https://implementations.example/connectors/${connectorKey}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "parents",
        primary_key: ["id"],
        query: { expand: [{ default_limit: 10, max_limit: 20, name: "children" }] },
        relationships: [
          {
            cardinality: "has_many",
            foreign_key: "parent_id",
            name: "children",
            stream: "children",
          },
        ],
        schema: {
          properties: { id: { type: "string" }, title: { type: "string" } },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        name: "children",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            parent_id: { type: "string" },
            visible: { type: "string" },
          },
          required: ["id", "parent_id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        name: "alternate_children",
        primary_key: ["id"],
        schema: {
          properties: {
            alternate_parent_id: { type: "string" },
            id: { type: "string" },
            visible: { type: "string" },
          },
          required: ["id", "alternate_parent_id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

function localFulfillment(sourceId: string, connectorKey: string): JsonObject {
  const runtime = runtimeManifest(connectorKey);
  return {
    source_declaration: {
      declaration_version: "client-expand-closure-v1",
      display: { name: "Client expansion closure" },
      extensions: {},
      protocol_version: "0.1.0",
      publisher: { id: "https://publishers.example/pdpp-test" },
      source: { id: sourceId, kind: "provider_native" },
      streams: runtime.streams,
    },
    storage_binding: { connector_id: connectorKey },
    streams: runtime.streams,
  };
}

async function fetchJson(url: string, options: RequestInit = {}): Promise<{ body: JsonObject; status: number }> {
  const response = await fetch(url, options);
  const text = await response.text();
  return { body: text ? (JSON.parse(text) as JsonObject) : {}, status: response.status };
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

async function approveGrant(asUrl: string, sourceId: string): Promise<JsonObject> {
  const initiated = await fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/client-expand-closure-test",
          source: { id: sourceId, kind: "provider_native" },
          streams: [
            { fields: ["id", "title"], name: "parents" },
            // Omit both child foreign keys from the request. Issuance must add
            // them because valid expandable foreign keys are schema-required.
            { fields: ["id", "visible"], name: "children" },
            { fields: ["id", "visible"], name: "alternate_children" },
          ],
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

  const approved = await fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: review.body.approval_review_revision,
      request_uri: initiated.body.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.ok(approved.body.token, "approval must issue a client token");
  const childrenGrant = approved.body.grant.streams.find((stream: JsonObject) => stream.name === "children");
  const alternateChildrenGrant = approved.body.grant.streams.find(
    (stream: JsonObject) => stream.name === "alternate_children"
  );
  assert.deepEqual(childrenGrant.fields, ["id", "visible", "parent_id"]);
  assert.deepEqual(alternateChildrenGrant.fields, ["id", "visible", "alternate_parent_id"]);
  return approved.body;
}

function assertClientExpansionRejected(
  response: { body: JsonObject; status: number },
  param: "expand" | "expand_limit"
): void {
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.error?.code, "invalid_request");
  assert.equal(response.body.error?.param, param);
  assert.equal(
    response.body.error?.message,
    `${param === "expand" ? "expand[]" : "expand_limit[...]"} is not supported for client-token reads in PDPP v0.1`
  );
}

async function runClientExpansionClosure(backend: Backend): Promise<void> {
  const suffix = `${backend.name}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const connectorKey = `client_expand_closure_${suffix}`;
  const connectorInstanceId = `cin_${suffix}`;
  const sourceId = `https://sources.example/${suffix}`;
  const fulfillment = localFulfillment(sourceId, connectorKey);
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
      displayName: "Client expansion closure",
      ownerSubjectId: OWNER_ID,
      sourceBinding: { fixture: suffix },
      sourceBindingKey: suffix,
      sourceKind: "manual",
      status: "active",
      updatedAt: now,
    });

    const storageTarget = { connector_id: connectorKey, connector_instance_id: connectorInstanceId };
    await ingestRecord(storageTarget, {
      data: { id: "parent-1", title: "Parent" },
      key: "parent-1",
      stream: "parents",
    });
    await ingestRecord(storageTarget, {
      data: { id: "child-1", parent_id: "parent-1", visible: "original relation" },
      key: "child-1",
      stream: "children",
    });
    await ingestRecord(storageTarget, {
      data: { alternate_parent_id: "parent-1", id: "alternate-child-1", visible: "mutated relation" },
      key: "alternate-child-1",
      stream: "alternate_children",
    });

    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const approved = await approveGrant(asUrl, sourceId);
    const auth = { headers: { Authorization: `Bearer ${approved.token as string}` } };

    // Repoint the same relationship name after issuance. The grant has not
    // changed; before closure, current metadata changes the nested child from
    // child-1 to alternate-child-1 and interprets alternate_parent_id.
    const parentStream = fulfillment.streams[0] as JsonObject;
    parentStream.relationships[0] = {
      cardinality: "has_many",
      foreign_key: "alternate_parent_id",
      name: "children",
      stream: "alternate_children",
    };

    assertClientExpansionRejected(
      await fetchJson(`${rsUrl}/v1/streams/parents/records?expand[]=children`, auth),
      "expand"
    );
    assertClientExpansionRejected(
      await fetchJson(`${rsUrl}/v1/streams/parents/records/parent-1?expand[]=children`, auth),
      "expand"
    );
    assertClientExpansionRejected(
      await fetchJson(`${rsUrl}/v1/streams/parents/records?expand_limit[children]=1`, auth),
      "expand_limit"
    );
    assertClientExpansionRejected(await fetchJson(`${rsUrl}/v1/search?q=visible&expand[]=children`, auth), "expand");
  } finally {
    await closeServer(server);
    configureNativeManifest(null);
    await closePostgresStorage();
    closeDb();
  }
}

test("client expansion rejects mutable current relationships before metadata on SQLite", () =>
  runClientExpansionClosure({ name: "sqlite" }));

test("client expansion rejects mutable current relationships before metadata on PostgreSQL", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is required",
}, () => {
  assert.ok(POSTGRES_URL);
  return runClientExpansionClosure({ databaseUrl: POSTGRES_URL, name: "postgres" });
});
