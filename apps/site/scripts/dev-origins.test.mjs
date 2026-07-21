// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { collectAllowedDevOrigins, isLocalDevIpv4, parseAllowedDevOrigins } from "./dev-origins.mjs";

test("parseAllowedDevOrigins accepts hostnames, URLs, and wildcards", () => {
  assert.deepEqual(parseAllowedDevOrigins("https://pdpp.test:3000, *.pdpp.test, 192.168.0.2"), [
    "pdpp.test",
    "*.pdpp.test",
    "192.168.0.2",
  ]);
});

test("isLocalDevIpv4 permits loopback, private LAN, link-local, and CGNAT ranges", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.10", "172.31.255.9", "192.168.0.2", "169.254.1.1", "100.64.0.2"]) {
    assert.equal(isLocalDevIpv4(address), true, address);
  }
});

test("isLocalDevIpv4 rejects public and malformed addresses", () => {
  for (const address of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2600:1700::1", "not-an-ip"]) {
    assert.equal(isLocalDevIpv4(address), false, address);
  }
});

test("collectAllowedDevOrigins combines env, machine hostnames, and local interface addresses", () => {
  const origins = collectAllowedDevOrigins({
    envValue: "example.test, https://proxy.test:3443",
    hostName: "workstation",
    interfaces: {
      eno2: [
        { address: "192.168.0.2", family: "IPv4" },
        { address: "8.8.8.8", family: "IPv4" },
      ],
      tailscale0: [{ address: "100.64.0.2", family: "IPv4" }],
    },
  });

  assert.deepEqual(origins, [
    "100.64.0.2",
    "192.168.0.2",
    "example.test",
    "proxy.test",
    "workstation",
    "workstation.local",
  ]);
});
