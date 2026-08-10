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

test("codex coverage truth: status differentiates complete vs incomplete scans", async () => {
  // Test that we can distinguish:
  // 1. Collected (rollouts parsed, records emitted)
  // 2. Verified-empty (rollouts scanned, zero records emitted, no errors)
  // 3. Incomplete (would require a read error, which is harder to simulate)

  // Already tested via populated-rollouts (collected) and empty-home (verified_empty)
  // This test just affirms the derived records exist and have correct statuses
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

  const recs = records(result.messages);
  const coverageRecs = recs.filter((r) => r.stream === "coverage_diagnostics");

  const messagesRecord = coverageRecs.find((r) => r.data.store === "derived_messages");
  const functionCallsRecord = coverageRecs.find((r) => r.data.store === "derived_function_calls");

  assert(messagesRecord, "must have derived_messages coverage record");
  assert(functionCallsRecord, "must have derived_function_calls coverage record");

  // With the populated fixture, we should see collected status
  assert.equal(messagesRecord.data.status, "collected", "populated rollouts must show collected");
  assert.equal(functionCallsRecord.data.status, "collected", "populated rollouts must show collected");
});

test("codex coverage truth: unreadable sessions dir shows incomplete status", async () => {
  // Create a home with an unreadable sessions directory (EACCES)
  const { execSync } = await import("node:child_process");
  const unreadableHome = join(import.meta.dirname, "../../fixtures/codex/unreadable-home");
  const sessionDir = join(unreadableHome, "sessions");

  // Setup: create the dir, make it unreadable
  execSync(`mkdir -p "${sessionDir}"`);
  execSync(`chmod 000 "${sessionDir}"`);

  try {
    const result = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: join(import.meta.dirname, "../.."),
      entrypoint: "connectors/codex/index.ts",
      env: { CODEX_HOME: unreadableHome },
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

    // EACCES (permission denied) = incomplete scan, not verified_empty
    assert.equal(
      messagesRecord.data.status,
      "incomplete",
      "messages with unreadable sessions (EACCES) must show incomplete"
    );
    assert.equal(
      functionCallsRecord.data.status,
      "incomplete",
      "function_calls with unreadable sessions (EACCES) must show incomplete"
    );
  } finally {
    // Cleanup: restore permissions
    try {
      execSync(`chmod 755 "${sessionDir}"`);
    } catch {
      // Ignore cleanup errors
    }
  }
});
