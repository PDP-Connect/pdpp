// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for the `photos` stream through the real connector
 * protocol subprocess: directory discovery, sidecar matching, content-hash
 * dedup across duplicated album copies, unsupported files, and blob
 * hydration. Complements the pure-function unit tests in schemas.test.ts.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const GOOGLE_TAKEOUT_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "google_takeout", "index.ts");

// Bounded fixture bytes: small deterministic buffers, never real photo data.
const TINY_JPEG_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const TINY_JPEG_B = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20]);

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((message): message is Extract<EmittedMessage, { type: "RECORD" }> => message.type === "RECORD")
    .filter((message) => message.stream === stream)
    .map((message) => message.data);
}

function skipResults(messages: readonly EmittedMessage[]): Extract<EmittedMessage, { type: "SKIP_RESULT" }>[] {
  return messages.filter(
    (message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => message.type === "SKIP_RESULT"
  );
}

async function runPhotosImport(
  importRoot: string,
  env: Record<string, string> = {}
): Promise<{ messages: EmittedMessage[]; photos: Record<string, unknown>[] }> {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: GOOGLE_TAKEOUT_ENTRYPOINT,
    env: {
      GOOGLE_TAKEOUT_DIR: importRoot,
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
      ...env,
    },
    start: {
      scope: { streams: [{ name: "photos" }] },
      type: "START",
    },
  });
  return { messages: result.messages, photos: records(result.messages, "photos") };
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

test("photos stream discovers files, matches sidecars, and skips unsupported files", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-takeout-photos-"));
  try {
    const photosDir = join(importRoot, "Photos", "Photos from 2024");
    await mkdir(photosDir, { recursive: true });
    await writeFile(join(photosDir, "IMG_0001.jpg"), TINY_JPEG_A);
    await writeFile(
      join(photosDir, "IMG_0001.jpg.json"),
      JSON.stringify({ title: "Sunset", photoTakenTime: { timestamp: "1717600000" } })
    );
    // Edited variant: Google does not emit a separate sidecar for it, so it
    // shares the original's prefix-matched sidecar (community-observed
    // Takeout behavior — see connector-primary-reconcile-0807.md §2).
    await writeFile(join(photosDir, "IMG_0001-edited.jpg"), TINY_JPEG_B);
    // Genuinely sidecar-less file (no other JSON in the directory shares a
    // meaningful prefix with it) — must still produce a record, not an error.
    await writeFile(join(photosDir, "zzz_no_sidecar.png"), TINY_JPEG_B);
    // Unsupported file type alongside real media.
    await writeFile(join(photosDir, "notes.txt"), "not a photo");
    // Per-album metadata.json must not be treated as a media sidecar match target for unrelated files.
    await writeFile(join(photosDir, "metadata.json"), JSON.stringify({ title: "Photos from 2024" }));

    const { photos, messages } = await runPhotosImport(importRoot);

    assert.equal(photos.length, 3, "IMG_0001.jpg, IMG_0001-edited.jpg, and zzz_no_sidecar.png are all discovered");

    const noSidecar = photos.find((p) => p.filename === "zzz_no_sidecar.png");
    assert.ok(noSidecar);
    assert.equal(noSidecar.title, null, "no matching sidecar; not an error");
    const withMetadata = photos.find((p) => p.filename === "IMG_0001.jpg");
    assert.ok(withMetadata);
    assert.equal(withMetadata.title, "Sunset");
    assert.match(String(withMetadata.content_sha256), /^[0-9a-f]{64}$/);

    const editedVariant = photos.find((p) => p.filename === "IMG_0001-edited.jpg");
    assert.ok(editedVariant);
    // Both files' bytes differ (TINY_JPEG_A vs TINY_JPEG_B), so they remain
    // distinct records even though they share sidecar-derived metadata.
    assert.equal(editedVariant.title, "Sunset");
    assert.notEqual(editedVariant.id, withMetadata.id);

    const progressText = messages
      .filter((m): m is Extract<EmittedMessage, { type: "PROGRESS" }> => m.type === "PROGRESS")
      .map((m) => m.message)
      .join("\n");
    assert.match(progressText, /unsupported_files=1/);
    assert.doesNotMatch(progressText, /notes\.txt/);

    const done = messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "succeeded");
    }
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("photos stream collapses duplicate album copies of the same photo to one record via content hash", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-takeout-dup-"));
  try {
    const albumA = join(importRoot, "Photos", "Vacation");
    const albumB = join(importRoot, "Photos", "Photos from 2024");
    await mkdir(albumA, { recursive: true });
    await mkdir(albumB, { recursive: true });
    // Google Takeout duplicates identical bytes into every album a photo
    // belongs to; per-copy sidecar fields (e.g. creationTime) can differ.
    await writeFile(join(albumA, "IMG_9999.jpg"), TINY_JPEG_A);
    await writeFile(join(albumA, "IMG_9999.jpg.json"), JSON.stringify({ creationTime: { timestamp: "1717600000" } }));
    await writeFile(join(albumB, "IMG_9999.jpg"), TINY_JPEG_A);
    await writeFile(join(albumB, "IMG_9999.jpg.json"), JSON.stringify({ creationTime: { timestamp: "1717600100" } }));

    const { photos } = await runPhotosImport(importRoot);

    const ids = new Set(photos.map((p) => p.id));
    assert.equal(ids.size, 1, "identical bytes in two album folders collapse to one record id");
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("photos stream matches a truncated supplemental-metadata sidecar by prefix", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-takeout-truncated-"));
  try {
    const photosDir = join(importRoot, "Photos", "Photos from 2024");
    await mkdir(photosDir, { recursive: true });
    const longName = "a_very_long_original_filename_from_a_phone_camera.jpg";
    await writeFile(join(photosDir, longName), TINY_JPEG_A);
    // Simulates Google's real truncation of the newer sidecar suffix.
    await writeFile(
      join(photosDir, "a_very_long_original_filename_from_a_ph.supplemental-m.json"),
      JSON.stringify({ title: "Truncated sidecar match" })
    );

    const { photos } = await runPhotosImport(importRoot);

    assert.equal(photos.length, 1);
    assert.equal(photos[0]?.title, "Truncated sidecar match");
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("photos stream skips oversized files without dropping the record", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-takeout-oversized-"));
  try {
    const photosDir = join(importRoot, "Photos", "Photos from 2024");
    await mkdir(photosDir, { recursive: true });
    await writeFile(join(photosDir, "big.jpg"), TINY_JPEG_A);

    const { photos } = await runPhotosImport(importRoot, {
      PDPP_GOOGLE_TAKEOUT_MAX_PHOTO_BYTES: "1",
    });

    assert.equal(photos.length, 1);
    assert.equal(photos[0]?.hydration_status, "skipped_too_large");
    assert.equal(photos[0]?.blob_ref, null);
    assert.equal(photos[0]?.content_sha256, null);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("photos stream reports directory-read failures without leaking the local path", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-takeout-missing-"));
  try {
    // Do not create a Photos/ directory at all.
    const { messages } = await runPhotosImport(importRoot);
    const skips = skipResults(messages);
    assert.equal(skips.length, 1);
    assert.equal(skips[0]?.reason, "photos_not_found");
    assert.doesNotMatch(skips[0]?.message ?? "", new RegExp(importRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("photos stream hydrates bytes through the reference blob endpoint", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-takeout-hydrate-"));
  try {
    const photosDir = join(importRoot, "Photos", "Photos from 2024");
    await mkdir(photosDir, { recursive: true });
    await writeFile(join(photosDir, "IMG_1111.jpg"), TINY_JPEG_A);

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
        const { photos } = await runPhotosImport(importRoot, {
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
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("photos stream marks hydration failed (not fabricated deletion) when blob upload fails", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-takeout-hydrate-fail-"));
  try {
    const photosDir = join(importRoot, "Photos", "Photos from 2024");
    await mkdir(photosDir, { recursive: true });
    await writeFile(join(photosDir, "IMG_2222.jpg"), TINY_JPEG_A);

    await withBlobServer(
      async () => ({ body: { error: "synthetic upload failure" }, status: 500 }),
      async (baseUrl) => {
        const { photos } = await runPhotosImport(importRoot, {
          PDPP_OWNER_TOKEN: "owner-token",
          PDPP_RS_URL: baseUrl,
        });
        assert.equal(photos.length, 1, "the record is still emitted even though hydration failed");
        assert.equal(photos[0]?.hydration_status, "failed");
        assert.deepEqual(photos[0]?.blob_ref, null);
        assert.match(String(photos[0]?.hydration_error), /500/);
        assert.doesNotMatch(String(photos[0]?.hydration_error), /IMG_2222|Photos from 2024/);
      }
    );
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});
