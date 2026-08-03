// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted MCP clients (ChatGPT, Claude.ai) fetch the MCP URL from their own
 * servers. A loopback or plain-http origin is unreachable for them no matter
 * what the owner does locally, so the connect page must not promise those
 * clients will work. Local agents are unaffected.
 *
 * This is a SHAPE check: failing it proves unreachability, passing it proves
 * only that the syntax bar is cleared. DNS, firewalls, proxies, and
 * certificates still decide whether a hosted client actually connects.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyHostedMcpOrigin, hasPublicHttpsShape } from "./hosted-mcp-origin.ts";

test("loopback and private origins never clear the public-HTTPS shape bar", () => {
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
    assert.equal(hasPublicHttpsShape(origin), false, `${origin} must not clear the public-HTTPS shape bar`);
  }
});

test("plain http on a public host fails the shape bar", () => {
  assert.equal(hasPublicHttpsShape("http://pdpp.example.com"), false);
});

test("public https origins clear the shape bar", () => {
  for (const origin of [
    "https://pdpp.example.com",
    "https://pdpp.example.com:8443",
    "https://friendly-name.trycloudflare.com",
  ]) {
    assert.equal(hasPublicHttpsShape(origin), true, `${origin} must clear the public-HTTPS shape bar`);
  }
});

// 172.32 is outside the RFC1918 172.16/12 block and must not be misclassified.
test("public addresses adjacent to private ranges still clear the bar", () => {
  assert.equal(hasPublicHttpsShape("https://172.32.0.1"), true);
});

// Address families a plain "is it localhost" string check misses. Each of these
// is unroutable from a hosted client, so none may clear the shape bar.
test("CGNAT, private IPv6, mDNS and private-DNS hosts are rejected", () => {
  for (const origin of [
    "https://100.64.0.1",
    "https://100.127.255.255",
    "https://[::1]",
    "https://[fd00::1]",
    "https://[fe80::1]",
    "https://[::ffff:127.0.0.1]",
    "https://pdpp.local",
    "https://pdpp.internal",
    "https://pdpp.home.arpa",
    "https://nas.lan",
    "https://pdpp",
  ]) {
    assert.equal(hasPublicHttpsShape(origin), false, `${origin} must not clear the public-HTTPS shape bar`);
  }
});

// 100.128/9 is public even though it neighbours the CGNAT block.
test("addresses adjacent to the CGNAT block stay public", () => {
  assert.equal(hasPublicHttpsShape("https://100.128.0.1"), true);
  assert.equal(hasPublicHttpsShape("https://99.63.0.1"), true);
});

test("classification distinguishes why an origin fails, for honest copy", () => {
  assert.equal(classifyHostedMcpOrigin("http://pdpp.example.com"), "not_https");
  assert.equal(classifyHostedMcpOrigin("https://192.168.1.10"), "not_public_address");
  assert.equal(classifyHostedMcpOrigin("not-a-url"), "malformed");
  assert.equal(classifyHostedMcpOrigin("https://pdpp.example.com"), "public_https_shape");
});

// A trailing root-label dot is the same DNS name, so it must not smuggle a
// private-DNS suffix past the check.
test("trailing-dot FQDNs are classified like their dotless form", () => {
  for (const origin of ["https://nas.local.", "https://foo.internal.", "https://pdpp.home.arpa.", "https://127.0.0.1."]) {
    assert.equal(hasPublicHttpsShape(origin), false, `${origin} must not clear the public-HTTPS shape bar`);
  }
  assert.equal(hasPublicHttpsShape("https://pdpp.example.com."), true, "a public FQDN with a root dot is still public");
});
