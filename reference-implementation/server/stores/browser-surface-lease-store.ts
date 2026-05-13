import {
  type BrowserSurface,
  type BrowserSurfaceLease,
  TERMINAL_BROWSER_SURFACE_LEASE_STATUSES,
} from "../../runtime/browser-surface-leases.ts";
import { type BindValue, execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from "../../lib/db.ts";
import { getDb } from "../db.js";
import {
  getStorageBackendKind,
  isPostgresStorageBackend,
  postgresQuery,
  withPostgresTransaction,
} from "../postgres-storage.js";

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: BrowserSurfaceRow[] | BrowserSurfaceLeaseRow[] }>;
};

interface BrowserSurfaceRow {
  surface_id: string;
  backend: BrowserSurface["backend"];
  profile_key: string;
  connector_id: string;
  account_key: string | null;
  cdp_url: string;
  stream_base_url: string;
  health: BrowserSurface["health"];
  container_id: string | null;
  active_lease_id: string | null;
  created_at: string;
  last_used_at: string;
}

interface BrowserSurfaceLeaseRow {
  lease_id: string;
  surface_id: string | null;
  connector_id: string;
  profile_key: string;
  account_key: string | null;
  run_id: string;
  status: BrowserSurfaceLease["status"];
  priority_class: BrowserSurfaceLease["priority_class"];
  requested_at: string;
  leased_at: string | null;
  released_at: string | null;
  expires_at: string;
  fencing_token: number;
  wait_reason: BrowserSurfaceLease["wait_reason"] | null;
}

export interface BrowserSurfaceLeaseStore {
  upsertSurface(surface: BrowserSurface): Promise<BrowserSurface>;
  upsertLease(lease: BrowserSurfaceLease): Promise<BrowserSurfaceLease>;
  getSurface(surfaceId: string): Promise<BrowserSurface | null>;
  getLease(leaseId: string): Promise<BrowserSurfaceLease | null>;
  listSurfaces(): Promise<BrowserSurface[]>;
  listNonTerminalLeases(): Promise<BrowserSurfaceLease[]>;
  updateLeaseTerminal(
    leaseId: string,
    status: Extract<BrowserSurfaceLease["status"], "released" | "expired" | "deferred" | "cancelled" | "surface_failed">,
    options?: { releasedAt?: string; waitReason?: BrowserSurfaceLease["wait_reason"] | null }
  ): Promise<BrowserSurfaceLease | null>;
  clearSurfaceActiveLease(surfaceId: string, leaseId: string, fencingToken: number): Promise<BrowserSurface | null>;
  withLeaseTransaction<T>(fn: (store: BrowserSurfaceLeaseStore) => Promise<T> | T): Promise<T>;
}

const TERMINAL_STATUS_SQL = TERMINAL_BROWSER_SURFACE_LEASE_STATUSES.map((status) => `'${status}'`).join(", ");

function mapSurface(row: BrowserSurfaceRow | null | undefined): BrowserSurface | null {
  if (!row) return null;
  return {
    surface_id: row.surface_id,
    backend: row.backend,
    profile_key: row.profile_key,
    connector_id: row.connector_id,
    cdp_url: row.cdp_url,
    stream_base_url: row.stream_base_url,
    health: row.health,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    ...(row.account_key ? { account_key: row.account_key } : {}),
    ...(row.active_lease_id ? { active_lease_id: row.active_lease_id } : {}),
    ...(row.container_id ? { container_id: row.container_id } : {}),
  };
}

function mapLease(row: BrowserSurfaceLeaseRow | null | undefined): BrowserSurfaceLease | null {
  if (!row) return null;
  return {
    lease_id: row.lease_id,
    connector_id: row.connector_id,
    profile_key: row.profile_key,
    run_id: row.run_id,
    status: row.status,
    priority_class: row.priority_class,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    fencing_token: Number(row.fencing_token),
    ...(row.account_key ? { account_key: row.account_key } : {}),
    ...(row.leased_at ? { leased_at: row.leased_at } : {}),
    ...(row.released_at ? { released_at: row.released_at } : {}),
    ...(row.surface_id ? { surface_id: row.surface_id } : {}),
    ...(row.wait_reason ? { wait_reason: row.wait_reason } : {}),
  };
}

function sqliteSurfaceParams(surface: BrowserSurface): BindValue[] {
  return [
    surface.surface_id,
    surface.backend,
    surface.profile_key,
    surface.connector_id,
    surface.account_key ?? null,
    surface.cdp_url,
    surface.stream_base_url,
    surface.health,
    surface.container_id ?? null,
    surface.active_lease_id ?? null,
    surface.created_at,
    surface.last_used_at,
  ];
}

function sqliteLeaseParams(lease: BrowserSurfaceLease): BindValue[] {
  return [
    lease.lease_id,
    lease.surface_id ?? null,
    lease.connector_id,
    lease.profile_key,
    lease.account_key ?? null,
    lease.run_id,
    lease.status,
    lease.priority_class,
    lease.requested_at,
    lease.leased_at ?? null,
    lease.released_at ?? null,
    lease.expires_at,
    lease.fencing_token,
    lease.wait_reason ?? null,
  ];
}

function firstDynamicRow<R>(sql: string, params: BindValue[] = []): R | undefined {
  for (const row of iterateDynamicSqlAcknowledged<R>(sql, params)) {
    return row;
  }
  return undefined;
}

function allDynamicRows<R>(sql: string, params: BindValue[] = []): R[] {
  return [...iterateDynamicSqlAcknowledged<R>(sql, params)];
}

class SqliteBrowserSurfaceLeaseStore implements BrowserSurfaceLeaseStore {
  upsertSurface(surface: BrowserSurface): Promise<BrowserSurface> {
    // REVIEWED-DYNAMIC: browser surface persistence is a compact new store seam; the SQL is static here and not caller-built.
    execDynamicSqlAcknowledged(
      `INSERT INTO browser_surfaces(
        surface_id, backend, profile_key, connector_id, account_key, cdp_url, stream_base_url,
        health, container_id, active_lease_id, created_at, last_used_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(surface_id) DO UPDATE SET
        backend = excluded.backend,
        profile_key = excluded.profile_key,
        connector_id = excluded.connector_id,
        account_key = excluded.account_key,
        cdp_url = excluded.cdp_url,
        stream_base_url = excluded.stream_base_url,
        health = excluded.health,
        container_id = excluded.container_id,
        active_lease_id = excluded.active_lease_id,
        created_at = excluded.created_at,
        last_used_at = excluded.last_used_at`,
      sqliteSurfaceParams(surface)
    );
    return Promise.resolve(surface);
  }

  upsertLease(lease: BrowserSurfaceLease): Promise<BrowserSurfaceLease> {
    // REVIEWED-DYNAMIC: browser lease persistence is a compact new store seam; the SQL is static here and not caller-built.
    execDynamicSqlAcknowledged(
      `INSERT INTO browser_surface_leases(
        lease_id, surface_id, connector_id, profile_key, account_key, run_id, status,
        priority_class, requested_at, leased_at, released_at, expires_at, fencing_token, wait_reason
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lease_id) DO UPDATE SET
        surface_id = excluded.surface_id,
        connector_id = excluded.connector_id,
        profile_key = excluded.profile_key,
        account_key = excluded.account_key,
        run_id = excluded.run_id,
        status = excluded.status,
        priority_class = excluded.priority_class,
        requested_at = excluded.requested_at,
        leased_at = excluded.leased_at,
        released_at = excluded.released_at,
        expires_at = excluded.expires_at,
        fencing_token = excluded.fencing_token,
        wait_reason = excluded.wait_reason`,
      sqliteLeaseParams(lease)
    );
    return Promise.resolve(lease);
  }

  getSurface(surfaceId: string): Promise<BrowserSurface | null> {
    // REVIEWED-DYNAMIC: static primary-key lookup for the compact browser surface store.
    const row = firstDynamicRow<BrowserSurfaceRow>("SELECT * FROM browser_surfaces WHERE surface_id = ?", [surfaceId]);
    return Promise.resolve(mapSurface(row));
  }

  getLease(leaseId: string): Promise<BrowserSurfaceLease | null> {
    // REVIEWED-DYNAMIC: static primary-key lookup for the compact browser lease store.
    const row = firstDynamicRow<BrowserSurfaceLeaseRow>("SELECT * FROM browser_surface_leases WHERE lease_id = ?", [leaseId]);
    return Promise.resolve(mapLease(row));
  }

  listSurfaces(): Promise<BrowserSurface[]> {
    // REVIEWED-DYNAMIC: browser surfaces are a small controller-owned runtime table.
    const rows = allDynamicRows<BrowserSurfaceRow>("SELECT * FROM browser_surfaces ORDER BY surface_id");
    return Promise.resolve(rows.map((row) => mapSurface(row)!));
  }

  listNonTerminalLeases(): Promise<BrowserSurfaceLease[]> {
    // REVIEWED-DYNAMIC: terminal status list is derived from the runtime enum constants.
    const rows = allDynamicRows<BrowserSurfaceLeaseRow>(
      `SELECT * FROM browser_surface_leases
       WHERE status NOT IN (${TERMINAL_STATUS_SQL})
       ORDER BY CASE priority_class WHEN 'owner_interactive' THEN 0 ELSE 1 END, requested_at, lease_id`
    );
    return Promise.resolve(rows.map((row) => mapLease(row)!));
  }

  updateLeaseTerminal(
    leaseId: string,
    status: Extract<BrowserSurfaceLease["status"], "released" | "expired" | "deferred" | "cancelled" | "surface_failed">,
    options: { releasedAt?: string; waitReason?: BrowserSurfaceLease["wait_reason"] | null } = {}
  ): Promise<BrowserSurfaceLease | null> {
    // REVIEWED-DYNAMIC: static terminal-state mutation for the browser lease store.
    execDynamicSqlAcknowledged(
      `UPDATE browser_surface_leases
       SET status = ?, released_at = COALESCE(?, released_at), wait_reason = ?
       WHERE lease_id = ?`,
      [status, options.releasedAt ?? null, options.waitReason ?? null, leaseId]
    );
    return this.getLease(leaseId);
  }

  clearSurfaceActiveLease(surfaceId: string, leaseId: string, fencingToken: number): Promise<BrowserSurface | null> {
    // REVIEWED-DYNAMIC: static fenced surface release mutation for the browser lease store.
    execDynamicSqlAcknowledged(
      `UPDATE browser_surfaces
       SET active_lease_id = NULL
       WHERE surface_id = ?
         AND active_lease_id = ?
         AND EXISTS (
           SELECT 1 FROM browser_surface_leases
           WHERE lease_id = ?
             AND surface_id = browser_surfaces.surface_id
             AND fencing_token = ?
         )`,
      [surfaceId, leaseId, leaseId, fencingToken]
    );
    return this.getSurface(surfaceId);
  }

  async withLeaseTransaction<T>(fn: (store: BrowserSurfaceLeaseStore) => Promise<T> | T): Promise<T> {
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = await fn(this);
      db.exec("COMMIT");
      return value;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }
}

class PostgresBrowserSurfaceLeaseStore implements BrowserSurfaceLeaseStore {
  readonly #query: (sql: string, params?: unknown[]) => Promise<{ rows: BrowserSurfaceRow[] | BrowserSurfaceLeaseRow[] }>;

  constructor(client?: Queryable) {
    this.#query = client ? (sql, params = []) => client.query(sql, params) : (sql, params = []) => postgresQuery(sql, params);
  }

  async upsertSurface(surface: BrowserSurface): Promise<BrowserSurface> {
    await this.#query(
      `INSERT INTO browser_surfaces(
        surface_id, backend, profile_key, connector_id, account_key, cdp_url, stream_base_url,
        health, container_id, active_lease_id, created_at, last_used_at
      )
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT(surface_id) DO UPDATE SET
        backend = EXCLUDED.backend,
        profile_key = EXCLUDED.profile_key,
        connector_id = EXCLUDED.connector_id,
        account_key = EXCLUDED.account_key,
        cdp_url = EXCLUDED.cdp_url,
        stream_base_url = EXCLUDED.stream_base_url,
        health = EXCLUDED.health,
        container_id = EXCLUDED.container_id,
        active_lease_id = EXCLUDED.active_lease_id,
        created_at = EXCLUDED.created_at,
        last_used_at = EXCLUDED.last_used_at`,
      sqliteSurfaceParams(surface)
    );
    return surface;
  }

  async upsertLease(lease: BrowserSurfaceLease): Promise<BrowserSurfaceLease> {
    await this.#query(
      `INSERT INTO browser_surface_leases(
        lease_id, surface_id, connector_id, profile_key, account_key, run_id, status,
        priority_class, requested_at, leased_at, released_at, expires_at, fencing_token, wait_reason
      )
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT(lease_id) DO UPDATE SET
        surface_id = EXCLUDED.surface_id,
        connector_id = EXCLUDED.connector_id,
        profile_key = EXCLUDED.profile_key,
        account_key = EXCLUDED.account_key,
        run_id = EXCLUDED.run_id,
        status = EXCLUDED.status,
        priority_class = EXCLUDED.priority_class,
        requested_at = EXCLUDED.requested_at,
        leased_at = EXCLUDED.leased_at,
        released_at = EXCLUDED.released_at,
        expires_at = EXCLUDED.expires_at,
        fencing_token = EXCLUDED.fencing_token,
        wait_reason = EXCLUDED.wait_reason`,
      sqliteLeaseParams(lease)
    );
    return lease;
  }

  async getSurface(surfaceId: string): Promise<BrowserSurface | null> {
    const result = await this.#query("SELECT * FROM browser_surfaces WHERE surface_id = $1", [surfaceId]);
    return mapSurface(result.rows[0] as BrowserSurfaceRow | undefined);
  }

  async getLease(leaseId: string): Promise<BrowserSurfaceLease | null> {
    const result = await this.#query("SELECT * FROM browser_surface_leases WHERE lease_id = $1", [leaseId]);
    return mapLease(result.rows[0] as BrowserSurfaceLeaseRow | undefined);
  }

  async listSurfaces(): Promise<BrowserSurface[]> {
    const result = await this.#query("SELECT * FROM browser_surfaces ORDER BY surface_id");
    return (result.rows as BrowserSurfaceRow[]).map((row) => mapSurface(row)!);
  }

  async listNonTerminalLeases(): Promise<BrowserSurfaceLease[]> {
    const result = await this.#query(
      `SELECT * FROM browser_surface_leases
       WHERE status NOT IN (${TERMINAL_STATUS_SQL})
       ORDER BY CASE priority_class WHEN 'owner_interactive' THEN 0 ELSE 1 END, requested_at, lease_id`
    );
    return (result.rows as BrowserSurfaceLeaseRow[]).map((row) => mapLease(row)!);
  }

  async updateLeaseTerminal(
    leaseId: string,
    status: Extract<BrowserSurfaceLease["status"], "released" | "expired" | "deferred" | "cancelled" | "surface_failed">,
    options: { releasedAt?: string; waitReason?: BrowserSurfaceLease["wait_reason"] | null } = {}
  ): Promise<BrowserSurfaceLease | null> {
    await this.#query(
      `UPDATE browser_surface_leases
       SET status = $1, released_at = COALESCE($2, released_at), wait_reason = $3
       WHERE lease_id = $4`,
      [status, options.releasedAt ?? null, options.waitReason ?? null, leaseId]
    );
    return this.getLease(leaseId);
  }

  async clearSurfaceActiveLease(surfaceId: string, leaseId: string, fencingToken: number): Promise<BrowserSurface | null> {
    await this.#query(
      `UPDATE browser_surfaces
       SET active_lease_id = NULL
       WHERE surface_id = $1
         AND active_lease_id = $2
         AND EXISTS (
           SELECT 1 FROM browser_surface_leases
           WHERE lease_id = $2
             AND surface_id = browser_surfaces.surface_id
             AND fencing_token = $3
         )`,
      [surfaceId, leaseId, fencingToken]
    );
    return this.getSurface(surfaceId);
  }

  withLeaseTransaction<T>(fn: (store: BrowserSurfaceLeaseStore) => Promise<T> | T): Promise<T> {
    return withPostgresTransaction((client: Queryable) => fn(new PostgresBrowserSurfaceLeaseStore(client)));
  }
}

export function createSqliteBrowserSurfaceLeaseStore(): BrowserSurfaceLeaseStore {
  return new SqliteBrowserSurfaceLeaseStore();
}

export function createPostgresBrowserSurfaceLeaseStore(): BrowserSurfaceLeaseStore {
  return new PostgresBrowserSurfaceLeaseStore();
}

export function createBrowserSurfaceLeaseStore(): BrowserSurfaceLeaseStore {
  return isPostgresStorageBackend() ? createPostgresBrowserSurfaceLeaseStore() : createSqliteBrowserSurfaceLeaseStore();
}

let defaultStore: BrowserSurfaceLeaseStore | null = null;
let defaultStoreBackend: string | null = null;

export function getDefaultBrowserSurfaceLeaseStore(): BrowserSurfaceLeaseStore {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultStoreBackend !== backend) {
    defaultStore = createBrowserSurfaceLeaseStore();
    defaultStoreBackend = backend;
  }
  return defaultStore;
}
