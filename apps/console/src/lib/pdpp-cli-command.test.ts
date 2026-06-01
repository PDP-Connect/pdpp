/**
 * Unit tests for the dashboard CLI invocation helpers. The dashboard
 * advertises a canonical `pdpp ref ...` command next to a zero-install
 * `npx -y @pdpp/cli@beta ref ...` fallback so users who haven't installed
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
  pdppLocalCollectorDoctorCommand,
  pdppLocalCollectorStatusCommand,
} from "./pdpp-cli-command.ts";

const NPX_CONNECT_PREFIX = /^npx -y @pdpp\/cli@beta connect /;
const QUEUE_FLAG = /--queue/;
const BASE_URL_FLAG = /--base-url/;
const DEVICE_TOKEN_FLAG = /--device-token/;
const HOST_PATH_ARG = /\s\/|~\//;

test("package info advertises the @pdpp/cli@beta specifier", () => {
  assert.equal(pdppCliPackageInfo.packageName, "@pdpp/cli");
  assert.equal(pdppCliPackageInfo.binName, "pdpp");
  assert.equal(pdppCliPackageInfo.packageSpecifier, "@pdpp/cli@beta");
});

test("connect command uses npx + package specifier", () => {
  assert.match(pdppCliConnectCommand, NPX_CONNECT_PREFIX);
});

test("connect command can be rendered for a concrete provider URL", () => {
  assert.equal(
    pdppCliConnectCommandFor("https://pdpp.vivid.fish"),
    "npx -y @pdpp/cli@beta connect https://pdpp.vivid.fish"
  );
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

test("pdppCliCollectorEnrollCommand renders the canonical enroll form", () => {
  assert.equal(
    pdppCliCollectorEnrollCommand({ baseUrl: "http://127.0.0.1:7662", code: "abc-123" }),
    "npx -y @pdpp/local-collector@beta enroll --base-url http://127.0.0.1:7662 --code abc-123"
  );
});

test("pdppCliCollectorEnrollCommand appends a quoted --device-label when provided", () => {
  assert.equal(
    pdppCliCollectorEnrollCommand({
      baseUrl: "https://ref.example.com",
      code: "code-1",
      deviceLabel: "the owner's laptop",
    }),
    'npx -y @pdpp/local-collector@beta enroll --base-url https://ref.example.com --code code-1 --device-label "the owner\'s laptop"'
  );
});

test("pdppCliCollectorEnrollCommand ignores empty device labels", () => {
  assert.equal(
    pdppCliCollectorEnrollCommand({
      baseUrl: "https://ref.example.com",
      code: "code-1",
      deviceLabel: "   ",
    }),
    "npx -y @pdpp/local-collector@beta enroll --base-url https://ref.example.com --code code-1"
  );
});

test("pdppCliCollectorRunCommand renders the canonical run form", () => {
  assert.equal(
    pdppCliCollectorRunCommand({ baseUrl: "http://127.0.0.1:7662", connectorId: "claude_code" }),
    "npx -y @pdpp/local-collector@beta run --base-url http://127.0.0.1:7662 --connector claude_code"
  );
  assert.equal(
    pdppCliCollectorRunCommand({ baseUrl: "https://ref.example.com", connectorId: "codex" }),
    "npx -y @pdpp/local-collector@beta run --base-url https://ref.example.com --connector codex"
  );
});

test("pdppLocalCollectorDoctorCommand renders a local-only doctor form with no base-url or secret", () => {
  assert.equal(pdppLocalCollectorDoctorCommand(), "npx -y @pdpp/local-collector@beta doctor");
});

test("pdppLocalCollectorDoctorCommand scopes to a connection id when one is known", () => {
  assert.equal(
    pdppLocalCollectorDoctorCommand({ connectionId: "claude_code:laptop" }),
    "npx -y @pdpp/local-collector@beta doctor --connection-id claude_code:laptop"
  );
});

test("pdppLocalCollectorDoctorCommand ignores blank connection ids", () => {
  assert.equal(pdppLocalCollectorDoctorCommand({ connectionId: "   " }), "npx -y @pdpp/local-collector@beta doctor");
  assert.equal(pdppLocalCollectorDoctorCommand({ connectionId: null }), "npx -y @pdpp/local-collector@beta doctor");
});

test("pdppLocalCollectorStatusCommand renders the status form", () => {
  assert.equal(pdppLocalCollectorStatusCommand(), "npx -y @pdpp/local-collector@beta status");
  assert.equal(
    pdppLocalCollectorStatusCommand({ connectionId: "codex:server" }),
    "npx -y @pdpp/local-collector@beta status --connection-id codex:server"
  );
});

test("local collector diagnostic commands never leak a filesystem path or base-url", () => {
  // The doctor/status commands run on the device that owns the data. They must
  // not embed a host-local queue path or the reference base URL — that would
  // leak device-local internals into a remotely-rendered command.
  for (const command of [
    pdppLocalCollectorDoctorCommand({ connectionId: "claude_code:laptop" }),
    pdppLocalCollectorStatusCommand({ connectionId: "claude_code:laptop" }),
  ]) {
    assert.doesNotMatch(command, QUEUE_FLAG);
    assert.doesNotMatch(command, BASE_URL_FLAG);
    assert.doesNotMatch(command, DEVICE_TOKEN_FLAG);
    // The only legitimate `/` is inside the npm package specifier; no path
    // argument (absolute or `~/`) should appear.
    assert.doesNotMatch(command, HOST_PATH_ARG, "no host filesystem path arguments");
  }
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
