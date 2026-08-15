// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mounted-route proof for the BOUNDED, paginated `GET /_ref/connectors?limit=`
 * branch.
 *
 * Terminal-gate revision (2026-07-29): the independent gate rejected the
 * prior version of this proof for two reasons:
 *   1. It measured the now-DELETED unparameterized compat branch (no
 *      `limit`/`cursor`) — that branch no longer exists at all. A bare GET
 *      with no `limit` now fails closed with HTTP 400 `invalid_request`
 *      (see `ref-connectors-routes.test.ts`); there is no more "unscoped
 *      list" to page-bound.
 *   2. Its N=1 vs N=200 tolerance was too loose, and its "eventually
 *      converges to zero writes" framing assumed a read-triggered reconcile
 *      barrier that no longer exists. Every durable mutation
 *      (browser-enrollment-shell TTL retirement, due-attention expiry,
 *      connector-summary-evidence reconcile/repair) has been removed from
 *      the GET path entirely and now runs ONLY from
 *      `server/connector-maintenance-sweep.ts`'s periodic + startup sweep
 *      (see that module's own doc comment). An ordinary GET is now
 *      unconditionally read-only: the FIRST read after seeding performs
 *      zero writes, not just the Nth.
 *
 * This file re-targets the same generically useful SQLite/Postgres
 * statement-counting harnesses at the bounded `?limit=` route instead, and
 * proves, including an exact 50-to-200 fleet slope (and the larger historical
 * N=1-to-1000 guard):
 *   (a) executed-SQL-statement count for one bounded page stays ~constant
 *       between N=1 and N=1000 — a page-bounded implementation must not pay
 *       per-connection cost for connections outside the requested page;
 *   (b) a read against already-converged evidence performs ZERO writes,
 *       including the very FIRST read after seeding (there is no more
 *       reconcile-on-read to converge across repeated calls);
 *   (c) the same two proofs against real PostgreSQL when
 *       `PDPP_TEST_POSTGRES_URL` is set.
 *
 * It also adds a dedicated regression oracle for gate finding P0 #1: an
 * expired browser-enrollment shell must not be retired by a GET (zero
 * application writes on the first AND a subsequent read of an owner with one
 * expired shell) — retirement now happens exclusively via
 * `runConnectorMaintenanceSweep` / `retireExpiredBrowserEnrollmentShellsForMaintenance`.
 */

import assert from "node:assert/strict";
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
const CONNECTOR_ID = "unbounded-scale-proof";
const SHELL_CONNECTOR_ID = "unbounded-scale-proof-shell";
const SECRET = "unbounded-scale-proof-secret-must-never-leak";
const LARGE_OWNER_COUNT = 1000;
const PAGE_LIMIT = 100;
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const WRITE_STATEMENT_PATTERN = /^\s*(insert|update|delete)\b/i;

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "unbounded scale proof cursor key";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

interface ListEnvelope {
  readonly data?: readonly Record<string, unknown>[];
  readonly fleet_health?: unknown;
  readonly has_more?: boolean;
  readonly next_cursor?: string | null;
  readonly object?: string;
}

function instanceId(index: number): string {
  return `cin_unbounded_${String(index).padStart(4, "0")}`;
}

function iso(index: number): string {
  return new Date(Date.UTC(2026, 6, 29, 12, 0, index)).toISOString();
}

function manifest(connectorId: string): Record<string, unknown> {
  return {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: connectorId,
    display_name: "Unbounded scale proof",
    protocol_version: "0.1.0",
    streams: [{ name: "messages", primary_key: ["id"] }],
    version: "1.0.0",
  };
}

async function closeServer(server: StartedServer | null): Promise<void> {
  if (!server) {
    return;
  }
  server.abortStartupBackfill("unbounded scale proof shutdown");
  server.schedulerManager?.stop?.();
  server.stopBrowserSurfaceLeaseSweep();
  server.stopConnectorMaintenanceSweep();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
    server.controller.drainActiveRuns(5000),
    server.startupBackfillDone,
    server.startupRunHistoryBackfillDone,
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
    await server.startupRunHistoryBackfillDone.catch(() => undefined);
    await server.startupSummaryEvidenceSweepDone.catch(() => undefined);
    // This suite counts writes caused by its GET. The server's periodic
    // maintenance is independently responsible for shell retirement, so stop
    // it before seeding/measuring rather than allowing a concurrent tick to
    // be attributed to the read under test.
    server.stopConnectorMaintenanceSweep();
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

async function seedOwner(startIndex: number, count: number): Promise<void> {
  if (isPostgresStorageBackend()) {
    if (startIndex === 0) {
      await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
        CONNECTOR_ID,
        JSON.stringify(manifest(CONNECTOR_ID)),
        iso(0),
      ]);
    }
    for (let offset = 0; offset < count; offset += 1) {
      const index = startIndex + offset;
      const id = instanceId(index);
      const createdAt = iso(index);
      // biome-ignore lint/performance/noAwaitInLoops: each record's fixture identity is paired with this connection.
      await postgresQuery(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, $2, $3, $4, 'active', 'account', $5, $6::jsonb, $7, $7, NULL)`,
        [id, OWNER, CONNECTOR_ID, `Unbounded proof ${index}`, id, JSON.stringify({ secret: SECRET }), createdAt]
      );
      await postgresQuery(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, 'messages', $3, '{}'::jsonb, $4, 1, false, $3)`,
        [CONNECTOR_ID, id, `record-${index}`, createdAt]
      );
    }
    return;
  }

  const db = getDb();
  if (startIndex === 0) {
    db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
      CONNECTOR_ID,
      JSON.stringify(manifest(CONNECTOR_ID)),
      iso(0)
    );
  }
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
    for (let offset = 0; offset < count; offset += 1) {
      const index = startIndex + offset;
      const id = instanceId(index);
      const createdAt = iso(index);
      insertInstance.run(
        id,
        OWNER,
        CONNECTOR_ID,
        `Unbounded proof ${index}`,
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

async function seedExpiredBrowserEnrollmentShell(): Promise<void> {
  const shellId = "cin_unbounded_shell_expired";
  const createdAt = "2026-07-29T00:00:00.000Z";
  const expiredAt = "2026-07-29T01:00:00.000Z"; // Long past — TTL is 2h from creation in the real sweep, but this fixture's ttl is irrelevant: expired-ness is decided by comparing enrollment_expires_at to "now", which is in the past regardless of when the sweep runs.
  const binding = { enrollment_expires_at: expiredAt, kind: "browser_enrollment_shell" };
  if (isPostgresStorageBackend()) {
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      SHELL_CONNECTOR_ID,
      JSON.stringify(manifest(SHELL_CONNECTOR_ID)),
      createdAt,
    ]);
    await postgresQuery(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES($1, $2, $3, $4, 'draft', 'browser_collector', $1, $5::jsonb, $6, $6, NULL)`,
      [shellId, OWNER, SHELL_CONNECTOR_ID, "Unbounded proof expired shell", JSON.stringify(binding), createdAt]
    );
    return;
  }
  const db = getDb();
  db.prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    SHELL_CONNECTOR_ID,
    JSON.stringify(manifest(SHELL_CONNECTOR_ID)),
    createdAt
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES(?, ?, ?, ?, 'draft', 'browser_collector', ?, ?, ?, ?, NULL)`
  ).run(
    shellId,
    OWNER,
    SHELL_CONNECTOR_ID,
    "Unbounded proof expired shell",
    shellId,
    JSON.stringify(binding),
    createdAt,
    createdAt
  );
}

function shellStatus(): string {
  const db = getDb();
  const row = db
    .prepare("SELECT status FROM connector_instances WHERE connector_instance_id = ?")
    .get("cin_unbounded_shell_expired") as { status?: string } | undefined;
  assert.ok(row, "expired shell fixture row must exist");
  return row.status as string;
}

async function shellStatusPostgres(): Promise<string> {
  const result = await postgresQuery("SELECT status FROM connector_instances WHERE connector_instance_id = $1", [
    "cin_unbounded_shell_expired",
  ]);
  const row = result.rows[0] as { status?: string } | undefined;
  assert.ok(row, "expired shell fixture row must exist");
  return row.status as string;
}

async function getPage(asUrl: string, params: Readonly<Record<string, string>> = {}): Promise<ListEnvelope> {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT), ...params });
  const response = await fetch(`${asUrl}/_ref/connectors?${query.toString()}`);
  const body = (await response.json()) as ListEnvelope;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.object, "list");
  assert.ok(Array.isArray(body.data));
  return body;
}

/** Pages through the bounded route to completion, returning every row seen. */
async function getAllPages(asUrl: string): Promise<readonly Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pagination is inherently sequential — each page's cursor decides the next request.
    const page = await getPage(asUrl, cursor ? { cursor } : {});
    rows.push(...(page.data ?? []));
    if (!(page.has_more && page.next_cursor)) {
      return rows;
    }
    cursor = page.next_cursor;
  }
  throw new Error("getAllPages did not converge within 50 pages");
}

/**
 * `server/db.ts`'s `getDb()` wraps the raw better-sqlite3 handle in a Proxy
 * that CACHES prepared statements keyed by SQL text (`withCachedPrepare`) —
 * calling `.prepare(sameText)` twice returns the SAME `Statement` object and
 * does not re-invoke `Database.prototype.prepare` at all. Counting `.prepare`
 * calls therefore undercounts (it would show 0 repeat cost for the exact
 * per-connection fan-out this test exists to catch, since every connection's
 * query has identical SQL text and only differs by bound parameter). Instead,
 * patch `Statement.prototype.get/all/run/iterate` — the actual per-call
 * execution entry points — which fire every time regardless of statement
 * caching. `run` is better-sqlite3's write-statement entry point (INSERT/
 * UPDATE/DELETE never use `.get()`/`.all()`), so counting it alone gives a
 * genuine write-count proxy without needing Postgres-style stat views.
 */
function statementPrototype(): Record<string, (...args: unknown[]) => unknown> {
  return Database.prototype.prepare.call(new Database(":memory:"), "SELECT 1").constructor.prototype as Record<
    string,
    (...args: unknown[]) => unknown
  >;
}

async function countSqliteStatementCalls<T>(
  fn: () => Promise<T>,
  methods: readonly string[]
): Promise<{ readonly calls: number; readonly result: T }> {
  let calls = 0;
  const StatementPrototype = statementPrototype();
  const originals: [string, (...args: unknown[]) => unknown][] = methods.map((method) => {
    const original = StatementPrototype[method];
    if (typeof original !== "function") {
      throw new Error(`better-sqlite3 Statement.prototype.${method} is not a function`);
    }
    return [method, original];
  });
  for (const [method, original] of originals) {
    StatementPrototype[method] = function patched(this: unknown, ...args: unknown[]) {
      calls += 1;
      return original.apply(this, args);
    };
  }
  try {
    const result = await fn();
    return { calls, result };
  } finally {
    for (const [method, original] of originals) {
      StatementPrototype[method] = original;
    }
  }
}

function countSqliteCalls<T>(fn: () => Promise<T>): Promise<{ readonly executionCalls: number; readonly result: T }> {
  return countSqliteStatementCalls(fn, ["all", "get", "iterate", "run"]).then(({ calls, result }) => ({
    executionCalls: calls,
    result,
  }));
}

function countSqliteWrites<T>(fn: () => Promise<T>): Promise<{ readonly writeCalls: number; readonly result: T }> {
  return countSqliteStatementCalls(fn, ["run"]).then(({ calls, result }) => ({ result, writeCalls: calls }));
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
    const result = await fn();
    return { calls, result };
  } finally {
    pool.query = original as typeof pool.query;
  }
}

/**
 * Counts application-issued INSERT/UPDATE/DELETE statements by inspecting
 * SQL text on `pool.query` calls. `pg_stat_database`'s cumulative tuple
 * counters (the pattern `physical-footprint-helper.test.ts` uses against a
 * long-lived database) are too noisy for the disposable per-test database
 * this file creates: background autovacuum/statistics-collector activity on
 * a freshly created database moves those counters independently of this
 * test's own traffic. Counting write-shaped SQL text directly is exact
 * regardless of background database activity.
 */
async function countPostgresWrites<T>(
  fn: () => Promise<T>
): Promise<{ readonly writeCalls: number; readonly result: T }> {
  const pool = getPostgresPool();
  const original = pool.query.bind(pool);
  let writeCalls = 0;
  pool.query = ((...args: Parameters<typeof original>) => {
    const first = args[0] as unknown;
    const sql = typeof first === "string" ? first : ((first as { text?: string }).text ?? "");
    if (WRITE_STATEMENT_PATTERN.test(sql)) {
      writeCalls += 1;
    }
    return original(...args);
  }) as typeof pool.query;
  try {
    return { result: await fn(), writeCalls };
  } finally {
    pool.query = original as typeof pool.query;
  }
}

/**
 * Core proof, backend-agnostic: seed a SMALL owner, measure one bounded page
 * read, then grow to a LARGE owner and measure again — a page-bounded
 * implementation issues a near-identical statement count for both, since the
 * page size (not the fleet size) determines the read's shape. Every measured
 * read is also asserted to be write-free on its OWN first attempt: GET no
 * longer performs any reconcile-on-read, so there is no warm-up/convergence
 * step required before a read is write-free (unlike the retired unscoped
 * compat branch this file previously measured).
 */
async function assertBoundedListIsPageBoundedAndWriteFree(asUrl: string): Promise<void> {
  await seedOwner(0, 1);
  const completeWithHealth = await getPage(asUrl, { include_fleet_health: "1" });
  const fleetHealthResponse = await fetch(`${asUrl}/_ref/fleet-health`);
  assert.equal(fleetHealthResponse.status, 200);
  assert.deepEqual(
    completeWithHealth.fleet_health,
    await fleetHealthResponse.json(),
    "a terminal page's optional fleet health must use its exact inventory and summaries"
  );
  const connectorFilteredHealth = await getPage(asUrl, { connector_id: CONNECTOR_ID, include_fleet_health: "1" });
  assert.equal(
    "fleet_health" in connectorFilteredHealth,
    false,
    "a terminal connector-filtered page must omit fleet health"
  );
  const measureQueries = isPostgresStorageBackend()
    ? async (fn: () => Promise<ListEnvelope>) => {
        const { calls, result } = await countPostgresQueries(fn);
        return { calls, result };
      }
    : async (fn: () => Promise<ListEnvelope>) => {
        const { executionCalls, result } = await countSqliteCalls(fn);
        return { calls: executionCalls, result };
      };
  const measureWrites = isPostgresStorageBackend()
    ? (fn: () => Promise<ListEnvelope>) => countPostgresWrites(fn)
    : (fn: () => Promise<ListEnvelope>) => countSqliteWrites(fn);

  // N=1: first-ever read of a freshly seeded, never-before-observed
  // connection must ALREADY perform zero writes — there is no more
  // reconcile-on-read to converge, so there is nothing to warm up.
  const smallWrites = await measureWrites(() => getPage(asUrl));
  assert.equal(smallWrites.result.data?.length, 1, "N=1 bounded page returns exactly the one seeded connection");
  assert.equal(
    smallWrites.writeCalls,
    0,
    "N=1: the very first bounded-page read of a never-before-observed connection performs zero writes"
  );

  const small = await measureQueries(() => getPage(asUrl));
  assert.equal(small.result.data?.length, 1);

  // Exact regression requested for the connector/run hydration change: grow
  // an ordinary page from 50 to 200 identities and prove the SQL call family
  // does not turn into one correlation read per connector.
  await seedOwner(1, 49);
  const fifty = await measureQueries(() => getPage(asUrl));
  assert.equal(fifty.result.data?.length, 50);
  await seedOwner(50, 150);
  const twoHundred = await measureQueries(() => getPage(asUrl));
  assert.equal(twoHundred.result.data?.length, PAGE_LIMIT);
  const incompleteWithHealth = await getPage(asUrl, { include_fleet_health: "1" });
  assert.equal("fleet_health" in incompleteWithHealth, false, "an incomplete page must omit fleet health");
  assert.ok(incompleteWithHealth.next_cursor);
  const continuationWithHealth = await getPage(asUrl, {
    cursor: incompleteWithHealth.next_cursor,
    include_fleet_health: "1",
  });
  assert.equal("fleet_health" in continuationWithHealth, false, "a terminal continuation page must omit fleet health");
  assert.ok(
    twoHundred.calls <= fifty.calls + 12,
    `50-to-200 page SQL calls must stay bounded (N=50:${fifty.calls}, N=200:${twoHundred.calls})`
  );

  await seedOwner(200, LARGE_OWNER_COUNT - 200);

  // N=large: a fresh, never-before-observed batch of connections, read for
  // the first time. Same expectation: zero writes on the first read, and a
  // statement count that stays within a small additive slop of the N=1 page
  // read, not scaling with the ~1000x difference in fleet size (the page
  // itself is still capped at PAGE_LIMIT rows).
  const largeWrites = await measureWrites(() => getPage(asUrl));
  assert.equal(
    largeWrites.result.data?.length,
    PAGE_LIMIT,
    "a bounded page against a 1000-connection fleet still returns exactly one page's worth of rows"
  );
  assert.equal(
    largeWrites.writeCalls,
    0,
    "N=1000: the very first bounded-page read against a freshly seeded large fleet performs zero writes"
  );

  const large = await measureQueries(() => getPage(asUrl));
  assert.equal(large.result.data?.length, PAGE_LIMIT);
  assert.ok(
    large.calls <= small.calls * 4 + 40,
    `bounded-page SQL execution count must depend on page size, not fleet size (N=1 fleet:${small.calls}, N=1000 fleet:${large.calls})`
  );
  assert.ok(!JSON.stringify(large.result).includes(SECRET), "bounded page evidence must never select source secrets");

  // A converged instance's SECOND read of the same page must also be
  // write-free — reads are idempotent with respect to durable state, not
  // merely "eventually" write-free.
  const converged = await measureWrites(() => getPage(asUrl));
  assert.equal(converged.writeCalls, 0, "a repeated bounded-page read against the same fleet performs zero writes");

  // Page-follow to completion proves the full 1000-connection fleet is still
  // completely reachable through the bounded route — the gate's requirement
  // was removing the unbounded COMPAT branch, not fleet-wide reachability
  // itself.
  const allRows = await getAllPages(asUrl);
  assert.equal(allRows.length, LARGE_OWNER_COUNT, "paging to completion reaches every owner-visible connection");
}

/**
 * Gate finding P0 #1 regression oracle: an expired browser-enrollment shell
 * must never be retired (flipped to `revoked`) as a side effect of a GET.
 * Retirement is now exclusively the maintenance sweep's responsibility
 * (`retireExpiredBrowserEnrollmentShellsForMaintenance` /
 * `runConnectorMaintenanceSweep`, wired to run at startup and on its own
 * periodic timer — see `server/connector-maintenance-sweep.ts`). This proof
 * targets the SQLite backend only: shell status is asserted via a direct
 * `connector_instances` row read, which the harness already has a live
 * `getDb()` handle for; the Postgres proof above already covers cross-backend
 * write-freedom for the general case.
 */
async function assertExpiredShellSurvivesGetUnretired(asUrl: string): Promise<void> {
  await seedExpiredBrowserEnrollmentShell();
  assert.equal(shellStatus(), "draft", "fixture sanity: shell starts in draft, not yet retired");

  const first = await countSqliteWrites(() => getPage(asUrl));
  assert.equal(
    first.writeCalls,
    0,
    "the FIRST bounded-page read of an owner with one expired browser-enrollment shell performs zero writes"
  );
  assert.equal(
    shellStatus(),
    "draft",
    "an expired browser-enrollment shell is not retired by the first GET (gate finding P0 #1)"
  );

  const second = await countSqliteWrites(() => getPage(asUrl));
  assert.equal(second.writeCalls, 0, "a SUBSEQUENT bounded-page read also performs zero writes");
  assert.equal(
    shellStatus(),
    "draft",
    "an expired browser-enrollment shell stays un-retired across repeated GETs — only the maintenance sweep retires it"
  );
}

test("SQLite bounded /_ref/connectors?limit= page is page-bounded and write-free from the first read", async () => {
  await withMountedRoute(null, assertBoundedListIsPageBoundedAndWriteFree);
});

test("SQLite: an expired browser-enrollment shell survives repeated GETs unretired (gate finding P0 #1)", async () => {
  await withMountedRoute(null, assertExpiredShellSurvivesGetUnretired);
});

/**
 * Same proof as `assertExpiredShellSurvivesGetUnretired` above, against real
 * PostgreSQL — the second gate's re-review explicitly required this exact
 * expired-shell oracle on both backends, not just SQLite (the shared
 * production code path is not itself sufficient evidence of cross-backend
 * write-freedom, since `countPostgresWrites` inspects Postgres-specific
 * write-shaped SQL text, a genuinely different instrumentation path from
 * SQLite's `Statement.prototype` patching).
 */
async function assertExpiredShellSurvivesGetUnretiredPostgres(asUrl: string): Promise<void> {
  await seedExpiredBrowserEnrollmentShell();
  assert.equal(await shellStatusPostgres(), "draft", "fixture sanity: shell starts in draft, not yet retired");

  const first = await countPostgresWrites(() => getPage(asUrl));
  assert.equal(
    first.writeCalls,
    0,
    "the FIRST bounded-page read of an owner with one expired browser-enrollment shell performs zero writes"
  );
  assert.equal(
    await shellStatusPostgres(),
    "draft",
    "an expired browser-enrollment shell is not retired by the first GET (gate finding P0 #1)"
  );

  const second = await countPostgresWrites(() => getPage(asUrl));
  assert.equal(second.writeCalls, 0, "a SUBSEQUENT bounded-page read also performs zero writes");
  assert.equal(
    await shellStatusPostgres(),
    "draft",
    "an expired browser-enrollment shell stays un-retired across repeated GETs — only the maintenance sweep retires it"
  );
}

if (POSTGRES_URL) {
  test("PostgreSQL bounded /_ref/connectors?limit= page is page-bounded and write-free from the first read", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_bounded_scale_${process.pid}_${Date.now()}`,
      },
      async (url) => await withMountedRoute(url, assertBoundedListIsPageBoundedAndWriteFree)
    );
  });

  test("PostgreSQL: an expired browser-enrollment shell survives repeated GETs unretired (gate finding P0 #1)", async () => {
    assert.ok(POSTGRES_URL, "PDPP_TEST_POSTGRES_URL must target the disposable PostgreSQL proof service");
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_expired_shell_pg_${process.pid}_${Date.now()}`,
      },
      async (url) => await withMountedRoute(url, assertExpiredShellSurvivesGetUnretiredPostgres)
    );
  });
}
