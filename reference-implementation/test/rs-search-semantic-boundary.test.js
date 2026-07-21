/**
 * Import-boundary guards for the `rs.search.semantic` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-search-semantic-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, sandbox modules,
 *     the native `server/search.js` helper module, the native
 *     `server/search-semantic.js` helper module, or `process` /
 *     `process.env`.
 *   - The operation-level lexical-helper import ban (`server/search.js`)
 *     is the operation-boundary realization of the file-level
 *     no-silent-fallback invariant pinned on `server/search-semantic.js`
 *     (see `semantic-retrieval.test.js` task 14.21/14.22). The
 *     `server/search-semantic.js` import ban prevents the operation from
 *     becoming a back door around that invariant.
 *
 * The operation-module boundary check delegates to the shared helper so
 * the forbidden-import list is the single source of truth across
 * operations (see openspec/changes/add-reference-operation-boundary-gate).
 * The `server/search.js` and `server/search-semantic.js` demotion
 * assertions remain operation-specific and stay here.
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

const OP_REL = 'reference-implementation/operations/rs-search-semantic/index.ts';

test('rs.search.semantic operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('rs.search.semantic operation does not import server/search.js (lexical helper)', () => {
  // The operation must not depend on the native `server/search.js` helper
  // module. This is the operation-boundary realization of the file-level
  // no-silent-fallback invariant on `server/search-semantic.js`.
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/search['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the native server/search.js lexical helper module',
  );
});

test('rs.search.semantic operation does not import server/search-semantic.js', () => {
  // The operation must not import the native `server/search-semantic.js`
  // helper module either. The native shell wires the operation against
  // dependencies; the operation must not reach back into the shell.
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/search-semantic['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the native server/search-semantic.js helper module',
  );
});
