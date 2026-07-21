// Pure, no-DB unit tests for the deployment-report secret-leak guard in
// operations/ref-deployment/index.ts. No test imports it by name. This operation
// re-asserts, at the public-surface boundary, that a regressed dependency cannot
// leak an unredacted secret env value or emit an invalid provenance marker — a
// defense-in-depth guard on the deployment diagnostics endpoint.
//
// The report collector is stubbed so we exercise the guard directly.
//
// Mutation surface:
//   - an environment entry with a provenance other than present/absent/redacted throws.
//   - a `secret` entry with provenance='present' AND a non-null value throws
//     (secrets MUST be redacted); a null-valued present secret is allowed.
//   - a valid report passes through unchanged.

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRefDeployment } from '../operations/ref-deployment/index.ts';

function report(environment) {
  return { environment, service: 'pdpp-reference', version: '0.1.0' };
}

function deps(environment) {
  return { collectDeploymentReport: async () => report(environment) };
}

test('executeRefDeployment: a valid report (present non-secret, redacted secret, absent) passes through', async () => {
  const env = [
    { name: 'PORT', provenance: 'present', secret: false, value: '3000' },
    { name: 'DB_PASSWORD', provenance: 'redacted', secret: true, value: null },
    { name: 'OPTIONAL_FLAG', provenance: 'absent', secret: false, value: null },
  ];
  const out = await executeRefDeployment(deps(env));
  assert.deepEqual(out.environment, env, 'the report is returned unchanged');
  assert.equal(out.version, '0.1.0');
});

test('executeRefDeployment: an invalid provenance marker throws', async () => {
  await assert.rejects(
    executeRefDeployment(deps([{ name: 'X', provenance: 'maybe', secret: false, value: 'v' }])),
    /invalid provenance/,
  );
});

test('executeRefDeployment: SECRET LEAK — a present secret with a non-null value throws', async () => {
  await assert.rejects(
    executeRefDeployment(deps([{ name: 'API_KEY', provenance: 'present', secret: true, value: 'sk-live-123' }])),
    /leaked a secret env value/,
    'an unredacted secret value must be rejected at the boundary',
  );
});

test('executeRefDeployment: a present secret with a NULL value is allowed (properly redacted)', async () => {
  const env = [{ name: 'API_KEY', provenance: 'present', secret: true, value: null }];
  const out = await executeRefDeployment(deps(env));
  assert.deepEqual(out.environment, env);
});

test('executeRefDeployment: a present NON-secret with a value is fine (only secrets are guarded)', async () => {
  const env = [{ name: 'LOG_LEVEL', provenance: 'present', secret: false, value: 'info' }];
  const out = await executeRefDeployment(deps(env));
  assert.deepEqual(out.environment, env);
});

test('executeRefDeployment: the guard scans every entry (a leak anywhere in the list is caught)', async () => {
  await assert.rejects(
    executeRefDeployment(deps([
      { name: 'OK', provenance: 'present', secret: false, value: 'v' },
      { name: 'OK2', provenance: 'redacted', secret: true, value: null },
      { name: 'LEAK', provenance: 'present', secret: true, value: 'oops' }, // last entry leaks
    ])),
    /leaked a secret env value for LEAK/,
  );
});
