/**
 * Unit tests for the dashboard CLI invocation helpers. The dashboard
 * advertises a canonical `pdpp ref ...` command next to a zero-install
 * `npx -y @pdpp/cli@beta ref ...` fallback so users who haven't installed
 * the binary still have a runnable form.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  pdppCliConnectCommand,
  pdppCliInstallCommand,
  pdppCliNoInstallCommand,
  pdppCliPackageInfo,
} from "./pdpp-cli-command.ts";

const NPX_CONNECT_PREFIX = /^npx -y @pdpp\/cli@beta connect /;

test("package info advertises the @pdpp/cli@beta specifier", () => {
  assert.equal(pdppCliPackageInfo.packageName, "@pdpp/cli");
  assert.equal(pdppCliPackageInfo.binName, "pdpp");
  assert.equal(pdppCliPackageInfo.packageSpecifier, "@pdpp/cli@beta");
});

test("connect command uses npx + package specifier", () => {
  assert.match(pdppCliConnectCommand, NPX_CONNECT_PREFIX);
});

test("install command uses npx + --help", () => {
  assert.equal(pdppCliInstallCommand, "npx -y @pdpp/cli@beta --help");
});

test("pdppCliNoInstallCommand rewrites pdpp ref invocations to npx form", () => {
  assert.equal(
    pdppCliNoInstallCommand("pdpp ref run timeline abc-123"),
    "npx -y @pdpp/cli@beta ref run timeline abc-123"
  );
  assert.equal(
    pdppCliNoInstallCommand("pdpp ref grant timeline grant-1"),
    "npx -y @pdpp/cli@beta ref grant timeline grant-1"
  );
  assert.equal(pdppCliNoInstallCommand("pdpp ref trace show trace-1"), "npx -y @pdpp/cli@beta ref trace show trace-1");
});

test("pdppCliNoInstallCommand returns null for non-pdpp commands", () => {
  assert.equal(pdppCliNoInstallCommand("ls -la"), null);
  assert.equal(pdppCliNoInstallCommand(""), null);
});
