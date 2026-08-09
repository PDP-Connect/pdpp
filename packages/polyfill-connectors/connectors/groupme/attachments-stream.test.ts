// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GroupMe attachments-stream tests (production seam).
 *
 * Covers the two defects behind the live UAT blob-404 storm on
 * `POST /v1/blobs?stream=attachments&record_key=attachment:image`:
 *
 * 1. Manifest gap (fixed in manifests/groupme.json): the connector uploaded
 *    with `stream: "attachments"` but the manifest never declared that
 *    stream, so the RS `hasManifestStream` check 404'd every upload. Covered
 *    by reference-implementation/test/rs-blobs-upload-groupme-attachments-manifest.test.ts.
 * 2. record_key collision (fixed here): every image attachment in a run
 *    shared the constant record_key `attachment:image` (same for
 *    `attachment:file`), so distinct attachments were indistinguishable to
 *    the RS blob store's record_key-scoped binding. attachmentRecordId
 *    derives a unique key per (message, position, URL).
 *
 * Also covers: attachmentContentType no longer sends the bogus MIME type
 * `image/file` for file attachments, and normalizeOneAttachment emits a
 * first-class `attachments` record (matching gmail/whatsapp/imessage/
 * claude_code convention) whenever the stream is requested.
 */

import assert, { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachmentContentType,
  attachmentRecordId,
  normalizeAttachments,
  normalizeOneAttachment,
  resolveUploadMimeType,
} from "./index.ts";

describe("GroupMe attachments stream (production seam)", () => {
  describe("attachmentRecordId (record_key uniqueness)", () => {
    it("derives distinct record keys for two different attachments in the same message", () => {
      const first = attachmentRecordId("msg.1", 0, "https://i.groupme.com/a.jpg");
      const second = attachmentRecordId("msg.1", 1, "https://i.groupme.com/b.jpg");
      assert.notStrictEqual(first, second, "distinct attachments must not collapse onto one record_key");
    });

    it("derives distinct record keys for the same-position attachment across different messages", () => {
      const messageOne = attachmentRecordId("msg.1", 0, "https://i.groupme.com/a.jpg");
      const messageTwo = attachmentRecordId("msg.2", 0, "https://i.groupme.com/a.jpg");
      assert.notStrictEqual(messageOne, messageTwo, "record_key must be scoped to the owning message");
    });

    it("is stable (reproducible) for the same message/index/url across runs", () => {
      const a = attachmentRecordId("msg.1", 0, "https://i.groupme.com/a.jpg");
      const b = attachmentRecordId("msg.1", 0, "https://i.groupme.com/a.jpg");
      strictEqual(a, b, "re-collecting the same message must derive the same record_key (dedup-safe)");
    });

    it("never reproduces the pre-fix constant-per-type record_key shape", () => {
      const id = attachmentRecordId("msg.1", 0, "https://i.groupme.com/a.jpg");
      assert.notStrictEqual(id, "attachment:image", "must not regress to the old type-only record_key");
    });
  });

  describe("attachmentContentType (MIME type correctness)", () => {
    it("uses image/jpeg for image attachments", () => {
      strictEqual(attachmentContentType({ type: "image", url: "https://i.groupme.com/a.jpg" }), "image/jpeg");
    });

    it("does NOT send the bogus 'image/file' MIME type for file attachments", () => {
      const mimeType = attachmentContentType({ type: "file", url: "https://i.groupme.com/a.pdf" });
      assert.notStrictEqual(mimeType, "image/file");
      strictEqual(mimeType, "application/octet-stream");
    });
  });

  describe("resolveUploadMimeType (prefer observed Content-Type over the guess)", () => {
    it("prefers a real observed PNG content-type over the image/jpeg guess", () => {
      strictEqual(resolveUploadMimeType("image/png", "image/jpeg"), "image/png");
    });

    it("prefers a real observed GIF content-type over the image/jpeg guess", () => {
      strictEqual(resolveUploadMimeType("image/gif", "image/jpeg"), "image/gif");
    });

    it("falls back to the guess when the provider omitted Content-Type", () => {
      strictEqual(resolveUploadMimeType(null, "image/jpeg"), "image/jpeg");
    });

    it("falls back to the guess when the observed header failed normalization (malformed/invalid)", () => {
      strictEqual(resolveUploadMimeType(null, "application/octet-stream"), "application/octet-stream");
    });
  });

  describe("normalizeOneAttachment / normalizeAttachments (attachments stream emission)", () => {
    it("emits an 'attachments' record for an image attachment when the stream is requested", async () => {
      const emitted: unknown[] = [];
      const uploader = async () => ({ blob_id: "blob_1", mime_type: "image/jpeg", sha256: "sha1", size_bytes: 10 });

      const result = await normalizeOneAttachment(
        { type: "image", url: "https://i.groupme.com/a.jpg", name: null },
        0,
        "msg.1",
        "group_messages",
        uploader,
        (data) => {
          emitted.push(data);
          return Promise.resolve();
        }
      );

      strictEqual(result.blob_id, "blob_1");
      strictEqual(emitted.length, 1);
      const record = emitted[0] as Record<string, unknown>;
      strictEqual(record.message_id, "msg.1");
      strictEqual(record.message_stream, "group_messages");
      strictEqual(record.type, "image");
      strictEqual(record.hydration_status, "hydrated");
      deepStrictEqual(record.blob_ref, { blob_id: "blob_1", mime_type: "image/jpeg", sha256: "sha1", size_bytes: 10 });
    });

    it("does not emit an attachments record when the stream is not requested (emitAttachmentRecord undefined)", async () => {
      const uploader = async () => ({ blob_id: "blob_1", mime_type: "image/jpeg", sha256: "sha1", size_bytes: 10 });
      const result = await normalizeOneAttachment(
        { type: "image", url: "https://i.groupme.com/a.jpg", name: null },
        0,
        "msg.1",
        "group_messages",
        uploader,
        undefined
      );
      strictEqual(result.blob_id, "blob_1", "inline blob_id embedding is preserved regardless of stream request");
    });

    it("records hydration_status=failed with a preserved error when the uploader throws", async () => {
      const emitted: unknown[] = [];
      const uploader = () =>
        Promise.reject(new Error("blob upload failed (404): Stream 'attachments' not found for connector groupme"));

      await normalizeOneAttachment(
        { type: "image", url: "https://i.groupme.com/a.jpg", name: null },
        0,
        "msg.1",
        "group_messages",
        uploader,
        (data) => {
          emitted.push(data);
          return Promise.resolve();
        }
      );

      const record = emitted[0] as Record<string, unknown>;
      strictEqual(record.hydration_status, "failed");
      strictEqual(record.blob_id, undefined, "normalized attachment must not claim a blob_id on failure");
      assert.match(String(record.hydration_error), /Stream 'attachments' not found/);
    });

    it("does not emit an attachments record for location/emoji attachments (no blob to hydrate)", async () => {
      const emitted: unknown[] = [];
      await normalizeOneAttachment(
        { type: "emoji", url: "https://i.groupme.com/emoji.png", name: null },
        0,
        "msg.1",
        "group_messages",
        undefined,
        (data) => {
          emitted.push(data);
          return Promise.resolve();
        }
      );
      strictEqual(emitted.length, 0);
    });

    it("emits one distinct attachments record per attachment in a multi-attachment message", async () => {
      const emitted: unknown[] = [];
      const uploader = async (url: string) => ({
        blob_id: `blob_${url.split("/").pop()}`,
        mime_type: "image/jpeg",
        sha256: "sha",
        size_bytes: 1,
      });

      await normalizeAttachments(
        [
          { type: "image", url: "https://i.groupme.com/a.jpg", name: null },
          { type: "image", url: "https://i.groupme.com/b.jpg", name: null },
        ],
        "msg.1",
        "group_messages",
        uploader,
        (data) => {
          emitted.push(data);
          return Promise.resolve();
        }
      );

      strictEqual(emitted.length, 2);
      const ids = emitted.map((r) => (r as Record<string, unknown>).id);
      strictEqual(new Set(ids).size, 2, "each attachment must get a distinct record id");
    });
  });
});
