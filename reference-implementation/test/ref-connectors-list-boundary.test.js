// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `ref.connectors.list` operation.
 *
 * Spec: openspec/changes/mount-ref-connectors-approvals-operations
 *
 * The shared `operations-boundary.test.js` walks every operation module and
 * asserts the canonical forbidden-import list. This file pins the
 * operation-specific assertions: no static import of the host
 * `server/ref-control.ts` module (which transitively pulls SQLite + auth
 * internals), and no static import of `server/index.js` (the Fastify host).
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

const OP_REL = 'reference-implementation/operations/ref-connectors-list/index.ts';

test('ref.connectors.list operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('ref.connectors.list operation does not import server/ref-control.ts', () => {
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/ref-control['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the native server/ref-control module (which pulls SQLite + auth internals)',
  );
});

test('ref.connectors.list operation does not import server/index.js', () => {
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/index['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the Fastify host module',
  );
});
