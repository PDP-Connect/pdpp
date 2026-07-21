// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `rs.blobs.upload`.
 *
 * Pins the parameter normalization, Content-Type normalization, body→bytes
 * coercion, manifest visibility short-circuit, and the verbatim
 * `{ object: 'blob', ... }` envelope shape.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BlobsUploadInvalidRequestError,
  BlobsUploadStreamNotFoundError,
  executeBlobsUpload,
} from '../operations/rs-blobs-upload/index.ts';

function defaultDeps(overrides = {}) {
  return {
    hasManifestStream: () => true,
    persistBlob: ({ data }) => ({
      blob_id: 'blob_sha256_abc',
      sha256: 'abc',
      size_bytes: data.byteLength,
      mime_type: 'application/octet-stream',
    }),
    ...overrides,
  };
}

function defaultInput(overrides = {}) {
  return {
    requestParams: {
      connector_id: 'gmail',
      stream: 'messages',
      record_key: 'rk_1',
    },
    contentType: 'application/octet-stream',
    body: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

test('rs.blobs.upload returns the canonical { object: "blob", ... } envelope', async () => {
  const out = await executeBlobsUpload(
    defaultInput(),
    defaultDeps({
      persistBlob: () => ({
        blob_id: 'blob_sha256_xyz',
        sha256: 'xyz',
        size_bytes: 3,
        mime_type: 'application/octet-stream',
      }),
    }),
  );
  assert.deepEqual(out.envelope, {
    object: 'blob',
    blob_id: 'blob_sha256_xyz',
    sha256: 'xyz',
    size_bytes: 3,
    mime_type: 'application/octet-stream',
  });
});

test('rs.blobs.upload rejects missing connector_id with invalid_request', async () => {
  await assert.rejects(
    () =>
      executeBlobsUpload(
        defaultInput({ requestParams: { stream: 'messages', record_key: 'rk_1' } }),
        defaultDeps(),
      ),
    (err) => {
      assert.ok(err instanceof BlobsUploadInvalidRequestError);
      assert.equal(err.code, 'invalid_request');
      assert.match(err.message, /connector_id must be a single non-empty string/);
      return true;
    },
  );
});

test('rs.blobs.upload rejects whitespace-only stream with invalid_request', async () => {
  await assert.rejects(
    () =>
      executeBlobsUpload(
        defaultInput({ requestParams: { connector_id: 'gmail', stream: '   ', record_key: 'rk_1' } }),
        defaultDeps(),
      ),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      return true;
    },
  );
});

test('rs.blobs.upload rejects missing Content-Type header', async () => {
  await assert.rejects(
    () => executeBlobsUpload(defaultInput({ contentType: undefined }), defaultDeps()),
    (err) => {
      assert.ok(err instanceof BlobsUploadInvalidRequestError);
      assert.match(err.message, /Content-Type header is required/);
      return true;
    },
  );
});

test('rs.blobs.upload rejects malformed Content-Type', async () => {
  await assert.rejects(
    () => executeBlobsUpload(defaultInput({ contentType: 'not-a-mime' }), defaultDeps()),
    (err) => {
      assert.ok(err instanceof BlobsUploadInvalidRequestError);
      assert.match(err.message, /Content-Type header must be a valid media type/);
      return true;
    },
  );
});

test('rs.blobs.upload normalizes Content-Type by stripping parameters and lowercasing', async () => {
  let captured;
  await executeBlobsUpload(
    defaultInput({ contentType: 'IMAGE/PNG; charset=utf-8' }),
    defaultDeps({
      persistBlob: (args) => {
        captured = args;
        return {
          blob_id: 'b',
          sha256: 's',
          size_bytes: 0,
          mime_type: args.mimeType,
        };
      },
    }),
  );
  assert.equal(captured.mimeType, 'image/png');
});

test('rs.blobs.upload throws not_found when manifest does not declare the stream', async () => {
  await assert.rejects(
    () =>
      executeBlobsUpload(
        defaultInput(),
        defaultDeps({ hasManifestStream: () => false }),
      ),
    (err) => {
      assert.ok(err instanceof BlobsUploadStreamNotFoundError);
      assert.equal(err.code, 'not_found');
      assert.match(err.message, /Stream 'messages' not found for connector gmail/);
      return true;
    },
  );
});

test('rs.blobs.upload manifest check runs before body coercion', async () => {
  // A bad body that would throw on coercion must NOT throw if manifest
  // visibility fails first; the previous native ordering raised not_found
  // before coercion, and we preserve it.
  await assert.rejects(
    () =>
      executeBlobsUpload(
        defaultInput({ body: { not: 'bytes' } }),
        defaultDeps({ hasManifestStream: () => false }),
      ),
    (err) => {
      assert.ok(err instanceof BlobsUploadStreamNotFoundError);
      return true;
    },
  );
});

test('rs.blobs.upload coerces string bodies to bytes', async () => {
  let captured;
  await executeBlobsUpload(
    defaultInput({ body: 'hi' }),
    defaultDeps({
      persistBlob: (args) => {
        captured = args;
        return {
          blob_id: 'b',
          sha256: 's',
          size_bytes: args.data.byteLength,
          mime_type: 'text/plain',
        };
      },
    }),
  );
  assert.equal(captured.data instanceof Uint8Array, true);
  assert.equal(captured.data.byteLength, 2);
});

test('rs.blobs.upload coerces null/undefined to empty bytes', async () => {
  let captured;
  await executeBlobsUpload(
    defaultInput({ body: null }),
    defaultDeps({
      persistBlob: (args) => {
        captured = args;
        return { blob_id: 'b', sha256: 's', size_bytes: 0, mime_type: 'x/y' };
      },
    }),
  );
  assert.equal(captured.data.byteLength, 0);
});

test('rs.blobs.upload rejects unsupported body shapes', async () => {
  await assert.rejects(
    () => executeBlobsUpload(defaultInput({ body: 42 }), defaultDeps()),
    (err) => {
      assert.ok(err instanceof BlobsUploadInvalidRequestError);
      assert.match(err.message, /Blob upload body must be bytes/);
      return true;
    },
  );
});

test('rs.blobs.upload runs query/Content-Type validation before manifest check', async () => {
  let manifestCalled = false;
  await assert.rejects(
    () =>
      executeBlobsUpload(
        defaultInput({ requestParams: { stream: 'messages', record_key: 'rk_1' } }),
        defaultDeps({
          hasManifestStream: () => {
            manifestCalled = true;
            return true;
          },
        }),
      ),
    (err) => {
      assert.equal(err.code, 'invalid_request');
      return true;
    },
  );
  assert.equal(manifestCalled, false);
});
