// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hostile-input redaction coverage for `errorDetail` (the browser-session
 * connector's terminal-error body diagnostic). Restores the bounds this
 * connector's original terminal-error-detail.test.ts asserted before the
 * browser-session redesign deleted it wholesale: the new suite
 * (integration.test.ts) only ever feeds `errorDetail` benign bodies
 * ("session gone", "upstream boom"), so nothing proved secrets/URLs/emails
 * from a real Venmo error body are actually redacted before reaching
 * `connector_error_json` (F5 in /tmp/review-venmo-browser-redesign-0810.md).
 * Mirrors connectors/ynab/terminal-error-detail.test.ts, adapted to this
 * connector's `errorDetail(body: string)` signature (no token/endpoint
 * arguments — the browser-session redesign moved auth off a bearer token).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { errorDetail } from "./index.ts";

test("errorDetail: a hostile error.message cannot leak a bearer token, secret, or email", () => {
  const hostile = JSON.stringify({
    error: {
      message:
        "callback https://user:pw@evil.example.com/cb?access_token=BODYSECRET failed; " +
        "Authorization: Bearer BODYBEARER; password=BODYPASS; contact owner@example.com",
    },
  });
  const detail = errorDetail(hostile);
  for (const leak of ["BODYSECRET", "BODYBEARER", "BODYPASS", "owner@example.com", "user:pw", "evil.example.com"]) {
    assert.doesNotMatch(detail, new RegExp(leak), `${leak} must not survive the body diagnostic`);
  }
});

test("errorDetail: a non-envelope body (proxy/HTML dump) is redacted wholesale and bounded to 200 chars", () => {
  const proxyDump = `<html>gateway error for https://user:pw@proxy.example.com/x?token=PROXYSECRET
    contact ops@example.com</html>${"padding ".repeat(60)}`;
  const detail = errorDetail(proxyDump);
  for (const leak of ["PROXYSECRET", "ops@example.com", "user:pw", "proxy.example.com"]) {
    assert.doesNotMatch(detail, new RegExp(leak), `${leak} must not survive an unrecognized body`);
  }
  assert.ok(detail.length <= 200, `expected a bounded diagnostic, got ${detail.length}`);
});

test("errorDetail: redaction runs BEFORE the 200-char bound, so no secret survives as a truncated fragment", () => {
  // The secret sits past the bound: slicing first would cut through the token
  // rather than redacting it, leaving a fragment of the real value behind.
  const body = JSON.stringify({
    error: { message: `${"padding ".repeat(30)}token=TAILSECRETVALUE` },
  });
  const detail = errorDetail(body);
  assert.doesNotMatch(detail, /TAILSECRETVALUE/, "no whole secret");
  assert.doesNotMatch(detail, /TAILSECRET/, "not even a truncated fragment");
});

test("errorDetail: a plain-text (non-JSON) failure with a query-string secret is redacted", () => {
  const detail = errorDetail("plain text failure https://api.venmo.com/v1/oauth/access_token?secret=abc");
  assert.doesNotMatch(detail, /secret=abc/);
});

test("errorDetail: an ordinary benign error.message still reads usefully end to end (COUNTERWEIGHT)", () => {
  // Sanitizing must not gut a benign, useful error — this is the counterweight
  // for the hostile-input work above.
  assert.match(errorDetail(JSON.stringify({ error: { message: "account disabled" } })), /account disabled/);
  assert.match(errorDetail("upstream boom"), /upstream boom/);
});
