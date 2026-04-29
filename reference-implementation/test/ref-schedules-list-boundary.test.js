/**
 * Import-boundary guards for the `ref.schedules.list` operation.
 *
 * Spec: openspec/changes/mount-ref-schedules-operations
 *
 * The shared `operations-boundary.test.js` walks every operation module
 * and asserts the canonical forbidden-import list. This file pins the
 * operation-specific assertions: the schedule-list operation must not
 * statically import the runtime controller, the scheduler store, the
 * server auth module, or the server index. Schedule reads flow in
 * through capability-shaped dependencies so a regression in any of those
 * substrate modules cannot reach the operation directly.
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

const OP_REL = 'reference-implementation/operations/ref-schedules-list/index.ts';

test('ref.schedules.list operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('ref.schedules.list operation does not import the runtime controller or scheduler store', () => {
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

test('ref.schedules.list operation does not import server/auth.js or server/index.js', () => {
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
