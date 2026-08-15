// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dual-backend contract tests for the `identity_inventory` named profile on
 * `listConnectorSummaryPage`/`getConnectorSummaryForRoute`
 * (Fable ruling terminal-read-architecture-fable-0730.md §8, R8.4).
 *
 * Every test body runs against BOTH SQLite (a fresh temp file per test) and
 * a real disposable PostgreSQL database (`PDPP_TEST_POSTGRES_URL`, skipped
 * when that env var is absent) via `withBothBackends`, so declared-only,
 * observed-unexpected, revoked, and pre-sweep behavior — plus the cost gate
 * and N=0/1/25/100 page sizing — are proven identical on both durable
 * backends, not just SQLite.
 *
 * Proves:
 *   1. The pinned field set is exactly `connection_id`, `connector_id`,
 *      `connector_instance_id`, `display_name`, `connector_display_name`,
 *      `streams`, `membership_state`.
 *   2. `streams` equals the stored evidence-row declared∪observed union, or
 *      declared-only + `pending` when no evidence row exists.
 *   3. View-model equivalence: the identity/membership fields are
 *      bit-identical between the `identity_inventory` profile and the
 *      default full profile for the same connection.
 *   4. Cost gate: page reads stay within the ≤4 page-scoped-statement
 *      budget, zero writes, zero `spine_events` reads, on both backends.
 *   5. N=0/1/25/100 page-size checks against the profile itself (not the
 *      full profile's own N=100 proof elsewhere, which does not exercise
 *      this profile's dependency-gating branch).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: test-only raw SQLite instrumentation.
import Database from "better-sqlite3";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import {
  type ConnectorIdentityInventorySummary,
  getConnectorSummaryForRoute,
  listConnectorSummaryPage,
} from "../server/ref-control.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "identity-inventory-profile test cursor key";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const SPINE_EVENTS_TABLE_RE = /SPINE_EVENTS/i;

const CONNECTOR_ID = "https://test.pdpp.dev/connectors/identity-inventory-profile";
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-20T12:00:00.000Z";
const REVOKED_AT = "2026-06-10T19:10:28.476Z";

const DECLARED_ONLY_INSTANCE_ID = "cin_identity_declared_only";
const OBSERVED_UNEXPECTED_INSTANCE_ID = "cin_identity_observed_unexpected";
const REVOKED_INSTANCE_ID = "cin_identity_revoked";
const PRE_SWEEP_INSTANCE_ID = "cin_identity_pre_sweep";

const PINNED_KEYS = [
  "connection_id",
  "connector_display_name",
  "connector_id",
  "connector_instance_id",
  "display_name",
  "membership_state",
  "streams",
].sort();

/**
 * Run `fn` once against a fresh SQLite temp database, and once (skipped when
 * `PDPP_TEST_POSTGRES_URL` is absent) against a fresh disposable PostgreSQL
 * database on the sanctioned dedicated test cluster.
 */
function withBothBackends(name: string, fn: () => Promise<void>): void {
  test(`${name} (SQLite)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-ref-connectors-identity-inventory-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  });

  if (!POSTGRES_URL) {
    return;
  }

  test(`${name} (PostgreSQL)`, async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_identity_inv_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`,
      },
      async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        await fn();
      }
    );
  });
}

async function seedConnector(): Promise<void> {
  const manifest = {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: CONNECTOR_ID,
    display_name: "Identity Inventory Profile Test Connector",
    protocol_version: "0.1.0",
    streams: [
      { name: "messages", primary_key: ["id"] },
      { name: "files", primary_key: ["id"] },
    ],
    version: "1.0.0",
  };
  if (isPostgresStorageBackend()) {
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      CONNECTOR_ID,
      JSON.stringify(manifest),
      NOW,
    ]);
    return;
  }
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

function getInstanceStore() {
  return isPostgresStorageBackend() ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
}

async function seedInstance(options: {
  connectorInstanceId: string;
  displayName: string;
  status?: string;
  revokedAt?: string | null;
}): Promise<void> {
  await getInstanceStore().upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: options.connectorInstanceId,
    createdAt: NOW,
    displayName: options.displayName,
    ownerSubjectId: OWNER_SUBJECT_ID,
    revokedAt: options.revokedAt ?? null,
    sourceBinding: { kind: "manual" },
    sourceBindingKey: options.connectorInstanceId,
    sourceKind: "manual",
    status: options.status ?? "active",
    updatedAt: options.revokedAt ?? NOW,
  });
}

async function seedRecord(options: {
  connectorInstanceId: string;
  stream: string;
  key: string;
  emittedAt: string;
}): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
       VALUES($1, $2, $3, $4, '{}'::jsonb, $5, 1, false, $4)`,
      [CONNECTOR_ID, options.connectorInstanceId, options.stream, options.key, options.emittedAt]
    );
    await postgresQuery(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES($1, $2, $3, $4, 1, '{}'::jsonb, $5, false)`,
      [CONNECTOR_ID, options.connectorInstanceId, options.stream, options.key, options.emittedAt]
    );
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`
    )
    .run(CONNECTOR_ID, options.connectorInstanceId, options.stream, options.key, "{}", options.emittedAt);
  getDb()
    .prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES (?, ?, ?, ?, 1, ?, ?, 0)`
    )
    .run(CONNECTOR_ID, options.connectorInstanceId, options.stream, options.key, "{}", options.emittedAt);
}

function assertPinnedShape(row: ConnectorIdentityInventorySummary): void {
  assert.deepEqual(Object.keys(row).sort(), PINNED_KEYS);
}

withBothBackends(
  "identity_inventory profile: declared-only fixture (evidence row present, no observed streams beyond declared)",
  async () => {
    await seedConnector();
    await seedInstance({ connectorInstanceId: DECLARED_ONLY_INSTANCE_ID, displayName: "Declared Only" });
    await reconcileConnectorSummaryEvidence(null);

    const row = await getConnectorSummaryForRoute(DECLARED_ONLY_INSTANCE_ID, null, {
      profile: "identity_inventory",
    });

    assert.ok(row, "a known connection resolves to an identity_inventory row");
    assertPinnedShape(row);
    assert.equal(row.connection_id, DECLARED_ONLY_INSTANCE_ID);
    assert.equal(row.connector_id, CONNECTOR_ID);
    assert.equal(row.connector_instance_id, DECLARED_ONLY_INSTANCE_ID);
    assert.equal(row.display_name, "Declared Only");
    assert.equal(row.membership_state, "complete", "an evidence row exists (the sweep ran)");
    assert.deepEqual([...row.streams].sort(), ["files", "messages"], "declared-only streams, no observed extras");
  }
);

withBothBackends(
  "identity_inventory profile: observed-unexpected fixture (a stream outside the declared manifest is included in the union)",
  async () => {
    await seedConnector();
    await seedInstance({ connectorInstanceId: OBSERVED_UNEXPECTED_INSTANCE_ID, displayName: "Observed Unexpected" });
    await seedRecord({
      connectorInstanceId: OBSERVED_UNEXPECTED_INSTANCE_ID,
      emittedAt: "2026-05-20T12:10:00.000Z",
      key: "rec-1",
      stream: "undeclared_stream",
    });
    await reconcileConnectorSummaryEvidence(null);

    const row = await getConnectorSummaryForRoute(OBSERVED_UNEXPECTED_INSTANCE_ID, null, {
      profile: "identity_inventory",
    });

    assert.ok(row);
    assertPinnedShape(row);
    assert.equal(row.membership_state, "complete");
    assert.deepEqual(
      [...row.streams].sort(),
      ["files", "messages", "undeclared_stream"],
      "the observed-but-undeclared stream is part of the declared∪observed union"
    );
  }
);

withBothBackends("identity_inventory profile: revoked connections remain resolvable and owner-visible", async () => {
  await seedConnector();
  await seedInstance({
    connectorInstanceId: REVOKED_INSTANCE_ID,
    displayName: "Revoked",
    revokedAt: REVOKED_AT,
    status: "revoked",
  });
  await reconcileConnectorSummaryEvidence(null);

  const row = await getConnectorSummaryForRoute(REVOKED_INSTANCE_ID, null, { profile: "identity_inventory" });

  assert.ok(row, "a revoked connection is still resolvable by the identity_inventory profile");
  assertPinnedShape(row);
  assert.equal(row.connection_id, REVOKED_INSTANCE_ID);
  assert.deepEqual([...row.streams].sort(), ["files", "messages"]);
});

withBothBackends(
  "identity_inventory profile: pre-sweep fixture (no evidence row yet) serves declared-only with membership_state=pending",
  async () => {
    await seedConnector();
    await seedInstance({ connectorInstanceId: PRE_SWEEP_INSTANCE_ID, displayName: "Pre Sweep" });
    // Deliberately do NOT call reconcileConnectorSummaryEvidence: no evidence
    // row exists yet for this connection (new connection, pre-sweep).

    const row = await getConnectorSummaryForRoute(PRE_SWEEP_INSTANCE_ID, null, { profile: "identity_inventory" });

    assert.ok(row, "a connection with no evidence row yet still resolves");
    assertPinnedShape(row);
    assert.equal(row.membership_state, "pending", "no evidence row exists yet — declared-only, honestly pending");
    assert.deepEqual(
      [...row.streams].sort(),
      ["files", "messages"],
      "pre-sweep streams come from the declared manifest only"
    );
  }
);

withBothBackends(
  "identity_inventory profile: view-model equivalence with the full (default) profile for the same connection",
  async () => {
    await seedConnector();
    await seedInstance({ connectorInstanceId: DECLARED_ONLY_INSTANCE_ID, displayName: "Declared Only" });
    await reconcileConnectorSummaryEvidence(null);

    const identityRow = await getConnectorSummaryForRoute(DECLARED_ONLY_INSTANCE_ID, null, {
      profile: "identity_inventory",
    });
    const fullRow = await getConnectorSummaryForRoute(DECLARED_ONLY_INSTANCE_ID, null);

    assert.ok(identityRow);
    assert.ok(fullRow);
    // The five identity/membership fields Explore's toConnectionFacet reads
    // must be bit-identical between the two profiles for the same instant.
    assert.equal(identityRow.connection_id, fullRow.connection_id);
    assert.equal(identityRow.connector_id, fullRow.connector_id);
    assert.equal(identityRow.connector_instance_id, fullRow.connector_instance_id);
    assert.equal(identityRow.display_name, fullRow.display_name);
    assert.equal(identityRow.connector_display_name, fullRow.connector_display_name);
    assert.deepEqual([...identityRow.streams].sort(), [...fullRow.streams].sort());
  }
);

withBothBackends(
  "identity_inventory profile: page path (listConnectorSummaryPage) returns the same pinned shape for N=0/1/25/100",
  async () => {
    await seedConnector();
    const ids = Array.from({ length: 100 }, (_, i) => `cin_identity_page_${String(i).padStart(3, "0")}`);
    for (const [i, id] of ids.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: each backend store call must serialize against the same connector row; batching risks unique-key races on Postgres.
      await seedInstance({ connectorInstanceId: id, displayName: `Page ${i}` });
    }
    await reconcileConnectorSummaryEvidence(null);

    // N=0: an owner-scoped page for a subject with no connections.
    const emptyPage = await listConnectorSummaryPage(null, {
      limit: 25,
      ownerSubjectId: "owner_with_no_connections",
      profile: "identity_inventory",
    });
    assert.deepEqual(emptyPage.data, []);
    assert.equal(emptyPage.has_more, false);

    // N=1.
    const onePage = await listConnectorSummaryPage(null, {
      limit: 1,
      ownerSubjectId: OWNER_SUBJECT_ID,
      profile: "identity_inventory",
    });
    assert.equal(onePage.data.length, 1);
    assert.equal(onePage.has_more, true);
    assertPinnedShape(onePage.data[0] as ConnectorIdentityInventorySummary);

    // N=25: one bounded page short of the full seeded set.
    const page25 = await listConnectorSummaryPage(null, {
      limit: 25,
      ownerSubjectId: OWNER_SUBJECT_ID,
      profile: "identity_inventory",
    });
    assert.equal(page25.data.length, 25);
    assert.equal(page25.has_more, true, "100 seeded connections exceed a 25-row page");

    // N=100: the full seeded set, exactly at the reference's own page-limit cap.
    const page100 = await listConnectorSummaryPage(null, {
      limit: 100,
      ownerSubjectId: OWNER_SUBJECT_ID,
      profile: "identity_inventory",
    });
    assert.equal(page100.data.length, 100);
    assert.equal(page100.has_more, false);
    for (const row of page100.data) {
      assertPinnedShape(row);
    }
    assert.deepEqual(
      new Set(page100.data.map((row) => row.connection_id)).size,
      100,
      "N=100 page has no duplicate identities"
    );
  }
);

withBothBackends(
  "identity_inventory profile: cost gate — page reads are page-scoped statements only, zero writes, zero spine reads",
  async () => {
    await seedConnector();
    await seedInstance({ connectorInstanceId: DECLARED_ONLY_INSTANCE_ID, displayName: "Declared Only" });
    await reconcileConnectorSummaryEvidence(null);

    const statements: { sql: string; kind: "read" | "write" }[] = [];

    if (isPostgresStorageBackend()) {
      const pool = getPostgresPool();
      const originalQuery = pool.query.bind(pool);
      pool.query = ((...args: Parameters<typeof originalQuery>) => {
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
        const trimmed = sql.trim().toUpperCase();
        const kind: "read" | "write" = trimmed.startsWith("SELECT") ? "read" : "write";
        statements.push({ kind, sql: trimmed });
        return originalQuery(...args);
      }) as typeof pool.query;
      try {
        await listConnectorSummaryPage(null, {
          limit: 25,
          ownerSubjectId: OWNER_SUBJECT_ID,
          profile: "identity_inventory",
        });
      } finally {
        pool.query = originalQuery as typeof pool.query;
      }
    } else {
      // Instrument the raw better-sqlite3 driver's `Database.prototype.prepare`
      // (not the cached-prepare Proxy `getDb()` returns) so every distinct SQL
      // text this call issues is observed exactly once, with no self-recursion.
      const originalPrepare = Database.prototype.prepare;
      (Database.prototype as unknown as { prepare: (sql: string) => unknown }).prepare = function instrumentedPrepare(
        sql: string
      ) {
        const trimmed = sql.trim().toUpperCase();
        const kind: "read" | "write" = trimmed.startsWith("SELECT") ? "read" : "write";
        statements.push({ kind, sql: trimmed });
        return (originalPrepare as unknown as (sql: string) => unknown).call(this, sql);
      };
      try {
        await listConnectorSummaryPage(null, {
          limit: 25,
          ownerSubjectId: OWNER_SUBJECT_ID,
          profile: "identity_inventory",
        });
      } finally {
        Database.prototype.prepare = originalPrepare;
      }
    }

    const writes = statements.filter((s) => s.kind === "write");
    assert.deepEqual(writes, [], "GET under the identity_inventory profile must issue zero writes");
    const spineReads = statements.filter((s) => SPINE_EVENTS_TABLE_RE.test(s.sql));
    assert.deepEqual(spineReads, [], "the identity_inventory profile must never read spine_events");
    // Dependency matrix (R8.1): identity page + evidence-row batch +
    // declared-manifest lookup — at most 4 page-scoped statements, not the
    // ~22-24 the full profile issues.
    assert.ok(
      statements.length <= 4,
      `expected at most 4 page-scoped statements (identity page + evidence batch + manifest lookup), got ${statements.length}: ${statements.map((s) => s.sql).join(" | ")}`
    );
  }
);
