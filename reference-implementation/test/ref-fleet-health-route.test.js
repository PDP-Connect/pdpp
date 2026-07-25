// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import { buildAsApp } from "../server/index.js";
import { createOwnerAuthPlaceholder } from "../server/owner-auth.ts";
import { createOwnerSessionController } from "../server/owner-session.ts";
import { mountRefFleetHealth } from "../server/routes/ref-connectors.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { createApp } from "../server/transport.js";

const OWNER_PASSWORD = "fleet-health-route-owner-password";
const CUSTOM_OWNER_SUBJECT_ID = "custom-fleet-owner";
const OWNER_LOCAL_CONNECTION_ID = "owner-local-must-not-leak";
const CUSTOM_OWNER_CONNECTION_ID = "custom-owner-visible";
const INTERNAL_CONNECTION_ID = "custom-owner-internal";
const VISIBLE_CONNECTOR_ID = "fleet-health-visible-connector";

const HEALTHY_VERDICT = {
  dimensions: {
    active_work: [],
    attention: { needs_owner: [] },
    coverage_audit: "pass",
    freshness_advisories: [],
    intentional_policy: { manual: [], paused: [] },
    recovery: { retryable: [], terminal: [] },
    runtime: "healthy",
    stalled_work: [],
    system: { degraded_or_broken: [] },
    unknown_evidence: [],
  },
  fully_healthy: true,
  scope: {
    assessed: [],
    configured: 0,
    intentional_exclusions: [],
    setup_pending: [],
    unassessed: [],
  },
  state: "healthy",
};

test("fleet-health route uses the real transport, contract registry, and owner-session gate", async () => {
  const app = createApp();
  const ownerAuth = createOwnerAuthPlaceholder({ password: OWNER_PASSWORD });
  mountRefFleetHealth(app, {
    getFleetHealthVerdict: () => HEALTHY_VERDICT,
    handleError: (_res, error) => {
      throw error;
    },
    requireOwnerSession: ownerAuth.requireOwnerSession,
  });
  await app.fastify.ready();

  const rejected = await app.fastify.inject({
    method: "GET",
    url: "/_ref/fleet-health",
    headers: { accept: "application/json" },
  });
  assert.equal(rejected.statusCode, 401);
  assert.equal(JSON.parse(rejected.body).error.code, "owner_session_required");

  const session = createOwnerSessionController({ password: OWNER_PASSWORD }).issueSessionCookieHeader();
  assert.ok(session, "test owner session must be issued");
  const accepted = await app.fastify.inject({
    method: "GET",
    url: "/_ref/fleet-health",
    headers: { accept: "application/json", cookie: session.split(";")[0] },
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(JSON.parse(accepted.body), HEALTHY_VERDICT);
});

test("production fleet wiring projects one custom-owner visible population without internal or owner_local identities", async () => {
  initDb(":memory:");
  const store = createSqliteConnectorInstanceStore();
  const now = "2026-07-23T00:00:00.000Z";
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(
      VISIBLE_CONNECTOR_ID,
      JSON.stringify({
        protocol_version: "0.1.0",
        connector_id: VISIBLE_CONNECTOR_ID,
        version: "1.0.0",
        display_name: "Fleet-visible connector",
        capabilities: { public_listing: { listed: true, status: "test" } },
        streams: [],
      }),
      now
    );
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(
      "pg_lexical_backfill_fleet_health",
      JSON.stringify({
        protocol_version: "0.1.0",
        connector_id: "pg_lexical_backfill_fleet_health",
        version: "1.0.0",
        display_name: "Internal backfill",
        streams: [],
      }),
      now
    );
  for (const [connectorInstanceId, ownerSubjectId, connectorId] of [
    [CUSTOM_OWNER_CONNECTION_ID, CUSTOM_OWNER_SUBJECT_ID, VISIBLE_CONNECTOR_ID],
    [OWNER_LOCAL_CONNECTION_ID, "owner_local", VISIBLE_CONNECTOR_ID],
    [INTERNAL_CONNECTION_ID, CUSTOM_OWNER_SUBJECT_ID, "pg_lexical_backfill_fleet_health"],
  ]) {
    await store.upsert({
      connectorInstanceId,
      ownerSubjectId,
      connectorId,
      displayName: connectorInstanceId,
      status: "active",
      sourceKind: "account",
      sourceBindingKey: connectorInstanceId,
      sourceBinding: { kind: "test" },
      createdAt: now,
      updatedAt: now,
    });
  }

  const app = buildAsApp({ ownerAuthPassword: "", ownerAuthSubjectId: CUSTOM_OWNER_SUBJECT_ID });
  await app.fastify.ready();
  try {
    const response = await app.fastify.inject({ method: "GET", url: "/_ref/fleet-health" });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.scope.configured, 1);
    assert.deepEqual(body.scope.assessed.map((entry) => entry.connection_id), [CUSTOM_OWNER_CONNECTION_ID]);
    assert.deepEqual(body.scope.unassessed, []);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(`${OWNER_LOCAL_CONNECTION_ID}|${INTERNAL_CONNECTION_ID}`));
  } finally {
    await app.fastify.close();
    closeDb();
  }
});
