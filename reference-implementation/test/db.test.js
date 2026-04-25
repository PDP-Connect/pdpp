import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import {
  closeDb,
  initDb,
  isTransientSqliteLockError,
  runWithSqliteBusyRetry,
} from '../server/db.js';
import { seedPreRegisteredClients } from '../server/auth.js';

test('initDb applies a configurable SQLite busy timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-db-'));
  try {
    const db = initDb(join(dir, 'pdpp.sqlite'), { busyTimeoutMs: 12_345 });
    assert.equal(db.pragma('busy_timeout', { simple: true }), 12_345);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isTransientSqliteLockError recognizes SQLITE_BUSY/LOCKED', () => {
  assert.equal(isTransientSqliteLockError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })), true);
  assert.equal(isTransientSqliteLockError(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED' })), true);
  assert.equal(
    isTransientSqliteLockError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY_SNAPSHOT' })),
    true,
  );
  assert.equal(isTransientSqliteLockError(new Error('database is locked')), true);
  assert.equal(isTransientSqliteLockError(new Error('something else')), false);
  assert.equal(isTransientSqliteLockError(null), false);
});

test('runWithSqliteBusyRetry retries transient lock failures and eventually succeeds', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await runWithSqliteBusyRetry(
    () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return 'ok';
    },
    {
      maxAttempts: 5,
      initialDelayMs: 1,
      maxDelayMs: 4,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  // Two retries scheduled (after attempts 1 and 2). Backoff doubles from 1ms.
  assert.deepEqual(sleeps, [1, 2]);
});

test('runWithSqliteBusyRetry rethrows non-transient errors immediately', async () => {
  let calls = 0;
  await assert.rejects(
    () => runWithSqliteBusyRetry(() => {
      calls += 1;
      throw new Error('SQLITE_CORRUPT: database disk image is malformed');
    }, { sleep: () => Promise.resolve() }),
    /malformed/,
  );
  assert.equal(calls, 1);
});

test('runWithSqliteBusyRetry surfaces the original error after the retry budget is exhausted', async () => {
  const sleeps = [];
  await assert.rejects(
    () => runWithSqliteBusyRetry(() => {
      const err = new Error('database is locked');
      err.code = 'SQLITE_BUSY';
      throw err;
    }, {
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 4,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    }),
    (err) => err.code === 'SQLITE_BUSY' && /database is locked/.test(err.message),
  );
  // 3 attempts → 2 backoff sleeps between them.
  assert.equal(sleeps.length, 2);
});

test('seedPreRegisteredClients survives a transient sibling write lock at startup', async () => {
  // Models the Docker dev-compose `node --watch` restart: a sibling
  // process briefly holds a WAL write lock while the new process is
  // running its idempotent client seed. With the application-level
  // retry wrapper we expect seed to recover and write, not crash.
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-seed-'));
  const dbPath = join(dir, 'pdpp.sqlite');
  let sibling;
  try {
    initDb(dbPath, { busyTimeoutMs: 25 });
    closeDb();

    // Sibling holds a write transaction with busy_timeout=0 so its hold
    // is observable as a lock to the seed connection.
    sibling = new Database(dbPath, { timeout: 0 });
    sibling.pragma('journal_mode = WAL');
    sibling.pragma('busy_timeout = 0');
    sibling.prepare('BEGIN IMMEDIATE').run();
    sibling.prepare(`
      INSERT INTO oauth_clients(
        client_id, registration_mode, token_endpoint_auth_method,
        client_secret, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('sibling_holding_writer', 'pre_registered_public', 'none', null, '{}', 'now', 'now');

    // New process opens with a tight busy_timeout. Without the retry,
    // the seed write inside the sibling's hold window would surface a
    // SQLITE_BUSY immediately.
    initDb(dbPath, { busyTimeoutMs: 25 });

    // Release the sibling lock shortly after seed begins. The retry
    // backoff (100ms initial) lets the second attempt land after this.
    setTimeout(() => {
      try { sibling.prepare('ROLLBACK').run(); } catch {}
    }, 50);

    const retryEvents = [];
    await seedPreRegisteredClients(
      [
        { client_id: 'seed_a', client_name: 'Seed A' },
        { client_id: 'seed_b', client_name: 'Seed B' },
      ],
      {
        onRetry: (info) => retryEvents.push(info),
        retry: { initialDelayMs: 30, maxDelayMs: 200, maxAttempts: 8 },
      },
    );

    assert.ok(retryEvents.length >= 1, 'expected at least one retry event');
    // Both clients should have been persisted after the retry succeeded.
    const reopened = new Database(dbPath, { readonly: true });
    const rows = reopened.prepare(
      'SELECT client_id FROM oauth_clients WHERE client_id IN (?, ?) ORDER BY client_id',
    ).all('seed_a', 'seed_b');
    reopened.close();
    assert.deepEqual(rows.map((r) => r.client_id), ['seed_a', 'seed_b']);
  } finally {
    try { sibling?.close(); } catch {}
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
