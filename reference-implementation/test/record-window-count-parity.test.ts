// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Dual-backend parity for the record-list `window` and `count` aggregates.
//
// `queryRecords` dispatches to the SQLite store or the real `postgresQueryRecords`
// based on the active backend, so the SAME test body run under each backend is a
// true conformance check of the production code (not a test-only reimplementation
// like the record-read-conformance Postgres driver).
//
// This pins a known parity gap: the Postgres list path validated `window` but did
// not compute `meta.window`, so a client asking for `window: 'exact'` got bounds
// on SQLite and nothing on Postgres. Storage-convergence increment 2.

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { ingestRecord, queryRecords as queryRecordsUntyped } from "../server/records.ts";

// queryRecords is imported from checkJs:false JS; its `manifest` parameter
// is inferred as exactly `null` from a `manifest = null` default, which a
// real manifest object never satisfies structurally. This wrapper restates
// the real contract (params and the meta.window/meta.count response shape
// this file reads), verified against the source signature and its
// downstream buildWindowEnvelope/mergeMetaWindow/mergeMetaCount calls.
interface QueryRecordsResult {
  meta?: {
    count?: { kind: string; value: number };
    window?: { earliest_at: string | null; latest_at: string | null; total: number };
  };
}

type QueryRecordsFn = (
  storageTarget: unknown,
  stream: string,
  grant: unknown,
  requestParams: Record<string, unknown>,
  manifest: unknown
) => Promise<QueryRecordsResult>;

const queryRecords = queryRecordsUntyped as QueryRecordsFn;

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const CONNECTOR_ID = "window_parity_demo";
const STREAM = "items";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  display_name: "Record window count parity",
  manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "created_at",
      cursor_field: "created_at",
      name: STREAM,
      primary_key: ["id"],
      schema: {
        properties: {
          body: { type: "string" },
          created_at: { format: "date-time", type: "string" },
          id: { type: "string" },
        },
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

const SEED = [
  { body: "a", created_at: "2026-01-01T00:00:00.000Z", id: "r1" },
  { body: "b", created_at: "2026-01-02T00:00:00.000Z", id: "r2" },
  { body: "c", created_at: "2026-01-03T00:00:00.000Z", id: "r3" },
];

const GRANT = { streams: [{ fields: ["id", "created_at", "body"], name: STREAM }] };

async function seedAndQuery(seed = SEED) {
  await registerConnector(MANIFEST);
  for (const data of seed) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await ingestRecord(CONNECTOR_ID, { data, emitted_at: data.created_at, key: data.id, stream: STREAM });
  }
  return queryRecords(CONNECTOR_ID, STREAM, GRANT, { count: "exact", window: "exact" }, MANIFEST);
}

// Rows whose consent_time carries non-UTC offsets and unparseable values.
// The chronological earliest is r_late (-07:00 == 13:00Z) vs r_early (+02:00
// == 06:00Z); a lexicographic MIN/MAX would pick the wrong bound, and the
// malformed values must be skipped whether they are lexically-small or
// ISO-shaped-but-invalid. Both backends must agree on the chronological bounds
// over the parseable rows.
const TZ_SEED = [
  { body: "x", created_at: "2026-02-01T08:00:00+02:00", id: "z1" }, // 06:00Z (earliest)
  { body: "y", created_at: "2026-02-01T06:00:00-07:00", id: "z2" }, // 13:00Z (latest)
  { body: "z", created_at: "2026-02-01T10:00:00+00:00", id: "z3" }, // 10:00Z
  { body: "w", created_at: "-bad-date", id: "z4" }, // unparseable, must be skipped
  { body: "v", created_at: "2026-99-99T00:00:00Z", id: "z5" }, // ISO-shaped but unparseable
];

function assertTimezoneWindow(result: QueryRecordsResult, label: string): void {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
  assert.ok(result?.meta?.window, `${label}: tz seed must produce meta.window`);
  assert.equal(result.meta.window.total, 5, `${label}: total counts all 5 rows`);
  assert.equal(result.meta.window.earliest_at, "2026-02-01T06:00:00.000Z", `${label}: chronological earliest`);
  assert.equal(result.meta.window.latest_at, "2026-02-01T13:00:00.000Z", `${label}: chronological latest`);
}

// The behavioral contract both backends must satisfy. Asserting it in one place
// guarantees SQLite and Postgres agree.
function assertWindowAndCount(result: QueryRecordsResult, label: string): void {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
  assert.ok(result?.meta, `${label}: response must carry meta`);
  assert.deepEqual(
    result.meta.count,
    { kind: "exact", value: 3 },
    `${label}: exact count must equal the 3 seeded rows`
  );
  assert.ok(result.meta.window, `${label}: window: 'exact' must produce meta.window`);
  assert.equal(result.meta.window.total, 3, `${label}: window total over the 3 seeded rows`);
  // Window bounds span the cursor/consent-time field across the seeded rows.
  assert.equal(result.meta.window.earliest_at, "2026-01-01T00:00:00.000Z", `${label}: window earliest_at`);
  assert.equal(result.meta.window.latest_at, "2026-01-03T00:00:00.000Z", `${label}: window latest_at`);
}

test("SQLite: window:exact + count:exact produce bounds and count", async () => {
  initDb(":memory:");
  try {
    const result = await seedAndQuery();
    assertWindowAndCount(result, "sqlite");
  } finally {
    closeDb();
  }
});

test("SQLite: window bounds are chronological across non-UTC offsets, skipping unparseable rows", async () => {
  initDb(":memory:");
  try {
    const result = await seedAndQuery(TZ_SEED);
    assertTimezoneWindow(result, "sqlite");
  } finally {
    closeDb();
  }
});

// Clean every table the Postgres tests touch so they do not pollute other
// suites sharing a Postgres test database.
async function cleanupPostgres() {
  for (const table of ["records", "record_changes", "version_counter", "retained_size_stream", "connectors"]) {
    const column = table === "retained_size_stream" ? "stream" : "connector_id";
    const value = table === "retained_size_stream" ? STREAM : CONNECTOR_ID;
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await postgresQuery(
      `DELETE FROM ${table} WHERE ${column} = $1`,
      [value]
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    ).catch(() => {});
  }
}

if (POSTGRES_URL) {
  test("Postgres: window:exact + count:exact produce bounds and count (parity with SQLite)", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      const result = await seedAndQuery();
      assertWindowAndCount(result, "postgres");
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });

  test("Postgres: window bounds are chronological across non-UTC offsets, skipping unparseable rows (parity with SQLite)", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      const result = await seedAndQuery(TZ_SEED);
      assertTimezoneWindow(result, "postgres");
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });
} else {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
  test("Postgres: window/count parity (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {});
}
