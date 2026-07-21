// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rename, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanLocalJsonl } from "./local-jsonl-cursor.ts";

async function scan(path: string, prior?: Awaited<ReturnType<typeof scanLocalJsonl>>["cursor"]) {
  const lines: string[] = [];
  const result = await scanLocalJsonl({
    path,
    prior,
    onLine: (line) => {
      lines.push(line.toString("utf8"));
      return Promise.resolve();
    },
  });
  return { lines, result };
}

test("local JSONL cursor skips an mtime-only touch and tails one complete append", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"one"}\n');
  const first = await scan(path);
  const date = new Date(Date.now() + 10_000);
  await utimes(path, date, date);
  const touched = await scan(path, first.result.cursor);
  assert.equal(touched.result.decision.kind, "verified_noop");
  assert.deepEqual(touched.lines, []);
  await writeFile(path, '{"id":"one"}\n{"id":"two"}\n');
  const appended = await scan(path, touched.result.cursor);
  assert.deepEqual(appended.lines, ['{"id":"two"}']);
  assert.equal(appended.result.decision.kind, "append");
});

test("local JSONL cursor detects a changed committed byte beyond 64 KiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
  const path = join(root, "events.jsonl");
  const padding = "x".repeat(70_000);
  await writeFile(path, `${JSON.stringify({ id: "one", padding })}\n`);
  const first = await scan(path);
  const contents = await (await import("node:fs/promises")).readFile(path, "utf8");
  await writeFile(path, contents.replace("x", "y"));
  const rewritten = await scan(path, first.result.cursor);
  assert.deepEqual(rewritten.lines, [contents.replace("x", "y").trim()]);
  assert.deepEqual(rewritten.result.decision, { kind: "rebuild", reason: "prefix_changed" });
});

test("local JSONL cursor retains an unterminated line until it gains LF", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"partial');
  const first = await scan(path);
  assert.equal(first.result.cursor.committed_offset_bytes, 0);
  assert.deepEqual(first.lines, []);
  await writeFile(path, '{"id":"partial"}\n');
  const second = await scan(path, first.result.cursor);
  assert.deepEqual(second.lines, ['{"id":"partial"}']);
});

test("local JSONL cursor rebuilds after a replacement or truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"one"}\n');
  const first = await scan(path);
  await truncate(path, 0);
  await writeFile(path, '{"id":"new"}\n');
  const truncated = await scan(path, first.result.cursor);
  assert.equal(truncated.result.decision.kind, "rebuild");
  assert.deepEqual(truncated.lines, ['{"id":"new"}']);
  const replacement = join(root, "replacement.jsonl");
  await writeFile(replacement, '{"id":"new"}\n{"id":"later"}\n');
  await rename(replacement, path);
  const rotated = await scan(path, truncated.result.cursor);
  assert.deepEqual(rotated.lines, ['{"id":"later"}']);
  assert.equal(rotated.result.decision.kind, "append");
});

test("local JSONL cursor rejects an in-scan same-size mutation without returning a cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"one"}\n');
  await assert.rejects(
    scanLocalJsonl({
      path,
      onLine: async () => {
        await writeFile(path, '{"id":"two"}\n');
      },
      prior: undefined,
    }),
    /mutated while scanning/
  );
});

test("local JSONL cursor rejects a concurrent committed-prefix rewrite plus growth", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"one"}\n');
  await assert.rejects(
    scanLocalJsonl({
      path,
      onLine: async () => {
        await writeFile(path, '{"id":"rewritten"}\n{"id":"grown"}\n');
      },
      prior: undefined,
    }),
    /committed prefix changed while scanning/
  );
  const retry = await scan(path);
  assert.deepEqual(retry.lines, ['{"id":"rewritten"}', '{"id":"grown"}']);
});

test("local JSONL cursor never clean-appends after a prior-prefix rewrite plus growth", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
  const path = join(root, "events.jsonl");
  await writeFile(path, '{"id":"one"}\n');
  const first = await scan(path);
  await writeFile(path, '{"id":"one"}\n{"id":"two"}\n');
  await assert.rejects(
    scanLocalJsonl({
      path,
      prior: first.result.cursor,
      onLine: async () => {
        await writeFile(path, '{"id":"rewritten"}\n{"id":"two"}\n{"id":"three"}\n');
      },
    }),
    /committed prefix changed while scanning/
  );
  const retry = await scan(path);
  assert.deepEqual(retry.lines, ['{"id":"rewritten"}', '{"id":"two"}', '{"id":"three"}']);
});
