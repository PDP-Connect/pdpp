// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Terminal-gate re-revision (2026-07-29) — P1: "The N=1/N=1000 scale test is
 * good fleet evidence, but ref-connectors-list-unbounded-scale.test.ts seeds
 * one record per connection. It has no large per-connection record corpus
 * case. Add an executed-SQL counter and plan oracle with a fixed bounded
 * connector page plus a large record corpus (including representative
 * streams/history), on both backends."
 *
 * That prior file's N=1-vs-N=1000 oracle proves independence from FLEET
 * SIZE (connection count) — it does not, and was never meant to, prove
 * independence from CORPUS SIZE (how many records one connection has). This
 * file complements it: a FIXED, small connector page (well within one
 * bounded page — this is not a fleet-size test) where each connection has a
 * LARGE record corpus across multiple streams with history (superseded/old
 * versions, not just current rows), proving:
 *   (a) executed-SQL-statement count for reading that bounded page stays
 *       ~constant whether each connection has a handful of records or tens
 *       of thousands — the per-connection aggregate reads
 *       (`connector-summary-evidence-engine.ts`'s canonical-count/checkpoint
 *       queries) are O(1) STATEMENTS regardless of corpus size, even though
 *       their execution cost scales with rows scanned;
 *   (b) EXPLAIN (SQLite `EXPLAIN QUERY PLAN`, real PostgreSQL `EXPLAIN`)
 *       shows every record aggregate is answered via an index on
 *       `(connector_instance_id, ...)` — never a sequential/full-table scan
 *       — on both backends, so the large corpus does not degrade to O(total
 *       table rows) even at the single-query level.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: test-only raw SQLite instrumentation.
import Database from "better-sqlite3";

import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const OWNER = "owner_local";
const CONNECTOR_ID = "record-corpus-independence-proof";
const SECRET = "record-corpus-independence-secret-must-never-leak";
const CONNECTION_COUNT = 5; // fixed, small, well within one bounded page — this test is about CORPUS size, not fleet size.
// Any `connector_instance_id`-leading index on `records` satisfies this — the
// property under test is "the count is index-driven, not a full scan", not
// which specific index the planner picks. Matches `USING INDEX` and `USING
// COVERING INDEX` alike: a covering index is strictly better here (it answers
// the count without touching the table at all), so a regex that accepted only
// the former would reject an improvement. `idx_records_canonical_count`
// (connector_instance_id, deleted, stream, emitted_at) is the current pick.
const SQLITE_RECORDS_INDEX = /USING (?:COVERING )?INDEX idx_records_(lookup|version|canonical_count)/;
const SQLITE_RECORDS_FULL_SCAN = /SCAN records\b(?!.*USING)/;
const POSTGRES_RECORDS_SEQ_SCAN = /Seq Scan on records\b/;
const SMALL_RECORD_COUNT_PER_CONNECTION = 3;
const LARGE_RECORD_COUNT_PER_CONNECTION = 5000;
const STREAMS = ["messages", "attachments"] as const;
const PAGE_LIMIT = 100;
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "record corpus independence cursor key";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

interface ListEnvelope {
  readonly data?: readonly Record<string, unknown>[];
  readonly object?: string;
}

function connectorIdForPhase(phase: string): string {
  return `${CONNECTOR_ID}-${phase}`;
}

function instanceId(phase: string, index: number): string {
  return `cin_corpus_${phase}_${String(index).padStart(4, "0")}`;
}

function iso(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 6, 29, 12, 0, 0) + offsetSeconds * 1000).toISOString();
}

function manifest(connectorId: string): Record<string, unknown> {
  return {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: connectorId,
    display_name: "Record corpus independence proof",
    protocol_version: "0.1.0",
    streams: STREAMS.map((name) => ({ name, primary_key: ["id"] })),
    version: "1.0.0",
  };
}

async function closeServer(server: StartedServer | null): Promise<void> {
  if (!server) {
    return;
  }
  server.abortStartupBackfill("record corpus independence proof shutdown");
  server.schedulerManager?.stop?.();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
    server.controller.drainActiveRuns(5000),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

async function withMountedRoute(databaseUrl: string | null, fn: (asUrl: string) => Promise<void>): Promise<void> {
  const previousDatabaseUrl = process.env.PDPP_DATABASE_URL;
  if (databaseUrl) {
    process.env.PDPP_DATABASE_URL = databaseUrl;
  } else {
    delete process.env.PDPP_DATABASE_URL;
  }
  let server: StartedServer | null = null;
  try {
    server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
    await server.startupBackfillDone.catch(() => undefined);
    await server.startupSummaryEvidenceSweepDone.catch(() => undefined);
    await fn(`http://localhost:${server.asPort}`);
  } finally {
    await closeServer(server);
    await closePostgresStorage().catch(() => undefined);
    closeDb();
    if (previousDatabaseUrl === undefined) {
      delete process.env.PDPP_DATABASE_URL;
    } else {
      process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
    }
  }
}

/**
 * Seeds a FRESH, phase-keyed connector + CONNECTION_COUNT connections (never
 * colliding with a different phase's fixture, so "small" and "large" phases
 * can coexist in the same database and be measured independently), each
 * with `recordsPerConnection` records PER STREAM (so a "large" run seeds
 * `recordsPerConnection * STREAMS.length` rows per connection), including
 * HISTORY — a fraction of DELETED records alongside the current corpus, not
 * just distinct current rows — matching the gate's "including
 * representative streams/history" ask.
 */
async function seedFleetWithRecordsPerConnection(phase: string, recordsPerConnection: number): Promise<void> {
  const connectorId = connectorIdForPhase(phase);
  if (isPostgresStorageBackend()) {
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      connectorId,
      JSON.stringify(manifest(connectorId)),
      iso(0),
    ]);

    // Bulk-insert every connector_instance for this phase in one round-trip
    // via unnest(...) over parallel arrays — the standard node-postgres bulk
    // pattern, replacing what was previously CONNECTION_COUNT sequential
    // single-row INSERTs.
    const instanceIds: string[] = [];
    const displayNames: string[] = [];
    const createdAts: string[] = [];
    for (let index = 0; index < CONNECTION_COUNT; index += 1) {
      instanceIds.push(instanceId(phase, index));
      displayNames.push(`Corpus proof ${phase} ${index}`);
      createdAts.push(iso(index));
    }
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       SELECT id, $2, $3, display_name, 'active', 'account', id, $4::jsonb, created_at, created_at, NULL
       FROM unnest($1::text[], $5::text[], $6::text[]) AS t(id, display_name, created_at)`,
      [instanceIds, OWNER, connectorId, JSON.stringify({ secret: SECRET }), displayNames, createdAts]
    );

    // Bulk-insert every record for every connection/stream in this phase in
    // one round-trip: build the full corpus in memory, then a single
    // unnest(...)-driven INSERT — replacing what was previously
    // CONNECTION_COUNT * STREAMS.length * recordsPerConnection individual
    // INSERTs (100,000 round-trips for the "large" phase before this fix).
    const recConnectorInstanceIds: string[] = [];
    const recStreams: string[] = [];
    const recKeys: string[] = [];
    const recEmittedAts: string[] = [];
    const recDeleted: boolean[] = [];
    for (let index = 0; index < CONNECTION_COUNT; index += 1) {
      const id = instanceId(phase, index);
      for (const stream of STREAMS) {
        for (let recordIndex = 0; recordIndex < recordsPerConnection; recordIndex += 1) {
          // History: every 10th key is a DELETED record (a distinct key from
          // the current ones, since (connector_instance_id, stream,
          // record_key) is UNIQUE) — the canonical count must correctly
          // exclude these via `deleted = false`, not merely count every row
          // ever written for this connection.
          const isHistorical = recordIndex % 10 === 0;
          const key = isHistorical ? `record-${stream}-deleted-${recordIndex}` : `record-${stream}-${recordIndex}`;
          recConnectorInstanceIds.push(id);
          recStreams.push(stream);
          recKeys.push(key);
          recEmittedAts.push(iso(index * 100_000 + recordIndex));
          recDeleted.push(isHistorical);
        }
      }
    }
    await postgresQuery(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
       SELECT $1, connector_instance_id, stream, record_key, '{}'::jsonb, emitted_at, 1, deleted, record_key
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[])
         AS t(connector_instance_id, stream, record_key, emitted_at, deleted)`,
      [connectorId, recConnectorInstanceIds, recStreams, recKeys, recEmittedAts, recDeleted]
    );
    return;
  }

  const db = getDb();
  db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    connectorId,
    JSON.stringify(manifest(connectorId)),
    iso(0)
  );
  const insertInstance = db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES(?, ?, ?, ?, 'active', 'account', ?, ?, ?, ?, NULL)`
  );
  const insertRecord = db.prepare(
    `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version, deleted)
     VALUES(?, ?, ?, ?, '{}', ?, ?, 1, ?)`
  );
  const insertAll = db.transaction(() => {
    for (let index = 0; index < CONNECTION_COUNT; index += 1) {
      const id = instanceId(phase, index);
      const createdAt = iso(index);
      insertInstance.run(
        id,
        OWNER,
        connectorId,
        `Corpus proof ${phase} ${index}`,
        id,
        JSON.stringify({ secret: SECRET }),
        createdAt,
        createdAt
      );
      for (const stream of STREAMS) {
        for (let recordIndex = 0; recordIndex < recordsPerConnection; recordIndex += 1) {
          // History: every 10th key is a DELETED record (a distinct key from
          // the current ones, since (connector_instance_id, stream,
          // record_key) is UNIQUE) — the canonical count must correctly
          // exclude these via `deleted = false`, not merely count every row
          // ever written for this connection.
          const isHistorical = recordIndex % 10 === 0;
          const key = isHistorical ? `record-${stream}-deleted-${recordIndex}` : `record-${stream}-${recordIndex}`;
          const emittedAt = iso(index * 100_000 + recordIndex);
          insertRecord.run(connectorId, id, stream, key, emittedAt, emittedAt, isHistorical ? 1 : 0);
        }
      }
    }
  });
  insertAll();
}

async function getPage(asUrl: string, phase: string): Promise<ListEnvelope> {
  // Scoped to exactly this phase's connector_id: both the "small" and
  // "large" corpus fixtures coexist in the SAME database (distinct
  // connector_ids), so each measurement must read only its own phase's
  // connections, never the other phase's.
  const response = await fetch(
    `${asUrl}/_ref/connectors?limit=${PAGE_LIMIT}&connector_id=${encodeURIComponent(connectorIdForPhase(phase))}`
  );
  const body = (await response.json()) as ListEnvelope;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.object, "list");
  assert.ok(Array.isArray(body.data));
  return body;
}

/** Same convention as ref-connectors-list-unbounded-scale.test.ts — see that file's doc comment for the full rationale. */
function statementPrototype(): Record<string, (...args: unknown[]) => unknown> {
  return Database.prototype.prepare.call(new Database(":memory:"), "SELECT 1").constructor.prototype as Record<
    string,
    (...args: unknown[]) => unknown
  >;
}

async function countSqliteCalls<T>(fn: () => Promise<T>): Promise<{ readonly calls: number; readonly result: T }> {
  let calls = 0;
  const StatementPrototype = statementPrototype();
  const methods = ["all", "get", "iterate", "run"] as const;
  const originals: [string, (...args: unknown[]) => unknown][] = methods.map((method) => {
    const original = StatementPrototype[method];
    if (typeof original !== "function") {
      throw new Error(`better-sqlite3 Statement.prototype.${method} is not a function`);
    }
    return [method, original];
  });
  for (const [method, original] of originals) {
    StatementPrototype[method] = function patched(this: unknown, ...args: unknown[]) {
      calls += 1;
      return original.apply(this, args);
    };
  }
  try {
    const result = await fn();
    return { calls, result };
  } finally {
    for (const [method, original] of originals) {
      StatementPrototype[method] = original;
    }
  }
}

async function countPostgresCalls<T>(fn: () => Promise<T>): Promise<{ readonly calls: number; readonly result: T }> {
  const pool = getPostgresPool();
  const original = pool.query.bind(pool);
  let calls = 0;
  pool.query = ((...args: Parameters<typeof original>) => {
    calls += 1;
    return original(...args);
  }) as typeof pool.query;
  try {
    const result = await fn();
    return { calls, result };
  } finally {
    pool.query = original as typeof pool.query;
  }
}

/**
 * Core proof, backend-agnostic: seed two INDEPENDENT fixed, small (5)
 * connection fleets in the SAME database — one with a SMALL per-connection
 * record corpus, one with a LARGE one (including a fraction of deleted
 * history) — each under its own connector_id so a connector_id-scoped page
 * read measures exactly one phase's connections. A per-connection query
 * that is a fixed-shape aggregate (COUNT(*)/MAX(...)) issues the SAME
 * NUMBER OF STATEMENTS regardless of how many rows that aggregate scans.
 */
async function assertPageIsRecordCorpusIndependent(asUrl: string): Promise<void> {
  await seedFleetWithRecordsPerConnection("small", SMALL_RECORD_COUNT_PER_CONNECTION);
  await seedFleetWithRecordsPerConnection("large", LARGE_RECORD_COUNT_PER_CONNECTION);
  const measure = isPostgresStorageBackend()
    ? (fn: () => Promise<ListEnvelope>) => countPostgresCalls(fn)
    : (fn: () => Promise<ListEnvelope>) => countSqliteCalls(fn);

  const small = await measure(() => getPage(asUrl, "small"));
  assert.equal(small.result.data?.length, CONNECTION_COUNT, "the fixed small-corpus fleet fits in one page");

  const large = await measure(() => getPage(asUrl, "large"));
  assert.equal(
    large.result.data?.length,
    CONNECTION_COUNT,
    "the SAME fixed connection count still fits in one page — only the per-connection corpus grew"
  );
  assert.ok(
    large.calls <= small.calls * 2 + 10,
    `bounded-page SQL execution count for a FIXED connection count must not scale with per-connection record corpus size (small-corpus:${small.calls}, large-corpus (${LARGE_RECORD_COUNT_PER_CONNECTION}/stream):${large.calls})`
  );
  assert.ok(!JSON.stringify(large.result).includes(SECRET), "bounded page evidence must never select source secrets");
}

test("SQLite: a bounded page's SQL execution count is independent of per-connection record corpus size", async () => {
  await withMountedRoute(null, assertPageIsRecordCorpusIndependent);
});

/**
 * Plan oracle: proves the per-connection canonical-count aggregate
 * (`connector-summary-evidence-engine.ts`'s `SELECT connector_instance_id,
 * COUNT(*) ... FROM records WHERE deleted = false GROUP BY
 * connector_instance_id`) is answered via an index covering
 * `connector_instance_id` (SQLite has two candidates —
 * `idx_records_lookup`/`idx_records_version` — either is sargable here;
 * this only asserts an INDEX is used, never a full table scan), so a large
 * per-connection corpus does not degrade this query to O(entire `records`
 * table) even at the single-statement level.
 */
async function assertCanonicalCountUsesIndexSqlite(): Promise<void> {
  await seedFleetWithRecordsPerConnection("large", LARGE_RECORD_COUNT_PER_CONNECTION);
  const db = getDb();
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT connector_instance_id, COUNT(*) AS total_records FROM records WHERE deleted = 0 AND connector_instance_id IN (?) GROUP BY connector_instance_id"
    )
    .all(instanceId("large", 0)) as readonly { detail?: string }[];
  const detail = plan.map((row) => row.detail ?? "").join(" | ");
  assert.match(
    detail,
    SQLITE_RECORDS_INDEX,
    `the canonical record count must use a connector_instance_id-leading index, not a full table scan; got: ${detail}`
  );
  assert.doesNotMatch(detail, SQLITE_RECORDS_FULL_SCAN, `must not fall back to a full table scan; got: ${detail}`);
}

test("SQLite: the canonical per-connection record count uses the connector_instance_id index, not a full table scan", async () => {
  await withMountedRoute(null, assertCanonicalCountUsesIndexSqlite);
});

if (POSTGRES_URL) {
  test("PostgreSQL: a bounded page's SQL execution count is independent of per-connection record corpus size", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_record_corpus_${process.pid}_${Date.now()}`,
      },
      async (url) => await withMountedRoute(url, assertPageIsRecordCorpusIndependent)
    );
  });

  test("PostgreSQL: the canonical per-connection record count uses an index, not a sequential scan", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_record_corpus_explain_${process.pid}_${Date.now()}`,
      },
      async (url) =>
        await withMountedRoute(url, async () => {
          await seedFleetWithRecordsPerConnection("large", LARGE_RECORD_COUNT_PER_CONNECTION);
          const result = await postgresQuery(
            "EXPLAIN SELECT connector_instance_id, COUNT(*)::int AS total_records FROM records WHERE deleted = FALSE AND connector_instance_id = ANY($1::text[]) GROUP BY connector_instance_id",
            [[instanceId("large", 0)]]
          );
          const planText = (result.rows as readonly { "QUERY PLAN"?: string }[])
            .map((row) => row["QUERY PLAN"] ?? "")
            .join(" | ");
          assert.doesNotMatch(
            planText,
            POSTGRES_RECORDS_SEQ_SCAN,
            `must not sequentially scan the records table; got: ${planText}`
          );
        })
    );
  });
}
