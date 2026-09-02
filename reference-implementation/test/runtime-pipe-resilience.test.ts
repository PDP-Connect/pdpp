// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { createJsonlLineDispatcher, runConnector } from "../runtime/index.ts";
import { isClosedPipeWriteError } from "../runtime/pipe-errors.ts";
import { type DeriveTerminalReasonInput, deriveTerminalReason } from "../runtime/terminal-reason.ts";

/**
 * `deriveTerminalReason`'s `doneMessage` type only declares the `status`
 * field it reads; these fixtures carry `records_emitted` too, to document
 * the realistic shape of a DONE message. A typed local widens the literal
 * so the extra field isn't silently dropped by an excess-property check.
 */
function doneMessage(
  status: string,
  recordsEmitted: number
): NonNullable<DeriveTerminalReasonInput["doneMessage"]> & { records_emitted: number } {
  return { records_emitted: recordsEmitted, status };
}

interface StructuredRunOutcome {
  failure_message?: unknown;
  records_emitted?: unknown;
  status: unknown;
  stdin_closed_at_phase?: unknown;
  terminal_reason?: unknown;
}

function asStructuredOutcome(value: unknown): StructuredRunOutcome {
  assert.ok(value && typeof value === "object", "structured outcome");
  assert.ok("status" in value, "expected a status field");
  return value as StructuredRunOutcome;
}

/**
 * Minimal admission fixture for `runConnector`'s required `admitRunConnection`
 * callback: echoes back whatever connectorId/connectorInstanceId/ownerSubjectId
 * it is asked to admit. These pipe-resilience tests assert only on the
 * spawn/terminal-reason outcome shape, never on connection identity, so a
 * pass-through admission is sufficient.
 */
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

test("createJsonlLineDispatcher replays complete lines emitted before the runtime installs its listener", () => {
  const dispatcher = createJsonlLineDispatcher();
  const received: string[] = [];

  dispatcher.dispatch('{"type":"RECORD"}\r');
  dispatcher.dispatch('{"type":"DONE"}');
  dispatcher.onLine((line) => received.push(line));
  dispatcher.dispatch('{"type":"STATE"}');

  assert.deepEqual(received, ['{"type":"RECORD"}', '{"type":"DONE"}', '{"type":"STATE"}']);
});

// Regression coverage for
//   openspec/changes/harden-reference-runtime-reliability/
//
// Three layers, in order of how directly they prove the contract:
//   1. Classifier unit tests   — what counts as a downgradable
//      closed-pipe write error.
//   2. deriveTerminalReason    — the production helper that maps
//      {doneMessage, finalStatus, childStdinClosedReason,
//      childStdinClosedAtPhase} to the run's terminal_reason. This is
//      the run-terminal contract; if it changes, run outcomes change.
//   3. Spawn smoke             — host-survives proof for the captured
//      EPIPE crash. Asserts no uncaughtException reaches the global
//      handler and the resolved outcome carries one of the typed
//      terminal_reason values the spec promises.

// ─── 1. Classifier ───────────────────────────────────────────────────────────

test("isClosedPipeWriteError classifies EPIPE write as downgradable", () => {
  const err = Object.assign(new Error("write EPIPE"), {
    code: "EPIPE",
    errno: -32,
    syscall: "write",
  });
  assert.equal(isClosedPipeWriteError(err), true);
});

test("isClosedPipeWriteError classifies ERR_STREAM_DESTROYED as downgradable", () => {
  const err = Object.assign(new Error("Cannot call write after a stream was destroyed"), {
    code: "ERR_STREAM_DESTROYED",
  });
  assert.equal(isClosedPipeWriteError(err), true);
});

test("isClosedPipeWriteError classifies ERR_STREAM_WRITE_AFTER_END as downgradable", () => {
  const err = Object.assign(new Error("write after end"), {
    code: "ERR_STREAM_WRITE_AFTER_END",
  });
  assert.equal(isClosedPipeWriteError(err), true);
});

test("isClosedPipeWriteError rejects unrelated TypeError", () => {
  assert.equal(isClosedPipeWriteError(new TypeError("not pipe")), false);
});

test("isClosedPipeWriteError rejects EPIPE on non-write syscall", () => {
  // A read-side EPIPE (rare, but Node can synthesize one) is not a
  // downgradable write-side condition.
  const err = Object.assign(new Error("read EPIPE"), {
    code: "EPIPE",
    syscall: "read",
  });
  assert.equal(isClosedPipeWriteError(err), false);
});

test("isClosedPipeWriteError rejects EPIPE-looking strings without code", () => {
  assert.equal(isClosedPipeWriteError(new Error("write EPIPE")), false);
});

test("isClosedPipeWriteError tolerates non-error inputs", () => {
  assert.equal(isClosedPipeWriteError(null), false);
  assert.equal(isClosedPipeWriteError(undefined), false);
  assert.equal(isClosedPipeWriteError("EPIPE"), false);
  assert.equal(isClosedPipeWriteError(42), false);
});

// ─── 2. deriveTerminalReason (run-terminal contract) ─────────────────────────

test("deriveTerminalReason: DONE succeeded → null reason", () => {
  assert.deepEqual(
    deriveTerminalReason({
      childStdinClosedAtPhase: null,
      childStdinClosedReason: null,
      doneMessage: doneMessage("succeeded", 5),
      finalStatus: "succeeded",
    }),
    { phase: null, reason: null }
  );
});

test("deriveTerminalReason: DONE failed → connector_reported_failed", () => {
  assert.deepEqual(
    deriveTerminalReason({
      childStdinClosedAtPhase: null,
      childStdinClosedReason: null,
      doneMessage: doneMessage("failed", 0),
      finalStatus: "failed",
    }),
    { phase: null, reason: "connector_reported_failed" }
  );
});

test("deriveTerminalReason: DONE cancelled → connector_reported_cancelled", () => {
  assert.deepEqual(
    deriveTerminalReason({
      childStdinClosedAtPhase: null,
      childStdinClosedReason: null,
      doneMessage: doneMessage("cancelled", 0),
      finalStatus: "failed",
    }),
    { phase: null, reason: "connector_reported_cancelled" }
  );
});

test("deriveTerminalReason: failed without DONE, no stdin-close → connector_exit_without_done", () => {
  assert.deepEqual(
    deriveTerminalReason({
      childStdinClosedAtPhase: null,
      childStdinClosedReason: null,
      doneMessage: null,
      finalStatus: "failed",
    }),
    { phase: null, reason: "connector_exit_without_done" }
  );
});

test("deriveTerminalReason: failed without DONE + stdin closed at start → connector_stdin_closed/start", () => {
  assert.deepEqual(
    deriveTerminalReason({
      childStdinClosedAtPhase: "start",
      childStdinClosedReason: "connector_stdin_closed",
      doneMessage: null,
      finalStatus: "failed",
    }),
    { phase: "start", reason: "connector_stdin_closed" }
  );
});

test("deriveTerminalReason: failed without DONE + stdin closed at interaction_response → connector_stdin_closed/interaction_response", () => {
  assert.deepEqual(
    deriveTerminalReason({
      childStdinClosedAtPhase: "interaction_response",
      childStdinClosedReason: "connector_stdin_closed",
      doneMessage: null,
      finalStatus: "failed",
    }),
    { phase: "interaction_response", reason: "connector_stdin_closed" }
  );
});

test("deriveTerminalReason: stdin-closed reason WITHOUT phase still resolves, with phase=unknown", () => {
  // Defensive: if the phase was somehow not recorded, the reason is
  // still load-bearing. We surface 'unknown' rather than dropping it.
  assert.deepEqual(
    deriveTerminalReason({
      childStdinClosedAtPhase: null,
      childStdinClosedReason: "connector_stdin_closed",
      doneMessage: null,
      finalStatus: "failed",
    }),
    { phase: "unknown", reason: "connector_stdin_closed" }
  );
});

test("deriveTerminalReason: DONE wins over a recorded stdin-close", () => {
  // If DONE arrived (the connector formally completed) AND a later
  // stdin write failed — for example, a runtime cleanup write — the
  // protocol-level DONE is the load-bearing terminal record. The
  // stdin-close is an artefact of teardown, not the run outcome.
  assert.deepEqual(
    deriveTerminalReason({
      childStdinClosedAtPhase: "interaction_response",
      childStdinClosedReason: "connector_stdin_closed",
      doneMessage: doneMessage("failed", 0),
      finalStatus: "failed",
    }),
    { phase: null, reason: "connector_reported_failed" }
  );
});

test("deriveTerminalReason: succeeded run with no DONE and no stdin-close → null", () => {
  // Defensive shape: a non-failed run with no DONE shouldn't carry a
  // failure reason. The runtime never reaches this state in
  // production, but the helper SHALL be total.
  assert.deepEqual(
    deriveTerminalReason({
      childStdinClosedAtPhase: null,
      childStdinClosedReason: null,
      doneMessage: null,
      finalStatus: "succeeded",
    }),
    { phase: null, reason: null }
  );
});

// ─── 3. Spawn smoke (host-survives proof) ────────────────────────────────────

test("runConnector: connector that exits before reading START does not crash the host", async () => {
  // Without per-stream error listeners on proc.stdin/stdout/stderr, an
  // EPIPE on the runtime's first stdin write would surface as an
  // unhandled 'error' event on the parent's stream and become an
  // uncaughtException — the captured Docker crash class.
  //
  // Note on race: depending on kernel pipe-buffer timing the parent's
  // synchronous START write may either fail with EPIPE (→
  // 'connector_stdin_closed') or be absorbed before the child closes (→
  // 'connector_exit_without_done'). Both are typed terminal values
  // declared in the spec; the load-bearing contract is that the host
  // survives and the outcome carries a typed reason. The
  // deriveTerminalReason unit tests above cover the precise mapping
  // regardless of which branch the kernel races into.
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-pipe-test-"));
  const stubPath = join(tmpDir, "stub-exits.js");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env node",
      "setImmediate(() => { try { process.stdin.destroy(); } catch {} process.exit(7); });",
      "",
    ].join("\n"),
    "utf8"
  );
  chmodSync(stubPath, 0o755);

  const manifest = {
    connector_id: "https://registry.pdpp.dev/connectors/test-pipe-resilience-stub",
    runtime_requirements: {},
    streams: [
      {
        name: "noop",
        primary_key: "id",
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
    ],
    version: "0.1.0",
  };

  const uncaughtErrors: unknown[] = [];
  const onUncaught = (err: unknown) => uncaughtErrors.push(err);
  process.on("uncaughtException", onUncaught);

  let outcome: RuntimeRunConnectorResult | null = null;
  let outcomeError: unknown = null;
  try {
    outcome = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: manifest.connector_id,
      connectorPath: stubPath,
      // No server harness; supply an empty detail-gap store so the
      // runtime exercises only the pipe-resilience path under test.
      detailGapStore: {
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async listPendingGaps() {
          return [];
        },
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async markGapStatus() {
          return null;
        },
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async upsertPendingGap() {
          return null;
        },
      },
      manifest,
      onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      onProgress: () => {},
      ownerToken: "test-owner-token",
      rsUrl: "http://127.0.0.1:1",
      state: null,
    });
  } catch (err) {
    outcomeError = err;
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    rmSync(tmpDir, { force: true, recursive: true });
  }

  const epipeEscapes = uncaughtErrors.filter((err) => isClosedPipeWriteError(err));
  assert.equal(epipeEscapes.length, 0, `expected no closed-pipe uncaughtException, got ${epipeEscapes.length}`);

  const surfaced = asStructuredOutcome(outcome ?? outcomeError);
  assert.equal(surfaced.status, "failed", "failed run when child exits before DONE");
  assert.ok(
    typeof surfaced.terminal_reason === "string" &&
      ["connector_stdin_closed", "connector_exit_without_done"].includes(surfaced.terminal_reason),
    `expected terminal_reason in {connector_stdin_closed, connector_exit_without_done}, got ${JSON.stringify(surfaced.terminal_reason)}`
  );
  if (surfaced.terminal_reason === "connector_stdin_closed") {
    assert.ok(
      typeof surfaced.stdin_closed_at_phase === "string" &&
        ["start", "interaction_response"].includes(surfaced.stdin_closed_at_phase),
      `expected stdin_closed_at_phase in {start, interaction_response}, got ${JSON.stringify(surfaced.stdin_closed_at_phase)}`
    );
  }
});

// ─── 4. Flush/read handshake regression ──────────────────────────────────────
//
// Regression guard for the flush/read race:
//   - Connector exits when its stdout write buffer drains to the OS pipe.
//   - At that point bytes may still be in the kernel buffer and the runtime
//     may not have finished slow HTTP ingest of all RECORD messages.
//   - Without the handshake, the runtime can call validateDoneRecordsEmitted
//     before all records are flushed → connector_protocol_violation.
//
// The fix: runtime closes child stdin after DONE is consumed+flushed;
// connector waits for that stdin EOF before process.exit().
//
// This test spawns a stub that emits many large records (total > OS pipe
// buffer), uses a slow mock ingest server, and asserts no mismatch.

test("runConnector: many large records with slow ingest do not trigger connector_protocol_violation", {
  timeout: 30_000,
}, async (_t: TestContext) => {
  const RECORD_COUNT = 20;
  const RECORD_PAYLOAD_KB = 60;
  const INGEST_DELAY_MS = 40;

  // ── Mock RS ingest server ───────────────────────────────────────────────
  let _ingestCallCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      // biome-ignore lint/style/noIncrementDecrement: counter mutation is explicit in this ordered test
      _ingestCallCount++;
      const records_accepted = body.split("\n").filter(Boolean).length;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            records_accepted,
            records_attempted: records_accepted,
            records_rejected: 0,
            rejections: [],
          })
        );
      }, INGEST_DELAY_MS);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "expected an AddressInfo from an ephemeral listen(0)");
  const rsUrl = `http://127.0.0.1:${address.port}`;

  // ── Stub connector ──────────────────────────────────────────────────────
  // Implements the generalized flushAndExit: drain stdout, then wait for
  // stdin EOF (runtime's consumption-complete signal) before process.exit().
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-flush-test-"));
  const stubPath = join(tmpDir, "stub-flush.mjs");
  const payload = "x".repeat(RECORD_PAYLOAD_KB * 1024);

  writeFileSync(
    stubPath,
    `
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';

const RECORD_COUNT = ${RECORD_COUNT};
const payload = ${JSON.stringify(payload)};

function emit(msg) {
  const line = JSON.stringify(msg) + '\\n';
  const ok = process.stdout.write(line);
  if (ok) return Promise.resolve();
  return new Promise(resolve => process.stdout.once('drain', resolve));
}

function flushAndExit(code) {
  const doExit = () => {
    if (process.stdin.readableEnded) { process.exit(code); return; }
    process.stdin.once('end', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  };
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', doExit);
    setTimeout(() => process.exit(code), 3000).unref();
  } else {
    doExit();
  }
}

async function main() {
  // Read START
  await new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.once('line', () => { rl.close(); resolve(); });
  });

  for (let i = 0; i < RECORD_COUNT; i++) {
    await emit({ type: 'RECORD', stream: 'items', key: String(i), data: { id: String(i), body: payload }, emitted_at: new Date().toISOString() });
  }
  await emit({ type: 'DONE', status: 'succeeded', records_emitted: RECORD_COUNT });
  flushAndExit(0);
}

main().catch(err => {
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: err.message, retryable: false } }).catch(() => {});
  flushAndExit(1);
});
`,
    "utf8"
  );
  chmodSync(stubPath, 0o755);

  // ── Manifest ────────────────────────────────────────────────────────────
  const manifest = {
    connector_id: "https://registry.pdpp.dev/connectors/test-flush-handshake-stub",
    runtime_requirements: {},
    streams: [
      {
        name: "items",
        primary_key: "id",
        schema: {
          properties: { body: { type: "string" }, id: { type: "string" } },
          required: ["id"],
          type: "object",
        },
      },
    ],
    version: "0.1.0",
  };

  let outcome: RuntimeRunConnectorResult | null = null;
  let outcomeError: unknown = null;
  try {
    outcome = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: manifest.connector_id,
      connectorPath: stubPath,
      detailGapStore: {
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async listPendingGaps() {
          return [];
        },
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async markGapStatus() {
          return null;
        },
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async upsertPendingGap() {
          return null;
        },
      },
      manifest,
      onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      onProgress: () => {},
      ownerToken: "test-owner-token",
      rsUrl,
      state: null,
    });
  } catch (err) {
    outcomeError = err;
  } finally {
    server.close();
    rmSync(tmpDir, { force: true, recursive: true });
  }

  const result = asStructuredOutcome(outcome ?? outcomeError);
  assert.equal(
    result.status,
    "succeeded",
    `expected succeeded, got ${result.status}${result.terminal_reason ? ` (${result.terminal_reason})` : ""}${result.failure_message ? `: ${result.failure_message}` : ""}`
  );
  assert.equal(result.records_emitted, RECORD_COUNT, "all records counted");
});

// ─── 5. START/listener ordering regression ─────────────────────────────────

test("runConnector: preserves a connector's first RECORD when it writes immediately after START", async () => {
  // The live GitHub failure had this exact shape: the child received START,
  // emitted its first stream, and reported a count that included it before
  // the runtime installed its JSONL listener. The child is deliberately
  // faster than the runtime here — no timer, no I/O between START and RECORD.
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const recordsAccepted = body.split("\n").filter(Boolean).length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          records_accepted: recordsAccepted,
          records_attempted: recordsAccepted,
          records_rejected: 0,
          rejections: [],
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "expected an AddressInfo from an ephemeral listen(0)");

  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-start-listener-order-"));
  const connectorPath = join(tmpDir, "immediate-first-record.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from "node:readline";

const reader = createInterface({ input: process.stdin, terminal: false });
reader.once("line", () => {
  const emittedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify({ type: "RECORD", stream: "items", key: "first", data: { id: "first" }, emitted_at: emittedAt }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "STATE", stream: "items", cursor: { seen: "first" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 1 }) + "\\n");
  process.stdin.once("end", () => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
`,
    "utf8"
  );
  chmodSync(connectorPath, 0o755);

  const manifest = {
    connector_id: "https://registry.pdpp.dev/connectors/test-start-listener-order",
    runtime_requirements: {},
    streams: [
      {
        name: "items",
        primary_key: "id",
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
    ],
    version: "0.1.0",
  };

  let outcome: RuntimeRunConnectorResult | null = null;
  let outcomeError: unknown = null;
  try {
    outcome = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: manifest.connector_id,
      connectorPath,
      detailGapStore: {
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async listPendingGaps() {
          return [];
        },
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async markGapStatus() {
          return null;
        },
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        async upsertPendingGap() {
          return null;
        },
      },
      manifest,
      onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
      // biome-ignore lint/suspicious/noEmptyBlockStatements: this regression asserts only the returned protocol outcome
      onProgress: () => {},
      ownerToken: "test-owner-token",
      rsUrl: `http://127.0.0.1:${address.port}`,
      state: null,
    });
  } catch (err) {
    outcomeError = err;
  } finally {
    server.close();
    rmSync(tmpDir, { force: true, recursive: true });
  }

  const result = asStructuredOutcome(outcome ?? outcomeError);
  assert.equal(result.status, "succeeded");
  assert.equal(result.records_emitted, 1, "the runtime must observe the first RECORD before validating DONE");
});
