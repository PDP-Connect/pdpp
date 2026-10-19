// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import { accountingEventLine, StructuredNodeSummaryAccumulator, structuredNodeSummary } from "./receipt.ts";

const EVENT_LIMIT_PATTERN = /reporter event exceeds the 1 MiB parser limit/;

const corpus =
  [
    "ordinary reporter text",
    accountingEventLine({ type: "test:pass", details: { type: "test", name: "first 🧪 café" } }),
    accountingEventLine({ type: "test:pass", details: { type: "suite:start" } }),
    accountingEventLine({ type: "test:fail", details: { type: "test", name: "second" } }),
  ].join("\r\n") +
  "\r\n" +
  accountingEventLine({ type: "test:pass", details: { type: "test", name: "last without newline 雪" } });

function chunkWithSeed(bytes: Buffer, seed: number): string[] {
  const decoder = new StringDecoder("utf8");
  const chunks: string[] = [];
  let cursor = 0;
  let state = seed;
  while (cursor < bytes.length) {
    state = (state * 48_271) % 0x7f_ff_ff_ff;
    const size = 1 + (state % 19);
    chunks.push(decoder.write(bytes.subarray(cursor, cursor + size)));
    cursor += size;
  }
  const final = decoder.end();
  if (final) {
    chunks.push(final);
  }
  return chunks;
}

test("incremental node summary matches structuredNodeSummary across split lines and UTF-8 chunkings", () => {
  const expected = structuredNodeSummary(corpus);
  for (let seed = 1; seed <= 100; seed += 1) {
    const accumulator = new StructuredNodeSummaryAccumulator();
    for (const chunk of chunkWithSeed(Buffer.from(corpus), seed)) {
      accumulator.write(chunk);
    }
    assert.deepEqual(accumulator.finish(), expected, `chunk seed ${seed}`);
  }
});

test("the incremental parser accepts an event exactly at 1 MiB and rejects a completed oversized event", () => {
  const encoded = accountingEventLine({ type: "test:pass", details: { type: "suite:start" } });
  const atLimit = encoded + " ".repeat(1024 * 1024 - encoded.length);
  const accepted = new StructuredNodeSummaryAccumulator();
  accepted.write(`${atLimit}\n`);
  assert.equal(accepted.finish().assertions, 0);

  const oversized = new StructuredNodeSummaryAccumulator();
  assert.throws(() => oversized.write(`${atLimit} \n`), EVENT_LIMIT_PATTERN);
});
