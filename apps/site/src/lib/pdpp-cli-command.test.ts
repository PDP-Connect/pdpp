// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the dashboard CLI invocation helpers. The dashboard
 * advertises a canonical `pdpp ref ...` command next to a zero-install
 * `npx -y @pdpp/cli ref ...` fallback so users who haven't installed
 * the binary still have a runnable form.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  pdppCliCollectorEnrollCommand,
  pdppCliCollectorRunCommand,
  pdppCliConnectCommand,
  pdppCliConnectCommandFor,
  pdppCliInstallCommand,
  pdppCliMonorepoCommand,
  pdppCliNoInstallCommand,
  pdppCliPackageInfo,
} from "./pdpp-cli-command.ts";

const NPX_CONNECT_PREFIX = /^npx -y @pdpp\/cli connect /;

test("package info advertises the @pdpp/cli specifier", () => {
  assert.equal(pdppCliPackageInfo.packageName, "@pdpp/cli");
  assert.equal(pdppCliPackageInfo.binName, "pdpp");
  assert.equal(pdppCliPackageInfo.packageSpecifier, "@pdpp/cli");
});

test("connect command uses npx + package specifier", () => {
  assert.match(pdppCliConnectCommand, NPX_CONNECT_PREFIX);
});

test("connect command can be rendered for a concrete provider URL", () => {
  assert.equal(pdppCliConnectCommandFor("https://pdpp.example.com"), "npx -y @pdpp/cli connect https://pdpp.example.com");
});

test("install command uses npx + --help", () => {
  assert.equal(pdppCliInstallCommand, "npx -y @pdpp/cli --help");
});

test("pdppCliNoInstallCommand rewrites pdpp ref invocations to npx form", () => {
  assert.equal(pdppCliNoInstallCommand("pdpp ref run timeline abc-123"), "npx -y @pdpp/cli ref run timeline abc-123");
  assert.equal(
    pdppCliNoInstallCommand("pdpp ref grant timeline grant-1"),
    "npx -y @pdpp/cli ref grant timeline grant-1"
  );
  assert.equal(pdppCliNoInstallCommand("pdpp ref trace show trace-1"), "npx -y @pdpp/cli ref trace show trace-1");
});

test("pdppCliNoInstallCommand returns null for non-pdpp commands", () => {
  assert.equal(pdppCliNoInstallCommand("ls -la"), null);
  assert.equal(pdppCliNoInstallCommand(""), null);
});

test("pdppCliCollectorEnrollCommand renders the canonical enroll form", () => {
  assert.equal(
    pdppCliCollectorEnrollCommand({ baseUrl: "http://127.0.0.1:7662", code: "abc-123" }),
    "npx -y @pdpp/local-collector enroll --base-url http://127.0.0.1:7662 --code abc-123"
  );
});

test("pdppCliCollectorEnrollCommand appends a quoted --device-label when provided", () => {
  assert.equal(
    pdppCliCollectorEnrollCommand({
      baseUrl: "https://ref.example.com",
      code: "code-1",
      deviceLabel: "the owner's laptop",
    }),
    'npx -y @pdpp/local-collector enroll --base-url https://ref.example.com --code code-1 --device-label "the owner\'s laptop"'
  );
});

test("pdppCliCollectorEnrollCommand ignores empty device labels", () => {
  assert.equal(
    pdppCliCollectorEnrollCommand({
      baseUrl: "https://ref.example.com",
      code: "code-1",
      deviceLabel: "   ",
    }),
    "npx -y @pdpp/local-collector enroll --base-url https://ref.example.com --code code-1"
  );
});

test("pdppCliCollectorRunCommand renders the canonical run form", () => {
  assert.equal(
    pdppCliCollectorRunCommand({ baseUrl: "http://127.0.0.1:7662", connectorId: "claude_code" }),
    "npx -y @pdpp/local-collector run --base-url http://127.0.0.1:7662 --connector claude_code"
  );
  assert.equal(
    pdppCliCollectorRunCommand({ baseUrl: "https://ref.example.com", connectorId: "codex" }),
    "npx -y @pdpp/local-collector run --base-url https://ref.example.com --connector codex"
  );
});

test("pdppCliMonorepoCommand wraps pdpp invocations with pnpm exec", () => {
  assert.equal(
    pdppCliMonorepoCommand("pdpp collector enroll --base-url http://x --code y"),
    "pnpm exec pdpp collector enroll --base-url http://x --code y"
  );
});

test("pdppCliMonorepoCommand returns null for non-pdpp commands", () => {
  assert.equal(pdppCliMonorepoCommand("ls -la"), null);
  assert.equal(pdppCliMonorepoCommand(""), null);
});
