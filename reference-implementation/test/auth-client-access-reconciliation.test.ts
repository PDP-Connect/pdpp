// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { emitSpineEvent } from "../lib/spine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createAuthClientAccessMaintenanceReconciler,
  reconcileClientAccessArtifacts,
} from "../server/stores/auth-client-access-reconciliation-store.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const INVALID_MAX_CLIENTS_ERROR = /maxClients must be a positive integer/;

interface SqliteStatement {
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

interface SqliteHandle {
  prepare: (sql: string) => SqliteStatement;
}

const typedGetDb = getDb as unknown as () => SqliteHandle;

interface AuthorityStatusRow {
  grant_status: string;
  member_revoked_at: string | null;
  member_status: string;
  package_revoked_at: string | null;
  package_status: string;
  refresh_revoked_at: string | null;
  refresh_status: string;
  token_revoked: number | boolean;
}

function idsFor(clientId: string) {
  return {
    grantId: `${clientId}_grant`,
    grantRefreshHash: `${clientId}_grant_refresh`,
    grantTokenId: `${clientId}_grant_token`,
    packageId: `${clientId}_package`,
    packageRefreshHash: `${clientId}_package_refresh`,
    packageTokenId: `${clientId}_package_token`,
  };
}

function seedSqliteClient(clientId: string): void {
  const now = "2026-08-03T00:00:00.000Z";
  const ids = idsFor(clientId);
  const db = typedGetDb();

  db.prepare(`
    INSERT INTO grants(
      grant_id, subject_id, client_id, storage_binding_json, grant_json,
      access_mode, status, consumed, issued_at, expires_at
    ) VALUES (?, ?, ?, NULL, ?, 'mcp', 'active', FALSE, ?, NULL)
  `).run(ids.grantId, "reconcile_subject", clientId, JSON.stringify({ grant_id: ids.grantId }), now);

  db.prepare(`
    INSERT INTO grant_packages(
      package_id, subject_id, client_id, status, package_json,
      trace_id, scenario_id, created_at, approved_at, revoked_at
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL)
  `).run(
    ids.packageId,
    "reconcile_subject",
    clientId,
    JSON.stringify({ package_id: ids.packageId }),
    `${clientId}_trace`,
    `${clientId}_scenario`,
    now,
    now
  );

  db.prepare(`
    INSERT INTO tokens(token_id, grant_id, package_id, subject_id, client_id, token_kind, expires_at, revoked)
    VALUES (?, ?, NULL, ?, ?, 'mcp', NULL, FALSE),
           (?, ?, ?, ?, ?, 'mcp_package', NULL, FALSE)
  `).run(
    ids.grantTokenId,
    ids.grantId,
    "reconcile_subject",
    clientId,
    ids.packageTokenId,
    ids.grantId,
    ids.packageId,
    "reconcile_subject",
    clientId
  );

  db.prepare(`
    INSERT INTO oauth_refresh_tokens(
      refresh_token_hash, client_id, grant_id, package_id, subject_id, status,
      created_at, expires_at, last_used_at, revoked_at
    ) VALUES (?, ?, ?, NULL, ?, 'active', ?, NULL, NULL, NULL),
             (?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL)
  `).run(
    ids.grantRefreshHash,
    clientId,
    ids.grantId,
    "reconcile_subject",
    now,
    ids.packageRefreshHash,
    clientId,
    ids.grantId,
    ids.packageId,
    "reconcile_subject",
    now
  );

  db.prepare(`
    INSERT INTO grant_package_members(
      package_id, grant_id, token_id, source_json, status, added_at, revoked_at
    ) VALUES (?, ?, ?, ?, 'active', ?, NULL)
  `).run(ids.packageId, ids.grantId, ids.packageTokenId, JSON.stringify({ source: "test" }), now);
}

async function seedPostgresClient(clientId: string): Promise<void> {
  const now = "2026-08-03T00:00:00.000Z";
  const ids = idsFor(clientId);
  await postgresQuery(
    `INSERT INTO grants(
       grant_id, subject_id, client_id, storage_binding_json, grant_json,
       access_mode, status, consumed, issued_at, expires_at
     ) VALUES ($1, $2, $3, NULL, $4::jsonb, 'mcp', 'active', FALSE, $5, NULL)`,
    [ids.grantId, "reconcile_subject", clientId, JSON.stringify({ grant_id: ids.grantId }), now]
  );
  await postgresQuery(
    `INSERT INTO grant_packages(
       package_id, subject_id, client_id, status, package_json,
       trace_id, scenario_id, created_at, approved_at, revoked_at
     ) VALUES ($1, $2, $3, 'active', $4::jsonb, $5, $6, $7, $7, NULL)`,
    [
      ids.packageId,
      "reconcile_subject",
      clientId,
      JSON.stringify({ package_id: ids.packageId }),
      `${clientId}_trace`,
      `${clientId}_scenario`,
      now,
    ]
  );
  await postgresQuery(
    `INSERT INTO tokens(token_id, grant_id, package_id, subject_id, client_id, token_kind, expires_at, revoked)
     VALUES ($1, $2, NULL, $3, $4, 'mcp', NULL, FALSE),
            ($5, $2, $6, $3, $4, 'mcp_package', NULL, FALSE)`,
    [ids.grantTokenId, ids.grantId, "reconcile_subject", clientId, ids.packageTokenId, ids.packageId]
  );
  await postgresQuery(
    `INSERT INTO oauth_refresh_tokens(
       refresh_token_hash, client_id, grant_id, package_id, subject_id, status,
       created_at, expires_at, last_used_at, revoked_at
     ) VALUES ($1, $2, $3, NULL, $4, 'active', $5, NULL, NULL, NULL),
              ($6, $2, $3, $7, $4, 'active', $5, NULL, NULL, NULL)`,
    [ids.grantRefreshHash, clientId, ids.grantId, "reconcile_subject", now, ids.packageRefreshHash, ids.packageId]
  );
  await postgresQuery(
    `INSERT INTO grant_package_members(
       package_id, grant_id, token_id, source_json, status, added_at, revoked_at
     ) VALUES ($1, $2, $3, $4::jsonb, 'active', $5, NULL)`,
    [ids.packageId, ids.grantId, ids.packageTokenId, JSON.stringify({ source: "test" }), now]
  );
}

async function emitDeletedEvidence(clientId: string, objectId = clientId): Promise<void> {
  await emitSpineEvent({
    actor_id: "reconciliation-test",
    actor_type: "system",
    client_id: clientId,
    data: { test: true },
    event_type: "client.deleted",
    object_id: objectId,
    object_type: "client",
    scenario_id: `${clientId}_scenario`,
    status: "succeeded",
    trace_id: `${clientId}_trace`,
  });
}

function readSqliteAuthorityStatus(clientId: string): AuthorityStatusRow {
  const ids = idsFor(clientId);
  return typedGetDb()
    .prepare(`
      SELECT
        g.status AS grant_status,
        gm.status AS member_status,
        gp.status AS package_status,
        gp.revoked_at AS package_revoked_at,
        gm.revoked_at AS member_revoked_at,
        t.revoked AS token_revoked,
        rt.status AS refresh_status,
        rt.revoked_at AS refresh_revoked_at
      FROM grants g
      JOIN grant_packages gp ON gp.package_id = ?
      JOIN grant_package_members gm ON gm.package_id = gp.package_id AND gm.grant_id = g.grant_id
      JOIN tokens t ON t.token_id = ?
      JOIN oauth_refresh_tokens rt ON rt.refresh_token_hash = ?
      WHERE g.grant_id = ?
    `)
    .get(ids.packageId, ids.packageTokenId, ids.packageRefreshHash, ids.grantId) as AuthorityStatusRow;
}

async function readPostgresAuthorityStatus(clientId: string): Promise<AuthorityStatusRow> {
  const ids = idsFor(clientId);
  const result = await postgresQuery<AuthorityStatusRow>(
    `SELECT
       g.status AS grant_status,
       gm.status AS member_status,
       gp.status AS package_status,
       gp.revoked_at AS package_revoked_at,
       gm.revoked_at AS member_revoked_at,
       t.revoked AS token_revoked,
       rt.status AS refresh_status,
       rt.revoked_at AS refresh_revoked_at
     FROM grants g
     JOIN grant_packages gp ON gp.package_id = $1
     JOIN grant_package_members gm ON gm.package_id = gp.package_id AND gm.grant_id = g.grant_id
     JOIN tokens t ON t.token_id = $2
     JOIN oauth_refresh_tokens rt ON rt.refresh_token_hash = $3
     WHERE g.grant_id = $4`,
    [ids.packageId, ids.packageTokenId, ids.packageRefreshHash, ids.grantId]
  );
  const [row] = result.rows;
  assert.ok(row);
  return row;
}

async function runSqliteAssertions(): Promise<void> {
  initDb(":memory:");
  try {
    const clientId = "client_deleted_direct";
    seedSqliteClient(clientId);
    const first = await reconcileClientAccessArtifacts(clientId, "2026-08-03T01:00:00.000Z");
    assert.deepEqual(first, {
      clientId,
      grantsRevoked: 1,
      packageMembersRevoked: 1,
      packagesRevoked: 1,
      refreshTokensRevoked: 2,
      tokensRevoked: 2,
    });
    const beforeSecondPass = readSqliteAuthorityStatus(clientId);
    assert.equal(beforeSecondPass.member_revoked_at, "2026-08-03T01:00:00.000Z");

    const second = await reconcileClientAccessArtifacts(clientId, "2026-08-03T02:00:00.000Z");
    assert.deepEqual(second, {
      clientId,
      grantsRevoked: 0,
      packageMembersRevoked: 0,
      packagesRevoked: 0,
      refreshTokensRevoked: 0,
      tokensRevoked: 0,
    });
    const afterSecondPass = readSqliteAuthorityStatus(clientId);
    assert.equal(afterSecondPass.member_revoked_at, beforeSecondPass.member_revoked_at);
    assert.equal(afterSecondPass.package_revoked_at, beforeSecondPass.package_revoked_at);
    assert.equal(afterSecondPass.refresh_status, "revoked");
    assert.equal(afterSecondPass.token_revoked, 1);
  } finally {
    closeDb();
  }
}

test("SQLite client-access reconciliation is status-only and idempotent", runSqliteAssertions);

test("invalid maintenance bounds do not poison the reconciler single-flight guard", async () => {
  initDb(":memory:");
  try {
    const reconciler = createAuthClientAccessMaintenanceReconciler();
    await assert.rejects(reconciler.runRound({ maxClients: 0 }), INVALID_MAX_CLIENTS_ERROR);
    const round = await reconciler.runRound({ maxClients: 1, maxDurationMs: 10_000 });
    assert.ok(round);
    assert.deepEqual(round.processedClientIds, []);
    assert.equal(round.incomplete, false);
  } finally {
    closeDb();
  }
});

test("SQLite maintenance uses exact deletion evidence and a one-client cursor budget", async () => {
  initDb(":memory:");
  try {
    const firstClient = "client_deleted_a";
    const secondClient = "client_deleted_b";
    const mismatchedClient = "client_mismatched_evidence";
    const ignoredClient = "client_without_evidence";
    for (const clientId of [firstClient, secondClient, mismatchedClient, ignoredClient]) {
      seedSqliteClient(clientId);
    }
    await emitDeletedEvidence(firstClient);
    await emitDeletedEvidence(secondClient);
    await emitDeletedEvidence(mismatchedClient, "different_client_object");

    const reconciler = createAuthClientAccessMaintenanceReconciler();
    const firstRound = await reconciler.runRound({
      maxClients: 1,
      maxDurationMs: 10_000,
      nowIso: () => "2026-08-03T03:00:00.000Z",
    });
    assert.ok(firstRound);
    assert.deepEqual(firstRound.processedClientIds, [firstClient]);
    assert.equal(firstRound.incomplete, true);
    assert.equal(readSqliteAuthorityStatus(ignoredClient).grant_status, "active");

    const secondRound = await reconciler.runRound({
      maxClients: 1,
      maxDurationMs: 10_000,
      nowIso: () => "2026-08-03T04:00:00.000Z",
    });
    assert.ok(secondRound);
    assert.deepEqual(secondRound.processedClientIds, [secondClient]);
    assert.equal(secondRound.incomplete, false);
    assert.equal(readSqliteAuthorityStatus(firstClient).member_status, "revoked");
    assert.equal(readSqliteAuthorityStatus(secondClient).member_status, "revoked");
    assert.equal(readSqliteAuthorityStatus(mismatchedClient).member_status, "active");
    assert.equal(readSqliteAuthorityStatus(ignoredClient).member_status, "active");
  } finally {
    closeDb();
  }
});

test("Postgres client-access reconciliation and cursor path matches SQLite", { skip: !POSTGRES_URL }, async () => {
  const postgresUrl = POSTGRES_URL;
  assert.ok(postgresUrl);
  initDb(":memory:");
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
  try {
    const clientId = "client_deleted_postgres";
    await seedPostgresClient(clientId);
    const first = await reconcileClientAccessArtifacts(clientId, "2026-08-03T01:00:00.000Z");
    assert.equal(first.grantsRevoked, 1);
    assert.equal(first.packageMembersRevoked, 1);
    assert.equal(first.packagesRevoked, 1);
    assert.equal(first.refreshTokensRevoked, 2);
    assert.equal(first.tokensRevoked, 2);
    const status = await readPostgresAuthorityStatus(clientId);
    assert.equal(status.grant_status, "revoked");
    assert.equal(status.package_status, "revoked");
    assert.equal(status.member_status, "revoked");
    assert.equal(status.refresh_status, "revoked");
    assert.equal(status.token_revoked, true);

    const evidenceClient = "client_deleted_postgres_cursor";
    const ignoredClient = "client_without_postgres_evidence";
    await seedPostgresClient(evidenceClient);
    await seedPostgresClient(ignoredClient);
    await emitDeletedEvidence(evidenceClient);
    const reconciler = createAuthClientAccessMaintenanceReconciler();
    const round = await reconciler.runRound({ maxClients: 1, maxDurationMs: 10_000 });
    assert.ok(round);
    assert.deepEqual(round.processedClientIds, [evidenceClient]);
    assert.equal((await readPostgresAuthorityStatus(evidenceClient)).member_status, "revoked");
    assert.equal((await readPostgresAuthorityStatus(ignoredClient)).member_status, "active");
  } finally {
    await closePostgresStorage();
    closeDb();
  }
});
