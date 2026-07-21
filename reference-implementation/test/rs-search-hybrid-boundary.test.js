// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `rs.search.hybrid` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-search-hybrid-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, sandbox modules,
 *     the native `server/search.js` lexical helper module, the native
 *     `server/search-semantic.js` helper module, the native
 *     `server/search-hybrid.js` helper module, or `process` /
 *     `process.env`.
 *   - The lexical and semantic helper import bans are load-bearing: this
 *     operation does NOT itself reach into either underlying retrieval
 *     surface; it consumes already-grant-filtered per-source result
 *     envelopes through capability dependencies. The
 *     `server/search-hybrid.js` import ban prevents the operation from
 *     becoming a back door around the no-fallback invariant.
 *
 * The operation-module boundary check delegates to the shared helper so
 * the forbidden-import list is the single source of truth across
 * operations (see openspec/changes/add-reference-operation-boundary-gate).
 * The `server/search.js`, `server/search-semantic.js`, and
 * `server/search-hybrid.js` demotion assertions remain operation-specific
 * and stay here.
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

const OP_REL = 'reference-implementation/operations/rs-search-hybrid/index.ts';

test('rs.search.hybrid operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('rs.search.hybrid operation does not import server/search.js (lexical helper)', () => {
  // The operation must not depend on the native `server/search.js` helper
  // module. The shell wires the lexical runner as a capability dependency;
  // the operation only sees the per-source result envelope.
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/search['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the native server/search.js lexical helper module',
  );
});

test('rs.search.hybrid operation does not import server/search-semantic.js', () => {
  // Same rule as above for the semantic helper.
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/search-semantic['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the native server/search-semantic.js helper module',
  );
});

test('rs.search.hybrid operation does not import server/search-hybrid.js', () => {
  // The operation must not import the native `server/search-hybrid.js`
  // helper module either. The native shell wires the operation against
  // dependencies; the operation must not reach back into the shell.
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/search-hybrid['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the native server/search-hybrid.js helper module',
  );
});
