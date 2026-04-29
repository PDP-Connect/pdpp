/**
 * Import-boundary guards for the `ref.records.timeline` operation.
 *
 * Spec: openspec/changes/complete-reference-operation-refactor
 *
 * The shared `operations-boundary.test.js` walks every operation module
 * and asserts the canonical forbidden-import list. This file pins the
 * operation-specific assertions: the records-timeline operation must
 * not statically import the ref-control substrate helper, the manifest
 * store, the server auth/index modules, or the records mutator. All
 * timeline reads flow in through capability-shaped dependencies.
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

const OP_REL = 'reference-implementation/operations/ref-records-timeline/index.ts';

test('ref.records.timeline operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('ref.records.timeline operation does not import the ref-control substrate or records module', () => {
  const src = read(OP_REL);
  for (const needle of ['/server/ref-control', '/server/records', '/server/ref-record-utils', '/lib/db', '/lib/spine']) {
    const fromPattern = new RegExp(`\\bfrom\\s*['"][^'"]*${needle}['"]`);
    assert.equal(
      fromPattern.test(src),
      false,
      `operation must not import ${needle}; substrate access flows through dependencies`,
    );
  }
});

test('ref.records.timeline operation does not import server/auth.js or server/index.js', () => {
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
