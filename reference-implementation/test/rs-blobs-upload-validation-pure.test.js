// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the blob-upload validation in
// operations/rs-blobs-upload/index.ts. No test imports it by name. It validates the
// connector_id/stream/record_key params + Content-Type, gates on the stream being
// present in the manifest, then persists — the upload-request contract. The
// store/manifest dependencies are stubbed.
//
// Mutation surface:
//   - connector_id / stream / record_key must each be a single non-empty string
//     (missing or repeated -> BlobsUploadInvalidRequestError code invalid_request).
//   - Content-Type header is required (else invalid_request).
//   - the stream must be present in the manifest (else BlobsUploadStreamNotFoundError
//     code not_found).
//   - success -> { object:'blob', blob_id, sha256, size_bytes, mime_type }.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BlobsUploadInvalidRequestError,
  BlobsUploadStreamNotFoundError,
  executeBlobsUpload,
} from '../operations/rs-blobs-upload/index.ts';

function makeDeps({ visible = true } = {}) {
  return {
    hasManifestStream: async () => visible,
    persistBlob: async ({ mimeType, data }) => ({
      blob_id: 'bl_1',
      sha256: 'deadbeef',
      size_bytes: data.length,
      mime_type: mimeType,
    }),
  };
}

const validParams = { connector_id: 'amazon', stream: 'receipts', record_key: 'r1' };

function run(overrides = {}, opts = {}) {
  return executeBlobsUpload(
    {
      requestParams: overrides.requestParams ?? validParams,
      body: overrides.body ?? Buffer.from('hello'),
      contentType: 'contentType' in overrides ? overrides.contentType : 'image/png',
    },
    makeDeps(opts),
  );
}

test('executeBlobsUpload: a valid upload returns the blob envelope', async () => {
  const out = await run();
  assert.deepEqual(out.envelope, {
    object: 'blob',
    blob_id: 'bl_1',
    sha256: 'deadbeef',
    size_bytes: 5,
    mime_type: 'image/png',
  });
});

test('executeBlobsUpload: a missing required param is invalid_request', async () => {
  for (const missing of ['connector_id', 'stream', 'record_key']) {
    const params = { ...validParams };
    delete params[missing];
    await assert.rejects(
      run({ requestParams: params }),
      (err) => {
        assert.ok(err instanceof BlobsUploadInvalidRequestError, `${missing}: typed error`);
        assert.equal(err.code, 'invalid_request');
        return true;
      },
      `missing ${missing} should reject`,
    );
  }
});

test('executeBlobsUpload: a repeated (array) param is invalid_request', async () => {
  await assert.rejects(
    run({ requestParams: { ...validParams, connector_id: ['a', 'b'] } }),
    (err) => { assert.equal(err.code, 'invalid_request'); return true; },
  );
});

test('executeBlobsUpload: a missing Content-Type is invalid_request', async () => {
  await assert.rejects(
    run({ contentType: undefined }),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      assert.ok(err.message.includes('Content-Type'));
      return true;
    },
  );
});

test('executeBlobsUpload: a stream absent from the manifest is not_found', async () => {
  await assert.rejects(
    run({}, { visible: false }),
    (err) => {
      assert.ok(err instanceof BlobsUploadStreamNotFoundError);
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
});

test('executeBlobsUpload: size_bytes reflects the uploaded body length', async () => {
  const out = await run({ body: Buffer.from('a bigger payload than before') });
  assert.equal(out.envelope.size_bytes, 'a bigger payload than before'.length);
});
