// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for adjudicate-orphaned-runs.ts — the one-shot backfill that writes
 * the missing terminal event for runs stranded under dead container ids.
 *
 * Pure units run everywhere. The DB integration suite is env-gated on
 * PDPP_TEST_POSTGRES_URL and asserts:
 *   - dry-run writes nothing and reports the full scope;
 *   - apply writes `run.abandoned` (never `run.failed`) and re-projects
 *     `run_history` off `running`;
 *   - the pre-image lands in a backup table, so the pass is reversible;
 *   - a run that already has ANY terminal event is never re-adjudicated;
 *   - a second apply is a no-op (idempotent on `caused_by_event_id`);
 *   - `records_emitted` is left untouched, so records validly ingested
 *     before the controller died stay committed.
 *
 * The last three are the ones that matter most: this tool writes to the
 * append-only spine of a live production database, so "runs twice safely"
 * and "never revises a committed yield down" are the load-bearing
 * properties, not the happy path.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import pg from "pg";
import {
  ABANDONED_AT_BOOT_REASON,
  adjudicateOrphans,
  BACKUP_TABLE_PREFIX,
  backupTableName,
  formatSummary,
  parseArgs,
  planOrphans,
  sanitizeIdentifierToken,
  summarizePlan,
  truncateId,
  validateArgs,
} from "../scripts/repair/adjudicate-orphaned-runs.ts";

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const REGEXP_LIMIT_POSITIVE = /--limit must be a positive integer/;
const REGEXP_UNSAFE_SCOPE = /unsafe scope/;
const REGEXP_DRY_RUN = /\[DRY RUN\]/;
const REGEXP_WOULD_WRITE = /would write run\.abandoned/;
const REGEXP_RERUN_APPLY = /re-run with --apply/;
const REGEXP_NOTHING = /nothing to adjudicate/;
const REGEXP_TRUNCATED = /^cin_0123\.\.\.0123$/;

// Pure units

test("parseArgs defaults to dry-run and collects repeatable --connector", () => {
  const args = parseArgs(["--connector=ynab", "--connector=slack", "--connector=ynab"]);
  assert.equal(args.apply, false, "dry-run is the default");
  assert.deepEqual(args.connectors, ["ynab", "slack"], "de-duplicated in first-seen order");
  assert.equal(args.limit, null);
});

test("parseArgs reads --apply and --limit", () => {
  const args = parseArgs(["--apply", "--limit=25"]);
  assert.equal(args.apply, true);
  assert.equal(args.limit, 25);
});

test("validateArgs rejects a non-positive --limit", () => {
  assert.match(String(validateArgs({ limit: 0 })), REGEXP_LIMIT_POSITIVE);
  assert.match(String(validateArgs({ limit: -3 })), REGEXP_LIMIT_POSITIVE);
  assert.equal(validateArgs({ limit: null }), null, "no limit is acceptable");
  assert.equal(validateArgs({ limit: 10 }), null);
});

test("sanitizeIdentifierToken rejects a token that cannot form an identifier", () => {
  assert.throws(() => sanitizeIdentifierToken("", "scope"), REGEXP_UNSAFE_SCOPE);
  assert.equal(sanitizeIdentifierToken("YNAB-2026", "scope"), "ynab_2026");
});

test("backupTableName stays within Postgres' 63-byte identifier limit", () => {
  const name = backupTableName({ scope: "x".repeat(90), stamp: "20260821120000" });
  assert.ok(name.length <= 63, `expected <= 63 bytes, got ${name.length}`);
  assert.ok(name.startsWith(BACKUP_TABLE_PREFIX));
});

test("summarizePlan groups by connector with a first/last date span", () => {
  const plan = summarizePlan([
    row({ actor_id: "ynab", event_id: "e1", occurred_at: "2026-06-04T00:00:00.000Z", run_id: "r1" }),
    row({ actor_id: "ynab", event_id: "e2", occurred_at: "2026-07-01T00:00:00.000Z", run_id: "r2" }),
    row({ actor_id: "slack", event_id: "e3", occurred_at: "2026-06-11T00:00:00.000Z", run_id: "r3" }),
  ]);
  assert.equal(plan.total, 3);
  assert.deepEqual(plan.byConnector[0], { connector: "ynab", count: 2, first: "2026-06-04", last: "2026-07-01" });
  assert.deepEqual(plan.byConnector[1], { connector: "slack", count: 1, first: "2026-06-11", last: "2026-06-11" });
});

test("formatSummary prints the scope and withholds the write in dry-run", () => {
  const out = formatSummary({
    adjudicated: 0,
    applied: false,
    backupTable: null,
    failed: false,
    plan: summarizePlan([
      row({ actor_id: "ynab", event_id: "e1", occurred_at: "2026-06-04T00:00:00.000Z", run_id: "r1" }),
    ]),
    reprojected: 0,
  });
  assert.match(out, REGEXP_DRY_RUN);
  assert.match(out, REGEXP_WOULD_WRITE);
  assert.match(out, REGEXP_RERUN_APPLY);
});

test("formatSummary reports a clean database as nothing to do", () => {
  const out = formatSummary({
    adjudicated: 0,
    applied: false,
    backupTable: null,
    failed: false,
    plan: summarizePlan([]),
    reprojected: 0,
  });
  assert.match(out, REGEXP_NOTHING);
});

test("truncateId elides a long identifier", () => {
  assert.equal(truncateId("short"), "short");
  assert.match(truncateId("cin_0123456789abcdef0123"), REGEXP_TRUNCATED);
});

function row(over: Partial<Parameters<typeof summarizePlan>[0][number]>) {
  return {
    actor_id: "ynab",
    connector_instance_id: "cin_test",
    event_id: "evt_x",
    occurred_at: "2026-06-01T00:00:00.000Z",
    original_boot_epoch: "epoch-old",
    original_controller_id: "container-dead",
    run_id: "run_x",
    scenario_id: "default",
    trace_id: "trc_x",
    ...over,
  };
}

// Database integration

const dbTest = POSTGRES_URL ? test : test.skip;

async function withSchema<T>(fn: (pool: pg.Pool, schema: string) => Promise<T>): Promise<T> {
  const schema = `aor_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const pool = new Pool({ connectionString: POSTGRES_URL });
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`SET search_path TO "${schema}"`);
    // Minimal shapes: only the columns this tool reads and writes.
    await pool.query(`
      CREATE TABLE "${schema}".spine_events (
        event_id TEXT PRIMARY KEY, event_seq BIGSERIAL, event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
        scenario_id TEXT NOT NULL, trace_id TEXT NOT NULL,
        actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
        object_type TEXT NOT NULL, object_id TEXT NOT NULL,
        status TEXT NOT NULL, run_id TEXT,
        connector_instance_id TEXT, data_json JSONB NOT NULL, version TEXT NOT NULL
      )`);
    await pool.query(
      `CREATE UNIQUE INDEX spine_run_abandoned_cause_unique
         ON "${schema}".spine_events ((data_json->>'caused_by_event_id'))
       WHERE event_type = 'run.abandoned'`
    );
    await pool.query(`
      CREATE TABLE "${schema}".run_history (
        run_id TEXT, connector_instance_id TEXT, status TEXT NOT NULL,
        completed_at TEXT, terminal_reason TEXT, records_emitted INTEGER
      )`);
    return await fn(pool, schema);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await pool.end();
  }
}

async function seedStarted(
  pool: pg.Pool,
  schema: string,
  { eventId, runId, actor = "ynab", cin = "cin_1" }: { actor?: string; cin?: string; eventId: string; runId: string }
) {
  await pool.query(
    `INSERT INTO "${schema}".spine_events
       (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
        actor_type, actor_id, object_type, object_id, status, run_id,
        connector_instance_id, data_json, version)
     VALUES ($1,'run.started','2026-06-04T00:00:00.000Z','2026-06-04T00:00:00.000Z','default','trc_1',
             'runtime',$2,'run',$3,'started',$3,$4,
             '{"boot_epoch":"epoch-dead","controller_id":"container-dead","seq":1}'::jsonb,'v1')`,
    [eventId, actor, runId, cin]
  );
  await pool.query(
    `INSERT INTO "${schema}".run_history (run_id, connector_instance_id, status, records_emitted)
     VALUES ($1, $2, 'running', 4321)`,
    [runId, cin]
  );
}

/** Record a `controller.booted` event, making `epoch` the newest epoch. */
async function seedBooted(pool: pg.Pool, schema: string, epoch: string) {
  await pool.query(
    `INSERT INTO "${schema}".spine_events
       (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
        actor_type, actor_id, object_type, object_id, status, data_json, version)
     VALUES ($1,'controller.booted','2026-08-21T00:00:00.000Z','2026-08-21T00:00:00.000Z','default','trc_boot',
             'runtime','controller','controller','controller','booted',
             jsonb_build_object('epoch', $2::text, 'controller_id', 'ctrl', 'seq', 1),'v1')`,
    [`evt_boot_${epoch}`, epoch]
  );
}

/** Seed a `run.started` owned by an explicit epoch. */
async function seedStartedForEpoch(
  pool: pg.Pool,
  schema: string,
  {
    eventId,
    runId,
    epoch,
    actor = "ynab",
    cin = "cin_live",
  }: { actor?: string; cin?: string; epoch: string; eventId: string; runId: string }
) {
  await pool.query(
    `INSERT INTO "${schema}".spine_events
       (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
        actor_type, actor_id, object_type, object_id, status, run_id,
        connector_instance_id, data_json, version)
     VALUES ($1,'run.started','2026-08-21T15:35:00.000Z','2026-08-21T15:35:00.000Z','default','trc_1',
             'runtime',$2,'run',$3,'started',$3,$4,
             jsonb_build_object('boot_epoch', $5::text, 'controller_id', 'ctrl', 'seq', 1),'v1')`,
    [eventId, actor, runId, cin, epoch]
  );
}

dbTest("a run belonging to the newest epoch is live work, not an orphan", async () => {
  await withSchema(async (pool, schema) => {
    await pool.query(`SET search_path TO "${schema}"`);
    // A dead incarnation's stranded run, then the live incarnation's boot,
    // then a run the live process started and is still executing.
    await seedStarted(pool, schema, { eventId: "evt_dead", runId: "run_dead" });
    await seedBooted(pool, schema, "epoch-live");
    await seedStartedForEpoch(pool, schema, { epoch: "epoch-live", eventId: "evt_live", runId: "run_live" });

    const rows = await planOrphans(pool, { connectors: [], limit: null });
    assert.deepEqual(
      rows.map((r) => r.run_id),
      ["run_dead"],
      "the live process's in-flight run must never be adjudicated as abandoned"
    );
  });
});

dbTest("dry-run reports the scope and writes nothing", async () => {
  await withSchema(async (pool, schema) => {
    await pool.query(`SET search_path TO "${schema}"`);
    await seedStarted(pool, schema, { eventId: "evt_1", runId: "run_1" });

    const rows = await planOrphans(pool, { connectors: [], limit: null });
    assert.equal(rows.length, 1);

    const result = await adjudicateOrphans({ apply: false, pool, rows, scope: "all", stamp: "20260821120000" });
    assert.equal(result.adjudicated, 0);

    const { rows: after } = await pool.query(
      `SELECT count(*)::int AS n FROM "${schema}".spine_events WHERE event_type = 'run.abandoned'`
    );
    assert.equal(after[0].n, 0, "dry-run must not write");
    const { rows: hist } = await pool.query(`SELECT status FROM "${schema}".run_history WHERE run_id = 'run_1'`);
    assert.equal(hist[0].status, "running", "dry-run must not re-project");
  });
});

dbTest("apply writes run.abandoned, never run.failed, and re-projects run_history", async () => {
  await withSchema(async (pool, schema) => {
    await pool.query(`SET search_path TO "${schema}"`);
    await seedStarted(pool, schema, { eventId: "evt_1", runId: "run_1" });

    const rows = await planOrphans(pool, { connectors: [], limit: null });
    const result = await adjudicateOrphans({ apply: true, pool, rows, scope: "all", stamp: "20260821120000" });
    assert.equal(result.failed, false, result.error ?? "");
    assert.equal(result.adjudicated, 1);
    assert.equal(result.reprojected, 1);

    const { rows: events } = await pool.query(
      `SELECT event_type, status, data_json FROM "${schema}".spine_events WHERE event_type <> 'run.started'`
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "run.abandoned");
    assert.equal(events[0].status, "abandoned");
    assert.equal(events[0].data_json.reason, ABANDONED_AT_BOOT_REASON);
    assert.equal(events[0].data_json.caused_by_event_id, "evt_1");
    assert.equal(events[0].data_json.original_controller_id, "container-dead");
    assert.equal(events[0].data_json.source, "repair_script");

    const { rows: failed } = await pool.query(
      `SELECT count(*)::int AS n FROM "${schema}".spine_events WHERE event_type = 'run.failed'`
    );
    assert.equal(failed[0].n, 0, "an interrupted run must never be recorded as a failure");

    const { rows: hist } = await pool.query(
      `SELECT status, terminal_reason, records_emitted FROM "${schema}".run_history WHERE run_id = 'run_1'`
    );
    assert.equal(hist[0].status, "abandoned");
    assert.equal(hist[0].terminal_reason, ABANDONED_AT_BOOT_REASON);
    assert.equal(hist[0].records_emitted, 4321, "records validly ingested before the death stay committed");
  });
});

dbTest("apply snapshots the pre-image so the pass is reversible", async () => {
  await withSchema(async (pool, schema) => {
    await pool.query(`SET search_path TO "${schema}"`);
    await seedStarted(pool, schema, { eventId: "evt_1", runId: "run_1" });
    const rows = await planOrphans(pool, { connectors: [], limit: null });
    const result = await adjudicateOrphans({ apply: true, pool, rows, scope: "all", stamp: "20260821120000" });

    const { rows: backup } = await pool.query(`SELECT event_id, run_id FROM "${schema}"."${result.backupTable}"`);
    assert.equal(backup.length, 1);
    assert.equal(backup[0].event_id, "evt_1");

    const { rows: histBackup } = await pool.query(`SELECT status FROM "${schema}"."${result.backupTable}_history"`);
    assert.equal(histBackup[0].status, "running", "the pre-image records the row as it was before repair");
  });
});

dbTest("a run that already has a terminal event is never re-adjudicated", async () => {
  await withSchema(async (pool, schema) => {
    await pool.query(`SET search_path TO "${schema}"`);
    await seedStarted(pool, schema, { eventId: "evt_1", runId: "run_1" });
    await pool.query(
      `INSERT INTO "${schema}".spine_events
         (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
          actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
       VALUES ('evt_done','run.completed','2026-06-04T01:00:00.000Z','2026-06-04T01:00:00.000Z',
               'default','trc_1','runtime','ynab','run','run_1','succeeded','run_1','{}'::jsonb,'v1')`
    );

    const rows = await planOrphans(pool, { connectors: [], limit: null });
    assert.equal(rows.length, 0, "a completed run is not an orphan");
  });
});

dbTest("a second apply is a no-op", async () => {
  await withSchema(async (pool, schema) => {
    await pool.query(`SET search_path TO "${schema}"`);
    await seedStarted(pool, schema, { eventId: "evt_1", runId: "run_1" });

    const first = await planOrphans(pool, { connectors: [], limit: null });
    await adjudicateOrphans({ apply: true, pool, rows: first, scope: "all", stamp: "20260821120000" });

    const second = await planOrphans(pool, { connectors: [], limit: null });
    assert.equal(second.length, 0, "the adjudicated run is no longer selected");

    const { rows: count } = await pool.query(
      `SELECT count(*)::int AS n FROM "${schema}".spine_events WHERE event_type = 'run.abandoned'`
    );
    assert.equal(count[0].n, 1, "exactly one run.abandoned per orphan, however many passes run");
  });
});

dbTest("--connector and --limit bound the scope", async () => {
  await withSchema(async (pool, schema) => {
    await pool.query(`SET search_path TO "${schema}"`);
    await seedStarted(pool, schema, { actor: "ynab", eventId: "evt_1", runId: "run_1" });
    await seedStarted(pool, schema, { actor: "slack", cin: "cin_2", eventId: "evt_2", runId: "run_2" });
    await seedStarted(pool, schema, { actor: "slack", cin: "cin_3", eventId: "evt_3", runId: "run_3" });

    assert.equal((await planOrphans(pool, { connectors: [], limit: null })).length, 3);
    assert.equal((await planOrphans(pool, { connectors: ["slack"], limit: null })).length, 2);
    assert.equal((await planOrphans(pool, { connectors: [], limit: 1 })).length, 1);
  });
});
