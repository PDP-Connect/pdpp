import assert from "node:assert/strict";
import test from "node:test";
import type { SpineEvent } from "../../lib/ref-client.ts";
import {
  extractBridgeUnavailable,
  HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  hasBridgeUnavailableCode,
} from "./bridge-unavailable.ts";

// Minimal SpineEvent factory — only the fields the detector reads.
function makeFailedEvent(data: Record<string, unknown>): SpineEvent {
  return {
    actor_id: "runtime",
    actor_type: "runtime",
    client_id: null,
    data,
    event_id: "ev_test",
    event_type: "run.failed",
    grant_id: null,
    interaction_id: null,
    object_id: "run_test",
    object_type: "run",
    occurred_at: "2026-01-01T00:00:00Z",
    provider_id: null,
    recorded_at: "2026-01-01T00:00:00Z",
    request_id: null,
    run_id: "run_test",
    scenario_id: null,
    status: "failed",
    stream_id: null,
    subject_id: null,
    subject_type: null,
    token_id: null,
    trace_id: "trace_test",
    version: "1",
  };
}

// ─── hasBridgeUnavailableCode ─────────────────────────────────────────────────

test("hasBridgeUnavailableCode: returns true for connector_error_message (real wire path)", () => {
  // This is the primary real path: TerminalError("[code] msg") → DONE.error.message
  // → run.failed data.connector_error_message
  assert.equal(
    hasBridgeUnavailableCode({
      reason: "connector_reported_failed",
      connector_error_message: `[${HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE}] Host browser bridge unavailable at ws://host.docker.internal:7670: connection refused.`,
    }),
    true
  );
});

test("hasBridgeUnavailableCode: returns true for reason field (direct/future path)", () => {
  assert.equal(hasBridgeUnavailableCode({ reason: HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE }), true);
});

test("hasBridgeUnavailableCode: returns true for failure_reason field", () => {
  assert.equal(hasBridgeUnavailableCode({ failure_reason: HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE }), true);
});

test("hasBridgeUnavailableCode: returns true for connector_error_code field", () => {
  assert.equal(hasBridgeUnavailableCode({ connector_error_code: HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE }), true);
});

test("hasBridgeUnavailableCode: returns true for code field", () => {
  assert.equal(hasBridgeUnavailableCode({ code: HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE }), true);
});

test("hasBridgeUnavailableCode: returns false for connector_reported_failed without code", () => {
  assert.equal(
    hasBridgeUnavailableCode({
      reason: "connector_reported_failed",
      connector_error_message: "could not open browser profile: Chrome not found",
    }),
    false
  );
});

test("hasBridgeUnavailableCode: returns false for runtime_error without code", () => {
  assert.equal(hasBridgeUnavailableCode({ reason: "runtime_error" }), false);
});

test("hasBridgeUnavailableCode: returns false for empty data", () => {
  assert.equal(hasBridgeUnavailableCode({}), false);
});

// ─── extractBridgeUnavailable ─────────────────────────────────────────────────

test("extractBridgeUnavailable: returns null for undefined", () => {
  assert.equal(extractBridgeUnavailable(undefined), null);
});

test("extractBridgeUnavailable: returns null when code absent from all fields", () => {
  const event = makeFailedEvent({
    reason: "connector_reported_failed",
    connector_error_message: "could not open browser profile: Chrome not found",
  });
  assert.equal(extractBridgeUnavailable(event), null);
});

test("extractBridgeUnavailable: detects real wire-path shape and extracts WS URL", () => {
  // Exact shape produced by reference-implementation/runtime/index.js when the
  // connector emits DONE{status:"failed", error:{message:"[code] ..."}}
  const event = makeFailedEvent({
    reason: "connector_reported_failed",
    connector_error_message:
      "[host_browser_bridge_unavailable] Host browser bridge unavailable at ws://host.docker.internal:7670: connect ECONNREFUSED. Ensure the host bridge is running...",
    connector_error_retryable: false,
  });
  const result = extractBridgeUnavailable(event);
  assert.ok(result !== null, "should detect the failure");
  assert.equal(result.url, "ws://host.docker.internal:7670");
  assert.ok(result.cause.includes(HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE), "cause should contain the stable code");
});

test("extractBridgeUnavailable: detects Linux docker bridge IP URL", () => {
  const event = makeFailedEvent({
    reason: "connector_reported_failed",
    connector_error_message:
      "[host_browser_bridge_unavailable] Host browser bridge unavailable at ws://172.17.0.1:7670: connection refused.",
  });
  const result = extractBridgeUnavailable(event);
  assert.ok(result !== null);
  assert.equal(result.url, "ws://172.17.0.1:7670");
});

test("extractBridgeUnavailable: falls back to bridge_url field when URL absent from message", () => {
  const event = makeFailedEvent({
    reason: "connector_reported_failed",
    connector_error_message: `[${HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE}] misconfigured`,
    bridge_url: "ws://host.docker.internal:7670",
  });
  const result = extractBridgeUnavailable(event);
  assert.ok(result !== null);
  assert.equal(result.url, "ws://host.docker.internal:7670");
});

test("extractBridgeUnavailable: returns null URL when no URL present anywhere", () => {
  const event = makeFailedEvent({
    connector_error_message: `[${HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE}] token mismatch`,
  });
  const result = extractBridgeUnavailable(event);
  assert.ok(result !== null);
  assert.equal(result.url, null);
});

test("extractBridgeUnavailable: detects code in reason field (direct path)", () => {
  const event = makeFailedEvent({ reason: HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE });
  const result = extractBridgeUnavailable(event);
  assert.ok(result !== null);
});
