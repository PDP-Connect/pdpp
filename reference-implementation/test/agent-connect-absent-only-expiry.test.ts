// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `agent_connect_attempts` is the second durable home of a resolved grant, and
 * it is an exception to the absent-only `expires_at` representation unless it
 * is closed explicitly.
 *
 * The table persists a grant TWICE:
 *
 *   grant_json           the resolved grant copied at approval time
 *   response_json        the whole materialized token response, whose `.grant`
 *                        member is a second, independent copy
 *
 * Redemption returns the persisted `response_json` verbatim when one exists and
 * otherwise builds a response from the persisted grant and stores it for
 * replay. So an attempt approved BEFORE the absent-only migration can still
 * hand a client `"expires_at": null` afterwards, through either path.
 *
 * The startup migration in `db.ts` / `postgres-storage.ts` rewrites
 * `grants.grant_json` only. It cannot close this seam on its own, for two
 * reasons that are properties of the code rather than of the deployment:
 *
 *   1. A one-shot migration cannot cover a row written AFTER it runs. During a
 *      rolling upgrade an older node still writes explicit nulls, and
 *      `markAttemptApproved` copies whatever the recovered consent held.
 *   2. `grantFromRecoveredConsent` falls back to `grant_packages.package_json`,
 *      which NO migration in this change rewrites. That source can therefore
 *      still supply a null-bearing grant on a fully-migrated deployment.
 *
 * So the repair is normalize-on-READ at the row-parse choke point, plus an
 * atomic rewrite of an already-materialized `response_json`. These tests pin
 * that behaviour on BOTH backends, across FIRST redemption and REPLAY of a
 * response that was materialized before the upgrade.
 *
 * The PostgreSQL half is gated on `PDPP_TEST_POSTGRES_URL`; when it is unset
 * the file still proves the SQLite half rather than skipping wholesale.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
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

const POLLING_CODE = "polling-code-under-test";
const POLLING_CODE_HASH = createHash("sha256").update(POLLING_CODE, "utf8").digest("base64url");
const REQUEST_URI = "urn:ietf:params:oauth:request_uri:agent-connect-absent-only";
const TOKEN = "tok_agent_connect_absent_only";

/** The pre-upgrade grant shape: a no-expiry grant carrying an explicit null. */
function legacyGrant(grantId: string): Record<string, unknown> {
  return {
    access_mode: "continuous",
    client: { client_id: "research-app" },
    expires_at: null,
    grant_id: grantId,
    issued_at: "2026-08-11T12:00:00Z",
    purpose_code: "https://pdpp.dev/purpose/research",
  };
}

/** A grant carrying a REAL expiry, which normalization must never disturb. */
function expiringGrant(grantId: string): Record<string, unknown> {
  return { ...legacyGrant(grantId), expires_at: "2027-04-06T00:00:00Z" };
}

function assertExpiryAbsent(body: Record<string, unknown>, label: string): void {
  const grant = body.grant as Record<string, unknown> | undefined;
  assert.ok(grant, `${label}: response must carry a grant`);
  assert.equal("expires_at" in grant, false, `${label}: the legacy explicit null must be dropped, not preserved`);
  assert.equal(grant.expires_at, undefined, `${label}: expiry must read as absent`);
  // Absence must survive serialization -- this is the wire representation the
  // client actually receives.
  assert.equal(JSON.stringify(grant).includes("expires_at"), false, `${label}: no expires_at may reach the wire`);
  // Normalization must not damage the rest of the grant.
  assert.equal(grant.access_mode, "continuous", `${label}: the rest of the grant must survive`);
}

// --- SQLite ---------------------------------------------------------------

/** Run `body` against a fresh on-disk SQLite database. */
function withSqlite(body: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-agent-connect-expiry-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await body();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedSqliteAttempt(id: string, grant: Record<string, unknown>, responseJson: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO agent_connect_attempts(
         id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
         interval_seconds, created_at, expires_at_ms, completed_at, grant_id, grant_json, token, response_json
       ) VALUES(?, ?, ?, ?, 'approved', ?, ?, 2, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      `${REQUEST_URI}:${id}`,
      "research-app",
      POLLING_CODE_HASH,
      "https://as.example/approve",
      "https://as.example/token",
      "2026-08-11T12:00:00Z",
      Date.now() + 600_000,
      "2026-08-11T12:00:05Z",
      grant.grant_id as string,
      JSON.stringify(grant),
      TOKEN,
      responseJson
    );
  // The attempt store gates redemption on a live, unrevoked token.
  getDb()
    .prepare(
      `INSERT INTO tokens(token_id, subject_id, client_id, token_kind, expires_at, revoked, created_at)
       VALUES(?, 'owner-1', 'research-app', 'access', NULL, 0, '2026-08-11T12:00:00Z')`
    )
    .run(TOKEN);
}

test(
  "SQLite: FIRST redemption of a pre-upgrade approved attempt returns an absent expiry",
  withSqlite(async () => {
    // No response_json yet: redemption builds the body from the persisted
    // legacy grant. This is the path a naive `grants`-only migration misses.
    seedSqliteAttempt("att_first", legacyGrant("grt_legacy_first"), null);

    const store = createAgentConnectAttemptStore();
    const result = await store.redeem("att_first", POLLING_CODE);

    assert.equal(result.outcome, "approved");
    assert.ok(result.outcome === "approved");
    assert.equal(result.replay, false, "a first redemption must not report replay");
    assertExpiryAbsent(result.body, "sqlite first redemption");
  })
);

test(
  "SQLite: REPLAY of an already-materialized response_json returns an absent expiry",
  withSqlite(async () => {
    // The case a fix that only touches the grant-parse path misses entirely:
    // the response was materialized BEFORE the upgrade, so redemption returns
    // the stored string verbatim without ever consulting `attempt.grant`.
    const grant = legacyGrant("grt_legacy_replay");
    const staleResponse = JSON.stringify({
      access_token: TOKEN,
      grant,
      grant_id: grant.grant_id,
      token_type: "Bearer",
    });
    assert.ok(staleResponse.includes('"expires_at":null'), "fixture must actually carry the legacy null");
    seedSqliteAttempt("att_replay", grant, staleResponse);

    const store = createAgentConnectAttemptStore();
    const result = await store.redeem("att_replay", POLLING_CODE);

    assert.equal(result.outcome, "approved");
    assert.ok(result.outcome === "approved");
    assert.equal(result.replay, true, "a materialized response must still report replay");
    assertExpiryAbsent(result.body, "sqlite replay");
  })
);

test(
  "SQLite: replay still returns the normalized body when the healing write fails",
  withSqlite(async () => {
    // The healing rewrite is documented as best-effort: the returned body is
    // already correct before any write is attempted, so a failure writing it
    // back must never turn a valid, already-normalized redemption into an
    // error. Force the write to fail with a trigger that rejects exactly the
    // healing UPDATE, and assert the redemption still succeeds.
    const grant = legacyGrant("grt_legacy_write_fails");
    const staleResponse = JSON.stringify({
      access_token: TOKEN,
      grant,
      grant_id: grant.grant_id,
      token_type: "Bearer",
    });
    seedSqliteAttempt("att_write_fails", grant, staleResponse);
    getDb().exec(`
      CREATE TRIGGER heal_write_fails
      BEFORE UPDATE OF response_json ON agent_connect_attempts
      WHEN NEW.id = 'att_write_fails'
      BEGIN
        SELECT RAISE(ABORT, 'simulated healing write failure');
      END;
    `);

    const store = createAgentConnectAttemptStore();
    const result = await store.redeem("att_write_fails", POLLING_CODE);

    assert.equal(result.outcome, "approved", "a failed healing write must not fail the redemption");
    assert.ok(result.outcome === "approved");
    assert.equal(result.replay, true);
    assertExpiryAbsent(result.body, "sqlite replay despite failed healing write");

    // The row itself was never healed, since the write failed -- confirms
    // this test actually exercised the failure path rather than a no-op.
    const row = getDb()
      .prepare("SELECT response_json FROM agent_connect_attempts WHERE id = ?")
      .get("att_write_fails") as { response_json: string };
    assert.equal(row.response_json, staleResponse, "the stored row must be untouched by a failed write");
  })
);

test(
  "SQLite: the stored response_json is rewritten so the null cannot resurface",
  withSqlite(async () => {
    const grant = legacyGrant("grt_legacy_rewrite");
    seedSqliteAttempt(
      "att_rewrite",
      grant,
      JSON.stringify({ access_token: TOKEN, grant, grant_id: grant.grant_id, token_type: "Bearer" })
    );

    const store = createAgentConnectAttemptStore();
    await store.redeem("att_rewrite", POLLING_CODE);

    // The durable row itself must no longer hold the legacy representation,
    // otherwise every later replay would have to re-normalize to stay correct.
    const row = getDb()
      .prepare("SELECT response_json, grant_json FROM agent_connect_attempts WHERE id = ?")
      .get("att_rewrite") as { grant_json: string; response_json: string };
    assert.equal(row.response_json.includes("expires_at"), false, "stored response must be rewritten in place");
    assert.equal(
      JSON.parse(row.response_json).grant.access_mode,
      "continuous",
      "the rewrite must preserve the rest of the response"
    );

    // A second redemption must agree with the first.
    const again = await store.redeem("att_rewrite", POLLING_CODE);
    assert.ok(again.outcome === "approved");
    assertExpiryAbsent(again.body, "sqlite second replay");
  })
);

test(
  "SQLite: a REAL expiry survives redemption untouched",
  withSqlite(async () => {
    // The other direction: normalization must be scoped to the null case, or
    // it would silently widen every bounded grant into an unbounded one.
    seedSqliteAttempt("att_expiring", expiringGrant("grt_expiring"), null);

    const store = createAgentConnectAttemptStore();
    const result = await store.redeem("att_expiring", POLLING_CODE);

    assert.ok(result.outcome === "approved");
    const grant = result.body.grant as Record<string, unknown>;
    assert.equal(grant.expires_at, "2027-04-06T00:00:00Z", "a real expiry must never be dropped");
  })
);

/**
 * Seed a PENDING attempt whose grant can only be recovered from
 * `grant_packages.package_json`.
 *
 * This is the package-shaped path: `getRecoveredApprovedConsent` LEFT JOINs
 * both `grants` and `grant_packages`, and `grantFromRecoveredConsent` prefers
 * `grant_json` and falls back to `package_json`. Deliberately inserting NO
 * `grants` row is what forces the fallback, so the attempt is approved from a
 * package rather than from a bare grant.
 *
 * The attempt starts PENDING with no grant of its own, because the package is
 * only ever consulted through `recoverApprovedAttempt`.
 */
function seedSqlitePackageShapedAttempt(id: string, packageGrant: Record<string, unknown>): void {
  const deviceCode = `device-${id}`;
  const packageId = packageGrant.grant_id as string;
  getDb()
    .prepare(
      `INSERT INTO agent_connect_attempts(
         id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
         interval_seconds, created_at, expires_at_ms
       ) VALUES(?, ?, ?, ?, 'pending', ?, ?, 2, ?, ?)`
    )
    .run(
      id,
      `urn:pdpp:pending-consent:${deviceCode}`,
      "research-app",
      POLLING_CODE_HASH,
      "https://as.example/approve",
      "https://as.example/token",
      "2026-08-11T12:00:00Z",
      Date.now() + 600_000
    );
  getDb()
    .prepare(
      `INSERT INTO pending_consents(
         device_code, user_code, params_json, status, subject_id, grant_id, token_id, created_at, expires_at, approved_at
       ) VALUES(?, ?, '{}', 'approved', 'owner-1', ?, ?, '2026-08-11T12:00:00Z', '2036-08-11T12:00:00Z', '2026-08-11T12:00:05Z')`
    )
    .run(deviceCode, `user-${id}`, packageId, TOKEN);
  // NO `grants` row on purpose: that absence is what routes recovery through
  // `package_json`.
  getDb()
    .prepare(
      `INSERT INTO grant_packages(package_id, subject_id, client_id, status, package_json, created_at, approved_at)
       VALUES(?, 'owner-1', 'research-app', 'active', ?, '2026-08-11T12:00:00Z', '2026-08-11T12:00:05Z')`
    )
    .run(packageId, JSON.stringify(packageGrant));
  getDb()
    .prepare(
      `INSERT INTO tokens(token_id, subject_id, client_id, token_kind, expires_at, revoked, created_at)
       VALUES(?, 'owner-1', 'research-app', 'access', NULL, 0, '2026-08-11T12:00:00Z')`
    )
    .run(TOKEN);
}

test(
  "SQLite: a package-shaped response is NOT altered when it already has no expiry member",
  withSqlite(async () => {
    // The review asked for this case explicitly: a response built from
    // `grant_packages.package_json` rather than from a bare grant must pass
    // through normalization UNCHANGED. Production holds 99 `grant_packages`
    // rows, so this is the shape most likely to be perturbed by an
    // over-broad rewrite.
    const packageGrant = {
      access_mode: "continuous",
      client: { client_id: "research-app" },
      grant_id: "pkg_absent",
      issued_at: "2026-08-11T12:00:00Z",
      purpose_code: "https://pdpp.dev/purpose/research",
    };
    seedSqlitePackageShapedAttempt("att_pkg_absent", packageGrant);

    const store = createAgentConnectAttemptStore();
    const result = await store.redeem("att_pkg_absent", POLLING_CODE);

    assert.ok(result.outcome === "approved", "the package-shaped attempt must redeem");
    // Byte-for-byte identity is the real assertion: normalization must be a
    // no-op here, not merely produce something that happens to validate.
    assert.deepEqual(
      result.body.grant,
      packageGrant,
      "an already-absent package-shaped grant must be returned exactly as stored"
    );
    assertExpiryAbsent(result.body, "sqlite package-shaped, already absent");
  })
);

test(
  "SQLite: a package-shaped response carrying a REAL expiry is NOT altered",
  withSqlite(async () => {
    // The other half of "unchanged": normalization must not touch a bounded
    // package grant either. Only the explicit-null case may ever be rewritten.
    const packageGrant = {
      access_mode: "continuous",
      client: { client_id: "research-app" },
      expires_at: "2027-04-06T00:00:00Z",
      grant_id: "pkg_expiring",
      issued_at: "2026-08-11T12:00:00Z",
      purpose_code: "https://pdpp.dev/purpose/research",
    };
    seedSqlitePackageShapedAttempt("att_pkg_expiring", packageGrant);

    const store = createAgentConnectAttemptStore();
    const result = await store.redeem("att_pkg_expiring", POLLING_CODE);

    assert.ok(result.outcome === "approved");
    assert.deepEqual(result.body.grant, packageGrant, "a bounded package-shaped grant must survive byte-for-byte");
  })
);

test(
  "SQLite: a package-shaped grant carrying the legacy null IS normalized",
  withSqlite(async () => {
    // `grant_packages.package_json` is NOT rewritten by either startup
    // migration, so this source can still supply a null on a fully-migrated
    // deployment. It is the reason the repair had to be normalize-on-read.
    // Pins that the previous two tests assert "unchanged" because the input
    // was already correct, not because this path skips normalization.
    seedSqlitePackageShapedAttempt("att_pkg_legacy", legacyGrant("pkg_legacy"));

    const store = createAgentConnectAttemptStore();
    const result = await store.redeem("att_pkg_legacy", POLLING_CODE);

    assert.ok(result.outcome === "approved");
    assertExpiryAbsent(result.body, "sqlite package-shaped, legacy null");
  })
);

// --- PostgreSQL -----------------------------------------------------------

/** Run `body` against the dedicated PostgreSQL test database. */
function withPostgres(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    assert.ok(POSTGRES_URL);
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await bootstrapPostgresSchema();
      await postgresQuery("DELETE FROM agent_connect_attempts");
      await body();
    } finally {
      await postgresQuery("DELETE FROM agent_connect_attempts").catch(() => undefined);
      await closePostgresStorage();
    }
  };
}

async function seedPostgresAttempt(
  id: string,
  grant: Record<string, unknown>,
  responseJson: string | null
): Promise<void> {
  await postgresQuery(
    `INSERT INTO agent_connect_attempts(
       id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
       interval_seconds, created_at, expires_at_ms, completed_at, grant_id, grant_json, token, response_json
     ) VALUES($1, $2, $3, $4, 'approved', $5, $6, 2, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
    [
      id,
      `${REQUEST_URI}:${id}`,
      "research-app",
      POLLING_CODE_HASH,
      "https://as.example/approve",
      "https://as.example/token",
      "2026-08-11T12:00:00Z",
      Date.now() + 600_000,
      "2026-08-11T12:00:05Z",
      grant.grant_id as string,
      JSON.stringify(grant),
      TOKEN,
      responseJson,
    ]
  );
  await postgresQuery(
    `INSERT INTO tokens(token_id, subject_id, client_id, token_kind, expires_at, revoked, created_at)
     VALUES($1, 'owner-1', 'research-app', 'access', NULL, FALSE, '2026-08-11T12:00:00Z')
     ON CONFLICT (token_id) DO NOTHING`,
    [TOKEN]
  );
}

test(
  "PostgreSQL: FIRST redemption of a pre-upgrade approved attempt returns an absent expiry",
  { skip: POSTGRES_SKIP },
  withPostgres(async () => {
    await seedPostgresAttempt("att_pg_first", legacyGrant("grt_pg_first"), null);

    const store = createAgentConnectAttemptStore();
    const result = await store.redeem("att_pg_first", POLLING_CODE);

    assert.ok(result.outcome === "approved");
    assert.equal(result.replay, false);
    assertExpiryAbsent(result.body, "postgres first redemption");
  })
);

test(
  "PostgreSQL: REPLAY of an already-materialized response_json returns an absent expiry",
  { skip: POSTGRES_SKIP },
  withPostgres(async () => {
    const grant = legacyGrant("grt_pg_replay");
    const staleResponse = JSON.stringify({
      access_token: TOKEN,
      grant,
      grant_id: grant.grant_id,
      token_type: "Bearer",
    });
    await seedPostgresAttempt("att_pg_replay", grant, staleResponse);

    const store = createAgentConnectAttemptStore();
    const result = await store.redeem("att_pg_replay", POLLING_CODE);

    assert.ok(result.outcome === "approved");
    assert.equal(result.replay, true);
    assertExpiryAbsent(result.body, "postgres replay");

    // And the durable row is rewritten, so the null cannot resurface later.
    const row = await postgresQuery<{ response_json: string | null }>(
      "SELECT response_json FROM agent_connect_attempts WHERE id = $1",
      ["att_pg_replay"]
    );
    assert.equal(
      (row.rows[0]?.response_json ?? "").includes("expires_at"),
      false,
      "stored response must be rewritten in place"
    );
  })
);

test(
  "PostgreSQL: replay still returns the normalized body when the healing write fails",
  { skip: POSTGRES_SKIP },
  withPostgres(async () => {
    // Same best-effort contract as the SQLite case, forced via a trigger
    // that rejects exactly the healing UPDATE on this one row.
    const grant = legacyGrant("grt_pg_write_fails");
    const staleResponse = JSON.stringify({
      access_token: TOKEN,
      grant,
      grant_id: grant.grant_id,
      token_type: "Bearer",
    });
    await seedPostgresAttempt("att_pg_write_fails", grant, staleResponse);
    await postgresQuery(`
      CREATE OR REPLACE FUNCTION pg_temp_reject_healing_write() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = 'att_pg_write_fails' THEN
          RAISE EXCEPTION 'simulated healing write failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await postgresQuery(`
      CREATE TRIGGER reject_healing_write
      BEFORE UPDATE OF response_json ON agent_connect_attempts
      FOR EACH ROW EXECUTE FUNCTION pg_temp_reject_healing_write();
    `);
    try {
      const store = createAgentConnectAttemptStore();
      const result = await store.redeem("att_pg_write_fails", POLLING_CODE);

      assert.equal(result.outcome, "approved", "a failed healing write must not fail the redemption");
      assert.ok(result.outcome === "approved");
      assert.equal(result.replay, true);
      assertExpiryAbsent(result.body, "postgres replay despite failed healing write");

      const row = await postgresQuery<{ response_json: string }>(
        "SELECT response_json FROM agent_connect_attempts WHERE id = $1",
        ["att_pg_write_fails"]
      );
      assert.equal(row.rows[0]?.response_json, staleResponse, "the stored row must be untouched by a failed write");
    } finally {
      await postgresQuery("DROP TRIGGER IF EXISTS reject_healing_write ON agent_connect_attempts");
      await postgresQuery("DROP FUNCTION IF EXISTS pg_temp_reject_healing_write()");
    }
  })
);

test(
  "PostgreSQL: a REAL expiry survives redemption untouched",
  { skip: POSTGRES_SKIP },
  withPostgres(async () => {
    await seedPostgresAttempt("att_pg_expiring", expiringGrant("grt_pg_expiring"), null);

    const store = createAgentConnectAttemptStore();
    const result = await store.redeem("att_pg_expiring", POLLING_CODE);

    assert.ok(result.outcome === "approved");
    const grant = result.body.grant as Record<string, unknown>;
    assert.equal(grant.expires_at, "2027-04-06T00:00:00Z");
  })
);
