/**
 * Import-boundary guards for the `ref.dataset.summary` operation.
 *
 * Enforces the dependency direction declared in
 * openspec/changes/mount-ref-dataset-summary-operation/design.md:
 *
 *   - The operation module SHALL NOT import Fastify, Express, Next, SQLite,
 *     Postgres, a raw SQL handle, sandbox modules, the native
 *     `server/records.js` helper module, the native `server/index.js`
 *     module, or `process` / `process.env`.
 *   - The sandbox `/sandbox/_ref/dataset/summary` route SHALL NOT
 *     statically import `buildLiveDatasetSummary` (it must mount the
 *     canonical operation).
 *   - `_demo/builders.ts` SHALL no longer export
 *     `buildLiveDatasetSummary`.
 *
 * The operation-module boundary check delegates to the shared helper so the
 * forbidden-import list is the single source of truth across operations
 * (see openspec/changes/add-reference-operation-boundary-gate). Sandbox-
 * route and `_demo/builders.ts` demotion assertions remain operation-
 * specific and stay here.
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

test('ref.dataset.summary operation has no host or storage concretes', () => {
  const rel = 'reference-implementation/operations/ref-dataset-summary/index.ts';
  assertOperationBoundary(read(rel), rel);
});

test('ref.dataset.summary operation does not import server/records.js', () => {
  // The operation must not depend on the native `server/records.js` helper
  // module (which carries the SQLite aggregates and bounded-row helpers).
  // The shared boundary already forbids `../server/...` imports for `auth`,
  // `records`, and `index`; this assertion adds explicit coverage so a
  // future bypass via a relative-path or differently-spelled import still
  // fails the gate.
  const rel = 'reference-implementation/operations/ref-dataset-summary/index.ts';
  const src = read(rel);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/records['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the native server/records.js helper module',
  );
});

test('sandbox /sandbox/_ref/dataset/summary route does not import buildLiveDatasetSummary', () => {
  const src = read('apps/web/src/app/sandbox/ref/dataset/summary/route.ts');
  // Match any static-import statement that pulls buildLiveDatasetSummary in.
  // Comments referencing the deleted symbol are still allowed; only
  // import-binding usage is forbidden.
  const importPattern =
    /\bimport\b[^;]*\bbuildLiveDatasetSummary\b[^;]*\bfrom\b[^;]*;/;
  assert.equal(
    importPattern.test(src),
    false,
    'public sandbox dataset-summary route must mount the canonical operation, not buildLiveDatasetSummary',
  );
});

test('sandbox builders.ts no longer exports buildLiveDatasetSummary', () => {
  const src = read('apps/web/src/app/sandbox/_demo/builders.ts');
  assert.equal(
    /export\s+function\s+buildLiveDatasetSummary\b/.test(src),
    false,
    'buildLiveDatasetSummary must be removed so the public route cannot import a parallel envelope writer',
  );
});

test('sandbox builders.ts no longer exports LiveDatasetSummary', () => {
  const src = read('apps/web/src/app/sandbox/_demo/builders.ts');
  // The interface previously co-located with the builder is also demoted —
  // the operation owns the envelope shape via `RefDatasetSummaryEnvelope`.
  assert.equal(
    /export\s+interface\s+LiveDatasetSummary\b/.test(src),
    false,
    'LiveDatasetSummary interface must be removed so the public surface relies on the operation envelope type',
  );
});

test('sandbox dashboard data source mounts ref.dataset.summary instead of building a live envelope locally', () => {
  // The sandbox dashboard data source is part of the public sandbox
  // experience: shared dashboard feature views render against it. Letting
  // it construct its own live-shaped `dataset_summary` envelope is the
  // same drift class as the public route doing so. The previous local
  // mapping (`built.blob_bytes` → `record_json_bytes`,
  // `built.earliest_record_time` → `earliest_ingested_at`, etc.) silently
  // disagreed with the canonical route. The fix mounts the operation;
  // this test pins it.
  const src = read('apps/web/src/app/sandbox/_demo/data-source.ts');
  assert.ok(
    /\bexecuteRefDatasetSummary\b/.test(src),
    'sandbox dashboard data source must call the canonical ref.dataset.summary operation',
  );
  assert.ok(
    /\bcreateSandboxRefDatasetSummaryDependencies\b/.test(src),
    'sandbox dashboard data source must wire the sandbox fixture dependencies',
  );
  // `buildDatasetSummary` (a different demo-shaped helper) may still
  // exist in `_demo/builders.ts` for non-live demo content; what must NOT
  // exist is the data source importing or calling it. Catch both forms.
  assert.equal(
    /\bimport\b[^;]*\bbuildDatasetSummary\b[^;]*\bfrom\b[^;]*;/.test(src),
    false,
    'sandbox dashboard data source must not import the demo-shaped buildDatasetSummary',
  );
  assert.equal(
    /\bbuildDatasetSummary\s*\(/.test(src),
    false,
    'sandbox dashboard data source must not call buildDatasetSummary — the operation owns the envelope',
  );
});
