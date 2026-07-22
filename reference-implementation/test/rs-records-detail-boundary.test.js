// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `rs.records.get` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-record-read-operations/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, sandbox modules,
 *     or `process` / `process.env`.
 *   - The sandbox
 *     `/sandbox/v1/streams/:stream/records/:recordId` route SHALL NOT
 *     import `buildLiveRecordDetail` (it must mount the canonical
 *     operation).
 *   - `_demo/builders.ts` SHALL no longer export `buildLiveRecordDetail`.
 *
 * The operation-module boundary check delegates to the shared helper so
 * the forbidden-import list is the single source of truth across
 * operations (see openspec/changes/add-reference-operation-boundary-gate).
 * Sandbox-route and `_demo/builders.ts` demotion assertions remain
 * operation-specific and stay here.
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

test('rs.records.get operation has no host or storage concretes', () => {
  const rel = 'reference-implementation/operations/rs-records-detail/index.ts';
  assertOperationBoundary(read(rel), rel);
});

test('sandbox /sandbox/v1/streams/:stream/records/:recordId route does not import buildLiveRecordDetail', () => {
  const src = read(
    'apps/site/src/app/sandbox/v1/streams/[stream]/records/[recordId]/route.ts',
  );
  const importPattern =
    /\bimport\b[^;]*\bbuildLiveRecordDetail\b[^;]*\bfrom\b[^;]*;/;
  assert.equal(
    importPattern.test(src),
    false,
    'public sandbox record-detail route must mount the canonical operation, not buildLiveRecordDetail',
  );
});

test('sandbox builders.ts no longer exports buildLiveRecordDetail', () => {
  const src = read('apps/site/src/app/sandbox/_demo/builders.ts');
  assert.equal(
    /export\s+function\s+buildLiveRecordDetail\b/.test(src),
    false,
    'buildLiveRecordDetail must be removed so the public route cannot import a parallel AS/RS builder',
  );
});
