import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { fileURLToPath } from 'url';
import { resolve, isAbsolute } from 'path';
import { statSync } from 'fs';

/**
 * Opens a read-only handle to a SQLite database.
 * Accepts "sqlite:///abs/path", "sqlite://./relative", or a plain file path.
 * Attempts to load sqlite-vec extension; if it fails, vecLoaded is set to false.
 * @param {string} url - SQLite URL or file path
 * @returns {Promise<{handle: Database, filepath: string, vecLoaded: boolean, close: function}>}
 */
export async function openSqliteSource(url) {
  let filepath;

  if (url.startsWith('sqlite://')) {
    const urlPart = url.slice('sqlite://'.length);
    if (urlPart.startsWith('/')) {
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
    sqliteVec.load(handle);
    vecLoaded = true;
  } catch (err) {
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
 * @param {string} filepath - Path to SQLite database file
 * @returns {{locked: boolean, reason?: string}}
 */
export function checkSqliteNotLocked(filepath) {
  const walPath = `${filepath}-wal`;
  const shmPath = `${filepath}-shm`;

  try {
    const walStat = statSync(walPath);
    if (walStat.size > 0) {
      return { locked: true, reason: 'WAL file is non-empty' };
    }
  } catch {
    // WAL file doesn't exist, not locked
  }

  try {
    const shmStat = statSync(shmPath);
    if (shmStat.size > 0) {
      return { locked: true, reason: 'SHM file is non-empty' };
    }
  } catch {
    // SHM file doesn't exist, not locked
  }

  return { locked: false };
}

/**
 * Synchronously counts total rows in a table.
 * @param {Database} handle - Database handle
 * @param {string} tableName - Table name
 * @returns {number}
 */
export function countRows(handle, tableName) {
  const stmt = handle.prepare(`SELECT COUNT(*) as cnt FROM \`${tableName}\``);
  const result = stmt.get();
  return result?.cnt ?? 0;
}

/**
 * Attempts to count rows in a table, wrapping errors gracefully.
 * Useful for virtual tables that may fail even after loading vec0.
 * @param {Database} handle - Database handle
 * @param {string} tableName - Table name
 * @returns {{ok: true, count: number} | {ok: false, reason: string}}
 */
export function tryQueryRowCount(handle, tableName) {
  try {
    const count = countRows(handle, tableName);
    return { ok: true, count };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Generator that yields successive arrays of row objects from a table.
 * @param {Database} handle - Database handle
 * @param {string} tableName - Table name
 * @param {number} batchSize - Rows per yielded array (default 500)
 * @yields {Array<object>}
 */
export function* streamRows(handle, tableName, batchSize = 500) {
  const stmt = handle.prepare(`SELECT * FROM \`${tableName}\``);
  const iterator = stmt.iterate();

  let batch = [];
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
 * @param {Database} handle - Database handle
 * @returns {Set<string>}
 */
export function listSourceTables(handle) {
  const stmt = handle.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  );
  const rows = stmt.all();
  return new Set(rows.map((r) => r.name));
}

/**
 * Returns column metadata for a table.
 * @param {Database} handle - Database handle
 * @param {string} tableName - Table name
 * @returns {Array<{name: string, type: string, notnull: number, pk: number, dflt_value: any}>}
 */
export function describeSourceColumns(handle, tableName) {
  const stmt = handle.prepare(`PRAGMA table_info(\`${tableName}\`)`);
  return stmt.all();
}
