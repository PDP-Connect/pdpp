// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalTerminalRunCommitEnvelope as referenceContractCanonicalTerminalRunCommitEnvelope } from "@pdpp/reference-contract/common";
import {
  buildLocalDeviceIngestBatchRequest,
  buildLocalDeviceRecordEnvelope,
  canonicalJson,
  canonicalTerminalRunCommitEnvelope,
  hashCanonicalJson,
  type TerminalRunCommitEnvelopeInput,
} from "./local-device-envelope.ts";

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
      key: "42",
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
      key: "42",
      stream: "messages",
      type: "RECORD",
    },
    sourceInstanceId: "source-1",
  });

  assert.equal(first.body_hash, retry.body_hash);
  assert.equal(first.record_key, "42");
  assert.deepEqual(Object.keys(first.data), ["a", "z"]);
});

test("buildLocalDeviceRecordEnvelope encodes a compound key as canonical minified JSON array", () => {
  const envelope = buildLocalDeviceRecordEnvelope({
    batchId: "batch-1",
    batchSeq: 7,
    connectorId: "codex",
    deviceId: "device-1",
    record: {
      data: { user_id: "user_123", date: "2026-04-01" },
      emitted_at: "2026-04-30T12:00:00.000Z",
      key: ["user_123", "2026-04-01"],
      stream: "daily_summaries",
      type: "RECORD",
    },
    sourceInstanceId: "source-1",
  });

  assert.equal(envelope.record_key, '["user_123","2026-04-01"]');
});

test("buildLocalDeviceIngestBatchRequest owns full-envelope hashing and wire projection", () => {
  const envelope = buildLocalDeviceRecordEnvelope({
    batchId: "batch-1",
    batchSeq: 7,
    connectorId: "codex",
    deviceId: "device-1",
    record: {
      data: { id: "message-1", text: "hello" },
      emitted_at: "2026-04-30T12:00:00.000Z",
      key: "message-1",
      stream: "messages",
      type: "RECORD",
    },
    sourceInstanceId: "source-1",
  });
  const request = buildLocalDeviceIngestBatchRequest({
    batchId: envelope.batch_id,
    batchSeq: envelope.batch_seq,
    connectorId: envelope.connector_id,
    deviceId: envelope.device_id,
    records: [envelope],
    sourceInstanceId: envelope.source_instance_id,
  });

  assert.equal(request.body_hash, hashCanonicalJson([envelope]));
  assert.notEqual(request.body_hash, hashCanonicalJson(request.records));
  assert.deepEqual(request.records, [
    {
      data: { id: "message-1", text: "hello" },
      emitted_at: "2026-04-30T12:00:00.000Z",
      record_key: "message-1",
      stream: "messages",
    },
  ]);
});

// canonicalTerminalRunCommitEnvelope is vendored (not imported) from
// @pdpp/reference-contract/common. These tests pin both the reference
// contract's golden fixture and byte-identical output across representative
// inputs, so drift is caught before a terminal-run commit reaches production.
test("canonicalTerminalRunCommitEnvelope matches the reference-contract golden hash fixture", () => {
  const input: TerminalRunCommitEnvelopeInput = {
    collection_boundary: "unscoped",
    commit_id: "commit-1",
    connector_id: "codex",
    connector_instance_id: "cin-1",
    device_id: "dev-1",
    run_id: "run-1",
    source_instance_id: "src-1",
    state_delta: { z: { cursor: 2 }, a: { cursor: 1 } },
    terminal_facts: [
      { coverage_statuses: ["missing", "collected", "missing"], stream: "z" },
      { coverage_statuses: ["collected"], scoped: false, stream: "a" },
    ],
    version: 1,
  };
  const canonical = JSON.stringify(canonicalTerminalRunCommitEnvelope(input));

  assert.equal(
    canonical,
    '{"collection_boundary":"unscoped","commit_id":"commit-1","connector_id":"codex","connector_instance_id":"cin-1","device_id":"dev-1","run_id":"run-1","source_instance_id":"src-1","state_delta":{"a":{"cursor":1},"z":{"cursor":2}},"terminal_facts":[{"coverage_statuses":["collected"],"scoped":false,"stream":"a"},{"coverage_statuses":["collected","missing"],"stream":"z"}],"version":1}'
  );
  assert.equal(
    createHash("sha256").update(canonical).digest("hex"),
    "147b0baeb81e66a5dfb3f0862596d50aeb87fe8a6723306740e9446dddb72648"
  );
});

test("canonicalTerminalRunCommitEnvelope is byte-identical to the live reference-contract implementation", () => {
  const inputs: TerminalRunCommitEnvelopeInput[] = [
    {
      collection_boundary: "unscoped",
      commit_id: "commit-1",
      connector_id: "codex",
      connector_instance_id: "cin-1",
      device_id: "dev-1",
      run_id: "run-1",
      source_instance_id: "src-1",
      state_delta: { z: { cursor: 2 }, a: { cursor: 1 } },
      terminal_facts: [
        { coverage_statuses: ["missing", "collected", "missing"], stream: "z" },
        { coverage_statuses: ["collected"], scoped: false, stream: "a" },
      ],
      version: 1,
    },
    {
      collection_boundary: "scoped:2026-01-01T00:00:00.000Z..2026-02-01T00:00:00.000Z",
      commit_id: "commit-2",
      connector_id: "claude_code",
      connector_instance_id: "cin-2",
      device_id: "dev-2",
      run_id: "run-2",
      source_instance_id: "src-2",
      state_delta: {},
      terminal_facts: [],
      version: 1,
    },
    {
      collection_boundary: "unscoped",
      commit_id: "commit-3",
      connector_id: "google_takeout",
      connector_instance_id: "cin-3",
      device_id: "dev-3",
      run_id: "run-3",
      source_instance_id: "src-3",
      state_delta: { nested: { deeply: { cursor: [1, 2, 3], flag: true, missing: undefined } } },
      terminal_facts: [
        { coverage_statuses: ["collected", "collected", "missing", "partial"], scoped: true, stream: 'weird "stream"' },
        { coverage_statuses: [], scoped: false, stream: "empty_coverage" },
      ],
      version: 1,
    },
  ];

  for (const input of inputs) {
    assert.deepEqual(
      canonicalTerminalRunCommitEnvelope(input),
      referenceContractCanonicalTerminalRunCommitEnvelope(input)
    );
    assert.equal(
      JSON.stringify(canonicalTerminalRunCommitEnvelope(input)),
      JSON.stringify(referenceContractCanonicalTerminalRunCommitEnvelope(input))
    );
  }
});
