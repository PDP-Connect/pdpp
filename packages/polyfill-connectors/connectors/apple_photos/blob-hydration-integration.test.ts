// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end blob hydration coverage for the `photos` stream through the
 * real connector protocol subprocess: hydrated success, oversized/too-large,
 * upload failure, and content-hash dedup across two "export copies" of the
 * same photo. Mirrors google_takeout's photos-integration.test.ts pattern —
 * both connectors share src/local-media-blob-hydration.ts, so this test
 * proves apple_photos wires the SAME hydration contract, not a reimplementation.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "apple_photos", "index.ts");

// Bounded fixture bytes: small deterministic buffers, never real photo data.
const TINY_JPEG_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD")
    .filter((m) => m.stream === stream)
    .map((m) => m.data);
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((done, reject) => {
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function withBlobServer<T>(
  handler: (req: IncomingMessage) => Promise<{ body: unknown; status: number }>,
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = createServer((req, res) => {
    handler(req)
      .then(({ body, status }) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      })
      .catch((err: unknown) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "test server error" }));
      });
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => done());
    });
    const address = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((done, reject) => {
      server.close((err) => (err ? reject(err) : done()));
    });
  }
}

async function runApplePhotos(
  exportDir: string,
  env: Record<string, string> = {}
): Promise<{ messages: EmittedMessage[]; photos: Record<string, unknown>[] }> {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: {
      APPLE_PHOTOS_EXPORT_DIR: exportDir,
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
      ...env,
    },
    start: {
      scope: { streams: [{ name: "photos" }] },
      state: {},
      type: "START",
    },
  });
  return { messages: result.messages, photos: records(result.messages, "photos") };
}

test("photos stream hydrates bytes through the reference blob endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-apple-photos-hydrate-"));
  try {
    await writeFile(join(dir, "IMG_1111.jpg"), TINY_JPEG_A);

    await withBlobServer(
      async (req) => {
        assert.equal(req.headers.authorization, "Bearer owner-token");
        assert.equal(req.headers["content-type"], "application/octet-stream");
        const url = new URL(req.url ?? "", "http://127.0.0.1");
        assert.equal(url.searchParams.get("mime_type"), "image/jpeg");
        const body = await readRequestBody(req);
        const sha256 = createHash("sha256").update(body).digest("hex");
        return {
          body: {
            blob_id: `blob_sha256_${sha256}`,
            mime_type: url.searchParams.get("mime_type"),
            object: "blob",
            sha256,
            size_bytes: body.byteLength,
          },
          status: 200,
        };
      },
      async (baseUrl) => {
        const { photos } = await runApplePhotos(dir, {
          PDPP_OWNER_TOKEN: "owner-token",
          PDPP_RS_URL: baseUrl,
        });
        assert.equal(photos.length, 1);
        assert.equal(photos[0]?.hydration_status, "hydrated");
        assert.equal(photos[0]?.hydration_error, null);
        assert.deepEqual(photos[0]?.blob_ref, {
          blob_id: `blob_sha256_${photos[0]?.content_sha256}`,
          mime_type: "image/jpeg",
          sha256: photos[0]?.content_sha256,
          size_bytes: TINY_JPEG_A.byteLength,
        });
      }
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("photos stream marks hydration failed (not fabricated deletion) when blob upload fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-apple-photos-hydrate-fail-"));
  try {
    await writeFile(join(dir, "IMG_2222.jpg"), TINY_JPEG_A);

    await withBlobServer(
      async () => ({ body: { error: "synthetic upload failure" }, status: 500 }),
      async (baseUrl) => {
        const { photos } = await runApplePhotos(dir, {
          PDPP_OWNER_TOKEN: "owner-token",
          PDPP_RS_URL: baseUrl,
        });
        assert.equal(photos.length, 1, "the record is still emitted even though hydration failed");
        assert.equal(photos[0]?.hydration_status, "failed");
        assert.deepEqual(photos[0]?.blob_ref, null);
        assert.match(String(photos[0]?.hydration_error), /500/);
        assert.doesNotMatch(String(photos[0]?.hydration_error), /IMG_2222/);
      }
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("photos stream skips oversized files without dropping the record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-apple-photos-oversized-"));
  try {
    await writeFile(join(dir, "big.jpg"), TINY_JPEG_A);

    const { photos } = await runApplePhotos(dir, {
      PDPP_APPLE_PHOTOS_MAX_PHOTO_BYTES: "1",
    });

    assert.equal(photos.length, 1);
    assert.equal(photos[0]?.hydration_status, "skipped_too_large");
    assert.equal(photos[0]?.blob_ref, null);
    assert.equal(photos[0]?.content_sha256, null);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("photos stream dedupes identical-content files discovered under different names/subdirectories to one record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-apple-photos-dedup-"));
  try {
    // Simulates the same photo present in two different Photos.app album
    // exports — same bytes, different filename and directory.
    await mkdir(join(dir, "album-1"), { recursive: true });
    await mkdir(join(dir, "album-2-copy"), { recursive: true });
    await writeFile(join(dir, "album-1", "IMG_3333.jpg"), TINY_JPEG_A);
    await writeFile(join(dir, "album-2-copy", "IMG_3333_copy.jpg"), TINY_JPEG_A);

    const { photos } = await runApplePhotos(dir);

    // Both files were discovered and hydrated, but since content_sha256 is
    // identical, buildPhotoRecord derives the same `id` for both — the
    // record itself (a mutable_state stream keyed by id) collapses to one
    // logical photo rather than two duplicate entries.
    const ids = new Set(photos.map((p) => p.id));
    assert.equal(photos.length, 2, "both files are discovered/hydrated independently");
    assert.equal(ids.size, 1, "identical content collapses to a single record id (dedup by content hash)");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
