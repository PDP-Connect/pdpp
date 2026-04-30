import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLocalDeviceRecordEnvelope, canonicalJson, hashCanonicalJson } from "./local-device-envelope.ts";

test("canonicalJson sorts object keys recursively and drops undefined fields", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { b: 2, a: 1 }, skip: undefined, list: [{ y: true, x: false }] }),
    '{"a":{"a":1,"b":2},"list":[{"x":false,"y":true}],"z":1}'
  );
});

test("hashCanonicalJson is stable for equivalent object key ordering", () => {
  assert.equal(hashCanonicalJson({ b: 2, a: 1 }), hashCanonicalJson({ a: 1, b: 2 }));
});

test("buildLocalDeviceRecordEnvelope creates deterministic connector RECORD body hash", () => {
  const first = buildLocalDeviceRecordEnvelope({
    batchId: "batch-1",
    batchSeq: 7,
    connectorId: "codex",
    deviceId: "device-1",
    record: {
      data: { z: "last", a: "first" },
      emitted_at: "2026-04-30T12:00:00.000Z",
      key: 42,
      stream: "messages",
      type: "RECORD",
    },
    sourceInstanceId: "source-1",
  });
  const retry = buildLocalDeviceRecordEnvelope({
    batchId: "batch-1",
    batchSeq: 7,
    connectorId: "codex",
    deviceId: "device-1",
    record: {
      data: { a: "first", z: "last" },
      emitted_at: "2026-04-30T12:00:00.000Z",
      key: 42,
      stream: "messages",
      type: "RECORD",
    },
    sourceInstanceId: "source-1",
  });

  assert.equal(first.body_hash, retry.body_hash);
  assert.equal(first.record_key, "42");
  assert.deepEqual(Object.keys(first.data), ["a", "z"]);
});
