// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `rs.blobs.upload`.
 *
 * Pins the parameter normalization, Content-Type normalization, body→bytes
 * coercion, manifest visibility short-circuit, and the verbatim
 * `{ object: 'blob', ... }` envelope shape.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  type BlobsUploadDependencies,
  type BlobsUploadInput,
  BlobsUploadInvalidRequestError,
  type BlobsUploadPersistArgs,
  type BlobsUploadPersistResult,
  BlobsUploadStreamNotFoundError,
  executeBlobsUpload,
} from "../operations/rs-blobs-upload/index.ts";

const REGEXP_1 = /connector_id must be a single non-empty string/;
const REGEXP_2 = /Content-Type header is required/;
const REGEXP_3 = /Content-Type header must be a valid media type/;
const REGEXP_4 = /Stream 'messages' not found for connector gmail/;
const REGEXP_5 = /Blob upload body must be bytes/;

function defaultDeps(overrides: Partial<BlobsUploadDependencies> = {}): BlobsUploadDependencies {
  return {
    hasManifestStream: () => true,
    persistBlob: ({ data }: BlobsUploadPersistArgs): BlobsUploadPersistResult => ({
      blob_id: "blob_sha256_abc",
      mime_type: "application/octet-stream",
      sha256: "abc",
      size_bytes: data.byteLength,
    }),
    ...overrides,
  };
}

function defaultInput(overrides: Partial<BlobsUploadInput> = {}): BlobsUploadInput {
  return {
    body: new Uint8Array([1, 2, 3]),
    contentType: "application/octet-stream",
    requestParams: {
      connector_id: "gmail",
      record_key: "rk_1",
      stream: "messages",
    },
    ...overrides,
  };
}

function errorCode(err: unknown): unknown {
  assert.ok(err && typeof err === "object" && "code" in err);
  return (err as { code: unknown }).code;
}

test('rs.blobs.upload returns the canonical { object: "blob", ... } envelope', async () => {
  const out = await executeBlobsUpload(
    defaultInput(),
    defaultDeps({
      persistBlob: () => ({
        blob_id: "blob_sha256_xyz",
        mime_type: "application/octet-stream",
        sha256: "xyz",
        size_bytes: 3,
      }),
    })
  );
  assert.deepEqual(out.envelope, {
    blob_id: "blob_sha256_xyz",
    mime_type: "application/octet-stream",
    object: "blob",
    sha256: "xyz",
    size_bytes: 3,
  });
});

test("rs.blobs.upload rejects missing connector_id with invalid_request", async () => {
  await assert.rejects(
    () =>
      executeBlobsUpload(defaultInput({ requestParams: { record_key: "rk_1", stream: "messages" } }), defaultDeps()),
    (err) => {
      assert.ok(err instanceof BlobsUploadInvalidRequestError);
      assert.equal(err.code, "invalid_request");
      assert.match(err.message, REGEXP_1);
      return true;
    }
  );
});

test("rs.blobs.upload rejects whitespace-only stream with invalid_request", async () => {
  await assert.rejects(
    () =>
      executeBlobsUpload(
        defaultInput({ requestParams: { connector_id: "gmail", record_key: "rk_1", stream: "   " } }),
        defaultDeps()
      ),
    (err) => {
      assert.equal(errorCode(err), "invalid_request");
      return true;
    }
  );
});

test("rs.blobs.upload rejects missing Content-Type header", async () => {
  await assert.rejects(
    () => executeBlobsUpload(defaultInput({ contentType: undefined }), defaultDeps()),
    (err) => {
      assert.ok(err instanceof BlobsUploadInvalidRequestError);
      assert.match(err.message, REGEXP_2);
      return true;
    }
  );
});

test("rs.blobs.upload rejects malformed Content-Type", async () => {
  await assert.rejects(
    () => executeBlobsUpload(defaultInput({ contentType: "not-a-mime" }), defaultDeps()),
    (err) => {
      assert.ok(err instanceof BlobsUploadInvalidRequestError);
      assert.match(err.message, REGEXP_3);
      return true;
    }
  );
});

test("rs.blobs.upload normalizes Content-Type by stripping parameters and lowercasing", async () => {
  let captured: BlobsUploadPersistArgs | undefined;
  await executeBlobsUpload(
    defaultInput({ contentType: "IMAGE/PNG; charset=utf-8" }),
    defaultDeps({
      persistBlob: (args) => {
        captured = args;
        return {
          blob_id: "b",
          mime_type: args.mimeType,
          sha256: "s",
          size_bytes: 0,
        };
      },
    })
  );
  assert.ok(captured);
  assert.equal(captured.mimeType, "image/png");
});

test("rs.blobs.upload throws not_found when manifest does not declare the stream", async () => {
  await assert.rejects(
    () => executeBlobsUpload(defaultInput(), defaultDeps({ hasManifestStream: () => false })),
    (err) => {
      assert.ok(err instanceof BlobsUploadStreamNotFoundError);
      assert.equal(err.code, "not_found");
      assert.match(err.message, REGEXP_4);
      return true;
    }
  );
});

test("rs.blobs.upload manifest check runs before body coercion", async () => {
  // A bad body that would throw on coercion must NOT throw if manifest
  // visibility fails first; the previous native ordering raised not_found
  // before coercion, and we preserve it.
  await assert.rejects(
    () => executeBlobsUpload(defaultInput({ body: { not: "bytes" } }), defaultDeps({ hasManifestStream: () => false })),
    (err) => {
      assert.ok(err instanceof BlobsUploadStreamNotFoundError);
      return true;
    }
  );
});

test("rs.blobs.upload coerces string bodies to bytes", async () => {
  let captured: BlobsUploadPersistArgs | undefined;
  await executeBlobsUpload(
    defaultInput({ body: "hi" }),
    defaultDeps({
      persistBlob: (args) => {
        captured = args;
        return {
          blob_id: "b",
          mime_type: "text/plain",
          sha256: "s",
          size_bytes: args.data.byteLength,
        };
      },
    })
  );
  assert.ok(captured);
  assert.equal(captured.data instanceof Uint8Array, true);
  assert.equal(captured.data.byteLength, 2);
});

test("rs.blobs.upload coerces null/undefined to empty bytes", async () => {
  let captured: BlobsUploadPersistArgs | undefined;
  await executeBlobsUpload(
    defaultInput({ body: null }),
    defaultDeps({
      persistBlob: (args) => {
        captured = args;
        return { blob_id: "b", mime_type: "x/y", sha256: "s", size_bytes: 0 };
      },
    })
  );
  assert.ok(captured);
  assert.equal(captured.data.byteLength, 0);
});

test("rs.blobs.upload rejects unsupported body shapes", async () => {
  await assert.rejects(
    () => executeBlobsUpload(defaultInput({ body: 42 }), defaultDeps()),
    (err) => {
      assert.ok(err instanceof BlobsUploadInvalidRequestError);
      assert.match(err.message, REGEXP_5);
      return true;
    }
  );
});

test("rs.blobs.upload runs query/Content-Type validation before manifest check", async () => {
  let manifestCalled = false;
  await assert.rejects(
    () =>
      executeBlobsUpload(
        defaultInput({ requestParams: { record_key: "rk_1", stream: "messages" } }),
        defaultDeps({
          hasManifestStream: () => {
            manifestCalled = true;
            return true;
          },
        })
      ),
    (err) => {
      assert.equal(errorCode(err), "invalid_request");
      return true;
    }
  );
  assert.equal(manifestCalled, false);
});
