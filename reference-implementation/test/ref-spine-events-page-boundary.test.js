// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `ref.spine.events.page` operation.
 *
 * Spec: openspec/changes/mount-ref-spine-operations
 *
 * The operation owns the live-bearer redaction (the
 * `security-auth-surfaces` suite enforces the runtime guarantee through
 * the route). The boundary test pins that the operation cannot reach
 * substrate directly: spine reads flow through the host adapter, which
 * passes the already-fetched page in as input.
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

const OP_REL = 'reference-implementation/operations/ref-spine-events-page/index.ts';

test('ref.spine.events.page operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('ref.spine.events.page operation does not import lib/spine or lib/db', () => {
  const src = read(OP_REL);
  for (const needle of ['lib/spine', 'lib/db']) {
    const fromPattern = new RegExp(`\\bfrom\\s*['"][^'"]*${needle}['"]`);
    assert.equal(
      fromPattern.test(src),
      false,
      `operation must not import ${needle}; the host injects the spine page directly`,
    );
  }
});

test('ref.spine.events.page operation does not import server modules', () => {
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
