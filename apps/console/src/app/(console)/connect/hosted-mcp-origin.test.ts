// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted MCP clients (ChatGPT, Claude.ai) fetch the MCP URL from their own
 * servers. A loopback or plain-http origin is unreachable for them no matter
 * what the owner does locally, so the connect page must not promise those
 * clients will work. Local agents are unaffected.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isHostedMcpReachableOrigin } from "./hosted-mcp-origin.ts";

test("loopback and private origins are not reachable by hosted MCP clients", () => {
  for (const origin of [
    "http://localhost:3000",
    "https://localhost:3000",
    "http://127.0.0.1:3000",
    "https://127.0.0.1:3000",
    "http://192.168.1.10:3000",
    "https://192.168.1.10",
    "https://10.0.0.5",
    "https://172.16.4.4",
    "https://169.254.10.1",
    "not-a-url",
  ]) {
    assert.equal(isHostedMcpReachableOrigin(origin), false, `${origin} must not be advertised as hosted-reachable`);
  }
});

test("plain http on a public host is still unreachable for hosted clients", () => {
  assert.equal(isHostedMcpReachableOrigin("http://pdpp.example.com"), false);
});

test("public https origins are reachable by hosted MCP clients", () => {
  for (const origin of [
    "https://pdpp.example.com",
    "https://pdpp.example.com:8443",
    "https://friendly-name.trycloudflare.com",
  ]) {
    assert.equal(isHostedMcpReachableOrigin(origin), true, `${origin} must be advertised as hosted-reachable`);
  }
});

// 172.32 is outside the RFC1918 172.16/12 block and must not be misclassified.
test("public addresses adjacent to private ranges stay reachable", () => {
  assert.equal(isHostedMcpReachableOrigin("https://172.32.0.1"), true);
});
