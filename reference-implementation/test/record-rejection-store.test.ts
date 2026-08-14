// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
// biome-ignore lint/correctness/noUnresolvedImports: better-sqlite3 is a declared workspace runtime dependency resolved by pnpm/Node.
import Database from "better-sqlite3";
import { Pool } from "pg";
import { writeTransaction } from "../lib/db.ts";
import { scanDirectPrepareText } from "../scripts/check-direct-prepare-conformance.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts";
import { RECORD_REJECTION_GENERATION, recordRejectionReplayKey } from "../server/record-rejection-replay-key.ts";
import {
  getRetainedSizeGlobal,
  listRetainedSizeConnections,
  listRetainedSizeStreams,
  reconcileDirtyRetainedSize,
} from "../server/retained-size-read-model.ts";
import {
  createRecordRejectionStore,
  DEFAULT_RECORD_REJECTION_OWNER_QUOTA_BYTES,
  deletePostgresRecordRejectionsForConnectionWithClient,
  deleteSqliteRecordRejectionsForConnectionWithinTransaction,
  insertOrReplayPostgresRecordRejectionWithClient,
  insertOrReplaySqliteRecordRejection,
  insertOrReplaySqliteRecordRejectionInTransaction,
  markPostgresAcceptedRecordRejectionsStaleWithClient,
  markSqliteAcceptedRecordRejectionsStale,
  RECORD_REJECTION_OWNER_QUOTA_ENV,
  RECORD_REJECTION_REPLAY_COUNT_MAX,
  RecordRejectionStoreError,
  recordRejectionOwnerQuotaBytes,
} from "../server/stores/record-rejection-store.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const execFileAsync = promisify(execFile);
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const SIMULATED_AUDIT_WRITE_FAILURE_RE = /simulated audit write failure/;
const INJECTED_PAYLOAD_BACKFILL_FAILURE_RE = /injected payload backfill failure/;
const ROLLBACK_CALLER_TRANSACTION_RE = /rollback caller transaction/;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("record rejection replay generation and key have one shared golden authority", () => {
  assert.equal(RECORD_REJECTION_GENERATION, "record-rejection-v2");
  assert.equal(
    recordRejectionReplayKey({
      connectorInstanceId: "cin_test",
      ownerSubjectId: "owner_a",
      payload: Buffer.from('{"id":null}'),
      reasonCode: "malformed_ndjson",
      stream: "items",
    }),
    "ac523764da7aaf6651f5af6667e855256f32ef75233ea9c35451af3ea9a8e2c2"
  );
});

test("direct-prepare conformance fails for a record-rejection-store production call-site counterexample", async () => {
  const counterexample = [
    "// Copyright The PDP-Connect Contributors",
    ["// SPDX-", "License-Identifier: Apache-2.0"].join(""),
    'import { getDb } from "../../db.ts";',
    "export function forbiddenRecordRejectionStorePrepareCounterexample() {",
    '  return getDb().prepare("SELECT 1").get();',
    "}",
    "export function forbiddenMultilinePrepareCounterexample(db) {",
    "  return db",
    '    .prepare("SELECT 1")',
    "    .get();",
    "}",
    "export function allowedAdjacentNames(database, dbx) {",
    '  return [database.prepare("SELECT 1"), dbx.prepare("SELECT 1")];',
    "}",
    "",
  ].join("\n");
  const target = "reference-implementation/server/stores/record-rejection-store.ts";
  assert.deepEqual(scanDirectPrepareText(target, counterexample), [
    {
      line: 5,
      path: target,
      text: 'return getDb().prepare("SELECT 1").get();',
    },
    {
      line: 8,
      path: target,
      text: "return db",
    },
  ]);
  assert.equal(existsSync(join(REPO_ROOT, target)), true);
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "reference-implementation/scripts/check-direct-prepare-conformance.ts", target],
    { cwd: REPO_ROOT }
  );
});

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
  await postgresQuery(
    "INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, '{}'::jsonb, $2) ON CONFLICT(connector_id) DO NOTHING",
    [connectorId, now()]
  );
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
  const quota = getDb()
    .prepare(
      "SELECT pending_payload_bytes, pending_receipt_count FROM record_rejection_quota WHERE owner_subject_id = ?"
    )
    .get<{ pending_payload_bytes: number; pending_receipt_count: number }>(ownerSubjectId) ?? {
    pending_payload_bytes: 0,
    pending_receipt_count: 0,
  };
  const rows = getDb()
    .prepare(
      "SELECT COALESCE(SUM(payload_bytes), 0) AS bytes, COUNT(*) AS count FROM record_rejections WHERE owner_subject_id = ?"
    )
    .get<{ bytes: number; count: number }>(ownerSubjectId) ?? { bytes: 0, count: 0 };
  assert.equal(quota.pending_payload_bytes, rows.bytes);
  assert.equal(quota.pending_receipt_count, rows.count);
}

async function assertPostgresQuotaMatchesRows(ownerSubjectId: string) {
  const quota = await postgresQuery<{ matches: boolean }>(
    `SELECT q.pending_payload_bytes = COALESCE(SUM(r.payload_bytes), 0)
            AND q.pending_receipt_count = COUNT(r.receipt_id) AS matches
       FROM record_rejection_quota q
       LEFT JOIN record_rejections r ON r.owner_subject_id = q.owner_subject_id
      WHERE q.owner_subject_id = $1
      GROUP BY q.pending_payload_bytes, q.pending_receipt_count`,
    [ownerSubjectId]
  );
  assert.equal(quota.rows[0]?.matches, true);
}

function sqliteAuditEventCount(receiptId: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM spine_events WHERE object_type = 'record_rejection' AND object_id = ?")
      .get<{ count: number }>(receiptId)?.count ?? 0
  );
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
  const second = await store.insertOrReplay({ ...input, inputIndex: 5 });
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.replayed, true);
  assert.equal(second.code, "invalid_record_identity");
  const auditCountAfterReplay = sqliteAuditEventCount(first.receiptId);
  assert.equal(auditCountAfterReplay, 1);
  getDb()
    .prepare("UPDATE record_rejections SET replay_count = ? WHERE receipt_id = ?")
    .run(RECORD_REJECTION_REPLAY_COUNT_MAX - 1, first.receiptId);
  await store.insertOrReplay({ ...input, inputIndex: 6 });
  await store.insertOrReplay({ ...input, inputIndex: 7 });
  assert.equal(
    getDb()
      .prepare("SELECT replay_count FROM record_rejections WHERE receipt_id = ?")
      .get<{ replay_count: number }>(first.receiptId)?.replay_count,
    RECORD_REJECTION_REPLAY_COUNT_MAX
  );
  assert.equal(sqliteAuditEventCount(first.receiptId), auditCountAfterReplay);

  const changedReason = await store.insertOrReplay({ ...input, inputIndex: 8, reasonCode: "malformed_ndjson" });
  assert.notEqual(changedReason.receiptId, first.receiptId);
  assert.equal(changedReason.replayed, false);
  assert.equal(changedReason.code, "malformed_ndjson");

  const page = await store.list({ connectorInstanceId: "cin_test", limit: 10, ownerSubjectId: "owner_a" });
  assert.equal(page.items.length, 2);
  const [item] = page.items;
  assert.ok(item);
  assert.equal(item.payloadBytes, Buffer.byteLength(input.rawLine));
  assert.equal(item.latestInputIndex, 7);
  assert.equal(item.replayCount, RECORD_REJECTION_REPLAY_COUNT_MAX);
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
    .prepare(
      "SELECT pending_payload_bytes, pending_receipt_count FROM record_rejection_quota WHERE owner_subject_id = ?"
    )
    .get<{ pending_payload_bytes: number; pending_receipt_count: number }>("owner_a");
  assert.equal(quota?.pending_payload_bytes, Buffer.byteLength(input.rawLine) * 2);
  assert.equal(quota?.pending_receipt_count, 2);
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
    ["record_rejection.quarantined", "record_rejection.quarantined"]
  );
  for (const [index, event] of auditEvents.entries()) {
    assert.equal(event.actor_id, "pdpp_reference");
    assert.equal(event.actor_type, "system");
    assert.equal(event.object_id, index === 0 ? first.receiptId : changedReason.receiptId);
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
    assert.equal(data.receipt_id, index === 0 ? first.receiptId : changedReason.receiptId);
    assert.equal(data.connection_id, "cin_test");
    assert.equal(data.stream, "items");
    assert.equal(data.reason_code, index === 0 ? "invalid_record_identity" : "malformed_ndjson");
    assert.equal(data.payload_bytes, Buffer.byteLength(input.rawLine));
    assert.equal(data.payload_sha256, detail.payloadSha256);
    assert.equal(JSON.stringify(data).includes(input.rawLine), false);
  }
});

test("SQLite record rejection store tracks bounded run provenance and stale-after-acceptance facts", async () => {
  initDb();
  seedSqliteConnection({ runId: "run_first" });
  getDb()
    .prepare(
      `INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, started_at)
       VALUES('run_latest', 'cin_test', 'test_connector', '{}', 'running', ?)`
    )
    .run(now());
  const store = createRecordRejectionStore();
  const rawLine = '{"key":"same","data":{"id":"same"}}';
  const first = await store.insertOrReplay({
    connectorId: "test_connector",
    connectorInstanceId: "cin_test",
    inputIndex: 0,
    ownerSubjectId: "owner_a",
    rawLine,
    reasonCode: "invalid_record_identity",
    runId: "run_first",
    stream: "items",
  });
  await store.insertOrReplay({
    connectorId: "test_connector",
    connectorInstanceId: "cin_test",
    inputIndex: 3,
    ownerSubjectId: "owner_a",
    rawLine,
    reasonCode: "invalid_record_identity",
    runId: "run_latest",
    stream: "items",
  });
  let detail = await store.getDetail({
    connectorInstanceId: "cin_test",
    ownerSubjectId: "owner_a",
    receiptId: first.receiptId,
  });
  assert.equal(detail?.status, "pending");
  assert.equal(detail?.runId, "run_first");
  assert.equal(detail?.firstRunId, "run_first");
  assert.equal(detail?.latestRunId, "run_latest");
  assert.equal(detail?.firstInputIndex, 0);
  assert.equal(detail?.latestInputIndex, 3);

  const changed = markSqliteAcceptedRecordRejectionsStale({
    connectorId: "test_connector",
    connectorInstanceId: "cin_test",
    ownerSubjectId: "owner_a",
    rawLine,
    recordKey: "same",
    runId: "run_accept",
    stream: "items",
  });
  assert.equal(changed, 1);
  detail = await store.getDetail({
    connectorInstanceId: "cin_test",
    ownerSubjectId: "owner_a",
    receiptId: first.receiptId,
  });
  assert.equal(detail?.status, "stale_after_acceptance");
  assert.equal(detail?.acceptedRunId, "run_accept");
  assert.equal(detail?.acceptedRecordKey, "same");
  assert.equal(typeof detail?.acceptedAt, "string");
  assert.equal(
    markSqliteAcceptedRecordRejectionsStale({
      connectorId: "test_connector",
      connectorInstanceId: "cin_test",
      ownerSubjectId: "owner_a",
      rawLine,
      recordKey: "same",
      runId: "run_accept_2",
      stream: "items",
    }),
    0,
    "a stale receipt is not repeatedly rewritten"
  );
  assertSqliteQuotaMatchesRows("owner_a");
});

test("SQLite record rejection retained-size accounting covers insert, replay, restart, and delete cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-record-rejection-retained-size-"));
  const dbPath = join(dir, "pdpp.sqlite");
  try {
    initDb(dbPath);
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
    const payloadBytes = Buffer.byteLength(input.rawLine);
    const first = await store.insertOrReplay(input);
    const replay = await store.insertOrReplay({ ...input, inputIndex: 3 });
    assert.equal(replay.receiptId, first.receiptId);
    assert.equal(replay.replayed, true);

    let global = await getRetainedSizeGlobal();
    assert.equal(global.record_rejection_payload_bytes, payloadBytes);
    assert.equal(global.record_rejection_count, 1);
    assert.equal(global.total_retained_bytes, payloadBytes);
    let [connection] = await listRetainedSizeConnections({ connectorInstanceId: "cin_test" });
    assert.ok(connection);
    assert.equal(connection.record_rejection_payload_bytes, payloadBytes);
    assert.equal(connection.record_rejection_count, 1);
    const [stream] = await listRetainedSizeStreams({ connectorInstanceId: "cin_test", stream: "items" });
    assert.ok(stream);
    assert.equal(stream.record_rejection_payload_bytes, payloadBytes);
    assert.equal(stream.record_rejection_count, 1);

    closeDb();
    initDb(dbPath);
    global = await getRetainedSizeGlobal();
    assert.equal(global.record_rejection_payload_bytes, payloadBytes);
    assert.equal(global.record_rejection_count, 1);

    const reopenedStore = createRecordRejectionStore();
    assert.equal(
      await reopenedStore.deleteForConnection({ connectorInstanceId: "cin_test", ownerSubjectId: "owner_a" }),
      1
    );
    [connection] = await listRetainedSizeConnections({ connectorInstanceId: "cin_test" });
    assert.ok(connection);
    assert.equal(connection.dirty, true);
    await reconcileDirtyRetainedSize();
    global = await getRetainedSizeGlobal();
    assert.equal(global.record_rejection_payload_bytes, 0);
    assert.equal(global.record_rejection_count, 0);
    assert.equal(global.total_retained_bytes, 0);
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
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

test("SQLite caller-owned rejection insert seam rolls back receipt quota and audit", () => {
  initDb();
  seedSqliteConnection();
  const db = getDb();
  assert.throws(
    () =>
      writeTransaction(() => {
        insertOrReplaySqliteRecordRejectionInTransaction(db, {
          connectorId: "test_connector",
          connectorInstanceId: "cin_test",
          inputIndex: 0,
          ownerSubjectId: "owner_a",
          rawLine: "caller-rollback",
          reasonCode: "malformed_ndjson",
          runId: "run_1",
          stream: "items",
        });
        throw new Error("rollback caller transaction");
      }),
    ROLLBACK_CALLER_TRANSACTION_RE
  );
  assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM record_rejections").get<{ count: number }>()?.count, 0);
  assert.equal(
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM spine_events WHERE event_type LIKE 'record_rejection.%'")
      .get<{ count: number }>()?.count,
    0
  );
  assertSqliteQuotaMatchesRows("owner_a");
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

test("SQLite record rejection store preserves NUL, distinct invalid UTF-8, and multibyte payload bytes", async () => {
  initDb();
  seedSqliteConnection();
  const store = createRecordRejectionStore();
  const cases = [
    { expectedText: "{\u0000}", rawLine: Buffer.from([0x7b, 0x00, 0x7d]), reasonCode: "malformed_ndjson" },
    { expectedText: null, rawLine: Buffer.from([0xc0, 0xaf]), reasonCode: "invalid_utf8" },
    { expectedText: null, rawLine: Buffer.from([0xe0, 0x80, 0xaf]), reasonCode: "invalid_utf8" },
    { expectedText: "é水", rawLine: Buffer.from("é水", "utf8"), reasonCode: "malformed_ndjson" },
  ] as const;
  const receipts = await Promise.all(
    cases.map((entry, inputIndex) =>
      store.insertOrReplay({
        connectorId: "test_connector",
        connectorInstanceId: "cin_test",
        inputIndex,
        ownerSubjectId: "owner_a",
        quotaBytes: 1000,
        rawLine: entry.rawLine,
        reasonCode: entry.reasonCode,
        runId: "run_1",
        stream: "items",
      })
    )
  );
  assert.notEqual(receipts[1]?.receiptId, receipts[2]?.receiptId);
  const details = await Promise.all(
    receipts.map((receipt) =>
      store.getDetail({ connectorInstanceId: "cin_test", ownerSubjectId: "owner_a", receiptId: receipt.receiptId })
    )
  );
  for (const [index, detail] of details.entries()) {
    assert.equal(detail?.payloadBase64, cases[index]?.rawLine.toString("base64"));
    assert.equal(detail?.payloadText, cases[index]?.expectedText);
    assert.equal(detail?.payloadBytes, cases[index]?.rawLine.byteLength);
  }
  assertSqliteQuotaMatchesRows("owner_a");
});

test("SQLite record rejection store enforces owner and connection receipt-count quotas with multi-owner isolation", async () => {
  initDb();
  seedSqliteConnection();
  seedSqliteConnection({ connectorInstanceId: "cin_b", runId: "run_b", status: "draft" });
  seedSqliteConnection({ connectorInstanceId: "cin_c", ownerSubjectId: "owner_b", runId: "run_c", status: "draft" });
  const store = createRecordRejectionStore();
  const input = {
    connectorId: "test_connector",
    connectorInstanceId: "cin_test",
    maxConnectionReceipts: 2,
    maxOwnerReceipts: 3,
    ownerSubjectId: "owner_a",
    quotaBytes: 1000,
    reasonCode: "malformed_ndjson",
    runId: "run_1",
    stream: "items",
  };
  await store.insertOrReplay({ ...input, inputIndex: 0, rawLine: "connection-one" });
  await store.insertOrReplay({ ...input, inputIndex: 1, rawLine: "connection-two" });
  await assert.rejects(
    store.insertOrReplay({ ...input, inputIndex: 2, rawLine: "connection-three" }),
    (error) => error instanceof RecordRejectionStoreError && error.code === "record_rejection_connection_quota_exceeded"
  );
  await store.insertOrReplay({
    ...input,
    connectorInstanceId: "cin_b",
    inputIndex: 0,
    rawLine: "owner-third",
    runId: "run_b",
  });
  await assert.rejects(
    store.insertOrReplay({
      ...input,
      connectorInstanceId: "cin_b",
      inputIndex: 1,
      rawLine: "owner-fourth",
      runId: "run_b",
    }),
    (error) => error instanceof RecordRejectionStoreError && error.code === "record_rejection_quota_exceeded"
  );
  await store.insertOrReplay({
    connectorId: "test_connector",
    connectorInstanceId: "cin_c",
    inputIndex: 0,
    maxOwnerReceipts: 1,
    ownerSubjectId: "owner_b",
    quotaBytes: 1000,
    rawLine: "owner-b-isolated",
    reasonCode: "malformed_ndjson",
    runId: "run_c",
    stream: "items",
  });
  assertSqliteQuotaMatchesRows("owner_a");
  assertSqliteQuotaMatchesRows("owner_b");
});

test("SQLite record rejection store matches ingest lifecycle and exact run-history fences", () => {
  initDb();
  seedSqliteConnection({ connectorInstanceId: "cin_draft", runId: "run_draft", status: "draft" });
  seedSqliteConnection({ connectorInstanceId: "cin_paused", runId: "run_paused", status: "paused" });
  seedSqliteConnection({ connectorInstanceId: "cin_revoked", runId: "run_revoked", status: "revoked" });
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
  assert.throws(
    () =>
      insertOrReplaySqliteRecordRejection({
        connectorId: "test_connector",
        connectorInstanceId: "cin_revoked",
        inputIndex: 0,
        ownerSubjectId: "owner_a",
        rawLine: "revoked",
        reasonCode: "malformed_ndjson",
        runId: "run_revoked",
        stream: "items",
      }),
    (err) => err instanceof RecordRejectionStoreError && err.code === "connection_not_writable"
  );
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

test("SQLite record rejection migration relaxes legacy pending-only status check", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-record-rejection-lifecycle-migration-"));
  const dbPath = join(dir, "legacy.sqlite");
  try {
    const legacy = new Database(dbPath);
    const createdAt = now();
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE connectors(connector_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO connectors VALUES('test_connector', '{}', '${createdAt}');
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
        revoked_at TEXT,
        manifest_generation INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO connector_instances VALUES('cin_test', 'owner_a', 'test_connector', 'Test', 'active', 'account', 'cin_test', '{}', '${createdAt}', '${createdAt}', NULL, 0);
      CREATE TABLE record_rejection_quota(owner_subject_id TEXT PRIMARY KEY, pending_payload_bytes INTEGER NOT NULL DEFAULT 0, pending_receipt_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      INSERT INTO record_rejection_quota VALUES('owner_a', 0, 0, '${createdAt}');
      CREATE TABLE record_rejections(
        receipt_id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        run_id TEXT,
        first_input_index INTEGER NOT NULL CHECK (first_input_index >= 0),
        latest_input_index INTEGER NOT NULL CHECK (latest_input_index >= 0),
        reason_code TEXT NOT NULL,
        payload BLOB NOT NULL,
        payload_sha256 TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
        rejection_generation TEXT NOT NULL DEFAULT 'record-rejection-v2',
        replay_key TEXT NOT NULL UNIQUE,
        replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status = 'pending'),
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
    `);
    legacy.close();
    initDb(dbPath);
    const sql = getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'record_rejections'")
      .get<{ sql: string }>()?.sql;
    assert.ok(sql?.includes("stale_after_acceptance"));
    getDb()
      .prepare(
        "INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, started_at) VALUES('run_1', 'cin_test', 'test_connector', '{}', 'running', ?)"
      )
      .run(now());
    const receipt = insertOrReplaySqliteRecordRejection({
      connectorId: "test_connector",
      connectorInstanceId: "cin_test",
      inputIndex: 0,
      ownerSubjectId: "owner_a",
      rawLine: '{"key":"same","data":{"id":"same"}}',
      reasonCode: "invalid_record_identity",
      runId: "run_1",
      stream: "items",
    });
    assert.equal(
      markSqliteAcceptedRecordRejectionsStale({
        connectorId: "test_connector",
        connectorInstanceId: "cin_test",
        ownerSubjectId: "owner_a",
        rawLine: '{"key":"same","data":{"id":"same"}}',
        recordKey: "same",
        runId: "run_accept",
        stream: "items",
      }),
      1
    );
    assert.equal(
      getDb()
        .prepare("SELECT status FROM record_rejections WHERE receipt_id = ?")
        .get<{ status: string }>(receipt.receiptId)?.status,
      "stale_after_acceptance"
    );
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SQLite record rejection migration converts legacy text payloads, rekeys v2, is idempotent, and rolls back faults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-record-rejections-v2-migration-"));
  const dbPath = join(dir, "legacy.sqlite");
  try {
    const legacy = new Database(dbPath);
    const createdAt = now();
    legacy.exec(`
      CREATE TABLE connectors(connector_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO connectors VALUES('test_connector', '{}', '${createdAt}');
      CREATE TABLE connector_instances(
        connector_instance_id TEXT PRIMARY KEY, owner_subject_id TEXT NOT NULL, connector_id TEXT NOT NULL,
        display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', source_kind TEXT NOT NULL,
        source_binding_key TEXT NOT NULL, source_binding_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT
      );
      INSERT INTO connector_instances(
        connector_instance_id, owner_subject_id, connector_id, display_name, status,
        source_kind, source_binding_key, source_binding_json, created_at, updated_at
      ) VALUES('cin_test', 'owner_a', 'test_connector', 'Test', 'active', 'account', 'cin_test', '{}', '${createdAt}', '${createdAt}');
      CREATE TABLE record_rejection_quota(owner_subject_id TEXT PRIMARY KEY, pending_payload_bytes INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      INSERT INTO record_rejection_quota VALUES('owner_a', 999, '${createdAt}');
      CREATE TABLE record_rejections(
        receipt_id TEXT PRIMARY KEY, owner_subject_id TEXT NOT NULL, connector_instance_id TEXT NOT NULL,
        connector_id TEXT NOT NULL, stream TEXT NOT NULL, run_id TEXT, first_input_index INTEGER NOT NULL,
        latest_input_index INTEGER NOT NULL, reason_code TEXT NOT NULL, payload_text TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL, payload_bytes INTEGER NOT NULL, replay_key TEXT NOT NULL UNIQUE,
        replay_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE TABLE retained_size_global(
        projection_key TEXT PRIMARY KEY, current_record_json_bytes INTEGER NOT NULL DEFAULT 0,
        record_history_json_bytes INTEGER NOT NULL DEFAULT 0, blob_bytes INTEGER NOT NULL DEFAULT 0,
        record_count INTEGER NOT NULL DEFAULT 0, record_history_count INTEGER NOT NULL DEFAULT 0,
        blob_count INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 0,
        computed_at TEXT, metadata_json TEXT
      );
      INSERT INTO retained_size_global(projection_key, dirty) VALUES('global', 0);
      CREATE TABLE retained_size_connection(
        connector_instance_id TEXT PRIMARY KEY, connector_id TEXT NOT NULL,
        current_record_json_bytes INTEGER NOT NULL DEFAULT 0, record_history_json_bytes INTEGER NOT NULL DEFAULT 0,
        blob_bytes INTEGER NOT NULL DEFAULT 0, record_count INTEGER NOT NULL DEFAULT 0,
        record_history_count INTEGER NOT NULL DEFAULT 0, blob_count INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0, computed_at TEXT
      );
      CREATE TABLE retained_size_stream(
        connector_instance_id TEXT NOT NULL, connector_id TEXT NOT NULL, stream TEXT NOT NULL,
        current_record_json_bytes INTEGER NOT NULL DEFAULT 0, record_history_json_bytes INTEGER NOT NULL DEFAULT 0,
        blob_bytes INTEGER NOT NULL DEFAULT 0, record_count INTEGER NOT NULL DEFAULT 0,
        record_history_count INTEGER NOT NULL DEFAULT 0, blob_count INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0, computed_at TEXT,
        PRIMARY KEY(connector_instance_id, stream)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO record_rejections VALUES(
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )`
      )
      .run(
        "rr_legacy",
        "owner_a",
        "cin_test",
        "test_connector",
        "items",
        "run_1",
        0,
        0,
        "malformed_ndjson",
        '{"id":null}',
        "8bdf592a5d687a7aaee0ac11c053c7bf2efc0a2bacebeb180a9dc2ba06f80c00",
        11,
        "legacy-key-without-reason",
        0,
        "pending",
        createdAt,
        createdAt
      );
    legacy.close();
    initDb(dbPath);
    const columns = getDb().prepare("PRAGMA table_info(record_rejections)").all<{ name: string }>();
    assert.equal(
      columns.some((column) => column.name === "payload_text"),
      false
    );
    const row = getDb()
      .prepare("SELECT payload, rejection_generation, replay_key FROM record_rejections WHERE receipt_id = 'rr_legacy'")
      .get<{ payload: Buffer; rejection_generation: string; replay_key: string }>();
    assert.equal(row?.payload.toString("utf8"), '{"id":null}');
    assert.equal(row?.rejection_generation, RECORD_REJECTION_GENERATION);
    assert.equal(
      row?.replay_key,
      recordRejectionReplayKey({
        connectorInstanceId: "cin_test",
        ownerSubjectId: "owner_a",
        payload: Buffer.from('{"id":null}'),
        reasonCode: "malformed_ndjson",
        stream: "items",
      })
    );
    assertSqliteQuotaMatchesRows("owner_a");
    await reconcileDirtyRetainedSize();
    const migratedRetainedGlobal = await getRetainedSizeGlobal();
    assert.equal(migratedRetainedGlobal.record_rejection_payload_bytes, 11);
    assert.equal(migratedRetainedGlobal.record_rejection_count, 1);
    assert.equal(
      (
        await createRecordRejectionStore().getDetail({
          connectorInstanceId: "cin_test",
          ownerSubjectId: "owner_a",
          receiptId: "rr_legacy",
        })
      )?.payloadBase64,
      Buffer.from('{"id":null}').toString("base64")
    );
    getDb().exec(`
      CREATE TABLE record_rejection_update_probe(update_count INTEGER NOT NULL DEFAULT 0);
      INSERT INTO record_rejection_update_probe VALUES(0);
      CREATE TRIGGER count_record_rejection_update_probe AFTER UPDATE ON record_rejections
      BEGIN
        UPDATE record_rejection_update_probe SET update_count = update_count + 1;
      END;
    `);
    closeDb();
    initDb(dbPath);
    assert.equal(
      getDb().prepare("SELECT update_count FROM record_rejection_update_probe").get<{ update_count: number }>()
        ?.update_count,
      0
    );
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("SQLite record rejection migration rolls back injected text-to-BLOB failures and reopens cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-record-rejections-v2-migration-fault-"));
  const dbPath = join(dir, "legacy.sqlite");
  try {
    const legacy = new Database(dbPath);
    const createdAt = now();
    legacy.exec(`
      CREATE TABLE connectors(connector_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO connectors VALUES('test_connector', '{}', '${createdAt}');
      CREATE TABLE connector_instances(
        connector_instance_id TEXT PRIMARY KEY, owner_subject_id TEXT NOT NULL, connector_id TEXT NOT NULL,
        display_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', source_kind TEXT NOT NULL,
        source_binding_key TEXT NOT NULL, source_binding_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT
      );
      INSERT INTO connector_instances(
        connector_instance_id, owner_subject_id, connector_id, display_name, status,
        source_kind, source_binding_key, source_binding_json, created_at, updated_at
      ) VALUES('cin_test', 'owner_a', 'test_connector', 'Test', 'active', 'account', 'cin_test', '{}', '${createdAt}', '${createdAt}');
      CREATE TABLE record_rejection_quota(
        owner_subject_id TEXT PRIMARY KEY, pending_payload_bytes INTEGER NOT NULL DEFAULT 0,
        pending_receipt_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      INSERT INTO record_rejection_quota VALUES('owner_a', 0, 0, '${createdAt}');
      CREATE TABLE record_rejections(
        receipt_id TEXT PRIMARY KEY, owner_subject_id TEXT NOT NULL, connector_instance_id TEXT NOT NULL,
        connector_id TEXT NOT NULL, stream TEXT NOT NULL, run_id TEXT, first_input_index INTEGER NOT NULL,
        latest_input_index INTEGER NOT NULL, reason_code TEXT NOT NULL, payload BLOB, payload_text TEXT,
        payload_sha256 TEXT NOT NULL, payload_bytes INTEGER NOT NULL, replay_key TEXT NOT NULL UNIQUE,
        replay_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      INSERT INTO record_rejections VALUES(
        'rr_fault', 'owner_a', 'cin_test', 'test_connector', 'items', 'run_1', 0, 0,
        'malformed_ndjson', NULL, '{"id":null}', '8bdf592a5d687a7aaee0ac11c053c7bf2efc0a2bacebeb180a9dc2ba06f80c00',
        11, 'fault-key', 0, 'pending', '${createdAt}', '${createdAt}'
      );
      CREATE TRIGGER fail_payload_backfill BEFORE UPDATE OF payload ON record_rejections
      BEGIN
        SELECT RAISE(FAIL, 'injected payload backfill failure');
      END;
    `);
    legacy.close();
    assert.throws(() => initDb(dbPath), INJECTED_PAYLOAD_BACKFILL_FAILURE_RE);
    closeDb();
    const failed = new Database(dbPath);
    const failedColumns = failed.prepare("PRAGMA table_info(record_rejections)").all() as { name: string }[];
    assert.equal(
      failedColumns.some((column) => column.name === "payload_text"),
      true
    );
    const failedRow = failed
      .prepare("SELECT payload IS NULL AS payload_is_null FROM record_rejections WHERE receipt_id = 'rr_fault'")
      .get() as { payload_is_null: number } | undefined;
    assert.equal(failedRow?.payload_is_null, 1);
    failed.prepare("DROP TRIGGER fail_payload_backfill").run();
    failed.close();
    initDb(dbPath);
    const recoveredColumns = getDb().prepare("PRAGMA table_info(record_rejections)").all<{ name: string }>();
    assert.equal(
      recoveredColumns.some((column) => column.name === "payload_text"),
      false
    );
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
      `TRUNCATE
         retained_size_top_rows, retained_size_record_family, retained_size_stream,
         retained_size_connection, retained_size_global,
         record_rejections, record_rejection_quota, controller_active_runs,
         run_history, connector_instances, connectors
       CASCADE`
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
      quotaBytes: 1000,
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
    assert.notEqual(changedReasonReplay.receiptId, first.receiptId);
    assert.equal(changedReasonReplay.code, "malformed_ndjson");
    const rejectionPayloadBytes = Buffer.byteLength(input.rawLine);
    const retainedGlobal = await getRetainedSizeGlobal();
    assert.equal(retainedGlobal.record_rejection_payload_bytes, rejectionPayloadBytes * 2);
    assert.equal(retainedGlobal.record_rejection_count, 2);
    const [retainedConnection] = await listRetainedSizeConnections({ connectorInstanceId: "cin_test" });
    assert.equal(retainedConnection?.record_rejection_payload_bytes, rejectionPayloadBytes * 2);
    assert.equal(retainedConnection?.record_rejection_count, 2);
    const [retainedStream] = await listRetainedSizeStreams({ connectorInstanceId: "cin_test", stream: "items" });
    assert.equal(retainedStream?.record_rejection_payload_bytes, rejectionPayloadBytes * 2);
    assert.equal(retainedStream?.record_rejection_count, 2);
    await postgresQuery("UPDATE record_rejections SET replay_count = $1 WHERE receipt_id = $2", [
      RECORD_REJECTION_REPLAY_COUNT_MAX - 1,
      first.receiptId,
    ]);
    await store.insertOrReplay({ ...input, inputIndex: 20 });
    await store.insertOrReplay({ ...input, inputIndex: 21, runId: "run_1" });
    const saturated = await postgresQuery<{ replay_count: string }>(
      "SELECT replay_count FROM record_rejections WHERE receipt_id = $1",
      [first.receiptId]
    );
    assert.equal(Number(saturated.rows[0]?.replay_count), RECORD_REJECTION_REPLAY_COUNT_MAX);
    const provenance = await store.getDetail({
      connectorInstanceId: "cin_test",
      ownerSubjectId: "owner_a",
      receiptId: first.receiptId,
    });
    assert.equal(provenance?.status, "pending");
    assert.equal(provenance?.firstRunId, "run_1");
    assert.equal(provenance?.latestRunId, "run_1");
    await withPostgresTransaction(
      async (client) => {
        const changed = await markPostgresAcceptedRecordRejectionsStaleWithClient(client, {
          connectorId: "test_connector",
          connectorInstanceId: "cin_test",
          ownerSubjectId: "owner_a",
          rawLine: input.rawLine,
          recordKey: "accepted_pg",
          runId: "run_pg_accept",
          stream: "items",
        });
        assert.equal(changed, 2);
      },
      { lockConnectorInstanceId: "cin_test" }
    );
    const stale = await store.getDetail({
      connectorInstanceId: "cin_test",
      ownerSubjectId: "owner_a",
      receiptId: first.receiptId,
    });
    assert.equal(stale?.status, "stale_after_acceptance");
    assert.equal(stale?.acceptedRunId, "run_pg_accept");
    assert.equal(stale?.acceptedRecordKey, "accepted_pg");
    const staleChangedReason = await store.getDetail({
      connectorInstanceId: "cin_test",
      ownerSubjectId: "owner_a",
      receiptId: changedReasonReplay.receiptId,
    });
    assert.equal(staleChangedReason?.status, "stale_after_acceptance");
    assert.equal(staleChangedReason?.acceptedRunId, "run_pg_accept");
    assert.equal(staleChangedReason?.acceptedRecordKey, "accepted_pg");
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
      async () =>
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
    const byteCases = [
      { expectedText: "{\u0000}", rawLine: Buffer.from([0x7b, 0x00, 0x7d]), reasonCode: "malformed_ndjson" },
      { expectedText: null, rawLine: Buffer.from([0xc0, 0xaf]), reasonCode: "invalid_utf8" },
      { expectedText: null, rawLine: Buffer.from([0xe0, 0x80, 0xaf]), reasonCode: "invalid_utf8" },
      { expectedText: "é水", rawLine: Buffer.from("é水", "utf8"), reasonCode: "malformed_ndjson" },
    ] as const;
    const byteReceipts = await Promise.all(
      byteCases.map((byteCase, offset) =>
        store.insertOrReplay({
          ...input,
          inputIndex: 30 + offset,
          rawLine: byteCase.rawLine,
          reasonCode: byteCase.reasonCode,
        })
      )
    );
    assert.notEqual(byteReceipts[1]?.receiptId, byteReceipts[2]?.receiptId);
    const byteDetails = await Promise.all(
      byteReceipts.map((receipt) =>
        store.getDetail({
          connectorInstanceId: "cin_test",
          ownerSubjectId: "owner_a",
          receiptId: receipt.receiptId,
        })
      )
    );
    for (const [offset, byteCase] of byteCases.entries()) {
      const detail = byteDetails[offset];
      assert.ok(detail);
      assert.equal(detail?.payloadBase64, byteCase.rawLine.toString("base64"));
      assert.equal(detail?.payloadText, byteCase.expectedText);
      assert.equal(detail?.payloadBytes, byteCase.rawLine.byteLength);
    }
    await assertPostgresQuotaMatchesRows("owner_a");
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
    await seedPostgresConnection({ connectorInstanceId: "cin_tx", runId: "run_tx", status: "active" });
    await assert.rejects(
      withPostgresTransaction(async (client) => {
        await insertOrReplayPostgresRecordRejectionWithClient(client, {
          ...input,
          connectorInstanceId: "cin_tx",
          inputIndex: 50,
          rawLine: "pg-caller-rollback",
          runId: "run_tx",
        });
        throw new Error("rollback caller transaction");
      }),
      ROLLBACK_CALLER_TRANSACTION_RE
    );
    assert.equal(
      Number(
        (
          await postgresQuery<{ count: string }>(
            "SELECT COUNT(*)::bigint AS count FROM record_rejections WHERE connector_instance_id = 'cin_tx'"
          )
        ).rows[0]?.count ?? 0
      ),
      0
    );
    assert.equal(
      Number(
        (
          await postgresQuery<{ count: string }>(
            "SELECT COUNT(*)::bigint AS count FROM spine_events WHERE object_type = 'record_rejection' AND data_json->>'connection_id' = 'cin_tx'"
          )
        ).rows[0]?.count ?? 0
      ),
      0
    );
    await assertPostgresQuotaMatchesRows("owner_a");
    await seedPostgresConnection({ connectorInstanceId: "cin_revoked", runId: "run_revoked", status: "revoked" });
    await assert.rejects(
      store.insertOrReplay({
        ...input,
        connectorInstanceId: "cin_revoked",
        inputIndex: 40,
        rawLine: "revoked",
        runId: "run_revoked",
      }),
      (error) => error instanceof RecordRejectionStoreError && error.code === "connection_not_writable"
    );
    await seedPostgresConnection({ connectorInstanceId: "cin_b", runId: "run_b", status: "draft" });
    await seedPostgresConnection({
      connectorInstanceId: "cin_c",
      ownerSubjectId: "owner_b",
      runId: "run_c",
      status: "draft",
    });
    await assert.rejects(
      store.insertOrReplay({
        ...input,
        inputIndex: 41,
        maxConnectionReceipts: 7,
        rawLine: "connection-count-overflow",
      }),
      (error) =>
        error instanceof RecordRejectionStoreError && error.code === "record_rejection_connection_quota_exceeded"
    );
    await store.insertOrReplay({
      ...input,
      connectorInstanceId: "cin_b",
      inputIndex: 0,
      maxOwnerReceipts: 8,
      rawLine: "owner-fill",
      runId: "run_b",
    });
    await assert.rejects(
      store.insertOrReplay({
        ...input,
        connectorInstanceId: "cin_b",
        inputIndex: 1,
        maxOwnerReceipts: 8,
        rawLine: "owner-count-overflow",
        runId: "run_b",
      }),
      (error) => error instanceof RecordRejectionStoreError && error.code === "record_rejection_quota_exceeded"
    );
    await store.insertOrReplay({
      connectorId: "test_connector",
      connectorInstanceId: "cin_c",
      inputIndex: 0,
      maxOwnerReceipts: 1,
      ownerSubjectId: "owner_b",
      quotaBytes: 1000,
      rawLine: "owner-b-isolated",
      reasonCode: "malformed_ndjson",
      runId: "run_c",
      stream: "items",
    });
    await assertPostgresQuotaMatchesRows("owner_a");
    await assertPostgresQuotaMatchesRows("owner_b");
    assert.equal(await store.deleteForConnection({ connectorInstanceId: "cin_test", ownerSubjectId: "owner_a" }), 7);
    await assertPostgresQuotaMatchesRows("owner_a");
    const canonicalRetained = await postgresQuery<{ bytes: string; count: string }>(
      "SELECT COALESCE(SUM(payload_bytes), 0)::bigint AS bytes, COUNT(*)::bigint AS count FROM record_rejections"
    );
    await closePostgresStorage();
    const migrationAdmin = new Pool({ connectionString: POSTGRES_URL });
    try {
      await Promise.all(
        [
          "retained_size_global",
          "retained_size_connection",
          "retained_size_stream",
          "retained_size_record_family",
          "retained_size_top_rows",
        ].flatMap((table) => [
          migrationAdmin.query(`ALTER TABLE ${table} DROP COLUMN record_rejection_payload_bytes`),
          migrationAdmin.query(`ALTER TABLE ${table} DROP COLUMN record_rejection_count`),
        ])
      );
    } finally {
      await migrationAdmin.end();
    }
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    await reconcileDirtyRetainedSize();
    const migratedGlobal = await getRetainedSizeGlobal();
    assert.equal(migratedGlobal.record_rejection_payload_bytes, Number(canonicalRetained.rows[0]?.bytes));
    assert.equal(migratedGlobal.record_rejection_count, Number(canonicalRetained.rows[0]?.count));
  } finally {
    await closePostgresStorage();
  }
});
