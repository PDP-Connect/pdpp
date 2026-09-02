// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression cover for the Gmail attachment MIME type sent to the blob upload.
//
// The production defect: two attachments on the owner's mailbox reported an
// IMAP BODYSTRUCTURE content type of `image/*`. That is non-empty, so the old
// `downloaded.mimeType || attachment.content_type || DEFAULT` chain forwarded
// it verbatim; `*` is outside the blob endpoint's media-type grammar, so every
// upload attempt was rejected with `400 mime_type must be a valid media type`.
// A 4xx never converges on retry, so each item burned its full no-progress
// budget and was quarantined `terminal` with `failure_class:
// blob_upload_http_4xx` — no durable impossibility proof, on a REQUIRED stream,
// which pins the whole Gmail source at "Missing data" indefinitely.
//
// The bytes were always fetchable (27,742 each, against a 25 MiB cap). Only the
// label was malformed. These tests hold the seam at the boundary that actually
// rejected it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAttachmentMimeType } from "./index.ts";

// The blob endpoint's own acceptance rule, transcribed from
// `reference-implementation/operations/rs-blobs-upload/index.ts`
// (`MEDIA_TYPE_PATTERN` + `readMediaType`). This is the ORACLE: the test asserts
// what the real consumer accepts, so a fix that merely satisfies a mirror of
// itself cannot pass. Kept as an independent transcription rather than an
// import because the connector package must not depend on the RI.
const ENDPOINT_MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

function endpointAcceptsMimeType(value: string): boolean {
  const mediaType = (value.split(";")[0] ?? "").trim().toLowerCase();
  return Boolean(mediaType) && ENDPOINT_MEDIA_TYPE_PATTERN.test(mediaType);
}

test("the production wildcard type is replaced, not forwarded", () => {
  // The exact value observed on record_keys 1518531308003508931:2 and
  // 1518656574754117199:2 in the owner's mailbox.
  assert.equal(normalizeAttachmentMimeType("image/*", null), "application/octet-stream");
});

test("every rejected candidate shape yields a type the endpoint accepts", () => {
  // Each of these survives a `||` chain (non-empty) but fails the endpoint's
  // grammar, which is precisely the class of value that produced the wedge.
  const rejectedByEndpoint = [
    "image/*",
    "*/*",
    "*",
    "image/",
    "/jpeg",
    "image",
    "image / jpeg",
    "image/*; charset=utf-8",
    " ",
  ];
  for (const candidate of rejectedByEndpoint) {
    assert.equal(
      endpointAcceptsMimeType(candidate),
      false,
      `test premise broken: the endpoint would have accepted ${JSON.stringify(candidate)}`
    );
    const resolved = normalizeAttachmentMimeType(candidate, null);
    assert.equal(
      endpointAcceptsMimeType(resolved),
      true,
      `normalizing ${JSON.stringify(candidate)} produced ${JSON.stringify(resolved)}, which the endpoint rejects`
    );
  }
});

test("a valid type is preserved exactly, including its parameters", () => {
  // The endpoint strips parameters itself, so a parameterized type must be
  // passed through rather than downgraded to octet-stream.
  assert.equal(normalizeAttachmentMimeType("image/jpeg", null), "image/jpeg");
  assert.equal(normalizeAttachmentMimeType("text/plain; charset=utf-8", null), "text/plain; charset=utf-8");
  assert.equal(normalizeAttachmentMimeType("application/vnd.ms-excel", null), "application/vnd.ms-excel");
  assert.equal(normalizeAttachmentMimeType("IMAGE/JPEG", null), "IMAGE/JPEG");
});

test("preference falls to the next candidate only when the earlier one is invalid", () => {
  // First VALID wins, not first non-empty: the wildcard must not shadow a
  // usable record-level type behind it.
  assert.equal(normalizeAttachmentMimeType("image/*", "image/png"), "image/png");
  assert.equal(normalizeAttachmentMimeType(null, "image/png"), "image/png");
  assert.equal(normalizeAttachmentMimeType(undefined, undefined), "application/octet-stream");
  assert.equal(normalizeAttachmentMimeType("", ""), "application/octet-stream");
  // A valid leading candidate still wins over a valid later one.
  assert.equal(normalizeAttachmentMimeType("image/gif", "image/png"), "image/gif");
});

test("no input shape can produce a value the endpoint would reject", () => {
  const candidates: (string | null | undefined)[] = [
    "image/*",
    "*/*",
    "",
    " ",
    null,
    undefined,
    "image/jpeg",
    "text/plain; charset=utf-8",
    "garbage",
    "a/b/c",
  ];
  for (const first of candidates) {
    for (const second of candidates) {
      const resolved = normalizeAttachmentMimeType(first, second);
      assert.equal(
        endpointAcceptsMimeType(resolved),
        true,
        `(${JSON.stringify(first)}, ${JSON.stringify(second)}) produced ${JSON.stringify(resolved)}, which the endpoint rejects`
      );
    }
  }
});
