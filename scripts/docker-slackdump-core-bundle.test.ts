// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Integration test: verify default core Docker image includes slackdump v4.4.2.
// Builds the core target once, then inspects the image for proof of bundled slackdump.
//
// Rationale: Slack connector is declared as "background_safe" only if slackdump
// is present. This test ensures the default deployment image actually works.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const DOCKER_CMD = "docker";
const DOCKERFILE_PATH = "./Dockerfile";
const CORE_IMAGE_TAG = "pdpp:test-core-slackdump";

// Check Docker availability before running.
function isDockerAvailable(): boolean {
  try {
    execFileSync(DOCKER_CMD, ["--version"], { timeout: 2000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skipIfNoDocker = isDockerAvailable() ? test : test.skip;

skipIfNoDocker("Build and inspect core image with slackdump", async (t) => {
  t.diagnostic("Building core Docker image (single build, then multiple inspections)...");

  // Build the core image once. This is the actual production image.
  try {
    execFileSync(DOCKER_CMD, [
      "build",
      "--target",
      "core",
      "-t",
      CORE_IMAGE_TAG,
      "-f",
      DOCKERFILE_PATH,
      ".",
    ]);
    t.diagnostic("core image built successfully");
  } catch (err) {
    t.diagnostic(`Build failed: ${err}`);
    throw err;
  }

  // Test 1: slackdump binary exists and is executable
  t.test("slackdump binary is executable", async () => {
    try {
      execFileSync(DOCKER_CMD, [
        "run",
        "--rm",
        CORE_IMAGE_TAG,
        "test",
        "-x",
        "/usr/local/bin/slackdump",
      ]);
      t.diagnostic("slackdump binary found at /usr/local/bin/slackdump");
    } catch (err) {
      throw new Error(`slackdump binary check failed: ${err}`);
    }
  });

  // Test 2: slackdump version check passes
  t.test("slackdump version returns success", async () => {
    try {
      const output = execFileSync(DOCKER_CMD, [
        "run",
        "--rm",
        CORE_IMAGE_TAG,
        "slackdump",
        "version",
      ], { encoding: "utf8" });

      assert(
        output.match(/v4\.\d+\.\d+/),
        `slackdump version output should contain v4.x.y; got: ${output.trim()}`
      );
      t.diagnostic(`slackdump version: ${output.trim()}`);
    } catch (err) {
      throw new Error(`slackdump version check failed: ${err}`);
    }
  });

  // Test 3: AGPL-3.0 license file is present
  t.test("AGPL-3.0 license file present", async () => {
    try {
      const licenseText = execFileSync(DOCKER_CMD, [
        "run",
        "--rm",
        CORE_IMAGE_TAG,
        "head",
        "-1",
        "/usr/local/share/slackdump/LICENSE.agpl-3.0.txt",
      ], { encoding: "utf8" });

      assert(licenseText.length > 0, "License file should have content");
      t.diagnostic(`License header: ${licenseText.trim().substring(0, 60)}...`);
    } catch (err) {
      throw new Error(`License file check failed: ${err}`);
    }
  });

  // Test 4: Upstream source URL reference is preserved
  t.test("Upstream source URL reference preserved", async () => {
    try {
      const sourceUrl = execFileSync(DOCKER_CMD, [
        "run",
        "--rm",
        CORE_IMAGE_TAG,
        "cat",
        "/usr/local/share/slackdump/SOURCE_URL",
      ], { encoding: "utf8" });

      assert(
        sourceUrl.includes("github.com/rusq/slackdump"),
        "SOURCE_URL should reference upstream repository"
      );
      t.diagnostic(`Source URL: ${sourceUrl.trim()}`);
    } catch (err) {
      throw new Error(`Source URL check failed: ${err}`);
    }
  });

  // Test 5: Image layer size sanity check (not bloated with build deps)
  t.test("Image size is reasonable (no build bloat)", async () => {
    try {
      const sizeOutput = execFileSync(DOCKER_CMD, [
        "image",
        "inspect",
        CORE_IMAGE_TAG,
        "--format={{.Size}}",
      ], { encoding: "utf8" });

      const sizeBytes = parseInt(sizeOutput.trim());
      const sizeMB = sizeBytes / (1024 * 1024);

      // Core is ~800MB (Node + browsers), +40-50MB for slackdump = ~850-900MB max
      // If it's >1.2GB, something went wrong (e.g., Go toolchain leaked)
      assert(
        sizeMB < 1200,
        `Image size should be <1200MB; got ${sizeMB.toFixed(1)}MB (possible build bloat)`
      );
      t.diagnostic(`Image size: ${sizeMB.toFixed(1)}MB`);
    } catch (err) {
      throw new Error(`Image size check failed: ${err}`);
    }
  });
});
