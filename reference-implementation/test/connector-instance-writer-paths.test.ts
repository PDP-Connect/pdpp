// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  postgresBackfillRecordSortPositionsForManifest,
  postgresPersistContentAddressedBlob,
} from "../server/postgres-records.ts";
import {
  deleteAllRecordsForConnector,
  deleteConnectionRecordRowsPostgres as deleteConnectionRecordRowsPostgresUntyped,
  enumerateConnectionStreams as enumerateConnectionStreamsUntyped,
  ingestRecord,
  teardownConnectionSearchProjection as teardownConnectionSearchProjectionUntyped,
} from "../server/records.ts";

// `server/records.js` is plain JS. `enumerateConnectionStreams` internally
// resolves its connector id via the real, typed `resolveStorageConnectorId`
// (`server/storage-utils.ts`), which returns `string | null` for the fully
// general case — but every storage target this test ever passes carries a
// real, already-known connector id (the connection genuinely exists), so the
// production-shaped, always-non-null return type is the honest contract for
// this call site, matching `ConnectorInstanceDeletePurge.enumerateStreams`'s
// real signature in `server/stores/connector-instance-store.ts`.
type EnumerateConnectionStreamsFn = (storageTarget: {
  connector_id: string;
  connector_instance_id: string;
}) => Promise<{ connectorId: string; connectorInstanceId: string; streams: string[] }>;
const enumerateConnectionStreams = enumerateConnectionStreamsUntyped as EnumerateConnectionStreamsFn;

type DeleteConnectionRecordRowsPostgresFn = (client: unknown, connectorInstanceId: string) => Promise<number>;
const deleteConnectionRecordRowsPostgres =
  deleteConnectionRecordRowsPostgresUntyped as DeleteConnectionRecordRowsPostgresFn;

type TeardownConnectionSearchProjectionFn = (args: {
  connectorId: string;
  connectorInstanceId: string;
  streams: string[];
  deletedRecordCount: number;
}) => Promise<void>;
const teardownConnectionSearchProjection =
  teardownConnectionSearchProjectionUntyped as TeardownConnectionSearchProjectionFn;

import { withConnectorInstanceWrite } from "../server/connector-instance-write-coordinator.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { lexicalIndexBackfillForManifest as lexicalIndexBackfillForManifestUntyped } from "../server/search.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

// `server/search.js` is plain JS: `lexicalIndexBackfillForManifest`'s
// destructured-default parameter (`{ manifest, log = () => {}, signal = null } = {}`)
// makes TS infer its argument type narrowly from the defaults alone (only
// `log`/`signal` have defaults, so `manifest` is inferred as absent) —
// TS2352 territory. Re-typed here via the documented pattern: import the
// JS export and cast it to a signature matching how the
// production function is actually called (a manifest with an id, a
// storage-binding-scoped instance, and stream-level lexical search config).
interface LexicalBackfillManifest {
  connector_id: string;
  storage_binding: { connector_instance_id: string };
  streams: Array<{ name: string; query: { search: { lexical_fields: string[] } } }>;
}
type LexicalIndexBackfillForManifestFn = (args: {
  manifest: LexicalBackfillManifest;
  log?: (() => void) | undefined;
  signal?: null | undefined;
}) => Promise<void>;
const lexicalIndexBackfillForManifest = lexicalIndexBackfillForManifestUntyped as LexicalIndexBackfillForManifestFn;

function mustRow<T extends Record<string, unknown>>(value: T | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

function deferred<T = void>() {
  // `Promise`'s executor runs synchronously, so `resolve` is genuinely
  // assigned before this function returns — the definite-assignment marker
  // just tells TS what that synchronous-call contract already guarantees.
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function target(connectorId: string, connectorInstanceId: string) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

function record(stream: string, key: string, title: string) {
  return {
    data: { id: key, title },
    emitted_at: "2026-07-16T00:00:00.000Z",
    key,
    stream,
  };
}

async function holdInstance(connectorInstanceId: string) {
  const entered = deferred();
  const release = deferred();
  const held = withConnectorInstanceWrite(connectorInstanceId, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { held, release };
}

test("SQLite connector-wide bulk deletion serializes the actual same-instance writer, while a sibling instance overlaps", async () => {
  const connectorId = "writer-path-bulk";
  const instanceA = "cin_writer_path_a";
  const instanceB = "cin_writer_path_b";
  const stream = "messages";
  initDb(":memory:");
  let held: Awaited<ReturnType<typeof holdInstance>> | null = null;
  let bulk: ReturnType<typeof deleteAllRecordsForConnector> | null = null;
  let sameInstanceIngest: Promise<void> | null = null;
  try {
    await ingestRecord(target(connectorId, instanceA), record(stream, "a-before", "before A"));
    await ingestRecord(target(connectorId, instanceB), record(stream, "b-before", "before B"));

    held = await holdInstance(instanceA);
    bulk = deleteAllRecordsForConnector(connectorId);
    await new Promise((resolve) => setImmediate(resolve));

    let sameInstanceFinished = false;
    sameInstanceIngest = ingestRecord(
      target(connectorId, instanceA),
      record(stream, "a-after", "ordered after bulk")
    ).then(() => {
      sameInstanceFinished = true;
    });

    // `bulk` is waiting on A. It must not hold B while it waits, so this real
    // direct ingest can complete and is then included in B's stream teardown.
    await ingestRecord(target(connectorId, instanceB), record(stream, "b-racing", "sibling overlaps"));
    assert.equal(sameInstanceFinished, false);

    held.release.resolve();
    await held.held;
    await bulk;
    await sameInstanceIngest;

    const liveRows = getDb()
      .prepare(
        `SELECT connector_instance_id, record_key
         FROM records
        WHERE connector_id = ? AND deleted = 0
        ORDER BY connector_instance_id, record_key`
      )
      .all(connectorId);
    assert.deepEqual(liveRows, [{ connector_instance_id: instanceA, record_key: "a-after" }]);
  } finally {
    if (held) {
      held.release.resolve();
    }
    await Promise.allSettled([held?.held, bulk, sameInstanceIngest].filter(Boolean));
    closeDb();
  }
});

test("SQLite direct ingest queued before bulk deletion deterministically leaves the bulk-delete final state", async () => {
  const connectorId = "writer-path-bulk-reverse";
  const connectorInstanceId = "cin_writer_path_bulk_reverse";
  const stream = "messages";
  initDb(":memory:");
  let held: Awaited<ReturnType<typeof holdInstance>> | null = null;
  let directIngest: ReturnType<typeof ingestRecord> | null = null;
  let bulk: ReturnType<typeof deleteAllRecordsForConnector> | null = null;
  try {
    await ingestRecord(target(connectorId, connectorInstanceId), record(stream, "before", "before reverse ordering"));
    held = await holdInstance(connectorInstanceId);
    directIngest = ingestRecord(
      target(connectorId, connectorInstanceId),
      record(stream, "direct-first", "direct is ordered before bulk")
    );
    await new Promise((resolve) => setImmediate(resolve));
    bulk = deleteAllRecordsForConnector(connectorId);
    await new Promise((resolve) => setImmediate(resolve));

    held.release.resolve();
    await held.held;
    await directIngest;
    await bulk;
    const remaining = getDb()
      .prepare("SELECT COUNT(*) AS count FROM records WHERE connector_instance_id = ? AND deleted = 0")
      .get(connectorInstanceId);
    assert.equal(mustRow(remaining, "remaining count row exists").count, 0);
  } finally {
    if (held) {
      held.release.resolve();
    }
    await Promise.allSettled([held?.held, directIngest, bulk].filter(Boolean));
    closeDb();
  }
});

test("SQLite lexical manifest backfill waits on its actual instance but does not block a sibling writer", async () => {
  const connectorId = "writer-path-lexical";
  const instanceA = "cin_writer_lexical_a";
  const instanceB = "cin_writer_lexical_b";
  const stream = "messages";
  initDb(":memory:");
  let held: Awaited<ReturnType<typeof holdInstance>> | null = null;
  let backfill: ReturnType<typeof lexicalIndexBackfillForManifest> | null = null;
  try {
    await ingestRecord(target(connectorId, instanceA), record(stream, "a", "alpha indexed"));
    held = await holdInstance(instanceA);
    backfill = lexicalIndexBackfillForManifest({
      manifest: {
        connector_id: connectorId,
        storage_binding: { connector_instance_id: instanceA },
        streams: [{ name: stream, query: { search: { lexical_fields: ["title"] } } }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    await ingestRecord(target(connectorId, instanceB), record(stream, "b", "sibling indexed independently"));
    held.release.resolve();
    await held.held;
    await backfill;

    const rows = getDb()
      .prepare(
        `SELECT record_key FROM lexical_search_index
        WHERE connector_instance_id = ? AND stream = ? ORDER BY record_key`
      )
      .all(instanceA, stream);
    assert.deepEqual(rows, [{ record_key: "a" }]);
  } finally {
    if (held) {
      held.release.resolve();
    }
    await Promise.allSettled([held?.held, backfill].filter(Boolean));
    closeDb();
  }
});

test("SQLite direct ingest queued before lexical backfill is indexed by the later backfill", async () => {
  const connectorId = "writer-path-lexical-reverse";
  const connectorInstanceId = "cin_writer_lexical_reverse";
  const stream = "messages";
  initDb(":memory:");
  let held: Awaited<ReturnType<typeof holdInstance>> | null = null;
  let directIngest: ReturnType<typeof ingestRecord> | null = null;
  let backfill: ReturnType<typeof lexicalIndexBackfillForManifest> | null = null;
  try {
    held = await holdInstance(connectorInstanceId);
    directIngest = ingestRecord(
      target(connectorId, connectorInstanceId),
      record(stream, "direct-first", "indexed after direct durable write")
    );
    await new Promise((resolve) => setImmediate(resolve));
    backfill = lexicalIndexBackfillForManifest({
      manifest: {
        connector_id: connectorId,
        storage_binding: { connector_instance_id: connectorInstanceId },
        streams: [{ name: stream, query: { search: { lexical_fields: ["title"] } } }],
      },
    });
    held.release.resolve();
    await held.held;
    await directIngest;
    await backfill;
    const indexed = getDb()
      .prepare(
        `SELECT record_key FROM lexical_search_index
        WHERE connector_instance_id = ? AND stream = ?`
      )
      .get(connectorInstanceId, stream);
    assert.equal(mustRow(indexed, "indexed row exists").record_key, "direct-first");
  } finally {
    if (held) {
      held.release.resolve();
    }
    await Promise.allSettled([held?.held, directIngest, backfill].filter(Boolean));
    closeDb();
  }
});

test("SQLite connection purge is fenced through its durable delete and post-commit search teardown", async () => {
  const connectorId = "writer-path-connection-purge";
  const connectorInstanceId = "cin_writer_connection_purge";
  initDb(":memory:");
  let held: Awaited<ReturnType<typeof holdInstance>> | null = null;
  let deletion: ReturnType<ReturnType<typeof createSqliteConnectorInstanceStore>["deleteConnection"]> | null = null;
  try {
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest) VALUES(?, ?)")
      .run(connectorId, JSON.stringify({ connector_id: connectorId }));
    const store = createSqliteConnectorInstanceStore();
    store.upsert({
      connectorId,
      connectorInstanceId,
      createdAt: "2026-07-16T00:00:00.000Z",
      displayName: "Writer path purge",
      ownerSubjectId: "owner_writer_paths",
      sourceBinding: { kind: "writer_path_test" },
      sourceBindingKey: "writer-path-purge",
      sourceKind: "manual",
      status: "active",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });
    held = await holdInstance(connectorInstanceId);
    let teardownRan = false;
    deletion = store.deleteConnection(connectorInstanceId, {
      now: "2026-07-16T00:00:01.000Z",
      ownerSubjectId: "owner_writer_paths",
      purge: {
        // This SQLite-backend test's delete path never reaches the Postgres
        // row-delete arm (`deleteConnection`'s SQLite implementation calls
        // only `deleteRecordRowsSqlite`) — a throwing stub documents that
        // this branch is genuinely unreachable here rather than silently
        // asserting success for untested behavior.
        deleteRecordRowsPostgres: () => {
          throw new Error("unreachable: the SQLite connection-purge path never calls deleteRecordRowsPostgres");
        },
        deleteRecordRowsSqlite: () => 0,
        enumerateStreams: async () => ({ connectorId, connectorInstanceId, streams: ["messages"] }),
        teardownProjection: () => {
          teardownRan = true;
          return Promise.resolve();
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(store.get(connectorInstanceId), "durable purge cannot begin before the shared instance fence");
    held.release.resolve();
    await held.held;
    await deletion;
    assert.equal(store.get(connectorInstanceId), null);
    assert.equal(teardownRan, true, "the held fence covers the post-commit projection teardown too");
  } finally {
    if (held) {
      held.release.resolve();
    }
    await Promise.allSettled([held?.held, deletion].filter(Boolean));
    closeDb();
  }
});

test("Postgres sort repair fences all manifest streams for an instance and blob binding respects the same fence", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  const suffix = `writer_path_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const connectorId = `connector_${suffix}`;
  const instanceA = `cin_${suffix}`;
  const streamA = "first";
  const streamB = "later";
  initDb(":memory:");
  const postgresUrl = DEDICATED_POSTGRES_URL;
  assert.ok(postgresUrl, "DEDICATED_POSTGRES_URL is required for this test");
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
  let held: Awaited<ReturnType<typeof holdInstance>> | null = null;
  let blobWrite: ReturnType<typeof postgresPersistContentAddressedBlob> | null = null;
  let connectionPurge: ReturnType<ReturnType<typeof createPostgresConnectorInstanceStore>["deleteConnection"]> | null =
    null;
  try {
    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (connector_id) DO NOTHING`,
      [connectorId, JSON.stringify({ connector_id: connectorId }), "2026-07-16T00:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
       VALUES
         ($1, $2, $3, 'first-record', $4::jsonb, $5, 1, FALSE, 'first-record'),
         ($1, $2, $6, 'later-record', $7::jsonb, $5, 1, FALSE, 'later-record')`,
      [
        connectorId,
        instanceA,
        streamA,
        JSON.stringify({ first_cursor: "2026-07-15T01:00:00.000Z", id: "first-record" }),
        "2026-07-16T00:00:00.000Z",
        streamB,
        JSON.stringify({ id: "later-record", later_cursor: "2026-07-15T02:00:00.000Z" }),
      ]
    );
    const repaired = await postgresBackfillRecordSortPositionsForManifest({
      connector_id: connectorId,
      streams: [
        { cursor_field: "first_cursor", name: streamA },
        { cursor_field: "later_cursor", name: streamB },
      ],
    });
    assert.equal(repaired.updated, 2);
    const cursors = await postgresQuery(
      `SELECT stream, cursor_value FROM records
        WHERE connector_instance_id = $1 ORDER BY stream`,
      [instanceA]
    );
    assert.deepEqual(cursors.rows, [
      { cursor_value: "2026-07-15T01:00:00.000Z", stream: streamA },
      { cursor_value: "2026-07-15T02:00:00.000Z", stream: streamB },
    ]);

    held = await holdInstance(instanceA);
    blobWrite = postgresPersistContentAddressedBlob({
      connectorId,
      connectorInstanceId: instanceA,
      data: Buffer.from("coordinated binding"),
      mimeType: "text/plain",
      recordKey: "first-record",
      stream: streamA,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const beforeRelease = await postgresQuery(
      "SELECT COUNT(*)::int AS count FROM blob_bindings WHERE connector_instance_id = $1",
      [instanceA]
    );
    assert.equal(Number(mustRow(beforeRelease.rows[0], "beforeRelease row exists").count), 0);
    held.release.resolve();
    await held.held;
    await blobWrite;
    const afterRelease = await postgresQuery(
      "SELECT COUNT(*)::int AS count FROM blob_bindings WHERE connector_instance_id = $1",
      [instanceA]
    );
    assert.equal(Number(mustRow(afterRelease.rows[0], "afterRelease row exists").count), 1);

    const purgeInstanceId = `${instanceA}_purge`;
    const store = createPostgresConnectorInstanceStore();
    await store.upsert({
      connectorId,
      connectorInstanceId: purgeInstanceId,
      createdAt: "2026-07-16T00:00:00.000Z",
      displayName: "Postgres writer path purge",
      ownerSubjectId: "owner_writer_paths",
      sourceBinding: { kind: "writer_path_test" },
      sourceBindingKey: `purge_${suffix}`,
      sourceKind: "manual",
      status: "active",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });
    await postgresQuery(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
       VALUES ($1, $2, 'messages', 'purge-record', $3::jsonb, $4, 1, FALSE, 'purge-record')`,
      [
        connectorId,
        purgeInstanceId,
        JSON.stringify({ first_cursor: "2026-07-15T03:00:00.000Z", id: "purge-record" }),
        "2026-07-16T00:00:00.000Z",
      ]
    );
    await postgresPersistContentAddressedBlob({
      connectorId,
      connectorInstanceId: purgeInstanceId,
      data: Buffer.from("binding removed by real connection purge"),
      mimeType: "text/plain",
      recordKey: "purge-record",
      stream: "messages",
    });
    held = await holdInstance(purgeInstanceId);
    let teardownRan = false;
    connectionPurge = store.deleteConnection(purgeInstanceId, {
      now: "2026-07-16T00:00:01.000Z",
      ownerSubjectId: "owner_writer_paths",
      purge: {
        deleteRecordRowsPostgres: (client, id) => deleteConnectionRecordRowsPostgres(client, id),
        // This Postgres-backend test's delete path never reaches the SQLite
        // row-delete arm (`deleteConnection`'s Postgres implementation calls
        // only `deleteRecordRowsPostgres`) — a throwing stub documents that
        // this branch is genuinely unreachable here rather than silently
        // asserting success for untested behavior.
        deleteRecordRowsSqlite: () => {
          throw new Error("unreachable: the Postgres connection-purge path never calls deleteRecordRowsSqlite");
        },
        enumerateStreams: (storageTarget) => enumerateConnectionStreams(storageTarget),
        teardownProjection: async (args) => {
          teardownRan = true;
          await teardownConnectionSearchProjection(args);
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(await store.get(purgeInstanceId), "Postgres durable purge cannot begin before the shared instance fence");
    held.release.resolve();
    await held.held;
    await connectionPurge;
    assert.equal(await store.get(purgeInstanceId), null);
    assert.equal(teardownRan, true);
    const purgedBindings = await postgresQuery(
      "SELECT COUNT(*)::int AS count FROM blob_bindings WHERE connector_instance_id = $1",
      [purgeInstanceId]
    );
    assert.equal(
      Number(mustRow(purgedBindings.rows[0], "purgedBindings row exists").count),
      0,
      "connection purge removes its blob binding under the same fence"
    );
  } finally {
    if (held) {
      held.release.resolve();
    }
    await Promise.allSettled([held?.held, blobWrite, connectionPurge].filter(Boolean));
    await postgresQuery("DELETE FROM blob_bindings WHERE connector_id = $1", [connectorId]).catch(() => undefined);
    await postgresQuery("DELETE FROM blobs WHERE connector_id = $1", [connectorId]).catch(() => undefined);
    await postgresQuery("DELETE FROM records WHERE connector_id = $1", [connectorId]).catch(() => undefined);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", [connectorId]).catch(
      () => undefined
    );
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]).catch(() => undefined);
    await closePostgresStorage();
    closeDb();
  }
});
