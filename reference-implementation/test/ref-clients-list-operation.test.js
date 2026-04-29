/**
 * Operation-level behavior tests for `ref.clients.list`.
 *
 * Pins:
 *   - the `?owner=true` request requirement (typed
 *     `RefClientsListInvalidRequestError` for any other shape);
 *   - the `{object: 'list', data}` envelope shape;
 *   - that the operation passes dependency entries through unchanged
 *     (the host owns the per-operator subject scoping);
 *   - that the operation awaits dependency promises.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RefClientsListInvalidRequestError,
  executeRefClientsList,
} from '../operations/ref-clients-list/index.ts';

const sampleClient = {
  client_id: 'client_abc',
  client_name: 'Operator CLI',
  created_at: '2026-04-01T00:00:00Z',
  active_token_count: 1,
};

test('ref.clients.list emits {object: list, data: []} when there are no clients', async () => {
  const envelope = await executeRefClientsList(
    { owner: 'true' },
    { listOwnerIssuedClients: () => [] },
  );
  assert.deepEqual(envelope, { object: 'list', data: [] });
});

test('ref.clients.list passes dependency entries through unchanged', async () => {
  const inputs = [sampleClient, { ...sampleClient, client_id: 'client_xyz', client_name: null, active_token_count: 0 }];
  const envelope = await executeRefClientsList(
    { owner: 'true' },
    { listOwnerIssuedClients: () => inputs },
  );
  assert.equal(envelope.object, 'list');
  assert.deepEqual(envelope.data, inputs);
});

test('ref.clients.list does not mutate the dependency array', async () => {
  const inputs = [sampleClient];
  const snapshot = inputs.slice();
  const envelope = await executeRefClientsList(
    { owner: 'true' },
    { listOwnerIssuedClients: () => inputs },
  );
  assert.notStrictEqual(envelope.data, inputs);
  assert.deepEqual(inputs, snapshot);
});

test('ref.clients.list rejects a missing owner query parameter with invalid_request', async () => {
  await assert.rejects(
    () =>
      executeRefClientsList(
        { owner: undefined },
        { listOwnerIssuedClients: () => [] },
      ),
    (err) => err instanceof RefClientsListInvalidRequestError && err.code === 'invalid_request',
  );
});

test('ref.clients.list rejects owner values other than the literal string "true"', async () => {
  for (const raw of ['false', 'TRUE', '1', true, 0, null, ['true']]) {
    await assert.rejects(
      () =>
        executeRefClientsList(
          { owner: raw },
          { listOwnerIssuedClients: () => [] },
        ),
      RefClientsListInvalidRequestError,
      `expected reject for owner=${JSON.stringify(raw)}`,
    );
  }
});

test('ref.clients.list awaits dependency promises', async () => {
  let resolved = false;
  const envelope = await executeRefClientsList(
    { owner: 'true' },
    {
      listOwnerIssuedClients: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            resolved = true;
            resolve([sampleClient]);
          }),
        ),
    },
  );
  assert.equal(resolved, true);
  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].client_id, sampleClient.client_id);
});
