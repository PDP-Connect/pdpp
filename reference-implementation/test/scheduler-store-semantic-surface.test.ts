// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the semantic surface of the production `SchedulerStore`.
 *
 * The store wraps SQLite tables that store `enabled` as a `0 | 1`
 * integer. The public surface MUST hide that representation: every
 * `ScheduleRecord` returned by `getSchedule` / `listSchedules` MUST
 * carry `enabled: boolean`. Any future regression that re-leaks the
 * SQLite-flavored `0 | 1` numeric through the public surface (e.g. by
 * skipping the row→record mapper) will fail this test.
 *
 * Method names are also pinned: a future change that renamed
 * `createSchedule` back to `insert` or split the registries into
 * `store.schedules.*` / `store.activeRuns.*` namespaces would fail
 * compilation, but the runtime checks below add a belt-and-braces
 * assertion in case a `// eslint-disable` or a casted type slipped past
 * review.
 *
 * Spec: openspec/changes/extract-low-risk-reference-stores/design.md
 *       (Decision 4: "Interfaces are semantic, not table-shaped").
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";
import { createSqliteSchedulerStore, type SchedulerStore } from "../server/stores/scheduler-store.ts";

const SEMANTIC_CONNECTOR = "https://test.pdpp.org/connectors/semantic-surface";

const SEMANTIC_MANIFEST = {
  connector_id: SEMANTIC_CONNECTOR,
  display_name: "Semantic Surface Connector",
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [
    {
      name: "stream_x",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

async function withFreshStore(fn: (store: SchedulerStore) => Promise<void> | void): Promise<void> {
  initDb();
  await registerConnector(SEMANTIC_MANIFEST);
  const store = createSqliteSchedulerStore();
  try {
    await fn(store);
  } finally {
    closeDb();
  }
}

function propertyAt(target: object, name: string): unknown {
  return (target as Record<string, unknown>)[name];
}

test("SchedulerStore exposes only semantic schedule lifecycle methods", () => {
  const store = createSqliteSchedulerStore();
  const expected = [
    "appendRunHistory",
    "createSchedule",
    "deleteSchedule",
    "getSchedule",
    "listSchedules",
    "setScheduleEnabled",
    "updateSchedule",
    "deleteActiveRun",
    "listActiveRuns",
    "getLatestRunHistoryForConnection",
    "listLastRunTimes",
    "listRunHistory",
    "upsertLastRunTime",
    "upsertActiveRun",
  ];
  for (const name of expected) {
    assert.equal(typeof propertyAt(store, name), "function", `expected ${name} on store`);
  }

  // No table-shaped or namespaced surfaces leak through.
  const forbidden = ["insert", "update", "delete", "schedules", "activeRuns", "getDb", "exec"];
  for (const name of forbidden) {
    assert.equal(
      propertyAt(store, name),
      undefined,
      `SchedulerStore must not expose '${name}' — interfaces are semantic, not table-shaped`
    );
  }
});

test("createSchedule + getSchedule round-trip surfaces enabled as a boolean (true)", async () => {
  await withFreshStore(async (store) => {
    const now = "2026-04-29T00:00:00.000Z";
    await store.createSchedule({
      connector_id: SEMANTIC_CONNECTOR,
      created_at: now,
      enabled: true,
      interval_seconds: 600,
      jitter_seconds: 30,
      updated_at: now,
    });

    const got = await store.getSchedule(SEMANTIC_CONNECTOR);
    assert.ok(got, "expected a schedule record");
    assert.equal(typeof got.enabled, "boolean", "enabled must round-trip as a boolean, not a 0|1 integer");
    assert.equal(got.enabled, true);
    assert.notEqual(got.enabled, 1, "enabled must not leak the SQLite 0|1 representation");
  });
});

test("createSchedule + getSchedule round-trip surfaces enabled as a boolean (false)", async () => {
  await withFreshStore(async (store) => {
    const now = "2026-04-29T00:00:00.000Z";
    await store.createSchedule({
      connector_id: SEMANTIC_CONNECTOR,
      created_at: now,
      enabled: false,
      interval_seconds: 600,
      jitter_seconds: 30,
      updated_at: now,
    });

    const got = await store.getSchedule(SEMANTIC_CONNECTOR);
    assert.ok(got, "expected a schedule record");
    assert.equal(typeof got.enabled, "boolean", "enabled must round-trip as a boolean, not a 0|1 integer");
    assert.equal(got.enabled, false);
    assert.notEqual(got.enabled, 0, "enabled must not leak the SQLite 0|1 representation");
  });
});

test("setScheduleEnabled toggles the boolean without leaking 0|1", async () => {
  await withFreshStore(async (store) => {
    const now = "2026-04-29T00:00:00.000Z";
    await store.createSchedule({
      connector_id: SEMANTIC_CONNECTOR,
      created_at: now,
      enabled: true,
      interval_seconds: 600,
      jitter_seconds: 0,
      updated_at: now,
    });

    await store.setScheduleEnabled(SEMANTIC_CONNECTOR, false, "2026-04-29T00:00:01.000Z");
    const paused = await store.getSchedule(SEMANTIC_CONNECTOR);
    assert.ok(paused, "expected a schedule record");
    assert.equal(typeof paused.enabled, "boolean");
    assert.equal(paused.enabled, false);

    await store.setScheduleEnabled(SEMANTIC_CONNECTOR, true, "2026-04-29T00:00:02.000Z");
    const resumed = await store.getSchedule(SEMANTIC_CONNECTOR);
    assert.ok(resumed, "expected a schedule record");
    assert.equal(typeof resumed.enabled, "boolean");
    assert.equal(resumed.enabled, true);
  });
});

test("scheduler run history and last-run time round-trip through semantic methods", async () => {
  await withFreshStore(async (store) => {
    const startedAt = "2026-04-29T01:00:00.000Z";
    const completedAt = "2026-04-29T01:00:01.000Z";
    await store.appendRunHistory({
      attempt: 1,
      checkpointSummary: { streams: 1 },
      completedAt,
      connectorError: null,
      connectorId: SEMANTIC_CONNECTOR,
      failureReason: null,
      knownGaps: [],
      recordsEmitted: 7,
      reportedRecordsEmitted: null,
      runId: "run_semantic_history",
      source: { id: SEMANTIC_CONNECTOR, kind: "connector" },
      startedAt,
      status: "succeeded",
      terminalReason: null,
      traceId: "trc_semantic_history",
    });
    await store.upsertLastRunTime(SEMANTIC_CONNECTOR, 1_776_000_001_000, completedAt);

    const history = await store.listRunHistory(10);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0], {
      attempt: 1,
      checkpointSummary: { streams: 1 },
      completedAt,
      connectorError: null,
      connectorId: SEMANTIC_CONNECTOR,
      connectorInstanceId: SEMANTIC_CONNECTOR,
      failureReason: null,
      knownGaps: [],
      recordsEmitted: 7,
      reportedRecordsEmitted: null,
      runId: "run_semantic_history",
      source: { id: SEMANTIC_CONNECTOR, kind: "connector" },
      startedAt,
      status: "succeeded",
      terminalReason: null,
      traceId: "trc_semantic_history",
    });
    assert.equal((await store.getLatestRunHistoryForConnection(SEMANTIC_CONNECTOR))?.runId, "run_semantic_history");
    assert.equal(
      (await store.getLatestRunHistoryForConnection(SEMANTIC_CONNECTOR, "succeeded"))?.runId,
      "run_semantic_history"
    );
    assert.equal(await store.getLatestRunHistoryForConnection(SEMANTIC_CONNECTOR, "failed"), null);

    assert.deepEqual(await store.listLastRunTimes(), [
      {
        connector_id: SEMANTIC_CONNECTOR,
        connector_instance_id: SEMANTIC_CONNECTOR,
        last_run_time_ms: 1_776_000_001_000,
        updated_at: completedAt,
      },
    ]);
  });
});

test("same connector instances keep separate schedules, active runs, and last-run times", async () => {
  await withFreshStore(async (store) => {
    const now = "2026-04-29T02:00:00.000Z";
    const work = "cin_semantic_work";
    const personal = "cin_semantic_personal";

    await store.createSchedule({
      connector_id: SEMANTIC_CONNECTOR,
      connector_instance_id: work,
      created_at: now,
      enabled: true,
      interval_seconds: 600,
      jitter_seconds: 10,
      updated_at: now,
    });
    await store.createSchedule({
      connector_id: SEMANTIC_CONNECTOR,
      connector_instance_id: personal,
      created_at: now,
      enabled: false,
      interval_seconds: 1800,
      jitter_seconds: 60,
      updated_at: now,
    });

    await store.upsertActiveRun({
      connector_id: SEMANTIC_CONNECTOR,
      connector_instance_id: work,
      run_generation: 1,
      run_id: "run_work",
      scenario_id: "scn_work",
      started_at: now,
      trace_id: "trc_work",
    });
    await store.upsertActiveRun({
      connector_id: SEMANTIC_CONNECTOR,
      connector_instance_id: personal,
      run_generation: 1,
      run_id: "run_personal",
      scenario_id: "scn_personal",
      started_at: now,
      trace_id: "trc_personal",
    });
    await store.upsertLastRunTime(work, 1_776_000_002_000, now, SEMANTIC_CONNECTOR);
    await store.upsertLastRunTime(personal, 1_776_000_003_000, now, SEMANTIC_CONNECTOR);

    assert.equal((await store.listSchedules()).length, 2);
    assert.deepEqual(
      (await store.listSchedules()).map((row) => [
        row.connector_instance_id,
        row.connector_id,
        row.interval_seconds,
        row.enabled,
      ]),
      [
        [personal, SEMANTIC_CONNECTOR, 1800, false],
        [work, SEMANTIC_CONNECTOR, 600, true],
      ]
    );
    assert.deepEqual(
      (await store.listActiveRuns()).map((row) => [row.connector_instance_id, row.connector_id, row.run_id]).sort(),
      [
        [personal, SEMANTIC_CONNECTOR, "run_personal"],
        [work, SEMANTIC_CONNECTOR, "run_work"],
      ]
    );
    assert.deepEqual(
      (await store.listLastRunTimes()).map((row) => [
        row.connector_instance_id,
        row.connector_id,
        row.last_run_time_ms,
      ]),
      [
        [personal, SEMANTIC_CONNECTOR, 1_776_000_003_000],
        [work, SEMANTIC_CONNECTOR, 1_776_000_002_000],
      ]
    );
  });
});

test("active-run upsert preserves the incumbent row on duplicate admission", async () => {
  await withFreshStore(async (store) => {
    const first = await store.upsertActiveRun({
      connector_id: SEMANTIC_CONNECTOR,
      connector_instance_id: SEMANTIC_CONNECTOR,
      run_generation: 1,
      run_id: "run_semantic_first",
      scenario_id: "scn_semantic_first",
      started_at: "2026-04-29T03:00:00.000Z",
      trace_id: "trc_semantic_first",
    });
    const second = await store.upsertActiveRun({
      connector_id: SEMANTIC_CONNECTOR,
      connector_instance_id: SEMANTIC_CONNECTOR,
      run_generation: 2,
      run_id: "run_semantic_second",
      scenario_id: "scn_semantic_second",
      started_at: "2026-04-29T03:01:00.000Z",
      trace_id: "trc_semantic_second",
    });

    assert.notEqual(first, false, "first active-run insert should succeed");
    assert.equal(second, false, "duplicate active-run admission should fail closed");
    assert.equal((await store.getActiveRun(SEMANTIC_CONNECTOR))?.run_id, "run_semantic_first");
    assert.deepEqual(
      (await store.listActiveRuns()).map((row) => [row.connector_instance_id, row.run_id]),
      [[SEMANTIC_CONNECTOR, "run_semantic_first"]]
    );
  });
});

test("scheduler storage migration backfills legacy rows to deterministic default account instance id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-scheduler-store-"));
  const dbPath = join(dir, "reference.sqlite");
  initDb(dbPath);
  await registerConnector(SEMANTIC_MANIFEST);
  const defaultAccountInstanceId = makeDefaultAccountConnectorInstanceId("owner_local", SEMANTIC_CONNECTOR);
  try {
    const db = getDb();
    db.exec(`
      DROP TABLE connector_schedules;
      CREATE TABLE connector_schedules (
        connector_id TEXT PRIMARY KEY,
        interval_seconds INTEGER NOT NULL,
        jitter_seconds INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      DROP TABLE controller_active_runs;
      CREATE TABLE controller_active_runs (
        connector_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        trace_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
      DROP TABLE scheduler_run_history;
      CREATE TABLE scheduler_run_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connector_id TEXT NOT NULL,
        source_json TEXT NOT NULL,
        status TEXT NOT NULL,
        records_emitted INTEGER NOT NULL DEFAULT 0,
        reported_records_emitted INTEGER,
        checkpoint_summary_json TEXT,
        known_gaps_json TEXT NOT NULL DEFAULT '[]',
        connector_error_json TEXT,
        run_id TEXT,
        trace_id TEXT,
        failure_reason TEXT,
        terminal_reason TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        error TEXT,
        attempt INTEGER NOT NULL
      );
      DROP TABLE scheduler_last_run_times;
      CREATE TABLE scheduler_last_run_times (
        connector_id TEXT PRIMARY KEY,
        last_run_time_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO connector_schedules(connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)"
    ).run(SEMANTIC_CONNECTOR, 900, 0, 1, "2026-04-29T03:00:00.000Z", "2026-04-29T03:00:00.000Z");
    db.prepare(
      "INSERT INTO controller_active_runs(connector_id, run_id, trace_id, scenario_id, started_at) VALUES(?, ?, ?, ?, ?)"
    ).run(SEMANTIC_CONNECTOR, "run_legacy", "trc_legacy", "scn_legacy", "2026-04-29T03:00:01.000Z");
    db.prepare("INSERT INTO scheduler_last_run_times(connector_id, last_run_time_ms, updated_at) VALUES(?, ?, ?)").run(
      SEMANTIC_CONNECTOR,
      1_776_000_004_000,
      "2026-04-29T03:00:02.000Z"
    );
    db.prepare(
      "INSERT INTO scheduler_run_history(connector_id, source_json, status, records_emitted, known_gaps_json, started_at, completed_at, attempt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(SEMANTIC_CONNECTOR, "{}", "succeeded", 1, "[]", "2026-04-29T03:00:01.000Z", "2026-04-29T03:00:02.000Z", 1);
    closeDb();

    initDb(dbPath);
    const store = createSqliteSchedulerStore();
    assert.equal((await store.getSchedule(defaultAccountInstanceId))?.connector_instance_id, defaultAccountInstanceId);
    assert.equal((await store.listActiveRuns())[0]?.connector_instance_id, defaultAccountInstanceId);
    assert.equal((await store.listLastRunTimes())[0]?.connector_instance_id, defaultAccountInstanceId);
    assert.equal((await store.listRunHistory(10))[0]?.connectorInstanceId, defaultAccountInstanceId);
    assert.equal(
      (await store.getLatestRunHistoryForConnection(defaultAccountInstanceId))?.connectorInstanceId,
      defaultAccountInstanceId
    );
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("listSchedules entries each surface enabled as a boolean", async () => {
  await withFreshStore(async (store) => {
    const now = "2026-04-29T00:00:00.000Z";
    await store.createSchedule({
      connector_id: SEMANTIC_CONNECTOR,
      created_at: now,
      enabled: false,
      interval_seconds: 600,
      jitter_seconds: 0,
      updated_at: now,
    });

    const list = await store.listSchedules();
    assert.equal(list.length, 1);
    for (const record of list) {
      assert.equal(typeof record.enabled, "boolean", "every listSchedules() entry must carry enabled as a boolean");
    }
  });
});
