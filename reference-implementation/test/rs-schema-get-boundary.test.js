/**
 * Import-boundary guards for the `rs.schema.get` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-schema-get-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, sandbox UI/page
 *     code, or `process.env`.
 *   - The sandbox `/sandbox/v1/schema` route SHALL NOT import
 *     `buildLiveSchemaResponse` (it must mount the canonical operation).
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

test('rs.schema.get operation has no host or storage concretes', () => {
  const src = read('reference-implementation/operations/rs-schema-get/index.ts');

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
    // Sandbox UI/page code must not be reachable from the operation.
    'apps/web',
    '_demo/',
  ];
  for (const needle of forbidden) {
    assert.equal(
      src.includes(`from '${needle}`) || src.includes(`from "${needle}`),
      false,
      `rs.schema.get operation must not import "${needle}" (got match in operations/rs-schema-get/index.ts)`,
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
    'rs.schema.get operation must not read process.env',
  );
});

test('sandbox /sandbox/v1/schema route does not import buildLiveSchemaResponse', () => {
  const src = read('apps/web/src/app/sandbox/v1/schema/route.ts');
  const importPattern =
    /\bimport\b[^;]*\bbuildLiveSchemaResponse\b[^;]*\bfrom\b[^;]*;/;
  assert.equal(
    importPattern.test(src),
    false,
    'public sandbox schema route must mount the canonical operation, not buildLiveSchemaResponse',
  );
});

test('sandbox builders.ts no longer exports buildLiveSchemaResponse', () => {
  const src = read('apps/web/src/app/sandbox/_demo/builders.ts');
  assert.equal(
    /export\s+function\s+buildLiveSchemaResponse\b/.test(src),
    false,
    'buildLiveSchemaResponse must be removed so the public route cannot import a parallel AS/RS builder',
  );
});
