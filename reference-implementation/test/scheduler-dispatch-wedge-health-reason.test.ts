// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Health read-model oracle for the dispatch-liveness wedge record
// (`dispatchWedgedRecord`, runtime/scheduler.ts): a wedged pre-run gate must
// surface through the product connector-summary read model as the TYPED
// `scheduler_dispatch_wedged` token, never as the prose `error` sentence.
//
// The read model composes `failureReason ?? error` into the run's
// `failure_reason` (`productRunHistoryToConnectorRunSummary`, ref-control.ts),
// which `projectConnectorSummaryConnectionHealth` then surfaces as the health
// snapshot's `reason_code` when the connection degrades. Before the fix the
// wedged record carried only `terminalReason` plus a prose `error`, so both
// `last_run.failure_reason` and the health `reason_code` were the sentence
// "scheduler_dispatch_wedged: pre-launch dispatch gate did not settle within
// its liveness ceiling" -- the discriminating assertions below fail on that
// shape.
//
// Each connection is primed with one PRIOR genuine successful run through the
// real spine writer plus a rebuild/reconcile of `connector_summary_evidence`,
// matching the production shape where a wedge strikes an established
// connection whose projection evidence is current -- without that,
// `ProjectionReliable` fails closed and the headline `reason_code` is null
// regardless of the run's reason, which would mask the prose-vs-token
// distinction this oracle exists to pin.
//
// COUNTERWEIGHT: an ordinary failed run with no typed `failureReason` must
// STILL fall back to its prose `error` -- the fix adds a typed token to the
// wedge record, it does not suppress the read model's prose fallback, which
// is the only signal an ordinary unclassified failure has.
//
// Runs the wedge end to end (a real `createScheduler` with a hung readiness
// gate persisting through the real scheduler store) on BOTH SQLite and a
// dedicated disposable PostgreSQL database, so the typed token is proven
// through each backend's own write + product-reader round trip.

import assert from "node:assert/strict";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { createScheduler, type Scheduler } from "../runtime/scheduler.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { rebuildConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { getConnectorSummaryForRoute } from "../server/ref-control.ts";
import { getDefaultSchedulerStore } from "../server/stores/scheduler-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

let tempDbCounter = 0;
function tempDbName(label: string): string {
  tempDbCounter += 1;
  return `pdpp_test_wedge_health_${label}_${process.pid}_${tempDbCounter}`;
}

const WEDGED_TOKEN = "scheduler_dispatch_wedged";
const ORDINARY_FAILURE_PROSE = "connector exploded mid-flight with an unclassified error";
// The prior success predates both failure shapes (the live wedge stamps the
// real clock; the counterweight row uses NOW below), so the failure is always
// the connection's newest run.
const PRIOR_SUCCESS_AT = "2026-08-10T00:00:00.000Z";
const NOW = "2026-08-11T00:00:00.000Z";

function connectorManifest(connectorId: string): Record<string, unknown> {
  return {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: connectorId,
    display_name: connectorId,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: "id",
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
    ],
    version: "1.0.0",
  };
}

function seedConnectionSqlite(connectorInstanceId: string, connectorId: string): void {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(connectorManifest(connectorId)), PRIOR_SUCCESS_AT);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(
      connectorInstanceId,
      "owner_local",
      connectorId,
      connectorId,
      connectorInstanceId,
      PRIOR_SUCCESS_AT,
      PRIOR_SUCCESS_AT
    );
}

async function seedConnectionPostgres(connectorInstanceId: string, connectorId: string): Promise<void> {
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    connectorId,
    JSON.stringify(connectorManifest(connectorId)),
    PRIOR_SUCCESS_AT,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, $3, 'active', 'account', $4, '{}'::jsonb, $5, $6, NULL)`,
    [connectorInstanceId, connectorId, connectorId, connectorInstanceId, PRIOR_SUCCESS_AT, PRIOR_SUCCESS_AT]
  );
}

/**
 * One prior genuine successful run through the real spine writer, then a full
 * evidence rebuild + reconcile so `connector_summary_evidence` is CURRENT for
 * this connection. Backend-agnostic: `emitSpineEvent`/rebuild/reconcile all
 * route through whichever storage backend is active.
 */
async function primeCurrentEvidence(connectorId: string, connectorInstanceId: string): Promise<void> {
  const runId = `run_prior_success_${connectorInstanceId}`;
  await emitSpineEvent({
    actor_id: connectorId,
    actor_type: "runtime",
    data: {
      boot_epoch: `boot-${connectorInstanceId}`,
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      seq: 1,
      source: { id: connectorId, kind: "connector" },
      trigger_kind: "manual",
    },
    event_id: `evt_${runId}_started`,
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    occurred_at: PRIOR_SUCCESS_AT,
    run_id: runId,
    status: "started",
  });
  await emitSpineEvent({
    actor_id: connectorId,
    actor_type: "runtime",
    data: {
      connection_id: connectorInstanceId,
      connector_instance_id: connectorInstanceId,
      records_emitted: 1,
      source: { id: connectorId, kind: "connector" },
    },
    event_id: `evt_${runId}_terminal`,
    event_type: "run.completed",
    object_id: runId,
    object_type: "run",
    occurred_at: PRIOR_SUCCESS_AT,
    run_id: runId,
    status: "succeeded",
  });
  await rebuildConnectorSummaryEvidence();
  await reconcileConnectorSummaryEvidence(null);
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // biome-ignore lint/performance/noAwaitInLoops: bounded poll loop matches this suite's sibling fixtures.
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

/**
 * A real scheduler wedged exactly like the dispatch-liveness deadline suite:
 * hung readiness gate, short ceiling, persisting through the REAL default
 * scheduler store so the wedge row lands in `run_history` on whichever
 * backend is active. Resolves once one wedged record has been observed,
 * with the scheduler already stopped.
 */
async function runOneWedgeThroughDefaultStore(connectorId: string, connectorInstanceId: string): Promise<void> {
  const completedRuns: RunRecord[] = [];
  let scheduler: Scheduler | null = null;
  try {
    scheduler = createScheduler({
      admitRunConnection: ({ connectorId: cid, connectorInstanceId: iid, ownerSubjectId }) =>
        Promise.resolve({
          connectorId: cid,
          connectorInstanceId: iid ?? cid,
          ownerSubjectId: ownerSubjectId ?? "owner_local",
        }),
      connectors: [
        {
          connectorId,
          connectorInstanceId,
          connectorPath: "/tmp/unreachable-connector-must-never-spawn.mjs",
          intervalMs: 25,
          manifest: { capabilities: { refresh_policy: { background_safe: true } } },
          maxRetries: 0,
          ownerSubjectId: "owner-wedge",
          ownerToken: "owner-token",
        },
      ],
      dispatchLivenessCeilingMs: 60,
      getState: async () => null,
      onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      onRunComplete: (record) => completedRuns.push(record),
      readinessChecker: () => new Promise(() => undefined), // hangs every tick
      rsUrl: "http://localhost.invalid",
      schedulerStore: getDefaultSchedulerStore(),
    });
    scheduler.start();
    await waitFor(() => completedRuns.some((r) => r.terminalReason === WEDGED_TOKEN), 3000);
  } finally {
    scheduler?.stop();
  }
}

interface RunHistoryReasonRow {
  readonly error: string | null;
  readonly failure_reason: string | null;
  readonly status: string;
  readonly terminal_reason: string | null;
}

function assertWedgedRowShape(row: RunHistoryReasonRow | undefined): void {
  assert.ok(row, "the wedged record must be persisted to run_history");
  assert.equal(row.status, "failed");
  assert.equal(row.failure_reason, WEDGED_TOKEN, "the durable row must carry the typed failure_reason token");
  assert.equal(row.terminal_reason, WEDGED_TOKEN, "the typed terminal_reason must be preserved unchanged");
  assert.ok(
    row.error?.startsWith(`${WEDGED_TOKEN}:`),
    "the operator-facing prose error must still be preserved alongside the typed token"
  );
}

async function assertWedgedSummaryShape(connectorInstanceId: string): Promise<void> {
  const summary = await getConnectorSummaryForRoute(connectorInstanceId);
  assert.ok(summary, "the route resolves the connection");
  assert.ok(summary.last_run, "the wedged run is the connection's latest run");
  assert.equal(summary.last_run.status, "failed");
  assert.equal(
    summary.last_run.failure_reason,
    WEDGED_TOKEN,
    "the read model must surface the TYPED token -- before the fix this was the prose error sentence"
  );
  assert.equal(summary.last_run.terminal_reason, WEDGED_TOKEN);
  assert.equal(
    summary.connection_health.reason_code,
    WEDGED_TOKEN,
    "health must classify the wedge by its typed reason code, not fall to prose"
  );
}

async function appendOrdinaryProseFailure(connectorId: string, connectorInstanceId: string): Promise<void> {
  await Promise.resolve(
    getDefaultSchedulerStore().appendRunHistory({
      attempt: 1,
      checkpointSummary: null,
      completedAt: NOW,
      connectorId,
      connectorInstanceId,
      error: ORDINARY_FAILURE_PROSE,
      knownGaps: [],
      recordsEmitted: 0,
      source: { id: connectorId, kind: "connector" },
      startedAt: NOW,
      status: "failed",
    })
  );
}

async function assertOrdinaryFailureSummaryShape(connectorInstanceId: string): Promise<void> {
  const summary = await getConnectorSummaryForRoute(connectorInstanceId);
  assert.ok(summary, "the route resolves the connection");
  assert.ok(summary.last_run, "the ordinary failure is the connection's latest run");
  assert.equal(summary.last_run.status, "failed");
  assert.equal(
    summary.last_run.failure_reason,
    ORDINARY_FAILURE_PROSE,
    "an ordinary failure with no typed failureReason must STILL fall back to its prose error -- the wedge fix must not suppress the read model's only signal for unclassified failures"
  );
  assert.equal(
    summary.connection_health.reason_code,
    ORDINARY_FAILURE_PROSE,
    "health keeps the prose fallback for an unclassified ordinary failure"
  );
}

test("SQLite: a dispatch wedge surfaces through the product health read model as the typed token, not prose", {
  timeout: 15_000,
}, async () => {
  initDb(makeTemporaryDbPath("pdpp-wedge-health-sqlite-"));
  try {
    const connectorId = "wedge_health_sqlite_connector";
    const connectorInstanceId = "cin_wedge_health_sqlite";
    seedConnectionSqlite(connectorInstanceId, connectorId);
    await primeCurrentEvidence(connectorId, connectorInstanceId);

    await runOneWedgeThroughDefaultStore(connectorId, connectorInstanceId);
    // recordAndNotify persists fire-and-forget; wait for the durable row.
    await waitFor(
      () =>
        getDb()
          .prepare("SELECT 1 FROM run_history WHERE connector_instance_id = ? AND status = 'failed'")
          .get(connectorInstanceId) !== undefined,
      3000
    );

    const row = getDb()
      .prepare(
        `SELECT status, failure_reason, terminal_reason, error FROM run_history
           WHERE connector_instance_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(connectorInstanceId) as RunHistoryReasonRow | undefined;
    assertWedgedRowShape(row);
    await assertWedgedSummaryShape(connectorInstanceId);
  } finally {
    closeDb();
  }
});

test("SQLite COUNTERWEIGHT: an ordinary prose-only failure still falls back to its error text", {
  timeout: 15_000,
}, async () => {
  initDb(makeTemporaryDbPath("pdpp-wedge-health-counter-sqlite-"));
  try {
    const connectorId = "wedge_counter_sqlite_connector";
    const connectorInstanceId = "cin_wedge_counter_sqlite";
    seedConnectionSqlite(connectorInstanceId, connectorId);
    await primeCurrentEvidence(connectorId, connectorInstanceId);

    await appendOrdinaryProseFailure(connectorId, connectorInstanceId);
    await assertOrdinaryFailureSummaryShape(connectorInstanceId);
  } finally {
    closeDb();
  }
});

test("PostgreSQL: a dispatch wedge surfaces through the product health read model as the typed token, not prose", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
  timeout: 30_000,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: tempDbName("wedge"),
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const connectorId = "wedge_health_pg_connector";
      const connectorInstanceId = "cin_wedge_health_pg";
      await seedConnectionPostgres(connectorInstanceId, connectorId);
      await primeCurrentEvidence(connectorId, connectorInstanceId);

      await runOneWedgeThroughDefaultStore(connectorId, connectorInstanceId);
      await waitFor(async () => {
        const check = await postgresQuery(
          "SELECT 1 FROM run_history WHERE connector_instance_id = $1 AND status = 'failed'",
          [connectorInstanceId]
        );
        return (check.rowCount ?? 0) > 0;
      }, 5000);

      const result = await postgresQuery<RunHistoryReasonRow>(
        `SELECT status, failure_reason, terminal_reason, error FROM run_history
           WHERE connector_instance_id = $1 ORDER BY id DESC LIMIT 1`,
        [connectorInstanceId]
      );
      assertWedgedRowShape(result.rows[0]);
      await assertWedgedSummaryShape(connectorInstanceId);
    }
  );
});

test("PostgreSQL COUNTERWEIGHT: an ordinary prose-only failure still falls back to its error text", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
  timeout: 30_000,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: tempDbName("counter"),
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const connectorId = "wedge_counter_pg_connector";
      const connectorInstanceId = "cin_wedge_counter_pg";
      await seedConnectionPostgres(connectorInstanceId, connectorId);
      await primeCurrentEvidence(connectorId, connectorInstanceId);

      await appendOrdinaryProseFailure(connectorId, connectorInstanceId);
      await assertOrdinaryFailureSummaryShape(connectorInstanceId);
    }
  );
});
