import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDb, initDb } from '../server/db.js';

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
