// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `ref.connector-schedule.get` operation.
 *
 * Spec: openspec/changes/mount-ref-schedules-operations
 *
 * The shared `operations-boundary.test.js` walks every operation module
 * and asserts the canonical forbidden-import list. This file pins the
 * operation-specific assertions: the per-connector schedule operation
 * must not statically import the runtime controller, the scheduler
 * store, the server auth module, or the server index. The operation
 * surfaces a typed not-found error for the host to translate into the
 * existing PDPP 404 envelope; the substrate read flows in through a
 * capability-shaped dependency.
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

const OP_REL = 'reference-implementation/operations/ref-connector-schedule-get/index.ts';

test('ref.connector-schedule.get operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('ref.connector-schedule.get operation does not import the runtime controller or scheduler store', () => {
  const src = read(OP_REL);
  for (const needle of ['/runtime/controller', 'scheduler-store', '/server/stores/']) {
    const fromPattern = new RegExp(`\\bfrom\\s*['"][^'"]*${needle}['"]`);
    assert.equal(
      fromPattern.test(src),
      false,
      `operation must not import ${needle}; substrate access flows through dependencies`,
    );
  }
});

test('ref.connector-schedule.get operation does not import server/auth.js or server/index.js', () => {
  const src = read(OP_REL);
  for (const needle of ['/server/auth', '/server/index']) {
    const fromPattern = new RegExp(`\\bfrom\\s*['"][^'"]*${needle}['"]`);
    assert.equal(
      fromPattern.test(src),
      false,
      `operation must not import ${needle}`,
    );
  }
});
