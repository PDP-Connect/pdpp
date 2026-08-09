// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminating regression test for the live GroupMe UAT 404 storm:
 * repeated `POST /v1/blobs?stream=attachments&record_key=attachment:image`
 * returning 404.
 *
 * Root cause: `BlobsUploadStreamNotFoundError` is thrown whenever
 * `hasManifestStream(connectorId, stream)` returns false (rs-blobs-upload's
 * own manifest-visibility gate). The GroupMe connector
 * (connectors/groupme/index.ts) calls the blob uploader with
 * `stream: "attachments"`, but the GroupMe manifest never declared an
 * `attachments` stream — every other connector that uses the shared
 * reference-blob-uploader (gmail, whatsapp, imessage, claude_code) declares
 * one. This test drives the real `executeBlobsUpload` operation against a
 * `hasManifestStream` implementation that mirrors the production route
 * (routes/rs-mutation.ts `POST /v1/blobs` handler): visibility is decided by
 * literally finding `stream` in the connector's own manifest `streams[]`.
 *
 * Before the manifest fix this test fails with `BlobsUploadStreamNotFoundError`
 * (mirroring the live 404); after the fix it passes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  type BlobsUploadDependencies,
  type BlobsUploadInput,
  BlobsUploadStreamNotFoundError,
  executeBlobsUpload,
} from "../operations/rs-blobs-upload/index.ts";

const GROUPME_MANIFEST = JSON.parse(
  readFileSync(new URL("../../packages/polyfill-connectors/manifests/groupme.json", import.meta.url), "utf8")
) as { streams: Array<{ name: string }> };

const STREAM_NOT_FOUND_PATTERN = /Stream 'attachments' not found for connector groupme/;

/** Mirrors routes/rs-mutation.ts POST /v1/blobs `hasManifestStream`: a literal find over manifest streams[]. */
function manifestBackedDeps(manifest: { streams: Array<{ name: string }> }): BlobsUploadDependencies {
  return {
    hasManifestStream: (_connectorId: string, streamName: string) =>
      Boolean(manifest.streams.find((candidate) => candidate.name === streamName)),
    persistBlob: ({ data }) => ({
      blob_id: "blob_sha256_test",
      mime_type: "image/jpeg",
      sha256: "test-sha",
      size_bytes: data.byteLength,
    }),
  };
}

function groupmeAttachmentUploadInput(): BlobsUploadInput {
  return {
    body: new Uint8Array([1, 2, 3]),
    contentType: "image/jpeg",
    requestParams: {
      connector_id: "groupme",
      record_key: "attachment:image",
      stream: "attachments",
    },
  };
}

test("GroupMe manifest declares an 'attachments' stream (matches gmail/whatsapp/imessage convention)", () => {
  const names = GROUPME_MANIFEST.streams.map((s) => s.name);
  assert.ok(
    names.includes("attachments"),
    `expected GroupMe manifest streams[] to include "attachments", got: ${JSON.stringify(names)}`
  );
});

test("POST /v1/blobs?stream=attachments&record_key=attachment:image succeeds against the real GroupMe manifest", async () => {
  const out = await executeBlobsUpload(groupmeAttachmentUploadInput(), manifestBackedDeps(GROUPME_MANIFEST));
  assert.equal(out.envelope.object, "blob");
  assert.equal(out.envelope.blob_id, "blob_sha256_test");
});

test("sanity: an undeclared stream still 404s (proves the check is real, not vacuously true)", async () => {
  const manifestWithoutAttachments = {
    streams: GROUPME_MANIFEST.streams.filter((s) => s.name !== "attachments"),
  };
  await assert.rejects(
    () => executeBlobsUpload(groupmeAttachmentUploadInput(), manifestBackedDeps(manifestWithoutAttachments)),
    (err: unknown) => {
      assert.ok(err instanceof BlobsUploadStreamNotFoundError);
      assert.equal(err.code, "not_found");
      assert.match(err.message, STREAM_NOT_FOUND_PATTERN);
      return true;
    }
  );
});
