// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the device-authorization decision (approve/deny)
// operation in operations/as-device-decision/index.ts. No test imports it by name.
// It resolves a device authorization from user_code OR approval_id, then approves
// or denies it — the RFC 8628 verification-UI decision contract.
//
// RED note: auth-surface. Tests OBSERVE the branch/dispatch mapping with stubbed
// store capabilities; no token is minted.
//
// Mutation surface:
//   - neither user_code nor approval_id -> 400/invalid_request.
//   - approval_id with a non-pending / missing row -> 404/not_found.
//   - approve dispatches deps.approve, deny dispatches deps.deny; success carries userCode.
//   - a thrown store error -> 400 with err.code (default invalid_request) + defaults.

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAsDeviceDecision } from '../operations/as-device-decision/index.ts';

function baseDeps(overrides = {}) {
  return {
    getByApprovalId: async () => ({ status: 'pending', user_code: 'UC-FROM-ROW' }),
    approve: async () => {},
    deny: async () => {},
    ...overrides,
  };
}

test('executeAsDeviceDecision: neither user_code nor approval_id is a 400 invalid_request', async () => {
  const out = await executeAsDeviceDecision({ action: 'approve' }, baseDeps());
  assert.equal(out.outcome, 'failure');
  assert.equal(out.status, 400);
  assert.equal(out.errorCode, 'invalid_request');
});

test('executeAsDeviceDecision: an approval_id with a non-pending row is a 404 not_found', async () => {
  const out = await executeAsDeviceDecision(
    { action: 'approve', approvalId: 'ap-1' },
    baseDeps({ getByApprovalId: async () => ({ status: 'denied', user_code: 'UC' }) }),
  );
  assert.equal(out.status, 404);
  assert.equal(out.errorCode, 'not_found');
});

test('executeAsDeviceDecision: approve dispatches deps.approve with the resolved user code', async () => {
  const calls = { approve: [], deny: [] };
  const out = await executeAsDeviceDecision(
    { action: 'approve', userCode: 'UC-1', subjectId: 'owner' },
    baseDeps({
      approve: async (uc, sid) => { calls.approve.push([uc, sid]); },
      deny: async (uc) => { calls.deny.push(uc); },
    }),
  );
  assert.equal(out.outcome, 'success');
  assert.equal(out.userCode, 'UC-1');
  assert.deepEqual(calls.approve, [['UC-1', 'owner']], 'approve called');
  assert.deepEqual(calls.deny, [], 'deny NOT called for an approve action');
});

test('executeAsDeviceDecision: deny dispatches deps.deny (not approve)', async () => {
  const calls = { approve: 0, deny: 0 };
  const out = await executeAsDeviceDecision(
    { action: 'deny', userCode: 'UC-2', subjectId: 'owner' },
    baseDeps({ approve: async () => { calls.approve += 1; }, deny: async () => { calls.deny += 1; } }),
  );
  assert.equal(out.outcome, 'success');
  assert.equal(calls.deny, 1, 'deny called');
  assert.equal(calls.approve, 0, 'approve NOT called for a deny action');
});

test('executeAsDeviceDecision: an approval_id resolves the user code from the pending row', async () => {
  const seen = [];
  const out = await executeAsDeviceDecision(
    { action: 'approve', approvalId: 'ap-2' },
    baseDeps({
      getByApprovalId: async () => ({ status: 'pending', user_code: 'UC-ROW' }),
      approve: async (uc) => { seen.push(uc); },
    }),
  );
  assert.equal(out.outcome, 'success');
  assert.deepEqual(seen, ['UC-ROW'], 'approve called with the row user_code');
});

test('executeAsDeviceDecision: a thrown store error is a 400 with the error code + carried ids', async () => {
  const out = await executeAsDeviceDecision(
    { action: 'approve', userCode: 'UC-3' },
    baseDeps({
      approve: async () => {
        const e = new Error('bad');
        e.code = 'invalid_grant';
        e.request_id = 'rq';
        e.trace_id = 'tr';
        throw e;
      },
    }),
  );
  assert.equal(out.status, 400);
  assert.equal(out.errorCode, 'invalid_grant');
  assert.equal(out.requestId, 'rq');
  assert.equal(out.traceId, 'tr');
});

test('executeAsDeviceDecision: a thrown error with no code/message uses the defaults', async () => {
  const out = await executeAsDeviceDecision(
    { action: 'deny', userCode: 'UC-4' },
    baseDeps({ deny: async () => { throw new Error(''); } }),
  );
  assert.equal(out.errorCode, 'invalid_request');
  assert.equal(out.errorMessage, 'Device decision rejected');
});
