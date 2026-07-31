// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity matrix for the postgresListPartitions loose-index-scan rewrite.
 *
 * PROVES:
 *   1. The recursive loose-index-scan query returns EXACTLY the same
 *      (connectorId, connectorType, stream) set as a plain `SELECT DISTINCT`
 *      would, across every appendPostgresScope filter combination.
 *   2. Deleted-only partitions are excluded; partitions with a mix of
 *      deleted/live rows are still included (once).
 *   3. Special/edge-case string values (empty string, quotes, unicode) round-trip
 *      correctly through the loose scan.
 *   4. Output is deterministically ordered (connectorId, stream ascending) on
 *      both backends.
 *   5. SQLite and Postgres agree on the same seeded dataset.
 *
 * Mutation coverage: a broken filter (e.g. dropping a scope clause, or
 * reverting to an unscoped scan) is caught by the "connectionIds/streams
 * scope is honored" tests below, which assert the EXACT set, not just a
 * non-empty result — a query that silently returns extra or missing
 * partitions fails these tests.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExploreTimelinePartition } from "../operations/rs-explore-timeline/index.ts";

import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  buildPostgresExploreTimelineDeps,
  buildSqliteExploreTimelineDeps,
} from "../server/explore-timeline-substrate.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord } from "../server/records.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const SUFFIX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function sortPartitions(rows: readonly ExploreTimelinePartition[]): ExploreTimelinePartition[] {
  return [...rows].sort((a, b) => a.connectorId.localeCompare(b.connectorId) || a.stream.localeCompare(b.stream));
}

function assertSameOrderedSet(
  actual: readonly ExploreTimelinePartition[],
  expected: readonly ExploreTimelinePartition[],
  label: string
) {
  assert.deepEqual(sortPartitions(actual), sortPartitions(expected), `${label}: partition set mismatch`);
}

// Directly insert a row bypassing ingestRecord's validation, to reach edge-case
// values (deleted rows, empty-string identifiers) ingestRecord would reject.
function rawInsertSqlite(row: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  recordKey: string;
  deleted: boolean;
}) {
  getDb()
    .prepare(
      `INSERT INTO records (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.connectorId,
      row.connectorInstanceId,
      row.stream,
      row.recordKey,
      "{}",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      row.deleted ? 1 : 0
    );
}

async function rawInsertPostgres(row: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  recordKey: string;
  deleted: boolean;
}) {
  await postgresQuery(
    `INSERT INTO records (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, deleted, primary_key_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $4)`,
    [
      row.connectorId,
      row.connectorInstanceId,
      row.stream,
      row.recordKey,
      "{}",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      row.deleted,
    ]
  );
}

// ---------------------------------------------------------------------------
// SQLite matrix
// ---------------------------------------------------------------------------

test("listPartitions (sqlite): filter matrix, deleted handling, and deterministic ordering", async () => {
  initDb(":memory:");
  try {
    const cinA = `lp_cin_a_${SUFFIX}`;
    const cinB = `lp_cin_b_${SUFFIX}`;
    const cinC = `lp_cin_c_${SUFFIX}`;

    // Live rows across 2 connections, multiple streams.
    await ingestRecord(
      { connectorId: "ctype_a", connectorInstanceId: cinA },
      { data: {}, emitted_at: "2026-01-01T00:00:00.000Z", key: "k1", stream: "accounts" }
    );
    await ingestRecord(
      { connectorId: "ctype_a", connectorInstanceId: cinA },
      { data: {}, emitted_at: "2026-01-01T00:00:00.000Z", key: "k2", stream: "transactions" }
    );
    await ingestRecord(
      { connectorId: "ctype_b", connectorInstanceId: cinB },
      { data: {}, emitted_at: "2026-01-01T00:00:00.000Z", key: "k3", stream: "accounts" }
    );

    // Deleted-only partition: connector_instance_id cinC, stream "ghost" — must
    // never appear in any result.
    rawInsertSqlite({
      connectorId: "ctype_c",
      connectorInstanceId: cinC,
      deleted: true,
      recordKey: "k4",
      stream: "ghost",
    });

    // Mixed partition: cinA/"mixed" has one deleted row and one live row — must
    // appear exactly once.
    rawInsertSqlite({
      connectorId: "ctype_a",
      connectorInstanceId: cinA,
      deleted: true,
      recordKey: "k5",
      stream: "mixed",
    });
    rawInsertSqlite({
      connectorId: "ctype_a",
      connectorInstanceId: cinA,
      deleted: false,
      recordKey: "k6",
      stream: "mixed",
    });

    const deps = buildSqliteExploreTimelineDeps();

    const expectedUnscoped: ExploreTimelinePartition[] = [
      { connectorId: cinA, connectorType: "ctype_a", stream: "accounts" },
      { connectorId: cinA, connectorType: "ctype_a", stream: "transactions" },
      { connectorId: cinA, connectorType: "ctype_a", stream: "mixed" },
      { connectorId: cinB, connectorType: "ctype_b", stream: "accounts" },
    ];
    const unscoped = await deps.listPartitions();
    assertSameOrderedSet(unscoped, expectedUnscoped, "sqlite unscoped");
    assert.equal(
      unscoped.some((p) => p.connectorId === cinC),
      false,
      "sqlite: deleted-only partition must be absent"
    );

    // connectionIds include
    const includeConn = await deps.listPartitions({ connectionIds: [cinA] });
    assertSameOrderedSet(
      includeConn,
      [
        { connectorId: cinA, connectorType: "ctype_a", stream: "accounts" },
        { connectorId: cinA, connectorType: "ctype_a", stream: "transactions" },
        { connectorId: cinA, connectorType: "ctype_a", stream: "mixed" },
      ],
      "sqlite connectionIds include"
    );

    // streams include
    const includeStreams = await deps.listPartitions({ streams: ["accounts"] });
    assertSameOrderedSet(
      includeStreams,
      [
        { connectorId: cinA, connectorType: "ctype_a", stream: "accounts" },
        { connectorId: cinB, connectorType: "ctype_b", stream: "accounts" },
      ],
      "sqlite streams include"
    );

    // excludeConnectionIds
    const excludeConn = await deps.listPartitions({ excludeConnectionIds: [cinA] });
    assertSameOrderedSet(
      excludeConn,
      [{ connectorId: cinB, connectorType: "ctype_b", stream: "accounts" }],
      "sqlite excludeConnectionIds"
    );

    // excludeStreams
    const excludeStreams = await deps.listPartitions({ excludeStreams: ["mixed", "transactions"] });
    assertSameOrderedSet(
      excludeStreams,
      [
        { connectorId: cinA, connectorType: "ctype_a", stream: "accounts" },
        { connectorId: cinB, connectorType: "ctype_b", stream: "accounts" },
      ],
      "sqlite excludeStreams"
    );

    // mixed filters: streams include + excludeConnectionIds
    const mixed = await deps.listPartitions({ excludeConnectionIds: [cinB], streams: ["accounts", "mixed"] });
    assertSameOrderedSet(
      mixed,
      [
        { connectorId: cinA, connectorType: "ctype_a", stream: "accounts" },
        { connectorId: cinA, connectorType: "ctype_a", stream: "mixed" },
      ],
      "sqlite mixed filters"
    );

    // empty result: impossible filter
    const empty = await deps.listPartitions({ connectionIds: ["lp_does_not_exist"] });
    assert.deepEqual(empty, [], "sqlite: impossible filter yields empty array");
  } finally {
    closeDb();
  }
});

test("listPartitions (sqlite): special string values round-trip exactly", async () => {
  initDb(":memory:");
  try {
    const cinEmpty = "";
    const cinQuote = `lp_quote_${SUFFIX}_'"\\`;
    const cinUnicode = `lp_unicode_${SUFFIX}_日本語`;

    rawInsertSqlite({ connectorId: "", connectorInstanceId: cinEmpty, deleted: false, recordKey: "k1", stream: "" });
    rawInsertSqlite({
      connectorId: "ctype_special",
      connectorInstanceId: cinQuote,
      deleted: false,
      recordKey: "k2",
      stream: "stream with spaces",
    });
    rawInsertSqlite({
      connectorId: "ctype_special",
      connectorInstanceId: cinUnicode,
      deleted: false,
      recordKey: "k3",
      stream: "stream_文字",
    });

    const deps = buildSqliteExploreTimelineDeps();
    const result = await deps.listPartitions();

    assertSameOrderedSet(
      result,
      [
        { connectorId: cinEmpty, connectorType: "", stream: "" },
        { connectorId: cinQuote, connectorType: "ctype_special", stream: "stream with spaces" },
        { connectorId: cinUnicode, connectorType: "ctype_special", stream: "stream_文字" },
      ],
      "sqlite special values"
    );
  } finally {
    closeDb();
  }
});

// ---------------------------------------------------------------------------
// Postgres matrix (mirrors the sqlite matrix exactly)
// ---------------------------------------------------------------------------

if (POSTGRES_URL) {
  test("listPartitions (postgres): filter matrix, deleted handling, and deterministic ordering", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      const cinA = `lp_cin_a_${SUFFIX}`;
      const cinB = `lp_cin_b_${SUFFIX}`;
      const cinC = `lp_cin_c_${SUFFIX}`;

      await ingestRecord(
        { connectorId: "ctype_a", connectorInstanceId: cinA },
        { data: {}, emitted_at: "2026-01-01T00:00:00.000Z", key: "k1", stream: "accounts" }
      );
      await ingestRecord(
        { connectorId: "ctype_a", connectorInstanceId: cinA },
        { data: {}, emitted_at: "2026-01-01T00:00:00.000Z", key: "k2", stream: "transactions" }
      );
      await ingestRecord(
        { connectorId: "ctype_b", connectorInstanceId: cinB },
        { data: {}, emitted_at: "2026-01-01T00:00:00.000Z", key: "k3", stream: "accounts" }
      );

      await rawInsertPostgres({
        connectorId: "ctype_c",
        connectorInstanceId: cinC,
        deleted: true,
        recordKey: "k4",
        stream: "ghost",
      });
      await rawInsertPostgres({
        connectorId: "ctype_a",
        connectorInstanceId: cinA,
        deleted: true,
        recordKey: "k5",
        stream: "mixed",
      });
      await rawInsertPostgres({
        connectorId: "ctype_a",
        connectorInstanceId: cinA,
        deleted: false,
        recordKey: "k6",
        stream: "mixed",
      });

      const deps = buildPostgresExploreTimelineDeps();

      const expectedUnscoped: ExploreTimelinePartition[] = [
        { connectorId: cinA, connectorType: "ctype_a", stream: "accounts" },
        { connectorId: cinA, connectorType: "ctype_a", stream: "transactions" },
        { connectorId: cinA, connectorType: "ctype_a", stream: "mixed" },
        { connectorId: cinB, connectorType: "ctype_b", stream: "accounts" },
      ];
      // Scope every read to our own seeded ids so a shared live Postgres database
      // (this test suite may run concurrently with others) can't leak extra rows in.
      const scopeToOurs = { connectionIds: [cinA, cinB, cinC] };
      const unscoped = await deps.listPartitions(scopeToOurs);
      assertSameOrderedSet(unscoped, expectedUnscoped, "postgres unscoped (scoped to seeded ids)");
      assert.equal(
        unscoped.some((p) => p.connectorId === cinC),
        false,
        "postgres: deleted-only partition must be absent"
      );

      const includeConn = await deps.listPartitions({ connectionIds: [cinA] });
      assertSameOrderedSet(
        includeConn,
        [
          { connectorId: cinA, connectorType: "ctype_a", stream: "accounts" },
          { connectorId: cinA, connectorType: "ctype_a", stream: "transactions" },
          { connectorId: cinA, connectorType: "ctype_a", stream: "mixed" },
        ],
        "postgres connectionIds include"
      );

      const includeStreams = await deps.listPartitions({ ...scopeToOurs, streams: ["accounts"] });
      assertSameOrderedSet(
        includeStreams,
        [
          { connectorId: cinA, connectorType: "ctype_a", stream: "accounts" },
          { connectorId: cinB, connectorType: "ctype_b", stream: "accounts" },
        ],
        "postgres streams include"
      );

      const excludeConn = await deps.listPartitions({ ...scopeToOurs, excludeConnectionIds: [cinA] });
      assertSameOrderedSet(
        excludeConn,
        [{ connectorId: cinB, connectorType: "ctype_b", stream: "accounts" }],
        "postgres excludeConnectionIds"
      );

      const excludeStreams = await deps.listPartitions({ ...scopeToOurs, excludeStreams: ["mixed", "transactions"] });
      assertSameOrderedSet(
        excludeStreams,
        [
          { connectorId: cinA, connectorType: "ctype_a", stream: "accounts" },
          { connectorId: cinB, connectorType: "ctype_b", stream: "accounts" },
        ],
        "postgres excludeStreams"
      );

      const mixed = await deps.listPartitions({
        ...scopeToOurs,
        excludeConnectionIds: [cinB],
        streams: ["accounts", "mixed"],
      });
      assertSameOrderedSet(
        mixed,
        [
          { connectorId: cinA, connectorType: "ctype_a", stream: "accounts" },
          { connectorId: cinA, connectorType: "ctype_a", stream: "mixed" },
        ],
        "postgres mixed filters"
      );

      const empty = await deps.listPartitions({ connectionIds: ["lp_does_not_exist"] });
      assert.deepEqual(empty, [], "postgres: impossible filter yields empty array");
    } finally {
      await postgresQuery("DELETE FROM records WHERE connector_instance_id = ANY($1::text[])", [
        [`lp_cin_a_${SUFFIX}`, `lp_cin_b_${SUFFIX}`, `lp_cin_c_${SUFFIX}`],
      ]);
      await closePostgresStorage();
      closeDb();
    }
  });

  test("listPartitions (postgres): special string values round-trip exactly", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      const cinQuote = `lp_quote_${SUFFIX}_pg`;
      const cinUnicode = `lp_unicode_${SUFFIX}_pg`;

      await rawInsertPostgres({
        connectorId: "ctype_special",
        connectorInstanceId: cinQuote,
        deleted: false,
        recordKey: "k2",
        stream: "stream with spaces",
      });
      await rawInsertPostgres({
        connectorId: "ctype_special",
        connectorInstanceId: cinUnicode,
        deleted: false,
        recordKey: "k3",
        stream: "stream_文字",
      });

      const deps = buildPostgresExploreTimelineDeps();
      const result = await deps.listPartitions({ connectionIds: [cinQuote, cinUnicode] });

      assertSameOrderedSet(
        result,
        [
          { connectorId: cinQuote, connectorType: "ctype_special", stream: "stream with spaces" },
          { connectorId: cinUnicode, connectorType: "ctype_special", stream: "stream_文字" },
        ],
        "postgres special values"
      );
    } finally {
      await postgresQuery("DELETE FROM records WHERE connector_instance_id = ANY($1::text[])", [
        [`lp_quote_${SUFFIX}_pg`, `lp_unicode_${SUFFIX}_pg`],
      ]);
      await closePostgresStorage();
      closeDb();
    }
  });
  test("listPartitions: sqlite and postgres agree on the same seeded dataset shape", async () => {
    const cinA = `lp_xb_a_${SUFFIX}`;
    const cinB = `lp_xb_b_${SUFFIX}`;
    const cinC = `lp_xb_c_${SUFFIX}`;
    const shape = [
      { connectorId: "ctype_a", connectorInstanceId: cinA, stream: "accounts" },
      { connectorId: "ctype_a", connectorInstanceId: cinA, stream: "transactions" },
      { connectorId: "ctype_b", connectorInstanceId: cinB, stream: "accounts" },
    ];

    // SQLite leg first — isPostgresStorageBackend() defaults to false until
    // initPostgresStorage() is called, so ingestRecord correctly targets SQLite.
    initDb(":memory:");
    let sqliteResult: readonly ExploreTimelinePartition[];
    try {
      for (const row of shape) {
        // biome-ignore lint/performance/noAwaitInLoops: Deterministic fixture seeding.
        await ingestRecord(
          { connectorId: row.connectorId, connectorInstanceId: row.connectorInstanceId },
          { data: {}, emitted_at: "2026-01-01T00:00:00.000Z", key: `${row.stream}_k`, stream: row.stream }
        );
      }
      rawInsertSqlite({
        connectorId: "ctype_c",
        connectorInstanceId: cinC,
        deleted: true,
        recordKey: "ghost_k",
        stream: "ghost",
      });
      sqliteResult = await buildSqliteExploreTimelineDeps().listPartitions();
    } finally {
      closeDb();
    }

    // Postgres leg second, same shape, isolated database, own cleanup.
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    let postgresResult: readonly ExploreTimelinePartition[];
    try {
      for (const row of shape) {
        // biome-ignore lint/performance/noAwaitInLoops: Deterministic fixture seeding.
        await ingestRecord(
          { connectorId: row.connectorId, connectorInstanceId: row.connectorInstanceId },
          { data: {}, emitted_at: "2026-01-01T00:00:00.000Z", key: `${row.stream}_k`, stream: row.stream }
        );
      }
      await rawInsertPostgres({
        connectorId: "ctype_c",
        connectorInstanceId: cinC,
        deleted: true,
        recordKey: "ghost_k",
        stream: "ghost",
      });
      postgresResult = await buildPostgresExploreTimelineDeps().listPartitions({ connectionIds: [cinA, cinB, cinC] });
    } finally {
      await postgresQuery("DELETE FROM records WHERE connector_instance_id = ANY($1::text[])", [[cinA, cinB, cinC]]);
      await closePostgresStorage();
      closeDb();
    }

    assertSameOrderedSet(sqliteResult, postgresResult, "sqlite vs postgres, same seeded shape");
  });
} else {
  test("listPartitions (postgres): skipped (PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => undefined);
}
