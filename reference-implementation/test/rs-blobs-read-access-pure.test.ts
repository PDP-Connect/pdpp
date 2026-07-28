// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import assert from "node:assert/strict";
import test from "node:test";

import {
  type BlobsReadBinding,
  type BlobsReadBlobRow,
  type BlobsReadDependencies,
  BlobsReadNotFoundError,
  type BlobsReadVisibleRecord,
  executeBlobsRead,
} from "../operations/rs-blobs-read/index.ts";

const DEFAULT_BLOB: BlobsReadBlobRow = { blob_id: "b1", data: null, mime_type: "text/plain", size_bytes: 1 };

function makeDeps({
  blob = DEFAULT_BLOB,
  bindings = [] as readonly BlobsReadBinding[],
  actorConnectorId = "amazon" as string | null,
  getVisibleRecord,
}: {
  blob?: BlobsReadBlobRow | null;
  bindings?: readonly BlobsReadBinding[];
  actorConnectorId?: string | null;
  getVisibleRecord?: (binding: BlobsReadBinding) => Promise<BlobsReadVisibleRecord | null | undefined>;
} = {}): BlobsReadDependencies {
  return {
    getActorConnectorId: () => actorConnectorId,
    getVisibleRecord: getVisibleRecord ?? (async () => null),
    loadBindings: async () => bindings,
    loadBlob: async () => blob,
  };
}

test("executeBlobsRead: a missing blob is a not-found", async () => {
  await assert.rejects(executeBlobsRead({ blobId: "b1" }, makeDeps({ blob: null })), BlobsReadNotFoundError);
});

test("executeBlobsRead: returns the blob when a visible record for the actor references it", async () => {
  const out = await executeBlobsRead(
    { blobId: "b1" },
    makeDeps({
      actorConnectorId: "amazon",
      bindings: [{ connector_id: "amazon", record_key: "r1", stream: "orders" }],
      getVisibleRecord: async () => ({ data: { blob_ref: { blob_id: "b1" } } }),
    })
  );
  assert.deepEqual(out.blob, DEFAULT_BLOB);
});

test("executeBlobsRead: a binding for a DIFFERENT connector than the actor is skipped -> not found", async () => {
  await assert.rejects(
    executeBlobsRead(
      { blobId: "b1" },
      makeDeps({
        actorConnectorId: "amazon",
        bindings: [{ connector_id: "gmail", record_key: "r1", stream: "orders" }],
        getVisibleRecord: async () => ({ data: { blob_ref: { blob_id: "b1" } } }),
      })
    ),
    BlobsReadNotFoundError,
    "a record under another connector must not expose the blob"
  );
});

test("executeBlobsRead: a visible record that references a DIFFERENT blob does not grant access", async () => {
  await assert.rejects(
    executeBlobsRead(
      { blobId: "b1" },
      makeDeps({
        actorConnectorId: "amazon",
        bindings: [{ connector_id: "amazon", record_key: "r1", stream: "orders" }],
        getVisibleRecord: async () => ({ data: { blob_ref: { blob_id: "a-different-blob" } } }),
      })
    ),
    BlobsReadNotFoundError
  );
});

test("executeBlobsRead: no actor connector -> not found (cannot match any binding)", async () => {
  await assert.rejects(
    executeBlobsRead(
      { blobId: "b1" },
      makeDeps({
        actorConnectorId: null,
        bindings: [{ connector_id: "amazon", record_key: "r1", stream: "orders" }],
        getVisibleRecord: async () => ({ data: { blob_ref: { blob_id: "b1" } } }),
      })
    ),
    BlobsReadNotFoundError
  );
});

test("executeBlobsRead: a getVisibleRecord throw is swallowed; a LATER matching binding still grants", async () => {
  let call = 0;
  const out = await executeBlobsRead(
    { blobId: "b1" },
    makeDeps({
      actorConnectorId: "amazon",
      bindings: [
        { connector_id: "amazon", record_key: "r1", stream: "orders" },
        { connector_id: "amazon", record_key: "r2", stream: "orders" },
      ],
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      getVisibleRecord: async () => {
        call += 1;
        if (call === 1) {
          throw new Error("transient visibility failure");
        }
        return { data: { blob_ref: { blob_id: "b1" } } };
      },
    })
  );
  assert.deepEqual(out.blob, DEFAULT_BLOB, "the second binding grants after the first throws");
  assert.equal(call, 2, "both bindings were tried");
});
