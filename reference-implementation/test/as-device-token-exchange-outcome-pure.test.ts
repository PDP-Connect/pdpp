// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the RFC 8628 device-code token-exchange operation in
// operations/as-device-token-exchange/index.ts. No test imports it by name. It
// governs the polling token exchange: grant-type validation, the client-fault vs
// server-fault status split (authorization_pending/slow_down/... are 400 polling
// signals, not 500s), and the redaction of trace_context from the token response.
//
// RED note: auth-surface. Tests OBSERVE the outcome mapping; exchange is stubbed,
// no token is minted.
//
// Mutation surface:
//   - unsupported grant_type -> 400/unsupported_grant_type.
//   - success -> 200, trace_context stripped from publicResult, surfaced as traceContext.
//   - thrown CLIENT_FAULT code (authorization_pending/slow_down/access_denied/
//     expired_token/invalid_grant/invalid_client) -> 400; any other code -> 500.
//   - errorCode/message defaults; request_id/trace_id extracted from the error.

import assert from "node:assert/strict";
import test from "node:test";

import {
  type AsDeviceTokenExchangeDependencies,
  type AsDeviceTokenExchangeInput,
  executeAsDeviceTokenExchange,
} from "../operations/as-device-token-exchange/index.ts";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

class DeviceTokenExchangeError extends Error {
  code?: string;
  request_id?: string;
  trace_id?: string;
}

function inputFor(overrides: Partial<AsDeviceTokenExchangeInput> & { grantType: string }): AsDeviceTokenExchangeInput {
  return {
    clientId: null,
    deviceCode: null,
    ...overrides,
  };
}

function throwingDeps(
  code: string | undefined,
  extra: { message?: string; request_id?: string; trace_id?: string } = {}
): AsDeviceTokenExchangeDependencies {
  return {
    exchangeDeviceCode: () => {
      const err = new DeviceTokenExchangeError(extra.message ?? "boom");
      if (code !== undefined) {
        err.code = code;
      }
      if (extra.request_id !== undefined) {
        err.request_id = extra.request_id;
      }
      if (extra.trace_id !== undefined) {
        err.trace_id = extra.trace_id;
      }
      throw err;
    },
  };
}

test("executeAsDeviceTokenExchange: an unsupported grant_type is a 400 unsupported_grant_type", async () => {
  const out = await executeAsDeviceTokenExchange(inputFor({ grantType: "authorization_code" }), {
    exchangeDeviceCode: () => {
      throw new Error("should not be called");
    },
  });
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 400);
  assert.equal(out.errorCode, "unsupported_grant_type");
});

test("executeAsDeviceTokenExchange: a successful exchange is 200 and redacts trace_context", async () => {
  const out = await executeAsDeviceTokenExchange(
    inputFor({ clientId: "cli", deviceCode: "dc", grantType: DEVICE_CODE_GRANT }),
    { exchangeDeviceCode: () => ({ access_token: "AT", token_type: "Bearer", trace_context: { trace_id: "T" } }) }
  );
  assert.ok(out.outcome === "success");
  assert.equal(out.status, 200);
  assert.equal(out.publicResult.access_token, "AT", "token surfaced");
  assert.ok(!("trace_context" in out.publicResult), "trace_context stripped from the public token response");
  assert.deepEqual(out.traceContext, { trace_id: "T" }, "trace_context surfaced separately");
});

test("executeAsDeviceTokenExchange: RFC 8628 polling signals are 400 (client faults, not 500)", async () => {
  for await (const code of [
    "authorization_pending",
    "slow_down",
    "access_denied",
    "expired_token",
    "invalid_grant",
    "invalid_client",
  ]) {
    const out = await executeAsDeviceTokenExchange(inputFor({ grantType: DEVICE_CODE_GRANT }), throwingDeps(code));
    assert.ok(out.outcome === "failure");
    assert.equal(out.status, 400, `${code} must be a 400 client fault`);
    assert.equal(out.errorCode, code);
  }
});

test("executeAsDeviceTokenExchange: an unrecognized / server error code is a 500", async () => {
  assert.equal(
    (await executeAsDeviceTokenExchange(inputFor({ grantType: DEVICE_CODE_GRANT }), throwingDeps("server_error")))
      .status,
    500
  );
  assert.equal(
    (
      await executeAsDeviceTokenExchange(
        inputFor({ grantType: DEVICE_CODE_GRANT }),
        throwingDeps("some_unexpected_failure")
      )
    ).status,
    500
  );
});

test("executeAsDeviceTokenExchange: error with no code defaults to server_error/500 and a fallback message", async () => {
  const out = await executeAsDeviceTokenExchange(inputFor({ grantType: DEVICE_CODE_GRANT }), {
    exchangeDeviceCode: () => {
      const error = new Error("cleared to exercise the fallback message");
      error.message = "";
      throw error;
    },
  });
  assert.ok(out.outcome === "failure");
  assert.equal(out.errorCode, "server_error", "default error code");
  assert.equal(out.status, 500);
  assert.equal(out.errorMessage, "Token exchange failed", "default message");
});

test("executeAsDeviceTokenExchange: request_id and trace_id are carried from the thrown error", async () => {
  const out = await executeAsDeviceTokenExchange(
    inputFor({ grantType: DEVICE_CODE_GRANT }),
    throwingDeps("authorization_pending", { request_id: "rq-1", trace_id: "tr-1" })
  );
  assert.ok(out.outcome === "failure");
  assert.equal(out.requestId, "rq-1");
  assert.equal(out.traceId, "tr-1");
});
