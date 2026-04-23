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
import { test } from "node:test";
import type { EmittedMessage, ValidateRecord } from "./connector-runtime.ts";
import { makeRecordingEmit } from "./test-harness.ts";

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
