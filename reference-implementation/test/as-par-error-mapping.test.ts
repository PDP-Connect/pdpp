// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { mapParProtocolError } from "../server/routes/as-par.ts";

test("mapParProtocolError: maps source validation without mutating the source error", () => {
  const source = Object.assign(new Error("authorization_details is invalid"), {
    code: "source.authorization_details_invalid",
    param: "authorization_details",
    request_id: "req-123",
    statusCode: 400,
    trace_id: "trace-456",
  });

  const mapped = mapParProtocolError(source);

  assert.ok(mapped instanceof Error);
  assert.notStrictEqual(mapped, source);
  assert.equal(source.code, "source.authorization_details_invalid");
  assert.equal((mapped as Error & { code?: string }).code, "invalid_authorization_details");
  assert.equal(mapped.message, source.message);
  assert.equal((mapped as Error & { param?: string }).param, source.param);
  assert.equal((mapped as Error & { request_id?: string }).request_id, source.request_id);
  assert.equal((mapped as Error & { statusCode?: number }).statusCode, source.statusCode);
  assert.equal((mapped as Error & { trace_id?: string }).trace_id, source.trace_id);
  assert.equal(mapped.cause, source);
});
