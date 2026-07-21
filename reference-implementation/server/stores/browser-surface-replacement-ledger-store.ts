import { type BindValue, execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from "../../lib/db.ts";
import {
  type ReplacementReceipt,
  ReplacementReplayConflictError,
  selectCurrentReplacementReceipt,
} from "../../runtime/browser-surface/replacement-receipt-ledger.ts";
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from "../postgres-storage.js";

export interface BrowserSurfaceReplacementReceiptStore {
  append(receipt: ReplacementReceipt): Promise<ReplacementReceipt>;
  findPendingForScope(input: {
    readonly connection_id: string;
    readonly surface_subject_id: string | null;
    readonly profile_key: string;
    readonly preferred_surface_id?: string;
  }): Promise<ReplacementReceipt | null>;
  findPendingForSurface(surfaceId: string): Promise<ReplacementReceipt | null>;
  list(): Promise<readonly ReplacementReceipt[]>;
  listForScope(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
  }): Promise<readonly ReplacementReceipt[]>;
  selectCurrent(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
    readonly current_generation_hash?: string;
  }): Promise<ReplacementReceipt | null>;
}

interface ReplacementReceiptRow {
  cause: ReplacementReceipt["cause"];
  connection_id: string;
  connector_id: string | null;
  event_seq: number | string;
  idempotency_key: string;
  lease_id: string | null;
  next_generation_hash: string | null;
  observed_at: string;
  phase: ReplacementReceipt["phase"];
  previous_generation_hash: string | null;
  profile_key: string;
  replacement_id: string;
  run_id: string | null;
  scope: string;
  surface_id: string | null;
  surface_subject_id: string | null;
  terminal_outcome: ReplacementReceipt["terminal_outcome"] | null;
}

export const SQLITE_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS browser_surface_replacement_receipts (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  replacement_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  run_id TEXT,
  lease_id TEXT,
  surface_id TEXT,
  previous_generation_hash TEXT,
  next_generation_hash TEXT,
  cause TEXT NOT NULL CHECK (cause IN (
    'capacity_pressure',
    'idle_ttl',
    'operator_requested',
    'restart_reconcile',
    'readiness_invalidated',
    'allocator_internal_ensure_surface',
    'same_container_browser_generation_change',
    'external_or_host_loss'
  )),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'completed', 'terminal')),
  terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('failed', 'abandoned')),
  observed_at TEXT NOT NULL,
  UNIQUE (idempotency_key, phase),
  UNIQUE (replacement_id, phase),
  CHECK ((phase = 'terminal') = (terminal_outcome IS NOT NULL)),
  CHECK (phase != 'completed' OR next_generation_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_browser_surface_replacement_scope_order
  ON browser_surface_replacement_receipts(connection_id, surface_subject_id, event_seq, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_browser_surface_replacement_surface_order
  ON browser_surface_replacement_receipts(surface_id, event_seq, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_surface_replacement_one_resolution
  ON browser_surface_replacement_receipts(replacement_id)
  WHERE phase IN ('completed', 'terminal');
`;

export const POSTGRES_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS browser_surface_replacement_receipts (
  event_seq BIGSERIAL PRIMARY KEY,
  replacement_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  run_id TEXT,
  lease_id TEXT,
  surface_id TEXT,
  previous_generation_hash TEXT,
  next_generation_hash TEXT,
  cause TEXT NOT NULL CHECK (cause IN (
    'capacity_pressure',
    'idle_ttl',
    'operator_requested',
    'restart_reconcile',
    'readiness_invalidated',
    'allocator_internal_ensure_surface',
    'same_container_browser_generation_change',
    'external_or_host_loss'
  )),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'completed', 'terminal')),
  terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('failed', 'abandoned')),
  observed_at TEXT NOT NULL,
  UNIQUE (idempotency_key, phase),
  UNIQUE (replacement_id, phase),
  CHECK ((phase = 'terminal') = (terminal_outcome IS NOT NULL)),
  CHECK (phase != 'completed' OR next_generation_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_scope_order
  ON browser_surface_replacement_receipts(connection_id, surface_subject_id, event_seq, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_surface_order
  ON browser_surface_replacement_receipts(surface_id, event_seq, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_one_resolution
  ON browser_surface_replacement_receipts(replacement_id)
  WHERE phase IN ('completed', 'terminal');
`;

function mapRow(row: ReplacementReceiptRow): ReplacementReceipt {
  const receipt = {
    event_seq: Number(row.event_seq),
    replacement_id: row.replacement_id,
    idempotency_key: row.idempotency_key,
    scope: row.scope,
    connection_id: row.connection_id,
    profile_key: row.profile_key,
    cause: row.cause,
    phase: row.phase,
    observed_at: row.observed_at,
  } as ReplacementReceipt;
  setOptionalRowValue(receipt, "connector_id", row.connector_id);
  setOptionalRowValue(receipt, "surface_subject_id", row.surface_subject_id);
  setOptionalRowValue(receipt, "run_id", row.run_id);
  setOptionalRowValue(receipt, "lease_id", row.lease_id);
  setOptionalRowValue(receipt, "surface_id", row.surface_id);
  setOptionalRowValue(receipt, "previous_generation_hash", row.previous_generation_hash);
  setOptionalRowValue(receipt, "next_generation_hash", row.next_generation_hash);
  setOptionalRowValue(receipt, "terminal_outcome", row.terminal_outcome);
  return receipt;
}

function assertSameEvent(existing: ReplacementReceipt, incoming: ReplacementReceipt): void {
  const immutableFields: readonly (keyof ReplacementReceipt)[] = [
    "replacement_id",
    "idempotency_key",
    "scope",
    "connection_id",
    "connector_id",
    "profile_key",
    "surface_subject_id",
    "run_id",
    "lease_id",
    "surface_id",
    "previous_generation_hash",
    "next_generation_hash",
    "cause",
    "phase",
    "terminal_outcome",
  ];
  for (const field of immutableFields) {
    assertSameEventField(existing, incoming, field);
  }
}

function assertSameEventField(
  existing: ReplacementReceipt,
  incoming: ReplacementReceipt,
  field: keyof ReplacementReceipt
): void {
  if (existing[field] !== incoming[field]) {
    throw new ReplacementReplayConflictError(`replacement replay changed immutable field ${field}`);
  }
}

function params(receipt: ReplacementReceipt): readonly (string | number | null)[] {
  return [
    receipt.replacement_id,
    receipt.idempotency_key,
    receipt.scope,
    receipt.connection_id,
    nullable(receipt.connector_id),
    receipt.profile_key,
    nullable(receipt.surface_subject_id),
    nullable(receipt.run_id),
    nullable(receipt.lease_id),
    nullable(receipt.surface_id),
    nullable(receipt.previous_generation_hash),
    nullable(receipt.next_generation_hash),
    receipt.cause,
    receipt.phase,
    nullable(receipt.terminal_outcome),
    receipt.observed_at,
  ];
}

function nullable(value: string | undefined): string | null {
  return value ?? null;
}

function setOptionalRowValue(
  target: ReplacementReceipt,
  field: keyof ReplacementReceipt,
  value: string | null | undefined
): void {
  if (value !== null && value !== undefined) {
    (target as unknown as Record<string, unknown>)[field] = value;
  }
}

class SqliteBrowserSurfaceReplacementReceiptStore implements BrowserSurfaceReplacementReceiptStore {
  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async append(receipt: ReplacementReceipt): Promise<ReplacementReceipt> {
    const existing = dbRows(
      `SELECT * FROM browser_surface_replacement_receipts
       WHERE (idempotency_key = ? AND phase = ?) OR (replacement_id = ? AND phase = ?)
       ORDER BY event_seq`,
      [receipt.idempotency_key, receipt.phase, receipt.replacement_id, receipt.phase]
    );
    for (const row of existing) {
      const mapped = mapRow(row);
      assertSameEvent(mapped, receipt);
      return mapped;
    }
    const prior = dbRow(
      `SELECT * FROM browser_surface_replacement_receipts
       WHERE replacement_id = ? ORDER BY event_seq DESC LIMIT 1`,
      [receipt.replacement_id]
    );
    if (prior) {
      assertSameEventIdentity(mapRow(prior), receipt);
      assertNoOppositeResolution(mapRow(prior), receipt);
    }
    // REVIEWED-DYNAMIC: this append SQL is fixed but the receipt table is a runtime ledger object.
    execDynamicSqlAcknowledged(
      `INSERT INTO browser_surface_replacement_receipts(
        replacement_id, idempotency_key, scope, connection_id, connector_id, profile_key,
        surface_subject_id, run_id, lease_id, surface_id, previous_generation_hash,
        next_generation_hash, cause, phase, terminal_outcome, observed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`,
      params(receipt) as BindValue[]
    );
    const inserted = dbRow(
      `SELECT * FROM browser_surface_replacement_receipts
       WHERE (idempotency_key = ? AND phase = ?)
          OR (replacement_id = ? AND phase IN ('completed', 'terminal'))
       ORDER BY event_seq LIMIT 1`,
      [receipt.idempotency_key, receipt.phase, receipt.replacement_id]
    );
    if (!inserted) {
      throw new Error(`replacement receipt insert ${receipt.replacement_id}/${receipt.phase} was not readable`);
    }
    const authoritative = mapRow(inserted);
    assertSameEvent(authoritative, receipt);
    return authoritative;
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async findPendingForSurface(surfaceId: string): Promise<ReplacementReceipt | null> {
    const row = dbRow(
      `SELECT started.* FROM browser_surface_replacement_receipts AS started
       WHERE started.surface_id = ? AND started.phase = 'started'
         AND NOT EXISTS (
           SELECT 1 FROM browser_surface_replacement_receipts AS resolved
           WHERE resolved.replacement_id = started.replacement_id
             AND resolved.phase IN ('completed', 'terminal')
         )
       ORDER BY started.event_seq DESC LIMIT 1`,
      [surfaceId]
    );
    return row ? mapRow(row) : null;
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async findPendingForScope(input: {
    readonly connection_id: string;
    readonly surface_subject_id: string | null;
    readonly profile_key: string;
    readonly preferred_surface_id?: string;
  }): Promise<ReplacementReceipt | null> {
    const row = dbRow(
      `SELECT started.* FROM browser_surface_replacement_receipts AS started
       WHERE started.connection_id = ?
         AND started.surface_subject_id IS ?
         AND started.profile_key = ?
         AND started.phase = 'started'
         AND NOT EXISTS (
           SELECT 1 FROM browser_surface_replacement_receipts AS resolved
           WHERE resolved.replacement_id = started.replacement_id
             AND resolved.phase IN ('completed', 'terminal')
         )
       ORDER BY CASE WHEN started.surface_id = ? THEN 0 ELSE 1 END,
                started.event_seq DESC, started.idempotency_key DESC
       LIMIT 1`,
      [input.connection_id, input.surface_subject_id, input.profile_key, input.preferred_surface_id ?? null]
    );
    return row ? mapRow(row) : null;
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async list(): Promise<readonly ReplacementReceipt[]> {
    return dbRows("SELECT * FROM browser_surface_replacement_receipts ORDER BY event_seq, idempotency_key").map(mapRow);
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async listForScope(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
  }): Promise<readonly ReplacementReceipt[]> {
    const rows =
      input.surface_subject_id === undefined
        ? dbRows(
            `SELECT * FROM browser_surface_replacement_receipts
           WHERE connection_id = ? ORDER BY event_seq, idempotency_key`,
            [input.connection_id]
          )
        : dbRows(
            `SELECT * FROM browser_surface_replacement_receipts
           WHERE connection_id = ? AND surface_subject_id = ? ORDER BY event_seq, idempotency_key`,
            [input.connection_id, input.surface_subject_id]
          );
    return rows.map(mapRow);
  }

  async selectCurrent(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
    readonly current_generation_hash?: string;
  }): Promise<ReplacementReceipt | null> {
    const rows = await this.listForScope(input);
    if (input.surface_subject_id === undefined) {
      const scopes = new Set(rows.map((row) => row.scope));
      if (scopes.size > 1) {
        return null;
      }
    }
    return selectCurrentReplacementReceipt(rows, input.current_generation_hash ?? null);
  }
}

class PostgresBrowserSurfaceReplacementReceiptStore implements BrowserSurfaceReplacementReceiptStore {
  readonly #query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: ReplacementReceiptRow[] }>;

  constructor(query = postgresQuery) {
    this.#query = (sql, values = []) => query(sql, [...values]) as Promise<{ rows: ReplacementReceiptRow[] }>;
  }

  async append(receipt: ReplacementReceipt): Promise<ReplacementReceipt> {
    const existing = await this.#query(
      `SELECT * FROM browser_surface_replacement_receipts
       WHERE (idempotency_key = $1 AND phase = $2) OR (replacement_id = $3 AND phase = $4)
       ORDER BY event_seq`,
      [receipt.idempotency_key, receipt.phase, receipt.replacement_id, receipt.phase]
    );
    for (const row of existing.rows) {
      const mapped = mapRow(row);
      assertSameEvent(mapped, receipt);
      return mapped;
    }
    const prior = await this.#query(
      `SELECT * FROM browser_surface_replacement_receipts
       WHERE replacement_id = $1 ORDER BY event_seq DESC LIMIT 1`,
      [receipt.replacement_id]
    );
    const priorRow = prior.rows[0];
    if (priorRow) {
      assertSameEventIdentity(mapRow(priorRow), receipt);
      assertNoOppositeResolution(mapRow(priorRow), receipt);
    }
    const inserted = await this.#query(
      `INSERT INTO browser_surface_replacement_receipts(
        replacement_id, idempotency_key, scope, connection_id, connector_id, profile_key,
        surface_subject_id, run_id, lease_id, surface_id, previous_generation_hash,
        next_generation_hash, cause, phase, terminal_outcome, observed_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT DO NOTHING
      RETURNING *`,
      params(receipt)
    );
    const row =
      inserted.rows[0] ??
      (
        await this.#query(
          `SELECT * FROM browser_surface_replacement_receipts
       WHERE (idempotency_key = $1 AND phase = $2)
          OR (replacement_id = $3 AND phase IN ('completed', 'terminal'))
       ORDER BY event_seq LIMIT 1`,
          [receipt.idempotency_key, receipt.phase, receipt.replacement_id]
        )
      ).rows[0];
    if (!row) {
      throw new Error(`replacement receipt insert ${receipt.replacement_id}/${receipt.phase} was not readable`);
    }
    const authoritative = mapRow(row);
    assertSameEvent(authoritative, receipt);
    return authoritative;
  }

  async findPendingForSurface(surfaceId: string): Promise<ReplacementReceipt | null> {
    const result = await this.#query(
      `SELECT started.* FROM browser_surface_replacement_receipts AS started
       WHERE started.surface_id = $1 AND started.phase = 'started'
         AND NOT EXISTS (
           SELECT 1 FROM browser_surface_replacement_receipts AS resolved
           WHERE resolved.replacement_id = started.replacement_id
             AND resolved.phase IN ('completed', 'terminal')
         )
       ORDER BY started.event_seq DESC LIMIT 1`,
      [surfaceId]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findPendingForScope(input: {
    readonly connection_id: string;
    readonly surface_subject_id: string | null;
    readonly profile_key: string;
    readonly preferred_surface_id?: string;
  }): Promise<ReplacementReceipt | null> {
    const result = await this.#query(
      `SELECT started.* FROM browser_surface_replacement_receipts AS started
       WHERE started.connection_id = $1
         AND started.surface_subject_id IS NOT DISTINCT FROM $2
         AND started.profile_key = $3
         AND started.phase = 'started'
         AND NOT EXISTS (
           SELECT 1 FROM browser_surface_replacement_receipts AS resolved
           WHERE resolved.replacement_id = started.replacement_id
             AND resolved.phase IN ('completed', 'terminal')
         )
       ORDER BY CASE WHEN $4::text IS NOT NULL AND started.surface_id = $4::text THEN 0 ELSE 1 END,
                started.event_seq DESC, started.idempotency_key DESC
       LIMIT 1`,
      [input.connection_id, input.surface_subject_id, input.profile_key, input.preferred_surface_id ?? null]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async list(): Promise<readonly ReplacementReceipt[]> {
    const result = await this.#query(
      "SELECT * FROM browser_surface_replacement_receipts ORDER BY event_seq, idempotency_key"
    );
    return result.rows.map(mapRow);
  }

  async listForScope(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
  }): Promise<readonly ReplacementReceipt[]> {
    const result =
      input.surface_subject_id === undefined
        ? await this.#query(
            `SELECT * FROM browser_surface_replacement_receipts
           WHERE connection_id = $1 ORDER BY event_seq, idempotency_key`,
            [input.connection_id]
          )
        : await this.#query(
            `SELECT * FROM browser_surface_replacement_receipts
           WHERE connection_id = $1 AND surface_subject_id = $2 ORDER BY event_seq, idempotency_key`,
            [input.connection_id, input.surface_subject_id]
          );
    return result.rows.map(mapRow);
  }

  async selectCurrent(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
    readonly current_generation_hash?: string;
  }): Promise<ReplacementReceipt | null> {
    const rows = await this.listForScope(input);
    if (input.surface_subject_id === undefined) {
      const scopes = new Set(rows.map((row) => row.scope));
      if (scopes.size > 1) {
        return null;
      }
    }
    return selectCurrentReplacementReceipt(rows, input.current_generation_hash ?? null);
  }
}

function assertSameEventIdentity(previous: ReplacementReceipt, incoming: ReplacementReceipt): void {
  const fields: readonly (keyof ReplacementReceipt)[] = [
    "replacement_id",
    "scope",
    "connection_id",
    "connector_id",
    "profile_key",
    "surface_subject_id",
    "run_id",
    "lease_id",
    "surface_id",
    "previous_generation_hash",
    "cause",
  ];
  for (const field of fields) {
    if (previous[field] !== incoming[field]) {
      throw new ReplacementReplayConflictError(
        `replacement ${previous.replacement_id} immutable field ${field} changed`
      );
    }
  }
}

function assertNoOppositeResolution(previous: ReplacementReceipt, incoming: ReplacementReceipt): void {
  if (isResolution(previous.phase) && isResolution(incoming.phase) && previous.phase !== incoming.phase) {
    throw new ReplacementReplayConflictError(
      `replacement ${incoming.replacement_id} already resolved as ${previous.phase}`
    );
  }
}

function isResolution(phase: ReplacementReceipt["phase"]): boolean {
  return phase === "completed" || phase === "terminal";
}

function dbRows(sql: string, bind: readonly unknown[] = []): ReplacementReceiptRow[] {
  return [...iterateDynamicSqlAcknowledged<ReplacementReceiptRow>(sql, bind as BindValue[])];
}

function dbRow(sql: string, bind: readonly unknown[] = []): ReplacementReceiptRow | undefined {
  for (const row of iterateDynamicSqlAcknowledged<ReplacementReceiptRow>(sql, bind as BindValue[])) {
    return row;
  }
  return;
}

export function createSqliteBrowserSurfaceReplacementReceiptStore(): BrowserSurfaceReplacementReceiptStore {
  return new SqliteBrowserSurfaceReplacementReceiptStore();
}

export function createPostgresBrowserSurfaceReplacementReceiptStore(
  query?: (sql: string, values?: readonly unknown[]) => Promise<{ rows: ReplacementReceiptRow[] }>
): BrowserSurfaceReplacementReceiptStore {
  return new PostgresBrowserSurfaceReplacementReceiptStore(query);
}

export function createBrowserSurfaceReplacementReceiptStore(): BrowserSurfaceReplacementReceiptStore {
  return isPostgresStorageBackend()
    ? createPostgresBrowserSurfaceReplacementReceiptStore()
    : createSqliteBrowserSurfaceReplacementReceiptStore();
}

export function getDefaultBrowserSurfaceReplacementReceiptStore(): BrowserSurfaceReplacementReceiptStore {
  const backend = getStorageBackendKind();
  if (backend === "postgres") {
    return createPostgresBrowserSurfaceReplacementReceiptStore();
  }
  return createSqliteBrowserSurfaceReplacementReceiptStore();
}
