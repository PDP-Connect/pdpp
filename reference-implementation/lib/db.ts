/**
 * Bounded-statement wrapper for the reference RS database.
 *
 * New migrated database reads in the reference implementation should flow
 * through one of the primitives exported here. A staged-file lefthook gate
 * prevents newly-introduced direct `db.prepare(...)` calls outside this module,
 * `server/db.js` (the engine itself), and `server/queries/index.ts` (registry
 * validation). Some older/read-specialized call sites remain grandfathered and
 * are tracked by the OpenSpec change.
 *
 * Spec: openspec/changes/bound-spine-and-record-read-paths/specs/
 *       reference-implementation-architecture/spec.md
 *       Requirement: "Reference SQL wrapper SHALL make bounded reads explicit"
 *
 * The five primitives:
 *
 *   getOne(query, params)
 *     Single-row read. Returns the row or null. SQL is a `terminator: 'one'`
 *     query.
 *
 *   getMany(query, params, { limit, cursor })
 *     Bounded multi-row read. Caller supplies `limit > 0`. Wrapper binds
 *     `LIMIT (limit + 1)` to detect overflow. Returns
 *     `{ rows, truncated, nextCursor }`. SQL is a `terminator: 'many'`
 *     query that contains a trailing `LIMIT ?` placeholder.
 *
 *   iterate(query, params)
 *     Streaming generator. Caller iterates and breaks. The wrapper does
 *     NOT impose a cap; the caller is expected to break at a bounded
 *     point. Use this for record-page assembly that filters rows in JS
 *     and stops at an authorization-narrowed page boundary.
 *
 *   exec(query, params)
 *     INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/REPLACE. Returns
 *     `{ changes, lastInsertRowid }`.
 *
 *   execNamedOn(db, query, params)
 *     Same mutation semantics as `exec`, but binds a named-parameter object
 *     against an explicit database handle. This exists for append paths that
 *     already accept a transaction handle and whose SQL artifact uses
 *     `@named` placeholders.
 *
 *   execReturningOne(query, params)
 *     Mutation that returns exactly one row via SQL `RETURNING`. SQL is a
 *     `terminator: 'exec_one'` query — a mutation statement (INSERT /
 *     UPDATE / DELETE / REPLACE / CREATE / ALTER / DROP) that includes a
 *     `RETURNING <cols>` clause. Used for atomic operations whose
 *     post-mutation result must be observed in the same statement that
 *     wrote it (e.g. `INSERT … ON CONFLICT … DO UPDATE … RETURNING`
 *     allocators). Distinct from both `exec` (mutation, no row) and
 *     `getOne` (pure read) so the SQL semantics are pinned at the call
 *     site.
 *
 *   allowUnboundedReadAcknowledged(query, params)
 *     Whole-table scan of a small enumeration table. The caller MUST be
 *     a `terminator: 'many'` query annotated `@bounded_by:
 *     small_enumeration_table` with a declared `@max_rows`. The wrapper
 *     checks that the row count does not exceed the declared bound and
 *     throws if it does.
 *
 *   transaction(fn)
 *     Better-sqlite3 transaction wrapper, unchanged.
 */

import { getDb } from "../server/db.js";
import type {
  IterateQuery,
  MutationQuery,
  MutationReturningOneQuery,
  ReadManyQuery,
  ReadOneQuery,
  SmallEnumerationQuery,
} from "../server/queries/index.ts";

// Re-export the registry handle types and the frozen registry instance
// so call sites can import everything they need from `lib/db.ts`. Not a
// barrel file in the perf-concerning sense — `db.ts` owns substantive
// exports (primitives, errors, cursor utilities) and these re-exports
// pin the wrapper's public surface to one module.
export type {
  IterateQuery,
  MutationQuery,
  MutationReturningOneQuery,
  ReadManyQuery,
  ReadOneQuery,
  RegisteredQuery,
  SmallEnumerationQuery,
} from "../server/queries/index.ts";
// biome-ignore lint/performance/noBarrelFile: see above.
export { referenceQueries } from "../server/queries/index.ts";

// ---------------------------------------------------------------------------
// Parameter and result types
// ---------------------------------------------------------------------------

/**
 * Bind parameters for a prepared statement. Better-sqlite3 accepts these
 * primitives plus `Buffer` for BLOB columns.
 */
export type BindValue = string | number | bigint | null | Uint8Array;
export type BindParams = readonly BindValue[];

export interface ExecResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface PageOptions {
  /** Opaque cursor returned from a prior page, or null/undefined for the first page. */
  readonly cursor?: string | null;
  /** Maximum rows the caller wants in this page. SHALL be > 0 and ≤ MAX_PAGE_LIMIT. */
  readonly limit: number;
}

export interface Page<R> {
  readonly nextCursor: string | null;
  readonly rows: readonly R[];
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Cursor encoding
// ---------------------------------------------------------------------------

/** Cursors are opaque to callers; format may change without contract impact. */
const CURSOR_VERSION = 1;

interface CursorPayload {
  /** The cursor field's last-row value. JSON-safe types only. */
  readonly k: string | number | null;
  /** Tiebreaker (rowid) so cursoring is stable under concurrent inserts. */
  readonly r: number;
  readonly v: number;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new InvalidCursorError("Cursor is not base64url-encoded.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidCursorError("Cursor payload is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || !("v" in parsed) || !("k" in parsed) || !("r" in parsed)) {
    throw new InvalidCursorError("Cursor payload is missing required fields.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== CURSOR_VERSION) {
    throw new InvalidCursorError(`Cursor version ${String(obj.v)} is not supported.`);
  }
  const k = obj.k;
  if (k !== null && typeof k !== "string" && typeof k !== "number") {
    throw new InvalidCursorError("Cursor key field has unsupported type.");
  }
  if (typeof obj.r !== "number" || !Number.isInteger(obj.r)) {
    throw new InvalidCursorError("Cursor tiebreaker is not an integer.");
  }
  return { v: CURSOR_VERSION, k, r: obj.r };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidCursorError extends Error {
  override readonly name = "InvalidCursorError";
}

export class UnboundedReadError extends Error {
  override readonly name = "UnboundedReadError";
}

export class SmallEnumerationOverflowError extends Error {
  override readonly name = "SmallEnumerationOverflowError";
  readonly query: SmallEnumerationQuery;
  readonly observedRows: number;
  constructor(query: SmallEnumerationQuery, observedRows: number) {
    super(
      `Query ${query.key} (${query.file}) returned ${observedRows} rows, exceeding declared @max_rows=${query.maxRows} for table "${query.table}". This indicates the small-enumeration assumption no longer holds; revisit the @bounded_by annotation or migrate the call site to db.getMany with a real limit.`
    );
    this.query = query;
    this.observedRows = observedRows;
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Hard upper bound on a single page; callers cannot request more. */
export const MAX_PAGE_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Primitive: getOne
// ---------------------------------------------------------------------------

/**
 * Single-row read. The query SHALL be a `terminator: 'one'` artifact.
 * Returns the hydrated row or null if no row matched.
 */
export function getOne<R>(query: ReadOneQuery, params: BindParams = []): R | null {
  const db = requireDb();
  const stmt = db.prepare(query.sql);
  const row = stmt.get(...params);
  return (row ?? null) as R | null;
}

// ---------------------------------------------------------------------------
// Primitive: getMany
// ---------------------------------------------------------------------------

/**
 * Bounded multi-row read. The query SHALL be a `terminator: 'many'`
 * artifact whose SQL ends with a `LIMIT ?` placeholder. The wrapper
 * binds `LIMIT (limit + 1)`; if `limit + 1` rows are returned, the page
 * is `truncated` and the last row is dropped from `rows` and used to
 * derive `nextCursor`.
 *
 * The caller is responsible for ordering: the SQL SHALL include
 * `ORDER BY <cursorField>, rowid` (or equivalent stable tiebreaker) so
 * cursoring is deterministic under concurrent inserts. The wrapper
 * does not inject `ORDER BY`; the artifact is the source of truth.
 */
export function getMany<R extends Record<string, unknown>>(
  query: ReadManyQuery,
  params: BindParams,
  opts: PageOptions
): Page<R> {
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    throw new UnboundedReadError(`getMany requires limit > 0 (got ${String(opts.limit)}) for query ${query.key}.`);
  }
  if (opts.limit > MAX_PAGE_LIMIT) {
    throw new UnboundedReadError(
      `getMany limit ${opts.limit} exceeds MAX_PAGE_LIMIT=${MAX_PAGE_LIMIT} for query ${query.key}.`
    );
  }

  const db = requireDb();
  const stmt = db.prepare(query.sql);
  const fetchLimit = opts.limit + 1;
  // Cursor handling lives in the SQL artifact, not the wrapper: each
  // many-query that paginates declares its cursor field and embeds the
  // `WHERE (cursor_field, rowid) > (?, ?)` predicate in its SQL. The
  // wrapper passes the decoded cursor values through `params`. Callers
  // that decode/encode cursors do so via decodeCursor()/encodeCursor()
  // exported below.
  const allRows = stmt.all(...params, fetchLimit) as R[];
  const truncated = allRows.length === fetchLimit;
  const rows = truncated ? allRows.slice(0, opts.limit) : allRows;
  const nextCursor = truncated ? buildNextCursor(query, rows) : null;
  return { rows, truncated, nextCursor };
}

function buildNextCursor<R extends Record<string, unknown>>(query: ReadManyQuery, rows: readonly R[]): string | null {
  const last = rows.at(-1);
  if (!last) {
    return null;
  }
  const k = last[query.cursorField];
  const rowid = last.rowid ?? last.id;
  if (rowid === undefined || rowid === null) {
    // The artifact promised a cursor field but no rowid/id column was
    // selected. This is a query-authoring bug, not a runtime concern;
    // surface it loudly so the next test run catches it.
    throw new Error(
      `[db] Cannot build next cursor for ${query.key}: row is missing 'rowid' or 'id'. Add it to the SELECT list.`
    );
  }
  if (typeof rowid !== "number" || !Number.isInteger(rowid)) {
    throw new Error(`[db] Cannot build next cursor for ${query.key}: rowid is not an integer.`);
  }
  if (k !== null && typeof k !== "string" && typeof k !== "number") {
    throw new Error(
      `[db] Cannot build next cursor for ${query.key}: cursor field "${query.cursorField}" is not string|number|null.`
    );
  }
  return encodeCursor({ v: CURSOR_VERSION, k: k ?? null, r: rowid });
}

// ---------------------------------------------------------------------------
// Primitive: iterate
// ---------------------------------------------------------------------------

/**
 * Streaming row iterator. The caller MUST break out of the generator at
 * a bounded point; the wrapper does not impose a cap. Use this for
 * record-page assembly that filters in JS and stops at an
 * authorization-narrowed page boundary.
 *
 * Yields rows as the driver streams them.
 */
export function* iterate<R>(query: IterateQuery, params: BindParams = []): Generator<R, void, unknown> {
  const db = requireDb();
  const stmt = db.prepare(query.sql);
  for (const row of stmt.iterate(...params) as IterableIterator<R>) {
    yield row;
  }
}

// ---------------------------------------------------------------------------
// Primitive: exec
// ---------------------------------------------------------------------------

/**
 * Execute a mutation. Returns the standard better-sqlite3
 * `{ changes, lastInsertRowid }` shape.
 */
export function exec(query: MutationQuery, params: BindParams = []): ExecResult {
  const db = requireDb();
  const stmt = db.prepare(query.sql);
  const result = stmt.run(...params);
  return {
    changes: result.changes,
    lastInsertRowid: result.lastInsertRowid,
  };
}

function normalizeExecResult(result: unknown): ExecResult {
  const row = result && typeof result === "object" ? (result as Partial<ExecResult>) : {};
  return {
    changes: typeof row.changes === "number" ? row.changes : 0,
    lastInsertRowid:
      typeof row.lastInsertRowid === "number" || typeof row.lastInsertRowid === "bigint" ? row.lastInsertRowid : 0,
  };
}

/**
 * Execute a named-parameter mutation against a specific DB handle. Keep this
 * narrow: most code should use positional `exec`; this helper preserves
 * transaction-handle call sites whose static SQL is clearer with `@name`
 * placeholders.
 */
export function execNamedOn(
  db: {
    prepare(sql: string): {
      run(params: object): unknown;
    };
  },
  query: MutationQuery,
  params: object
): ExecResult {
  const stmt = db.prepare(query.sql);
  return normalizeExecResult(stmt.run(params));
}

// ---------------------------------------------------------------------------
// Primitive: execReturningOne
// ---------------------------------------------------------------------------

/**
 * Execute a mutation that returns exactly one row via SQL `RETURNING`.
 * The query SHALL be a `terminator: 'exec_one'` artifact whose SQL begins
 * with a mutation keyword (INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/
 * DROP) and contains a `RETURNING` clause; the loader enforces that.
 *
 * Use this for atomic operations whose result must be observed in the
 * same statement that wrote it — e.g. `INSERT … ON CONFLICT … DO UPDATE
 * … RETURNING` allocators. The wrapper deliberately uses a different
 * primitive from `exec` and `getOne` so the registry does not have to
 * lie about whether a query is a mutation or a read.
 *
 * Throws if the statement returns zero rows; SQL with `RETURNING` on a
 * single-target row is expected to return exactly one row.
 */
export function execReturningOne<R>(query: MutationReturningOneQuery, params: BindParams = []): R {
  const db = requireDb();
  const stmt = db.prepare(query.sql);
  // better-sqlite3 lets a `RETURNING` statement be driven via `.get(...)`;
  // it runs the mutation and returns the first row.
  const row = stmt.get(...params) as R | undefined;
  if (row === undefined) {
    throw new Error(
      `[db] execReturningOne(${query.key}) returned no rows; RETURNING statements must produce exactly one row.`
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Primitive: allowUnboundedReadAcknowledged
// ---------------------------------------------------------------------------

/**
 * Whole-table scan of a small enumeration table. The query SHALL be
 * annotated `@bounded_by: small_enumeration_table` with `@table` and
 * `@max_rows`. The wrapper asserts that the observed row count does
 * not exceed the declared maximum and throws otherwise.
 *
 * The deliberately loud function name is the review trigger. The current
 * lefthook gate does not enforce comment adjacency.
 */
export function allowUnboundedReadAcknowledged<R>(query: SmallEnumerationQuery, params: BindParams = []): readonly R[] {
  const db = requireDb();
  const stmt = db.prepare(query.sql);
  const rows = stmt.all(...params) as R[];
  if (rows.length > query.maxRows) {
    throw new SmallEnumerationOverflowError(query, rows.length);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Primitive: iterateDynamicSqlAcknowledged
// ---------------------------------------------------------------------------

/**
 * Dynamic-SQL escape hatch. The handful of read paths in the reference
 * (e.g. `fetchVisibleRecordRowsPaginated`, the search candidate
 * builders) compose SQL at call time because their WHERE clauses vary
 * with the caller's grant and request filters. Those queries cannot
 * live as static `.sql` artifacts because the registry validates each
 * artifact with `db.prepare(sql)` at boot, and a fixed SQL string
 * cannot express "include this WHERE clause only when a time_range is
 * present."
 *
 * This primitive is the only legitimate way to execute a dynamically-
 * built SQL string against the reference database. Every call site
 * SHALL:
 *
 *   - Build the SQL string from a fixed set of fragments (no user
 *     input concatenation; placeholders only for values).
 *   - Prefer a SQL `LIMIT ?` clause so the read is bounded whenever the
 *     dynamic path can page in SQL.
 *   - Prefer an adjacent `// REVIEWED-DYNAMIC: <reason>` comment explaining
 *     why static SQL does not fit. The current lefthook gate does not enforce
 *     comment adjacency or LIMIT presence.
 *
 * Returns a streaming iterator. The caller is responsible for breaking
 * out at a bounded point — typically once `LIMIT ?` rows have been
 * collected and request-side JS filters applied.
 */
export function* iterateDynamicSqlAcknowledged<R>(sql: string, params: BindParams = []): Generator<R, void, unknown> {
  const db = requireDb();
  const stmt = db.prepare(sql);
  for (const row of stmt.iterate(...params) as IterableIterator<R>) {
    yield row;
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Better-sqlite3 transaction wrapper. The provided function runs inside
 * BEGIN/COMMIT; if it throws, the transaction is rolled back and the
 * error propagates. Synchronous (matches better-sqlite3's idiom).
 */
export function transaction<T>(fn: () => T): T {
  const db = requireDb();
  return db.transaction(fn)();
}

/**
 * Like `transaction`, but opens with `BEGIN IMMEDIATE` so the SQLite
 * write lock is acquired at transaction start instead of being upgraded
 * on the first write inside the body. Use this for any mutation unit
 * that reads state and then writes based on that state — e.g. record
 * ingest's `(connector_id, stream)` version allocation — so concurrent
 * writers serialize on the read, not on the first write. Synchronous.
 *
 * Spec: openspec/changes/harden-record-ingest-atomicity/design.md
 */
export function writeTransaction<T>(fn: () => T): T {
  const db = requireDb();
  return db.transaction(fn).immediate();
}

// ---------------------------------------------------------------------------
// Cursor utilities (exported for handlers that decode caller-provided cursors)
// ---------------------------------------------------------------------------

export { decodeCursor, encodeCursor };

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface DbHandle {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown;
    iterate(...params: unknown[]): IterableIterator<unknown>;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  transaction<T>(fn: () => T): {
    (): T;
    immediate(): T;
    deferred(): T;
    exclusive(): T;
  };
}

function requireDb(): DbHandle {
  const db = getDb() as DbHandle | undefined;
  if (!db) {
    throw new Error("[db] No database is open. Call initDb() before using the wrapper.");
  }
  return db;
}
