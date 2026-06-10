/**
 * Regression tests for the tool-result emit path's memory bound.
 *
 * `emitToolResultFile` previously read the *entire* on-disk blob into a string
 * just to keep a short `content_preview` — an O(file) allocation that blew up
 * on huge Claude Code sessions (a single `tool-results/*.txt` can be hundreds
 * of MB). The fix reads only a bounded head prefix. These tests pin:
 *   - the emitted record shape is unchanged (preview, bytes, binary reason);
 *   - `content_bytes` reflects the FULL file size (from stat), not the prefix;
 *   - a file far larger than the preview budget still emits a correct preview;
 *   - binary content is still flagged.
 */

import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { RecordData } from "../../src/connector-runtime.ts";
import { emitToolResultFile } from "./index.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pdpp-tool-result-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Emitted {
  data: RecordData;
  stream: string;
}

async function emitFor(name: string, body: Buffer | string): Promise<Emitted[]> {
  const toolResultsDir = join(dir, "tool-results");
  const full = join(toolResultsDir, name);
  await writeFile(full, body); // writeFile creates the parent only if it exists
  return await runEmit(toolResultsDir, full);
}

async function runEmit(toolResultsDir: string, full: string): Promise<Emitted[]> {
  const emitted: Emitted[] = [];
  const st: Stats = await stat(full);
  await emitToolResultFile({
    emitRecord: async (stream, data) => {
      emitted.push({ stream, data });
      await Promise.resolve();
    },
    full,
    toolResultsDir,
    projectDir: "proj",
    sessionId: "sess-1",
    st,
  });
  return emitted;
}

test("small tool-result: preview + full byte count", async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "tool-results"), { recursive: true });
  const emitted = await emitFor("r.txt", "small output");
  assert.equal(emitted.length, 1);
  const rec = emitted[0];
  assert.ok(rec);
  assert.equal(rec.stream, "attachments");
  assert.equal(rec.data.event_type, "tool_result_file");
  assert.equal(rec.data.content_preview, "small output");
  assert.equal(rec.data.content_binary_reason, null);
  assert.equal(rec.data.content_bytes, Buffer.byteLength("small output"));
});

test("huge tool-result: preview is bounded, content_bytes is the FULL size", async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "tool-results"), { recursive: true });
  // 16 MiB of repeating text — preview must come from the head, byte count
  // from stat. The test passing at all proves we don't OOM on the read.
  const fullSize = 16 * 1024 * 1024;
  const body = "L".repeat(fullSize);
  const emitted = await emitFor("big.txt", body);
  assert.equal(emitted.length, 1);
  const rec = emitted[0];
  assert.ok(rec);
  // content_bytes is the WHOLE file, not the bounded prefix.
  assert.equal(rec.data.content_bytes, fullSize);
  // Preview is bounded (TOOL_RESULT_PREVIEW_CHARS = 500) + ellipsis.
  const preview = rec.data.content_preview as string;
  assert.ok(preview.length <= 501, `preview should be bounded, got ${preview.length}`);
  assert.ok(preview.startsWith("LLL"));
  assert.ok(preview.endsWith("…"), "long content should be truncated with an ellipsis");
});

test("binary tool-result: preview null + binary reason set", async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "tool-results"), { recursive: true });
  const emitted = await emitFor("bin.txt", Buffer.from([0x61, 0x00, 0x62]));
  assert.equal(emitted.length, 1);
  const rec = emitted[0];
  assert.ok(rec);
  assert.equal(rec.data.content_preview, null);
  assert.ok(typeof rec.data.content_binary_reason === "string");
});

test("unreadable tool-result path: emits nothing (caller-tolerant)", async () => {
  const { mkdir } = await import("node:fs/promises");
  const toolResultsDir = join(dir, "tool-results");
  await mkdir(toolResultsDir, { recursive: true });
  const missing = join(toolResultsDir, "gone.txt");
  await writeFile(missing, "x");
  const st: Stats = await stat(missing);
  await rm(missing);
  const emitted: Emitted[] = [];
  await emitToolResultFile({
    emitRecord: async (stream, data) => {
      emitted.push({ stream, data });
      await Promise.resolve();
    },
    full: missing,
    toolResultsDir,
    projectDir: "proj",
    sessionId: "sess-1",
    st,
  });
  assert.equal(emitted.length, 0);
});
