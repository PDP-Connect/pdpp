// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BoundedReadableResponse,
  describeBoundedReadRejection,
  readBoundedText,
} from "./bounded-response-read.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

function responseWith(headers: Record<string, string>, chunks: string[]): BoundedReadableResponse {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: streamOf(chunks),
  };
}

test("readBoundedText: normal payload under the cap reads through unchanged", async () => {
  const res = responseWith({ "content-length": "5" }, ["hello"]);
  const outcome = await readBoundedText(res, 1024);
  assert.deepEqual(outcome, { kind: "ok", text: "hello" });
});

test("readBoundedText: normal payload with no Content-Length header still reads through under the cap", async () => {
  const res = responseWith({}, ["hello", " world"]);
  const outcome = await readBoundedText(res, 1024);
  assert.deepEqual(outcome, { kind: "ok", text: "hello world" });
});

test("readBoundedText: declared Content-Length exceeding the cap is rejected BEFORE the body is read", async () => {
  // `stream.locked` flips to true only once `getReader()` is called on it.
  // Checking it after the call proves the fast Content-Length rejection
  // returned before the code ever touched the body stream — a real
  // ReadableStream, no cast needed.
  const body = streamOf(["x"]);
  const res: BoundedReadableResponse = {
    headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? "999999999" : null) },
    body,
  };
  const outcome = await readBoundedText(res, 10);
  assert.equal(outcome.kind, "content_length_exceeded");
  assert.equal(body.locked, false, "getReader() must not be called once Content-Length alone exceeds the cap");
  if (outcome.kind === "content_length_exceeded") {
    assert.equal(outcome.declaredBytes, 999_999_999);
    assert.equal(outcome.maxBytes, 10);
  }
});

test("readBoundedText: missing Content-Length with an oversized stream is caught by the streaming cap", async () => {
  // No Content-Length header at all — the only guard that can catch this
  // is the streaming byte-count cap enforced while consuming the body.
  const res = responseWith({}, ["a".repeat(20)]);
  const outcome = await readBoundedText(res, 10);
  assert.equal(outcome.kind, "content_length_missing_stream_exceeded");
  if (outcome.kind === "content_length_missing_stream_exceeded") {
    assert.equal(outcome.maxBytes, 10);
  }
});

test("readBoundedText: a lying (understated) Content-Length with an oversized stream is caught by the streaming cap", async () => {
  // Content-Length claims 5 bytes (under the cap, so the upfront check
  // passes) but the actual stream delivers far more — the streaming guard
  // is authoritative regardless of what the header declared.
  const res = responseWith({ "content-length": "5" }, ["a".repeat(50)]);
  const outcome = await readBoundedText(res, 10);
  assert.equal(outcome.kind, "content_length_understated_stream_exceeded");
  if (outcome.kind === "content_length_understated_stream_exceeded") {
    assert.equal(outcome.declaredBytes, 5);
    assert.equal(outcome.maxBytes, 10);
  }
});

test("readBoundedText: a malformed Content-Length header is treated as absent, not trusted", async () => {
  const res = responseWith({ "content-length": "not-a-number" }, ["hello"]);
  const outcome = await readBoundedText(res, 1024);
  assert.deepEqual(outcome, { kind: "ok", text: "hello" });
});

test("readBoundedText: a negative Content-Length header is treated as absent, not trusted", async () => {
  const res = responseWith({ "content-length": "-5" }, ["hello"]);
  const outcome = await readBoundedText(res, 1024);
  assert.deepEqual(outcome, { kind: "ok", text: "hello" });
});

test("readBoundedText: exactly at the cap is accepted (boundary is inclusive)", async () => {
  const res = responseWith({}, ["a".repeat(10)]);
  const outcome = await readBoundedText(res, 10);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind === "ok") {
    assert.equal(outcome.text.length, 10);
  }
});

test("readBoundedText: one byte over the cap is rejected", async () => {
  const res = responseWith({}, ["a".repeat(11)]);
  const outcome = await readBoundedText(res, 10);
  assert.notEqual(outcome.kind, "ok");
});

test("readBoundedText: null body reads as empty text", async () => {
  const res: BoundedReadableResponse = { headers: { get: () => null }, body: null };
  const outcome = await readBoundedText(res, 1024);
  assert.deepEqual(outcome, { kind: "ok", text: "" });
});

test("readBoundedText: rejects across multiple chunks, not just a single oversized chunk", async () => {
  const res = responseWith({}, ["a".repeat(6), "b".repeat(6)]);
  const outcome = await readBoundedText(res, 10);
  assert.notEqual(outcome.kind, "ok");
});

test("describeBoundedReadRejection: produces a size-only message with no body content", () => {
  const msg = describeBoundedReadRejection({ kind: "content_length_exceeded", declaredBytes: 999, maxBytes: 100 });
  assert.match(msg, /999/);
  assert.match(msg, /100/);
});
