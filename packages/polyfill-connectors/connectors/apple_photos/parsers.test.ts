// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { MediaHydrationResult } from "../../src/local-media-blob-hydration.ts";
import { advanceCursor, buildPhotoRecord, detectMimeType, hashId, isBeforeCursor } from "./parsers.ts";
import type { DiscoveredFile } from "./types.ts";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function hydrated(contentSha256: string, sizeBytes = 1024): MediaHydrationResult {
  return {
    blobRef: null,
    contentSha256,
    hydrationError: null,
    hydrationStatus: "unavailable",
    sizeBytes,
  };
}

// ─── detectMimeType ─────────────────────────────────────────────────────

test("detectMimeType: recognizes common image extensions", () => {
  assert.equal(detectMimeType("photo.jpg"), "image/jpeg");
  assert.equal(detectMimeType("photo.JPEG"), "image/jpeg");
  assert.equal(detectMimeType("photo.png"), "image/png");
  assert.equal(detectMimeType("photo.heic"), "image/heic");
});

test("detectMimeType: recognizes video extensions", () => {
  assert.equal(detectMimeType("clip.mov"), "video/quicktime");
  assert.equal(detectMimeType("clip.mp4"), "video/mp4");
});

test("detectMimeType: unknown extension falls back to octet-stream", () => {
  assert.equal(detectMimeType("mystery.xyz"), "application/octet-stream");
  assert.equal(detectMimeType("no-extension"), "application/octet-stream");
});

// ─── hashId ───────────────────────────────────────────────────────────

test("hashId: deterministic 24-char hex output", () => {
  const id = hashId("a|b|c");
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(id, hashId("a|b|c"));
});

test("hashId: differs for different inputs", () => {
  assert.notEqual(hashId("a"), hashId("b"));
});

// ─── buildPhotoRecord ────────────────────────────────────────────────────

test("buildPhotoRecord: builds a fully-populated record from file metadata + hydration", () => {
  const file: DiscoveredFile = {
    path: "/tmp/export/IMG_0001.jpg",
    sizeBytes: 1024,
    mtimeIso: "2024-06-05T13:45:22.000Z",
  };
  const contentSha256 = sha256("fake-jpeg-bytes");
  const rec = buildPhotoRecord(file, "IMG_0001.jpg", hydrated(contentSha256));

  assert.match(rec.id, /^[0-9a-f]{24}$/);
  assert.equal(rec.filename, "IMG_0001.jpg");
  assert.equal(rec.content_type, "image/jpeg");
  assert.equal(rec.size_bytes, 1024);
  assert.equal(rec.content_sha256, contentSha256);
  assert.equal(rec.file_modified_at, "2024-06-05T13:45:22.000Z");
  assert.equal(rec.hydration_status, "unavailable");
  assert.equal(rec.hydration_error, null);
  assert.equal(rec.blob_ref, null);
  // No EXIF/XMP parsing in this cut — these fields are always null, a
  // bounded, documented omission (see index.ts header + parsers.ts
  // buildPhotoRecord doc comment).
  assert.equal(rec.taken_at, null);
  assert.equal(rec.latitude, null);
  assert.equal(rec.longitude, null);
  assert.equal(rec.camera_make, null);
  assert.equal(rec.camera_model, null);
});

test("buildPhotoRecord: id is derived from content hash ALONE — dedups across different filenames/paths", () => {
  const fileA: DiscoveredFile = {
    path: "/tmp/export/album1/a.jpg",
    sizeBytes: 100,
    mtimeIso: "2024-06-05T00:00:00.000Z",
  };
  const fileB: DiscoveredFile = {
    path: "/tmp/export/album2-copy/renamed.jpg",
    sizeBytes: 100,
    mtimeIso: "2024-07-01T00:00:00.000Z",
  };
  const sha = sha256("identical-photo-bytes");
  const recA = buildPhotoRecord(fileA, "a.jpg", hydrated(sha));
  const recB = buildPhotoRecord(fileB, "renamed.jpg", hydrated(sha));
  assert.equal(
    recA.id,
    recB.id,
    "same content hash must collapse to the same record id regardless of filename/path/mtime"
  );
});

test("buildPhotoRecord: different content hash → different id", () => {
  const file: DiscoveredFile = { path: "/tmp/export/a.jpg", sizeBytes: 100, mtimeIso: "2024-06-05T13:45:22.000Z" };
  const a = buildPhotoRecord(file, "a.jpg", hydrated(sha256("x")));
  const b = buildPhotoRecord(file, "a.jpg", hydrated(sha256("y")));
  assert.notEqual(a.id, b.id);
});

test("buildPhotoRecord: hydrated status carries blob_ref through to the record", () => {
  const file: DiscoveredFile = { path: "/tmp/export/a.jpg", sizeBytes: 2048, mtimeIso: "2024-06-05T13:45:22.000Z" };
  const contentSha256 = sha256("bytes");
  const hydration: MediaHydrationResult = {
    blobRef: { blob_id: "blob-123", mime_type: "image/jpeg", sha256: contentSha256, size_bytes: 2048 },
    contentSha256,
    hydrationError: null,
    hydrationStatus: "hydrated",
    sizeBytes: 2048,
  };
  const rec = buildPhotoRecord(file, "a.jpg", hydration);
  assert.equal(rec.hydration_status, "hydrated");
  assert.deepEqual(rec.blob_ref, hydration.blobRef);
  assert.equal(rec.content_sha256, contentSha256);
  assert.equal(rec.size_bytes, 2048);
});

test("buildPhotoRecord: skipped_too_large keeps a typed record with no bytes/hash", () => {
  const file: DiscoveredFile = {
    path: "/tmp/export/huge.mov",
    sizeBytes: 999_999_999,
    mtimeIso: "2024-06-05T13:45:22.000Z",
  };
  const hydration: MediaHydrationResult = {
    blobRef: null,
    contentSha256: null,
    hydrationError: null,
    hydrationStatus: "skipped_too_large",
    sizeBytes: 999_999_999,
  };
  const rec = buildPhotoRecord(file, "huge.mov", hydration);
  assert.equal(rec.hydration_status, "skipped_too_large");
  assert.equal(rec.content_sha256, null);
  assert.equal(rec.blob_ref, null);
  // No content hash to dedup on — falls back to filename+size+mtime identity.
  assert.match(rec.id, /^[0-9a-f]{24}$/);
});

test("buildPhotoRecord: failed hydration (unreadable file) still emits a record, not a drop", () => {
  const file: DiscoveredFile = {
    path: "/tmp/export/corrupt.jpg",
    sizeBytes: 512,
    mtimeIso: "2024-06-05T13:45:22.000Z",
  };
  const hydration: MediaHydrationResult = {
    blobRef: null,
    contentSha256: null,
    hydrationError: "read failed",
    hydrationStatus: "failed",
    sizeBytes: null,
  };
  const rec = buildPhotoRecord(file, "corrupt.jpg", hydration);
  assert.equal(rec.hydration_status, "failed");
  assert.equal(rec.hydration_error, "read failed");
  assert.equal(rec.content_sha256, null);
});

test("buildPhotoRecord: fallback id (no content hash) still differs across distinct files", () => {
  const fileA: DiscoveredFile = { path: "/tmp/export/x.jpg", sizeBytes: 10, mtimeIso: "2024-06-05T00:00:00.000Z" };
  const fileB: DiscoveredFile = { path: "/tmp/export/y.jpg", sizeBytes: 20, mtimeIso: "2024-06-06T00:00:00.000Z" };
  const failedHydration: MediaHydrationResult = {
    blobRef: null,
    contentSha256: null,
    hydrationError: "read failed",
    hydrationStatus: "failed",
    sizeBytes: null,
  };
  const a = buildPhotoRecord(fileA, "x.jpg", failedHydration);
  const b = buildPhotoRecord(fileB, "y.jpg", failedHydration);
  assert.notEqual(a.id, b.id);
});

// ─── Cursor helpers ─────────────────────────────────────────────────────

test("isBeforeCursor: no cursor → false (keep)", () => {
  assert.equal(isBeforeCursor("2024-06-05T00:00:00.000Z", undefined), false);
});

test("isBeforeCursor: equal → true (skip already-emitted)", () => {
  assert.equal(isBeforeCursor("2024-06-05T00:00:00.000Z", "2024-06-05T00:00:00.000Z"), true);
});

test("isBeforeCursor: strictly after cursor → false (keep)", () => {
  assert.equal(isBeforeCursor("2024-06-06T00:00:00.000Z", "2024-06-05T00:00:00.000Z"), false);
});

test("advanceCursor: undefined prev → takes next", () => {
  assert.equal(advanceCursor(undefined, "2024-06-05T00:00:00.000Z"), "2024-06-05T00:00:00.000Z");
});

test("advanceCursor: next > prev → takes next", () => {
  assert.equal(advanceCursor("2024-06-05T00:00:00.000Z", "2024-06-06T00:00:00.000Z"), "2024-06-06T00:00:00.000Z");
});

test("advanceCursor: next < prev → keeps prev (monotonic)", () => {
  assert.equal(advanceCursor("2024-06-06T00:00:00.000Z", "2024-06-05T00:00:00.000Z"), "2024-06-06T00:00:00.000Z");
});
