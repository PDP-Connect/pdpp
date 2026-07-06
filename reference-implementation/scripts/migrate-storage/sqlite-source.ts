import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";

/** A better-sqlite3 database handle. */
type DatabaseHandle = Database.Database;

/**
 * Opens a read-only handle to a SQLite database.
 * Accepts "sqlite:///abs/path", "sqlite://./relative", or a plain file path.
 * Attempts to load sqlite-vec extension; if it fails, vecLoaded is set to false.
 * @param url - SQLite URL or file path
 * @returns
 */
// biome-ignore lint/suspicious/useAwait: async signature is the public contract callers await; better-sqlite3 open is synchronous but the returned Promise must be preserved.
export async function openSqliteSource(url: string): Promise<{
  handle: DatabaseHandle;
  filepath: string;
  vecLoaded: boolean;
  close: () => void;
}> {
  let filepath: string;

  if (url.startsWith("sqlite://")) {
    const urlPart = url.slice("sqlite://".length);
    if (urlPart.startsWith("/")) {
      // sqlite:///absolute/path
      filepath = urlPart;
    } else {
      // sqlite://./relative or sqlite://../relative
      filepath = resolve(urlPart);
    }
  } else {
    // Plain file path
    filepath = isAbsolute(url) ? url : resolve(url);
  }

  const handle = new Database(filepath, { readonly: true, fileMustExist: true });

  let vecLoaded = false;
  try {
    loadSqliteVec(handle);
    vecLoaded = true;
  } catch {
    // Extension not available; virtual tables may be unreadable
    // but non-virtual table migration should still work
  }

  return {
    handle,
    filepath,
    vecLoaded,
    close() {
      handle.close();
    },
  };
}

/**
 * Checks if a SQLite database is currently locked by a writer.
 * Inspects .sqlite-wal and .sqlite-shm files.
 * @param filepath - Path to SQLite database file
 * @returns
 */
export function checkSqliteNotLocked(filepath: string): { locked: boolean; reason?: string } {
  const walPath = `${filepath}-wal`;
  const shmPath = `${filepath}-shm`;

  try {
    const walStat = statSync(walPath);
    if (walStat.size > 0) {
      return { locked: true, reason: "WAL file is non-empty" };
    }
  } catch {
    // WAL file doesn't exist, not locked
  }

  try {
    const shmStat = statSync(shmPath);
    if (shmStat.size > 0) {
      return { locked: true, reason: "SHM file is non-empty" };
    }
  } catch {
    // SHM file doesn't exist, not locked
  }

  return { locked: false };
}

/**
 * Synchronously counts total rows in a table.
 * @param handle - Database handle
 * @param tableName - Table name
 * @returns
 */
export function countRows(handle: DatabaseHandle, tableName: string): number {
  const stmt = handle.prepare(`SELECT COUNT(*) as cnt FROM \`${tableName}\``);
  const result = stmt.get() as { cnt?: number } | undefined;
  return result?.cnt ?? 0;
}

/**
 * Attempts to count rows in a table, wrapping errors gracefully.
 * Useful for virtual tables that may fail even after loading vec0.
 * @param handle - Database handle
 * @param tableName - Table name
 * @returns
 */
export function tryQueryRowCount(
  handle: DatabaseHandle,
  tableName: string
): { ok: true; count: number } | { ok: false; reason: string } {
  try {
    const count = countRows(handle, tableName);
    return { ok: true, count };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Generator that yields successive arrays of row objects from a table.
 * @param handle - Database handle
 * @param tableName - Table name
 * @param batchSize - Rows per yielded array (default 500)
 * @yields
 */
export function* streamRows(
  handle: DatabaseHandle,
  tableName: string,
  batchSize = 500
): Generator<Record<string, unknown>[]> {
  const stmt = handle.prepare(`SELECT * FROM \`${tableName}\``);
  const iterator = stmt.iterate() as IterableIterator<Record<string, unknown>>;

  let batch: Record<string, unknown>[] = [];
  for (const row of iterator) {
    batch.push(row);
    if (batch.length === batchSize) {
      yield batch;
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield batch;
  }
}

/**
 * Returns the set of table names in the database.
 * @param handle - Database handle
 * @returns
 */
export function listSourceTables(handle: DatabaseHandle): Set<string> {
  const stmt = handle.prepare("SELECT name FROM sqlite_master WHERE type='table'");
  const rows = stmt.all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Returns column metadata for a table.
 * @param handle - Database handle
 * @param tableName - Table name
 * @returns
 */
export function describeSourceColumns(
  handle: DatabaseHandle,
  tableName: string
): Array<{
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: unknown;
}> {
  const stmt = handle.prepare(`PRAGMA table_info(\`${tableName}\`)`);
  return stmt.all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
    dflt_value: unknown;
  }>;
}
