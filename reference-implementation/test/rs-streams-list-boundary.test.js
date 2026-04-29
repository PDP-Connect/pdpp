/**
 * Import-boundary guards for the `rs.streams.list` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-streams-list-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, or `process.env`.
 *   - The sandbox `/sandbox/v1/streams` route SHALL NOT import
 *     `buildLiveStreamsList` (it must mount the canonical operation).
 *
 * The check is grep-style on source: it does not execute the modules.
 * Trade-off: it cannot catch dynamically-resolved imports, but it does
 * catch the static-import drift class this slice is meant to prevent.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function read(rel) {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

test('rs.streams.list operation has no host or storage concretes', () => {
  const src = read('reference-implementation/operations/rs-streams-list/index.ts');

  // Forbidden module imports.
  const forbidden = [
    'fastify',
    'express',
    'next/',
    'better-sqlite3',
    './db',
    '../db',
    '../lib/db',
    '../server/db',
    '../server/records',
    '../server/auth',
    '../server/index',
    'pg', // postgres
  ];
  for (const needle of forbidden) {
    assert.equal(
      src.includes(`from '${needle}`) || src.includes(`from "${needle}`),
      false,
      `rs.streams.list operation must not import "${needle}" (got match in operations/rs-streams-list/index.ts)`,
    );
  }

  // process.env access is also forbidden. Strip comments first so
  // documentation that names the rule does not trip the guard.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.equal(
    stripped.includes('process.env'),
    false,
    'rs.streams.list operation must not read process.env',
  );
});

test('sandbox /sandbox/v1/streams route does not import buildLiveStreamsList', () => {
  const src = read('apps/web/src/app/sandbox/v1/streams/route.ts');
  // Match any static-import statement that pulls buildLiveStreamsList in.
  // Comments referencing the deleted symbol are still allowed; only
  // import-binding usage is forbidden.
  const importPattern =
    /\bimport\b[^;]*\bbuildLiveStreamsList\b[^;]*\bfrom\b[^;]*;/;
  assert.equal(
    importPattern.test(src),
    false,
    'public sandbox stream-list route must mount the canonical operation, not buildLiveStreamsList',
  );
});

test('sandbox builders.ts no longer exports buildLiveStreamsList', () => {
  const src = read('apps/web/src/app/sandbox/_demo/builders.ts');
  assert.equal(
    /export\s+function\s+buildLiveStreamsList\b/.test(src),
    false,
    'buildLiveStreamsList must be removed so the public route cannot import a parallel AS/RS builder',
  );
});
