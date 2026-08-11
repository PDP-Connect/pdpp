// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the .txt two-pass TOCTOU fix (manual-upload-large-artifact,
 * red-team finding #3): pass 1 (identity scan) and pass 2 (message
 * emission) both read a staged .txt export from disk, independently. If
 * the file changes between passes -- a concurrent re-upload reusing the
 * same staging filename, or this connector's own boot sweep touching the
 * staging directory -- pass 2 could silently parse different bytes than
 * pass 1 scanned, producing a chatId/identity derived from content A but
 * messages emitted from content B.
 *
 * index.ts closes this two ways:
 *  1. Both passes read from the SAME pinned file descriptor (opened once,
 *     kept open for the export's lifetime), not a fresh path-based open
 *     per pass -- closes the "path resolves to a different inode" half of
 *     the race.
 *  2. A (size, mtimeMs) snapshot is taken at the end of pass 1 and
 *     re-checked via a fresh fstat on that SAME fd immediately before pass
 *     2 starts; a mismatch throws TxtArtifactChangedError rather than
 *     emitting against inconsistent content -- closes the "same inode,
 *     mutated in place" half.
 *
 * The race window is normally sub-millisecond in production. This suite
 * uses the test-only PDPP_TEST_TXT_TOCTOU_BARRIER_DIR hook (index.ts,
 * testOnlyTxtToctouBarrier) to pause at the exact pass boundary. The test
 * rewrites only after the child signals that pass 1 is complete, then
 * releases pass 2, so it does not rely on subprocess startup timing.
 */

import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

function largeFixtureBaseDir(): string {
  return process.env.PDPP_TEST_LARGE_FIXTURE_DIR || tmpdir();
}

async function waitForBarrier(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for test barrier: ${path}`, { cause: error });
      }
      await new Promise((done) => setTimeout(done, 10));
    }
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const WHATSAPP_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "whatsapp", "index.ts");

const ORIGINAL_EXPORT = `[6/5/24, 9:15:22 AM] Alice: Hello
[6/5/24, 9:16:00 AM] Bob: Hi there`;

// Same byte length as ORIGINAL_EXPORT so a size-only identity check (no
// mtime component) would NOT catch this mutation -- proves the fix checks
// mtimeMs too, not just size.
const REWRITTEN_SAME_SIZE_EXPORT = `[6/5/24, 9:15:22 AM] Alice: Zzzzz
[6/5/24, 9:16:00 AM] Bob: Hi there`;

test("a .txt export rewritten (same size, new mtime) between pass 1 and pass 2 fails the run rather than emitting mismatched content", async () => {
  assert.equal(
    Buffer.byteLength(ORIGINAL_EXPORT, "utf8"),
    Buffer.byteLength(REWRITTEN_SAME_SIZE_EXPORT, "utf8"),
    "fixture sanity: the rewrite must be same-size to prove mtime, not just size, is checked"
  );
  const importRoot = await mkdtemp(join(largeFixtureBaseDir(), "pdpp-whatsapp-toctou-"));
  const filePath = join(importRoot, "WhatsApp Chat - Alice.txt");
  try {
    await writeFile(filePath, ORIGINAL_EXPORT);

    const runPromise = runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: WHATSAPP_ENTRYPOINT,
      env: {
        PDPP_OWNER_TOKEN: "",
        PDPP_RS_URL: "",
        PDPP_TEST_TXT_TOCTOU_BARRIER_DIR: importRoot,
        RS_URL: "",
        TZ: "America/Chicago",
        WHATSAPP_EXPORT_DIR: importRoot,
      },
      start: {
        scope: { streams: [{ name: "chats" }, { name: "messages" }] },
        type: "START",
      },
      timeoutMs: 15_000,
    });

    await waitForBarrier(join(importRoot, "pass-1-complete"));
    await writeFile(filePath, REWRITTEN_SAME_SIZE_EXPORT);
    await writeFile(join(importRoot, "release-pass-2"), "release\n");

    const result = await runPromise;
    const done = result.messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "failed", "the run must fail closed, not silently emit mismatched content");
      assert.match(done.error?.message ?? "", /changed on disk/);
    }
    const messageRecords = result.messages.filter(
      (m): m is Extract<typeof m, { type: "RECORD" }> => m.type === "RECORD" && m.stream === "messages"
    );
    assert.equal(messageRecords.length, 0, "no message records were emitted from the mismatched second pass");
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("a .txt export left UNCHANGED between pass 1 and pass 2 (barrier active, no mutation) still succeeds", async () => {
  // Proves the barrier + identity re-check do not themselves introduce a
  // false positive: releasing the exact boundary without touching the file
  // must still succeed.
  const importRoot = await mkdtemp(join(largeFixtureBaseDir(), "pdpp-whatsapp-toctou-stable-"));
  const filePath = join(importRoot, "WhatsApp Chat - Alice.txt");
  try {
    await writeFile(filePath, ORIGINAL_EXPORT);

    const runPromise = runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: WHATSAPP_ENTRYPOINT,
      env: {
        PDPP_OWNER_TOKEN: "",
        PDPP_RS_URL: "",
        PDPP_TEST_TXT_TOCTOU_BARRIER_DIR: importRoot,
        RS_URL: "",
        TZ: "America/Chicago",
        WHATSAPP_EXPORT_DIR: importRoot,
      },
      start: {
        scope: { streams: [{ name: "chats" }, { name: "messages" }] },
        type: "START",
      },
      timeoutMs: 15_000,
    });
    await waitForBarrier(join(importRoot, "pass-1-complete"));
    await writeFile(join(importRoot, "release-pass-2"), "release\n");
    const result = await runPromise;

    const done = result.messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "succeeded");
    }
    const messageRecords = result.messages.filter(
      (m): m is Extract<typeof m, { type: "RECORD" }> => m.type === "RECORD" && m.stream === "messages"
    );
    assert.equal(messageRecords.length, 2, "both messages are emitted when the file is genuinely unchanged");
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});
