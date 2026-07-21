/**
 * Import-boundary guards for the `rs.search.lexical` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-search-lexical-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, sandbox modules,
 *     the native `server/search.js` helper module, or `process` /
 *     `process.env`.
 *   - The sandbox `/sandbox/v1/search` route SHALL NOT statically import
 *     `buildLiveSearchResponse` (it must mount the canonical operation).
 *   - `_demo/builders.ts` SHALL no longer export
 *     `buildLiveSearchResponse`.
 *
 * The operation-module boundary check delegates to the shared helper so
 * the forbidden-import list is the single source of truth across
 * operations (see openspec/changes/add-reference-operation-boundary-gate).
 * Sandbox-route and `_demo/builders.ts` demotion assertions remain
 * operation-specific and stay here.
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

test('rs.search.lexical operation has no host or storage concretes', () => {
  const rel = 'reference-implementation/operations/rs-search-lexical/index.ts';
  assertOperationBoundary(read(rel), rel);
});

test('rs.search.lexical operation does not import server/search.js', () => {
  // The operation must not depend on the native `server/search.js` helper
  // module (which carries the FTS5/SQLite snapshot machinery). The shared
  // boundary already forbids `../server/...` imports for `auth`, `records`,
  // and `index`; this assertion adds explicit coverage for `search.js`.
  const rel = 'reference-implementation/operations/rs-search-lexical/index.ts';
  const src = read(rel);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/search['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the native server/search.js helper module',
  );
});

test('sandbox /sandbox/v1/search route does not import buildLiveSearchResponse', () => {
  const src = read('apps/site/src/app/sandbox/v1/search/route.ts');
  // Match any static-import statement that pulls buildLiveSearchResponse
  // in. Comments referencing the deleted symbol are still allowed; only
  // import-binding usage is forbidden.
  const importPattern =
    /\bimport\b[^;]*\bbuildLiveSearchResponse\b[^;]*\bfrom\b[^;]*;/;
  assert.equal(
    importPattern.test(src),
    false,
    'public sandbox search route must mount the canonical operation, not buildLiveSearchResponse',
  );
});

test('sandbox builders.ts no longer exports buildLiveSearchResponse', () => {
  const src = read('apps/site/src/app/sandbox/_demo/builders.ts');
  assert.equal(
    /export\s+function\s+buildLiveSearchResponse\b/.test(src),
    false,
    'buildLiveSearchResponse must be removed so the public route cannot import a parallel AS/RS builder',
  );
});
