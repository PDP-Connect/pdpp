/**
 * Import-boundary guards for the `ref.approvals.list` operation.
 *
 * Spec: openspec/changes/mount-ref-connectors-approvals-operations
 *
 * The shared `operations-boundary.test.js` walks every operation module
 * and asserts the canonical forbidden-import list. This file pins the
 * operation-specific assertions: no static import of the host
 * `server/ref-control.ts`, the consent / owner-device stores, the
 * `server/auth.js` module, or `server/index.js`. The approvals queue is
 * security-sensitive (device-code-equivalent secrets must not leak
 * through `request_uri` or `user_code`); the operation must remain a
 * dependency-injection boundary so a regression in any of those substrate
 * modules cannot reach the operation directly.
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

const OP_REL = 'reference-implementation/operations/ref-approvals-list/index.ts';

test('ref.approvals.list operation has no host or storage concretes', () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test('ref.approvals.list operation does not import server/ref-control.ts', () => {
  const src = read(OP_REL);
  const fromPattern = /\bfrom\s*['"][^'"]*\/server\/ref-control['"]/;
  assert.equal(
    fromPattern.test(src),
    false,
    'operation must not import the native server/ref-control module',
  );
});

test('ref.approvals.list operation does not import the consent or owner-device stores', () => {
  const src = read(OP_REL);
  for (const needle of ['consent-store', 'owner-device-auth-store']) {
    const fromPattern = new RegExp(`\\bfrom\\s*['"][^'"]*${needle}['"]`);
    assert.equal(
      fromPattern.test(src),
      false,
      `operation must not import ${needle}; substrate access flows through dependencies`,
    );
  }
});

test('ref.approvals.list operation does not import server/auth.js or server/index.js', () => {
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
