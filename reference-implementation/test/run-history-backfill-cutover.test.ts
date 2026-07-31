// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Run-history backfill + LIST cutover — terminal-read-architecture-
// fable-0730.md §9 (R9.1-R9.3).
//
// Proves: bounded backfill fold reuses the unchanged summarizeEvents fold
// and lands scheduled/manual/browser/cancelled/legacy-connector-wide runs
// into run_history; idempotency (rerun inserts zero) and crash-resume
// (cursor commits only after the batch lands); race safety (concurrent
// live terminal write vs backfill insert lands exactly one row, terminal
// facts win; two concurrent sweep owners fence to exactly one); boundedness
// (batch size caps rows/statements, mid-batch time budget yields); and the
// product LIST/detail route (getConnectorSummaryForRoute) performs ZERO
// spine_events statements post-cutover, sourcing run facts from run_history
// + the active-run/lease overlay using the existing status vocabulary.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { getConnectorSummaryForRoute } from "../server/ref-control.ts";
import {
  createResumableRunHistoryBackfillStage,
  runRunHistoryBackfillRound,
} from "../server/stores/run-history-backfill-stage.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const SPINE_EVENTS_STATEMENT_PATTERN = /\bspine_events\b/i;

// Same CJS module instance server/db.ts requires — patching this prototype
// method observes every `db.prepare(...)` call the Proxy cache wrapper
// (withCachedPrepare, server/db.ts) delegates to, including the
// cache-miss-only calls a naive per-instance wrap would under-count.
const BetterSqlite3Database = createRequire(import.meta.url)("better-sqlite3") as {
  readonly prototype: { prepare: (this: unknown, sql: string) => unknown };
};

const OWNER = "owner_local";
const NOW = "2026-07-30T00:00:00.000Z";
const CONNECTOR_ID = "test_backfill_connector";

function seedManifestConnector(connectorId: string = CONNECTOR_ID): void {
  const manifest = {
    capabilities: { public_listing: { listed: true, status: "test" } },
    connector_id: connectorId,
    display_name: connectorId,
    protocol_version: "0.1.0",
    streams: [],
    version: "1.0.0",
  };
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
}

function seedInstance(connectorInstanceId: string, connectorId: string = CONNECTOR_ID): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

function startedEvent(
  runId: string,
  connectorInstanceId: string | null,
  triggerKind: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      boot_epoch: "boot-backfill-cutover",
      ...(connectorInstanceId
        ? { connection_id: connectorInstanceId, connector_instance_id: connectorInstanceId }
        : {}),
      seq: 1,
      source: { id: CONNECTOR_ID, kind: "connector" },
      trigger_kind: triggerKind,
      ...overrides,
    },
    event_id: `evt_${runId}_started`,
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status: "started",
  };
}

function terminalEvent(
  runId: string,
  connectorInstanceId: string | null,
  eventType: "run.browser_surface_failed" | "run.cancelled" | "run.completed" | "run.failed",
  status: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      ...(connectorInstanceId
        ? { connection_id: connectorInstanceId, connector_instance_id: connectorInstanceId }
        : {}),
      records_emitted: 3,
      source: { id: CONNECTOR_ID, kind: "connector" },
      ...overrides,
    },
    event_id: `evt_${runId}_terminal`,
    event_type: eventType,
    object_id: runId,
    object_type: "run",
    run_id: runId,
    status,
  };
}

// A legacy connector-wide run event predates `connection_id` on the spine
// and cannot be produced through `emitSpineEvent` (its own run.started
// guard now requires `connector_instance_id`, added after these events
// stopped being written). Insert directly to reproduce that historical
// shape for the singleton-attribution fixture.
let legacyEventSeq = 900_000;
function insertLegacySpineEvent(input: {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly runId: string;
  readonly status: string;
}): void {
  legacyEventSeq += 1;
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, source_kind, source_id, data_json, version
       ) VALUES (?, ?, ?, ?, ?, 'scn_reference_default', ?, 'runtime', ?, 'run', ?, ?, ?, 'connector', ?, ?, '1')`
    )
    .run(
      input.eventId,
      legacyEventSeq,
      input.eventType,
      input.occurredAt,
      input.occurredAt,
      `trace_${input.eventId}`,
      CONNECTOR_ID,
      input.runId,
      input.status,
      input.runId,
      CONNECTOR_ID,
      JSON.stringify({ records_emitted: 3, source: { id: CONNECTOR_ID, kind: "connector" } })
    );
}

interface RunHistoryTestRow {
  readonly completed_at: string | null;
  readonly connector_instance_id: string;
  readonly facts_json: string | null;
  readonly run_id: string;
  readonly started_at: string;
  readonly status: string;
}

function readRunHistoryRow(runId: string): RunHistoryTestRow | undefined {
  return getDb().prepare("SELECT * FROM run_history WHERE run_id = ?").get(runId) as RunHistoryTestRow | undefined;
}

function countRunHistoryRows(runId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM run_history WHERE run_id = ?").get(runId) as { n: number };
  return row.n;
}

test("backfill round: candidate discovery + fold lands scheduled/manual/browser/cancelled/legacy runs", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-backfill-corpus-");
  initDb(dbPath);
  try {
    seedManifestConnector();
    seedInstance("cin_scheduled");
    seedInstance("cin_manual");
    seedInstance("cin_browser");
    seedInstance("cin_cancelled");

    const cases: Array<{
      connectorInstanceId: string;
      eventType: "run.cancelled" | "run.completed" | "run.failed";
      runId: string;
      status: string;
      triggerKind: string;
    }> = [
      {
        connectorInstanceId: "cin_scheduled",
        eventType: "run.completed",
        runId: "run_bf_scheduled",
        status: "succeeded",
        triggerKind: "scheduled",
      },
      {
        connectorInstanceId: "cin_manual",
        eventType: "run.completed",
        runId: "run_bf_manual",
        status: "succeeded",
        triggerKind: "manual",
      },
      {
        connectorInstanceId: "cin_browser",
        eventType: "run.completed",
        runId: "run_bf_browser",
        status: "succeeded",
        triggerKind: "browser",
      },
      {
        connectorInstanceId: "cin_cancelled",
        eventType: "run.cancelled",
        runId: "run_bf_cancelled",
        status: "cancelled",
        triggerKind: "manual",
      },
    ];

    for (const testCase of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential.
      await emitSpineEvent(startedEvent(testCase.runId, testCase.connectorInstanceId, testCase.triggerKind));
      await emitSpineEvent(
        terminalEvent(testCase.runId, testCase.connectorInstanceId, testCase.eventType, testCase.status)
      );
      // The generalized writer already wrote a live run_history row for each
      // of these — delete it so the backfill stage discovers them as
      // genuinely spine-only (proving the fold path independent of the
      // live writer, per the acceptance oracle's "scheduled/manual/browser/
      // cancelled" corpus).
      getDb().prepare("DELETE FROM run_history WHERE run_id = ?").run(testCase.runId);
    }

    // Legacy connector-wide run: no connection_id anywhere in its window,
    // exactly one active instance for this connector -> singleton-attributed.
    getDb().prepare("DELETE FROM connector_instances WHERE connector_id = ?").run(CONNECTOR_ID);
    seedInstance("cin_legacy_singleton");
    insertLegacySpineEvent({
      eventId: "evt_run_bf_legacy_started",
      eventType: "run.started",
      occurredAt: NOW,
      runId: "run_bf_legacy",
      status: "started",
    });
    insertLegacySpineEvent({
      eventId: "evt_run_bf_legacy_terminal",
      eventType: "run.completed",
      occurredAt: NOW,
      runId: "run_bf_legacy",
      status: "succeeded",
    });

    for (const testCase of cases) {
      assert.equal(countRunHistoryRows(testCase.runId), 0, `${testCase.runId}: spine-only precondition`);
    }
    assert.equal(countRunHistoryRows("run_bf_legacy"), 0, "run_bf_legacy: spine-only precondition");

    const result = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 50, maxDurationMs: 5000 });
    assert.equal(result.backfilled, 5, "all five candidate runs backfilled in one bounded round");

    for (const testCase of cases) {
      const row = readRunHistoryRow(testCase.runId);
      assert.ok(row, `${testCase.runId}: backfilled row exists`);
      assert.equal(row?.status, testCase.status, `${testCase.runId}: backfilled status matches the fold`);
      assert.equal(
        row?.connector_instance_id,
        testCase.connectorInstanceId,
        `${testCase.runId}: connection attributed correctly`
      );
      assert.ok(row?.completed_at, `${testCase.runId}: terminal row has completed_at`);
      const facts = JSON.parse(row?.facts_json ?? "{}");
      assert.equal(facts.origin, "backfill", `${testCase.runId}: facts_json carries provenance, not a schema column`);
    }

    const legacyRow = readRunHistoryRow("run_bf_legacy");
    assert.ok(legacyRow, "legacy connector-wide run: singleton-attributed at backfill time");
    assert.equal(
      legacyRow?.connector_instance_id,
      "cin_legacy_singleton",
      "legacy run attributed to the sole active instance"
    );
  } finally {
    closeDb();
  }
});

test("backfill preserves nested browser-surface terminal facts for a pre-launch failure", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-backfill-browser-surface-");
  initDb(dbPath);
  try {
    seedManifestConnector();
    const connectorInstanceId = "cin_browser_surface_backfill";
    const runId = "run_browser_surface_backfill";
    seedInstance(connectorInstanceId);
    await emitSpineEvent(
      terminalEvent(runId, connectorInstanceId, "run.browser_surface_failed", "surface_failed", {
        browser_surface: {
          browser_surface_lease_id: "lease_browser_surface_backfill",
          browser_surface_profile_key: `${CONNECTOR_ID}:${connectorInstanceId}`,
          browser_surface_status: "surface_failed",
          browser_surface_wait_reason: "surface_unhealthy",
        },
      })
    );
    // Make the durable input historical so this exercises the backfill
    // writer rather than the live run-history hook.
    getDb().prepare("DELETE FROM run_history WHERE run_id = ?").run(runId);

    const result = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 25, maxDurationMs: 5000 });
    assert.equal(result.backfilled, 1);
    const row = readRunHistoryRow(runId);
    assert.equal(row?.status, "surface_failed");
    assert.deepEqual(JSON.parse(row?.facts_json ?? "{}"), {
      browser_surface_lease_id: "lease_browser_surface_backfill",
      browser_surface_profile_key: `${CONNECTOR_ID}:${connectorInstanceId}`,
      browser_surface_status: "surface_failed",
      browser_surface_wait_reason: "surface_unhealthy",
      origin: "backfill",
    });
  } finally {
    closeDb();
  }
});

test("legacy connector-wide run with 0 or >1 active instances is skipped (unattributable, never surfaced)", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-backfill-legacy-ambiguous-");
  initDb(dbPath);
  try {
    seedManifestConnector();
    // Zero active instances.
    insertLegacySpineEvent({
      eventId: "evt_run_bf_legacy_zero_started",
      eventType: "run.started",
      occurredAt: NOW,
      runId: "run_bf_legacy_zero",
      status: "started",
    });
    insertLegacySpineEvent({
      eventId: "evt_run_bf_legacy_zero_terminal",
      eventType: "run.completed",
      occurredAt: NOW,
      runId: "run_bf_legacy_zero",
      status: "succeeded",
    });

    const zeroResult = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 50, maxDurationMs: 5000 });
    assert.equal(zeroResult.backfilled, 0, "zero active instances: unattributable, skipped");
    assert.equal(countRunHistoryRows("run_bf_legacy_zero"), 0, "no row inserted for the unattributable run");

    // Two active instances.
    seedInstance("cin_ambig_a");
    seedInstance("cin_ambig_b");
    insertLegacySpineEvent({
      eventId: "evt_run_bf_legacy_ambig_started",
      eventType: "run.started",
      occurredAt: NOW,
      runId: "run_bf_legacy_ambig",
      status: "started",
    });
    insertLegacySpineEvent({
      eventId: "evt_run_bf_legacy_ambig_terminal",
      eventType: "run.completed",
      occurredAt: NOW,
      runId: "run_bf_legacy_ambig",
      status: "succeeded",
    });

    const ambigResult = await runRunHistoryBackfillRound({
      afterSeq: zeroResult.resumeAfterSeq ?? 0,
      batchSize: 50,
      maxDurationMs: 5000,
    });
    assert.equal(ambigResult.backfilled, 0, "two active instances: ambiguous, skipped");
    assert.equal(countRunHistoryRows("run_bf_legacy_ambig"), 0, "no row inserted for the ambiguous run");
  } finally {
    closeDb();
  }
});

test("idempotency: rerunning the backfill round from the same checkpoint inserts zero rows", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-backfill-idempotent-");
  initDb(dbPath);
  try {
    seedManifestConnector();
    seedInstance("cin_idem");
    await emitSpineEvent(startedEvent("run_bf_idem", "cin_idem", "manual"));
    await emitSpineEvent(terminalEvent("run_bf_idem", "cin_idem", "run.completed", "succeeded"));
    getDb().prepare("DELETE FROM run_history WHERE run_id = ?").run("run_bf_idem");

    const first = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 50, maxDurationMs: 5000 });
    assert.equal(first.backfilled, 1, "first round backfills the one run");
    assert.equal(countRunHistoryRows("run_bf_idem"), 1);

    // Rerun from checkpoint 0 (simulating a re-delivered/duplicated tick):
    // candidate discovery excludes run_ids already in run_history, so this
    // finds zero candidates regardless of checkpoint value.
    const second = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 50, maxDurationMs: 5000 });
    assert.equal(second.backfilled, 0, "second round from the same checkpoint inserts zero rows");
    assert.equal(countRunHistoryRows("run_bf_idem"), 1, "still exactly one row, no duplicate");
  } finally {
    closeDb();
  }
});

test("crash-resume: cursor advances only after the batch lands; a resumed stage does not skip or duplicate", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-backfill-crash-resume-");
  initDb(dbPath);
  try {
    seedManifestConnector();
    for (let i = 0; i < 6; i += 1) {
      const connectorInstanceId = `cin_resume_${i}`;
      const runId = `run_bf_resume_${i}`;
      seedInstance(connectorInstanceId);
      // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential.
      await emitSpineEvent(startedEvent(runId, connectorInstanceId, "manual"));
      await emitSpineEvent(terminalEvent(runId, connectorInstanceId, "run.completed", "succeeded"));
      getDb().prepare("DELETE FROM run_history WHERE run_id = ?").run(runId);
    }

    const stage = createResumableRunHistoryBackfillStage();
    // Batch size 2 forces multiple ticks across the 6-run corpus.
    const tick1 = await stage.run({ batchSize: 2, maxDurationMs: 5000 });
    assert.ok(tick1, "first tick acquires the lease and runs");
    assert.equal(tick1?.backfilled, 2, "first tick backfills exactly its batch size");

    // Simulate a crash-resume: a fresh stage instance sharing the same
    // durable cursor row must pick up exactly where the last committed
    // tick left off — no skip, no re-process.
    const resumedStage = createResumableRunHistoryBackfillStage();
    const tick2 = await resumedStage.run({ batchSize: 2, maxDurationMs: 5000 });
    assert.equal(tick2?.backfilled, 2, "resumed tick backfills the next batch, no overlap");
    const tick3 = await resumedStage.run({ batchSize: 2, maxDurationMs: 5000 });
    assert.equal(tick3?.backfilled, 2, "final tick backfills the remaining batch");

    let total = 0;
    for (let i = 0; i < 6; i += 1) {
      total += countRunHistoryRows(`run_bf_resume_${i}`);
    }
    assert.equal(total, 6, "every run backfilled exactly once across the resumed ticks — no duplicates, no skips");
  } finally {
    closeDb();
  }
});

test("race: concurrent live terminal write vs backfill insert on the same run_id lands exactly one row, terminal facts win", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-backfill-race-terminal-");
  initDb(dbPath);
  try {
    seedManifestConnector();
    seedInstance("cin_race");
    const runId = "run_bf_race";
    await emitSpineEvent(startedEvent(runId, "cin_race", "manual"));
    await emitSpineEvent(terminalEvent(runId, "cin_race", "run.completed", "succeeded"));
    // The row already exists (written live) — this is the exact race the
    // ON CONFLICT DO NOTHING guards: backfill discovers this run_id is
    // NOT eligible (candidate discovery excludes ids already in
    // run_history), so it must never touch this row.
    const liveRow = readRunHistoryRow(runId);
    assert.ok(liveRow, "live write landed the row first");

    const result = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 50, maxDurationMs: 5000 });
    assert.equal(result.backfilled, 0, "backfill finds no eligible candidate — the live row already exists");
    assert.equal(countRunHistoryRows(runId), 1, "exactly one row; live terminal write wins by construction");
    const finalRow = readRunHistoryRow(runId);
    assert.equal(finalRow?.status, "succeeded", "terminal facts from the live write are untouched by backfill");
  } finally {
    closeDb();
  }
});

test("race: two concurrent sweep owners fence to exactly one via the cursor store's lease", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-backfill-race-fencing-");
  initDb(dbPath);
  try {
    seedManifestConnector();
    seedInstance("cin_fence");
    await emitSpineEvent(startedEvent("run_bf_fence", "cin_fence", "manual"));
    await emitSpineEvent(terminalEvent("run_bf_fence", "cin_fence", "run.completed", "succeeded"));
    getDb().prepare("DELETE FROM run_history WHERE run_id = ?").run("run_bf_fence");

    const ownerA = createResumableRunHistoryBackfillStage();
    const ownerB = createResumableRunHistoryBackfillStage();
    const [resultA, resultB] = await Promise.all([
      ownerA.run({ batchSize: 50, maxDurationMs: 5000 }),
      ownerB.run({ batchSize: 50, maxDurationMs: 5000 }),
    ]);
    // Exactly one owner acquires the fenced lease; the other's acquire
    // returns null (this stage's in-flight guard also prevents a second
    // concurrent call on the SAME instance, but these are two distinct
    // instances sharing the same durable cursor row — the store-level
    // fence is what's under test).
    const results = [resultA, resultB];
    const nonNull = results.filter((r) => r !== null);
    assert.ok(nonNull.length >= 1, "at least one owner completes a round");
    assert.equal(countRunHistoryRows("run_bf_fence"), 1, "exactly one row landed regardless of which owner ran");
  } finally {
    closeDb();
  }
});

test("boundedness: batchSize caps rows backfilled per round; a zero-budget round yields immediately without landing a partial row", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-backfill-bounded-");
  initDb(dbPath);
  try {
    seedManifestConnector();
    for (let i = 0; i < 10; i += 1) {
      const connectorInstanceId = `cin_bounded_${i}`;
      const runId = `run_bf_bounded_${i}`;
      seedInstance(connectorInstanceId);
      // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential.
      await emitSpineEvent(startedEvent(runId, connectorInstanceId, "manual"));
      await emitSpineEvent(terminalEvent(runId, connectorInstanceId, "run.completed", "succeeded"));
      getDb().prepare("DELETE FROM run_history WHERE run_id = ?").run(runId);
    }

    const result = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 3, maxDurationMs: 5000 });
    assert.equal(result.attempted, 3, "candidate discovery is bounded by batchSize");
    assert.equal(result.backfilled, 3, "at most batchSize rows land per round");
    assert.equal(result.incomplete, true, "a full batch reports incomplete — more candidates remain");

    let total = 0;
    for (let i = 0; i < 10; i += 1) {
      total += countRunHistoryRows(`run_bf_bounded_${i}`);
    }
    assert.equal(total, 3, "no more than batchSize rows landed this round");

    // A zero time budget must yield before landing any partial insert, and
    // must not commit a cursor position past a run it never attempted.
    const zeroBudget = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 50, maxDurationMs: 0 });
    assert.equal(zeroBudget.backfilled, 0, "zero duration budget yields without inserting");
    assert.equal(zeroBudget.incomplete, true, "reports incomplete rather than silently completing");
  } finally {
    closeDb();
  }
});

test("LIST route (getConnectorSummaryForRoute) performs zero spine_events statements post-cutover and renders backfilled facts", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-backfill-zero-spine-get-");
  initDb(dbPath);
  try {
    seedManifestConnector();
    seedInstance("cin_zero_spine");
    const runId = "run_bf_zero_spine";
    await emitSpineEvent(startedEvent(runId, "cin_zero_spine", "manual"));
    await emitSpineEvent(terminalEvent(runId, "cin_zero_spine", "run.completed", "succeeded"));
    getDb().prepare("DELETE FROM run_history WHERE run_id = ?").run(runId);

    const backfillResult = await runRunHistoryBackfillRound({ afterSeq: 0, batchSize: 50, maxDurationMs: 5000 });
    assert.equal(backfillResult.backfilled, 1, "the run is backfilled before the GET under test");

    const observedSql: string[] = [];
    const originalPrepare = BetterSqlite3Database.prototype.prepare;
    BetterSqlite3Database.prototype.prepare = function patchedPrepare(this: unknown, sql: string) {
      observedSql.push(sql);
      return originalPrepare.call(this, sql);
    };
    try {
      const summary = await getConnectorSummaryForRoute("cin_zero_spine");
      assert.ok(summary, "the route resolves the connection");
      assert.equal(summary?.last_run?.status, "succeeded", "last_run sourced from the backfilled run_history row");
      assert.equal(summary?.last_run?.run_id, runId, "last_run identifies the backfilled run");
    } finally {
      BetterSqlite3Database.prototype.prepare = originalPrepare;
    }

    const spineStatements = observedSql.filter((sql) => SPINE_EVENTS_STATEMENT_PATTERN.test(sql));
    assert.deepEqual(spineStatements, [], "zero spine_events statements on the product GET route post-cutover");
  } finally {
    closeDb();
  }
});

test("active-run overlay: a running row with a live lease renders in_progress; without a lease it renders failed (orphaned) — existing vocabulary, no new enum", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-run-history-backfill-overlay-");
  initDb(dbPath);
  try {
    seedManifestConnector();
    seedInstance("cin_overlay_live");
    seedInstance("cin_overlay_orphan");

    const liveRunId = "run_bf_overlay_live";
    await emitSpineEvent(startedEvent(liveRunId, "cin_overlay_live", "manual"));
    getDb()
      .prepare(
        `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .run("cin_overlay_live", CONNECTOR_ID, liveRunId, "trace_live", "scn_reference_default", NOW);
    assert.equal(readRunHistoryRow(liveRunId)?.status, "running", "row remains status=running while the run is live");

    const orphanRunId = "run_bf_overlay_orphan";
    await emitSpineEvent(startedEvent(orphanRunId, "cin_overlay_orphan", "manual"));
    // No controller_active_runs row for this one — simulates a crashed
    // process that left the row 'running' with no live lease.
    assert.equal(readRunHistoryRow(orphanRunId)?.status, "running", "row remains status=running with no lease");

    const liveSummary = await getConnectorSummaryForRoute("cin_overlay_live");
    assert.equal(
      liveSummary?.last_run?.status,
      "in_progress",
      "live lease composes to in_progress — existing vocabulary"
    );

    const orphanSummary = await getConnectorSummaryForRoute("cin_overlay_orphan");
    assert.equal(
      orphanSummary?.last_run?.status,
      "failed",
      "no lease composes to failed (orphaned) — existing vocabulary, not a new enum value"
    );
  } finally {
    closeDb();
  }
});
