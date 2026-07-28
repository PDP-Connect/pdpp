// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `rs.blobs.read`.
 *
 * Pins:
 *   - blob_not_found when the blob row is absent.
 *   - blob_not_found when the blob exists but no binding matches the actor's
 *     storage binding.
 *   - blob_not_found when bindings exist but no visible record references
 *     this blob.
 *   - success when at least one visible record references the blob.
 *   - per-binding error swallowing (one binding throwing must not short-circuit
 *     the loop).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { type BlobsReadBinding, BlobsReadNotFoundError, executeBlobsRead } from "../operations/rs-blobs-read/index.ts";

const BLOB_ID = "blob_sha256_abc";

function blobRow(overrides = {}) {
  return {
    blob_id: BLOB_ID,
    data: new Uint8Array([1, 2, 3]),
    mime_type: "image/png",
    size_bytes: 3,
    ...overrides,
  };
}

function defaultDeps(overrides = {}) {
  return {
    getActorConnectorId: () => "gmail",
    getVisibleRecord: () => ({ data: { blob_ref: { blob_id: BLOB_ID } } }),
    loadBindings: () => [{ connector_id: "gmail", record_key: "rk_1", stream: "messages" }],
    loadBlob: () => blobRow(),
    ...overrides,
  };
}

test("rs.blobs.read returns the blob row when a visible record references it", async () => {
  const out = await executeBlobsRead({ blobId: BLOB_ID }, defaultDeps());
  assert.equal(out.blob.blob_id, BLOB_ID);
  assert.equal(out.blob.mime_type, "image/png");
});

test("rs.blobs.read raises blob_not_found when the blob row is absent", async () => {
  await assert.rejects(
    () => executeBlobsRead({ blobId: BLOB_ID }, defaultDeps({ loadBlob: () => null })),
    (err) => {
      assert.ok(err instanceof BlobsReadNotFoundError);
      assert.equal(err.code, "blob_not_found");
      return true;
    }
  );
});

test("rs.blobs.read raises blob_not_found when no binding matches the actor connector", async () => {
  await assert.rejects(
    () => executeBlobsRead({ blobId: BLOB_ID }, defaultDeps({ getActorConnectorId: () => "other" })),
    (err) => {
      assert.ok(err instanceof BlobsReadNotFoundError);
      return true;
    }
  );
});

test("rs.blobs.read raises blob_not_found when the actor has no resolved connector binding", async () => {
  await assert.rejects(
    () => executeBlobsRead({ blobId: BLOB_ID }, defaultDeps({ getActorConnectorId: () => null })),
    (err) => {
      assert.ok(err instanceof BlobsReadNotFoundError);
      return true;
    }
  );
});

test("rs.blobs.read raises blob_not_found when no visible record references this blob", async () => {
  await assert.rejects(
    () =>
      executeBlobsRead(
        { blobId: BLOB_ID },
        defaultDeps({
          getVisibleRecord: () => ({ data: { blob_ref: { blob_id: "other" } } }),
        })
      ),
    (err) => {
      assert.ok(err instanceof BlobsReadNotFoundError);
      return true;
    }
  );
});

test("rs.blobs.read raises blob_not_found when getVisibleRecord returns null", async () => {
  await assert.rejects(
    () => executeBlobsRead({ blobId: BLOB_ID }, defaultDeps({ getVisibleRecord: () => null })),
    (err) => {
      assert.ok(err instanceof BlobsReadNotFoundError);
      return true;
    }
  );
});

test("rs.blobs.read swallows per-binding errors and continues with other bindings", async () => {
  const bindings = [
    { connector_id: "gmail", record_key: "rk_a", stream: "a" },
    { connector_id: "gmail", record_key: "rk_b", stream: "b" },
  ];
  let calls = 0;
  const out = await executeBlobsRead(
    { blobId: BLOB_ID },
    defaultDeps({
      getVisibleRecord: (binding: BlobsReadBinding) => {
        calls += 1;
        if (binding.stream === "a") {
          throw new Error("grant denied");
        }
        return { data: { blob_ref: { blob_id: BLOB_ID } } };
      },
      loadBindings: () => bindings,
    })
  );
  assert.equal(calls, 2);
  assert.equal(out.blob.blob_id, BLOB_ID);
});

test("rs.blobs.read skips bindings whose connector does not match the actor", async () => {
  let visibleCalls = 0;
  await assert.rejects(
    () =>
      executeBlobsRead(
        { blobId: BLOB_ID },
        defaultDeps({
          getVisibleRecord: () => {
            visibleCalls += 1;
            return { data: { blob_ref: { blob_id: BLOB_ID } } };
          },
          loadBindings: () => [{ connector_id: "other", record_key: "rk_x", stream: "messages" }],
        })
      ),
    (err) => {
      assert.ok(err instanceof BlobsReadNotFoundError);
      return true;
    }
  );
  assert.equal(visibleCalls, 0, "visibility check must not run for non-matching connector bindings");
});
