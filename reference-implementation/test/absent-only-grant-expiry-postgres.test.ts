// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct PostgreSQL regression for the absent-only `expires_at` startup
 * migration.
 *
 * The focused migration test (`absent-only-grant-expiry.test.ts`) seeds and
 * reopens SQLite. That is the wrong backend to prove this change on: production
 * runs PostgreSQL, and this PR is a live representation rewrite covering nearly
 * every production grant. The two migrations are also written in different
 * dialects against different column types --
 *
 *   SQLite      TEXT  + json_remove(grant_json, '$.expires_at')
 *   PostgreSQL  JSONB + grant_json - 'expires_at'
 *
 * -- so passing on one says nothing about the other. `jsonb_typeof(...) =
 * 'null'` in particular distinguishes a JSON null from SQL NULL, and no SQLite
 * test can exercise that distinction.
 *
 * This file therefore runs the REAL `bootstrapPostgresSchema()` against a real
 * PostgreSQL server and proves, in order:
 *
 *   1. an explicit JSON null `expires_at` becomes absent;
 *   2. a string expiry is unchanged;
 *   3. an already-absent expiry stays absent;
 *   4. repeated startup is idempotent;
 *   5. the SQL `expires_at` COLUMN binding remains correct (the migration
 *      touches the JSONB blob only, never the column the queries filter on);
 *   6. the agent-connect grant/response copies are normalized.
 *
 * Point 6 is covered at the READ path rather than by a migration -- see
 * `agent-connect-absent-only-expiry.test.ts` for why a one-shot migration
 * cannot close that seam -- so it is asserted here end-to-end through the real
 * attempt store to prove the two repairs compose on PostgreSQL.
 *
 * Gated on `PDPP_TEST_POSTGRES_URL`. When unset each PostgreSQL case names
 * the reason, so coverage remains visible without adding a duplicate umbrella
 * skip.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  bootstrapPostgresSchema,
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { createAgentConnectAttemptStore } from "../server/routes/as-agent-connect.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or non-dedicated";

const LEGACY_NULL = "grt_pg_legacy_null";
const REAL_EXPIRY = "grt_pg_real_expiry";
const ALREADY_ABSENT = "grt_pg_already_absent";
const EXPIRY_STRING = "2027-04-06T00:00:00Z";

interface GrantRow {
  expires_at: string | null;
  grant_json: Record<string, unknown>;
}

/** Boot the real PostgreSQL schema, run `body`, then clean up what we seeded. */
function withPostgres(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    assert.ok(POSTGRES_URL);
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await bootstrapPostgresSchema();
      await clearSeed();
      await body();
    } finally {
      await clearSeed().catch(() => undefined);
      await closePostgresStorage();
    }
  };
}

async function clearSeed(): Promise<void> {
  await postgresQuery("DELETE FROM grants WHERE grant_id = ANY($1)", [[LEGACY_NULL, REAL_EXPIRY, ALREADY_ABSENT]]);
}

/**
 * Seed the three pre-migration shapes.
 *
 * The blobs are inserted as JSONB, so `expires_at: null` is a genuine JSON
 * null inside the document -- which is exactly what the migration predicate
 * `jsonb_typeof(grant_json->'expires_at') = 'null'` has to recognise, and what
 * distinguishes this from a SQL NULL column.
 */
async function seedPreMigrationGrants(): Promise<void> {
  const insert = async (grantId: string, grantJson: Record<string, unknown>, expiresAtColumn: string | null) => {
    await postgresQuery(
      `INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, issued_at, expires_at)
       VALUES($1, 'owner-1', 'client-1', $2::jsonb, $3, '2026-08-11T12:00:00Z', $4)`,
      [grantId, JSON.stringify(grantJson), grantJson.access_mode as string, expiresAtColumn]
    );
  };
  // 1. The legacy shape: an explicit JSON null.
  await insert(LEGACY_NULL, { access_mode: "continuous", expires_at: null, grant_id: LEGACY_NULL }, null);
  // 2. A real expiry, which must survive untouched -- in BOTH the blob and the
  //    column, since dropping it would silently unbound a bounded grant.
  await insert(
    REAL_EXPIRY,
    { access_mode: "single_use", expires_at: EXPIRY_STRING, grant_id: REAL_EXPIRY },
    EXPIRY_STRING
  );
  // 3. Already normalized: the migration must be a no-op, not a re-write.
  await insert(ALREADY_ABSENT, { access_mode: "continuous", grant_id: ALREADY_ABSENT }, null);
}

async function readGrants(): Promise<Map<string, GrantRow>> {
  const result = await postgresQuery<{ expires_at: string | null; grant_id: string; grant_json: unknown }>(
    "SELECT grant_id, grant_json, expires_at FROM grants WHERE grant_id = ANY($1)",
    [[LEGACY_NULL, REAL_EXPIRY, ALREADY_ABSENT]]
  );
  return new Map(
    result.rows.map((row) => [
      row.grant_id,
      // `pg` already parses JSONB into a JS value.
      { expires_at: row.expires_at, grant_json: row.grant_json as Record<string, unknown> },
    ])
  );
}

test(
  "PostgreSQL startup migration normalizes stored grant_json to absent-only expiry",
  { skip: POSTGRES_SKIP },
  withPostgres(async () => {
    await seedPreMigrationGrants();

    // Confirm the fixture really carries a JSON null before migrating --
    // otherwise this test could pass against a seed that never had the defect.
    const before = await readGrants();
    const seeded = before.get(LEGACY_NULL);
    assert.ok(seeded);
    assert.equal("expires_at" in seeded.grant_json, true, "seed must actually carry the legacy member");
    assert.equal(seeded.grant_json.expires_at, null, "seed must carry a JSON null, not an absent member");

    // Re-run the real startup path: this is the migration under test.
    await bootstrapPostgresSchema();
    const after = await readGrants();

    // --- 1. explicit JSON null becomes absent ---
    const migrated = after.get(LEGACY_NULL);
    assert.ok(migrated);
    assert.equal("expires_at" in migrated.grant_json, false, "explicit JSON null must be removed from the blob");
    assert.equal(migrated.grant_json.access_mode, "continuous", "the rest of the grant must survive");
    assert.equal(migrated.grant_json.grant_id, LEGACY_NULL);

    // --- 2. string expiry unchanged ---
    const untouched = after.get(REAL_EXPIRY);
    assert.ok(untouched);
    assert.equal(untouched.grant_json.expires_at, EXPIRY_STRING, "a real expiry must never be dropped");

    // --- 3. already-absent stays absent ---
    const absent = after.get(ALREADY_ABSENT);
    assert.ok(absent);
    assert.equal("expires_at" in absent.grant_json, false, "an already-absent expiry must stay absent");
    assert.equal(absent.grant_json.access_mode, "continuous");

    // --- 5. the SQL expires_at COLUMN binding remains correct ---
    // The migration edits the JSONB document only. If it ever touched the
    // column, every expiry-filtered query would silently change meaning.
    assert.equal(untouched.expires_at, EXPIRY_STRING, "the expires_at COLUMN must still hold the real expiry");
    assert.equal(migrated.expires_at, null, "a no-expiry grant's column stays SQL NULL");
    assert.equal(absent.expires_at, null);

    // And the column is still what SQL predicates actually select on.
    const selected = await postgresQuery<{ grant_id: string }>(
      "SELECT grant_id FROM grants WHERE grant_id = ANY($1) AND expires_at IS NOT NULL ORDER BY grant_id",
      [[LEGACY_NULL, REAL_EXPIRY, ALREADY_ABSENT]]
    );
    assert.deepEqual(
      selected.rows.map((row) => row.grant_id),
      [REAL_EXPIRY],
      "only the bounded grant may match an expires_at column predicate"
    );
  })
);

test(
  "PostgreSQL startup migration is idempotent across repeated startups",
  { skip: POSTGRES_SKIP },
  withPostgres(async () => {
    await seedPreMigrationGrants();
    await bootstrapPostgresSchema();
    const first = await readGrants();

    // --- 4. repeated startup is idempotent ---
    // Two further boots must not re-write anything: the predicate no longer
    // matches, so the rows must be byte-identical to the first migrated state.
    await bootstrapPostgresSchema();
    await bootstrapPostgresSchema();
    const third = await readGrants();

    for (const grantId of [LEGACY_NULL, REAL_EXPIRY, ALREADY_ABSENT]) {
      assert.deepEqual(
        third.get(grantId),
        first.get(grantId),
        `${grantId} must be unchanged by repeated startup migrations`
      );
    }
    assert.equal("expires_at" in (third.get(LEGACY_NULL)?.grant_json ?? {}), false);
    assert.equal(third.get(REAL_EXPIRY)?.grant_json.expires_at, EXPIRY_STRING);
  })
);

test(
  "PostgreSQL agent-connect grant and response copies are normalized after migration",
  { skip: POSTGRES_SKIP },
  withPostgres(async () => {
    // --- 6. agent-connect grant/response copies normalized ---
    // The startup migration deliberately does NOT rewrite this table; the
    // repair is normalize-on-read plus an atomic rewrite of the materialized
    // response. This proves the two halves compose on PostgreSQL: a
    // pre-upgrade attempt row survives the migration and STILL redeems to an
    // absent expiry, through both the grant copy and the response copy.
    const pollingCode = "pg-migration-polling-code";
    const pollingCodeHash = createHash("sha256").update(pollingCode, "utf8").digest("base64url");
    const token = "tok_pg_migration_agent_connect";
    const legacyGrant = {
      access_mode: "continuous",
      client: { client_id: "research-app" },
      expires_at: null,
      grant_id: "grt_pg_attempt_legacy",
      issued_at: "2026-08-11T12:00:00Z",
      purpose_code: "https://pdpp.dev/purpose/research",
    };
    const attemptIds = ["att_pg_mig_fresh", "att_pg_mig_replay"];
    const cleanup = async () => {
      await postgresQuery("DELETE FROM agent_connect_attempts WHERE id = ANY($1)", [attemptIds]);
      await postgresQuery("DELETE FROM tokens WHERE token_id = $1", [token]);
    };
    await cleanup();

    await postgresQuery(
      `INSERT INTO tokens(token_id, subject_id, client_id, token_kind, expires_at, revoked, created_at)
       VALUES($1, 'owner-1', 'research-app', 'access', NULL, FALSE, '2026-08-11T12:00:00Z')`,
      [token]
    );
    const seedAttempt = async (id: string, responseJson: string | null) => {
      await postgresQuery(
        `INSERT INTO agent_connect_attempts(
           id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
           interval_seconds, created_at, expires_at_ms, completed_at, grant_id, grant_json, token, response_json
         ) VALUES($1, $2, 'research-app', $3, 'approved', 'https://as.example/approve',
                  'https://as.example/token', 2, '2026-08-11T12:00:00Z', $4, '2026-08-11T12:00:05Z',
                  $5, $6::jsonb, $7, $8)`,
        [
          id,
          `urn:pg-migration:${id}`,
          pollingCodeHash,
          Date.now() + 600_000,
          legacyGrant.grant_id,
          JSON.stringify(legacyGrant),
          token,
          responseJson,
        ]
      );
    };

    try {
      await seedAttempt("att_pg_mig_fresh", null);
      await seedAttempt(
        "att_pg_mig_replay",
        JSON.stringify({
          access_token: token,
          grant: legacyGrant,
          grant_id: legacyGrant.grant_id,
          token_type: "Bearer",
        })
      );

      // The migration runs; it does not touch agent_connect_attempts.
      await bootstrapPostgresSchema();

      const store = createAgentConnectAttemptStore();

      // The grant copy, materialized for the first time after migration.
      const fresh = await store.redeem("att_pg_mig_fresh", pollingCode);
      assert.ok(fresh.outcome === "approved");
      const freshGrant = fresh.body.grant as Record<string, unknown>;
      assert.equal("expires_at" in freshGrant, false, "the attempt grant copy must normalize to absent");

      // The response copy, materialized BEFORE migration.
      const replay = await store.redeem("att_pg_mig_replay", pollingCode);
      assert.ok(replay.outcome === "approved");
      assert.equal(replay.replay, true);
      const replayGrant = replay.body.grant as Record<string, unknown>;
      assert.equal("expires_at" in replayGrant, false, "the nested response grant copy must normalize to absent");

      // Both durable copies now hold the terminal representation.
      const rows = await postgresQuery<{ grant_json: unknown; id: string; response_json: string | null }>(
        "SELECT id, grant_json, response_json FROM agent_connect_attempts WHERE id = ANY($1)",
        [attemptIds]
      );
      for (const row of rows.rows) {
        assert.equal(
          (row.response_json ?? "").includes("expires_at"),
          false,
          `${row.id}: stored response must not carry the legacy null`
        );
      }
    } finally {
      await cleanup();
    }
  })
);
