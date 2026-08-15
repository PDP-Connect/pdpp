// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { originMatchesHost, publicOrigin, redirectToPublicPath } from "./same-origin-route.ts";

function requestWith(headers: Record<string, string> = {}, url = "https://internal.example/submit"): Request {
  return new Request(url, { headers });
}

test("same-origin route helper preserves forwarded public origin for redirects", () => {
  const request = requestWith({
    host: "internal.example",
    "x-forwarded-host": "console.example",
    "x-forwarded-proto": "https",
  });
  assert.equal(publicOrigin(request), "https://console.example");
  const response = redirectToPublicPath(request, "/sources/add?error=failed");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://console.example/sources/add?error=failed");
});

test("same-origin route helper accepts absent or matching origins and rejects mismatches", () => {
  assert.equal(originMatchesHost(requestWith({ host: "console.example" })), true);
  assert.equal(originMatchesHost(requestWith({ host: "console.example", origin: "https://console.example" })), true);
  assert.equal(originMatchesHost(requestWith({ host: "console.example", origin: "https://attacker.example" })), false);
  assert.equal(originMatchesHost(requestWith({ host: "console.example", origin: "not a URL" })), false);
  assert.equal(originMatchesHost(requestWith({ origin: "https://console.example" })), false);
});
