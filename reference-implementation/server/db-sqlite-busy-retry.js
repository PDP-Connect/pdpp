/**
 * SQLite busy-retry cluster — self-contained, no db.js dependency.
 *
 * Best-effort retry wrapper for SQLite writes that race against a
 * still-shutting-down sibling process. The canonical case: `node --watch`
 * (and Docker dev compose, which runs `node --watch`) restarts the server
 * after an edit. SQLite's per-process `busy_timeout` retries are usually
 * enough, but on slow hosts and bind-mounted volumes the new process can
 * occasionally observe a `SQLITE_BUSY` from the old process's WAL writer
 * faster than the busy-timeout window covers (e.g., the old process held
 * a mid-startup write transaction that `db.close()` rolled back, but the
 * `-shm`/`-wal` lock wasn't visible-as-released yet to the new opener).
 *
 * Use this only for startup writes that:
 *   - are bounded and idempotent (seeds, reconciles), and
 *   - we'd rather retry than fail-the-process on transient contention.
 *
 * Persistent locks still surface — once the retry budget is exhausted we
 * rethrow with the original error so operators see a real diagnostic.
 *
 * Spec note: the `PDPP_SQLITE_BUSY_TIMEOUT_MS` ceiling already bounds
 * SQLite's own retry loop. This helper layers a small bounded application
 * retry on top so we don't re-enter SQLite immediately after a busy
 * failure — backoff gives the sibling process time to finish closing.
 */

const TRANSIENT_LOCK_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_SNAPSHOT']);

export function isTransientSqliteLockError(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_LOCK_CODES.has(err.code)) return true;
  const message = typeof err.message === 'string' ? err.message : '';
  return message.includes('database is locked') || message.includes('database table is locked');
}

/**
 * Synchronous sibling of `runWithSqliteBusyRetry` for the boot path.
 *
 * `initDb` runs synchronously (better-sqlite3 is sync; the surrounding
 * `await initDb(...)` call site only awaits the Promise wrapper) and the
 * very first write after opening the DB is `raw.exec(SCHEMA)`. On Docker
 * dev restart (`node --watch` or `docker compose restart reference`),
 * the new process can race the old process's still-closing WAL writer.
 * `seedPreRegisteredClients` is already wrapped in the async retry
 * helper, but the SCHEMA exec runs BEFORE that — so a transient lock
 * surfaces as `SQLITE_BUSY` from the boot itself. This helper applies
 * the same bounded retry policy without going async.
 *
 * Uses a busy-wait spin to back off because we are intentionally on the
 * synchronous path; the retry budget is small (5 attempts capped at
 * 1.5s each) and only fires on a transient lock, so the worst case is
 * ~5s of boot delay before we surface the original error.
 */
export function runWithSqliteBusyRetrySync(fn, opts = {}) {
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? Math.max(1, opts.maxAttempts) : 5;
  const initialDelayMs = Number.isFinite(opts.initialDelayMs) ? Math.max(0, opts.initialDelayMs) : 100;
  const maxDelayMs = Number.isFinite(opts.maxDelayMs) ? Math.max(initialDelayMs, opts.maxDelayMs) : 1500;
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;

  const sleepSync = typeof opts.sleepSync === 'function'
    ? opts.sleepSync
    : (ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) { /* busy-wait */ }
      };

  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientSqliteLockError(err)) throw err;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      if (onRetry) onRetry({ err, attempt, delay });
      sleepSync(delay);
    }
  }
  throw lastErr;
}

export async function runWithSqliteBusyRetry(fn, opts = {}) {
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? Math.max(1, opts.maxAttempts) : 5;
  const initialDelayMs = Number.isFinite(opts.initialDelayMs) ? Math.max(0, opts.initialDelayMs) : 100;
  const maxDelayMs = Number.isFinite(opts.maxDelayMs) ? Math.max(initialDelayMs, opts.maxDelayMs) : 1500;
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientSqliteLockError(err)) throw err;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      if (onRetry) onRetry({ err, attempt, delay });
      await sleep(delay);
    }
  }
  throw lastErr;
}
