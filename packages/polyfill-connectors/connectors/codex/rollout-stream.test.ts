/**
 * Memory-bound + append-safety tests for the Codex rollout streaming reader
 * (`iterJsonlLinesFromOffset`).
 *
 * This is the load-bearing component for the acceptance bar "stream or bound
 * active JSONL processing rather than loading multi-GB files wholesale." The
 * live root cause was a long-lived Codex session JSONL that can exceed 1 GB
 * while it is still being appended to. Two distinct memory failures matter:
 *
 *   1. Reading the whole active file into memory on every run (a wholesale
 *      `readFile(path, "utf8")` would resident-load the entire file — and on a
 *      >512 MB file would also throw V8's max-string-length error).
 *   2. Re-emitting the whole historical prefix on every append instead of
 *      tailing only the new suffix.
 *
 * `integration.test.ts` pins the per-line dispatcher (`processRolloutLine`) and
 * `append-cursor.test.ts` pins the end-to-end cursor round-trip, but neither
 * exercises the streaming reader directly. These tests close that gap: they
 * drive `iterJsonlLinesFromOffset` against real on-disk files and assert the
 * four invariants that keep a multi-GB parse bounded:
 *
 *   A. Resume-from-offset: starting at a prior committed offset yields ONLY the
 *      lines past it — never the prefix. This is what makes an append tail.
 *   B. Byte-offset exactness: `committedOffset` lands precisely one byte past
 *      each `\n`, over raw bytes (so a later resume never splits a line), and is
 *      correct for multi-byte UTF-8 content.
 *   C. Partial-trailing-line safety: an unterminated final line (an in-flight
 *      append) is NOT yielded and does NOT advance the offset, so it is re-read
 *      intact on the next run — no skipped line, no duplicated/garbled line.
 *   D. Bounded residency: peak resident Buffer memory (`arrayBuffers`) while
 *      streaming a file whose total size is many times any single line stays
 *      far below the file size. A regression that accumulated the file into one
 *      Buffer would spike `arrayBuffers` toward the full file size and fail this
 *      guard. (`arrayBuffers` is used rather than RSS because RSS is perturbed
 *      by V8 heap-arena growth and flakes at tens of MB.)
 *
 * These run with the real Node fs stack (no fixtures), writing temp files under
 * the OS tmp dir and cleaning them up.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { iterJsonlLinesFromOffset } from "./index.ts";

/** Byte length of a string as it lands on disk (UTF-8), so tests can predict
 *  committed offsets without re-reading the file. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-codex-stream-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function collect(path: string, startOffset: number): Promise<Array<{ obj: unknown; committedOffset: number }>> {
  const out: Array<{ obj: unknown; committedOffset: number }> = [];
  for await (const yielded of iterJsonlLinesFromOffset(path, startOffset)) {
    out.push(yielded);
  }
  return out;
}

// ─── Invariant A + B: resume-from-offset and byte-exact committed offsets ────

test("iterJsonlLinesFromOffset: yields each line with the byte offset just past its terminator", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "rollout.jsonl");
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call" } }),
    ];
    const body = `${lines.join("\n")}\n`;
    await writeFile(path, body);

    const yielded = await collect(path, 0);
    assert.equal(yielded.length, 3, "every newline-terminated line is yielded");

    // committedOffset is cumulative byte length up to and including each `\n`.
    let expected = 0;
    for (let i = 0; i < lines.length; i++) {
      expected += byteLen(lines[i] as string) + 1; // +1 for the `\n`
      assert.equal(yielded[i]?.committedOffset, expected, `line ${i} commits at the byte just past its terminator`);
    }
    // The final commit equals the whole file size (file ends on a terminator).
    assert.equal(yielded.at(-1)?.committedOffset, byteLen(body), "final commit == file size");
  });
});

test("iterJsonlLinesFromOffset: resuming from a prior committed offset yields ONLY the suffix (the append tail)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "rollout.jsonl");
    const head = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`;
    const tail = `${JSON.stringify({ n: 3 })}\n${JSON.stringify({ n: 4 })}\n`;
    await writeFile(path, head + tail);

    // Resume exactly at the head boundary — the cursor's committed offset.
    const suffix = await collect(path, byteLen(head));
    assert.equal(suffix.length, 2, "only the two appended lines are yielded — the prefix is never re-read");
    assert.deepEqual(
      suffix.map((y) => (y.obj as { n: number }).n),
      [3, 4],
      "the suffix lines are exactly the appended records, in order"
    );
    assert.equal(
      suffix.at(-1)?.committedOffset,
      byteLen(head + tail),
      "the resumed commit continues from the start offset, not from zero"
    );
  });
});

test("iterJsonlLinesFromOffset: byte offsets are exact over multi-byte UTF-8 so a resume never splits a line", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "rollout.jsonl");
    // Emoji + CJK: each char is 3–4 UTF-8 bytes. If the iterator counted decoded
    // characters instead of raw bytes, the committed offset would land mid-byte
    // and the next resume would corrupt or skip a line.
    const l1 = JSON.stringify({ text: "héllo 🌍 世界" });
    const l2 = JSON.stringify({ text: "second 🚀 line" });
    const body = `${l1}\n${l2}\n`;
    await writeFile(path, body);

    const all = await collect(path, 0);
    assert.equal(all.length, 2);
    const afterFirst = all[0]?.committedOffset ?? -1;
    assert.equal(afterFirst, byteLen(l1) + 1, "offset counts raw UTF-8 bytes, not characters");

    // Resuming at that byte boundary must yield the second line whole.
    const resumed = await collect(path, afterFirst);
    assert.equal(resumed.length, 1, "resume at a multi-byte boundary yields exactly the remaining line");
    assert.deepEqual(resumed[0]?.obj, { text: "second 🚀 line" }, "the resumed line decodes intact");
  });
});

// ─── Invariant C: partial trailing line is held, not skipped or duplicated ───

test("iterJsonlLinesFromOffset: an unterminated trailing line is not yielded and does not advance the offset", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "rollout.jsonl");
    const complete = `${JSON.stringify({ n: 1 })}\n`;
    const partial = JSON.stringify({ n: 2 }); // no trailing newline — an in-flight append
    await writeFile(path, complete + partial);

    const firstPass = await collect(path, 0);
    assert.equal(firstPass.length, 1, "only the newline-terminated line is yielded; the partial is withheld");
    assert.equal(
      firstPass.at(-1)?.committedOffset,
      byteLen(complete),
      "the committed offset stops at the last terminator — the partial bytes are not counted"
    );

    // The writer finishes the line later; re-reading from the committed offset
    // must now yield the (formerly partial) line intact, with no duplication of
    // the first line.
    await writeFile(path, `${complete + partial}\n`);
    const secondPass = await collect(path, byteLen(complete));
    assert.equal(secondPass.length, 1, "the completed line is picked up exactly once on the next run");
    assert.deepEqual(secondPass[0]?.obj, { n: 2 }, "the formerly-partial line is now whole");
  });
});

test("iterJsonlLinesFromOffset: a malformed (unparseable) line is skipped but its bytes still advance the offset", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "rollout.jsonl");
    const good1 = JSON.stringify({ n: 1 });
    const bad = "{not valid json";
    const good2 = JSON.stringify({ n: 2 });
    const body = `${good1}\n${bad}\n${good2}\n`;
    await writeFile(path, body);

    const yielded = await collect(path, 0);
    assert.equal(yielded.length, 2, "the malformed line is dropped, the two valid lines survive");
    assert.deepEqual(
      yielded.map((y) => (y.obj as { n: number }).n),
      [1, 2],
      "only the parseable objects are yielded"
    );
    // Critically: the final commit still equals the full file size, so the
    // malformed line is consumed (not re-read forever) on the next run.
    assert.equal(
      yielded.at(-1)?.committedOffset,
      byteLen(body),
      "the malformed line's bytes are counted toward the committed offset (skip, do not stall)"
    );
  });
});

// ─── Invariant D: bounded residency on a large active-shaped file ────────────

/** Stream `lineCount` JSONL lines to `path` without ever holding the whole body
 *  in memory in the test itself (mirrors how Codex appends incrementally). Each
 *  line carries a bounded text preview-sized payload — the realistic per-line
 *  shape, never a single multi-GB line. */
async function writeManyLines(path: string, lineCount: number, perLineFiller: number): Promise<number> {
  const filler = "x".repeat(perLineFiller);
  const ws = createWriteStream(path);
  let bytes = 0;
  for (let i = 0; i < lineCount; i++) {
    const line = `${JSON.stringify({ type: "response_item", i, payload: { type: "message", t: filler } })}\n`;
    bytes += byteLen(line);
    if (!ws.write(line)) {
      await once(ws, "drain");
    }
  }
  ws.end();
  await once(ws, "finish");
  return bytes;
}

test("iterJsonlLinesFromOffset: resident Buffer memory stays bounded while streaming a large active-shaped log", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "big-rollout.jsonl");
    // ~32 MB across ~64k lines (~512 B/line). Big enough that buffering even a
    // fraction of the file would dwarf a single 64 KB read chunk; small enough
    // to stay fast and not stress CI disk. The point is fileSize >> peak-buffer.
    const fileBytes = await writeManyLines(path, 64_000, 480);
    assert.ok(fileBytes > 24 * 1024 * 1024, `synthetic file should be sizeable; was ${fileBytes} bytes`);

    // `arrayBuffers` tracks off-heap Buffer/ArrayBuffer bytes — exactly where the
    // generator's `pending` Buffer and the read stream's internal chunk queue
    // live. Unlike RSS (perturbed by V8 heap-arena growth and GC bookkeeping, so
    // it flakes at tens of MB), this isolates the bytes the streaming read holds.
    // Because the consumer loop is synchronous, stream backpressure keeps the
    // internal queue near one highWaterMark (~64 KB) plus at most one pending
    // line. A regression that accumulated chunks into one whole-file Buffer (or
    // read the file into a Buffer wholesale) would push this delta toward
    // fileBytes and trip the absolute ceiling below.
    const baseArrayBuffers = process.memoryUsage().arrayBuffers;
    let peakArrayBuffersDelta = 0;
    let count = 0;
    let lastOffset = 0;
    for await (const { committedOffset } of iterJsonlLinesFromOffset(path, 0)) {
      count++;
      lastOffset = committedOffset;
      // Sample periodically — sampling every line would dominate runtime.
      if (count % 2048 === 0) {
        const delta = process.memoryUsage().arrayBuffers - baseArrayBuffers;
        if (delta > peakArrayBuffersDelta) {
          peakArrayBuffersDelta = delta;
        }
      }
    }

    assert.equal(count, 64_000, "every line is streamed exactly once");
    assert.equal(lastOffset, fileBytes, "the stream commits the whole file (ends on a terminator)");

    // Absolute ceiling independent of file size. Measured streaming peak on this
    // shape is ~3 MB (the read stream's internal chunk queue plus one pending
    // line; higher than a single highWaterMark because `for await` lets the
    // stream buffer a few chunks between microtask turns). A wholesale
    // `readFile` of the same file holds ~30 MB. 12 MB sits decisively in that
    // gap: ~4x the streaming peak (so scheduling jitter never flakes it) and
    // ~2.5x below a whole-file Buffer load (so the regression fails decisively).
    const CEILING_BYTES = 12 * 1024 * 1024;
    assert.ok(
      peakArrayBuffersDelta < CEILING_BYTES,
      `streaming must stay bounded: peak arrayBuffers delta ${peakArrayBuffersDelta} should be < ${CEILING_BYTES} (file ${fileBytes} bytes)`
    );
  });
});

test("iterJsonlLinesFromOffset: a single large line is buffered to one line, not the whole file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "one-big-line.jsonl");
    // One ~4 MB line followed by a small line. The generator must buffer the big
    // line (a line is the irreducible unit) but release it on its terminator and
    // not accumulate it together with the rest of the file.
    const bigText = "y".repeat(4 * 1024 * 1024);
    const bigLine = JSON.stringify({ type: "response_item", payload: { type: "message", t: bigText } });
    const smallLine = JSON.stringify({ n: 2 });
    const body = `${bigLine}\n${smallLine}\n`;
    await writeFile(path, body);

    const yielded = await collect(path, 0);
    assert.equal(yielded.length, 2, "both lines yield");
    assert.equal(yielded[0]?.committedOffset, byteLen(bigLine) + 1, "the big line commits at its own terminator");
    assert.equal(yielded.at(-1)?.committedOffset, byteLen(body), "the small line commits at file end");
    // Resuming after the big line yields only the small line — the big prefix is
    // never re-read, so a session with one huge historical line still tails cheap.
    const resumed = await collect(path, byteLen(bigLine) + 1);
    assert.equal(resumed.length, 1, "resume past the big line yields only the suffix");
    assert.deepEqual(resumed[0]?.obj, { n: 2 });
  });
});
