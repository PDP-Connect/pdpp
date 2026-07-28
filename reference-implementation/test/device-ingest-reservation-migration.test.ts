// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

const RE_CHECK_CONSTRAINT_FAILED = /CHECK constraint failed/;
const RE_ACCEPTED_COMPLETE_CHECK = /device_ingest_batch_outcomes_accepted_complete_check/;

function createLegacySqliteOutcome(db: ReturnType<typeof getDb>): void {
  db.prepare(`
    INSERT INTO device_exporters(device_id, owner_subject_id, display_name, created_at, updated_at)
    VALUES('dev_migration', 'owner_migration', 'Migration device', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z')
  `).run();
  db.exec("DROP TABLE device_ingest_batch_outcomes");
  db.exec(`
    CREATE TABLE device_ingest_batch_outcomes (
      device_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      source_instance_id TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(device_id, batch_id, body_hash),
      UNIQUE(device_id, batch_id)
    );
  `);
  db.prepare(`
    INSERT INTO device_ingest_batch_outcomes(
      device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at
    ) VALUES(?, ?, ?, ?, 'accepted', 201, ?, ?)
  `).run(
    "dev_migration",
    "batch_migration",
    "a".repeat(64),
    "src_migration",
    JSON.stringify({ accepted_record_count: 3, rejected_record_count: 0 }),
    "2026-07-16T00:00:00.000Z"
  );
}

test("SQLite migrates legacy accepted outcomes to complete terminal reservations", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-device-ingest-migration-"));
  const dbPath = path.join(tempDir, "reference.sqlite");
  try {
    initDb(dbPath);
    createLegacySqliteOutcome(getDb());
    initDb(dbPath);
    const migrated = getDb()
      .prepare(`
      SELECT status, record_count, durable_prefix_count, manifest_fingerprint,
             semantic_capability_identity, accepted_at
        FROM device_ingest_batch_outcomes
       WHERE device_id = 'dev_migration'
    `)
      .get();
    assert.deepEqual(migrated, {
      accepted_at: "2026-07-16T00:00:00.000Z",
      durable_prefix_count: 3,
      manifest_fingerprint: "",
      record_count: 3,
      semantic_capability_identity: "",
      status: "accepted",
    });
    const checks = getDb().prepare("PRAGMA table_info(device_ingest_batch_outcomes)").all();
    assert.ok((checks as Array<{ name: string }>).some((column) => column.name === "durable_prefix_count"));
    assert.throws(
      () =>
        getDb()
          .prepare(`
        INSERT INTO device_ingest_batch_outcomes(
          device_id, batch_id, body_hash, source_instance_id, status,
          record_count, durable_prefix_count, created_at
        ) VALUES(?, 'batch_bad', ?, 'src_bad', 'accepted', 2, 1, '2026-07-16T00:00:00.000Z')
      `)
          .run("dev_migration", "c".repeat(64)),
      RE_CHECK_CONSTRAINT_FAILED
    );
  } finally {
    closeDb();
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

const postgresEnabled = DEDICATED_POSTGRES_URL !== null;

test("Postgres migrates legacy accepted outcomes to equal named terminal cursor facts", {
  skip: !postgresEnabled,
}, async () => {
  const databaseUrl = DEDICATED_POSTGRES_URL ?? "";
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    await postgresQuery("DROP TABLE IF EXISTS device_ingest_batch_outcomes");
    await postgresQuery(`
      CREATE TABLE device_ingest_batch_outcomes (
        device_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        source_instance_id TEXT NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER NOT NULL,
        response_json JSONB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(device_id, batch_id, body_hash),
        UNIQUE(device_id, batch_id)
      )
    `);
    await postgresQuery(
      `INSERT INTO device_ingest_batch_outcomes(
        device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at
      ) VALUES($1, $2, $3, $4, 'accepted', 201, $5::jsonb, $6)`,
      [
        "dev_migration_pg",
        "batch_migration_pg",
        "b".repeat(64),
        "src_migration_pg",
        JSON.stringify({ accepted_record_count: 4, rejected_record_count: 0 }),
        "2026-07-16T00:00:00.000Z",
      ]
    );
    await bootstrapPostgresSchema();
    const pgResult = await postgresQuery(`
      SELECT status, record_count, durable_prefix_count, manifest_fingerprint,
             semantic_capability_identity, accepted_at
        FROM device_ingest_batch_outcomes
       WHERE device_id = 'dev_migration_pg'
    `);
    assert.deepEqual(pgResult.rows[0], {
      accepted_at: "2026-07-16T00:00:00.000Z",
      durable_prefix_count: 4,
      manifest_fingerprint: "",
      record_count: 4,
      semantic_capability_identity: "",
      status: "accepted",
    });
    const constraints = await postgresQuery(`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'device_ingest_batch_outcomes'::regclass
         AND conname IN (
           'device_ingest_batch_outcomes_state_check',
           'device_ingest_batch_outcomes_prefix_check',
           'device_ingest_batch_outcomes_accepted_complete_check'
         )
       ORDER BY conname
    `);
    assert.deepEqual(
      constraints.rows.map((constraint) => constraint.conname),
      [
        "device_ingest_batch_outcomes_accepted_complete_check",
        "device_ingest_batch_outcomes_prefix_check",
        "device_ingest_batch_outcomes_state_check",
      ]
    );
    await assert.rejects(
      () =>
        postgresQuery(`
        INSERT INTO device_ingest_batch_outcomes(
          device_id, batch_id, body_hash, source_instance_id, status,
          record_count, durable_prefix_count, created_at
        ) VALUES('dev_bad_pg', 'batch_bad_pg', repeat('c', 64), 'src_bad_pg', 'accepted', 2, 1, '2026-07-16T00:00:00.000Z')
      `),
      RE_ACCEPTED_COMPLETE_CHECK
    );
  } finally {
    await closePostgresStorage();
  }
});
