// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `makeRecordingEmit` — the shared test harness every
 * connector integration test uses to fake emit/emitRecord.
 *
 * Three modes matter:
 *   1. Pass-through (no validator) — records land in `.emitted` verbatim.
 *   2. Validating — passing records land in `.emitted`; failing records
 *      land in `.skipped` (same semantics as the runtime's RECORD path).
 *   3. Protocol side-channel — `.emit()` captures every non-RECORD
 *      EmittedMessage (PROGRESS, STATE, SKIP_RESULT, INTERACTION) so
 *      tests can assert on the full protocol, not just records.
 *
 * If this file regresses, every integration test downstream is fibbing.
 */

import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage, ValidateRecord } from "./connector-runtime.ts";
import { makeRecordingEmit, runConnectorProtocolSubprocess } from "./test-harness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const fixturePath = (name: string): string => join(PACKAGE_ROOT, "src", "test-fixtures", name);

// ─── Pass-through mode ───────────────────────────────────────────────────

test("makeRecordingEmit: pass-through mode — records land in .emitted verbatim", async () => {
  const h = makeRecordingEmit();
  await h.emitRecord("orders", { id: "ord-1", total: 42 });
  await h.emitRecord("orders", { id: "ord-2", total: 99 });

  assert.equal(h.emitted.length, 2);
  assert.deepEqual(h.emitted[0], { stream: "orders", data: { id: "ord-1", total: 42 } });
  assert.deepEqual(h.emitted[1], { stream: "orders", data: { id: "ord-2", total: 99 } });
  assert.equal(h.skipped.length, 0, "pass-through mode never skips");
});

// ─── Validating mode ─────────────────────────────────────────────────────

/** A tiny validator: the `orders` stream requires a positive-integer `id`. */
const validateHasId: ValidateRecord = (_stream, data) => {
  if (typeof data.id === "string" && data.id.length > 0) {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "id must be a non-empty string" }] };
};

test("makeRecordingEmit: validating mode — passing records land in .emitted", async () => {
  const h = makeRecordingEmit(validateHasId);
  await h.emitRecord("orders", { id: "ord-1" });
  await h.emitRecord("orders", { id: "ord-2" });

  assert.equal(h.emitted.length, 2);
  assert.equal(h.skipped.length, 0);
  assert.deepEqual(
    h.emitted.map((e) => e.data.id),
    ["ord-1", "ord-2"]
  );
});

test("makeRecordingEmit: validating mode — failing records land in .skipped with issues", async () => {
  const h = makeRecordingEmit(validateHasId);
  await h.emitRecord("orders", { id: "" });
  await h.emitRecord("orders", { id: 42 });

  assert.equal(h.emitted.length, 0, "neither record passes shape-check");
  assert.equal(h.skipped.length, 2);
  assert.equal(h.skipped[0]?.stream, "orders");
  assert.deepEqual(h.skipped[0]?.issues, [{ path: "id", message: "id must be a non-empty string" }]);
});

test("makeRecordingEmit: validating mode — mixed pass + fail are partitioned correctly", async () => {
  const h = makeRecordingEmit(validateHasId);
  await h.emitRecord("orders", { id: "ord-1" });
  await h.emitRecord("orders", { id: "" });
  await h.emitRecord("orders", { id: "ord-3" });

  assert.equal(h.emitted.length, 2, "two good records");
  assert.equal(h.skipped.length, 1, "one bad record");
  assert.deepEqual(
    h.emitted.map((e) => e.data.id),
    ["ord-1", "ord-3"]
  );
});

// ─── Protocol side-channel ───────────────────────────────────────────────

test("makeRecordingEmit: emit() side-channel captures PROGRESS / STATE / SKIP_RESULT / INTERACTION", async () => {
  const h = makeRecordingEmit();
  const progress: EmittedMessage = { type: "PROGRESS", message: "working" };
  const state: EmittedMessage = { type: "STATE", stream: "orders", cursor: { last: "ord-1" } };
  const skip: EmittedMessage = {
    type: "SKIP_RESULT",
    stream: "orders",
    reason: "http_error",
    message: "404",
  };
  const interaction: EmittedMessage = {
    type: "INTERACTION",
    request_id: "int_1",
    kind: "otp",
    message: "enter code",
  };

  await h.emit(progress);
  await h.emit(state);
  await h.emit(skip);
  await h.emit(interaction);

  assert.equal(h.protocolMessages.length, 4);
  assert.equal(h.protocolMessages[0], progress);
  assert.equal(h.protocolMessages[1], state);
  assert.equal(h.protocolMessages[2], skip);
  assert.equal(h.protocolMessages[3], interaction);
});

test("makeRecordingEmit: emit() + emitRecord() populate separate buffers (no cross-talk)", async () => {
  const h = makeRecordingEmit();
  await h.emitRecord("orders", { id: "ord-1" });
  await h.emit({ type: "PROGRESS", message: "hello" });
  await h.emitRecord("orders", { id: "ord-2" });

  assert.equal(h.emitted.length, 2, "records go to .emitted only");
  assert.equal(h.protocolMessages.length, 1, "protocol messages go to .protocolMessages only");
});

// ─── Unified events trace ────────────────────────────────────────────────

test("makeRecordingEmit: .events captures emit + emitRecord in call order", async () => {
  const h = makeRecordingEmit();
  await h.emitRecord("orders", { id: "ord-1" });
  await h.emit({ type: "PROGRESS", message: "halfway" });
  await h.emitRecord("orders", { id: "ord-2" });
  await h.emit({ type: "STATE", stream: "orders", cursor: { n: 2 } });

  assert.equal(h.events.length, 4);
  assert.equal(h.events[0]?.kind, "record");
  assert.equal(h.events[1]?.kind, "message");
  assert.equal(h.events[2]?.kind, "record");
  assert.equal(h.events[3]?.kind, "message");
  const ev3 = h.events[3];
  if (ev3?.kind === "message" && ev3.message.type === "STATE") {
    assert.equal(ev3.message.stream, "orders");
  } else {
    assert.fail("expected last event to be a STATE message");
  }
});

test("makeRecordingEmit: .events proves STATE lands AFTER last record (cross-kind ordering)", async () => {
  // This is the shape of assertion the chatgpt cursor proof now uses.
  // If an orchestration helper accidentally advances STATE between
  // records, this assertion fails — which the old split-array design
  // couldn't see.
  const h = makeRecordingEmit();
  await h.emitRecord("orders", { id: "ord-1" });
  await h.emitRecord("orders", { id: "ord-2" });
  await h.emit({ type: "STATE", stream: "orders", cursor: { n: 2 } });

  const lastRecordIdx = h.events.findLastIndex((e) => e.kind === "record");
  const stateIdx = h.events.findIndex(
    (e) => e.kind === "message" && e.message.type === "STATE" && e.message.stream === "orders"
  );
  assert.notEqual(lastRecordIdx, -1);
  assert.notEqual(stateIdx, -1);
  assert.ok(stateIdx > lastRecordIdx, "STATE must land strictly after the last record");
});

test("makeRecordingEmit: .events records validation failures with kind='record-skipped'", async () => {
  const validateRecord: ValidateRecord = (_stream, data) => {
    if (!data.id) {
      return { ok: false, issues: [{ path: "id", message: "required" }] };
    }
    return { ok: true, data };
  };
  const h = makeRecordingEmit(validateRecord);
  await h.emitRecord("orders", { id: "ok" });
  await h.emitRecord("orders", { total: 10 }); // missing id → skipped

  assert.equal(h.events.length, 2);
  assert.equal(h.events[0]?.kind, "record");
  assert.equal(h.events[1]?.kind, "record-skipped");
});

// ─── Subprocess protocol harness ────────────────────────────────────────

test("runConnectorProtocolSubprocess: non-browser fixture completes START to DONE over stdio", async () => {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: fixturePath("protocol-subprocess-non-browser.ts"),
    start: { type: "START", scope: { streams: [{ name: "items" }] } },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr.trim(), "");

  const types = result.messages.map((m) => m.type);
  assert.deepEqual(types, ["PROGRESS", "RECORD", "SKIP_RESULT", "STATE", "PROGRESS", "DONE"]);

  const record = result.messages.find((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD");
  assert.ok(record);
  assert.equal(record.stream, "items");
  assert.equal(record.key, "item-1");

  const skip = result.messages.find(
    (m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT"
  );
  assert.ok(skip, "invalid fixture row should become a runtime SKIP_RESULT");
  assert.equal(skip.reason, "shape_check_failed");

  const done = result.messages.at(-1);
  assert.equal(done?.type, "DONE");
  if (done?.type === "DONE") {
    assert.equal(done.status, "succeeded");
    assert.equal(done.records_emitted, 1);
  }
});

test("runConnectorProtocolSubprocess: browser-shaped no-browser fixture completes without launching Playwright", async () => {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: fixturePath("protocol-subprocess-browser-shaped.ts"),
    start: { type: "START", scope: { streams: [{ name: "orders" }, { name: "order_details" }] } },
  });

  assert.equal(result.code, 0);
  assert.equal(result.messages.at(-1)?.type, "DONE");
  assert.ok(
    result.messages.some((m) => m.type === "SKIP_RESULT" && m.stream === "order_details"),
    "browser-shaped fixture should report the deferred detail path without live browser work"
  );
  assert.ok(
    result.messages.some((m) => m.type === "RECORD" && m.stream === "orders"),
    "browser-shaped fixture should still emit the parent list record"
  );
});

test("runConnectorProtocolSubprocess: rejects a child that exits without terminal DONE", async () => {
  await assert.rejects(
    () =>
      runConnectorProtocolSubprocess({
        cwd: PACKAGE_ROOT,
        entrypoint: fixturePath("protocol-subprocess-bad-no-done.ts"),
        start: { type: "START", scope: { streams: [{ name: "items" }] } },
      }),
    /exited without DONE/
  );
});

test("runConnectorProtocolSubprocess: rejects non-zero child exit even after terminal DONE", async () => {
  await assert.rejects(
    () =>
      runConnectorProtocolSubprocess({
        cwd: PACKAGE_ROOT,
        entrypoint: fixturePath("protocol-subprocess-done-then-fail.ts"),
        start: { type: "START", scope: { streams: [{ name: "items" }] } },
      }),
    /exited non-zero after DONE/
  );
});

test("runConnectorProtocolSubprocess: failed DONE reports records emitted before a retryable failure", async () => {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: PACKAGE_ROOT,
    entrypoint: fixturePath("protocol-subprocess-fails-after-record.ts"),
    start: { type: "START", scope: { streams: [{ name: "items" }] } },
  });

  assert.equal(result.code, 1);
  const done = result.messages.at(-1);
  assert.equal(done?.type, "DONE");
  if (done?.type !== "DONE") {
    assert.fail("expected terminal DONE");
  }
  assert.equal(done.status, "failed");
  assert.equal(done.records_emitted, 1);
  assert.equal(done.error?.retryable, true);
  assert.match(done.error?.message ?? "", /retry budget exhausted/iu);
});
