/**
 * Generalized boundary gate for canonical reference operations.
 *
 * Discovers every `reference-implementation/operations/<name>/index.ts` and
 * asserts that the module obeys the shared boundary rule (no static imports of
 * Fastify, Express, Next, SQLite, Postgres, raw SQL handles, server-internal
 * repository/auth/index modules, sandbox UI/page code, or `_demo/` builders;
 * no executable `process.env` access).
 *
 * Per-operation tests (rs-streams-list-boundary.test.js and friends) keep their
 * sandbox-route and `_demo/builders.ts` demotion assertions; the operation-module
 * boundary check is centralized here so adding a new operation does not silently
 * bypass the gate.
 *
 * Spec: openspec/changes/add-reference-operation-boundary-gate/
 *       specs/reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertOperationBoundaryAtPath,
  discoverOperationModules,
} from './helpers/operation-boundary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const operations = discoverOperationModules(repoRoot);

test('operations directory yields at least one canonical operation module', () => {
  assert.ok(
    operations.length > 0,
    `expected at least one operation module under reference-implementation/operations/<name>/index.ts; found 0. ` +
      `If the directory has been moved or renamed, update discoverOperationModules accordingly so the gate is not silently neutered.`,
  );
});

for (const op of operations) {
  test(`operation ${op.name} obeys the canonical boundary rule`, () => {
    assertOperationBoundaryAtPath(op.absPath, op.relPath);
  });
}
