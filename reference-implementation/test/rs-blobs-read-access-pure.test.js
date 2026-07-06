// Pure, no-DB unit tests for the blob-read access control in
// operations/rs-blobs-read/index.ts. No test imports it by name. A blob is only
// readable if a record VISIBLE to the actor's connector references it via
// data.blob_ref.blob_id — a capability check that prevents reading a blob by id
// alone. The store/visibility dependencies are stubbed.
//
// RED note: this is an access-control surface. Tests OBSERVE the allow/deny
// decision; no blob bytes are actually loaded from storage.
//
// Mutation surface:
//   - a missing blob -> BlobsReadNotFoundError.
//   - a binding whose connector_id != the actor's connector is skipped.
//   - a visible record must reference THIS blob_id (data.blob_ref.blob_id) to grant.
//   - a getVisibleRecord throw is swallowed and the next binding is tried.
//   - no matching visible record (or no actor connector) -> BlobsReadNotFoundError.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BlobsReadNotFoundError,
  executeBlobsRead,
} from '../operations/rs-blobs-read/index.ts';

function makeDeps({ blob = { id: 'b1', bytes: 'x' }, bindings = [], actorConnectorId = 'amazon', getVisibleRecord } = {}) {
  return {
    loadBlob: async () => blob,
    loadBindings: async () => bindings,
    getActorConnectorId: () => actorConnectorId,
    getVisibleRecord: getVisibleRecord ?? (async () => null),
  };
}

test('executeBlobsRead: a missing blob is a not-found', async () => {
  await assert.rejects(
    executeBlobsRead({ blobId: 'b1' }, makeDeps({ blob: null })),
    BlobsReadNotFoundError,
  );
});

test('executeBlobsRead: returns the blob when a visible record for the actor references it', async () => {
  const out = await executeBlobsRead(
    { blobId: 'b1' },
    makeDeps({
      bindings: [{ connector_id: 'amazon' }],
      actorConnectorId: 'amazon',
      getVisibleRecord: async () => ({ data: { blob_ref: { blob_id: 'b1' } } }),
    }),
  );
  assert.deepEqual(out.blob, { id: 'b1', bytes: 'x' });
});

test('executeBlobsRead: a binding for a DIFFERENT connector than the actor is skipped -> not found', async () => {
  await assert.rejects(
    executeBlobsRead(
      { blobId: 'b1' },
      makeDeps({
        bindings: [{ connector_id: 'gmail' }],
        actorConnectorId: 'amazon',
        getVisibleRecord: async () => ({ data: { blob_ref: { blob_id: 'b1' } } }),
      }),
    ),
    BlobsReadNotFoundError,
    'a record under another connector must not expose the blob',
  );
});

test('executeBlobsRead: a visible record that references a DIFFERENT blob does not grant access', async () => {
  await assert.rejects(
    executeBlobsRead(
      { blobId: 'b1' },
      makeDeps({
        bindings: [{ connector_id: 'amazon' }],
        actorConnectorId: 'amazon',
        getVisibleRecord: async () => ({ data: { blob_ref: { blob_id: 'a-different-blob' } } }),
      }),
    ),
    BlobsReadNotFoundError,
  );
});

test('executeBlobsRead: no actor connector -> not found (cannot match any binding)', async () => {
  await assert.rejects(
    executeBlobsRead(
      { blobId: 'b1' },
      makeDeps({
        bindings: [{ connector_id: 'amazon' }],
        actorConnectorId: null,
        getVisibleRecord: async () => ({ data: { blob_ref: { blob_id: 'b1' } } }),
      }),
    ),
    BlobsReadNotFoundError,
  );
});

test('executeBlobsRead: a getVisibleRecord throw is swallowed; a LATER matching binding still grants', async () => {
  let call = 0;
  const out = await executeBlobsRead(
    { blobId: 'b1' },
    makeDeps({
      bindings: [{ connector_id: 'amazon' }, { connector_id: 'amazon' }],
      actorConnectorId: 'amazon',
      getVisibleRecord: async () => {
        call += 1;
        if (call === 1) throw new Error('transient visibility failure');
        return { data: { blob_ref: { blob_id: 'b1' } } };
      },
    }),
  );
  assert.deepEqual(out.blob, { id: 'b1', bytes: 'x' }, 'the second binding grants after the first throws');
  assert.equal(call, 2, 'both bindings were tried');
});
