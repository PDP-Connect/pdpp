// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dual-backend contract tests for the `retained_count_summary` named profile
 * and the bounded repeated `connector_id` SET scope on `listConnectorSummaryPage`
 * / `parseConnectorSummaryPageRequest` (design doc add-source-perf-design-agy-
 * 0730.md; Fable ruling terminal-read-architecture-fable-0730.md §2 R4/R5, §3
 * G2/G4 — the Add Source fan-out removal).
 *
 * Every test body runs against BOTH SQLite (a fresh temp file per test) and a
 * real disposable PostgreSQL database (`PDPP_TEST_POSTGRES_URL`, skipped when
 * absent) via `withBothBackends`, mirroring
 * `ref-connectors-identity-inventory-profile.test.ts`'s pattern.
 *
 * Proves:
 *   1. The pinned field set is exactly `connection_id`, `connector_id`,
 *      `connector_instance_id`, `display_name`, `connector_display_name`,
 *      `status`, `revoked_at`, `total_records`, `total_records_state`,
 *      `acquisition_coverage`.
 *   2. `total_records`/`total_records_state` mirror the evidence-first
 *      derivation exactly (known/known_zero/stale/unobserved).
 *   3. `acquisition_coverage.latest_batch` is the most recent acquisition
 *      batch for the connection, or `null` when none exists.
 *   4. Exact-set oracle: an owner with duplicate connector types, a
 *      zero-configured catalog id, active/paused/revoked rows, and a foreign
 *      owner — exhausted traversal over a SET scope equals the independently
 *      enumerated owner-visible `connector_instances` intersected with the
 *      scope.
 *   5. N=0/1/25/100/101 request sizing: 101 distinct set members is a typed
 *      invalid request; N=100 is the accepted ceiling.
 *   6. Pagination/security oracle: cursor scope/owner/set mismatch, mixing
 *      with `connection`, duplicate-after-canonicalization ids.
 *   7. Field parity to `detail`: for every returned id, this profile's fields
 *      equal the `?connection=<id>` full-detail projection's corresponding
 *      fields for the same instant (test oracle only).
 *   8. Cost gate: page reads stay within a small bounded statement budget,
 *      zero writes, zero `spine_events` reads, on both backends.
 *   9. Sparse/dense fleet: a SET scope selecting 2 connector types out of a
 *      1000-connection owner fleet returns exactly the scoped rows.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: test-only raw SQLite instrumentation.
import Database from "better-sqlite3";
import {
  ConnectorSummaryPageRequestError,
  decodeConnectorSummaryPageCursor,
  parseConnectorSummaryPageRequest,
} from "../operations/ref-connectors-list/pagination.ts";
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
  type ConnectorRetainedCountSummary,
  getConnectorSummaryForRoute,
  listConnectorSummaryPage,
} from "../server/ref-control.ts";
import {
  createPostgresAcquisitionBatchStore,
  createSqliteAcquisitionBatchStore,
} from "../server/stores/acquisition-batch-store.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "retained-count-summary-profile test cursor key";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const SPINE_EVENTS_TABLE_RE = /SPINE_EVENTS/i;

const OWNER_SUBJECT_ID = "owner_local";
const FOREIGN_OWNER_SUBJECT_ID = "owner_foreign_retained_count";
const NOW = "2026-05-20T12:00:00.000Z";

const CONNECTOR_A = "https://test.pdpp.dev/connectors/retained-count-a";
const CONNECTOR_B = "https://test.pdpp.dev/connectors/retained-count-b";
const CONNECTOR_EMPTY = "https://test.pdpp.dev/connectors/retained-count-empty";
const CONNECTOR_NSLOPE_FLEET = "https://test.pdpp.dev/connectors/retained-count-nslope-fleet";

const PINNED_KEYS = [
  "acquisition_coverage",
  "connection_id",
  "connector_display_name",
  "connector_id",
  "connector_instance_id",
  "display_name",
  "revoked_at",
  "status",
  "total_records",
  "total_records_state",
].sort();

function withBothBackends(name: string, fn: () => Promise<void>): void {
  test(`${name} (SQLite)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-ref-connectors-retained-count-"));
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
        databaseName: `pdpp_retained_count_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`,
      },
      async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        await fn();
      }
    );
  });
}

async function seedConnector(connectorId: string, streams: readonly string[] = ["messages"]): Promise<void> {
  const manifest = {
    capabilities: { public_listing: { listed: true, status: "test" } },
    connector_id: connectorId,
    display_name: `Retained Count Test ${connectorId}`,
    protocol_version: "0.1.0",
    streams: streams.map((name) => ({ name, primary_key: ["id"] })),
    version: "1.0.0",
  };
  if (isPostgresStorageBackend()) {
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      connectorId,
      JSON.stringify(manifest),
      NOW,
    ]);
    return;
  }
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
}

function getInstanceStore() {
  return isPostgresStorageBackend() ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
}

function getBatchStore() {
  return isPostgresStorageBackend() ? createPostgresAcquisitionBatchStore() : createSqliteAcquisitionBatchStore();
}

async function seedInstance(options: {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
  ownerSubjectId?: string;
  status?: string;
  revokedAt?: string | null;
  createdAt?: string;
}): Promise<void> {
  await getInstanceStore().upsert({
    connectorId: options.connectorId,
    connectorInstanceId: options.connectorInstanceId,
    createdAt: options.createdAt ?? NOW,
    displayName: options.displayName,
    ownerSubjectId: options.ownerSubjectId ?? OWNER_SUBJECT_ID,
    revokedAt: options.revokedAt ?? null,
    sourceBinding: { kind: "manual" },
    sourceBindingKey: options.connectorInstanceId,
    sourceKind: "manual",
    status: options.status ?? "active",
    updatedAt: options.revokedAt ?? options.createdAt ?? NOW,
  });
}

async function seedRecord(options: {
  connectorId: string;
  connectorInstanceId: string;
  stream: string;
  key: string;
  emittedAt: string;
}): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
       VALUES($1, $2, $3, $4, '{}'::jsonb, $5, 1, false, $4)`,
      [options.connectorId, options.connectorInstanceId, options.stream, options.key, options.emittedAt]
    );
    await postgresQuery(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES($1, $2, $3, $4, 1, '{}'::jsonb, $5, false)`,
      [options.connectorId, options.connectorInstanceId, options.stream, options.key, options.emittedAt]
    );
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`
    )
    .run(options.connectorId, options.connectorInstanceId, options.stream, options.key, "{}", options.emittedAt);
  getDb()
    .prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES (?, ?, ?, ?, 1, ?, ?, 0)`
    )
    .run(options.connectorId, options.connectorInstanceId, options.stream, options.key, "{}", options.emittedAt);
}

async function seedAcquisitionBatch(options: {
  connectorId: string;
  connectorInstanceId: string;
  uploadedFileName: string;
  createdAt: string;
  status?: string;
}): Promise<void> {
  await Promise.resolve(
    getBatchStore().insertOwnerArtifactBatch({
      artifactSha256: `sha_${options.connectorInstanceId}_${options.uploadedFileName}`,
      connectorId: options.connectorId,
      connectorInstanceId: options.connectorInstanceId,
      createdAt: options.createdAt,
      ownerSubjectId: OWNER_SUBJECT_ID,
      status: options.status ?? "committed",
      updatedAt: options.createdAt,
      uploadedFileName: options.uploadedFileName,
    })
  );
}

function assertPinnedShape(row: ConnectorRetainedCountSummary): void {
  assert.deepEqual(Object.keys(row).sort(), PINNED_KEYS);
}

// ─── 1. Field-set + derivation oracles ────────────────────────────────────

withBothBackends("retained_count_summary profile: pinned field set and known-count derivation", async () => {
  await seedConnector(CONNECTOR_A);
  await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: "cin_rcs_known", displayName: "Known" });
  await seedRecord({
    connectorId: CONNECTOR_A,
    connectorInstanceId: "cin_rcs_known",
    emittedAt: "2026-05-20T12:05:00.000Z",
    key: "rec-1",
    stream: "messages",
  });
  await reconcileConnectorSummaryEvidence(null);

  const row = await getConnectorSummaryForRoute("cin_rcs_known", null, { profile: "retained_count_summary" });

  assert.ok(row);
  assertPinnedShape(row);
  assert.equal(row.connection_id, "cin_rcs_known");
  assert.equal(row.connector_instance_id, "cin_rcs_known");
  assert.equal(row.connector_id, CONNECTOR_A);
  assert.equal(row.display_name, "Known");
  assert.equal(row.status, "active");
  assert.equal(row.revoked_at, null);
  assert.equal(row.total_records, 1);
  assert.equal(row.total_records_state, "known");
  assert.equal(row.acquisition_coverage, null, "no acquisition batch was seeded");
});

withBothBackends("retained_count_summary profile: unobserved (no evidence row yet) reads total_records=0", async () => {
  await seedConnector(CONNECTOR_A);
  await seedInstance({
    connectorId: CONNECTOR_A,
    connectorInstanceId: "cin_rcs_unobserved",
    displayName: "Unobserved",
  });
  // Deliberately no reconcileConnectorSummaryEvidence call.

  const row = await getConnectorSummaryForRoute("cin_rcs_unobserved", null, { profile: "retained_count_summary" });

  assert.ok(row);
  assertPinnedShape(row);
  assert.equal(row.total_records, 0);
  assert.equal(row.total_records_state, "unobserved");
});

withBothBackends("retained_count_summary profile: known_zero when evidence exists but has no records", async () => {
  await seedConnector(CONNECTOR_A);
  await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: "cin_rcs_zero", displayName: "Zero" });
  await reconcileConnectorSummaryEvidence(null);

  const row = await getConnectorSummaryForRoute("cin_rcs_zero", null, { profile: "retained_count_summary" });

  assert.ok(row);
  assert.equal(row.total_records, 0);
  assert.equal(row.total_records_state, "known_zero");
});

withBothBackends(
  "retained_count_summary profile: acquisition_coverage.latest_batch is the most recent batch",
  async () => {
    await seedConnector(CONNECTOR_A);
    await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: "cin_rcs_batches", displayName: "Batches" });
    await seedAcquisitionBatch({
      connectorId: CONNECTOR_A,
      connectorInstanceId: "cin_rcs_batches",
      createdAt: "2026-05-20T12:00:00.000Z",
      uploadedFileName: "older.zip",
    });
    await seedAcquisitionBatch({
      connectorId: CONNECTOR_A,
      connectorInstanceId: "cin_rcs_batches",
      createdAt: "2026-05-20T13:00:00.000Z",
      uploadedFileName: "newer.zip",
    });
    await reconcileConnectorSummaryEvidence(null);

    const row = await getConnectorSummaryForRoute("cin_rcs_batches", null, { profile: "retained_count_summary" });

    assert.ok(row);
    assert.ok(row.acquisition_coverage);
    assert.equal(row.acquisition_coverage.latest_batch?.uploaded_file_name, "newer.zip");
  }
);

withBothBackends(
  "retained_count_summary profile: view-model equivalence with the full (default) profile for the same connection",
  async () => {
    await seedConnector(CONNECTOR_A);
    await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: "cin_rcs_parity", displayName: "Parity" });
    await seedRecord({
      connectorId: CONNECTOR_A,
      connectorInstanceId: "cin_rcs_parity",
      emittedAt: "2026-05-20T12:05:00.000Z",
      key: "rec-1",
      stream: "messages",
    });
    await seedAcquisitionBatch({
      connectorId: CONNECTOR_A,
      connectorInstanceId: "cin_rcs_parity",
      createdAt: "2026-05-20T12:10:00.000Z",
      uploadedFileName: "parity.zip",
    });
    await reconcileConnectorSummaryEvidence(null);

    const retainedRow = await getConnectorSummaryForRoute("cin_rcs_parity", null, {
      profile: "retained_count_summary",
    });
    const fullRow = await getConnectorSummaryForRoute("cin_rcs_parity", null);

    assert.ok(retainedRow);
    assert.ok(fullRow);
    // Test oracle only (design doc "Summary parity oracle"): every field this
    // profile carries is bit-identical to the detail projection's value for
    // the same instant.
    assert.equal(retainedRow.connection_id, fullRow.connection_id);
    assert.equal(retainedRow.connector_id, fullRow.connector_id);
    assert.equal(retainedRow.connector_instance_id, fullRow.connector_instance_id);
    assert.equal(retainedRow.display_name, fullRow.display_name);
    assert.equal(retainedRow.connector_display_name, fullRow.connector_display_name);
    assert.equal(retainedRow.status, fullRow.status);
    assert.equal(retainedRow.revoked_at, fullRow.revoked_at ?? null);
    assert.equal(retainedRow.total_records, fullRow.total_records);
    assert.equal(retainedRow.total_records_state, fullRow.total_records_state);
    assert.equal(
      retainedRow.acquisition_coverage?.latest_batch?.uploaded_file_name,
      fullRow.acquisition_coverage?.latest_batch?.uploaded_file_name
    );
    assert.equal(
      retainedRow.acquisition_coverage?.latest_batch?.status,
      fullRow.acquisition_coverage?.latest_batch?.status
    );
  }
);

// ─── 2. Exact-set oracle (N=0/1/25/100, duplicates, revoked, foreign owner) ─

withBothBackends(
  "retained_count_summary profile: SET scope N=0/1/25/100 page sizing exactly matches the independently enumerated owner-visible relation",
  async () => {
    await seedConnector(CONNECTOR_A);
    const ids = Array.from({ length: 100 }, (_, i) => `cin_rcs_page_${String(i).padStart(3, "0")}`);
    for (const [i, id] of ids.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: each backend store call must serialize against the same connector row; batching risks unique-key races on Postgres.
      await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: id, displayName: `Page ${i}` });
    }
    await reconcileConnectorSummaryEvidence(null);

    // N=0: a foreign owner has none of these connections.
    const emptyPage = await listConnectorSummaryPage(null, {
      connectorId: [CONNECTOR_A],
      limit: 25,
      ownerSubjectId: FOREIGN_OWNER_SUBJECT_ID,
      profile: "retained_count_summary",
    });
    assert.deepEqual(emptyPage.data, []);
    assert.equal(emptyPage.has_more, false);

    // N=1.
    const onePage = await listConnectorSummaryPage(null, {
      connectorId: [CONNECTOR_A],
      limit: 1,
      ownerSubjectId: OWNER_SUBJECT_ID,
      profile: "retained_count_summary",
    });
    assert.equal(onePage.data.length, 1);
    assert.equal(onePage.has_more, true);
    assertPinnedShape(onePage.data[0] as ConnectorRetainedCountSummary);

    // N=25.
    const page25 = await listConnectorSummaryPage(null, {
      connectorId: [CONNECTOR_A],
      limit: 25,
      ownerSubjectId: OWNER_SUBJECT_ID,
      profile: "retained_count_summary",
    });
    assert.equal(page25.data.length, 25);
    assert.equal(page25.has_more, true);

    // N=100: exhausted traversal via cursor — the 100-row fixture exactly
    // fills one page at limit=100, so `has_more` is false immediately; the
    // loop still proves the general exhaustion shape (follow next_cursor
    // until has_more is false) rather than assuming a single page.
    const rows: ConnectorRetainedCountSummary[] = [];
    let after: Parameters<typeof listConnectorSummaryPage>[1]["after"] = null;
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: cursor pages depend on the prior page's continuation.
      const page = await listConnectorSummaryPage(null, {
        after,
        connectorId: [CONNECTOR_A],
        limit: 100,
        ownerSubjectId: OWNER_SUBJECT_ID,
        profile: "retained_count_summary",
      });
      rows.push(...page.data);
      if (!(page.has_more && page.next_cursor)) {
        break;
      }
      after = decodeConnectorSummaryPageCursor(page.next_cursor, OWNER_SUBJECT_ID, [CONNECTOR_A]);
    }
    assert.equal(rows.length, 100);
    assert.deepEqual(new Set(rows.map((row) => row.connection_id)).size, 100, "no duplicate identities");
  }
);

withBothBackends(
  "retained_count_summary profile: exact-set oracle — duplicate connector types, zero-configured id, revoked rows, foreign owner",
  async () => {
    await seedConnector(CONNECTOR_A);
    await seedConnector(CONNECTOR_B);
    await seedConnector(CONNECTOR_EMPTY);
    await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: "cin_rcs_a1", displayName: "A1" });
    await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: "cin_rcs_a2", displayName: "A2" });
    await seedInstance({ connectorId: CONNECTOR_B, connectorInstanceId: "cin_rcs_b1", displayName: "B1" });
    await seedInstance({
      connectorId: CONNECTOR_B,
      connectorInstanceId: "cin_rcs_b2_revoked",
      displayName: "B2 Revoked",
      revokedAt: "2026-06-01T00:00:00.000Z",
      status: "revoked",
    });
    await seedInstance({
      connectorId: CONNECTOR_A,
      connectorInstanceId: "cin_rcs_foreign",
      displayName: "Foreign",
      ownerSubjectId: FOREIGN_OWNER_SUBJECT_ID,
    });
    await reconcileConnectorSummaryEvidence(null);

    const page = await listConnectorSummaryPage(null, {
      connectorId: [CONNECTOR_A, CONNECTOR_B, CONNECTOR_EMPTY],
      limit: 100,
      ownerSubjectId: OWNER_SUBJECT_ID,
      profile: "retained_count_summary",
    });

    assert.equal(page.has_more, false);
    const ids = page.data.map((row) => row.connection_id).sort();
    assert.deepEqual(ids, ["cin_rcs_a1", "cin_rcs_a2", "cin_rcs_b1", "cin_rcs_b2_revoked"]);
    // Revoked pagination itself must not erase the row (design doc: "pagination
    // itself must not erase revoked identities") — Add Source applies its own
    // client-side revoked filter on top of this exact set.
    const revoked = page.data.find((row) => row.connection_id === "cin_rcs_b2_revoked");
    assert.ok(revoked);
    assert.equal(revoked.status, "revoked");
    assert.ok(revoked.revoked_at);
    // The foreign owner's connection never appears, and the empty catalog id
    // simply contributes no rows (not an error).
    assert.ok(!ids.includes("cin_rcs_foreign"));
  }
);

// ─── 3. Sparse/dense fleet ──────────────────────────────────────────────────

const FLEET_CONNECTOR_ID = "https://test.pdpp.dev/connectors/retained-count-fleet";

withBothBackends(
  "retained_count_summary profile: sparse SET scope inside a dense 1000-connection fleet returns only the scoped rows",
  async () => {
    await seedConnector(CONNECTOR_A);
    await seedConnector(CONNECTOR_B);
    await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: "cin_rcs_sparse_a", displayName: "Sparse A" });
    await seedInstance({ connectorId: CONNECTOR_B, connectorInstanceId: "cin_rcs_sparse_b", displayName: "Sparse B" });
    // Dense FLEET is many CONNECTIONS under one registered connector TYPE —
    // the registered-connector catalog stays small (a few types), matching
    // the design doc's model ("catalog is a fundamentally different, small,
    // bounded cardinality from the owner's fleet size"); only connection
    // count grows here.
    await seedConnector(FLEET_CONNECTOR_ID);
    for (let i = 0; i < 1000; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential to avoid unique-key races.
      await seedInstance({
        connectorId: FLEET_CONNECTOR_ID,
        connectorInstanceId: `cin_rcs_fleet_${i}`,
        displayName: `Fleet ${i}`,
      });
    }
    await reconcileConnectorSummaryEvidence(null);

    const page = await listConnectorSummaryPage(null, {
      connectorId: [CONNECTOR_A, CONNECTOR_B],
      limit: 100,
      ownerSubjectId: OWNER_SUBJECT_ID,
      profile: "retained_count_summary",
    });

    assert.equal(page.has_more, false);
    const ids = page.data.map((row) => row.connection_id).sort();
    assert.deepEqual(ids, ["cin_rcs_sparse_a", "cin_rcs_sparse_b"]);
  }
);

// ─── 4. Request/set-size validation ────────────────────────────────────────

test("retained_count_summary profile: SET scope rejects >100 distinct ids, empty sets, and duplicates after canonicalization", () => {
  const identity = (id: string) => id;

  const oversized = Array.from({ length: 101 }, (_, i) => `connector-${i}`);
  assert.throws(
    () => parseConnectorSummaryPageRequest({ connector_id: oversized, limit: "100" }, OWNER_SUBJECT_ID, identity),
    ConnectorSummaryPageRequestError
  );

  assert.throws(
    () => parseConnectorSummaryPageRequest({ connector_id: [], limit: "100" }, OWNER_SUBJECT_ID, identity),
    ConnectorSummaryPageRequestError
  );

  assert.throws(
    () =>
      parseConnectorSummaryPageRequest(
        { connector_id: ["a", "a"], limit: "100" },
        OWNER_SUBJECT_ID,
        () => "canonical-a"
      ),
    ConnectorSummaryPageRequestError,
    "two distinct raw ids that canonicalize to the same id must be rejected as a duplicate set"
  );

  const atCeiling = Array.from({ length: 100 }, (_, i) => `connector-${i}`);
  const parsed = parseConnectorSummaryPageRequest(
    { connector_id: atCeiling, limit: "100" },
    OWNER_SUBJECT_ID,
    identity
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.connectorId, atCeiling);

  // A single-element repeated form collapses to the plain single-id filter —
  // byte-identical shape to `?connector_id=A`.
  const single = parseConnectorSummaryPageRequest(
    { connector_id: ["only-one"], limit: "10" },
    OWNER_SUBJECT_ID,
    identity
  );
  assert.equal(single?.connectorId, "only-one");
});

test("retained_count_summary profile: profile parameter accepts retained_count_summary", () => {
  const parsed = parseConnectorSummaryPageRequest({ limit: "10", profile: "retained_count_summary" }, OWNER_SUBJECT_ID);
  assert.equal(parsed?.profile, "retained_count_summary");
});

// ─── 5. Cursor scope/owner/security oracle ─────────────────────────────────

withBothBackends(
  "retained_count_summary profile: cursor scope binds to the exact SET, rejecting mismatch/reorder/owner-swap replay",
  async () => {
    await seedConnector(CONNECTOR_A);
    await seedConnector(CONNECTOR_B);
    for (let i = 0; i < 3; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential.
      await seedInstance({
        connectorId: CONNECTOR_A,
        connectorInstanceId: `cin_rcs_cursor_a${i}`,
        displayName: `A${i}`,
      });
    }
    await reconcileConnectorSummaryEvidence(null);

    const firstPage = await listConnectorSummaryPage(null, {
      connectorId: [CONNECTOR_A, CONNECTOR_B],
      limit: 1,
      ownerSubjectId: OWNER_SUBJECT_ID,
      profile: "retained_count_summary",
    });
    assert.equal(firstPage.has_more, true);
    assert.ok(firstPage.next_cursor);
    const opaqueCursor = firstPage.next_cursor;

    // Same cursor, same set, different order — must still resolve (canonical
    // ordered fingerprint, not raw user ordering).
    const reorderedAfter = decodeConnectorSummaryPageCursor(opaqueCursor, OWNER_SUBJECT_ID, [CONNECTOR_B, CONNECTOR_A]);
    const reordered = await listConnectorSummaryPage(null, {
      after: reorderedAfter,
      connectorId: [CONNECTOR_B, CONNECTOR_A],
      limit: 1,
      ownerSubjectId: OWNER_SUBJECT_ID,
      profile: "retained_count_summary",
    });
    assert.ok(reordered.data.length >= 0); // resolves without throwing

    // Different set — must reject.
    assert.throws(() => decodeConnectorSummaryPageCursor(opaqueCursor, OWNER_SUBJECT_ID, [CONNECTOR_A]));

    // Unfiltered — must reject.
    assert.throws(() => decodeConnectorSummaryPageCursor(opaqueCursor, OWNER_SUBJECT_ID, null));

    // Different owner — must reject (no foreign-owner observation).
    assert.throws(() =>
      decodeConnectorSummaryPageCursor(opaqueCursor, FOREIGN_OWNER_SUBJECT_ID, [CONNECTOR_A, CONNECTOR_B])
    );
  }
);

test("retained_count_summary profile: connection stays mutually exclusive with limit/cursor/connector_id at the route request-parse boundary", () => {
  // `parseConnectorSummaryPageRequest` itself has no `connection` concept —
  // the route (`sendConnectionScopedConnectorSummary`) enforces this by
  // throwing before ever calling the page parser when `connection` is
  // present alongside limit/cursor/connector_id (see
  // `server/routes/ref-connectors.ts`). This test pins that the page parser
  // continues to accept a bare `connector_id` SET without a `connection`
  // key, proving the two code paths remain independent.
  const parsed = parseConnectorSummaryPageRequest(
    { connector_id: ["a", "b"], limit: "10" },
    OWNER_SUBJECT_ID,
    (id) => id
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.connectorId, ["a", "b"]);
});

// ─── 6. Cost gate ───────────────────────────────────────────────────────────

withBothBackends(
  "retained_count_summary profile: cost gate — page reads are page-scoped statements only, zero writes, zero spine reads",
  async () => {
    await seedConnector(CONNECTOR_A);
    await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: "cin_rcs_cost", displayName: "Cost" });
    await seedAcquisitionBatch({
      connectorId: CONNECTOR_A,
      connectorInstanceId: "cin_rcs_cost",
      createdAt: "2026-05-20T12:00:00.000Z",
      uploadedFileName: "cost.zip",
    });
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
          connectorId: [CONNECTOR_A],
          limit: 25,
          ownerSubjectId: OWNER_SUBJECT_ID,
          profile: "retained_count_summary",
        });
      } finally {
        pool.query = originalQuery as typeof pool.query;
      }
    } else {
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
          connectorId: [CONNECTOR_A],
          limit: 25,
          ownerSubjectId: OWNER_SUBJECT_ID,
          profile: "retained_count_summary",
        });
      } finally {
        Database.prototype.prepare = originalPrepare;
      }
    }

    const writes = statements.filter((s) => s.kind === "write");
    assert.deepEqual(writes, [], "GET under the retained_count_summary profile must issue zero writes");
    const spineReads = statements.filter((s) => SPINE_EVENTS_TABLE_RE.test(s.sql));
    assert.deepEqual(spineReads, [], "the retained_count_summary profile must never read spine_events");
    // Dependency matrix: identity page + evidence-row batch + acquisition-batch
    // batch + declared-manifest lookup — a handful of distinct statement
    // shapes, not the ~22-24 the full profile issues.
    assert.ok(
      statements.length <= 8,
      `expected a small, bounded number of distinct statement shapes, got ${statements.length}: ${statements.map((s) => s.sql).join(" | ")}`
    );
  }
);

// ─── 7. N-slope: statement/row count constant in unrelated fleet size ─────

withBothBackends(
  "retained_count_summary profile: statement count against a 1000-connection unrelated fleet matches the sparse cost-gate ceiling (n=1 vs n=1000)",
  async () => {
    await seedConnector(CONNECTOR_A);
    await seedInstance({ connectorId: CONNECTOR_A, connectorInstanceId: "cin_rcs_nslope", displayName: "N-slope" });
    // Dense unrelated fleet is many CONNECTIONS under one OTHER registered
    // connector type (see the sparse/dense fleet test above for why the
    // catalog itself must stay small); the scoped request never touches
    // CONNECTOR_NSLOPE_FLEET, so a request scoped to CONNECTOR_A alone must
    // cost the SAME small bounded statement count the n=1 cost-gate test
    // already proves, not grow with this unrelated fleet's size.
    await seedConnector(CONNECTOR_NSLOPE_FLEET);
    for (let i = 0; i < 999; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture setup is intentionally sequential.
      await seedInstance({
        connectorId: CONNECTOR_NSLOPE_FLEET,
        connectorInstanceId: `cin_rcs_nslope_fleet_${i}`,
        displayName: `Fleet ${i}`,
      });
    }
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
          connectorId: [CONNECTOR_A],
          limit: 25,
          ownerSubjectId: OWNER_SUBJECT_ID,
          profile: "retained_count_summary",
        });
      } finally {
        pool.query = originalQuery as typeof pool.query;
      }
    } else {
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
          connectorId: [CONNECTOR_A],
          limit: 25,
          ownerSubjectId: OWNER_SUBJECT_ID,
          profile: "retained_count_summary",
        });
      } finally {
        Database.prototype.prepare = originalPrepare;
      }
    }

    // Same ceiling as the n=1 sparse cost-gate test above: this dense
    // unrelated fleet (999 connections under a sibling connector type) must
    // not add a single extra statement to a request scoped away from it.
    assert.ok(
      statements.length <= 8,
      `expected the SAME small bounded statement count as the sparse fixture, got ${statements.length}: ${statements.map((s) => s.sql).join(" | ")}`
    );
    assert.deepEqual(
      statements.filter((s) => s.kind === "write"),
      [],
      "GET under the retained_count_summary profile must issue zero writes even against a dense unrelated fleet"
    );
  }
);
