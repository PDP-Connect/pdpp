// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";
import {
  getRetainedSizeGlobal,
  listRetainedSizeConnections,
  listRetainedSizeRecordFamilies,
  listRetainedSizeStreams,
  listRetainedSizeTop,
  markRetainedSizeConnectionDirty,
  markRetainedSizeDirty,
  rebuildRetainedSize,
  reconcileDirtyRetainedSize,
} from "../server/retained-size-read-model.ts";

async function withTempDb<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-retained-size-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

const storage = {
  connector_id: "test.connector",
  connector_instance_id: "cin_test_retained_size",
};

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

// `getRetainedSizeGlobal()` shapes its return via a union of two internal
// `.js` helpers (present vs. missing row); TS's structural inference over
// that union drops the spread-derived measure fields even though both
// branches populate them at runtime (server/retained-size-read-model.js
// shapePresentGlobalRow / shapeMissingGlobalRow). This extends the
// inferred base shape (via `& typeof`, not a disjoint `as`) with the
// measure fields the tests read, so the assertion stays anchored to the
// function's real inferred type instead of drifting from it.
type RetainedSizeGlobalRow = Awaited<ReturnType<typeof getRetainedSizeGlobal>> & {
  blob_bytes: number;
  blob_count: number;
  current_record_json_bytes: number;
  record_count: number;
  record_history_count: number;
  record_history_json_bytes: number;
};

test("retained-size rebuild derives global, connection, stream, and top rows from canonical state", () =>
  withTempDb(async () => {
    const one = { body: "hello", id: "one" };
    const two = { body: "hello world", id: "two" };
    await ingestRecord(storage, {
      data: one,
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "one",
      stream: "messages",
    });
    await ingestRecord(storage, {
      data: two,
      emitted_at: "2026-01-02T00:00:00.000Z",
      key: "two",
      stream: "files",
    });

    await rebuildRetainedSize();

    const expectedBytes = jsonBytes(one) + jsonBytes(two);
    const global = (await getRetainedSizeGlobal()) as RetainedSizeGlobalRow;
    assert.equal(global.record_count, 2);
    assert.equal(global.current_record_json_bytes, expectedBytes);
    assert.equal(global.record_history_count, 2);
    assert.equal(global.record_history_json_bytes, expectedBytes);
    assert.equal(global.dirty, false);
    assert.equal(global.metadata.state, "fresh");

    const connections = await listRetainedSizeConnections({ connectorInstanceId: storage.connector_instance_id });
    assert.equal(connections.length, 1);
    assert.equal(mustExist(connections[0], "connection projection must exist").total_retained_bytes, expectedBytes * 2);

    const streams = await listRetainedSizeStreams({ connectorInstanceId: storage.connector_instance_id });
    // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
    assert.deepEqual(streams.map((row) => row.stream).sort(), ["files", "messages"]);

    const topConnections = await listRetainedSizeTop({
      limit: 5,
      measure: "total_retained_bytes",
      scope: "connection",
    });
    const topConnection = mustExist(topConnections[0], "connection top row must exist");
    assert.equal(topConnection.connector_instance_id, storage.connector_instance_id);
    assert.equal(topConnection.dirty, false);

    const topRecords = await listRetainedSizeTop({
      limit: 1,
      measure: "current_record_json_bytes",
      scope: "record",
    });
    assert.equal(topRecords.length, 1);
    assert.equal(mustExist(topRecords[0], "record top row must exist").record_key, "two");
  }));

test("SQLite retained-size top rows preserve rejection byte and count measures after reconcile", () =>
  withTempDb(async () => {
    const payloadBytes = 11;
    getDb()
      .prepare(
        `INSERT INTO retained_size_connection(
           connector_instance_id, connector_id, record_rejection_payload_bytes,
           record_rejection_count, dirty
         )
         VALUES(?, ?, ?, ?, 0)`
      )
      .run("cin_rejection_top", "test.connector", payloadBytes, 1);
    getDb()
      .prepare(
        `INSERT INTO retained_size_stream(
           connector_instance_id, connector_id, stream, record_rejection_payload_bytes,
           record_rejection_count, dirty
         )
         VALUES(?, ?, ?, ?, ?, 0)`
      )
      .run("cin_rejection_top", "test.connector", "items", payloadBytes, 1);

    await reconcileDirtyRetainedSize();

    const [topConnection] = await listRetainedSizeTop({
      limit: 1,
      measure: "record_rejection_payload_bytes",
      scope: "connection",
    });
    const connectionTop = mustExist(topConnection, "connection rejection top row must exist");
    assert.equal(connectionTop.record_rejection_payload_bytes, 11);
    assert.equal(connectionTop.record_rejection_count, 1);
    assert.equal(connectionTop.total_retained_bytes, 11);

    const [topStream] = await listRetainedSizeTop({
      limit: 1,
      measure: "record_rejection_payload_bytes",
      scope: "stream",
    });
    const streamTop = mustExist(topStream, "stream rejection top row must exist");
    assert.equal(streamTop.record_rejection_payload_bytes, 11);
    assert.equal(streamTop.record_rejection_count, 1);
    assert.equal(streamTop.total_retained_bytes, 11);
  }));

test("retained-size record deltas update exact rows and mark top-N rows stale", () =>
  withTempDb(async () => {
    await ingestRecord(storage, {
      data: { body: "hello", id: "one" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "one",
      stream: "messages",
    });
    await rebuildRetainedSize();

    await ingestRecord(storage, {
      data: { body: "hello again", id: "one" },
      emitted_at: "2026-01-03T00:00:00.000Z",
      key: "one",
      stream: "messages",
    });

    const global = (await getRetainedSizeGlobal()) as RetainedSizeGlobalRow;
    assert.equal(global.record_count, 1);
    assert.equal(global.record_history_count, 2);
    assert.equal(global.dirty, false);

    const streams = await listRetainedSizeStreams({ connectorInstanceId: storage.connector_instance_id });
    const stream = mustExist(streams[0], "stream projection must exist");
    assert.equal(stream.record_count, 1);
    assert.equal(stream.record_history_count, 2);

    const staleTop = await listRetainedSizeTop({
      limit: 1,
      measure: "total_retained_bytes",
      scope: "connection",
    });
    const staleConnection = mustExist(staleTop[0], "stale connection top row must exist");
    assert.equal(staleConnection.dirty, true);
    assert.equal(mustExist(staleConnection.metadata, "stale top row must carry metadata").state, "stale");

    await reconcileDirtyRetainedSize();
    const freshTop = await listRetainedSizeTop({
      limit: 1,
      measure: "total_retained_bytes",
      scope: "connection",
    });
    assert.equal(mustExist(freshTop[0], "fresh connection top row must exist").dirty, false);
  }));

test("retained-size reconcile repairs global-only dirty metadata when row grains are clean", () =>
  withTempDb(async () => {
    await ingestRecord(storage, {
      data: { body: "hello", id: "one" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "one",
      stream: "messages",
    });
    await rebuildRetainedSize();

    await markRetainedSizeConnectionDirty({ connectorInstanceId: null });

    const dirtyGlobal = await getRetainedSizeGlobal();
    assert.equal(dirtyGlobal.dirty, true);
    assert.equal(dirtyGlobal.metadata.state, "stale");
    assert.equal(dirtyGlobal.metadata.last_error, "bulk write on unknown connection");

    const [cleanConnection] = await listRetainedSizeConnections({
      connectorInstanceId: storage.connector_instance_id,
    });
    const [cleanStream] = await listRetainedSizeStreams({
      connectorInstanceId: storage.connector_instance_id,
      stream: "messages",
    });
    assert.equal(mustExist(cleanConnection, "clean connection must exist").dirty, false);
    assert.equal(mustExist(cleanStream, "clean stream must exist").dirty, false);

    const result = await reconcileDirtyRetainedSize();
    assert.deepEqual(result, { connections: 0, streams: 0 });

    const freshGlobal = await getRetainedSizeGlobal();
    assert.equal(freshGlobal.dirty, false);
    assert.equal(freshGlobal.metadata.state, "fresh");
    assert.equal(freshGlobal.metadata.last_error, null);
  }));

test("retained-size rebuild attributes blob bytes through blob bindings", () =>
  withTempDb(async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("blob_sha256_x", "other.connector", "cin_other", "other", "r0", "text/plain", 7, "x", Buffer.from("payload"));
    db.prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES(?, ?, ?, ?, ?, '@record')`
    ).run("blob_sha256_x", storage.connector_id, storage.connector_instance_id, "messages", "one");

    await rebuildRetainedSize();

    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const connection = (await listRetainedSizeConnections({ connectorInstanceId: storage.connector_instance_id }))[0];
    const retainedConnection = mustExist(connection, "connection projection must exist");
    assert.equal(retainedConnection.blob_count, 1);
    assert.equal(retainedConnection.blob_bytes, 7);

    const blobTop = await listRetainedSizeTop({ limit: 1, measure: "blob_bytes", scope: "blob" });
    const topBlob = mustExist(blobTop[0], "blob top row must exist");
    assert.equal(topBlob.blob_id, "blob_sha256_x");
    assert.equal(topBlob.connector_instance_id, storage.connector_instance_id);
  }));

test("retained-size record total top rows include current, history, and blobs", () =>
  withTempDb(async () => {
    const first = { body: "small", id: "one" };
    const second = { body: "larger body", id: "one" };
    await ingestRecord(storage, {
      data: first,
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "one",
      stream: "messages",
    });
    await ingestRecord(storage, {
      data: second,
      emitted_at: "2026-01-02T00:00:00.000Z",
      key: "one",
      stream: "messages",
    });
    getDb()
      .prepare(
        `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "blob_sha256_record_total",
        storage.connector_id,
        storage.connector_instance_id,
        "messages",
        "one",
        "text/plain",
        37,
        "record_total",
        Buffer.from("payload")
      );
    getDb()
      .prepare(
        `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES(?, ?, ?, ?, ?, '@record')`
      )
      .run("blob_sha256_record_total", storage.connector_id, storage.connector_instance_id, "messages", "one");

    await rebuildRetainedSize();

    const [topRecord] = await listRetainedSizeTop({
      limit: 1,
      measure: "total_retained_bytes",
      scope: "record",
    });
    const currentBytes = jsonBytes(second);
    const historyBytes = jsonBytes(first) + jsonBytes(second);
    const retainedTopRecord = mustExist(topRecord, "record top row must exist");
    assert.equal(retainedTopRecord.record_key, "one");
    assert.equal(retainedTopRecord.current_record_json_bytes, currentBytes);
    assert.equal(retainedTopRecord.record_history_json_bytes, historyBytes);
    assert.equal(retainedTopRecord.blob_bytes, 37);
    assert.equal(retainedTopRecord.total_retained_bytes, currentBytes + historyBytes + 37);
  }));

test("retained-size record-family grain reads authored projection rows", () =>
  withTempDb(async () => {
    getDb()
      .prepare(
        `INSERT INTO retained_size_record_family(
         connector_instance_id, connector_id, stream, record_family,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        storage.connector_instance_id,
        storage.connector_id,
        "messages",
        "thread",
        11,
        13,
        17,
        2,
        3,
        4,
        "2026-01-01T00:00:00.000Z"
      );

    const [row] = await listRetainedSizeRecordFamilies({
      connectorInstanceId: storage.connector_instance_id,
      recordFamily: "thread",
      stream: "messages",
    });
    const recordFamily = mustExist(row, "record-family projection must exist");
    assert.equal(recordFamily.grain, "record_family");
    assert.equal(recordFamily.record_family, "thread");
    assert.equal(recordFamily.total_retained_bytes, 41);
    assert.equal(recordFamily.record_count, 2);
    assert.equal(recordFamily.record_history_count, 3);
    assert.equal(recordFamily.blob_count, 4);
  }));

// Regression tests for the `connector_id` filter on listRetainedSizeStreams.
//
// `/_ref/dataset/summary/streams` accepts an optional `?connector_id=...`
// query parameter and forwards it as `{ connectorId }` to this helper.
// An earlier draft of that route incorrectly forwarded the value as
// `{ connectorInstanceId }`, which produced empty or wrong-connector
// results whenever the connector had more than one instance. These
// tests pin the helper's `connector_id` semantics so a future drive-by
// edit (or a future Postgres-only refactor) cannot silently regress.
test("listRetainedSizeStreams: connectorId filter narrows by connector_id, not by connector_instance_id", () =>
  withTempDb(async () => {
    const alpha = {
      connector_id: "alpha.connector",
      connector_instance_id: "cin_alpha_a",
    };
    const beta = {
      connector_id: "beta.connector",
      connector_instance_id: "cin_beta_b",
    };
    await ingestRecord(alpha, {
      data: { id: "a-msg" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "a-msg",
      stream: "messages",
    });
    await ingestRecord(beta, {
      data: { id: "b-msg" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "b-msg",
      stream: "messages",
    });
    await rebuildRetainedSize();

    // Both helpers respect the new connectorId filter — neither test
    // pre-supposes Postgres backend selection.
    const alphaRows = await listRetainedSizeStreams({ connectorId: alpha.connector_id });
    assert.equal(alphaRows.length, 1, "connectorId filter should narrow to exactly one connector");
    const alphaRow = mustExist(alphaRows[0], "alpha stream projection must exist");
    assert.equal(alphaRow.connector_id, alpha.connector_id);
    assert.equal(alphaRow.connector_instance_id, alpha.connector_instance_id);
    assert.equal(alphaRow.stream, "messages");

    const betaRows = await listRetainedSizeStreams({ connectorId: beta.connector_id });
    assert.equal(betaRows.length, 1);
    assert.equal(mustExist(betaRows[0], "beta stream projection must exist").connector_id, beta.connector_id);

    // Bug-catch: passing alpha's `connector_id` value through the
    // `connectorInstanceId` slot must NOT silently match alpha. The two
    // connectors here have *different* connector_instance_ids than
    // connector_ids, so a route that confuses the slots would either
    // return zero rows or match the wrong connector.
    const wrongSlot = await listRetainedSizeStreams({
      connectorInstanceId: alpha.connector_id,
    });
    assert.deepEqual(wrongSlot, [], "connectorInstanceId filter must NOT match a connector_id value");
  }));

test("listRetainedSizeStreams: connectorId and stream filters compose", () =>
  withTempDb(async () => {
    const alpha = {
      connector_id: "alpha.connector",
      connector_instance_id: "cin_alpha_a",
    };
    const beta = {
      connector_id: "beta.connector",
      connector_instance_id: "cin_beta_b",
    };
    for (const account of [alpha, beta]) {
      const msgKey = `${account.connector_id}-msg`;
      const fileKey = `${account.connector_id}-file`;
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await ingestRecord(account, {
        data: { id: msgKey },
        emitted_at: "2026-01-01T00:00:00.000Z",
        key: msgKey,
        stream: "messages",
      });
      await ingestRecord(account, {
        data: { id: fileKey },
        emitted_at: "2026-01-02T00:00:00.000Z",
        key: fileKey,
        stream: "files",
      });
    }
    await rebuildRetainedSize();

    const alphaMessages = await listRetainedSizeStreams({
      connectorId: alpha.connector_id,
      stream: "messages",
    });
    assert.equal(alphaMessages.length, 1);
    const alphaMessage = mustExist(alphaMessages[0], "alpha message projection must exist");
    assert.equal(alphaMessage.connector_id, alpha.connector_id);
    assert.equal(alphaMessage.stream, "messages");
  }));

// Route-shape regression: this proves the public `connector_id` query
// parameter flows through `executeRefDatasetSummaryStreams` and the
// SQLite-host `listStreams` capability as a `connector_id` filter, not
// as a `connector_instance_id` filter. The host adapter in
// `server/index.js` calls `listRetainedSizeStreams({ connectorId })`
// (Postgres) or `listStreamProjections({ connectorId })` (SQLite); both
// helpers reach the same canonical `connector_id` column. If a future
// edit re-routes that to the `connectorInstanceId` slot, this test will
// fail at the boundary the route uses.
test("ref.dataset.summary.streams: connector_id query forwards as connectorId filter, not connectorInstanceId", async () => {
  const { executeRefDatasetSummaryStreams } = await import("../operations/ref-dataset-summary-streams/index.ts");

  const seenInputs: { connectorId: string | null }[] = [];
  const allRows = [
    {
      computed_at: "2026-05-19T12:00:00.000Z",
      connector_id: "gmail",
      consent_time_field: null,
      dirty_record_time_bounds: false,
      earliest_ingested_at: null,
      earliest_record_time: null,
      latest_ingested_at: null,
      latest_record_time: null,
      record_count: 3,
      record_json_bytes: 120,
      stream: "messages",
    },
    {
      computed_at: "2026-05-19T12:00:00.000Z",
      connector_id: "claude_code",
      consent_time_field: null,
      dirty_record_time_bounds: false,
      earliest_ingested_at: null,
      earliest_record_time: null,
      latest_ingested_at: null,
      latest_record_time: null,
      record_count: 2,
      record_json_bytes: 90,
      stream: "sessions",
    },
  ];

  const envelope = await executeRefDatasetSummaryStreams(
    { connector_id: "gmail" },
    {
      getProjectionMetadata: () => ({
        computed_at: "2026-05-19T12:00:00.000Z",
        last_error: null,
        rebuild_status: "idle",
        stale_since: null,
        state: "fresh",
      }),
      listStreams: (input) => {
        seenInputs.push(input);
        // Simulate the host's `listRetainedSizeStreams({ connectorId })`
        // / `listStreamProjections({ connectorId })` semantics: filter
        // the projection by connector_id when present, otherwise return
        // every row.
        return typeof input?.connectorId === "string" && input.connectorId.length > 0
          ? allRows.filter((row) => row.connector_id === input.connectorId)
          : allRows.slice();
      },
    }
  );

  assert.equal(seenInputs.length, 1);
  assert.ok(seenInputs[0], "listStreams was called at least once");
  assert.equal(
    seenInputs[0].connectorId,
    "gmail",
    "route MUST forward connector_id query as connectorId, not as connectorInstanceId"
  );
  // The host capability accepts `connectorId` — if a future edit
  // renames the dependency slot to `connectorInstanceId`, the host
  // adapter MUST be updated in lockstep. This assertion documents the
  // current dependency shape.
  assert.equal(
    "connectorInstanceId" in seenInputs[0],
    false,
    "operation must NOT pass connectorInstanceId; the dependency contract is { connectorId }"
  );
  assert.equal(envelope.filters.connector_id, "gmail");
  assert.equal(envelope.streams.length, 1);
  assert.ok(envelope.streams[0], "expected at least one stream in the envelope");
  assert.equal(envelope.streams[0].connector_id, "gmail");
});

// ── Postgres parity test (gated on PDPP_TEST_POSTGRES_URL) ───────────────────
//
// Seeds identical retained_size_global / _connection / _stream /
// _record_family / _top_rows fixtures onto BOTH backends and asserts the real
// production read functions (getRetainedSizeGlobal, listRetainedSizeConnections,
// listRetainedSizeStreams, listRetainedSizeRecordFamilies, listRetainedSizeTop)
// shape the same output regardless of dialect. Also exercises the
// markRetainedSizeDirty marker on Postgres and asserts the global row flips to
// dirty/state=stale. This is the conformance net for the seam-march migration:
// behaviour is preserved iff this test stays green on both backends before AND
// after the dialect branches collapse into a domain-local store.

const PG_NOW = "2026-06-18T12:00:00.000Z";
const PG_CONNECTOR_ID = "pg_retained_size_connector";
const PG_INSTANCE_ID = "cin_pg_retained_size_a";
const PG_INSTANCE_ID_B = "cin_pg_retained_size_b";

interface RetainedSizeFixtureIds {
  readonly connectorId?: string;
  readonly instanceId?: string;
  readonly instanceIdB?: string;
}

// A self-contained fixture covering every read grain. The same numbers are
// written to SQLite and to Postgres so a passing assertion means the two
// dialects produced byte-identical shaped reads.
function retainedSizeFixture(ids: RetainedSizeFixtureIds = {}) {
  const connectorId = ids.connectorId ?? PG_CONNECTOR_ID;
  const instanceId = ids.instanceId ?? PG_INSTANCE_ID;
  const instanceIdB = ids.instanceIdB ?? PG_INSTANCE_ID_B;
  return {
    connections: [
      {
        blob_bytes: 600,
        blob_count: 1,
        computed_at: PG_NOW,
        connector_id: connectorId,
        connector_instance_id: instanceId,
        current_record_json_bytes: 310,
        dirty: 0,
        record_count: 3,
        record_history_count: 4,
        record_history_json_bytes: 320,
      },
      {
        blob_bytes: 300,
        blob_count: 1,
        computed_at: PG_NOW,
        connector_id: connectorId,
        connector_instance_id: instanceIdB,
        current_record_json_bytes: 200,
        dirty: 0,
        record_count: 2,
        record_history_count: 2,
        record_history_json_bytes: 220,
      },
    ],
    global: {
      blob_bytes: 900,
      blob_count: 2,
      computed_at: PG_NOW,
      current_record_json_bytes: 510,
      dirty: 0,
      metadata: { last_error: null, rebuild_status: "idle", stale_since: null, state: "fresh" },
      record_count: 5,
      record_history_count: 6,
      record_history_json_bytes: 540,
    },
    recordFamilies: [
      {
        blob_bytes: 400,
        blob_count: 1,
        computed_at: PG_NOW,
        connector_id: connectorId,
        connector_instance_id: instanceId,
        current_record_json_bytes: 210,
        dirty: 0,
        record_count: 2,
        record_family: "thread",
        record_history_count: 3,
        record_history_json_bytes: 220,
        stream: "messages",
      },
    ],
    streams: [
      {
        blob_bytes: 400,
        blob_count: 1,
        computed_at: PG_NOW,
        connector_id: connectorId,
        connector_instance_id: instanceId,
        current_record_json_bytes: 210,
        dirty: 0,
        record_count: 2,
        record_history_count: 3,
        record_history_json_bytes: 220,
        stream: "messages",
      },
      {
        blob_bytes: 200,
        blob_count: 0,
        computed_at: PG_NOW,
        connector_id: connectorId,
        connector_instance_id: instanceId,
        current_record_json_bytes: 100,
        dirty: 0,
        record_count: 1,
        record_history_count: 1,
        record_history_json_bytes: 100,
        stream: "files",
      },
    ],
    topRows: [
      {
        blob_bytes: 600,
        blob_count: 1,
        blob_id: null,
        computed_at: PG_NOW,
        connector_id: connectorId,
        connector_instance_id: instanceId,
        current_record_json_bytes: 310,
        dirty: 0,
        grain_key: instanceId,
        measure: "total_retained_bytes",
        metadata: { last_error: null, rebuild_status: "idle", stale_since: null, state: "fresh" },
        rank: 1,
        record_count: 3,
        record_history_count: 4,
        record_history_json_bytes: 320,
        record_key: null,
        scope: "connection",
        stream: null,
        total_retained_bytes: 1230,
      },
      {
        blob_bytes: 300,
        blob_count: 1,
        blob_id: null,
        computed_at: PG_NOW,
        connector_id: connectorId,
        connector_instance_id: instanceIdB,
        current_record_json_bytes: 200,
        dirty: 0,
        grain_key: instanceIdB,
        measure: "total_retained_bytes",
        metadata: { last_error: null, rebuild_status: "idle", stale_since: null, state: "fresh" },
        rank: 2,
        record_count: 2,
        record_history_count: 2,
        record_history_json_bytes: 220,
        record_key: null,
        scope: "connection",
        stream: null,
        total_retained_bytes: 720,
      },
    ],
  };
}

function seedRetainedSizeGlobalSqlite(row: ReturnType<typeof retainedSizeFixture>["global"]) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_global(
         projection_key, current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count, dirty, computed_at, metadata_json
       )
       VALUES('global', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
      JSON.stringify(row.metadata)
    );
}

function seedRetainedSizeConnectionSqlite(row: ReturnType<typeof retainedSizeFixture>["connections"][number]) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id, current_record_json_bytes,
         record_history_json_bytes, blob_bytes, record_count, record_history_count,
         blob_count, dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.connector_instance_id,
      row.connector_id,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at
    );
}

function seedRetainedSizeStreamSqlite(row: ReturnType<typeof retainedSizeFixture>["streams"][number]) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream, current_record_json_bytes,
         record_history_json_bytes, blob_bytes, record_count, record_history_count,
         blob_count, dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at
    );
}

function seedRetainedSizeRecordFamilySqlite(row: ReturnType<typeof retainedSizeFixture>["recordFamilies"][number]) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_record_family(
         connector_instance_id, connector_id, stream, record_family,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count, dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.record_family,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at
    );
}

function seedRetainedSizeTopRowSqlite(row: ReturnType<typeof retainedSizeFixture>["topRows"][number]) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_top_rows(
         scope, measure, rank, grain_key, connector_instance_id, connector_id, stream,
         record_key, blob_id, current_record_json_bytes, record_history_json_bytes,
         blob_bytes, total_retained_bytes, record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.scope,
      row.measure,
      row.rank,
      row.grain_key,
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.record_key,
      row.blob_id,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.total_retained_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
      JSON.stringify(row.metadata)
    );
}

async function seedRetainedSizeGlobalPostgres(row: ReturnType<typeof retainedSizeFixture>["global"]) {
  await postgresQuery(
    `INSERT INTO retained_size_global(
       projection_key, current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count, dirty, computed_at, metadata_json
     )
     VALUES('global', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (projection_key) DO UPDATE SET
       current_record_json_bytes = EXCLUDED.current_record_json_bytes,
       record_history_json_bytes = EXCLUDED.record_history_json_bytes,
       blob_bytes = EXCLUDED.blob_bytes,
       record_count = EXCLUDED.record_count,
       record_history_count = EXCLUDED.record_history_count,
       blob_count = EXCLUDED.blob_count,
       dirty = EXCLUDED.dirty,
       computed_at = EXCLUDED.computed_at,
       metadata_json = EXCLUDED.metadata_json`,
    [
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
      JSON.stringify(row.metadata),
    ]
  );
}

async function seedRetainedSizeConnectionPostgres(row: ReturnType<typeof retainedSizeFixture>["connections"][number]) {
  await postgresQuery(
    `INSERT INTO retained_size_connection(
       connector_instance_id, connector_id, current_record_json_bytes,
       record_history_json_bytes, blob_bytes, record_count, record_history_count,
       blob_count, dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.connector_instance_id,
      row.connector_id,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
    ]
  );
}

async function seedRetainedSizeStreamPostgres(row: ReturnType<typeof retainedSizeFixture>["streams"][number]) {
  await postgresQuery(
    `INSERT INTO retained_size_stream(
       connector_instance_id, connector_id, stream, current_record_json_bytes,
       record_history_json_bytes, blob_bytes, record_count, record_history_count,
       blob_count, dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
    ]
  );
}

async function seedRetainedSizeRecordFamilyPostgres(
  row: ReturnType<typeof retainedSizeFixture>["recordFamilies"][number]
) {
  await postgresQuery(
    `INSERT INTO retained_size_record_family(
       connector_instance_id, connector_id, stream, record_family,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count, dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.record_family,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
    ]
  );
}

async function seedRetainedSizeTopRowPostgres(row: ReturnType<typeof retainedSizeFixture>["topRows"][number]) {
  await postgresQuery(
    `INSERT INTO retained_size_top_rows(
       scope, measure, rank, grain_key, connector_instance_id, connector_id, stream,
       record_key, blob_id, current_record_json_bytes, record_history_json_bytes,
       blob_bytes, total_retained_bytes, record_count, record_history_count, blob_count,
       dirty, computed_at, metadata_json
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)`,
    [
      row.scope,
      row.measure,
      row.rank,
      row.grain_key,
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.record_key,
      row.blob_id,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.total_retained_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
      JSON.stringify(row.metadata),
    ]
  );
}

async function cleanupRetainedSizePostgres(connectorId = PG_CONNECTOR_ID) {
  await postgresQuery(`DELETE FROM retained_size_global WHERE projection_key = 'global'`);
  await postgresQuery("DELETE FROM retained_size_top_rows");
  await postgresQuery("DELETE FROM retained_size_connection WHERE connector_id = $1", [connectorId]);
  await postgresQuery("DELETE FROM retained_size_stream WHERE connector_id = $1", [connectorId]);
  await postgresQuery("DELETE FROM retained_size_record_family WHERE connector_id = $1", [connectorId]);
}

test("Postgres retained-size top rows preserve rejection byte and count measures after reconcile", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const payloadBytes = 17_000;
  const databaseUrl = mustExist(
    process.env.PDPP_TEST_POSTGRES_URL,
    "Postgres test URL must be configured when test runs"
  );
  const connectorId = `pg_retained_size_rejection_${process.pid}_${Date.now()}`;
  const instanceId = `cin_${connectorId}`;
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    await cleanupRetainedSizePostgres(connectorId);
    await postgresQuery(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id, record_rejection_payload_bytes,
         record_rejection_count, dirty
       )
       VALUES($1, $2, $3, $4, 0)`,
      [instanceId, connectorId, payloadBytes, 2]
    );
    await postgresQuery(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream, record_rejection_payload_bytes,
         record_rejection_count, dirty
       )
       VALUES($1, $2, $3, $4, $5, 0)`,
      [instanceId, connectorId, "items", payloadBytes, 2]
    );

    await reconcileDirtyRetainedSize();

    const [topConnection] = await listRetainedSizeTop({
      limit: 1,
      measure: "record_rejection_payload_bytes",
      scope: "connection",
    });
    const connectionTop = mustExist(topConnection, "connection rejection top row must exist");
    assert.equal(connectionTop.record_rejection_payload_bytes, payloadBytes);
    assert.equal(connectionTop.record_rejection_count, 2);
    assert.equal(connectionTop.total_retained_bytes, payloadBytes);

    const [topStream] = await listRetainedSizeTop({
      limit: 1,
      measure: "record_rejection_payload_bytes",
      scope: "stream",
    });
    const streamTop = mustExist(topStream, "stream rejection top row must exist");
    assert.equal(streamTop.record_rejection_payload_bytes, payloadBytes);
    assert.equal(streamTop.record_rejection_count, 2);
    assert.equal(streamTop.total_retained_bytes, payloadBytes);
  } finally {
    await cleanupRetainedSizePostgres(connectorId);
    await closePostgresStorage();
  }
});

// Read every grain through the real production read functions. Backend is
// selected by isPostgresStorageBackend() inside those functions, so calling
// this on SQLite vs Postgres exercises both dialect arms with no test-side
// branching.
async function readAllRetainedSizeGrains(ids: RetainedSizeFixtureIds = {}) {
  const fixture = retainedSizeFixture(ids);
  const connectorId = ids.connectorId ?? PG_CONNECTOR_ID;
  const instanceId = ids.instanceId ?? PG_INSTANCE_ID;
  return {
    connections: await listRetainedSizeConnections(),
    connectionsFiltered: await listRetainedSizeConnections({
      connectorInstanceId: instanceId,
    }),
    fixture,
    global: await getRetainedSizeGlobal(),
    recordFamilies: await listRetainedSizeRecordFamilies({
      connectorInstanceId: instanceId,
      stream: "messages",
    }),
    streams: await listRetainedSizeStreams({ connectorInstanceId: instanceId }),
    streamsByConnector: await listRetainedSizeStreams({ connectorId }),
    streamsComposed: await listRetainedSizeStreams({
      connectorId,
      stream: "messages",
    }),
    top: await listRetainedSizeTop({
      limit: 5,
      measure: "total_retained_bytes",
      scope: "connection",
    }),
  };
}

test("Postgres retained-size reads shape identically to SQLite for global/connection/stream/record-family/top grains", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const connectorId = `pg_retained_size_parity_${process.pid}_${Date.now()}`;
  const instanceId = `cin_${connectorId}_a`;
  const instanceIdB = `cin_${connectorId}_b`;
  const fixtureIds = { connectorId, instanceId, instanceIdB };
  // 1. Compute the SQLite-shaped reads from a temp DB FIRST, while the
  //    backend is still SQLite.
  const dir = mkdtempSync(join(tmpdir(), "pdpp-retained-size-pg-parity-"));
  // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
  // biome-ignore lint/suspicious/noImplicitAnyLet: Fixture accumulator is intentionally inferred from runtime test data.
  let sqliteReads;
  try {
    initDb(join(dir, "pdpp.sqlite"));
    const fx = retainedSizeFixture(fixtureIds);
    seedRetainedSizeGlobalSqlite(fx.global);
    fx.connections.forEach(seedRetainedSizeConnectionSqlite);
    fx.streams.forEach(seedRetainedSizeStreamSqlite);
    fx.recordFamilies.forEach(seedRetainedSizeRecordFamilySqlite);
    fx.topRows.forEach(seedRetainedSizeTopRowSqlite);
    sqliteReads = await readAllRetainedSizeGrains(fixtureIds);
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }

  // 2. Switch to Postgres, seed the identical fixture, read through the same
  //    production functions, and assert byte-identical shaped output.
  const databaseUrl = mustExist(
    process.env.PDPP_TEST_POSTGRES_URL,
    "Postgres test URL must be configured when test runs"
  );
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    await cleanupRetainedSizePostgres(connectorId);
    const fx = retainedSizeFixture(fixtureIds);
    await seedRetainedSizeGlobalPostgres(fx.global);
    for (const row of fx.connections) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await seedRetainedSizeConnectionPostgres(row);
    }
    for (const row of fx.streams) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await seedRetainedSizeStreamPostgres(row);
    }
    for (const row of fx.recordFamilies) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await seedRetainedSizeRecordFamilyPostgres(row);
    }
    for (const row of fx.topRows) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await seedRetainedSizeTopRowPostgres(row);
    }

    const pgReads = await readAllRetainedSizeGrains(fixtureIds);

    // Global grain: full shaped row including parsed metadata.
    assert.deepEqual(pgReads.global, sqliteReads.global);
    assert.equal(pgReads.global.total_retained_bytes, 510 + 540 + 900);
    assert.equal(pgReads.global.dirty, false);
    assert.equal(pgReads.global.metadata.state, "fresh");

    // Connection grain: unfiltered list + connectorInstanceId filter.
    assert.deepEqual(pgReads.connections, sqliteReads.connections);
    assert.equal(pgReads.connections.length, 2);
    assert.deepEqual(pgReads.connectionsFiltered, sqliteReads.connectionsFiltered);
    assert.equal(pgReads.connectionsFiltered.length, 1);
    assert.equal(
      mustExist(pgReads.connectionsFiltered[0], "filtered connection row must exist").connector_instance_id,
      instanceId
    );

    // Stream grain: connectorInstanceId, connectorId, and composed filters
    // (the dynamic optional-WHERE construction).
    assert.deepEqual(pgReads.streams, sqliteReads.streams);
    // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
    assert.deepEqual(pgReads.streams.map((row) => row.stream).sort(), ["files", "messages"]);
    assert.deepEqual(pgReads.streamsByConnector, sqliteReads.streamsByConnector);
    assert.deepEqual(pgReads.streamsComposed, sqliteReads.streamsComposed);
    assert.equal(pgReads.streamsComposed.length, 1);
    assert.equal(mustExist(pgReads.streamsComposed[0], "composed stream row must exist").stream, "messages");

    // Record-family grain.
    assert.deepEqual(pgReads.recordFamilies, sqliteReads.recordFamilies);
    assert.equal(pgReads.recordFamilies.length, 1);
    assert.equal(mustExist(pgReads.recordFamilies[0], "record-family row must exist").record_family, "thread");

    // Top-N grain (ORDER BY rank + LIMIT placeholder).
    assert.deepEqual(pgReads.top, sqliteReads.top);
    assert.equal(pgReads.top.length, 2);
    const topConnection = mustExist(pgReads.top[0], "top connection row must exist");
    assert.equal(topConnection.connector_instance_id, instanceId);
    assert.equal(topConnection.total_retained_bytes, 1230);

    // 3. Exercise a marker: markRetainedSizeDirty must flip the Postgres
    //    global row to dirty + state=stale.
    await markRetainedSizeDirty("parity test bulk write");
    const dirtied = await getRetainedSizeGlobal();
    assert.equal(dirtied.dirty, true);
    assert.equal(dirtied.metadata.state, "stale");
    assert.equal(dirtied.metadata.last_error, "parity test bulk write");
  } finally {
    await cleanupRetainedSizePostgres(connectorId);
    await closePostgresStorage();
  }
});
