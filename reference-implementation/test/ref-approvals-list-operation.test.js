/**
 * Operation-level behavior tests for `ref.approvals.list`.
 *
 * Pins:
 *   - the `{object: 'list', data}` envelope shape;
 *   - the created-at-descending sort across mixed kinds;
 *   - the request_uri / user_code redaction invariant (the operation
 *     defends against a regression in the dependency).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRefApprovalsList } from '../operations/ref-approvals-list/index.ts';

function makeConsent(approvalId, createdAt, overrides = {}) {
  return {
    object: 'approval',
    approval_id: approvalId,
    kind: 'consent',
    client_id: 'client_x',
    request_uri: null,
    user_code: null,
    created_at: createdAt,
    grant_preview: {
      connector_id: null,
      provider_id: null,
      access_mode: null,
      purpose_code: null,
      purpose_description: null,
      streams: [],
    },
    ...overrides,
  };
}

function makeOwnerDevice(approvalId, createdAt, overrides = {}) {
  return {
    object: 'approval',
    approval_id: approvalId,
    kind: 'owner_device',
    client_id: 'client_y',
    request_uri: null,
    user_code: null,
    created_at: createdAt,
    grant_preview: null,
    ...overrides,
  };
}

test('ref.approvals.list emits {object: list, data}', async () => {
  const envelope = await executeRefApprovalsList({
    listPendingApprovals: () => [],
  });
  assert.deepEqual(envelope, { object: 'list', data: [] });
});

test('ref.approvals.list sorts by created_at descending across kinds', async () => {
  const inputs = [
    makeConsent('a', '2026-01-01T00:00:00Z'),
    makeOwnerDevice('b', '2026-03-01T00:00:00Z'),
    makeConsent('c', '2026-02-01T00:00:00Z'),
  ];
  const envelope = await executeRefApprovalsList({
    listPendingApprovals: () => inputs,
  });
  assert.deepEqual(
    envelope.data.map((entry) => entry.approval_id),
    ['b', 'c', 'a'],
  );
});

test('ref.approvals.list preserves stable order when created_at ties', async () => {
  const ts = '2026-04-01T00:00:00Z';
  const inputs = [
    makeConsent('first', ts),
    makeOwnerDevice('second', ts),
    makeConsent('third', ts),
  ];
  const envelope = await executeRefApprovalsList({
    listPendingApprovals: () => inputs,
  });
  // Tie-break: the operation's compareCreatedAtDesc returns 0 on equal
  // timestamps, so Array.prototype.sort preserves insertion order on
  // modern engines (TimSort is stable). Pin that contract.
  assert.deepEqual(
    envelope.data.map((entry) => entry.approval_id),
    ['first', 'second', 'third'],
  );
});

test('ref.approvals.list rejects entries that leak request_uri', async () => {
  const leaky = makeConsent('leak', '2026-04-01T00:00:00Z', {
    request_uri: 'urn:ietf:params:oauth:request_uri:device_code_xyz',
  });
  await assert.rejects(
    executeRefApprovalsList({
      listPendingApprovals: () => [leaky],
    }),
    /request_uri or user_code/,
  );
});

test('ref.approvals.list rejects entries that leak user_code', async () => {
  const leaky = makeOwnerDevice('leak', '2026-04-01T00:00:00Z', {
    user_code: 'WDJB-MJHT',
  });
  await assert.rejects(
    executeRefApprovalsList({
      listPendingApprovals: () => [leaky],
    }),
    /request_uri or user_code/,
  );
});

test('ref.approvals.list does not mutate the dependency array', async () => {
  const inputs = [
    makeConsent('a', '2026-01-01T00:00:00Z'),
    makeOwnerDevice('b', '2026-03-01T00:00:00Z'),
  ];
  const snapshot = inputs.slice();
  await executeRefApprovalsList({
    listPendingApprovals: () => inputs,
  });
  assert.deepEqual(inputs, snapshot);
});

test('ref.approvals.list awaits dependency promises', async () => {
  let resolved = false;
  const envelope = await executeRefApprovalsList({
    listPendingApprovals: () =>
      new Promise((resolve) =>
        setImmediate(() => {
          resolved = true;
          resolve([makeConsent('async', '2026-04-01T00:00:00Z')]);
        }),
      ),
  });
  assert.equal(resolved, true);
  assert.equal(envelope.data.length, 1);
});
