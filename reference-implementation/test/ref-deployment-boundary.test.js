// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `ref.deployment` operation.
 *
 * Spec: openspec/changes/complete-reference-operation-refactor
 *
 * The shared `operations-boundary.test.js` walks every operation module
 * and asserts the canonical forbidden-import list. This file pins the
 * operation-specific assertions: the deployment-diagnostics operation
 * must not statically import the substrate helper that performs the
 * actual collection (`server/deployment-diagnostics.ts`), the server
 * auth/index modules, the SQL substrate, the semantic-search backend,
 * or the manifest store. The diagnostics report flows in through the
 * `collectDeploymentReport` capability so the operation cannot reach
 * `process.env` indirectly.
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

const OP_REL = 'reference-implementation/operations/ref-deployment/index.ts';

test('ref.deployment operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('ref.deployment operation does not import the deployment-diagnostics substrate helper', () => {
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/deployment-diagnostics['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import server/deployment-diagnostics; the report flows in through the dependency',
  );
});

test('ref.deployment operation does not import server/auth, server/index, or other substrate modules', () => {
  const src = read(OP_REL);
  for (const needle of [
    '/server/auth',
    '/server/index',
    '/server/db',
    '/server/search-semantic',
    '/server/records',
    '/lib/db',
  ]) {
    const fromPattern = new RegExp(`\\bfrom\\s*['"][^'"]*${needle}['"]`);
    assert.equal(
      fromPattern.test(src),
      false,
      `operation must not import ${needle}`,
    );
  }
});
