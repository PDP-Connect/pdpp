// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `ref.clients.list` operation.
 *
 * Spec: openspec/changes/complete-reference-operation-refactor
 *
 * The shared `operations-boundary.test.js` walks every operation module
 * and asserts the canonical forbidden-import list. This file pins the
 * operation-specific assertions: the clients-list operation must not
 * statically import `server/auth.js` (where `listOwnerIssuedClients`
 * lives), the server index, or any storage substrate. Per-operator
 * client reads flow in through capability-shaped dependencies.
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

const OP_REL = 'reference-implementation/operations/ref-clients-list/index.ts';

test('ref.clients.list operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('ref.clients.list operation does not import server/auth.js or the server index', () => {
  const src = read(OP_REL);
  for (const needle of ['/server/auth', '/server/index']) {
    const fromPattern = new RegExp(`\\bfrom\\s*['"][^'"]*${needle}['"]`);
    assert.equal(
      fromPattern.test(src),
      false,
      `operation must not import ${needle}; client reads flow through dependencies`,
    );
  }
});

test('ref.clients.list operation does not import any storage substrate module', () => {
  const src = read(OP_REL);
  for (const needle of ['/lib/db', '/server/db', '/server/stores/']) {
    const fromPattern = new RegExp(`\\bfrom\\s*['"][^'"]*${needle}['"]`);
    assert.equal(
      fromPattern.test(src),
      false,
      `operation must not import ${needle}`,
    );
  }
});
