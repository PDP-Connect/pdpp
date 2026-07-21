/**
 * Import-boundary guards for the `rs.streams.detail` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-rs-stream-detail-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Next, SQLite,
 *     Postgres, a raw SQL handle, a generic repository, or `process.env`.
 *   - The sandbox `/sandbox/v1/streams/:stream` route SHALL NOT import
 *     `buildLiveStreamMetadataResponse` (it must mount the canonical
 *     operation).
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

test('rs.streams.detail operation has no host or storage concretes', () => {
  const rel = 'reference-implementation/operations/rs-streams-detail/index.ts';
  assertOperationBoundary(read(rel), rel);
});

test('sandbox /sandbox/v1/streams/:stream route does not import buildLiveStreamMetadataResponse', () => {
  const src = read('apps/site/src/app/sandbox/v1/streams/[stream]/route.ts');
  const importPattern =
    /\bimport\b[^;]*\bbuildLiveStreamMetadataResponse\b[^;]*\bfrom\b[^;]*;/;
  assert.equal(
    importPattern.test(src),
    false,
    'public sandbox stream-detail route must mount the canonical operation, not buildLiveStreamMetadataResponse',
  );
});

test('sandbox builders.ts no longer exports buildLiveStreamMetadataResponse', () => {
  const src = read('apps/site/src/app/sandbox/_demo/builders.ts');
  assert.equal(
    /export\s+function\s+buildLiveStreamMetadataResponse\b/.test(src),
    false,
    'buildLiveStreamMetadataResponse must be removed so the public route cannot import a parallel AS/RS builder',
  );
});
