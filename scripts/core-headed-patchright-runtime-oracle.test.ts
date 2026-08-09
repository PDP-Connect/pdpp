// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const CONNECTOR_HEADLESS_ENV_PATTERN = /PDPP_(?!BROWSER_HEADLESS\b)[A-Z0-9_]+_HEADLESS/u;

test("Core image packages the managed display, durable profile root, and full Chromium tree", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("deploy/docker/docker-compose.yml");

  assert.ok(dockerfile.includes("apt-get install -y --no-install-recommends xvfb"));
  assert.ok(dockerfile.includes("test -x /usr/bin/Xvfb"));
  assert.ok(dockerfile.includes("PDPP_RUNTIME_BROWSER=1"));
  assert.ok(dockerfile.includes("PDPP_BROWSER_PROFILE_ROOT=/var/lib/pdpp/browser-profiles"));
  // Durable connector artifacts (Slack archive, statement PDFs) must land on
  // the one documented volume. Anything outside /var/lib/pdpp is discarded on
  // container replacement — the defect that restarted the Slack sync from zero.
  assert.ok(dockerfile.includes("PDPP_CONNECTOR_ARTIFACT_ROOT=/var/lib/pdpp/connector-artifacts"));
  assert.ok(dockerfile.includes("chrome-linux64/chrome"));
  assert.ok(!dockerfile.includes("chromium_headless_shell"));
  const headlessOverride = ["PDPP_BROWSER_HEADLESS: $", "{PDPP_BROWSER_HEADLESS:-}"].join("");
  assert.ok(compose.includes(headlessOverride));
});

test("Core supervisor owns Xvfb lifecycle and keeps headless as the only browser-mode override", () => {
  const supervisor = read("deploy/railway/core-supervisor.ts");

  assert.ok(supervisor.includes('PDPP_BROWSER_HEADLESS === "1"'));
  assert.ok(supervisor.includes('start("xvfb", "Xvfb"'));
  assert.ok(supervisor.includes("waitForManagedDisplay"));
  assert.ok(supervisor.includes("childBaseEnv.DISPLAY = display"));
  assert.ok(supervisor.includes('PDPP_CORE_RUNTIME_ORACLE === "1"'));
  assert.ok(supervisor.includes("runtime-oracle"));
  assert.ok(supervisor.includes('other.kill("SIGTERM")'));
  assert.doesNotMatch(supervisor, CONNECTOR_HEADLESS_ENV_PATTERN);
});

test("production runtime oracle discriminates full Chromium, profile, CDP stream, cleanup, and restart", () => {
  const oracle = read("scripts/core-headed-patchright-runtime-oracle.ts");
  const wrapper = read("scripts/core-headed-patchright-runtime-oracle.sh");
  const launcher = read("packages/polyfill-connectors/src/browser-launch.ts");

  assert.ok(oracle.includes("PDPP_RUNTIME_BROWSER"));
  assert.ok(oracle.includes("HeadlessChrome"));
  assert.ok(oracle.includes("chrome-(?:linux64|linux)"));
  assert.ok(oracle.includes("PDPP_BROWSER_PROFILE_ROOT"));
  assert.ok(oracle.includes("DevToolsActivePort"));
  assert.ok(oracle.includes("prepareBrowserInteractionTarget"));
  assert.ok(oracle.includes("unregisterBrowserInteractionTarget"));
  assert.ok(oracle.includes("SingletonLock"));
  assert.ok(oracle.includes("localStorage"));
  assert.ok(oracle.includes("PDPP_CORE_RUNTIME_ORACLE_EXPECT_PERSISTED"));
  assert.ok(oracle.includes("registration_rejected"));
  assert.ok(oracle.includes("activeRegistrationPaths"));
  assert.ok(launcher.includes("resolveDeploymentBrowserHeadless"));
  assert.ok(wrapper.includes("docker run --rm"));
  assert.ok(wrapper.includes("PDPP_CORE_RUNTIME_ORACLE_EXPECT_PERSISTED=1"));
  assert.ok(wrapper.includes("docker ps -aq"));
});
