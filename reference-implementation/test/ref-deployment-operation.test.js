// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `ref.deployment`.
 *
 * Pins:
 *   - the operation calls `collectDeploymentReport` exactly once;
 *   - the operation passes the report through without mutation;
 *   - the operation enforces the env-redaction invariant: every
 *     `environment` entry must declare a known `provenance`, and a
 *     secret entry that is `present` with a non-null value is rejected
 *     so a regressed dependency cannot leak unredacted secrets.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRefDeployment } from '../operations/ref-deployment/index.ts';

function makeReport(overrides = {}) {
  return {
    database: { path: ':memory:' },
    environment: [
      { name: 'NODE_ENV', value: 'test', provenance: 'present', secret: false },
      { name: 'PDPP_OWNER_PASSWORD', value: null, provenance: 'redacted', secret: true },
    ],
    runtime_capabilities: {
      bindings: { browser: false, filesystem: false, local_device: false, network: true },
      collector_paired: false,
      in_container: false,
    },
    lexical: {
      backend: {
        active: 'sqlite_fts5',
        configured: false,
        fallback: false,
        pg_search: { available: false, state: 'not_applicable' },
      },
      index: { state: 'built', backfill_progress: null },
    },
    manifests: [],
    semantic: {
      backend: { configured: false, available: false },
      index: { kind: null, state: null, backfill_progress: null },
      participation: { tuples: [], connector_count: 0, stream_count: 0, field_count: 0 },
    },
    warnings: [],
    ...overrides,
  };
}

test('ref.deployment calls collectDeploymentReport exactly once and passes the report through', async () => {
  let calls = 0;
  const report = makeReport();
  const envelope = await executeRefDeployment({
    collectDeploymentReport: () => {
      calls += 1;
      return report;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(envelope, report);
});

test('ref.deployment awaits an async dependency', async () => {
  let resolved = false;
  const envelope = await executeRefDeployment({
    collectDeploymentReport: () =>
      new Promise((resolve) =>
        setImmediate(() => {
          resolved = true;
          resolve(makeReport());
        }),
      ),
  });
  assert.equal(resolved, true);
  assert.equal(envelope.database.path, ':memory:');
});

test('ref.deployment accepts every legal env provenance value', async () => {
  const envelope = await executeRefDeployment({
    collectDeploymentReport: () =>
      makeReport({
        environment: [
          { name: 'NODE_ENV', value: 'test', provenance: 'present', secret: false },
          { name: 'AS_PORT', value: null, provenance: 'absent', secret: false },
          { name: 'PDPP_OWNER_PASSWORD', value: null, provenance: 'redacted', secret: true },
        ],
      }),
  });
  assert.equal(envelope.environment.length, 3);
});

test('ref.deployment rejects an environment entry with an unknown provenance', async () => {
  await assert.rejects(
    () =>
      executeRefDeployment({
        collectDeploymentReport: () =>
          makeReport({
            environment: [
              { name: 'NODE_ENV', value: 'test', provenance: 'leaked', secret: false },
            ],
          }),
      }),
    /invalid provenance/,
  );
});

test('ref.deployment rejects a secret env value emitted with provenance=present and a non-null value', async () => {
  await assert.rejects(
    () =>
      executeRefDeployment({
        collectDeploymentReport: () =>
          makeReport({
            environment: [
              {
                name: 'PDPP_OWNER_PASSWORD',
                value: 'should-have-been-redacted',
                provenance: 'present',
                secret: true,
              },
            ],
          }),
      }),
    /leaked a secret env value/,
  );
});
