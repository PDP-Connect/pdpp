// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
import Database from "better-sqlite3";

import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
// biome-ignore lint/performance/noNamespaceImport: the test uses the module namespace as the observable import surface.
import * as recordsModule from "../server/records.ts";
import { getSyncState, ingestRecord } from "../server/records.ts";
import { createSqliteBlobStore } from "../server/stores/blob-store.ts";
import { createSqliteBrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";
import { createSqliteConnectorStateStore } from "../server/stores/connector-state-store.ts";
import { createSqliteDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";

const NOW = "2026-05-18T12:00:00.000Z";
const GMAIL = "gmail-acceptance";
const LOCAL = "local-collector-acceptance";

function manifest(connectorId: string, stream = "messages") {
  return {
    connector_id: connectorId,
    display_name: connectorId,
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: stream,
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            subject: { type: "string" },
          },
          required: ["id", "subject"],
          type: "object",
        },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

// `records.js` is untyped legacy JS: `queryRecords`'s `manifest` parameter is
// inferred as `null | undefined` purely from its default value (TS ignores
// the downstream `assertManifestReadAuthority(manifest, ...)` usage inside an
// unchecked JS file), even though the real manifest shape flows through fine
// at runtime. Re-declare the real call shape locally and cast the namespace
// export, per the established untyped-JS-import pattern.
// biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
const queryRecords = recordsModule.queryRecords;

async function withDb(fn: () => Promise<void>) {
  initDb();
  try {
    await registerConnector(manifest(GMAIL));
    await registerConnector(manifest(LOCAL, "events"));
    await fn();
  } finally {
    closeDb();
  }
}

function recordTarget(connectorId: string, connectorInstanceId: string) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

function stateTarget(connectorId: string, connectorInstanceId: string) {
  return { connectorId, connectorInstanceId };
}

function oldLegacyDefaultConnectorInstanceId(ownerSubjectId: string, connectorId: string) {
  const hash = createHash("sha256").update(`${ownerSubjectId}\n${connectorId}`).digest("hex");
  return `cin_legacy_${hash.slice(0, 24)}`;
}

function record(subject: string, key = "same-key") {
  return {
    data: { id: key, subject },
    emitted_at: NOW,
    key,
    stream: "messages",
  };
}

function createLegacyInstanceMigrationFixture(
  raw: Database.Database,
  { oldInstanceId, defaultAccountInstanceId }: { oldInstanceId: string; defaultAccountInstanceId?: string | undefined }
) {
  raw.exec(`
    CREATE TABLE connectors (
      connector_id TEXT PRIMARY KEY,
      manifest     TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE connector_instances (
      connector_instance_id TEXT PRIMARY KEY,
      owner_subject_id      TEXT NOT NULL,
      connector_id          TEXT NOT NULL,
      display_name          TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
      source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'manual', 'legacy')),
      source_binding_key    TEXT NOT NULL,
      source_binding_json   TEXT NOT NULL DEFAULT '{}',
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      revoked_at            TEXT,
      UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)
    );
    CREATE INDEX idx_connector_instances_owner_connector_status
      ON connector_instances(owner_subject_id, connector_id, status);
    CREATE TABLE records (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id  TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      stream        TEXT NOT NULL,
      record_key    TEXT NOT NULL,
      record_json   TEXT NOT NULL,
      emitted_at    TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,
      deleted       INTEGER NOT NULL DEFAULT 0,
      deleted_at    TEXT,
      UNIQUE(connector_instance_id, stream, record_key)
    );
  `);
  raw
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES(?, ?, ?)")
    .run(GMAIL, JSON.stringify(manifest(GMAIL)), NOW);
  const insertInstance = raw.prepare(
    `INSERT INTO connector_instances(
      connector_instance_id,
      owner_subject_id,
      connector_id,
      display_name,
      status,
      source_kind,
      source_binding_key,
      source_binding_json,
      created_at,
      updated_at,
      revoked_at
    ) VALUES(?, 'owner_local', ?, 'Gmail', 'active', ?, 'default', ?, ?, ?, NULL)`
  );
  insertInstance.run(oldInstanceId, GMAIL, "legacy", '{"kind":"legacy_default"}', NOW, NOW);
  if (defaultAccountInstanceId) {
    insertInstance.run(defaultAccountInstanceId, GMAIL, "account", '{"kind":"default_account"}', NOW, NOW);
  }
}

function insertRecordRow(raw: Database.Database, connectorInstanceId: string, recordKey: string, subject: string) {
  raw
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version)
     VALUES(?, ?, 'messages', ?, ?, ?, 1)`
    )
    .run(GMAIL, connectorInstanceId, recordKey, JSON.stringify({ id: recordKey, subject }), NOW);
}

test("existing legacy connector instance rows migrate to default account ids and tighten the source_kind check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-instance-legacy-row-"));
  const dbPath = join(dir, "reference.sqlite");
  const oldInstanceId = oldLegacyDefaultConnectorInstanceId("owner_local", GMAIL);
  const defaultAccountInstanceId = makeDefaultAccountConnectorInstanceId("owner_local", GMAIL);

  try {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE connectors (
        connector_id TEXT PRIMARY KEY,
        manifest     TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO connectors(connector_id, manifest, created_at)
      VALUES('${GMAIL}', '${JSON.stringify(manifest(GMAIL)).replaceAll("'", "''")}', '${NOW}');

      CREATE TABLE connector_instances (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id      TEXT NOT NULL,
        connector_id          TEXT NOT NULL,
        display_name          TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
        source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'manual', 'legacy')),
        source_binding_key    TEXT NOT NULL,
        source_binding_json   TEXT NOT NULL DEFAULT '{}',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        revoked_at            TEXT,
        UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)
      );
      CREATE INDEX idx_connector_instances_owner_connector_status
        ON connector_instances(owner_subject_id, connector_id, status);
      INSERT INTO connector_instances(
        connector_instance_id,
        owner_subject_id,
        connector_id,
        display_name,
        status,
        source_kind,
        source_binding_key,
        source_binding_json,
        created_at,
        updated_at,
        revoked_at
      )
      VALUES(
        '${oldInstanceId}',
        'owner_local',
        '${GMAIL}',
        'Gmail',
        'active',
        'legacy',
        'default',
        '{"kind":"legacy_default"}',
        '${NOW}',
        '${NOW}',
        NULL
      );

      CREATE TABLE records (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connector_id  TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream        TEXT NOT NULL,
        record_key    TEXT NOT NULL,
        record_json   TEXT NOT NULL,
        emitted_at    TEXT NOT NULL,
        version       INTEGER NOT NULL DEFAULT 1,
        deleted       INTEGER NOT NULL DEFAULT 0,
        deleted_at    TEXT,
        UNIQUE(connector_instance_id, stream, record_key)
      );
      INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version)
      VALUES('${GMAIL}', '${oldInstanceId}', 'messages', 'msg_legacy_instance', '{"id":"msg_legacy_instance","subject":"legacy row"}', '${NOW}', 1);

      CREATE TABLE connector_schedules (
        connector_instance_id TEXT PRIMARY KEY,
        connector_id      TEXT NOT NULL,
        interval_seconds  INTEGER NOT NULL,
        jitter_seconds    INTEGER NOT NULL DEFAULT 0,
        enabled           INTEGER NOT NULL DEFAULT 1,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at)
      VALUES('${oldInstanceId}', '${GMAIL}', 900, 10, 1, '${NOW}', '${NOW}');
    `);
    raw.close();

    initDb(dbPath);
    const db = getDb();
    const retiredInstanceCount = db
      .prepare("SELECT COUNT(*) AS count FROM connector_instances WHERE connector_instance_id = ?")
      .get(oldInstanceId);
    const migratedRecord = db
      .prepare("SELECT connector_instance_id FROM records WHERE record_key = ?")
      .get("msg_legacy_instance");
    const migratedSchedule = db
      .prepare("SELECT connector_instance_id FROM connector_schedules WHERE connector_id = ?")
      .get(GMAIL);
    const connectorSchema = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_instances'")
      .get();
    assert.ok(
      retiredInstanceCount && migratedRecord && migratedSchedule && connectorSchema,
      "migration queries return their rows"
    );
    assert.equal(retiredInstanceCount.count, 0);
    const instance = db
      .prepare(
        "SELECT connector_instance_id, source_kind, source_binding_key, source_binding_json FROM connector_instances WHERE connector_id = ?"
      )
      .get(GMAIL);
    assert.deepEqual(instance, {
      connector_instance_id: defaultAccountInstanceId,
      source_binding_json: '{"kind":"default_account"}',
      source_binding_key: "default",
      source_kind: "account",
    });
    assert.equal(migratedRecord.connector_instance_id, defaultAccountInstanceId);
    assert.equal(migratedSchedule.connector_instance_id, defaultAccountInstanceId);
    const schemaSql = connectorSchema.sql;
    assert.ok(typeof schemaSql === "string", "connector_instances schema SQL is present");
    assert.equal(schemaSql.includes("'legacy'"), false);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at)
         VALUES('cin_bad_legacy', 'owner_local', ?, 'Bad', 'active', 'legacy', 'bad', '{}', ?, ?)`
          )
          .run(GMAIL, NOW, NOW),
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      /CHECK constraint failed/
    );
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("legacy default rows merge into an existing default account connection when scoped rows do not collide", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-instance-legacy-merge-"));
  const dbPath = join(dir, "reference.sqlite");
  const oldInstanceId = oldLegacyDefaultConnectorInstanceId("owner_local", GMAIL);
  const defaultAccountInstanceId = makeDefaultAccountConnectorInstanceId("owner_local", GMAIL);

  try {
    const raw = new Database(dbPath);
    createLegacyInstanceMigrationFixture(raw, { defaultAccountInstanceId, oldInstanceId });
    insertRecordRow(raw, oldInstanceId, "legacy_msg", "legacy row");
    insertRecordRow(raw, defaultAccountInstanceId, "default_msg", "default row");
    raw.close();

    initDb(dbPath);
    const db = getDb();
    const retiredInstanceCount = db
      .prepare("SELECT COUNT(*) AS count FROM connector_instances WHERE connector_instance_id = ?")
      .get(oldInstanceId);
    const defaultRecordCount = db
      .prepare("SELECT COUNT(*) AS count FROM records WHERE connector_instance_id = ?")
      .get(defaultAccountInstanceId);
    assert.ok(retiredInstanceCount && defaultRecordCount, "migration count queries return their rows");
    assert.equal(retiredInstanceCount.count, 0);
    assert.equal(defaultRecordCount.count, 2);
    assert.deepEqual(
      db
        .prepare("SELECT record_key FROM records WHERE connector_instance_id = ? ORDER BY record_key")
        .all(defaultAccountInstanceId),
      [{ record_key: "default_msg" }, { record_key: "legacy_msg" }]
    );
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("legacy default merge aborts instead of overwriting colliding scoped rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-instance-legacy-collision-"));
  const dbPath = join(dir, "reference.sqlite");
  const oldInstanceId = oldLegacyDefaultConnectorInstanceId("owner_local", GMAIL);
  const defaultAccountInstanceId = makeDefaultAccountConnectorInstanceId("owner_local", GMAIL);

  try {
    const raw = new Database(dbPath);
    createLegacyInstanceMigrationFixture(raw, { defaultAccountInstanceId, oldInstanceId });
    insertRecordRow(raw, oldInstanceId, "same_msg", "legacy row");
    insertRecordRow(raw, defaultAccountInstanceId, "same_msg", "default row");
    raw.close();

    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.throws(() => initDb(dbPath), /records has a colliding row/);
    closeDb();

    const after = new Database(dbPath);
    try {
      const bothInstancesCount = after
        .prepare("SELECT COUNT(*) AS count FROM connector_instances WHERE connector_instance_id IN (?, ?)")
        .get(oldInstanceId, defaultAccountInstanceId) as { count: number } | undefined;
      assert.ok(bothInstancesCount, "connector_instances count row must exist");
      assert.equal(bothInstancesCount.count, 2);
      const oldInstanceRecordsCount = after
        .prepare("SELECT COUNT(*) AS count FROM records WHERE connector_instance_id = ?")
        .get(oldInstanceId) as { count: number } | undefined;
      assert.ok(oldInstanceRecordsCount, "records count row must exist for the old instance");
      assert.equal(oldInstanceRecordsCount.count, 1);
      const defaultInstanceRecordsCount = after
        .prepare("SELECT COUNT(*) AS count FROM records WHERE connector_instance_id = ?")
        .get(defaultAccountInstanceId) as { count: number } | undefined;
      assert.ok(defaultInstanceRecordsCount, "records count row must exist for the default-account instance");
      assert.equal(defaultInstanceRecordsCount.count, 1);
    } finally {
      after.close();
    }
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("legacy connector-keyed stores migrate to one deterministic default account instance per owner and connector without data loss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-instance-acceptance-"));
  const dbPath = join(dir, "reference.sqlite");
  const defaultAccountInstanceId = makeDefaultAccountConnectorInstanceId("owner_local", GMAIL);

  try {
    initDb(dbPath);
    await registerConnector(manifest(GMAIL));
    const db = getDb();
    db.exec(`
      DROP TABLE connector_state;
      CREATE TABLE connector_state (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_id, stream)
      );
      DROP TABLE grant_connector_state;
      CREATE TABLE grant_connector_state (
        grant_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(grant_id, connector_id, stream)
      );
      DROP TABLE records;
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        emitted_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        UNIQUE(connector_id, stream, record_key)
      );
      DROP TABLE record_changes;
      CREATE TABLE record_changes (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        record_json TEXT,
        emitted_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        PRIMARY KEY(connector_id, stream, version)
      );
      DROP TABLE version_counter;
      CREATE TABLE version_counter (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        max_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(connector_id, stream)
      );
      DROP TABLE blob_bindings;
      DROP TABLE blobs;
      CREATE TABLE blobs (
        blob_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        data BLOB
      );
      CREATE TABLE blob_bindings (
        blob_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        json_path TEXT NOT NULL DEFAULT '@record',
        PRIMARY KEY(blob_id, connector_id, stream, record_key, json_path)
      );
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
      DROP TABLE run_history;
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
      DROP TABLE connector_detail_gaps;
      CREATE TABLE connector_detail_gaps (
        gap_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        grant_id TEXT,
        source_json TEXT NOT NULL,
        stream TEXT NOT NULL,
        parent_stream TEXT,
        record_key TEXT,
        detail_locator_json TEXT,
        list_cursor_json TEXT,
        scope_json TEXT,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_after TEXT,
        last_error_json TEXT,
        discovered_run_id TEXT,
        last_run_id TEXT,
        recovered_run_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (status IN ('pending', 'in_progress', 'recovered', 'terminal'))
      );
      CREATE UNIQUE INDEX uniq_connector_detail_gaps_identity
        ON connector_detail_gaps(connector_id, ifnull(grant_id, ''), stream, ifnull(parent_stream, ''), ifnull(record_key, ''), ifnull(detail_locator_json, ''));
      CREATE INDEX idx_connector_detail_gaps_pending
        ON connector_detail_gaps(connector_id, grant_id, status, stream, next_attempt_after);
      DROP TABLE lexical_search_index;
      CREATE VIRTUAL TABLE lexical_search_index USING fts5(
        connector_id UNINDEXED,
        stream UNINDEXED,
        record_key UNINDEXED,
        field UNINDEXED,
        text,
        tokenize = 'unicode61'
      );
      DROP TABLE lexical_search_meta;
      CREATE TABLE lexical_search_meta (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(connector_id, stream)
      );
      DROP TABLE semantic_search_rowid;
      CREATE TABLE semantic_search_rowid (
        connector_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        record_key TEXT NOT NULL,
        rowid INTEGER NOT NULL,
        PRIMARY KEY(connector_id, scope_key, record_key)
      );
      DROP TABLE semantic_search_blob;
      CREATE TABLE semantic_search_blob (
        connector_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        record_key TEXT NOT NULL,
        embedding BLOB NOT NULL,
        PRIMARY KEY(connector_id, scope_key, record_key)
      );
      DROP TABLE semantic_search_meta;
      CREATE TABLE semantic_search_meta (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        distance_metric TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(connector_id, stream)
      );
      DROP TABLE semantic_search_backfill_progress;
      CREATE TABLE semantic_search_backfill_progress (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        distance_metric TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(connector_id, stream)
      );
    `);
    db.prepare("INSERT INTO connector_state VALUES(?, ?, ?, ?)").run(GMAIL, "messages", '{"cursor":"owner"}', NOW);
    db.prepare("INSERT INTO grant_connector_state VALUES(?, ?, ?, ?, ?)").run(
      "grant_1",
      GMAIL,
      "messages",
      '{"cursor":"grant"}',
      NOW
    );
    db.prepare(
      "INSERT INTO records(connector_id, stream, record_key, record_json, emitted_at, version) VALUES(?, ?, ?, ?, ?, ?)"
    ).run(GMAIL, "messages", "msg_1", '{"id":"msg_1","subject":"legacy"}', NOW, 7);
    db.prepare(
      "INSERT INTO record_changes(connector_id, stream, record_key, version, record_json, emitted_at) VALUES(?, ?, ?, ?, ?, ?)"
    ).run(GMAIL, "messages", "msg_1", 7, '{"id":"msg_1","subject":"legacy"}', NOW);
    db.prepare("INSERT INTO version_counter VALUES(?, ?, ?)").run(GMAIL, "messages", 7);
    db.prepare(
      "INSERT INTO blobs(blob_id, connector_id, stream, record_key, mime_type, size_bytes, sha256, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "blob_sha256_acceptance",
      GMAIL,
      "messages",
      "msg_1",
      "text/plain",
      5,
      "acceptance-sha",
      Buffer.from("hello")
    );
    db.prepare("INSERT INTO blob_bindings VALUES(?, ?, ?, ?, ?)").run(
      "blob_sha256_acceptance",
      GMAIL,
      "messages",
      "msg_1",
      "/body"
    );
    db.prepare("INSERT INTO connector_schedules VALUES(?, ?, ?, ?, ?, ?)").run(GMAIL, 900, 10, 1, NOW, NOW);
    // Detail-gap lease migration is a single-version deployment step: active
    // runs must be drained before bootstrap so their unleased work cannot be
    // reclaimed as retryable work. Keep terminal run history below, but do
    // not create an active-run row this deployment could not safely migrate.
    db.prepare(
      "INSERT INTO scheduler_run_history(connector_id, source_json, status, records_emitted, known_gaps_json, run_id, trace_id, started_at, completed_at, attempt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(GMAIL, "{}", "succeeded", 1, "[]", "run_history", "trc_history", NOW, NOW, 1);
    db.prepare("INSERT INTO scheduler_last_run_times VALUES(?, ?, ?)").run(GMAIL, 1_779_120_000_000, NOW);
    db.prepare(
      "INSERT INTO connector_detail_gaps(gap_id, connector_id, grant_id, source_json, stream, record_key, detail_locator_json, reason, status, attempt_count, discovered_run_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "gap_legacy",
      GMAIL,
      "grant_1",
      `{"connector_id":"${GMAIL}"}`,
      "messages",
      "msg_1",
      '{"path":"/thread"}',
      "detail unavailable",
      "pending",
      2,
      "run_legacy",
      NOW,
      NOW
    );
    db.prepare(
      "INSERT INTO lexical_search_index(connector_id, stream, record_key, field, text) VALUES(?, ?, ?, ?, ?)"
    ).run(GMAIL, "messages", "msg_1", "subject", "legacy lexical subject");
    db.prepare(
      "INSERT INTO lexical_search_meta(connector_id, stream, fields_fingerprint, updated_at) VALUES(?, ?, ?, ?)"
    ).run(GMAIL, "messages", "lexical-fingerprint", NOW);
    db.prepare("INSERT INTO semantic_search_rowid(connector_id, scope_key, record_key, rowid) VALUES(?, ?, ?, ?)").run(
      GMAIL,
      '["messages","subject"]',
      "msg_1",
      42
    );
    db.prepare(
      "INSERT INTO semantic_search_blob(connector_id, scope_key, record_key, embedding) VALUES(?, ?, ?, ?)"
    ).run(GMAIL, '["messages","subject"]', "msg_1", Buffer.from(new Float32Array([0.1, 0.2]).buffer));
    db.prepare(
      "INSERT INTO semantic_search_meta(connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)"
    ).run(GMAIL, "messages", "semantic-fingerprint", "test-embedding", 2, "cosine", NOW);
    db.prepare(
      "INSERT INTO semantic_search_backfill_progress(connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)"
    ).run(GMAIL, "messages", "semantic-progress", "test-embedding", 2, "cosine", NOW);
    closeDb();

    initDb(dbPath);
    const legacyState = await getSyncState(GMAIL);
    assert.equal(legacyState.connector_id, GMAIL);
    assert.equal(legacyState.connector_instance_id, defaultAccountInstanceId);
    assert.deepEqual(legacyState.state, { messages: { cursor: "owner" } });
    const migratedGrantState = getDb()
      .prepare("SELECT connector_instance_id FROM grant_connector_state WHERE grant_id = ?")
      .get("grant_1");
    const migratedRecord = getDb()
      .prepare("SELECT connector_instance_id FROM records WHERE record_key = ?")
      .get("msg_1");
    const migratedChange = getDb()
      .prepare("SELECT connector_instance_id FROM record_changes WHERE record_key = ?")
      .get("msg_1");
    const migratedCounter = getDb()
      .prepare("SELECT max_version FROM version_counter WHERE connector_instance_id = ?")
      .get(defaultAccountInstanceId);
    const migratedGap = getDb()
      .prepare("SELECT connector_instance_id FROM connector_detail_gaps WHERE gap_id = ?")
      .get("gap_legacy");
    const migratedLexicalMeta = getDb()
      .prepare("SELECT connector_instance_id FROM lexical_search_meta WHERE connector_id = ? AND stream = ?")
      .get(GMAIL, "messages");
    const migratedSemanticRowId = getDb()
      .prepare("SELECT connector_instance_id FROM semantic_search_rowid WHERE connector_id = ?")
      .get(GMAIL);
    const migratedSemanticBlob = getDb()
      .prepare("SELECT connector_instance_id FROM semantic_search_blob WHERE connector_id = ?")
      .get(GMAIL);
    const migratedSemanticMeta = getDb()
      .prepare("SELECT connector_instance_id FROM semantic_search_meta WHERE connector_id = ? AND stream = ?")
      .get(GMAIL, "messages");
    const migratedSemanticProgress = getDb()
      .prepare(
        "SELECT connector_instance_id FROM semantic_search_backfill_progress WHERE connector_id = ? AND stream = ?"
      )
      .get(GMAIL, "messages");
    assert.ok(
      migratedGrantState &&
        migratedRecord &&
        migratedChange &&
        migratedCounter &&
        migratedGap &&
        migratedLexicalMeta &&
        migratedSemanticRowId &&
        migratedSemanticBlob &&
        migratedSemanticMeta &&
        migratedSemanticProgress,
      "migrated rows are present"
    );
    assert.equal(migratedGrantState.connector_instance_id, defaultAccountInstanceId);
    assert.equal(migratedRecord.connector_instance_id, defaultAccountInstanceId);
    assert.equal(migratedChange.connector_instance_id, defaultAccountInstanceId);
    assert.equal(migratedCounter.max_version, 7);
    const blobBindings = await createSqliteBlobStore().listBlobBindings("blob_sha256_acceptance");
    assert.deepEqual(
      blobBindings
        .filter((row) => row.connector_instance_id)
        .map((row) => ({ connector_id: row.connector_id, record_key: row.record_key, stream: row.stream })),
      [{ connector_id: GMAIL, record_key: "msg_1", stream: "messages" }]
    );

    const scheduler = createSqliteSchedulerStore();
    const migratedSchedule = await scheduler.getSchedule(defaultAccountInstanceId);
    assert.ok(migratedSchedule, "schedule must exist for the default-account instance");
    assert.equal(migratedSchedule.interval_seconds, 900);
    assert.deepEqual(await scheduler.listActiveRuns(), [], "the legacy deployment was drained before lease migration");
    const runHistory = await scheduler.listRunHistory(10);
    const [firstRunHistoryEntry] = runHistory;
    assert.ok(firstRunHistoryEntry, "run history must have at least one entry");
    assert.equal(firstRunHistoryEntry.connectorInstanceId, defaultAccountInstanceId);
    const lastRunTimes = await scheduler.listLastRunTimes();
    const [firstLastRunTime] = lastRunTimes;
    assert.ok(firstLastRunTime, "last-run-times must have at least one entry");
    assert.equal(firstLastRunTime.connector_instance_id, defaultAccountInstanceId);
    assert.equal(migratedGap.connector_instance_id, defaultAccountInstanceId);
    assert.deepEqual(
      getDb()
        .prepare(
          "SELECT connector_instance_id, stream, record_key, field, text FROM lexical_search_index WHERE connector_id = ?"
        )
        .all(GMAIL),
      [
        {
          connector_instance_id: defaultAccountInstanceId,
          field: "subject",
          record_key: "msg_1",
          stream: "messages",
          text: "legacy lexical subject",
        },
      ]
    );
    assert.equal(migratedLexicalMeta.connector_instance_id, defaultAccountInstanceId);
    assert.equal(migratedSemanticRowId.connector_instance_id, defaultAccountInstanceId);
    assert.equal(migratedSemanticBlob.connector_instance_id, defaultAccountInstanceId);
    assert.equal(migratedSemanticMeta.connector_instance_id, defaultAccountInstanceId);
    assert.equal(migratedSemanticProgress.connector_instance_id, defaultAccountInstanceId);
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
});

test("two Gmail account instances isolate state, records, schedules, leases, and diagnostics", async () => {
  await withDb(async () => {
    const instances = createSqliteConnectorInstanceStore();
    await instances.upsert({
      connectorId: GMAIL,
      connectorInstanceId: "cin_gmail_work_acceptance",
      createdAt: NOW,
      displayName: "Gmail - work",
      ownerSubjectId: "owner_local",
      sourceBinding: { account_hint: "work@example.test" },
      sourceBindingKey: "work",
      sourceKind: "account",
      updatedAt: NOW,
    });
    await instances.upsert({
      connectorId: GMAIL,
      connectorInstanceId: "cin_gmail_personal_acceptance",
      createdAt: NOW,
      displayName: "Gmail - personal",
      ownerSubjectId: "owner_local",
      sourceBinding: { account_hint: "personal@example.test" },
      sourceBindingKey: "personal",
      sourceKind: "account",
      updatedAt: NOW,
    });

    const state = createSqliteConnectorStateStore();
    await state.putState(stateTarget(GMAIL, "cin_gmail_work_acceptance"), { messages: { cursor: "work" } });
    await state.putState(stateTarget(GMAIL, "cin_gmail_personal_acceptance"), { messages: { cursor: "personal" } });
    await ingestRecord(recordTarget(GMAIL, "cin_gmail_work_acceptance"), record("work"));
    await ingestRecord(recordTarget(GMAIL, "cin_gmail_personal_acceptance"), record("personal"));

    const scheduler = createSqliteSchedulerStore();
    scheduler.createSchedule({
      connector_id: GMAIL,
      connector_instance_id: "cin_gmail_work_acceptance",
      created_at: NOW,
      enabled: true,
      interval_seconds: 600,
      jitter_seconds: 0,
      updated_at: NOW,
    });
    scheduler.createSchedule({
      connector_id: GMAIL,
      connector_instance_id: "cin_gmail_personal_acceptance",
      created_at: NOW,
      enabled: false,
      interval_seconds: 1800,
      jitter_seconds: 0,
      updated_at: NOW,
    });
    scheduler.upsertActiveRun({
      connector_id: GMAIL,
      connector_instance_id: "cin_gmail_work_acceptance",
      run_generation: 1,
      run_id: "run_work_acceptance",
      scenario_id: "scn_work",
      started_at: NOW,
      trace_id: "trc_work",
    });
    scheduler.upsertActiveRun({
      connector_id: GMAIL,
      connector_instance_id: "cin_gmail_personal_acceptance",
      run_generation: 1,
      run_id: "run_personal_acceptance",
      scenario_id: "scn_personal",
      started_at: NOW,
      trace_id: "trc_personal",
    });

    const leases = createSqliteBrowserSurfaceLeaseStore();
    await leases.upsertLease({
      account_key: "work@example.test",
      connector_id: GMAIL,
      expires_at: "2026-05-18T12:05:00.000Z",
      fencing_token: 1,
      lease_id: "lease_work",
      priority_class: "background",
      profile_key: "cin_gmail_work_acceptance",
      requested_at: NOW,
      run_id: "run_work_acceptance",
      status: "waiting_for_browser_surface",
    });
    await leases.upsertLease({
      account_key: "personal@example.test",
      connector_id: GMAIL,
      expires_at: "2026-05-18T12:05:01.000Z",
      fencing_token: 1,
      lease_id: "lease_personal",
      priority_class: "background",
      profile_key: "cin_gmail_personal_acceptance",
      requested_at: NOW,
      run_id: "run_personal_acceptance",
      status: "waiting_for_browser_surface",
    });

    getDb()
      .prepare(
        "INSERT INTO spine_events(event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id, actor_type, actor_id, object_type, object_id, status, run_id, source_kind, source_id, data_json, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        "evt_work_diag",
        "connector.run.failed",
        NOW,
        NOW,
        "scn_work",
        "trc_work",
        "system",
        "runtime",
        "connector_run",
        "run_work_acceptance",
        "failed",
        "run_work_acceptance",
        "connector",
        "cin_gmail_work_acceptance",
        '{"connector_diagnostics":{"stderr_tail":{"text":"work failure"}}}',
        "0.1"
      );
    getDb()
      .prepare(
        "INSERT INTO spine_events(event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id, actor_type, actor_id, object_type, object_id, status, run_id, source_kind, source_id, data_json, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        "evt_personal_diag",
        "connector.run.failed",
        NOW,
        NOW,
        "scn_personal",
        "trc_personal",
        "system",
        "runtime",
        "connector_run",
        "run_personal_acceptance",
        "failed",
        "run_personal_acceptance",
        "connector",
        "cin_gmail_personal_acceptance",
        '{"connector_diagnostics":{"stderr_tail":{"text":"personal failure"}}}',
        "0.1"
      );

    assert.deepEqual((await state.getState(stateTarget(GMAIL, "cin_gmail_work_acceptance"))).state.messages, {
      cursor: "work",
    });
    assert.deepEqual((await state.getState(stateTarget(GMAIL, "cin_gmail_personal_acceptance"))).state.messages, {
      cursor: "personal",
    });
    const workRecords = await queryRecords(
      recordTarget(GMAIL, "cin_gmail_work_acceptance"),
      "messages",
      { streams: [{ fields: ["id", "subject"], name: "messages" }] },
      { changes_since: "beginning" },
      manifest(GMAIL)
    );
    const personalRecords = await queryRecords(
      recordTarget(GMAIL, "cin_gmail_personal_acceptance"),
      "messages",
      { streams: [{ fields: ["id", "subject"], name: "messages" }] },
      { changes_since: "beginning" },
      manifest(GMAIL)
    );
    assert.deepEqual(
      workRecords.data.map((row) => {
        assert.ok(row.data, "each returned work record carries data");
        return row.data.subject;
      }),
      ["work"]
    );
    assert.deepEqual(
      personalRecords.data.map((row) => {
        assert.ok(row.data, "each returned personal record carries data");
        return row.data.subject;
      }),
      ["personal"]
    );
    const workSchedule = await scheduler.getSchedule("cin_gmail_work_acceptance");
    assert.ok(workSchedule, "work schedule must exist");
    assert.equal(workSchedule.interval_seconds, 600);
    const personalSchedule = await scheduler.getSchedule("cin_gmail_personal_acceptance");
    assert.ok(personalSchedule, "personal schedule must exist");
    assert.equal(personalSchedule.interval_seconds, 1800);
    const activeRuns = await scheduler.listActiveRuns();
    assert.deepEqual(activeRuns.map((row) => row.run_id).sort(), ["run_personal_acceptance", "run_work_acceptance"]);
    const workLease = await leases.getLease("lease_work");
    assert.ok(workLease, "work lease must exist");
    assert.equal(workLease.profile_key, "cin_gmail_work_acceptance");
    const personalLease = await leases.getLease("lease_personal");
    assert.ok(personalLease, "personal lease must exist");
    assert.equal(personalLease.profile_key, "cin_gmail_personal_acceptance");
    assert.deepEqual(
      getDb()
        .prepare(
          "SELECT source_id, json_extract(data_json, '$.connector_diagnostics.stderr_tail.text') AS text FROM spine_events WHERE event_id LIKE ? ORDER BY source_id"
        )
        .all("evt_%_diag"),
      [
        { source_id: "cin_gmail_personal_acceptance", text: "personal failure" },
        { source_id: "cin_gmail_work_acceptance", text: "work failure" },
      ]
    );
  });
});

test("Claude and Codex collectors on two devices keep checkpoints and records separate", async () => {
  await withDb(async () => {
    const instances = createSqliteConnectorInstanceStore();
    await instances.upsert({
      connectorId: LOCAL,
      connectorInstanceId: "cin_local_claude_laptop",
      createdAt: NOW,
      displayName: "Claude laptop",
      ownerSubjectId: "owner_local",
      sourceBinding: { device_id: "dev_laptop", local_binding_id: "claude" },
      sourceBindingKey: "dev_laptop:claude",
      sourceKind: "local_device",
      updatedAt: NOW,
    });
    await instances.upsert({
      connectorId: LOCAL,
      connectorInstanceId: "cin_local_codex_desktop",
      createdAt: NOW,
      displayName: "Codex desktop",
      ownerSubjectId: "owner_local",
      sourceBinding: { device_id: "dev_desktop", local_binding_id: "codex" },
      sourceBindingKey: "dev_desktop:codex",
      sourceKind: "local_device",
      updatedAt: NOW,
    });

    const devices = createSqliteDeviceExporterStore();
    devices.createDevice({
      createdAt: NOW,
      deviceId: "dev_laptop",
      displayName: "Laptop",
      ownerSubjectId: "owner_local",
      updatedAt: NOW,
    });
    devices.createDevice({
      createdAt: NOW,
      deviceId: "dev_desktop",
      displayName: "Desktop",
      ownerSubjectId: "owner_local",
      updatedAt: NOW,
    });
    devices.upsertSourceInstance({
      connectorId: LOCAL,
      createdAt: NOW,
      deviceId: "dev_laptop",
      displayName: "Claude",
      localBindingId: "claude",
      sourceInstanceId: "src_claude",
      updatedAt: NOW,
    });
    devices.upsertSourceInstance({
      connectorId: LOCAL,
      createdAt: NOW,
      deviceId: "dev_desktop",
      displayName: "Codex",
      localBindingId: "codex",
      sourceInstanceId: "src_codex",
      updatedAt: NOW,
    });
    devices.recordBatchOutcome({
      batchId: "batch_1",
      bodyHash: "sha256:laptop",
      createdAt: NOW,
      deviceId: "dev_laptop",
      httpStatus: 202,
      response: { accepted: 1 },
      sourceInstanceId: "src_claude",
      status: "accepted",
    });
    devices.recordBatchOutcome({
      batchId: "batch_1",
      bodyHash: "sha256:desktop",
      createdAt: NOW,
      deviceId: "dev_desktop",
      httpStatus: 202,
      response: { accepted: 1 },
      sourceInstanceId: "src_codex",
      status: "accepted",
    });

    const state = createSqliteConnectorStateStore();
    await state.putState(stateTarget(LOCAL, "cin_local_claude_laptop"), { events: { cursor: "claude-checkpoint" } });
    await state.putState(stateTarget(LOCAL, "cin_local_codex_desktop"), { events: { cursor: "codex-checkpoint" } });
    await ingestRecord(recordTarget(LOCAL, "cin_local_claude_laptop"), {
      ...record("claude event", "event_1"),
      stream: "events",
    });
    await ingestRecord(recordTarget(LOCAL, "cin_local_codex_desktop"), {
      ...record("codex event", "event_1"),
      stream: "events",
    });

    assert.deepEqual((await state.getState(stateTarget(LOCAL, "cin_local_claude_laptop"))).state.events, {
      cursor: "claude-checkpoint",
    });
    assert.deepEqual((await state.getState(stateTarget(LOCAL, "cin_local_codex_desktop"))).state.events, {
      cursor: "codex-checkpoint",
    });
    assert.deepEqual(
      getDb()
        .prepare(
          "SELECT connector_instance_id, json_extract(record_json, '$.subject') AS subject FROM records WHERE connector_id = ? ORDER BY connector_instance_id"
        )
        .all(LOCAL),
      [
        { connector_instance_id: "cin_local_claude_laptop", subject: "claude event" },
        { connector_instance_id: "cin_local_codex_desktop", subject: "codex event" },
      ]
    );
    assert.deepEqual(
      devices
        .listBatchOutcomes({ limit: 10 })
        .filter((row) => row !== null)
        .map((row) => [row.deviceId, row.batchId, row.bodyHash, row.sourceInstanceId])
        .sort(),
      [
        ["dev_desktop", "batch_1", "sha256:desktop", "src_codex"],
        ["dev_laptop", "batch_1", "sha256:laptop", "src_claude"],
      ]
    );
  });
});
