/**
 * Import-boundary guards for the `rs.connector-state.get` operation.
 *
 * Spec: openspec/changes/complete-reference-operation-refactor
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

const OP_REL = 'reference-implementation/operations/rs-connector-state-get/index.ts';

test('rs.connector-state.get operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('rs.connector-state.get operation does not import server/index.js', () => {
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/index['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the Fastify host module',
  );
});

test('rs.connector-state.get operation does not import server/records.js', () => {
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/records['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the native records module (which pulls SQLite)',
  );
});
