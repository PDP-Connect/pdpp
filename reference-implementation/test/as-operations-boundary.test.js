/**
 * Import-boundary guards for the AS operation modules.
 *
 * Spec: openspec/changes/complete-reference-operation-refactor.
 *
 * `operations-boundary.test.js` walks every operation module and asserts the
 * canonical forbidden-import list. This file pins the AS-specific
 * assertions: no static import of the host `server/index.js` module
 * (the Express host) or `server/auth.js` (which transitively pulls SQLite),
 * for every AS operation introduced by this refactor.
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

const AS_OPERATIONS = [
  'as-discovery-index',
  'as-authorization-server-metadata',
  'as-dcr-register',
  'as-dcr-delete',
  'as-device-authorization-init',
  'as-device-token-exchange',
  'as-device-decision',
  'as-introspect',
  'as-polyfill-connector-register',
  'as-polyfill-connector-detail',
  'as-par-create',
  'as-consent-decision',
  'as-consent-exchange',
  'as-grant-revoke',
];

for (const name of AS_OPERATIONS) {
  const rel = `reference-implementation/operations/${name}/index.ts`;
  test(`${name}: canonical operation boundary`, () => {
    assertOperationBoundary(read(rel), rel);
  });

  test(`${name}: does not import server/index.js`, () => {
    const src = read(rel);
    assert.equal(
      /\bfrom\s*['"][^'"]*\/server\/index['"]/.test(src),
      false,
      `${rel}: operation must not import the Express host module`,
    );
  });

  test(`${name}: does not import server/auth.js`, () => {
    const src = read(rel);
    assert.equal(
      /\bfrom\s*['"][^'"]*\/server\/auth['"]/.test(src),
      false,
      `${rel}: operation must not import the native auth module (which pulls SQLite)`,
    );
  });
}
