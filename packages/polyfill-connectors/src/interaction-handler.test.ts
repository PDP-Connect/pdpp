import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { __testing, handleInteraction, type InteractionMessage } from "./interaction-handler.ts";

const { buildClickUrl, normalizeStatus } = __testing;

const ENV_KEYS = ["PDPP_WEB_BASE_URL", "PDPP_REFERENCE_ORIGIN"] as const;

function clearWebBaseEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  const saved = {} as Record<(typeof ENV_KEYS)[number], string | undefined>;
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreWebBaseEnv(saved: Record<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

describe("buildClickUrl", () => {
  let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    saved = clearWebBaseEnv();
  });

  afterEach(() => {
    restoreWebBaseEnv(saved);
  });

  test("returns undefined when runId is not provided", () => {
    assert.equal(buildClickUrl(undefined, "manual_action", "i-1"), undefined);
  });

  test("manual_action produces stream viewer URL with interaction_id", () => {
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "manual_action", "i-42");
    assert.equal(url, "https://reference.example.com/dashboard/runs/run-1/stream?interaction_id=i-42");
  });

  test("non-manual_action kinds produce the run page URL", () => {
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "credentials", "i-42");
    assert.equal(url, "https://reference.example.com/dashboard/runs/run-1");
  });

  test("PDPP_WEB_BASE_URL takes priority over PDPP_REFERENCE_ORIGIN", () => {
    process.env.PDPP_WEB_BASE_URL = "https://web.example.com";
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "manual_action", "i-1");
    assert.ok(url?.startsWith("https://web.example.com/"));
  });

  test("falls back to PDPP_REFERENCE_ORIGIN when web URL is unset", () => {
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "manual_action", "i-1");
    assert.ok(url?.startsWith("https://reference.example.com/"));
  });

  test("falls back to localhost when neither env var is set", () => {
    const url = buildClickUrl("run-1", "manual_action", "i-1");
    assert.ok(url?.startsWith("http://localhost:3000/"));
  });

  test("trims whitespace in env values", () => {
    process.env.PDPP_REFERENCE_ORIGIN = "  https://reference.example.com  ";
    const url = buildClickUrl("run-1", "manual_action", "i-1");
    assert.ok(url?.startsWith("https://reference.example.com/"));
  });

  test("treats empty string as unset and falls through to next source", () => {
    process.env.PDPP_WEB_BASE_URL = "";
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "manual_action", "i-1");
    assert.ok(url?.startsWith("https://reference.example.com/"));
  });

  test("missing interactionId still produces a URL with empty query value", () => {
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "manual_action", undefined);
    assert.equal(url, "https://reference.example.com/dashboard/runs/run-1/stream?interaction_id=");
  });
});

// Regression: the live ChatGPT failure mode `interaction_handler_invalid_response`
// (see tmp/workstreams/pwa-scheduler-status-memo.md) was caused by handlers
// that returned envelopes whose `status` was not in the runtime-validated set
// {success, cancelled, timeout}. The CLI orchestrator path uses
// `handleInteraction`, so its failure paths must also normalize.
describe("normalizeStatus", () => {
  test("preserves contract-allowed statuses", () => {
    assert.equal(normalizeStatus("success"), "success");
    assert.equal(normalizeStatus("cancelled"), "cancelled");
    assert.equal(normalizeStatus("timeout"), "timeout");
  });

  test("maps free-form / legacy statuses to cancelled", () => {
    assert.equal(normalizeStatus("failed"), "cancelled");
    assert.equal(normalizeStatus("error"), "cancelled");
    assert.equal(normalizeStatus(""), "cancelled");
    assert.equal(normalizeStatus(undefined), "cancelled");
    assert.equal(normalizeStatus("anything"), "cancelled");
  });
});

describe("handleInteraction envelope shape", () => {
  // Force the file-drop path (no TTY) and a tight timeout so the test runs
  // quickly. Drop a synthetic response file before invoking the handler so
  // waitForFile resolves on the first poll.
  function dropResponse(requestId: string, body: object): void {
    const path = join(tmpdir(), `pdpp-interaction-${requestId}.response.json`);
    writeFileSync(path, JSON.stringify(body), "utf8");
  }

  // Each test uses a unique request_id so the tmp-file probe doesn't collide.
  function withFreshRequestId(label: string): string {
    return `${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }

  test("returns runtime-valid envelope with exact request_id when status is success", async () => {
    const request_id = withFreshRequestId("ok");
    dropResponse(request_id, { status: "success", data: { code: "123456" } });
    const msg: InteractionMessage = {
      kind: "otp",
      message: "Enter OTP",
      request_id,
      timeout_seconds: 60,
    };
    const out = await handleInteraction(msg, { connectorName: "test" });
    assert.equal(out.type, "INTERACTION_RESPONSE");
    assert.equal(out.request_id, request_id);
    assert.equal(out.status, "success");
    assert.deepEqual(out.data, { code: "123456" });
  });

  test("normalizes free-form 'failed' status to 'cancelled' so runtime validator does not throw", async () => {
    const request_id = withFreshRequestId("failed");
    // Owner writes a legacy envelope with status:"failed". Pre-fix this would
    // surface as `interaction_handler_invalid_response` upstream because the
    // runtime only accepts success|cancelled|timeout.
    dropResponse(request_id, { status: "failed", error: { code: "user_aborted", message: "owner cancelled" } });
    const msg: InteractionMessage = {
      kind: "manual_action",
      message: "Test",
      request_id,
      timeout_seconds: 60,
    };
    const out = await handleInteraction(msg, { connectorName: "test" });
    assert.equal(out.type, "INTERACTION_RESPONSE");
    assert.equal(out.request_id, request_id);
    assert.equal(out.status, "cancelled");
    // Error context is still preserved for the run timeline.
    assert.equal(out.error?.code, "user_aborted");
  });

  test("preserves cancelled status when owner explicitly cancels", async () => {
    const request_id = withFreshRequestId("cancel");
    dropResponse(request_id, { status: "cancelled" });
    const msg: InteractionMessage = {
      kind: "manual_action",
      message: "Test",
      request_id,
      timeout_seconds: 60,
    };
    const out = await handleInteraction(msg, { connectorName: "test" });
    assert.equal(out.status, "cancelled");
  });

  test("never emits an arbitrary status string from the file-drop body", async () => {
    const request_id = withFreshRequestId("garbage");
    dropResponse(request_id, { status: "totally_made_up_status" });
    const msg: InteractionMessage = {
      kind: "manual_action",
      message: "Test",
      request_id,
      timeout_seconds: 60,
    };
    const out = await handleInteraction(msg, { connectorName: "test" });
    assert.ok(["success", "cancelled", "timeout"].includes(out.status));
  });
});
