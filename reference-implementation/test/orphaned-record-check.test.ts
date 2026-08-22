// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time record-attribution consistency check.
 *
 * The condition under test is the one that stranded 172,781 of the owner's
 * records: `records` has no foreign key to `connector_instances`, so deleting
 * a connection leaves its rows behind, attributable to nothing. Every owner
 * surface enumerates connections from `connector_instances`, so those rows
 * become invisible everywhere (standing principle P1).
 *
 * These tests pin the three properties that make the check worth having:
 * it FINDS a strand, it stays SILENT-but-positive on a clean database, and it
 * does not mistake a record whose connection still exists for a strand.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { checkOrphanedRecordsAtBoot, findOrphanedRecords } from "../lib/orphaned-record-check.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

// The owner-facing consequence the strand message must state — not merely a
// count, which would leave a reader unaware the data is unreachable.
const OWNER_CONSEQUENCE_REGEX = /not visible on any owner surface/;

interface CapturedLog {
  readonly level: "error" | "info";
  readonly msg: string;
  readonly obj: Record<string, unknown>;
}

function capturingLogger() {
  const entries: CapturedLog[] = [];
  return {
    entries,
    error: (obj: Record<string, unknown>, msg: string) => entries.push({ level: "error", msg, obj }),
    info: (obj: Record<string, unknown>, msg: string) => entries.push({ level: "info", msg, obj }),
  };
}

// `connector_instances.connector_id` is FK-constrained to `connectors`, so a
// connector row must exist first. Notably `records` carries NO such
// constraint back to `connector_instances` — which is exactly the schema gap
// that lets a connection delete strand its records.
function insertConnector(connectorId: string) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO connectors (connector_id, manifest, created_at) VALUES (?, '{}', '2026-08-01T00:00:00.000Z')`
    )
    .run(connectorId);
}

function insertConnection(connectorInstanceId: string, connectorId: string) {
  insertConnector(connectorId);
  getDb()
    .prepare(
      `INSERT INTO connector_instances
         (connector_instance_id, owner_subject_id, connector_id, display_name, status,
          source_kind, source_binding_key, source_binding_json, created_at, updated_at)
       VALUES (?, 'owner_test', ?, ?, 'active', 'account', ?, '{"kind":"account"}',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`
    )
    .run(connectorInstanceId, connectorId, connectorId, `account:${connectorInstanceId}`);
}

function insertRecord(
  connectorInstanceId: string,
  connectorId: string,
  stream: string,
  recordKey: string,
  { deleted = false }: { deleted?: boolean } = {}
) {
  getDb()
    .prepare(
      `INSERT INTO records
         (connector_id, connector_instance_id, stream, record_key, record_json,
          emitted_at, semantic_time, version, deleted)
       VALUES (?, ?, ?, ?, '{}', '2026-08-01T00:00:00.000Z', '', 1, ?)`
    )
    .run(connectorId, connectorInstanceId, stream, recordKey, deleted ? 1 : 0);
}

async function withDb(fn: () => Promise<void> | void) {
  const dbPath = makeTemporaryDbPath("pdpp-orphan-check-");
  await initDb(dbPath);
  try {
    await fn();
  } finally {
    closeDb();
  }
}

test("a live record whose connection row is gone is reported as orphaned", async () => {
  await withDb(async () => {
    // A connection that still exists, and one that has been deleted out from
    // under its records — exactly the shape a connection delete leaves behind.
    insertConnection("cin_live", "gmail");
    insertRecord("cin_live", "gmail", "messages", "k1");
    insertRecord("cin_gone", "amazon", "orders", "k1");
    insertRecord("cin_gone", "amazon", "orders", "k2");
    insertRecord("cin_gone", "amazon", "order_items", "k3");

    const result = await findOrphanedRecords();

    assert.equal(result.orphanedInstanceCount, 1, "only the connection-less instance counts");
    assert.equal(result.orphanedRecordCount, 3, "every live record under it counts");
    assert.deepEqual(
      result.groups.map((g) => g.connectorInstanceId),
      ["cin_gone"],
      "the live connection's records must never be reported as stranded"
    );
    assert.equal(result.groups[0]?.streams, 2, "distinct streams are counted, not rows");
  });
});

test("a deleted (tombstoned) record under a missing connection is not counted as live", async () => {
  await withDb(async () => {
    insertRecord("cin_gone", "amazon", "orders", "k1", { deleted: true });

    const result = await findOrphanedRecords();

    assert.equal(result.orphanedRecordCount, 0, "soft-deleted rows are already invisible by intent");
    assert.equal(result.orphanedInstanceCount, 0);
  });
});

test("boot check logs at error level and names the stranded instance", async () => {
  await withDb(async () => {
    insertRecord("cin_gone", "amazon", "orders", "k1");
    const logger = capturingLogger();

    await checkOrphanedRecordsAtBoot(logger);

    const errors = logger.entries.filter((e) => e.level === "error");
    assert.equal(errors.length, 1, "a strand must be reported exactly once, at error level");
    assert.equal(errors[0]?.obj.orphaned_records, 1);
    assert.equal(errors[0]?.obj.orphaned_instances, 1);
    assert.match(
      String(errors[0]?.msg),
      OWNER_CONSEQUENCE_REGEX,
      "the message must state the owner-visible consequence, not just the count"
    );
  });
});

test("a clean database reports positively rather than silently", async () => {
  await withDb(async () => {
    insertConnection("cin_live", "gmail");
    insertRecord("cin_live", "gmail", "messages", "k1");
    const logger = capturingLogger();

    const result = await checkOrphanedRecordsAtBoot(logger);

    assert.equal(result.orphanedRecordCount, 0);
    assert.equal(logger.entries.filter((e) => e.level === "error").length, 0, "no strand, no error");
    assert.equal(
      logger.entries.filter((e) => e.level === "info").length,
      1,
      "silence is indistinguishable from a check that never ran"
    );
  });
});
