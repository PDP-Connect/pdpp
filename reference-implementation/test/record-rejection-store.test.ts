// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
// biome-ignore lint/correctness/noUnresolvedImports: better-sqlite3 is a declared workspace runtime dependency resolved by pnpm/Node.
import Database from "better-sqlite3";
import { Pool } from "pg";
import { writeTransaction } from "../lib/db.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import {
  createRecordRejectionStore,
  DEFAULT_RECORD_REJECTION_OWNER_QUOTA_BYTES,
  deletePostgresRecordRejectionsForConnectionWithClient,
  deleteSqliteRecordRejectionsForConnectionWithinTransaction,
  insertOrReplaySqliteRecordRejection,
  RECORD_REJECTION_OWNER_QUOTA_ENV,
  RecordRejectionStoreError,
  recordRejectionOwnerQuotaBytes,
} from "../server/stores/record-rejection-store.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const execFileAsync = promisify(execFile);
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const SIMULATED_AUDIT_WRITE_FAILURE_RE = /simulated audit write failure/;

test("deployment quota configuration is explicit, byte-based, and fails closed when malformed", () => {
  assert.equal(recordRejectionOwnerQuotaBytes({}), DEFAULT_RECORD_REJECTION_OWNER_QUOTA_BYTES);
  assert.equal(recordRejectionOwnerQuotaBytes({ [RECORD_REJECTION_OWNER_QUOTA_ENV]: "0" }), 0);
  assert.equal(recordRejectionOwnerQuotaBytes({ [RECORD_REJECTION_OWNER_QUOTA_ENV]: "1048576" }), 1_048_576);
  for (const configured of ["-1", "1.5", "Infinity", "ten-megabytes"]) {
    assert.throws(
      () => recordRejectionOwnerQuotaBytes({ [RECORD_REJECTION_OWNER_QUOTA_ENV]: configured }),
      (error) => error instanceof RecordRejectionStoreError && error.code === "invalid_quota"
    );
  }
});

function now() {
  return new Date().toISOString();
}

function seedSqliteConnection({
  connectorId = "test_connector",
  connectorInstanceId = "cin_test",
  ownerSubjectId = "owner_a",
  runId = "run_1",
  status = "active",
} = {}) {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES(?, ?, ?)").run(
    connectorId,
    "{}",
    now()
  );
  db.prepare(
    `INSERT INTO connector_instances(
      connector_instance_id, owner_subject_id, connector_id, display_name, status,
      source_kind, source_binding_key, source_binding_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, 'account', ?, '{}', ?, ?)`
  ).run(connectorInstanceId, ownerSubjectId, connectorId, "Test", status, connectorInstanceId, now(), now());
  if (runId) {
    db.prepare(
      `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at)
       VALUES(?, ?, ?, ?, ?, ?)`
    ).run(connectorInstanceId, connectorId, runId, "trace_1", "scenario_1", now());
    db.prepare(
      `INSERT INTO run_history(
        run_id, connector_instance_id, connector_id, source_json, status, started_at
      ) VALUES(?, ?, ?, '{}', 'running', ?)`
    ).run(runId, connectorInstanceId, connectorId, now());
  }
}

async function seedPostgresConnection({
  connectorId = "test_connector",
  connectorInstanceId = "cin_test",
  ownerSubjectId = "owner_a",
  runId = "run_1",
  status = "active",
} = {}) {
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, '{}'::jsonb, $2)", [
    connectorId,
    now(),
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
      connector_instance_id, owner_subject_id, connector_id, display_name, status,
      source_kind, source_binding_key, source_binding_json, created_at, updated_at
    ) VALUES($1, $2, $3, 'Test', $4, 'account', $5, '{}'::jsonb, $6, $7)`,
    [connectorInstanceId, ownerSubjectId, connectorId, status, connectorInstanceId, now(), now()]
  );
  if (runId) {
    await postgresQuery(
      `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at)
       VALUES($1, $2, $3, 'trace_1', 'scenario_1', $4)`,
      [connectorInstanceId, connectorId, runId, now()]
    );
    await postgresQuery(
      `INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, started_at)
       VALUES($1, $2, $3, '{}'::jsonb, 'running', $4)`,
      [runId, connectorInstanceId, connectorId, now()]
    );
  }
}

function assertSqliteQuotaMatchesRows(ownerSubjectId: string) {
  const quota =
    getDb()
      .prepare("SELECT pending_payload_bytes FROM record_rejection_quota WHERE owner_subject_id = ?")
      .get<{ pending_payload_bytes: number }>(ownerSubjectId)?.pending_payload_bytes ?? 0;
  const rows =
    getDb()
      .prepare("SELECT COALESCE(SUM(payload_bytes), 0) AS bytes FROM record_rejections WHERE owner_subject_id = ?")
      .get<{ bytes: number }>(ownerSubjectId)?.bytes ?? 0;
  assert.equal(quota, rows);
}

async function insertFromSeparateSqliteProcess(
  dbPath: string,
  input: Parameters<typeof insertOrReplaySqliteRecordRejection>[0]
) {
  const dbModule = new URL("../server/db.ts", import.meta.url).href;
  const storeModule = new URL("../server/stores/record-rejection-store.ts", import.meta.url).href;
  const script = `
    import { closeDb, initDb } from ${JSON.stringify(dbModule)};
    import { insertOrReplaySqliteRecordRejection } from ${JSON.stringify(storeModule)};
    initDb(${JSON.stringify(dbPath)});
    try {
      const receipt = insertOrReplaySqliteRecordRejection(${JSON.stringify(input)});
      console.log(JSON.stringify({ ok: true, receiptId: receipt.receiptId }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error?.code ?? "unknown" }));
    } finally {
      closeDb();
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    script,
  ]);
  const resultLine = stdout.trim().split("\n").at(-1);
  assert.ok(resultLine);
  return JSON.parse(resultLine) as { code?: string; ok: boolean; receiptId?: string };
}

test.afterEach(() => {
  closeDb();
});

test("SQLite record rejection store replays exact inputs and keeps payload metadata bounded", async () => {
  initDb();
  seedSqliteConnection();
  const store = createRecordRejectionStore();
  const input = {
    connectorId: "test_connector",
    connectorInstanceId: "cin_test",
    inputIndex: 2,
    ownerSubjectId: "owner_a",
    rawLine: '{"id":null}',
    reasonCode: "invalid_record_identity",
    runId: "run_1",
    stream: "items",
  };
  const first = await store.insertOrReplay(input);
  const second = await store.insertOrReplay({ ...input, inputIndex: 5, reasonCode: "malformed_ndjson" });
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.replayed, true);
  assert.equal(second.code, "invalid_record_identity");

  const page = await store.list({ connectorInstanceId: "cin_test", limit: 10, ownerSubjectId: "owner_a" });
  assert.equal(page.items.length, 1);
  const [item] = page.items;
  assert.ok(item);
  assert.equal(item.payloadBytes, Buffer.byteLength(input.rawLine));
  assert.equal(item.latestInputIndex, 5);
  assert.equal("payloadText" in item, false);

  const detail = await store.getDetail({
    connectorInstanceId: "cin_test",
    ownerSubjectId: "owner_a",
    receiptId: first.receiptId,
  });
  assert.equal(detail?.payloadText, input.rawLine);
  assert.ok(detail);
  assert.match(detail.payloadSha256, SHA256_HEX_RE);

  const quota = getDb()
    .prepare("SELECT pending_payload_bytes FROM record_rejection_quota WHERE owner_subject_id = ?")
    .get<{ pending_payload_bytes: number }>("owner_a");
  assert.equal(quota?.pending_payload_bytes, Buffer.byteLength(input.rawLine));
  assertSqliteQuotaMatchesRows("owner_a");

  const auditEvents = getDb()
    .prepare(
      `SELECT actor_id, actor_type, data_json, event_type, object_id, object_type
         FROM spine_events
        WHERE event_type LIKE 'record_rejection.%'
        ORDER BY event_seq`
    )
    .all<{
      actor_id: string;
      actor_type: string;
      data_json: string;
      event_type: string;
      object_id: string;
      object_type: string;
    }>();
  assert.equal(auditEvents.length, 2);
  assert.deepEqual(
    auditEvents.map((event) => event.event_type),
    ["record_rejection.quarantined", "record_rejection.replayed"]
  );
  for (const event of auditEvents) {
    assert.equal(event.actor_id, "pdpp_reference");
    assert.equal(event.actor_type, "system");
    assert.equal(event.object_id, first.receiptId);
    assert.equal(event.object_type, "record_rejection");
    const data = JSON.parse(event.data_json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), [
      "connection_id",
      "created_at",
      "last_seen_at",
      "payload_bytes",
      "payload_sha256",
      "reason_code",
      "receipt_id",
      "stream",
    ]);
    assert.equal(data.receipt_id, first.receiptId);
    assert.equal(data.connection_id, "cin_test");
    assert.equal(data.stream, "items");
    assert.equal(data.reason_code, "invalid_record_identity");
    assert.equal(data.payload_bytes, Buffer.byteLength(input.rawLine));
    assert.equal(data.payload_sha256, detail.payloadSha256);
    assert.equal(JSON.stringify(data).includes(input.rawLine), false);
  }
});

test("SQLite record rejection receipt and audit fact roll back together", () => {
  initDb();
  seedSqliteConnection();
  getDb()
    .prepare(
      `CREATE TRIGGER reject_record_rejection_audit
       BEFORE INSERT ON spine_events
       WHEN NEW.event_type LIKE 'record_rejection.%'
       BEGIN
         SELECT RAISE(ABORT, 'simulated audit write failure');
       END`
    )
    .run();

  assert.throws(
    () =>
      insertOrReplaySqliteRecordRejection({
        connectorId: "test_connector",
        connectorInstanceId: "cin_test",
        inputIndex: 0,
        ownerSubjectId: "owner_a",
        rawLine: '{"id":null}',
        reasonCode: "invalid_record_identity",
        runId: "run_1",
        stream: "items",
      }),
    SIMULATED_AUDIT_WRITE_FAILURE_RE
  );
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM record_rejections").get<{ count: number }>()?.count, 0);
  assert.equal(
    getDb()
      .prepare("SELECT pending_payload_bytes FROM record_rejection_quota WHERE owner_subject_id = 'owner_a'")
      .get<{ pending_payload_bytes: number }>()?.pending_payload_bytes ?? 0,
    0
  );
  assert.equal(
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM spine_events WHERE event_type LIKE 'record_rejection.%'")
      .get<{ count: number }>()?.count,
    0
  );
});

test("SQLite record rejection store refuses quota exhaustion without acknowledging progress", () => {
  initDb();
  seedSqliteConnection();
  assert.throws(
    () =>
      insertOrReplaySqliteRecordRejection({
        connectorId: "test_connector",
        connectorInstanceId: "cin_test",
        inputIndex: 0,
        ownerSubjectId: "owner_a",
        quotaBytes: 1,
        rawLine: "too-large",
        reasonCode: "malformed_ndjson",
        runId: "run_1",
        stream: "items",
      }),
    (err) => err instanceof RecordRejectionStoreError && err.code === "record_rejection_quota_exceeded"
  );
  const count = getDb().prepare("SELECT COUNT(*) AS count FROM record_rejections").get<{ count: number }>();
  assert.equal(count?.count, 0);
  assertSqliteQuotaMatchesRows("owner_a");
});

test("SQLite record rejection store enforces the UTF-8 line-byte ceiling before persistence", () => {
  initDb();
  seedSqliteConnection();
  const boundary = insertOrReplaySqliteRecordRejection({
    connectorId: "test_connector",
    connectorInstanceId: "cin_test",
    inputIndex: 0,
    maxPayloadBytes: 4,
    ownerSubjectId: "owner_a",
    quotaBytes: 100,
    rawLine: "éé",
    reasonCode: "malformed_ndjson",
    runId: "run_1",
    stream: "items",
  });
  assert.equal(boundary.replayed, false);
  assert.throws(
    () =>
      insertOrReplaySqliteRecordRejection({
        connectorId: "test_connector",
        connectorInstanceId: "cin_test",
        inputIndex: 1,
        maxPayloadBytes: 4,
        ownerSubjectId: "owner_a",
        quotaBytes: 100,
        rawLine: "ééa",
        reasonCode: "malformed_ndjson",
        runId: "run_1",
        stream: "items",
      }),
    (error) => error instanceof RecordRejectionStoreError && error.code === "record_rejection_payload_too_large"
  );
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM record_rejections").get<{ count: number }>()?.count, 1);
  assertSqliteQuotaMatchesRows("owner_a");
  assert.equal(
    getDb()
      .prepare("SELECT pending_payload_bytes FROM record_rejection_quota WHERE owner_subject_id = 'owner_a'")
      .get<{ pending_payload_bytes: number }>()?.pending_payload_bytes,
    4
  );
});

test("SQLite record rejection store matches ingest lifecycle and exact run-history fences", () => {
  initDb();
  seedSqliteConnection({ connectorInstanceId: "cin_draft", runId: "run_draft", status: "draft" });
  seedSqliteConnection({ connectorInstanceId: "cin_paused", runId: "run_paused", status: "paused" });
  for (const [connectorInstanceId, runId] of [
    ["cin_draft", "run_draft"],
    ["cin_paused", "run_paused"],
  ] as const) {
    assert.doesNotThrow(() =>
      insertOrReplaySqliteRecordRejection({
        connectorId: "test_connector",
        connectorInstanceId,
        inputIndex: 0,
        ownerSubjectId: "owner_a",
        rawLine: `{"connection":"${connectorInstanceId}"}`,
        reasonCode: "invalid_record_identity",
        runId,
        stream: "items",
      })
    );
  }
  getDb().prepare("UPDATE run_history SET status = 'cancelled' WHERE run_id = 'run_draft'").run();
  assert.throws(
    () =>
      insertOrReplaySqliteRecordRejection({
        connectorId: "test_connector",
        connectorInstanceId: "cin_draft",
        inputIndex: 1,
        ownerSubjectId: "owner_a",
        rawLine: "terminal",
        reasonCode: "malformed_ndjson",
        runId: "run_draft",
        stream: "items",
      }),
    (err) => err instanceof RecordRejectionStoreError && err.code === "run_not_writable"
  );
});

test("SQLite record rejection store enforces owner isolation, run fence, restart persistence, and delete cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-record-rejections-"));
  const dbPath = join(dir, "store.sqlite");
  try {
    initDb(dbPath);
    seedSqliteConnection();
    seedSqliteConnection({ connectorInstanceId: "cin_other", ownerSubjectId: "owner_b", runId: "run_2" });
    const store = createRecordRejectionStore();
    const receipt = await store.insertOrReplay({
      connectorId: "test_connector",
      connectorInstanceId: "cin_test",
      inputIndex: 0,
      ownerSubjectId: "owner_a",
      rawLine: '{"bad":true}',
      reasonCode: "invalid_record_identity",
      runId: "run_1",
      stream: "items",
    });
    assert.equal(
      await store.getDetail({
        connectorInstanceId: "cin_test",
        ownerSubjectId: "owner_b",
        receiptId: receipt.receiptId,
      }),
      null
    );
    assert.rejects(
      store.insertOrReplay({
        connectorId: "test_connector",
        connectorInstanceId: "cin_test",
        inputIndex: 1,
        ownerSubjectId: "owner_a",
        rawLine: '{"bad":false}',
        reasonCode: "invalid_record_identity",
        runId: "missing_run",
        stream: "items",
      }),
      (err) => err instanceof RecordRejectionStoreError && err.code === "run_not_writable"
    );
    closeDb();
    initDb(dbPath);
    const restarted = createRecordRejectionStore();
    assert.equal(
      (
        await restarted.getDetail({
          connectorInstanceId: "cin_test",
          ownerSubjectId: "owner_a",
          receiptId: receipt.receiptId,
        })
      )?.payloadText,
      '{"bad":true}'
    );
    assert.equal(
      await restarted.deleteForConnection({ connectorInstanceId: "cin_test", ownerSubjectId: "owner_a" }),
      1
    );
    assert.equal(
      await restarted.getDetail({
        connectorInstanceId: "cin_test",
        ownerSubjectId: "owner_a",
        receiptId: receipt.receiptId,
      }),
      null
    );
    const quota = getDb()
      .prepare("SELECT pending_payload_bytes FROM record_rejection_quota WHERE owner_subject_id = ?")
      .get<{ pending_payload_bytes: number }>("owner_a");
    assert.equal(quota?.pending_payload_bytes, 0);
    assertSqliteQuotaMatchesRows("owner_a");
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SQLite transaction-aware delete hook rolls back quota and rows with its caller", async () => {
  initDb();
  seedSqliteConnection();
  const receipt = insertOrReplaySqliteRecordRejection({
    connectorId: "test_connector",
    connectorInstanceId: "cin_test",
    inputIndex: 0,
    ownerSubjectId: "owner_a",
    rawLine: "rollback-me",
    reasonCode: "malformed_ndjson",
    runId: "run_1",
    stream: "items",
  });
  assert.throws(() =>
    writeTransaction(() => {
      deleteSqliteRecordRejectionsForConnectionWithinTransaction({
        connectorInstanceId: "cin_test",
        ownerSubjectId: "owner_a",
      });
      throw new Error("injected caller failure");
    })
  );
  assert.equal(
    (
      await createRecordRejectionStore().getDetail({
        connectorInstanceId: "cin_test",
        ownerSubjectId: "owner_a",
        receiptId: receipt.receiptId,
      })
    )?.payloadText,
    "rollback-me"
  );
  assertSqliteQuotaMatchesRows("owner_a");
});

test("SQLite BEGIN IMMEDIATE keeps concurrent owner quota admission drift-free across processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-record-rejections-race-"));
  const dbPath = join(dir, "store.sqlite");
  try {
    initDb(dbPath);
    seedSqliteConnection();
    closeDb();
    const base = {
      connectorId: "test_connector",
      connectorInstanceId: "cin_test",
      inputIndex: 0,
      ownerSubjectId: "owner_a",
      quotaBytes: 4,
      reasonCode: "malformed_ndjson",
      runId: "run_1",
      stream: "items",
    };
    const outcomes = await Promise.all([
      insertFromSeparateSqliteProcess(dbPath, { ...base, rawLine: "aaaa" }),
      insertFromSeparateSqliteProcess(dbPath, { ...base, rawLine: "bbbb" }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    assert.deepEqual(
      outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.code),
      ["record_rejection_quota_exceeded"]
    );
    initDb(dbPath);
    assertSqliteQuotaMatchesRows("owner_a");
    assert.equal(
      getDb()
        .prepare("SELECT pending_payload_bytes FROM record_rejection_quota WHERE owner_subject_id = 'owner_a'")
        .get<{
          pending_payload_bytes: number;
        }>()?.pending_payload_bytes,
      4
    );
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SQLite record rejection migration upgrades legacy DBs and retains rollback tables without backfill", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-record-rejections-migration-"));
  const dbPath = join(dir, "legacy.sqlite");
  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE connectors(connector_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO connectors(connector_id, manifest, created_at) VALUES('test_connector', '{}', '${now()}');
      CREATE TABLE connector_instances(
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        source_kind TEXT NOT NULL,
        source_binding_key TEXT NOT NULL,
        source_binding_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );
      INSERT INTO connector_instances(
        connector_instance_id, owner_subject_id, connector_id, display_name, status,
        source_kind, source_binding_key, source_binding_json, created_at, updated_at
      ) VALUES('cin_test', 'owner_a', 'test_connector', 'Test', 'active', 'account', 'cin_test', '{}', '${now()}', '${now()}');
      CREATE TABLE record_rejections_rollback_sentinel(value TEXT);
      INSERT INTO record_rejections_rollback_sentinel(value) VALUES('keep');
    `);
    legacy.close();
    initDb(dbPath);
    closeDb();
    initDb(dbPath);
    const rejectionCount = getDb().prepare("SELECT COUNT(*) AS count FROM record_rejections").get<{ count: number }>();
    const sentinel = getDb().prepare("SELECT value FROM record_rejections_rollback_sentinel").get<{ value: string }>();
    assert.equal(rejectionCount?.count, 0);
    assert.equal(sentinel?.value, "keep");
    closeDb();
    initDb(dbPath);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM record_rejections").get<{ count: number }>()?.count, 0);
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Postgres record rejection store contract", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async () => {
  assert.ok(POSTGRES_URL);
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  const admin = new Pool({ connectionString: POSTGRES_URL });
  try {
    await admin.query(
      "TRUNCATE record_rejections, record_rejection_quota, controller_active_runs, run_history, connector_instances, connectors CASCADE"
    );
  } finally {
    await admin.end();
  }
  try {
    await seedPostgresConnection({ status: "draft" });
    const store = createRecordRejectionStore();
    const input = {
      connectorId: "test_connector",
      connectorInstanceId: "cin_test",
      inputIndex: 0,
      ownerSubjectId: "owner_a",
      quotaBytes: Buffer.byteLength('{"id":null}'),
      rawLine: '{"id":null}',
      reasonCode: "invalid_record_identity",
      runId: "run_1",
      stream: "items",
    };
    const [first, replay] = await Promise.all([
      store.insertOrReplay(input),
      store.insertOrReplay({ ...input, inputIndex: 1 }),
    ]);
    assert.equal(replay.receiptId, first.receiptId);
    const changedReasonReplay = await store.insertOrReplay({
      ...input,
      inputIndex: 2,
      reasonCode: "malformed_ndjson",
    });
    assert.equal(changedReasonReplay.receiptId, first.receiptId);
    assert.equal(changedReasonReplay.code, "invalid_record_identity");
    const boundary = await store.insertOrReplay({
      ...input,
      inputIndex: 3,
      maxPayloadBytes: 4,
      quotaBytes: 100,
      rawLine: "éé",
      reasonCode: "malformed_ndjson",
    });
    assert.equal(boundary.replayed, false);
    await assert.rejects(
      store.insertOrReplay({
        ...input,
        inputIndex: 4,
        maxPayloadBytes: 4,
        quotaBytes: 100,
        rawLine: "ééa",
        reasonCode: "malformed_ndjson",
      }),
      (error) => error instanceof RecordRejectionStoreError && error.code === "record_rejection_payload_too_large"
    );
    const quota = await postgresQuery<{ matches: boolean }>(
      `SELECT q.pending_payload_bytes = COALESCE(SUM(r.payload_bytes), 0) AS matches
         FROM record_rejection_quota q
         LEFT JOIN record_rejections r ON r.owner_subject_id = q.owner_subject_id
        WHERE q.owner_subject_id = $1
        GROUP BY q.pending_payload_bytes`,
      ["owner_a"]
    );
    assert.equal(quota.rows[0]?.matches, true);
    assert.equal(
      (await store.list({ connectorInstanceId: "cin_test", limit: 1, ownerSubjectId: "owner_a" })).items.length,
      1
    );
    assert.equal(
      (
        await store.getDetail({
          connectorInstanceId: "cin_test",
          ownerSubjectId: "owner_a",
          receiptId: first.receiptId,
        })
      )?.payloadText,
      '{"id":null}'
    );
    await assert.rejects(
      withPostgresTransaction(async (client) => {
        await deletePostgresRecordRejectionsForConnectionWithClient(client, {
          connectorInstanceId: "cin_test",
          ownerSubjectId: "owner_a",
        });
        throw new Error("injected caller failure");
      })
    );
    assert.equal(
      (
        await store.getDetail({
          connectorInstanceId: "cin_test",
          ownerSubjectId: "owner_a",
          receiptId: first.receiptId,
        })
      )?.payloadText,
      '{"id":null}'
    );
    assert.equal(await store.deleteForConnection({ connectorInstanceId: "cin_test", ownerSubjectId: "owner_a" }), 2);
    const postDeleteQuota = await postgresQuery<{ matches: boolean }>(
      `SELECT q.pending_payload_bytes = COALESCE(SUM(r.payload_bytes), 0) AS matches
         FROM record_rejection_quota q
         LEFT JOIN record_rejections r ON r.owner_subject_id = q.owner_subject_id
        WHERE q.owner_subject_id = $1
        GROUP BY q.pending_payload_bytes`,
      ["owner_a"]
    );
    assert.equal(postDeleteQuota.rows[0]?.matches, true);
  } finally {
    await closePostgresStorage();
  }
});
