// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { buildEmptyExportDirFixture, buildExportDirFixture } from "./fixtures.ts";
import { photosSchema } from "./schemas.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "apple_photos", "index.ts");

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD")
    .filter((m) => m.stream === stream)
    .map((m) => m.data);
}

function skips(messages: readonly EmittedMessage[]): Extract<EmittedMessage, { type: "SKIP_RESULT" }>[] {
  return messages.filter((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
}

function states(messages: readonly EmittedMessage[]): Extract<EmittedMessage, { type: "STATE" }>[] {
  return messages.filter((m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE");
}

function runApplePhotos(exportDir: string, streams: string[], state: Record<string, unknown> = {}) {
  return runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: {
      APPLE_PHOTOS_EXPORT_DIR: exportDir,
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
    },
    start: {
      scope: { streams: streams.map((name) => ({ name })) },
      state,
      type: "START",
    },
  });
}

test("apple_photos SKIP_RESULTs export_not_found when the export dir does not exist", async () => {
  const nonexistentDir = join(process.cwd(), "does-not-exist-apple-photos-export");
  const result = await runApplePhotos(nonexistentDir, ["photos"]);
  const skip = skips(result.messages).find((s) => s.stream === "photos");
  assert.ok(skip, "expected a photos SKIP_RESULT");
  assert.equal(skip?.reason, "export_not_found");
  assert.match(skip?.message ?? "", /Export photos from Photos\.app/);
  assert.equal(records(result.messages, "photos").length, 0);
});

test("apple_photos SKIP_RESULTs export_not_found when the export dir exists but is empty", async () => {
  const dir = buildEmptyExportDirFixture();
  try {
    const result = await runApplePhotos(dir, ["photos"]);
    const skip = skips(result.messages).find((s) => s.stream === "photos");
    assert.ok(skip, "expected a photos SKIP_RESULT for an empty export dir");
    assert.equal(skip?.reason, "export_not_found");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("apple_photos extracts filename/size/hash/mtime/content_type for fixture files", async () => {
  const mtime = new Date("2024-06-05T13:45:22.000Z");
  const dir = buildExportDirFixture([
    { relPath: "IMG_0001.jpg", contents: Buffer.from("fake-jpeg-content"), mtime },
    { relPath: "subalbum/clip.mov", contents: Buffer.from("fake-mov-content"), mtime },
  ]);
  try {
    const result = await runApplePhotos(dir, ["photos"]);
    const photos = records(result.messages, "photos");
    assert.equal(photos.length, 2);

    const jpg = photos.find((p) => p.filename === "IMG_0001.jpg");
    assert.ok(jpg, "expected the jpg record");
    assert.equal(jpg?.content_type, "image/jpeg");
    assert.equal(jpg?.size_bytes, Buffer.from("fake-jpeg-content").byteLength);
    assert.match(String(jpg?.content_sha256), /^[0-9a-f]{64}$/);
    assert.equal(jpg?.file_modified_at, mtime.toISOString());
    assert.equal(jpg?.taken_at, null);

    const mov = photos.find((p) => p.filename === "clip.mov");
    assert.ok(mov, "expected the mov record from the nested subdirectory");
    assert.equal(mov?.content_type, "video/quicktime");

    // Every emitted record validates against the schema.
    for (const p of photos) {
      const parsed = photosSchema.safeParse(p);
      assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("apple_photos ignores unsupported file extensions", async () => {
  const dir = buildExportDirFixture([
    { relPath: "IMG_0001.jpg", contents: Buffer.from("real-photo") },
    { relPath: "readme.txt", contents: Buffer.from("not a photo") },
    { relPath: ".DS_Store", contents: Buffer.from("mac metadata") },
  ]);
  try {
    const result = await runApplePhotos(dir, ["photos"]);
    const photos = records(result.messages, "photos");
    assert.equal(photos.length, 1);
    assert.equal(photos[0]?.filename, "IMG_0001.jpg");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("apple_photos cursor carries forward: a second run with prior STATE only emits newer files", async () => {
  const older = new Date("2024-06-01T00:00:00.000Z");
  const newer = new Date("2024-06-10T00:00:00.000Z");
  const dir = buildExportDirFixture([
    { relPath: "old.jpg", contents: Buffer.from("old"), mtime: older },
    { relPath: "new.jpg", contents: Buffer.from("new"), mtime: newer },
  ]);
  try {
    const first = await runApplePhotos(dir, ["photos"]);
    const firstPhotos = records(first.messages, "photos");
    assert.equal(firstPhotos.length, 2);
    const firstState = states(first.messages).find((s) => s.stream === "photos");
    assert.ok(firstState, "expected a photos STATE checkpoint");
    assert.equal((firstState.cursor as { last_modified: string }).last_modified, newer.toISOString());

    // Second run seeded with a cursor between old and new mtimes should
    // only re-emit the newer file.
    const second = await runApplePhotos(dir, ["photos"], {
      photos: { last_modified: older.toISOString() },
    });
    const secondPhotos = records(second.messages, "photos");
    assert.equal(secondPhotos.length, 1);
    assert.equal(secondPhotos[0]?.filename, "new.jpg");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
