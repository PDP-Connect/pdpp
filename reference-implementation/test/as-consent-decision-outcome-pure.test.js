// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the consent decision (approve/deny) operation in
// operations/as-consent-decision/index.ts. No test imports it by name. It resolves
// a pending consent from request_uri OR approval_id, then approves (minting a grant
// + token) or denies it — the operator/owner consent-decision contract.
//
// RED note: auth-surface. Tests OBSERVE the branch/outcome mapping with stubbed
// store capabilities; no grant/token is actually minted or persisted.
//
// Mutation surface:
//   - neither request_uri nor approval_id -> 400/invalid_request.
//   - approval_id with a non-pending / missing row -> 404/not_found.
//   - request_uri resolving to no device code -> 400/invalid_request.
//   - approve -> success/action=approve with grant+token (+ package fields when present).
//   - deny -> success/action=deny; a failed deny (falsy) -> 404/not_found.
//   - traceContext from pending.request.trace_context.

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAsConsentDecision } from '../operations/as-consent-decision/index.ts';

// A deps stub whose pending resolution returns a usable device code + pending row.
function resolvingDeps(overrides = {}) {
  return {
    getPendingConsentByApprovalId: async () => ({ status: 'pending', device_code: 'dc-1' }),
    buildPendingConsentRequestUri: (deviceCode) => `urn:req:${deviceCode}`,
    getPendingFromRequestUri: async () => ({
      deviceCode: 'dc-1',
      pending: { request: { trace_context: { trace_id: 'T' } } },
    }),
    approveGrant: async () => ({ grant: { id: 'g-1' }, token: 'tok-1' }),
    denyGrant: async () => true,
    ...overrides,
  };
}

test('executeAsConsentDecision: neither request_uri nor approval_id is a 400 invalid_request', async () => {
  const out = await executeAsConsentDecision({ action: 'approve' }, resolvingDeps());
  assert.equal(out.outcome, 'failure');
  assert.equal(out.status, 400);
  assert.equal(out.errorCode, 'invalid_request');
});

test('executeAsConsentDecision: an approval_id with a non-pending row is a 404 not_found', async () => {
  const out = await executeAsConsentDecision(
    { action: 'approve', approvalId: 'ap-1' },
    resolvingDeps({ getPendingConsentByApprovalId: async () => ({ status: 'consumed', device_code: 'dc-1' }) }),
  );
  assert.equal(out.status, 404);
  assert.equal(out.errorCode, 'not_found');
});

test('executeAsConsentDecision: a request_uri that resolves to no device code is a 400', async () => {
  const out = await executeAsConsentDecision(
    { action: 'approve', requestUri: 'urn:req:missing' },
    resolvingDeps({ getPendingFromRequestUri: async () => ({ deviceCode: null, pending: null }) }),
  );
  assert.equal(out.status, 400);
  assert.equal(out.errorCode, 'invalid_request');
});

test('executeAsConsentDecision: approve returns a success/approve outcome with grant + token', async () => {
  let approvedDeviceCode = null;
  const out = await executeAsConsentDecision(
    { action: 'approve', requestUri: 'urn:req:dc-1', subjectId: 'owner', approveOptions: {} },
    resolvingDeps({
      approveGrant: async (dc) => {
        approvedDeviceCode = dc;
        return { grant: { id: 'g-9' }, token: 'tok-9' };
      },
    }),
  );
  assert.equal(approvedDeviceCode, 'dc-1', 'approve is called with the resolved device code');
  assert.equal(out.outcome, 'success');
  assert.equal(out.action, 'approve');
  assert.deepEqual(out.grant, { id: 'g-9' });
  assert.equal(out.token, 'tok-9');
  assert.deepEqual(out.traceContext, { trace_id: 'T' }, 'trace context surfaced from pending');
  assert.ok(!('package' in out), 'no package fields when the grant is not a package');
});

test('executeAsConsentDecision: approve surfaces package fields when the grant is a package', async () => {
  const out = await executeAsConsentDecision(
    { action: 'approve', requestUri: 'urn:req:dc-1' },
    resolvingDeps({
      approveGrant: async () => ({ grant: { id: 'g' }, token: 't', package: true, package_id: 'pkg-1' }),
    }),
  );
  assert.equal(out.package, true);
  assert.equal(out.package_id, 'pkg-1');
});

test('executeAsConsentDecision: deny returns a success/deny outcome', async () => {
  const out = await executeAsConsentDecision({ action: 'deny', requestUri: 'urn:req:dc-1' }, resolvingDeps());
  assert.equal(out.outcome, 'success');
  assert.equal(out.action, 'deny');
  assert.ok(!('token' in out), 'a deny has no token');
});

test('executeAsConsentDecision: a deny that removes nothing (falsy) is a 404 not_found', async () => {
  const out = await executeAsConsentDecision(
    { action: 'deny', requestUri: 'urn:req:dc-1' },
    resolvingDeps({ denyGrant: async () => false }),
  );
  assert.equal(out.status, 404);
  assert.equal(out.errorCode, 'not_found');
});

test('executeAsConsentDecision: an approval_id resolves through to approve (device code from the row)', async () => {
  let builtFrom = null;
  const out = await executeAsConsentDecision(
    { action: 'approve', approvalId: 'ap-2' },
    resolvingDeps({
      getPendingConsentByApprovalId: async () => ({ status: 'pending', device_code: 'dc-from-row' }),
      buildPendingConsentRequestUri: (dc) => { builtFrom = dc; return `urn:req:${dc}`; },
    }),
  );
  assert.equal(builtFrom, 'dc-from-row', 'request_uri built from the row device code');
  assert.equal(out.outcome, 'success');
  assert.equal(out.action, 'approve');
});
