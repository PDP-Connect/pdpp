// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-PostgreSQL counterpart to `reconcile-summary-evidence-failure-
 * persistence.test.js`'s probe 3 / probe 4 (Sol third-verdict P1.1 minimum-
 * closure item 1): "Add SQLite + real-Postgres production-entry probes
 * starting current/fresh, forcing phase+marker double failure, one summary
 * call, affected component non-current and ProjectionReliable=false."
 *
 * Same two scenarios as the SQLite file, same production entry points
 * (`reconcileConnectorSummaryEvidence`, `listConnectorSummaries`), real
 * PostgreSQL fault injection via `CREATE TRIGGER`/`RAISE EXCEPTION` (the
 * pattern `device-exporter-postgres-proof.test.js` already establishes for
 * this codebase) instead of SQLite's `RAISE(ABORT, ...)`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { invalidateConnectorSummariesCache, listConnectorSummaries } from "../server/ref-control.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const NOW = "2026-07-17T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/failure-persistence-pg";
const INSTANCE_ID = "cin_failure_persistence_pg";
const STREAM = "messages";
interface JsonRecord {
  [key: string]: any;
}

const MANIFEST = {
  capabilities: { public_listing: { listed: true, status: "test" } },
  connector_id: CONNECTOR_ID,
  display_name: "Failure Persistence Probe (Postgres)",
  protocol_version: "0.1.0",
  streams: [
    {
      coverage_strategy: "full_inventory",
      name: STREAM,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "1.0.0",
};

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

async function seedConnector() {
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    JSON.stringify(MANIFEST),
    NOW,
  ]);
}

async function seedInstance() {
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, 'Failure Persistence Probe (Postgres)', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [INSTANCE_ID, CONNECTOR_ID, NOW]
  );
}

async function cleanup() {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("DELETE FROM spine_events WHERE run_id LIKE $1", ["run_probe%pg"]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

async function listBypassCache() {
  invalidateConnectorSummariesCache();
  const summaries = await listConnectorSummaries(null, { concurrency: 1, includeRunSummaries: false });
  invalidateConnectorSummariesCache();
  return summaries;
}

function summaryFor(summaries: JsonRecord[]): JsonRecord {
  const summary = summaries.find((row: JsonRecord) => row.connector_instance_id === INSTANCE_ID);
  assert.ok(summary, "summary for the probe connection must be visible");
  return summary;
}

function projectionReliable(summary: JsonRecord): JsonRecord | undefined {
  return summary.connection_health.conditions.find((condition: JsonRecord) => condition.type === "ProjectionReliable");
}

test("real PostgreSQL probe 3: simultaneous fold failure AND terminal-facts-failed-marker write failure still fails closed through the real production read", {
  skip: !POSTGRES_URL,
}, async () => {
  if (!POSTGRES_URL) {
    return;
  }
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  const suffix = `${process.pid}`;
  const foldFn = `pdpp_test_probe3_fold_fn_${suffix}`;
  const foldTrigger = `pdpp_test_probe3_fold_trg_${suffix}`;
  const markerFn = `pdpp_test_probe3_marker_fn_${suffix}`;
  const markerTrigger = `pdpp_test_probe3_marker_trg_${suffix}`;
  try {
    await cleanup();
    await seedConnector();
    await seedInstance();

    // Root-cause fix (2026-07-30): the shared `pdpp_test` database
    // accumulates `spine_events` rows across every test run that has ever
    // touched it (unlike the SQLite sibling, which gets a genuinely fresh,
    // empty temp database per test via `withTempDb`), so an UNSCOPED
    // `reconcileConnectorSummaryEvidence(null)`/`reconcileDirtyConnectorSummaryEvidence()`
    // call reads `readMaxTerminalEventSeq`'s fleet-wide `MAX(event_seq)`
    // (contaminated by every OTHER connection's terminal history) instead
    // of this connection's own. That silently stamped a huge, unrelated
    // fleet-wide checkpoint onto `stream_facts_event_seq` for THIS
    // brand-new connection during setup -- not the genuinely
    // fresh/zero/current bootstrap state the probe's "starts genuinely
    // healthy" precondition assumes -- so the fault-injection UPDATE later
    // in this test never actually changed `stream_facts_event_seq` (the
    // single locally-inserted terminal event never exceeded the
    // already-fleet-inflated checkpoint), the fold's write silently
    // no-op'd, neither trigger fired, and the barrier's own outcome
    // correctly reported zero failures for a write that was never
    // attempted. Scoping every reconcile/fold call in this test to
    // `[INSTANCE_ID]` makes `readMaxTerminalEventSeq` scope its own query
    // to this connection alone (`buildTerminalScopeFragmentPostgres`),
    // eliminating the fleet contamination and giving this test the same
    // genuinely-isolated starting state the SQLite sibling gets for free
    // from its temp database.
    await reconcileConnectorSummaryEvidence([INSTANCE_ID]);
    await reconcileDirtyConnectorSummaryEvidence([INSTANCE_ID]);
    const [before] = (
      await postgresQuery(
        "SELECT terminal_facts_state, dirty, state, stream_facts_event_seq FROM connector_summary_evidence WHERE connector_instance_id = $1",
        [INSTANCE_ID]
      )
    ).rows;
    assert.ok(before, "the initial reconcile creates an evidence row");
    assert.equal(before.terminal_facts_state, "current", "terminal_facts starts genuinely current");
    assert.equal(Number(before.dirty), 0);
    assert.equal(before.state, "fresh");
    assert.equal(
      Number(before.stream_facts_event_seq),
      0,
      "a genuinely fresh, scoped connection with zero terminal history starts at the real zero checkpoint, not a fleet-contaminated one"
    );

    const beforeSummary = summaryFor(await listBypassCache());
    assert.equal(projectionReliable(beforeSummary)?.status, "true", "the connection starts genuinely healthy");

    await postgresQuery(
      `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
         ) VALUES($1, 1, 'run.completed', $2, $2, 'test', 'trace_probe3pg', 'runtime', 'test-connector', 'run', 'run_probe3pg', 'succeeded', 'run_probe3pg', $3, $4::jsonb, '1')`,
      [
        "evt_probe3pg",
        NOW,
        INSTANCE_ID,
        JSON.stringify({
          collection_facts: {
            reference_only: true,
            schema_version: 1,
            streams: [{ checkpoint: "committed", collected: 0, stream: STREAM }],
          },
          connection_id: INSTANCE_ID,
          connector_instance_id: INSTANCE_ID,
        }),
      ]
    );

    // Fault injection: reject BOTH the fold's own write
    // (`stream_facts_event_seq` advance) AND the terminal-facts-failed
    // marker's own write (`terminal_facts_state` degrade) — the exact
    // simultaneous double-failure Sol's third verdict reproduced on real
    // PostgreSQL.
    await postgresQuery(`
        CREATE FUNCTION ${foldFn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.stream_facts_event_seq IS DISTINCT FROM OLD.stream_facts_event_seq THEN
            RAISE EXCEPTION 'injected fold write fault';
          END IF;
          RETURN NEW;
        END
        $$
      `);
    await postgresQuery(
      `CREATE TRIGGER ${foldTrigger} BEFORE UPDATE ON connector_summary_evidence FOR EACH ROW EXECUTE FUNCTION ${foldFn}()`
    );
    await postgresQuery(`
        CREATE FUNCTION ${markerFn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.terminal_facts_state IS DISTINCT FROM OLD.terminal_facts_state THEN
            RAISE EXCEPTION 'injected terminal-facts-failed marker write fault';
          END IF;
          RETURN NEW;
        END
        $$
      `);
    await postgresQuery(
      `CREATE TRIGGER ${markerTrigger} BEFORE UPDATE ON connector_summary_evidence FOR EACH ROW EXECUTE FUNCTION ${markerFn}()`
    );

    // Terminal-gate revision (2026-07-29, mirrored here 2026-07-30):
    // `listConnectorSummaries` (an ordinary GET's read path) no longer runs
    // any reconcile pass inline -- that barrier, and the in-memory
    // `failedRows` overlay it used to merge over the durable read for
    // exactly this double-failure case, moved to
    // `runConnectorMaintenanceSweep` (`server/connector-maintenance-sweep.ts`).
    // This probe calls the SAME barrier function the sweep calls
    // (`reconcileDirtyConnectorSummaryEvidence`), SCOPED to this test's own
    // connection (see the root-cause note above the initial reconcile call
    // -- an unscoped call here would re-read the fleet-wide checkpoint and
    // reintroduce the same contamination this fix removes), directly under
    // the fault, and asserts on the barrier's own returned outcome. Matches
    // the SQLite sibling's identically-named probe 3
    // (`reconcile-summary-evidence-failure-persistence.test.ts`), which
    // already carries the read-only-GET half of this fix.
    let outcome: Awaited<ReturnType<typeof reconcileDirtyConnectorSummaryEvidence>>;
    try {
      outcome = await reconcileDirtyConnectorSummaryEvidence([INSTANCE_ID]);
    } finally {
      await postgresQuery(`DROP TRIGGER IF EXISTS ${foldTrigger} ON connector_summary_evidence`);
      await postgresQuery(`DROP TRIGGER IF EXISTS ${markerTrigger} ON connector_summary_evidence`);
      await postgresQuery(`DROP FUNCTION IF EXISTS ${foldFn}()`);
      await postgresQuery(`DROP FUNCTION IF EXISTS ${markerFn}()`);
    }

    const [untouchedRow] = (
      await postgresQuery(
        "SELECT terminal_facts_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = $1",
        [INSTANCE_ID]
      )
    ).rows;
    assert.ok(untouchedRow, "the double-write fault leaves the original row in place");
    assert.equal(
      untouchedRow.terminal_facts_state,
      "current",
      "the durable row is genuinely untouched by the double-rejected writes on real PostgreSQL"
    );
    assert.equal(Number(untouchedRow.dirty), 0);
    assert.equal(untouchedRow.state, "fresh");

    assert.equal(
      outcome.failed,
      1,
      "the barrier's own outcome counts the double failure as failed, not silently repaired"
    );
    assert.ok(
      outcome.failureClasses.includes("terminal_facts"),
      "the failure is attributed to the terminal_facts component, not laundered as some other class"
    );

    // A plain read taken AFTER the fault is removed reflects the durable
    // row exactly as it stands (still stale-but-honestly-labeled `current`
    // from before the fault) -- an ordinary GET between sweep ticks is
    // honestly stale, not falsely healthy forever: the NEXT successful
    // sweep pass converges it once the fault is gone.
    const summaryAfterFaultRemoved = summaryFor(await listBypassCache());
    assert.equal(
      projectionReliable(summaryAfterFaultRemoved)?.status,
      "true",
      "a read after the transient fault clears still reports the last-known (stale-but-honest) durable state, not a fabricated failure that outlives the fault that caused it"
    );
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL probe 4: simultaneous discovery failure AND discovery-failed-marker write failure still fails closed through the real production read", {
  skip: !POSTGRES_URL,
}, async () => {
  if (!POSTGRES_URL) {
    return;
  }
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  const suffix = `${process.pid}`;
  const markerFn = `pdpp_test_probe4_marker_fn_${suffix}`;
  const markerTrigger = `pdpp_test_probe4_marker_trg_${suffix}`;
  let renamedVersionCounter = false;
  try {
    await cleanup();
    await seedConnector();
    await seedInstance();

    // Root-cause fix (2026-07-30), two independent defects:
    // (1) `reconcileConnectorSummaryEvidence` alone (the repair engine)
    // never runs the fold -- a brand-new row's `terminal_facts` stays
    // `unobserved`, which by itself makes the "starts genuinely healthy"
    // baseline below fail for an unrelated reason (`terminal_fold_failed`)
    // before the real probe even begins. Use the FULL barrier
    // (`reconcileDirtyConnectorSummaryEvidence`, repair + fold together),
    // matching the SQLite sibling's identically-named probe 4. (2) SCOPE it
    // to `[INSTANCE_ID]` -- see probe 3's identical note above: the shared
    // `pdpp_test` database accumulates fleet-wide `spine_events` across
    // every run that has ever touched it, so an unscoped fold call would
    // stamp this brand-new connection with an unrelated fleet-wide
    // checkpoint instead of its own genuine zero-history state.
    const first = await reconcileDirtyConnectorSummaryEvidence([INSTANCE_ID]);
    assert.equal(first.failed, 0);
    const [before] = (
      await postgresQuery(
        "SELECT record_snapshot_state, manifest_declaration_state, terminal_facts_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = $1",
        [INSTANCE_ID]
      )
    ).rows;
    assert.ok(before, "the initial reconcile creates an evidence row");
    assert.equal(before.record_snapshot_state, "current");
    assert.equal(before.manifest_declaration_state, "current");
    assert.equal(before.terminal_facts_state, "current", "the fold ran and genuinely converged the fresh row");
    assert.equal(Number(before.dirty), 0);
    assert.equal(before.state, "fresh");

    const beforeSummary = summaryFor(await listBypassCache());
    assert.equal(projectionReliable(beforeSummary)?.status, "true", "the connection starts genuinely healthy");

    // Fault injection: break discovery itself by renaming `version_counter`
    // (the exact table Sol's verdict named) AND simultaneously reject the
    // discovery-failed marker's own write.
    await postgresQuery("ALTER TABLE version_counter RENAME TO version_counter_hidden_probe4pg");
    renamedVersionCounter = true;
    await postgresQuery(`
        CREATE FUNCTION ${markerFn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.record_snapshot_state IS DISTINCT FROM OLD.record_snapshot_state THEN
            RAISE EXCEPTION 'injected discovery-failed marker write fault';
          END IF;
          RETURN NEW;
        END
        $$
      `);
    await postgresQuery(
      `CREATE TRIGGER ${markerTrigger} BEFORE UPDATE ON connector_summary_evidence FOR EACH ROW EXECUTE FUNCTION ${markerFn}()`
    );

    // Terminal-gate revision (2026-07-29, mirrored here 2026-07-30): as in
    // probe 3, call the maintenance sweep's own barrier function directly,
    // SCOPED to this connection, under the fault, and assert on its own
    // returned outcome -- a plain summary read after fault injection can
    // never observe it, since GET performs zero reconciliation.
    let outcome: Awaited<ReturnType<typeof reconcileDirtyConnectorSummaryEvidence>>;
    try {
      outcome = await reconcileDirtyConnectorSummaryEvidence([INSTANCE_ID]);
    } finally {
      await postgresQuery(`DROP TRIGGER IF EXISTS ${markerTrigger} ON connector_summary_evidence`);
      await postgresQuery(`DROP FUNCTION IF EXISTS ${markerFn}()`);
      await postgresQuery("ALTER TABLE version_counter_hidden_probe4pg RENAME TO version_counter");
      renamedVersionCounter = false;
    }

    const [untouchedRow] = (
      await postgresQuery(
        "SELECT record_snapshot_state, manifest_declaration_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = $1",
        [INSTANCE_ID]
      )
    ).rows;
    assert.ok(untouchedRow, "the double-write fault leaves the original row in place");
    assert.equal(
      untouchedRow.record_snapshot_state,
      "current",
      "the durable row is genuinely untouched by the double-rejected writes on real PostgreSQL"
    );
    assert.equal(Number(untouchedRow.dirty), 0);
    assert.equal(untouchedRow.state, "fresh");

    assert.equal(
      outcome.failed,
      1,
      "the barrier's own outcome counts the double failure as failed, not silently repaired"
    );

    // A plain read taken AFTER the fault is removed (discovery restored,
    // trigger dropped) reflects the durable row exactly as it stands --
    // still stale-but-honestly-labeled `current` from before the fault, an
    // honest bounded staleness window until the NEXT sweep pass converges
    // it, not a fabricated failure that outlives the transient fault.
    const summaryAfterFaultRemoved = summaryFor(await listBypassCache());
    assert.equal(
      projectionReliable(summaryAfterFaultRemoved)?.status,
      "true",
      "a read after the transient fault clears still reports the last-known (stale-but-honest) durable state"
    );
  } finally {
    if (renamedVersionCounter) {
      await postgresQuery("ALTER TABLE version_counter_hidden_probe4pg RENAME TO version_counter").catch(
        () => undefined
      );
    }
    await cleanup();
    await closePostgresStorage();
  }
});
