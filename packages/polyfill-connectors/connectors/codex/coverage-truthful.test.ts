// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

/**
 * Truthful evidence contract for derived streams (messages, function_calls).
 *
 * Status MUST be:
 * - "collected" if records were actually emitted
 * - "verified_empty" only if scan completed AND count=0 AND no errors
 * - "incomplete" if enumeration failed (EACCES, parse_error, etc.)
 *
 * ENOENT (missing rollout dir) = complete scan of empty set = verified_empty
 * EACCES/I/O = incomplete scan = incomplete status
 */

const FIXTURE_ROOT = join(import.meta.dirname, "../../fixtures/codex/source-home");
const DEVICE_A_HOME = join(FIXTURE_ROOT, "deviceA/codex-home");

function records(messages: EmittedMessage[]): Extract<EmittedMessage, { type: "RECORD" }>[] {
  return messages.filter((msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD");
}

function states(messages: EmittedMessage[], stream?: string): Extract<EmittedMessage, { type: "STATE" }>[] {
  return messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "STATE" }> =>
      msg.type === "STATE" && (!stream || msg.stream === stream)
  );
}

test("codex coverage truth: populated rollouts show collected status", async () => {
  // DEVICE_A_HOME has rollout data with messages
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: { CODEX_HOME: DEVICE_A_HOME },
    start: {
      scope: {
        streams: [{ name: "messages" }, { name: "function_calls" }, { name: "coverage_diagnostics" }],
      },
      type: "START",
    },
  });

  assert.equal(result.code, 0);
  const recs = records(result.messages);
  const coverageRecs = recs.filter((r) => r.stream === "coverage_diagnostics");

  const messagesRecord = coverageRecs.find((r) => r.data.store === "derived_messages" && r.data.stream === "messages");
  assert(messagesRecord, "must have coverage record for messages");
  assert.equal(messagesRecord.data.status, "collected", "messages with emitted records must show collected");
});

test("codex coverage truth: empty rollouts (ENOENT) show verified_empty", async () => {
  // Create a fixture with no rollout directory
  const emptyHome = join(import.meta.dirname, "../../fixtures/codex/empty-home-no-rollouts");

  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: { CODEX_HOME: emptyHome },
    start: {
      scope: {
        streams: [{ name: "messages" }, { name: "function_calls" }, { name: "coverage_diagnostics" }],
      },
      type: "START",
    },
  });

  assert.equal(result.code, 0);
  const recs = records(result.messages);
  const coverageRecs = recs.filter((r) => r.stream === "coverage_diagnostics");

  const messagesRecord = coverageRecs.find((r) => r.data.store === "derived_messages" && r.data.stream === "messages");
  const functionCallsRecord = coverageRecs.find(
    (r) => r.data.store === "derived_function_calls" && r.data.stream === "function_calls"
  );

  assert(messagesRecord, "must have coverage record for messages");
  assert(functionCallsRecord, "must have coverage record for function_calls");

  // ENOENT (missing directory) = complete scan of empty set = verified_empty
  assert.equal(
    messagesRecord.data.status,
    "verified_empty",
    "messages with no rollouts (ENOENT) must show verified_empty"
  );
  assert.equal(
    functionCallsRecord.data.status,
    "verified_empty",
    "function_calls with no rollouts (ENOENT) must show verified_empty"
  );
});

test("codex coverage truth: derived coverage records included in STATE snapshot", async () => {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: { CODEX_HOME: DEVICE_A_HOME },
    start: {
      scope: {
        streams: [{ name: "messages" }, { name: "function_calls" }, { name: "coverage_diagnostics" }],
      },
      type: "START",
    },
  });

  const coverageStates = states(result.messages, "coverage_diagnostics");
  assert(coverageStates.length > 0, "must emit coverage_diagnostics STATE");

  const stateSnapshot = (coverageStates[0]?.cursor as { stores?: Record<string, unknown> })?.stores;
  assert(stateSnapshot, "STATE must include stores snapshot");

  // Derived stores must appear in the snapshot (for snapshot_import_receipt proof)
  // The snapshot is indexed by store name as keys
  const storeNames =
    typeof stateSnapshot === "object" && stateSnapshot !== null
      ? Object.values(stateSnapshot)
          .filter((v) => typeof v === "object" && (v as any)?.store)
          .map((v) => (v as any).store)
      : [];
  assert(storeNames.includes("derived_messages"), "STATE snapshot must include derived_messages store");
  assert(storeNames.includes("derived_function_calls"), "STATE snapshot must include derived_function_calls store");
});

test("codex coverage truth: parse error makes coverage incomplete", async () => {
  // Create a fixture with a malformed rollout file to trigger parse_error
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const parseErrorHome = join(import.meta.dirname, "../../fixtures/codex/parse-error-home");
  const sessionDir = join(parseErrorHome, "sessions", "2026", "08", "09");

  // Create directories and a malformed rollout file
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "rollout-bad.jsonl"), '{"type":"session_meta","bad json\n');

  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: { CODEX_HOME: parseErrorHome },
    start: {
      scope: {
        streams: [{ name: "messages" }, { name: "function_calls" }, { name: "coverage_diagnostics" }],
      },
      type: "START",
    },
  });

  const recs = records(result.messages);
  const coverageRecs = recs.filter((r) => r.stream === "coverage_diagnostics");

  const messagesRecord = coverageRecs.find((r) => r.data.store === "derived_messages");
  const functionCallsRecord = coverageRecs.find((r) => r.data.store === "derived_function_calls");

  assert(messagesRecord, "must have coverage record for messages");
  assert(functionCallsRecord, "must have coverage record for function_calls");

  // Parse error = incomplete status
  assert.equal(messagesRecord.data.status, "incomplete", "parse error must show incomplete");
  assert.equal(functionCallsRecord.data.status, "incomplete", "parse error must show incomplete");
});

test("codex coverage truth: suppressed-but-populated shows verified_empty (fingerprinted)", async () => {
  // A complete scan where messages were examined but none emitted due to fingerprint suppression
  // should show verified_empty (data exists in scope, but all suppressed by fingerprint gate).
  // This is tested implicitly by running against DEVICE_A_HOME twice with state:
  // first pass collects all, second pass fingerprints suppress re-emission.
  const result1 = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: { CODEX_HOME: DEVICE_A_HOME },
    start: {
      scope: {
        streams: [{ name: "messages" }, { name: "function_calls" }, { name: "coverage_diagnostics" }],
      },
      type: "START",
    },
  });

  assert.equal(result1.code, 0);
  const recs1 = records(result1.messages);
  const coverageRecs1 = recs1.filter((r) => r.stream === "coverage_diagnostics");
  const messagesRecord1 = coverageRecs1.find((r) => r.data.store === "derived_messages");

  // First run: collected (records were emitted)
  assert.equal(messagesRecord1?.data.status, "collected", "first run should collect records");

  // Extract STATE cursor for second run (to simulate fingerprint suppression)
  const states1 = result1.messages.filter(
    (m): m is Extract<any, { type: "STATE" }> => m.type === "STATE" && m.stream === "messages"
  );
  const priorState = states1[states1.length - 1]?.cursor;

  // Second run with prior state: should show verified_empty (examined > 0, emitted = 0 due to fingerprint)
  const result2 = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: { CODEX_HOME: DEVICE_A_HOME },
    start: {
      scope: {
        streams: [{ name: "messages" }, { name: "function_calls" }, { name: "coverage_diagnostics" }],
      },
      type: "START",
      state: { messages: priorState },
    },
  });

  const recs2 = records(result2.messages);
  const coverageRecs2 = recs2.filter((r) => r.stream === "coverage_diagnostics");
  const messagesRecord2 = coverageRecs2.find((r) => r.data.store === "derived_messages");

  // Second run: verified_empty (complete scan, examined > 0, emitted = 0)
  assert.equal(
    messagesRecord2?.data.status,
    "verified_empty",
    "suppressed-but-populated should show verified_empty, not collected"
  );
});
