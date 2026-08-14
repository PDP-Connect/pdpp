// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import type { FleetHealthVerdict } from "../server/fleet-health.ts";
import { buildAsApp } from "../server/index.ts";
import { createOwnerAuthPlaceholder } from "../server/owner-auth.ts";
import { createOwnerSessionController } from "../server/owner-session.ts";
import {
  invalidateConnectorSummariesCache,
  listConnectorSummaries,
  listOwnerVisibleConnectorInstances,
} from "../server/ref-control.ts";
import type { MountRefConnectorsContext } from "../server/routes/ref-connectors.ts";
import { mountRefFleetHealth } from "../server/routes/ref-connectors.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { createApp } from "../server/transport.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";

// mountRefFleetHealth only reads getFleetHealthVerdict / handleError /
// requireOwnerSession from the shared MountRefConnectorsContext, but the
// context type is shared across every `_ref/connectors` route family mount.
// This stub satisfies the other (unused-by-fleet-health) required members by
// throwing if a code path this test never exercises somehow invokes them.
function unusedContextMember(name: string): () => never {
  return () => {
    throw new Error(`ref-fleet-health-route test stub: ${name} must not be called by mountRefFleetHealth`);
  };
}

function fleetHealthTestContext(
  overrides: Pick<MountRefConnectorsContext, "getFleetHealthVerdict" | "handleError" | "requireOwnerSession">
): MountRefConnectorsContext {
  return {
    canonicalConnectorKey: unusedContextMember("canonicalConnectorKey"),
    createRequestConnectorInstanceStore: unusedContextMember("createRequestConnectorInstanceStore"),
    createTraceContext: unusedContextMember("createTraceContext"),
    deleteConnection: unusedContextMember("deleteConnection"),
    deleteSchedule: unusedContextMember("deleteSchedule"),
    emitSpineEvent: unusedContextMember("emitSpineEvent"),
    ensureRequestId: unusedContextMember("ensureRequestId"),
    getConnectorDetail: unusedContextMember("getConnectorDetail"),
    getConnectorSummaryForRoute: unusedContextMember("getConnectorSummaryForRoute"),
    getOwnerSubjectId: unusedContextMember("getOwnerSubjectId"),
    getRuntimeStatus: unusedContextMember("getRuntimeStatus"),
    getSchedule: unusedContextMember("getSchedule"),
    listSchedules: unusedContextMember("listSchedules"),
    pdppError: unusedContextMember("pdppError"),
    resolveOwnerConnectorNamespace: unusedContextMember("resolveOwnerConnectorNamespace"),
    resolveRegisteredConnectorManifest: unusedContextMember("resolveRegisteredConnectorManifest"),
    resolveSingleConnectorIdQueryValue: unusedContextMember("resolveSingleConnectorIdQueryValue"),
    runNow: unusedContextMember("runNow"),
    setReferenceTraceId: unusedContextMember("setReferenceTraceId"),
    setScheduleEnabled: unusedContextMember("setScheduleEnabled"),
    updateConnectorInstanceStatus: unusedContextMember("updateConnectorInstanceStatus"),
    upsertSchedule: unusedContextMember("upsertSchedule"),
    ...overrides,
  };
}

const OWNER_PASSWORD = "fleet-health-route-owner-password";
const CUSTOM_OWNER_SUBJECT_ID = "custom-fleet-owner";
const OWNER_LOCAL_CONNECTION_ID = "owner-local-must-not-leak";
const CUSTOM_OWNER_CONNECTION_ID = "custom-owner-visible";
const INTERNAL_CONNECTION_ID = "custom-owner-internal";
const VISIBLE_CONNECTOR_ID = "fleet-health-visible-connector";

const HEALTHY_VERDICT: FleetHealthVerdict = {
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

function withoutObservedAt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutObservedAt);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "observed_at")
        .map(([key, item]) => [key, withoutObservedAt(item)])
    );
  }
  return value;
}

test("fleet-health route uses the real transport, contract registry, and owner-session gate", async () => {
  const app = createApp();
  const ownerAuth = createOwnerAuthPlaceholder({ password: OWNER_PASSWORD });
  mountRefFleetHealth(
    app,
    fleetHealthTestContext({
      getFleetHealthVerdict: () => HEALTHY_VERDICT,
      handleError: (_res: unknown, error: unknown) => {
        throw error;
      },
      requireOwnerSession: (...args: unknown[]) => {
        const [req, res, next] = args as Parameters<typeof ownerAuth.requireOwnerSession>;
        return ownerAuth.requireOwnerSession(req, res, next);
      },
    })
  );
  await app.fastify.ready();

  const rejected = await app.fastify.inject({
    headers: { accept: "application/json" },
    method: "GET",
    url: "/_ref/fleet-health",
  });
  assert.equal(rejected.statusCode, 401);
  assert.equal(JSON.parse(rejected.body).error.code, "owner_session_required");

  const session = createOwnerSessionController({ password: OWNER_PASSWORD }).issueSessionCookieHeader();
  assert.ok(session, "test owner session must be issued");
  const accepted = await app.fastify.inject({
    headers: { accept: "application/json", cookie: session.split(";")[0] },
    method: "GET",
    url: "/_ref/fleet-health",
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
        capabilities: { public_listing: { listed: true, status: "test" } },
        connector_id: VISIBLE_CONNECTOR_ID,
        display_name: "Fleet-visible connector",
        protocol_version: "0.1.0",
        streams: [],
        version: "1.0.0",
      }),
      now
    );
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(
      "pg_lexical_backfill_fleet_health",
      JSON.stringify({
        connector_id: "pg_lexical_backfill_fleet_health",
        display_name: "Internal backfill",
        protocol_version: "0.1.0",
        streams: [],
        version: "1.0.0",
      }),
      now
    );
  const fixtureConnections: ReadonlyArray<readonly [string, string, string]> = [
    [CUSTOM_OWNER_CONNECTION_ID, CUSTOM_OWNER_SUBJECT_ID, VISIBLE_CONNECTOR_ID],
    [OWNER_LOCAL_CONNECTION_ID, "owner_local", VISIBLE_CONNECTOR_ID],
    [INTERNAL_CONNECTION_ID, CUSTOM_OWNER_SUBJECT_ID, "pg_lexical_backfill_fleet_health"],
  ];
  for (const [connectorInstanceId, ownerSubjectId, connectorId] of fixtureConnections) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await store.upsert({
      connectorId,
      connectorInstanceId,
      createdAt: now,
      displayName: connectorInstanceId,
      ownerSubjectId,
      sourceBinding: { kind: "test" },
      sourceBindingKey: connectorInstanceId,
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    });
  }

  const app = buildAsApp({
    ownerAuthPassword: "",
    ownerAuthSubjectId: CUSTOM_OWNER_SUBJECT_ID,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
  await app.fastify.ready();
  try {
    const response = await app.fastify.inject({ method: "GET", url: "/_ref/fleet-health" });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as FleetHealthVerdict;
    assert.equal(body.scope.configured, 1);
    assert.deepEqual(
      body.scope.assessed.map((entry) => entry.connection_id),
      [CUSTOM_OWNER_CONNECTION_ID]
    );
    assert.deepEqual(body.scope.unassessed, []);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(`${OWNER_LOCAL_CONNECTION_ID}|${INTERNAL_CONNECTION_ID}`));
  } finally {
    await app.fastify.close();
    closeDb();
  }
});

test("fleet-summary projection reuses its owner-visible inventory without a second identity traversal", async () => {
  initDb(":memory:");
  const store = createSqliteConnectorInstanceStore();
  const now = "2026-07-30T00:00:00.000Z";
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(
      VISIBLE_CONNECTOR_ID,
      JSON.stringify({
        capabilities: { public_listing: { listed: true, status: "test" } },
        connector_id: VISIBLE_CONNECTOR_ID,
        display_name: "Fleet-visible connector",
        protocol_version: "0.1.0",
        streams: [],
        version: "1.0.0",
      }),
      now
    );
  await store.upsert({
    connectorId: VISIBLE_CONNECTOR_ID,
    connectorInstanceId: CUSTOM_OWNER_CONNECTION_ID,
    createdAt: now,
    displayName: "visible source",
    ownerSubjectId: CUSTOM_OWNER_SUBJECT_ID,
    sourceBinding: { kind: "test" },
    sourceBindingKey: CUSTOM_OWNER_CONNECTION_ID,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  try {
    const inventory = await listOwnerVisibleConnectorInstances(CUSTOM_OWNER_SUBJECT_ID);
    invalidateConnectorSummariesCache();
    const duplicateTraversal = await listConnectorSummaries(null, {
      includeRunSummaries: "singleton-active",
      ownerSubjectId: CUSTOM_OWNER_SUBJECT_ID,
    });
    const reusedInventory = await listConnectorSummaries(null, {
      includeRunSummaries: "singleton-active",
      ownerSubjectId: CUSTOM_OWNER_SUBJECT_ID,
      visibleConnections: inventory,
    });
    const emptySnapshot = await listConnectorSummaries(null, {
      includeRunSummaries: "singleton-active",
      ownerSubjectId: CUSTOM_OWNER_SUBJECT_ID,
      visibleConnections: [],
    });

    assert.deepEqual(
      withoutObservedAt(reusedInventory),
      withoutObservedAt(duplicateTraversal),
      "reusing the snapshot preserves fleet summaries apart from request-time observation timestamps"
    );
    assert.deepEqual(emptySnapshot, [], "a supplied empty inventory must not re-query the owner identity page");
  } finally {
    closeDb();
  }
});
