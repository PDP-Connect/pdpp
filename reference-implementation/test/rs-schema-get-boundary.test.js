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
 * The operation-module boundary check delegates to the shared helper so the
 * forbidden-import list is the single source of truth across operations
 * (see openspec/changes/add-reference-operation-boundary-gate). Sandbox-route
 * and `_demo/builders.ts` demotion assertions remain operation-specific and
 * stay here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertOperationBoundary } from './helpers/operation-boundary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function read(rel) {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

test('rs.schema.get operation has no host or storage concretes', () => {
  const rel = 'reference-implementation/operations/rs-schema-get/index.ts';
  assertOperationBoundary(read(rel), rel);
});

test('sandbox /sandbox/v1/schema route does not import buildLiveSchemaResponse', () => {
  const src = read('apps/site/src/app/sandbox/v1/schema/route.ts');
  const importPattern =
    /\bimport\b[^;]*\bbuildLiveSchemaResponse\b[^;]*\bfrom\b[^;]*;/;
  assert.equal(
    importPattern.test(src),
    false,
    'public sandbox schema route must mount the canonical operation, not buildLiveSchemaResponse',
  );
});

test('sandbox builders.ts no longer exports buildLiveSchemaResponse', () => {
  const src = read('apps/site/src/app/sandbox/_demo/builders.ts');
  assert.equal(
    /export\s+function\s+buildLiveSchemaResponse\b/.test(src),
    false,
    'buildLiveSchemaResponse must be removed so the public route cannot import a parallel AS/RS builder',
  );
});
