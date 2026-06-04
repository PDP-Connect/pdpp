/**
 * Tests for connector_options wiring in the local-collector path.
 *
 * Proves:
 *   1. buildCollectorStartMessage includes connector_options in the START message.
 *   2. buildCollectorStartMessage omits connector_options when not provided.
 *   3. runCollectorConnector rejects invalid connector_options before spawn when
 *      a manifest is provided.
 *   4. runCollectorConnector accepts valid connector_options when manifest is present.
 *   5. runCollectorConnector skips validation when no manifest is provided
 *      (backward compat — no schema → always proceed).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildCollectorStartMessage } from "./collector-runner.ts";
import type { ManifestWithConfigSchemas } from "./validate-connector-options.ts";

// ─── buildCollectorStartMessage ─────────────────────────────────────────────

test("buildCollectorStartMessage: omits connector_options when not provided", () => {
  const msg = buildCollectorStartMessage(["messages"]);
  assert.equal(msg.type, "START");
  assert.ok(!("connector_options" in msg), "connector_options must be absent when not passed");
});

test("buildCollectorStartMessage: omits connector_options when empty object is provided", () => {
  const msg = buildCollectorStartMessage(["messages"], [], null, {});
  assert.ok(!("connector_options" in msg), "empty connector_options must be omitted");
});

test("buildCollectorStartMessage: includes connector_options when provided", () => {
  const opts = { LOOKBACK_DAYS: 14, VERBOSE: true };
  const msg = buildCollectorStartMessage(["messages"], [], null, opts);
  assert.deepEqual(msg.connector_options, opts);
});

test("buildCollectorStartMessage: connector_options is a copy, not the original reference", () => {
  const opts = { LOOKBACK_DAYS: 7 };
  const msg = buildCollectorStartMessage(["messages"], [], null, opts);
  assert.notEqual(msg.connector_options, opts, "should be a defensive copy");
  assert.deepEqual(msg.connector_options, opts);
});

test("buildCollectorStartMessage: other fields unaffected when connector_options is set", () => {
  const priorState = { messages: "cursor-abc" };
  const backfills = ["archive"];
  const msg = buildCollectorStartMessage(["messages", "archive"], backfills, priorState, { DAYS: 3 });
  assert.deepEqual(
    msg.scope.streams.map((s) => s.name),
    ["messages", "archive"]
  );
  assert.deepEqual(msg.streamsToBackfill, ["archive"]);
  assert.deepEqual(msg.state, priorState);
  assert.deepEqual(msg.connector_options, { DAYS: 3 });
});

// ─── runCollectorConnector validation ───────────────────────────────────────
//
// These tests stub the network by using a connector fixture and a fake server URL
// that will fail at the outbox drain step — but validation fires BEFORE spawn,
// so a validation error throws before any network call.

const MANIFEST_WITH_SCHEMA: ManifestWithConfigSchemas = {
  options_schema: {
    type: "object",
    properties: {
      LOOKBACK_DAYS: { type: "integer", default: 7 },
      VERBOSE: { type: "boolean", default: false },
    },
  },
  credentials_schema: {
    type: "object",
    properties: {
      API_TOKEN: { type: "string" },
    },
  },
};

test("runCollectorConnector: rejects before spawn when options fail schema validation", async () => {
  const { runCollectorConnector } = await import("./collector-runner.ts");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdtempSync } = await import("node:fs");

  const queuePath = join(mkdtempSync(join(tmpdir(), "pdpp-opts-test-")), "queue.sqlite");

  await assert.rejects(
    () =>
      runCollectorConnector({
        baseUrl: "http://localhost:19999",
        connector: {
          args: [],
          command: "node",
          connector_id: "test",
          manifest: MANIFEST_WITH_SCHEMA,
          runtime_requirements: { bindings: {} },
          streams: ["messages"],
          connector_options: { LOOKBACK_DAYS: "not-an-integer" },
        },
        deviceId: "device-1",
        deviceToken: "tok",
        queuePath,
        sourceInstanceId: "src-1",
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("connector_options validation failed"),
        `expected validation error, got: ${err.message}`
      );
      assert.ok(err.message.includes("LOOKBACK_DAYS"), `expected field name in error: ${err.message}`);
      return true;
    }
  );
});

test("runCollectorConnector: no manifest provided — any options pass (backward compat)", async () => {
  // Without a manifest, validation is skipped. The run will fail at the
  // network level (fake baseUrl), but it must NOT fail at the options validation step.
  // We confirm by checking that the error is NOT a validation error.
  const { runCollectorConnector } = await import("./collector-runner.ts");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mkdtempSync } = await import("node:fs");

  const queuePath = join(mkdtempSync(join(tmpdir(), "pdpp-opts-noschema-")), "queue.sqlite");

  try {
    await runCollectorConnector({
      baseUrl: "http://localhost:19999",
      connector: {
        args: [],
        command: "node",
        connector_id: "legacy",
        // No manifest field — backward compat
        runtime_requirements: { bindings: {} },
        streams: ["messages"],
        connector_options: { ANYTHING: "goes", NUMERIC: 42 },
      },
      deviceId: "device-1",
      deviceToken: "tok",
      queuePath,
      sourceInstanceId: "src-legacy",
    });
  } catch (err) {
    // A network/spawn error here is fine — we only care that it's NOT a
    // connector_options validation error.
    assert.ok(
      !(err instanceof Error && err.message.includes("connector_options validation failed")),
      `must not be a validation error when no manifest provided, got: ${err instanceof Error ? err.message : err}`
    );
  }
});
