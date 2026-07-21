// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `rs.streams.list` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-streams-list-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, or `process.env`.
 *   - The sandbox `/sandbox/v1/streams` route SHALL NOT import
 *     `buildLiveStreamsList` (it must mount the canonical operation).
 *
 * The operation-module boundary check delegates to the shared helper so the
 * forbidden-import list is the single source of truth across operations
 * (see openspec/changes/add-reference-operation-boundary-gate). Sandbox-route
 * and `_demo/builders.ts` demotion assertions remain operation-specific and
 * stay here.
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

test('rs.streams.list operation has no host or storage concretes', () => {
  const rel = 'reference-implementation/operations/rs-streams-list/index.ts';
  assertOperationBoundary(read(rel), rel);
});

test('sandbox /sandbox/v1/streams route does not import buildLiveStreamsList', () => {
  const src = read('apps/site/src/app/sandbox/v1/streams/route.ts');
  // Match any static-import statement that pulls buildLiveStreamsList in.
  // Comments referencing the deleted symbol are still allowed; only
  // import-binding usage is forbidden.
  const importPattern =
    /\bimport\b[^;]*\bbuildLiveStreamsList\b[^;]*\bfrom\b[^;]*;/;
  assert.equal(
    importPattern.test(src),
    false,
    'public sandbox stream-list route must mount the canonical operation, not buildLiveStreamsList',
  );
});

test('sandbox builders.ts no longer exports buildLiveStreamsList', () => {
  const src = read('apps/site/src/app/sandbox/_demo/builders.ts');
  assert.equal(
    /export\s+function\s+buildLiveStreamsList\b/.test(src),
    false,
    'buildLiveStreamsList must be removed so the public route cannot import a parallel AS/RS builder',
  );
});

test('polyfill owner stream list is manifest-scoped, not raw storage-scoped', () => {
  const src = read('reference-implementation/server/routes/rs-read.ts');
  assert.match(
    src,
    /async function listExplicitPolyfillOwnerStreams[\s\S]*buildOwnerReadGrantForManifest\(ownerResolved\.manifest\)[\s\S]*ctx\.listStreamsAcrossBindings\(/,
    'explicit polyfill owner stream lists must use manifest-grant-scoped summaries',
  );
  assert.equal(
    /listSummaries:\s*async\s*\(\)\s*=>\s*ctx\.listAllStreams\(ownerResolved\.storageBinding\)/.test(src),
    false,
    'explicit owner connector scope must not expose raw storage streams that manifest/detail/records routes reject',
  );
});
