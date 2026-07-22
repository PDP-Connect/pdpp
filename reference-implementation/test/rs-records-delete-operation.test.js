// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `rs.records.delete`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RecordsDeleteInvalidRequestError,
  RecordsDeleteNotFoundError,
  executeRecordsDelete,
} from '../operations/rs-records-delete/index.ts';

function defaultDeps(overrides = {}) {
  return {
    hasManifestStream: () => true,
    deleteRecord: () => 1,
    ...overrides,
  };
}

test('rs.records.delete rejects null connector_id with invalid_request', async () => {
  await assert.rejects(
    () =>
      executeRecordsDelete(
        { connectorId: null, streamName: 'messages', recordId: 'r1' },
        defaultDeps(),
      ),
    (err) => {
      assert.ok(err instanceof RecordsDeleteInvalidRequestError);
      assert.equal(err.code, 'invalid_request');
      return true;
    },
  );
});

test('rs.records.delete raises not_found when manifest is missing the stream', async () => {
  await assert.rejects(
    () =>
      executeRecordsDelete(
        { connectorId: 'gmail', streamName: 'unknown', recordId: 'r1' },
        defaultDeps({ hasManifestStream: () => false }),
      ),
    (err) => {
      assert.ok(err instanceof RecordsDeleteNotFoundError);
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
});

test('rs.records.delete forwards stream and recordId to deleteRecord', async () => {
  let captured;
  await executeRecordsDelete(
    { connectorId: 'gmail', streamName: 'messages', recordId: 'r1' },
    defaultDeps({
      deleteRecord: (cid, stream, recordId) => {
        captured = { cid, stream, recordId };
        return 1;
      },
    }),
  );
  assert.deepEqual(captured, { cid: 'gmail', stream: 'messages', recordId: 'r1' });
});

test('rs.records.delete returns the dependency-provided deletedRecordCount', async () => {
  const out = await executeRecordsDelete(
    { connectorId: 'gmail', streamName: 'messages', recordId: 'r1' },
    defaultDeps({ deleteRecord: () => 0 }),
  );
  assert.equal(out.deletedRecordCount, 0);
});

test('rs.records.delete runs manifest check before invoking deleteRecord', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      executeRecordsDelete(
        { connectorId: 'gmail', streamName: 'unknown', recordId: 'r1' },
        defaultDeps({
          hasManifestStream: () => false,
          deleteRecord: () => {
            calls += 1;
            return 1;
          },
        }),
      ),
    () => true,
  );
  assert.equal(calls, 0);
});
