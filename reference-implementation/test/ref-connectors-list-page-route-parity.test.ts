// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mounted-route proof for the bounded `/_ref/connectors?limit=...` feed.
 *
 * This deliberately does not replace the smaller operation/store tests.  Its
 * job is to keep the real HTTP composition honest on both durable backends:
 * identity paging, every per-page summary projection axis, the opaque cursor,
 * and concurrent inventory writes all meet at this route.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: test-only raw SQLite instrumentation.
import Database from "better-sqlite3";

import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const OWNER = "owner_local";
const CONNECTOR_ID = "route-page-proof";
const SECRET = "route-page-proof-secret-must-never-leak";
const PAGE_LIMIT = 100;
const LARGE_OWNER_COUNT = 1000;
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const CURSOR_PATTERN = /^rcs1\.[A-Za-z0-9_-]+$/;
const FIRST_ID_PATTERN = /cin_page_0000/;
const paginationModuleUrl = new URL("../operations/ref-connectors-list/pagination.ts", import.meta.url).href;

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "route page parity cursor key";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

interface PageItem {
  readonly connection_id?: string;
  readonly connector_id?: string;
  readonly connector_instance_id?: string;
  readonly streams?: readonly unknown[];
}

interface PageEnvelope {
  readonly data?: readonly PageItem[];
  readonly has_more?: boolean;
  readonly next_cursor?: string | null;
  readonly object?: string;
}

function instanceId(index: number): string {
  return `cin_page_${String(index).padStart(4, "0")}`;
}

function iso(index: number): string {
  return new Date(Date.UTC(2026, 6, 29, 12, 0, index)).toISOString();
}

function manifest(): Record<string, unknown> {
  return {
    capabilities: { public_listing: { listed: true, status: "test" } },
    connector_id: CONNECTOR_ID,
    display_name: "Mounted route page proof",
    protocol_version: "0.1.0",
    streams: [{ name: "messages", primary_key: ["id"] }],
    version: "1.0.0",
  };
}

async function closeServer(server: StartedServer | null): Promise<void> {
  if (!server) {
    return;
  }
  server.abortStartupBackfill("route page parity shutdown");
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

async function seedPageOwner(count: number): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      CONNECTOR_ID,
      JSON.stringify(manifest()),
      iso(0),
    ]);
    for (let index = 0; index < count; index += 1) {
      const id = instanceId(index);
      const createdAt = iso(index);
      // biome-ignore lint/performance/noAwaitInLoops: each record's fixture identity is paired with this connection.
      await postgresQuery(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, $2, $3, $4, 'active', 'account', $5, $6::jsonb, $7, $7, NULL)`,
        [id, OWNER, CONNECTOR_ID, `Page proof ${index}`, id, JSON.stringify({ secret: SECRET }), createdAt]
      );
      // A real record forces summary synthesis (including stream facts) rather
      // than proving a shortcut through an entirely empty page.
      await postgresQuery(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, 'messages', $3, '{}'::jsonb, $4, 1, false, $3)`,
        [CONNECTOR_ID, id, `record-${index}`, createdAt]
      );
    }
    return;
  }

  const db = getDb();
  db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    CONNECTOR_ID,
    JSON.stringify(manifest()),
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
      const id = instanceId(index);
      const createdAt = iso(index);
      insertInstance.run(
        id,
        OWNER,
        CONNECTOR_ID,
        `Page proof ${index}`,
        id,
        JSON.stringify({ secret: SECRET }),
        createdAt,
        createdAt
      );
      insertRecord.run(CONNECTOR_ID, id, `record-${index}`, createdAt, createdAt);
    }
  });
  insertAll();
}

async function getPage(asUrl: string, query: string): Promise<PageEnvelope> {
  const response = await fetch(`${asUrl}/_ref/connectors?${query}`);
  const body = (await response.json()) as PageEnvelope;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.object, "list");
  assert.ok(Array.isArray(body.data));
  return body;
}

async function countSqlitePrepareCalls<T>(
  fn: () => Promise<T>
): Promise<{ readonly calls: number; readonly result: T }> {
  let calls = 0;
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function patchedPrepare(this: Database.Database, ...args: Parameters<typeof original>) {
    calls += 1;
    return original.apply(this, args);
  } as typeof original;
  try {
    return { calls, result: await fn() };
  } finally {
    Database.prototype.prepare = original;
  }
}

async function countPostgresQueries<T>(fn: () => Promise<T>): Promise<{ readonly calls: number; readonly result: T }> {
  const pool = getPostgresPool();
  const original = pool.query.bind(pool);
  let calls = 0;
  pool.query = ((...args: Parameters<typeof original>) => {
    calls += 1;
    return original(...args);
  }) as typeof pool.query;
  try {
    return { calls, result: await fn() };
  } finally {
    pool.query = original as typeof pool.query;
  }
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

async function traverse(asUrl: string, limit: number): Promise<readonly string[]> {
  let cursor: string | null = null;
  const ids: string[] = [];
  do {
    // biome-ignore lint/performance/noAwaitInLoops: each request depends on its previous opaque continuation.
    const page = await getPage(asUrl, `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const current = pageIds(page);
    assert.ok(current.length <= limit, "a bounded page must never exceed its explicit limit");
    ids.push(...current);
    cursor = page.next_cursor ?? null;
    assert.equal(Boolean(cursor), page.has_more ?? false, "continuation and has_more must agree");
  } while (cursor);
  return ids;
}

async function decodeInFreshProcess(cursor: string): Promise<string> {
  const script = [
    `import { decodeConnectorSummaryPageCursor } from ${JSON.stringify(paginationModuleUrl)};`,
    "process.stdout.write(JSON.stringify(decodeConnectorSummaryPageCursor(process.argv[1], process.argv[2])));",
  ].join(" ");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, cursor, OWNER], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  return stdout;
}

async function assertMountedRouteParity(asUrl: string): Promise<void> {
  await seedPageOwner(LARGE_OWNER_COUNT);

  const measure = isPostgresStorageBackend() ? countPostgresQueries : countSqlitePrepareCalls;
  const one = await measure(() => getPage(asUrl, "limit=1"));
  const hundredMeasured = await measure(() => getPage(asUrl, "limit=100"));
  assert.ok(
    hundredMeasured.calls <= one.calls + 8,
    `page route SQL shape must be page-bounded (N=1:${one.calls}, N=100:${hundredMeasured.calls})`
  );
  const first = one.result;
  assert.equal(first.data?.length, 1, "N=1 result bound");
  assert.equal(first.has_more, true);
  const cursor = first.next_cursor;
  if (typeof cursor !== "string") {
    throw new Error("first bounded page must carry a continuation");
  }
  assert.match(cursor, CURSOR_PATTERN);
  const childDecoded = await decodeInFreshProcess(cursor);
  assert.match(
    childDecoded,
    FIRST_ID_PATTERN,
    "a separately loaded process can resume using the configured durable key"
  );

  const hundred = hundredMeasured.result;
  assert.equal(hundred.data?.length, PAGE_LIMIT, "N=100 result bound");
  assert.equal(hundred.has_more, true, "above-cap inventory advertises exactly one continuation");
  assert.equal(typeof hundred.next_cursor, "string", "above-cap response carries an opaque continuation");
  // The previous assertion intentionally cannot compare two encrypted cursor
  // values.  It does, however, prove a page's response fields, ordering and
  // continuation contract through actual traversal below.

  const ids = await traverse(asUrl, PAGE_LIMIT);
  assert.equal(
    ids.length,
    LARGE_OWNER_COUNT,
    "synthetic large-owner traversal returns every result across bounded pages"
  );
  assert.equal(new Set(ids).size, ids.length, "keyset traversal has no duplicate winners");
  assert.deepEqual(ids, [...ids].sort(), "identity page ordering is canonical and stable");
  assert.ok(!JSON.stringify({ first, hundred }).includes(SECRET), "page evidence must never select source secrets");
  assert.ok(
    (hundred.data ?? []).every((item) => (item.streams?.length ?? 0) > 0),
    "summary stream axis is synthesized"
  );

  // Race a next-page traversal with the three inventory mutations that used
  // to expose offset pagination.  We assert the only safe contract under a
  // concurrent snapshot change: no duplicate identity and no over-limit page.
  const mutate = async () => {
    if (isPostgresStorageBackend()) {
      await postgresQuery("UPDATE connector_instances SET display_name = 'updated' WHERE connector_instance_id = $1", [
        instanceId(1),
      ]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [instanceId(2)]);
      await postgresQuery(
        `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
         VALUES($1, $2, $3, 'created', 'active', 'account', $1, '{}'::jsonb, $4, $4, NULL)`,
        ["cin_page_zzzz", OWNER, CONNECTOR_ID, "2026-07-29T12:59:59.000Z"]
      );
      return;
    }
    const db = getDb();
    db.prepare("UPDATE connector_instances SET display_name = 'updated' WHERE connector_instance_id = ?").run(
      instanceId(1)
    );
    db.prepare("DELETE FROM connector_instances WHERE connector_instance_id = ?").run(instanceId(2));
    db.prepare(
      `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
       VALUES(?, ?, ?, 'created', 'active', 'account', ?, '{}', ?, ?, NULL)`
    ).run(
      "cin_page_zzzz",
      OWNER,
      CONNECTOR_ID,
      "cin_page_zzzz",
      "2026-07-29T12:59:59.000Z",
      "2026-07-29T12:59:59.000Z"
    );
  };
  const concurrentFirst = await getPage(asUrl, "limit=1");
  const [concurrentSecond] = await Promise.all([
    getPage(asUrl, `limit=100&cursor=${encodeURIComponent(String(concurrentFirst.next_cursor))}`),
    mutate(),
  ]);
  const concurrentIds = [...pageIds(concurrentFirst), ...pageIds(concurrentSecond)];
  assert.equal(
    new Set(concurrentIds).size,
    concurrentIds.length,
    "concurrent create/update/delete does not duplicate an identity"
  );
  assert.ok(pageIds(concurrentSecond).length <= PAGE_LIMIT);
}

test("SQLite mounted bounded connector-summary route covers N=1/N=100/above-cap, restart cursors, and concurrent traversal", async () => {
  await withMountedRoute(null, assertMountedRouteParity);
});

if (POSTGRES_URL) {
  test("PostgreSQL mounted bounded connector-summary route has identical durable page semantics", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_route_page_${process.pid}_${Date.now()}`,
      },
      async (url) => await withMountedRoute(url, assertMountedRouteParity)
    );
  });
}
