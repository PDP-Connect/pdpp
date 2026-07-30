// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getConnectorListSummaryTerminalProjection,
  getConnectorListSummaryTerminalProjectionBatch,
  getConnectorSummaryEvidence,
  listConnectorSummaryEvidence,
  markAllConnectorSummaryEvidenceDirty,
  markConnectorSummaryEvidenceDirty,
  publishConnectorListSummaryTerminalProjection,
  rebuildConnectorSummaryEvidence,
  reconcileDirtyConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const OWNER = "owner_local";
const NOW = "2026-06-17T12:00:00.000Z";

// `stream_records` on a shaped evidence row is parsed from durable JSON
// (`parseEvidenceJson`), so `shapeEvidenceRow`'s inferred return type carries
// it as `unknown`. This mirrors the entries the rebuild actually derives per
// canonical stream (`connector-summary-evidence-engine.ts`'s
// addStreamRecordEvidence) — genuinely module-private, so it is declared
// locally rather than imported.
interface StreamRecordEvidence {
  count_state: string;
  declaration_state: string;
  record_count: number;
  retained_record_count: number;
  stream: string;
}

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-connector-summary-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

// ── SQLite-host seeding helpers ──────────────────────────────────────────────

function seedConnectorSqlite(connectorId: string) {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
}

function seedInstanceSqlite({
  connectorInstanceId,
  connectorId,
  displayName = connectorId,
  status = "active",
  sourceKind = "account",
  revokedAt = null,
}: {
  connectorInstanceId: string;
  connectorId: string;
  displayName?: string;
  status?: string;
  sourceKind?: string;
  revokedAt?: string | null;
}) {
  seedConnectorSqlite(connectorId);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`
    )
    .run(
      connectorInstanceId,
      OWNER,
      connectorId,
      displayName,
      status,
      sourceKind,
      connectorInstanceId,
      NOW,
      NOW,
      revokedAt
    );
}

// Seed the maintained retained_size_stream rows directly — that projection is
// the canonical source the connector-summary rebuild reads for record counts.
// Seeding it directly isolates this module from the full ingest + lexical
// pipeline (which validates manifests), the same way the retained-size tests
// rebuild from canonical rows rather than coupling to every downstream hook.
function seedRetainedSizeStreamSqlite({
  connectorInstanceId,
  connectorId,
  stream,
  recordCount,
  computedAt = NOW,
}: {
  connectorInstanceId: string;
  connectorId: string;
  stream: string;
  recordCount: number;
  computedAt?: string;
}) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream, record_count, dirty, computed_at
       )
       VALUES(?, ?, ?, ?, 0, ?)
       ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
         record_count = excluded.record_count,
         computed_at = excluded.computed_at`
    )
    .run(connectorInstanceId, connectorId, stream, recordCount, computedAt);
}

// dirty is explicitly 0: the new evidence engine's retained_bytes component
// only reads current_record_json_bytes/record_history_json_bytes/blob_bytes
// when the source row is clean (design.md: retained-size rows are
// authoritative for byte measures ONLY when clean), so a fixture standing
// in for "the retained-size projection already converged" must say so.
function seedRetainedSizeConnectionSqlite({
  connectorInstanceId,
  connectorId,
  recordJsonBytes = 0,
  recordChangesJsonBytes = 0,
  blobBytes = 0,
  computedAt = NOW,
}: {
  connectorInstanceId: string;
  connectorId: string;
  recordJsonBytes?: number;
  recordChangesJsonBytes?: number;
  blobBytes?: number;
  computedAt?: string;
}) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id, current_record_json_bytes,
         record_history_json_bytes, blob_bytes, dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(connector_instance_id) DO UPDATE SET
         connector_id = excluded.connector_id,
         current_record_json_bytes = excluded.current_record_json_bytes,
         record_history_json_bytes = excluded.record_history_json_bytes,
         blob_bytes = excluded.blob_bytes,
         dirty = 0,
         computed_at = excluded.computed_at`
    )
    .run(connectorInstanceId, connectorId, recordJsonBytes, recordChangesJsonBytes, blobBytes, computedAt);
}

function seedRecordSqlite({
  connectorInstanceId,
  connectorId,
  stream,
  recordKey,
  emittedAt,
  deleted = false,
}: {
  connectorInstanceId: string;
  connectorId: string;
  stream: string;
  recordKey: string;
  emittedAt: string;
  deleted?: boolean;
}) {
  getDb()
    .prepare(
      `INSERT INTO records(
         connector_id, connector_instance_id, stream, record_key, record_json,
         emitted_at, version, deleted, deleted_at
       )
       VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      connectorId,
      connectorInstanceId,
      stream,
      recordKey,
      JSON.stringify({ id: recordKey }),
      emittedAt,
      deleted ? 1 : 0,
      deleted ? emittedAt : null
    );
}

// ── SQLite tests ─────────────────────────────────────────────────────────────

test("rebuild derives durable identity + count evidence from canonical state", () =>
  withTempDb(async () => {
    seedInstanceSqlite({ connectorId: "gmail", connectorInstanceId: "cin_gmail_a", displayName: "Gmail personal" });
    seedRetainedSizeStreamSqlite({
      computedAt: "2026-06-17T13:30:00.000Z",
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      recordCount: 2,
      stream: "messages",
    });
    seedRetainedSizeStreamSqlite({
      computedAt: "2026-06-17T13:45:00.000Z",
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      recordCount: 1,
      stream: "attachments",
    });
    seedRetainedSizeConnectionSqlite({
      blobBytes: 4600,
      computedAt: "2026-06-17T13:45:00.000Z",
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      recordChangesJsonBytes: 340,
      recordJsonBytes: 1200,
    });
    seedRecordSqlite({
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      emittedAt: "2026-06-17T12:30:00.000Z",
      recordKey: "msg_1",
      stream: "messages",
    });
    seedRecordSqlite({
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      emittedAt: "2026-06-17T12:45:00.000Z",
      recordKey: "msg_2",
      stream: "messages",
    });
    seedRecordSqlite({
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      emittedAt: "2026-06-17T12:55:00.000Z",
      recordKey: "att_1",
      stream: "attachments",
    });
    seedRecordSqlite({
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      deleted: true,
      emittedAt: "2026-06-17T14:00:00.000Z",
      recordKey: "deleted_future",
      stream: "messages",
    });

    const rows = await rebuildConnectorSummaryEvidence();
    assert.equal(rows.length, 1);
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const row = rows[0];
    assert.ok(row, "rebuild must materialize a row for the seeded connection");
    assert.equal(row.connector_instance_id, "cin_gmail_a");
    assert.equal(row.connector_id, "gmail");
    assert.equal(row.display_name, "Gmail personal");
    assert.equal(row.status, "active");
    assert.equal(row.source_kind, "account");
    assert.equal(row.revoked_at, null);
    // Canonical `records WHERE deleted = false` is the count authority
    // (design.md), not the retained-size projection — 3 live records
    // (2 messages + 1 attachment), the future-dated deleted row excluded.
    assert.equal(row.total_records, 3);
    assert.equal(row.stream_count, 2);
    assert.equal(row.last_record_updated_at, "2026-06-17T12:55:00.000Z");
    assert.deepEqual(
      [...(row.stream_records as StreamRecordEvidence[])].sort((a, b) => a.stream.localeCompare(b.stream)),
      [
        {
          count_state: "known",
          declaration_state: "unavailable",
          record_count: 1,
          retained_record_count: 1,
          stream: "attachments",
        },
        {
          count_state: "known",
          declaration_state: "unavailable",
          record_count: 2,
          retained_record_count: 2,
          stream: "messages",
        },
      ]
    );
    // The seeded manifest has no streams array, so manifest_declaration is
    // unavailable and every canonical stream's declaration_state reads
    // "unavailable" too (design.md: "unexpected" is never asserted without
    // a successfully parsed manifest) — the honest unavailable contract,
    // not a defect.
    assert.equal(row.manifest_declaration.state, "unavailable");
    assert.deepEqual(row.retained_bytes, {
      blob_bytes: 4600,
      record_changes_json_bytes: 340,
      record_json_bytes: 1200,
      total_bytes: 6140,
    });
    assert.equal(row.total_retained_bytes, 6140);
    assert.equal(row.dirty, false);
    assert.equal(row.state, "fresh");
    assert.equal(row.last_error, null);
  }));

test("rebuild keeps connections with zero records as honest empty evidence", () =>
  withTempDb(async () => {
    seedInstanceSqlite({ connectorId: "notion", connectorInstanceId: "cin_empty", displayName: "Notion" });
    const rows = await rebuildConnectorSummaryEvidence();
    assert.equal(rows.length, 1);
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const row = rows[0];
    assert.ok(row, "rebuild must materialize a row for the seeded connection");
    assert.equal(row.total_records, 0);
    assert.equal(row.stream_count, 0);
    assert.equal(row.last_record_updated_at, null);
    assert.equal(row.dirty, false);
    assert.equal(row.state, "fresh");
  }));

test("terminal LIST projection is published only from current canonical evidence and becomes stale without GET repair", () =>
  withTempDb(async () => {
    const connectorId = "terminal_projection";
    const connectorInstanceId = "cin_terminal_projection";
    seedInstanceSqlite({ connectorId, connectorInstanceId });
    getDb()
      .prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?")
      .run(
        JSON.stringify({ connector_id: connectorId, streams: [{ name: "messages", primary_key: ["id"] }] }),
        connectorId
      );
    await rebuildConnectorSummaryEvidence();
    const initialEvidence = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.ok(initialEvidence, "bounded canonical read must materialize the evidence row");

    const before = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.deepEqual(before, {
      computed_at: null,
      projection: null,
      reason_code: null,
      state: "unobserved",
    });
    assert.equal(
      await publishConnectorListSummaryTerminalProjection({
        canonicalEvidenceRevision: initialEvidence.canonical_evidence_revision,
        computedAt: "2026-07-30T18:00:00.000Z",
        connectorInstanceId,
        projection: {
          runtime: null,
          summary: {
            connection_health: { state: "unknown" },
            connection_id: connectorInstanceId,
            connector_id: connectorId,
            schedule: null,
            total_records: 0,
          },
        },
      }),
      true
    );
    const published = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(published.state, "current");
    assert.deepEqual(published.projection?.summary, {
      connection_health: { state: "unknown" },
      connection_id: connectorInstanceId,
      connector_id: connectorId,
      schedule: null,
      total_records: 0,
    });

    await rebuildConnectorSummaryEvidence();
    const rebuilt = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(rebuilt.state, "stale", "canonical rebuild invalidates a previously published terminal payload");
    assert.equal(rebuilt.projection, null);
    assert.equal(rebuilt.reason_code, "canonical_evidence_rebuilt");
    const rebuiltEvidence = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.ok(rebuiltEvidence, "bounded canonical read must retain the evidence row after rebuild");
    assert.equal(
      await publishConnectorListSummaryTerminalProjection({
        canonicalEvidenceRevision: rebuiltEvidence.canonical_evidence_revision,
        computedAt: "2026-07-30T18:01:00.000Z",
        connectorInstanceId,
        projection: {
          runtime: null,
          summary: {
            connection_health: { state: "unknown" },
            connection_id: connectorInstanceId,
            connector_id: connectorId,
            schedule: null,
            total_records: 0,
          },
        },
      }),
      true
    );

    const beforeReadRow = getDb().prepare("SELECT total_changes() AS changes").get<{ changes: number }>();
    assert.ok(beforeReadRow);
    const totalChangesBeforeRead = beforeReadRow.changes;
    await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    const afterReadRow = getDb().prepare("SELECT total_changes() AS changes").get<{ changes: number }>();
    assert.ok(afterReadRow);
    const totalChangesAfterRead = afterReadRow.changes;
    assert.equal(totalChangesAfterRead, totalChangesBeforeRead, "terminal LIST read must not repair or write");

    await markConnectorSummaryEvidenceDirty({ connectorInstanceId, reason: "record mutation" });
    const stale = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(stale.state, "stale");
    assert.equal(stale.projection, null, "a stale payload is not reusable truth");
    assert.equal(stale.reason_code, "canonical_evidence_dirty");
  }));

test("terminal LIST rejects a late canonical snapshot after rebuild or dirty", () =>
  withTempDb(async () => {
    const connectorId = "terminal_snapshot_fence";
    const connectorInstanceId = "cin_terminal_snapshot_fence";
    seedInstanceSqlite({ connectorId, connectorInstanceId });
    getDb()
      .prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?")
      .run(
        JSON.stringify({ connector_id: connectorId, streams: [{ name: "messages", primary_key: ["id"] }] }),
        connectorId
      );
    await rebuildConnectorSummaryEvidence();
    const snapshotA = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.ok(snapshotA, "A is one bounded canonical-evidence read");

    await rebuildConnectorSummaryEvidence();
    const snapshotB = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.ok(snapshotB, "B is one bounded canonical-evidence read");
    assert.notEqual(snapshotB.canonical_evidence_revision, snapshotA.canonical_evidence_revision);
    assert.equal(
      await publishConnectorListSummaryTerminalProjection({
        canonicalEvidenceRevision: snapshotA.canonical_evidence_revision,
        computedAt: "2026-07-30T18:02:00.000Z",
        connectorInstanceId,
        projection: {
          runtime: null,
          summary: { connection_id: connectorInstanceId, connector_id: connectorId, total_records: 999 },
        },
      }),
      false,
      "rebuild B must reject a late A-derived payload"
    );
    assert.equal((await getConnectorListSummaryTerminalProjection(connectorInstanceId)).projection, null);

    await markConnectorSummaryEvidenceDirty({ connectorInstanceId, reason: "race mutation" });
    assert.equal(
      await publishConnectorListSummaryTerminalProjection({
        canonicalEvidenceRevision: snapshotB.canonical_evidence_revision,
        computedAt: "2026-07-30T18:03:00.000Z",
        connectorInstanceId,
        projection: {
          runtime: null,
          summary: { connection_id: connectorInstanceId, connector_id: connectorId, total_records: 998 },
        },
      }),
      false,
      "dirty B must reject a late B-derived payload"
    );
    const terminal = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(terminal.state, "stale");
    assert.equal(terminal.projection, null, "neither late payload may become current truth");
  }));

test("terminal LIST batch getter returns exact current/stale/unobserved/failed envelopes for N=0/1/25/100 and rejects over-bound", () =>
  withTempDb(async () => {
    const totalConnections = 100;
    const connectorId = "batch_terminal_projection";
    const ids = Array.from({ length: totalConnections }, (_, i) => `cin_batch_${i}`);
    for (const connectorInstanceId of ids) {
      seedInstanceSqlite({ connectorId, connectorInstanceId });
    }
    getDb()
      .prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?")
      .run(
        JSON.stringify({ connector_id: connectorId, streams: [{ name: "messages", primary_key: ["id"] }] }),
        connectorId
      );
    await rebuildConnectorSummaryEvidence();

    // N=0: no ids requested returns an empty map without touching storage.
    assert.deepEqual(await getConnectorListSummaryTerminalProjectionBatch([]), new Map());

    // Publish current projections for a subset; leave others unobserved; mark
    // one dirty (stale).
    const currentIds = ids.slice(0, 25);
    for (const connectorInstanceId of currentIds) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential publication keeps each connection's evidence revision unambiguous for this fixture.
      const evidence = await getConnectorSummaryEvidence(connectorInstanceId);
      assert.ok(evidence, "rebuild must materialize evidence for every seeded connection");
      const published = await publishConnectorListSummaryTerminalProjection({
        canonicalEvidenceRevision: evidence.canonical_evidence_revision,
        computedAt: "2026-07-30T19:00:00.000Z",
        connectorInstanceId,
        projection: {
          runtime: null,
          summary: { connection_id: connectorInstanceId, connector_id: connectorId, total_records: 0 },
        },
      });
      assert.equal(published, true);
    }
    const [staleId] = ids.slice(25, 26);
    assert.ok(staleId);
    const staleEvidence = await getConnectorSummaryEvidence(staleId);
    assert.ok(staleEvidence);
    assert.equal(
      await publishConnectorListSummaryTerminalProjection({
        canonicalEvidenceRevision: staleEvidence.canonical_evidence_revision,
        computedAt: "2026-07-30T19:00:00.000Z",
        connectorInstanceId: staleId,
        projection: {
          runtime: null,
          summary: { connection_id: staleId, connector_id: connectorId, total_records: 0 },
        },
      }),
      true
    );
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId: staleId, reason: "batch fixture" });

    // N=1
    const oneResult = await getConnectorListSummaryTerminalProjectionBatch([currentIds[0] as string]);
    assert.equal(oneResult.size, 1);
    assert.equal(oneResult.get(currentIds[0] as string)?.state, "current");

    // N=25: every requested id has an entry; current ids are current, the
    // rest of this 25-window is unobserved (never published).
    const twentyFiveWindow = ids.slice(0, 25);
    const twentyFiveResult = await getConnectorListSummaryTerminalProjectionBatch(twentyFiveWindow);
    assert.equal(twentyFiveResult.size, 25);
    for (const id of twentyFiveWindow) {
      assert.equal(twentyFiveResult.get(id)?.state, "current", `expected ${id} current`);
    }

    // N=100 (the full bound): every requested id has exactly one entry, no
    // id silently dropped, states are exact per fixture.
    const fullResult = await getConnectorListSummaryTerminalProjectionBatch(ids);
    assert.equal(fullResult.size, totalConnections);
    for (const id of currentIds) {
      assert.equal(fullResult.get(id)?.state, "current", `expected ${id} current`);
    }
    assert.equal(fullResult.get(staleId)?.state, "stale");
    assert.equal(fullResult.get(staleId)?.projection, null);
    const [neverPublishedId] = ids.slice(50, 51);
    assert.ok(neverPublishedId);
    assert.deepEqual(fullResult.get(neverPublishedId), {
      computed_at: null,
      projection: null,
      reason_code: null,
      state: "unobserved",
    });
    const missingId = "cin_never_existed";
    assert.deepEqual(
      await getConnectorListSummaryTerminalProjectionBatch([missingId]),
      new Map([
        [
          missingId,
          {
            computed_at: null,
            projection: null,
            reason_code: "summary_missing",
            state: "unobserved",
          },
        ],
      ])
    );

    // Duplicate ids collapse to one entry, not a wider read.
    const dupResult = await getConnectorListSummaryTerminalProjectionBatch([
      currentIds[0] as string,
      currentIds[0] as string,
    ]);
    assert.equal(dupResult.size, 1);

    // Over-bound (101 ids) is rejected outright rather than silently truncated.
    await assert.rejects(
      () => getConnectorListSummaryTerminalProjectionBatch([...ids, "cin_batch_overflow"]),
      RangeError
    );

    // The batch read never writes: total_changes() is unchanged across the call.
    const beforeReadRow = getDb().prepare("SELECT total_changes() AS changes").get<{ changes: number }>();
    assert.ok(beforeReadRow);
    await getConnectorListSummaryTerminalProjectionBatch(ids);
    const afterReadRow = getDb().prepare("SELECT total_changes() AS changes").get<{ changes: number }>();
    assert.ok(afterReadRow);
    assert.equal(afterReadRow.changes, beforeReadRow.changes, "terminal LIST batch read must not repair or write");
  }));

test("rebuild materializes revoked lifecycle evidence without dropping the row", () =>
  withTempDb(async () => {
    seedInstanceSqlite({
      connectorId: "slack",
      connectorInstanceId: "cin_revoked",
      displayName: "Slack workspace",
      revokedAt: "2026-06-10T00:00:00.000Z",
      status: "revoked",
    });
    const rows = await rebuildConnectorSummaryEvidence();
    assert.equal(rows.length, 1);
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const row = rows[0];
    assert.ok(row, "rebuild must materialize a row for the seeded connection");
    assert.equal(row.status, "revoked");
    assert.equal(row.revoked_at, "2026-06-10T00:00:00.000Z");
  }));

test("rebuild drops evidence rows for connections that no longer exist", () =>
  withTempDb(async () => {
    seedInstanceSqlite({ connectorId: "gmail", connectorInstanceId: "cin_keep" });
    seedInstanceSqlite({ connectorId: "oura", connectorInstanceId: "cin_drop" });
    await rebuildConnectorSummaryEvidence();
    assert.equal((await listConnectorSummaryEvidence()).length, 2);

    getDb().prepare("DELETE FROM connector_instances WHERE connector_instance_id = ?").run("cin_drop");
    const rows = await rebuildConnectorSummaryEvidence();
    assert.deepEqual(
      rows.map((r) => r.connector_instance_id),
      ["cin_keep"]
    );
  }));

test("dirty marking flips state to stale and reconcile repairs only dirty rows", () =>
  withTempDb(async () => {
    seedInstanceSqlite({ connectorId: "gmail", connectorInstanceId: "cin_gmail_a" });
    seedRetainedSizeStreamSqlite({
      computedAt: "2026-06-17T13:10:00.000Z",
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      recordCount: 1,
      stream: "messages",
    });
    seedRetainedSizeConnectionSqlite({
      blobBytes: 0,
      computedAt: "2026-06-17T13:10:00.000Z",
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      recordChangesJsonBytes: 10,
      recordJsonBytes: 100,
    });
    seedRecordSqlite({
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      emittedAt: "2026-06-17T12:10:00.000Z",
      recordKey: "msg_1",
      stream: "messages",
    });
    await rebuildConnectorSummaryEvidence();
    const initial = await getConnectorSummaryEvidence("cin_gmail_a");
    assert.ok(initial, "evidence row must exist after rebuild");
    assert.equal(initial.total_records, 1);

    // A new record lands; the ingest seam would mark the connection dirty.
    // Model that by bumping the canonical retained-size count, then dirtying.
    seedRetainedSizeStreamSqlite({
      computedAt: "2026-06-17T13:45:00.000Z",
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      recordCount: 2,
      stream: "messages",
    });
    seedRetainedSizeConnectionSqlite({
      blobBytes: 9,
      computedAt: "2026-06-17T13:45:00.000Z",
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      recordChangesJsonBytes: 20,
      recordJsonBytes: 240,
    });
    seedRecordSqlite({
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      emittedAt: "2026-06-17T12:45:00.000Z",
      recordKey: "msg_2",
      stream: "messages",
    });
    seedRecordSqlite({
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_a",
      deleted: true,
      emittedAt: "2026-06-17T14:00:00.000Z",
      recordKey: "deleted_future",
      stream: "messages",
    });
    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId: "cin_gmail_a",
      reason: "record ingest changed count",
      sourceEventSeq: 42,
    });

    const dirty = await getConnectorSummaryEvidence("cin_gmail_a");
    assert.ok(dirty, "evidence row must exist after dirty marking");
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.state, "stale");
    assert.equal(dirty.source_event_seq, 42);
    // Durable count is the pre-dirty snapshot until reconcile runs.
    assert.equal(dirty.total_records, 1);
    assert.equal(dirty.last_record_updated_at, "2026-06-17T12:10:00.000Z");

    const { reconciled } = await reconcileDirtyConnectorSummaryEvidence();
    assert.equal(reconciled, 1);
    const clean = await getConnectorSummaryEvidence("cin_gmail_a");
    assert.ok(clean, "evidence row must exist after reconcile");
    assert.equal(clean.dirty, false);
    assert.equal(clean.state, "fresh");
    assert.equal(clean.total_records, 2);
    assert.equal(clean.last_record_updated_at, "2026-06-17T12:45:00.000Z");
    assert.deepEqual(clean.stream_records, [
      {
        count_state: "known",
        declaration_state: "unavailable",
        record_count: 2,
        retained_record_count: 2,
        stream: "messages",
      },
    ]);
    assert.deepEqual(clean.retained_bytes, {
      blob_bytes: 9,
      record_changes_json_bytes: 20,
      record_json_bytes: 240,
      total_bytes: 269,
    });
    assert.equal(clean.total_retained_bytes, 269);
  }));

test("reconcile is a no-op when no rows are dirty", () =>
  withTempDb(async () => {
    seedInstanceSqlite({ connectorId: "gmail", connectorInstanceId: "cin_a" });
    await rebuildConnectorSummaryEvidence();
    const { reconciled } = await reconcileDirtyConnectorSummaryEvidence();
    assert.equal(reconciled, 0);
  }));

test("reconcile drops a dirty row whose connection was deleted", () =>
  withTempDb(async () => {
    seedInstanceSqlite({ connectorId: "gmail", connectorInstanceId: "cin_gone" });
    seedInstanceSqlite({ connectorId: "oura", connectorInstanceId: "cin_stay" });
    await rebuildConnectorSummaryEvidence();

    markConnectorSummaryEvidenceDirtySync("cin_gone", "connection deleted");
    getDb().prepare("DELETE FROM connector_instances WHERE connector_instance_id = ?").run("cin_gone");

    const { reconciled } = await reconcileDirtyConnectorSummaryEvidence();
    assert.equal(reconciled, 1);
    assert.deepEqual(
      (await listConnectorSummaryEvidence()).map((r) => r.connector_instance_id),
      ["cin_stay"]
    );
  }));

test("markAll dirties every maintained row", () =>
  withTempDb(async () => {
    seedInstanceSqlite({ connectorId: "gmail", connectorInstanceId: "cin_a" });
    seedInstanceSqlite({ connectorId: "oura", connectorInstanceId: "cin_b" });
    await rebuildConnectorSummaryEvidence();
    await markAllConnectorSummaryEvidenceDirty("bulk write");
    const rows = await listConnectorSummaryEvidence();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.dirty === true && r.state === "stale"));
  }));

test("persisted evidence never carries synthesized health/verdict columns", () =>
  withTempDb(async () => {
    seedInstanceSqlite({ connectorId: "gmail", connectorInstanceId: "cin_a" });
    await rebuildConnectorSummaryEvidence();
    const columns = (
      getDb().prepare("SELECT name FROM pragma_table_info('connector_summary_evidence')").all() as { name: string }[]
    ).map((r) => r.name);
    for (const forbidden of [
      "freshness",
      "connection_health",
      "rendered_verdict",
      "next_action",
      "collection_report",
    ]) {
      assert.equal(columns.includes(forbidden), false, `evidence must not persist ${forbidden}`);
    }
    assert.equal(columns.includes("last_record_updated_at"), true);
  }));

// A synchronous dirty-marker shim for the SQLite host so the "connection
// deleted" test can dirty a row and then delete its connection in the same
// tick without awaiting. Mirrors markConnectorSummaryEvidenceDirty's SQLite arm.
function markConnectorSummaryEvidenceDirtySync(connectorInstanceId: string, reason: string) {
  getDb()
    .prepare(
      `UPDATE connector_summary_evidence
          SET dirty = 1, state = 'stale', last_error = ?
        WHERE connector_instance_id = ?`
    )
    .run(reason, connectorInstanceId);
}

// ── Postgres parity test (gated on PDPP_TEST_POSTGRES_URL) ───────────────────

test("Postgres connector-summary evidence reaches the same rebuild/dirty/reconcile shape", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const connectorId = "pg_summary_connector";
  const instanceId = "cin_pg_summary_a";
  try {
    await cleanupPostgres(connectorId, instanceId);
    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
         VALUES($1, $2::jsonb, $3) ON CONFLICT(connector_id) DO NOTHING`,
      [connectorId, JSON.stringify({ connector_id: connectorId }), NOW]
    );
    await postgresQuery(
      `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         )
         VALUES($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
      [instanceId, OWNER, connectorId, "PG summary", NOW]
    );
    await seedRetainedSizeStreamPostgres(instanceId, connectorId, "messages", 1, "2026-06-17T13:20:00.000Z");
    await seedRetainedSizeConnectionPostgres(instanceId, connectorId, 510, 40, 900, "2026-06-17T13:20:00.000Z");
    await seedRecordPostgres(instanceId, connectorId, "messages", "msg_1", "2026-06-17T12:20:00.000Z");

    const rows = await rebuildConnectorSummaryEvidence();
    const row = rows.find((r) => r.connector_instance_id === instanceId);
    assert.ok(row, "rebuild should materialize the pg connection");
    assert.equal(row.connector_id, connectorId);
    assert.equal(row.total_records, 1);
    assert.equal(row.stream_count, 1);
    assert.equal(row.last_record_updated_at, "2026-06-17T12:20:00.000Z");
    assert.deepEqual(row.stream_records, [
      {
        count_state: "known",
        declaration_state: "unavailable",
        record_count: 1,
        retained_record_count: 1,
        stream: "messages",
      },
    ]);
    assert.deepEqual(row.retained_bytes, {
      blob_bytes: 900,
      record_changes_json_bytes: 40,
      record_json_bytes: 510,
      total_bytes: 1450,
    });
    assert.equal(row.total_retained_bytes, 1450);
    assert.equal(row.dirty, false);
    assert.equal(row.state, "fresh");

    await seedRetainedSizeStreamPostgres(instanceId, connectorId, "messages", 2, "2026-06-17T13:50:00.000Z");
    await seedRetainedSizeConnectionPostgres(instanceId, connectorId, 725, 80, 1200, "2026-06-17T13:50:00.000Z");
    await seedRecordPostgres(instanceId, connectorId, "messages", "msg_2", "2026-06-17T12:50:00.000Z");
    await seedRecordPostgres(instanceId, connectorId, "messages", "deleted_future", "2026-06-17T14:00:00.000Z", true);
    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId: instanceId,
      reason: "pg ingest",
      sourceEventSeq: 7,
    });
    const dirty = await getConnectorSummaryEvidence(instanceId);
    assert.ok(dirty, "evidence row must exist after dirty marking");
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.state, "stale");
    assert.equal(dirty.source_event_seq, 7);
    assert.equal(dirty.total_records, 1);
    assert.equal(dirty.last_record_updated_at, "2026-06-17T12:20:00.000Z");

    const { reconciled } = await reconcileDirtyConnectorSummaryEvidence();
    assert.ok(reconciled >= 1);
    const clean = await getConnectorSummaryEvidence(instanceId);
    assert.ok(clean, "evidence row must exist after reconcile");
    assert.equal(clean.dirty, false);
    assert.equal(clean.state, "fresh");
    assert.equal(clean.total_records, 2);
    assert.equal(clean.last_record_updated_at, "2026-06-17T12:50:00.000Z");
    assert.deepEqual(clean.stream_records, [
      {
        count_state: "known",
        declaration_state: "unavailable",
        record_count: 2,
        retained_record_count: 2,
        stream: "messages",
      },
    ]);
    assert.deepEqual(clean.retained_bytes, {
      blob_bytes: 1200,
      record_changes_json_bytes: 80,
      record_json_bytes: 725,
      total_bytes: 2005,
    });
    assert.equal(clean.total_retained_bytes, 2005);
  } finally {
    await cleanupPostgres(connectorId, instanceId);
    await closePostgresStorage();
  }
});

test("Postgres terminal LIST projection rejects late canonical snapshots", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const connectorId = "pg_terminal_projection";
  const connectorInstanceId = "cin_pg_terminal_projection";
  try {
    await cleanupPostgres(connectorId, connectorInstanceId);
    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES($1, $2::jsonb, $3)`,
      [
        connectorId,
        JSON.stringify({ connector_id: connectorId, streams: [{ name: "messages", primary_key: ["id"] }] }),
        NOW,
      ]
    );
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
      [connectorInstanceId, OWNER, connectorId, "PG terminal summary", NOW]
    );
    await rebuildConnectorSummaryEvidence();
    const snapshotA = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.ok(snapshotA, "A is one bounded canonical-evidence read");
    assert.equal(
      await publishConnectorListSummaryTerminalProjection({
        canonicalEvidenceRevision: snapshotA.canonical_evidence_revision,
        computedAt: "2026-07-30T18:00:00.000Z",
        connectorInstanceId,
        projection: {
          runtime: null,
          summary: {
            connection_health: { state: "unknown" },
            connection_id: connectorInstanceId,
            connector_id: connectorId,
          },
        },
      }),
      true
    );
    assert.equal((await getConnectorListSummaryTerminalProjection(connectorInstanceId)).state, "current");
    await rebuildConnectorSummaryEvidence();
    assert.equal(
      await publishConnectorListSummaryTerminalProjection({
        canonicalEvidenceRevision: snapshotA.canonical_evidence_revision,
        computedAt: "2026-07-30T18:01:00.000Z",
        connectorInstanceId,
        projection: {
          runtime: null,
          summary: { connection_id: connectorInstanceId, connector_id: connectorId, total_records: 999 },
        },
      }),
      false,
      "Postgres rebuild B must reject a late A-derived payload"
    );
    const snapshotB = await getConnectorSummaryEvidence(connectorInstanceId);
    assert.ok(snapshotB, "B is one bounded canonical-evidence read");
    await markConnectorSummaryEvidenceDirty({ connectorInstanceId, reason: "postgres mutation" });
    assert.equal(
      await publishConnectorListSummaryTerminalProjection({
        canonicalEvidenceRevision: snapshotB.canonical_evidence_revision,
        computedAt: "2026-07-30T18:02:00.000Z",
        connectorInstanceId,
        projection: {
          runtime: null,
          summary: { connection_id: connectorInstanceId, connector_id: connectorId, total_records: 998 },
        },
      }),
      false,
      "Postgres dirty B must reject a late B-derived payload"
    );
    const stale = await getConnectorListSummaryTerminalProjection(connectorInstanceId);
    assert.equal(stale.state, "stale");
    assert.equal(stale.projection, null);
  } finally {
    await cleanupPostgres(connectorId, connectorInstanceId);
    await closePostgresStorage();
  }
});

async function seedRetainedSizeStreamPostgres(
  instanceId: string,
  connectorId: string,
  stream: string,
  recordCount: number,
  computedAt: string = NOW
) {
  await postgresQuery(
    `INSERT INTO retained_size_stream(
       connector_instance_id, connector_id, stream, record_count, dirty, computed_at
     )
     VALUES($1, $2, $3, $4, 0, $5)
     ON CONFLICT (connector_instance_id, stream) DO UPDATE SET
       record_count = EXCLUDED.record_count,
       computed_at = EXCLUDED.computed_at`,
    [instanceId, connectorId, stream, recordCount, computedAt]
  );
}

async function seedRetainedSizeConnectionPostgres(
  instanceId: string,
  connectorId: string,
  recordJsonBytes: number,
  recordChangesJsonBytes: number,
  blobBytes: number,
  computedAt: string = NOW
) {
  await postgresQuery(
    `INSERT INTO retained_size_connection(
       connector_instance_id, connector_id, current_record_json_bytes,
       record_history_json_bytes, blob_bytes, dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, 0, $6)
     ON CONFLICT (connector_instance_id) DO UPDATE SET
       connector_id = EXCLUDED.connector_id,
       current_record_json_bytes = EXCLUDED.current_record_json_bytes,
       record_history_json_bytes = EXCLUDED.record_history_json_bytes,
       blob_bytes = EXCLUDED.blob_bytes,
       dirty = 0,
       computed_at = EXCLUDED.computed_at`,
    [instanceId, connectorId, recordJsonBytes, recordChangesJsonBytes, blobBytes, computedAt]
  );
}

async function seedRecordPostgres(
  instanceId: string,
  connectorId: string,
  stream: string,
  recordKey: string,
  emittedAt: string,
  deleted = false
) {
  await postgresQuery(
    `INSERT INTO records(
       connector_id, connector_instance_id, stream, record_key, record_json,
       emitted_at, version, deleted, deleted_at, primary_key_text
     )
     VALUES($1, $2, $3, $4, $5::jsonb, $6, 1, $7, $8, $4)`,
    [
      connectorId,
      instanceId,
      stream,
      recordKey,
      JSON.stringify({ id: recordKey }),
      emittedAt,
      deleted,
      deleted ? emittedAt : null,
    ]
  );
}

async function cleanupPostgres(connectorId: string, instanceId: string) {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [instanceId]);
  await postgresQuery("DELETE FROM retained_size_stream WHERE connector_instance_id = $1", [instanceId]);
  await postgresQuery("DELETE FROM retained_size_connection WHERE connector_instance_id = $1", [instanceId]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [instanceId]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [instanceId]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
}
