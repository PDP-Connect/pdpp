// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing coverage for the public `query_not_found` typed-error code
 * (server/routes/ref-error-status.ts: `query_not_found: 404`).
 *
 * `getRecordFieldWindow` supports a `q` selector that returns a bounded text
 * window centered on the FIRST occurrence of `q` within a text field (the
 * `content_ladder` / read_record_field affordance). When `q` does not occur in
 * the field's text, the read raises a `query_not_found` (HTTP 404) error rather
 * than returning an empty or offset-0 window — the caller asked to be anchored
 * on a match that does not exist.
 *
 * The existing field-window substrate test exercises the SUCCESS path of the
 * `q` selector but never the miss; no `test/` file exercised `query_not_found`
 * by name, so a mutation dropping the "no match" branch (silently returning a
 * degenerate window) or corrupting the code string went undetected. This test
 * pins the miss case on both storage backends.
 *
 * Note: this test only OBSERVES `getRecordFieldWindow`; it changes no behavior.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { getRecordFieldWindow as getRecordFieldWindowUntyped, ingestRecord } from "../server/records.ts";

// `getRecordFieldWindow`'s `manifest` parameter carries a `null` default value
// in its untyped JS declaration (server/records.js), which TS infers as the
// parameter's whole type. The real runtime contract accepts a manifest
// object, as every call below proves; this restates that real contract so
// callers do not need to fight the inferred-from-default narrowing at every
// call site.
type GetRecordFieldWindow = (
  storageTarget: string,
  stream: string,
  recordId: string,
  fieldPath: string,
  grant: unknown,
  manifest: unknown,
  requestParams: Record<string, unknown>
) => Promise<{ window: { match_start_chars: number } }>;

const getRecordFieldWindow = getRecordFieldWindowUntyped as GetRecordFieldWindow;

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const CONNECTOR_ID = "query_not_found_demo";
const STREAM = "emails";

function hasCodeAndHttpStatus(err: unknown): err is { code: unknown; httpStatus: unknown } {
  return typeof err === "object" && err !== null && "code" in err && "httpStatus" in err;
}

const MANIFEST = {
  connector_id: CONNECTOR_ID,
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
        required: ["id"],
        type: "object",
      },
      selection: { fields: true },
    },
  ],
  version: "1.0.0",
};

const SEED = [
  {
    body: "Alpha Hyperlane Bridge Omega",
    created_at: "2026-01-01T00:00:00.000Z",
    id: "e1",
  },
];

const GRANT = { streams: [{ fields: ["id", "created_at", "body"], name: STREAM }] };

async function seed() {
  await registerConnector(MANIFEST);
  for (const data of SEED) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
    await ingestRecord(CONNECTOR_ID, {
      data,
      emitted_at: data.created_at,
      key: data.id,
      stream: STREAM,
    });
  }
}

async function runConformance(label: string): Promise<void> {
  await seed();

  // Sanity: a needle that IS present resolves to a match window (proves the
  // record + field are readable, so a miss below is truly a "not found in
  // field", not a not-granted / not-found-record outcome).
  const hit = await getRecordFieldWindow(CONNECTOR_ID, STREAM, "e1", "body", GRANT, MANIFEST, {
    after_chars: 0,
    before_chars: 0,
    q: "Hyperlane",
  });
  assert.equal(hit.window.match_start_chars, 6, `${label}: present needle anchors on its match`);

  // The miss: a needle absent from the field text raises query_not_found (404).
  await assert.rejects(
    () =>
      getRecordFieldWindow(CONNECTOR_ID, STREAM, "e1", "body", GRANT, MANIFEST, {
        q: "needle-that-is-absent",
      }),
    (err) => {
      assert.ok(hasCodeAndHttpStatus(err));
      assert.equal(err.code, "query_not_found", `${label}: absent q SHALL raise query_not_found`);
      assert.equal(err.httpStatus, 404, `${label}: query_not_found is a 404`);
      return true;
    },
    `${label}: absent q selector`
  );

  // Case-insensitive matching means a differently-cased present needle is a HIT,
  // not a miss — so a miss is genuinely "no such text", not a casing artifact.
  const caseHit = await getRecordFieldWindow(CONNECTOR_ID, STREAM, "e1", "body", GRANT, MANIFEST, {
    after_chars: 0,
    before_chars: 0,
    q: "bridge",
  });
  assert.equal(caseHit.window.match_start_chars, 16, `${label}: case-insensitive present needle is a hit`);
}

test("SQLite: query_not_found on an absent q selector", async () => {
  initDb(":memory:");
  try {
    await runConformance("sqlite");
  } finally {
    closeDb();
  }
});

async function cleanupPostgres() {
  for (const table of ["records", "record_changes", "version_counter", "retained_size_stream", "connectors"]) {
    const column = table === "retained_size_stream" ? "stream" : "connector_id";
    const value = table === "retained_size_stream" ? STREAM : CONNECTOR_ID;
    // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
    await postgresQuery(`DELETE FROM ${table} WHERE ${column} = $1`, [value]).catch(() => {});
  }
}

if (POSTGRES_URL) {
  test("Postgres: query_not_found on an absent q selector (parity with SQLite)", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      await runConformance("postgres");
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });
} else {
  test("Postgres: query_not_found on an absent q selector (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  }, () => {});
}
