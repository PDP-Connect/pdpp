/**
 * Import-boundary guards for the `ref.spine.correlations.list` operation.
 *
 * Spec: openspec/changes/mount-ref-spine-operations
 *
 * The shared `operations-boundary.test.js` walks every operation module
 * and asserts the canonical forbidden-import list. This file pins the
 * operation-specific assertions: no static import of `lib/spine.ts`,
 * `lib/db.ts`, the host server, or the auth module. Spine reads flow
 * in via the `listSpineCorrelations` dependency.
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

const OP_REL = 'reference-implementation/operations/ref-spine-correlations-list/index.ts';

test('ref.spine.correlations.list operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('ref.spine.correlations.list operation does not import lib/spine or lib/db', () => {
  const src = read(OP_REL);
  for (const needle of ['lib/spine', 'lib/db']) {
    const fromPattern = new RegExp(`\\bfrom\\s*['"][^'"]*${needle}['"]`);
    assert.equal(
      fromPattern.test(src),
      false,
      `operation must not import ${needle}; spine reads flow in via dependencies`,
    );
  }
});

test('ref.spine.correlations.list operation does not import server modules', () => {
  const src = read(OP_REL);
  for (const needle of ['/server/auth', '/server/index', '/server/ref-control']) {
    const fromPattern = new RegExp(`\\bfrom\\s*['"][^'"]*${needle}['"]`);
    assert.equal(
      fromPattern.test(src),
      false,
      `operation must not import ${needle}`,
    );
  }
});
