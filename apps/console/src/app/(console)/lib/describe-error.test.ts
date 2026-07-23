// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { describeError, describeErrorText } from "./describe-error.ts";

const FALLBACK = "request failed (409)";

test("describeError prefers the reference-server envelope error.message", () => {
  const body = {
    error: {
      code: "subscription_already_disabled",
      message: "Subscription sub_abc is already disabled.",
      request_id: "req_1",
      type: "about:blank",
    },
  };
  assert.equal(describeError(body, FALLBACK), "Subscription sub_abc is already disabled.");
});

test("describeError prefers OAuth error_description when present", () => {
  const body = { error: "invalid_request", error_description: "The reason field exceeds 256 bytes." };
  assert.equal(describeError(body, FALLBACK), "The reason field exceeds 256 bytes.");
});

test("describeError surfaces a bare string error code when that is all there is", () => {
  assert.equal(describeError({ error: "access_denied" }, FALLBACK), "access_denied");
});

test("describeError returns a trimmed non-JSON string body verbatim", () => {
  assert.equal(describeError("  upstream timeout  ", FALLBACK), "upstream timeout");
});

test("describeError falls back when the body carries no usable message", () => {
  assert.equal(describeError({}, FALLBACK), FALLBACK);
  assert.equal(describeError(null, FALLBACK), FALLBACK);
  assert.equal(describeError({ error: {} }, FALLBACK), FALLBACK);
});

test("describeErrorText parses a JSON envelope string into the friendly message", () => {
  // This is exactly what `refFetch` holds: `await res.text()` of the
  // reference server's error envelope. The operator must see the message,
  // not the stringified blob.
  const raw = JSON.stringify({
    error: { code: "not_found", message: "Subscription not found.", type: "about:blank" },
  });
  assert.equal(
    describeErrorText(raw, "_ref /_ref/event-subscriptions/sub_x/disable failed (404)"),
    "Subscription not found."
  );
});

test("describeErrorText falls back to the status summary for a non-JSON body", () => {
  assert.equal(
    describeErrorText("<html>502 Bad Gateway</html>", "_ref /x failed (502)"),
    "<html>502 Bad Gateway</html>"
  );
});

test("describeErrorText never returns a raw JSON blob containing the envelope braces", () => {
  // Regression guard for the disable-affordance gap: the operator banner must
  // not show `{"error":{...}}`. describeErrorText must always resolve to the
  // inner message (or the clean fallback), never the stringified envelope.
  const raw = '{"error":{"code":"conflict","message":"Already disabled."}}';
  const out = describeErrorText(raw, "_ref /x failed (409)");
  assert.equal(out, "Already disabled.");
  assert.ok(!out.includes("{"), "friendly message must not contain raw JSON braces");
});
