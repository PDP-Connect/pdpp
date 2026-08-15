// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mounted-route proof for the paginated `/_ref/connectors?connector_id=...`
 * filter (client-gate requirement, Perf-2026-07-29): Add Source, manual
 * upload, and grant discovery need to enumerate all connections for ONE
 * connector without scanning the fleet. This composes with `limit`/`cursor`
 * on the SAME keyset page shape `ref-connectors-list-page-route-parity.test.ts`
 * already proves for the unfiltered page — this file proves the filter itself:
 * it narrows correctly, stays a fixed query family, preserves owner
 * isolation, and both `>100` traversal and concurrent mutation hold on both
 * durable backends.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, isPostgresStorageBackend, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const OWNER = "owner_local";
const TARGET_CONNECTOR_ID = "connector-id-filter-target";
const OTHER_CONNECTOR_ID = "connector-id-filter-other";
const SECRET = "connector-id-filter-secret-must-never-leak";
const TARGET_COUNT = 150;
const OTHER_COUNT = 5;
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "connector id filter cursor key";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

interface PageItem {
  readonly connection_id?: string;
  readonly connector_id?: string;
  readonly connector_instance_id?: string;
}

interface PageEnvelope {
  readonly data?: readonly PageItem[];
  readonly has_more?: boolean;
  readonly next_cursor?: string | null;
  readonly object?: string;
}

function instanceId(connectorId: string, index: number): string {
  return `cin_filter_${connectorId.replaceAll("-", "_")}_${String(index).padStart(4, "0")}`;
}

function iso(index: number): string {
  return new Date(Date.UTC(2026, 6, 29, 12, 0, index)).toISOString();
}

function manifest(connectorId: string): Record<string, unknown> {
  return {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: connectorId,
    display_name: `Connector id filter proof (${connectorId})`,
    protocol_version: "0.1.0",
    streams: [{ name: "messages", primary_key: ["id"] }],
    version: "1.0.0",
  };
}

async function closeServer(server: StartedServer | null): Promise<void> {
  if (!server) {
    return;
  }
  server.abortStartupBackfill("connector id filter proof shutdown");
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

async function seedConnector(connectorId: string, count: number): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      connectorId,
      JSON.stringify(manifest(connectorId)),
      iso(0),
    ]);
    for (let index = 0; index < count; index += 1) {
      const id = instanceId(connectorId, index);
      const createdAt = iso(index);
      // biome-ignore lint/performance/noAwaitInLoops: each record's fixture identity is paired with this connection.
      await postgresQuery(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, $2, $3, $4, 'active', 'account', $5, $6::jsonb, $7, $7, NULL)`,
        [
          id,
          OWNER,
          connectorId,
          `Filter proof ${connectorId} ${index}`,
          id,
          JSON.stringify({ secret: SECRET }),
          createdAt,
        ]
      );
      await postgresQuery(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, 'messages', $3, '{}'::jsonb, $4, 1, false, $3)`,
        [connectorId, id, `record-${index}`, createdAt]
      );
    }
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
     VALUES(?, ?, 'messages', ?, '{}', ?, ?, 1, 0)`
  );
  const insertAll = db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = instanceId(connectorId, index);
      const createdAt = iso(index);
      insertInstance.run(
        id,
        OWNER,
        connectorId,
        `Filter proof ${connectorId} ${index}`,
        id,
        JSON.stringify({ secret: SECRET }),
        createdAt,
        createdAt
      );
      insertRecord.run(connectorId, id, `record-${index}`, createdAt, createdAt);
    }
  });
  insertAll();
}

async function getFilteredPage(asUrl: string, query: string): Promise<PageEnvelope> {
  const response = await fetch(`${asUrl}/_ref/connectors?${query}`);
  const body = (await response.json()) as PageEnvelope;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.object, "list");
  assert.ok(Array.isArray(body.data));
  return body;
}

function pageIds(page: PageEnvelope): readonly string[] {
  return (page.data ?? []).map((item) => {
    const id = item.connection_id ?? item.connector_instance_id;
    if (typeof id !== "string") {
      throw new Error("mounted route item must carry its stable connection identity");
    }
    return id;
  });
}

async function traverseFiltered(asUrl: string, connectorId: string, limit: number): Promise<readonly string[]> {
  let cursor: string | null = null;
  const ids: string[] = [];
  do {
    const query = new URLSearchParams({ connector_id: connectorId, limit: String(limit) });
    if (cursor) {
      query.set("cursor", cursor);
    }
    // biome-ignore lint/performance/noAwaitInLoops: each request depends on its previous opaque continuation.
    const page = await getFilteredPage(asUrl, query.toString());
    const current = pageIds(page);
    assert.ok(current.length <= limit, "a bounded page must never exceed its explicit limit");
    assert.ok(
      (page.data ?? []).every((item) => item.connector_id === connectorId),
      "every item on a connector_id-filtered page must belong to that connector"
    );
    ids.push(...current);
    cursor = page.next_cursor ?? null;
    assert.equal(Boolean(cursor), page.has_more ?? false, "continuation and has_more must agree");
  } while (cursor);
  return ids;
}

async function assertConnectorIdFilterParity(asUrl: string): Promise<void> {
  await seedConnector(TARGET_CONNECTOR_ID, TARGET_COUNT);
  await seedConnector(OTHER_CONNECTOR_ID, OTHER_COUNT);

  // A connector_id filter without limit/cursor must be rejected — it composes
  // WITH pagination, it is not a standalone unbounded filtered list.
  const unboundedFilteredResponse = await fetch(`${asUrl}/_ref/connectors?connector_id=${TARGET_CONNECTOR_ID}`);
  assert.equal(unboundedFilteredResponse.status, 400, "connector_id without limit must be rejected");

  const first = await getFilteredPage(asUrl, `connector_id=${TARGET_CONNECTOR_ID}&limit=1`);
  assert.equal(first.data?.length, 1, "N=1 filtered page returns exactly one item");
  assert.equal(first.has_more, true, "the target connector has more than one connection");
  assert.equal(first.data?.[0]?.connector_id, TARGET_CONNECTOR_ID);

  const large = await getFilteredPage(asUrl, `connector_id=${TARGET_CONNECTOR_ID}&limit=100`);
  assert.equal(large.data?.length, 100, "N=100 filtered page hits the page cap, not the connector's full count");
  assert.ok(
    (large.data ?? []).every((item) => item.connector_id === TARGET_CONNECTOR_ID),
    "every returned item belongs to the filtered connector, never the sibling connector"
  );
  assert.ok(
    !JSON.stringify({ first, large }).includes(SECRET),
    "filtered page evidence must never select source secrets"
  );

  // >100 traversal: every one of TARGET_COUNT connections is visited exactly
  // once, and the sibling connector's OTHER_COUNT connections never appear.
  const traversed = await traverseFiltered(asUrl, TARGET_CONNECTOR_ID, 100);
  assert.equal(traversed.length, TARGET_COUNT, "filtered traversal returns every connection of the target connector");
  assert.equal(new Set(traversed).size, traversed.length, "filtered keyset traversal has no duplicate winners");
  assert.ok(
    traversed.every((id) => id.includes(TARGET_CONNECTOR_ID.replaceAll("-", "_"))),
    "no sibling-connector identity leaks into the filtered traversal"
  );

  // Unfiltered traversal at the same limit must include both connectors'
  // connections — the filter narrows, it does not become the new default.
  const unfilteredFirstPage = await getFilteredPage(asUrl, "limit=100");
  const unfilteredConnectorIds = new Set((unfilteredFirstPage.data ?? []).map((item) => item.connector_id));
  assert.ok(
    unfilteredConnectorIds.has(TARGET_CONNECTOR_ID) || unfilteredConnectorIds.has(OTHER_CONNECTOR_ID),
    "the unfiltered page still spans the fleet, not just the previously filtered connector"
  );

  // Cursor scope binding: a cursor issued under one connector_id filter must
  // not resolve for a different (or absent) filter — see
  // `decodeConnectorSummaryPageCursor`'s filter-match check.
  const filteredCursor = first.next_cursor;
  assert.equal(typeof filteredCursor, "string", "a filtered page with more results carries a continuation");
  const crossFilterResponse = await fetch(
    `${asUrl}/_ref/connectors?connector_id=${OTHER_CONNECTOR_ID}&limit=1&cursor=${encodeURIComponent(String(filteredCursor))}`
  );
  assert.equal(crossFilterResponse.status, 400, "a filtered cursor must not resolve under a different connector_id");
  const unfilteredReplayResponse = await fetch(
    `${asUrl}/_ref/connectors?limit=1&cursor=${encodeURIComponent(String(filteredCursor))}`
  );
  assert.equal(unfilteredReplayResponse.status, 400, "a filtered cursor must not resolve for an unfiltered request");

  // `?connection=` (the exact 0-or-1 selector) takes exclusive precedence and
  // must reject connector_id as an ambiguous combination, exactly like it
  // already rejects limit/cursor.
  const oneTargetId = instanceId(TARGET_CONNECTOR_ID, 0);
  const ambiguousResponse = await fetch(
    `${asUrl}/_ref/connectors?connection=${oneTargetId}&connector_id=${TARGET_CONNECTOR_ID}`
  );
  assert.equal(ambiguousResponse.status, 400, "connection= and connector_id together must be rejected as ambiguous");

  // Concurrent mutation: revoking one target connection mid-traversal must
  // not duplicate or lose any OTHER identity in the same filtered page set.
  const mutate = async () => {
    const revokeId = instanceId(TARGET_CONNECTOR_ID, 1);
    if (isPostgresStorageBackend()) {
      await postgresQuery(
        "UPDATE connector_instances SET status = 'revoked', revoked_at = $2 WHERE connector_instance_id = $1",
        [revokeId, iso(TARGET_COUNT + 1)]
      );
      return;
    }
    getDb()
      .prepare("UPDATE connector_instances SET status = 'revoked', revoked_at = ? WHERE connector_instance_id = ?")
      .run(iso(TARGET_COUNT + 1), revokeId);
  };
  const concurrentFirst = await getFilteredPage(asUrl, `connector_id=${TARGET_CONNECTOR_ID}&limit=1`);
  const [concurrentSecond] = await Promise.all([
    getFilteredPage(
      asUrl,
      `connector_id=${TARGET_CONNECTOR_ID}&limit=100&cursor=${encodeURIComponent(String(concurrentFirst.next_cursor))}`
    ),
    mutate(),
  ]);
  const concurrentIds = [...pageIds(concurrentFirst), ...pageIds(concurrentSecond)];
  assert.equal(
    new Set(concurrentIds).size,
    concurrentIds.length,
    "a concurrent status mutation does not duplicate an identity within the filtered traversal"
  );
}

test("SQLite connector_id filter composes with limit/cursor, stays fixed-query-family, and preserves owner/connector isolation", async () => {
  await withMountedRoute(null, assertConnectorIdFilterParity);
});

if (POSTGRES_URL) {
  test("PostgreSQL connector_id filter composes with limit/cursor, stays fixed-query-family, and preserves owner/connector isolation", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_connector_filter_${process.pid}_${Date.now()}`,
      },
      async (url) => await withMountedRoute(url, assertConnectorIdFilterParity)
    );
  });
}
