// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the RFC 8628 device-authorization INIT operation in
// operations/as-device-authorization-init/index.ts. No test imports it by name.
// It initiates the device flow: client_id validation, trace_context redaction from
// the RFC 8628 envelope, and an always-400 client-error path.
//
// RED note: auth-surface. Tests OBSERVE the outcome mapping; initiate is stubbed.
//
// Mutation surface:
//   - missing client_id -> 400/invalid_request/"client_id is required".
//   - success -> 200, trace_context stripped from publicResult, surfaced separately.
//   - thrown error -> 400 (always), errorCode from err.code (default invalid_request),
//     message default 'Device authorization rejected', request_id/trace_id carried.

import assert from "node:assert/strict";
import test from "node:test";

import { executeAsDeviceAuthInit } from "../operations/as-device-authorization-init/index.ts";

class DeviceAuthInitError extends Error {
  code?: string;
  request_id?: string;
  trace_id?: string;
}

test("executeAsDeviceAuthInit: a missing client_id is a 400 invalid_request", async () => {
  for (const clientId of [null, undefined, ""]) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    const out = await executeAsDeviceAuthInit({ baseUrl: "https://as", clientId }, { initiate: () => ({}) });
    assert.ok(out.outcome === "failure");
    assert.equal(out.status, 400);
    assert.equal(out.errorCode, "invalid_request");
    assert.equal(out.errorMessage, "client_id is required");
  }
});

test("executeAsDeviceAuthInit: success is 200 and redacts trace_context from the RFC 8628 envelope", async () => {
  let received: { id: string; opts: { baseUrl: string } } | null = null;
  const out = await executeAsDeviceAuthInit(
    { baseUrl: "https://as", clientId: "cli" },
    {
      initiate: (id, opts) => {
        received = { id, opts };
        return {
          device_code: "dc",
          interval: 5,
          trace_context: { trace_id: "T" },
          user_code: "WXYZ-1234",
          verification_uri: "https://as/device",
        };
      },
    }
  );
  assert.deepEqual(received, { id: "cli", opts: { baseUrl: "https://as" } }, "clientId + baseUrl forwarded");
  assert.ok(out.outcome === "success");
  assert.equal(out.status, 200);
  assert.equal(out.publicResult.user_code, "WXYZ-1234", "RFC 8628 fields surfaced");
  assert.equal(out.publicResult.device_code, "dc");
  assert.ok(!("trace_context" in out.publicResult), "trace_context stripped from the public envelope");
  assert.deepEqual(out.traceContext, { trace_id: "T" });
});

test("executeAsDeviceAuthInit: a thrown error is always a 400 client error", async () => {
  const out = await executeAsDeviceAuthInit(
    { baseUrl: "https://as", clientId: "cli" },
    {
      initiate: () => {
        const e = new DeviceAuthInitError("bad client");
        e.code = "invalid_client";
        throw e;
      },
    }
  );
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 400, "init errors are client faults (always 400)");
  assert.equal(out.errorCode, "invalid_client");
  assert.equal(out.errorMessage, "bad client");
});

test("executeAsDeviceAuthInit: error with no code/message uses invalid_request + fallback message", async () => {
  const out = await executeAsDeviceAuthInit(
    { baseUrl: "https://as", clientId: "cli" },
    {
      initiate: () => {
        // biome-ignore lint/suspicious/useErrorMessage: Test verifies the empty upstream error payload behavior.
        throw new Error("");
      },
    }
  );
  assert.ok(out.outcome === "failure");
  assert.equal(out.errorCode, "invalid_request");
  assert.equal(out.errorMessage, "Device authorization rejected");
});

test("executeAsDeviceAuthInit: request_id and trace_id are carried from the thrown error", async () => {
  const out = await executeAsDeviceAuthInit(
    { baseUrl: "https://as", clientId: "cli" },
    {
      initiate: () => {
        const e = new DeviceAuthInitError("x");
        e.code = "invalid_client";
        e.request_id = "rq-9";
        e.trace_id = "tr-9";
        throw e;
      },
    }
  );
  assert.ok(out.outcome === "failure");
  assert.equal(out.requestId, "rq-9");
  assert.equal(out.traceId, "tr-9");
});
