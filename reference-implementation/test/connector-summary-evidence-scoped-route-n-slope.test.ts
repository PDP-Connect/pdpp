// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scoped ROUTE-level N-slope: the real mounted-route call chain, including
 * fold + synthesis, not just discovery
 * (Sol P1.2 minimum-closure item 2: "Measure the real mounted route at
 * N=1/N=25 (including fold and synthesis), on SQLite and Postgres").
 *
 * `connector-summary-evidence-engine-scoped-consumer.test.js` already proves
 * the ENGINE's `reconcileConnectorSummaryEvidence([oneId])` discovery/repair
 * phase does not scale with N. This file proves the property Sol's verdict
 * specifically found unproven: `getConnectorSummaryForRoute` — the actual
 * function the mounted `/_ref/connectors?connection=...` and (via
 * `resolveUnambiguousConnectionForConnectorId`) `/_ref/connectors/:id`
 * routes call — does not scale with N through its COMPLETE call chain:
 * `loadConnectorSummaryProjectionDeps`'s reconcile barrier, THEN
 * `foldStreamFactsBestEffort` (now scoped — see connector-summary-read-model.ts),
 * THEN the post-repair `readSummaryEvidenceRowsOrFailure` durable read (now
 * scoped), THEN `projectConnectorSummaryForInstance` synthesis itself.
 *
 * Query-counting methodology matches the scoped-consumer file: patches
 * `Database.prototype.prepare` directly (the raw better-sqlite3 method the
 * `server/db.js` cached-prepare Proxy's `get` trap calls on a cache miss) —
 * NOT `db.prepare = fn` reassignment, which the proxy's `get` trap silently
 * never reads back.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import Database from "better-sqlite3";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { getConnectorSummaryForRoute } from "../server/ref-control.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const NOW = "2026-07-17T00:00:00.000Z";

const MANIFEST = {
  capabilities: { public_listing: { tier: "supported" } },
  connector_id: "route-n-slope-target",
  display_name: "Route N-Slope Target",
  protocol_version: "0.1.0",
  streams: [{ name: "messages", primary_key: ["id"] }],
  version: "1.0.0",
};

const UNRELATED_MANIFEST_BASE = {
  capabilities: { public_listing: { tier: "supported" } },
  display_name: "Route N-Slope Unrelated",
  protocol_version: "0.1.0",
  streams: [{ name: "messages", primary_key: ["id"] }],
  version: "1.0.0",
};

// ─── SQLite ─────────────────────────────────────────────────────────────

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-route-n-slope-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedSqliteTargetConnection() {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(MANIFEST.connector_id, JSON.stringify(MANIFEST), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES ('cin_route_target', 'owner_local', ?, 'Target', 'active', 'account', 'target', '{}', ?, ?, NULL)`
    )
    .run(MANIFEST.connector_id, NOW, NOW);
  getDb()
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, semantic_time, version, deleted)
       VALUES (?, 'cin_route_target', 'messages', 'r1', '{}', ?, ?, 1, 0)`
    )
    .run(MANIFEST.connector_id, NOW, NOW);
}

function seedSqliteUnrelatedConnections(n: number): void {
  const connectorId = "route-n-slope-unrelated";
  const manifest = { ...UNRELATED_MANIFEST_BASE, connector_id: connectorId };
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
  for (let i = 0; i < n; i += 1) {
    const id = `cin_route_unrelated_${i}`;
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES (?, 'owner_local', ?, 'x', 'active', 'account', ?, '{}', ?, ?, NULL)`
      )
      .run(id, connectorId, id, NOW, NOW);
  }
}

async function countRawPrepareCalls<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  let calls = 0;
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function patchedPrepare(this: InstanceType<typeof Database>, sql: string) {
    calls += 1;
    return original.call<InstanceType<typeof Database>, [string], ReturnType<typeof original>>(this, sql);
  } as typeof original;
  try {
    const result = await fn();
    return { calls, result };
  } finally {
    Database.prototype.prepare = original;
  }
}

test(
  "SQLite: getConnectorSummaryForRoute (discovery + fold + synthesis, the real mounted-route call chain) issues a query count independent of N unrelated connections",
  withTempDb(async () => {
    // N=1
    seedSqliteUnrelatedConnections(1);
    seedSqliteTargetConnection();
    await reconcileConnectorSummaryEvidence(null); // warm every row once
    const { result: summary1, calls: calls1 } = await countRawPrepareCalls(() =>
      getConnectorSummaryForRoute("cin_route_target")
    );
    assert.ok(summary1, "the route resolves a real synthesized summary, not null");
    assert.equal(summary1.total_records, 1, "synthesis genuinely ran — the real record count rode through");
    assert.ok(calls1 > 0, "sanity: interception observed real prepare calls");

    closeDb();
    const dir25 = mkdtempSync(join(tmpdir(), "pdpp-route-n-slope-25-"));
    initDb(join(dir25, "pdpp.sqlite"));
    // N=25 — same target connection, 25 unrelated siblings instead of 1.
    seedSqliteUnrelatedConnections(25);
    seedSqliteTargetConnection();
    await reconcileConnectorSummaryEvidence(null); // warm every row once
    const { result: summary25, calls: calls25 } = await countRawPrepareCalls(() =>
      getConnectorSummaryForRoute("cin_route_target")
    );
    rmSync(dir25, { force: true, recursive: true });

    assert.ok(summary25, "the route resolves a real synthesized summary at N=25 too");
    assert.equal(summary25.total_records, 1);
    // The property Sol's verdict specifically found unproven: total query
    // count through discovery + fold + post-repair read + synthesis must
    // not grow with N. A regression reintroducing an unscoped fold or an
    // unscoped post-repair evidence read would show as calls25 >> calls1
    // even though the engine's own discovery phase (already proven scoped)
    // stays fixed.
    assert.equal(
      calls25,
      calls1,
      `getConnectorSummaryForRoute against N=25 unrelated connections issued ${calls25} prepare calls vs N=1's ${calls1} — the full route call chain must not scale with N`
    );
  })
);

// ─── Postgres (gated) ───────────────────────────────────────────────────

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

async function seedPostgresTargetConnection() {
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [MANIFEST.connector_id]);
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    MANIFEST.connector_id,
    JSON.stringify(MANIFEST),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ('cin_route_target_pg', 'owner_local', $1, 'Target', 'active', 'account', 'target', '{}'::jsonb, $2, $2, NULL)`,
    [MANIFEST.connector_id, NOW]
  );
  await postgresQuery(
    `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
     VALUES ($1, 'cin_route_target_pg', 'messages', 'r1', '{}'::jsonb, $2, 1, false, 'r1')`,
    [MANIFEST.connector_id, NOW]
  );
}

async function seedPostgresUnrelatedConnections(n: number): Promise<void> {
  const connectorId = "route-n-slope-unrelated-pg";
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    connectorId,
    JSON.stringify({ ...UNRELATED_MANIFEST_BASE, connector_id: connectorId }),
    NOW,
  ]);
  for (let i = 0; i < n; i += 1) {
    const id = `cin_route_unrelated_pg_${i}`;
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES($1, 'owner_local', $2, 'x', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
      [id, connectorId, NOW]
    );
  }
}

async function cleanupPostgres() {
  for (const connectorId of [MANIFEST.connector_id, "route-n-slope-unrelated-pg"]) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_id = $1", [connectorId]);
    await postgresQuery("DELETE FROM records WHERE connector_id = $1", [connectorId]);
    await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", [connectorId]);
    await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
  }
}

function countPoolQueries<T>(fn: () => Promise<T>): Promise<{ calls: number; result: T }> {
  const pool = getPostgresPool();
  const original = pool.query.bind(pool);
  let calls = 0;
  pool.query = ((...args: Parameters<typeof original>) => {
    calls += 1;
    return original(...args);
  }) as typeof pool.query;
  return fn()
    .finally(() => {
      pool.query = original;
    })
    .then((result: T) => ({ calls, result }));
}

test("real PostgreSQL: getConnectorSummaryForRoute (discovery + fold + synthesis) query count for N=25 stays within a small constant factor of N=1", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  try {
    await cleanupPostgres();
    await seedPostgresUnrelatedConnections(1);
    await seedPostgresTargetConnection();
    await reconcileConnectorSummaryEvidence(null);
    const { result: summary1, calls: calls1 } = await countPoolQueries(() =>
      getConnectorSummaryForRoute("cin_route_target_pg")
    );
    assert.ok(summary1);
    assert.equal(summary1.total_records, 1);

    await cleanupPostgres();
    await seedPostgresUnrelatedConnections(25);
    await seedPostgresTargetConnection();
    await reconcileConnectorSummaryEvidence(null);
    const { result: summary25, calls: calls25 } = await countPoolQueries(() =>
      getConnectorSummaryForRoute("cin_route_target_pg")
    );

    assert.ok(summary25);
    assert.equal(summary25.total_records, 1);
    assert.ok(
      calls25 <= calls1 + 5,
      `N=25 getConnectorSummaryForRoute issued ${calls25} pool.query calls vs N=1's ${calls1} — the full route call chain must not scale with N`
    );
  } finally {
    await cleanupPostgres();
    await closePostgresStorage();
  }
});
