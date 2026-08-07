// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Integration test: verify default core Docker image includes slackdump v4.4.2.
// Builds the core target once, then inspects the image for proof of bundled slackdump.
//
// Rationale: Slack connector is declared as "background_safe" only if slackdump
// is present. This test ensures the default deployment image actually includes it.

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

  // Sequential assertions: all must complete before parent test finishes
  // (avoid early exit that leaves subtests orphaned)

  // Test 1: slackdump binary exists and is executable
  await t.test("slackdump binary is executable", () => {
    try {
      execFileSync(DOCKER_CMD, [
        "run",
        "--rm",
        CORE_IMAGE_TAG,
        "test",
        "-x",
        "/usr/local/bin/slackdump",
      ]);
      t.diagnostic("✓ slackdump binary found at /usr/local/bin/slackdump");
    } catch (err) {
      throw new Error(`slackdump binary check failed: ${err}`);
    }
  });

  // Test 2: slackdump version check passes
  await t.test("slackdump version returns success", () => {
    try {
      const output = execFileSync(DOCKER_CMD, [
        "run",
        "--rm",
        CORE_IMAGE_TAG,
        "slackdump",
        "version",
      ], { encoding: "utf8" });

      assert(
        output.includes("Slackdump") && output.match(/4\.4\.\d+/),
        `slackdump version output should contain Slackdump 4.4.x; got: ${output.trim()}`
      );
      const versionMatch = output.match(/Slackdump [\d.]+/);
      t.diagnostic(`✓ slackdump version: ${versionMatch ? versionMatch[0] : "unknown"}`);
    } catch (err) {
      throw new Error(`slackdump version check failed: ${err}`);
    }
  });

  // Test 3: AGPL-3.0 license file is present
  await t.test("AGPL-3.0 license file present", () => {
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
      assert(
        licenseText.includes("GNU AFFERO") || licenseText.includes("AGPL"),
        "License should reference AGPL"
      );
      t.diagnostic("✓ AGPL-3.0 license file present");
    } catch (err) {
      throw new Error(`License file check failed: ${err}`);
    }
  });

  // Test 4: Upstream source URL reference is exact and valid
  // AGPL section 6(d): Corresponding Source must be resolvable tree/archive URL
  await t.test("Upstream source URL reference exact and resolvable", () => {
    try {
      const sourceUrl = execFileSync(DOCKER_CMD, [
        "run",
        "--rm",
        CORE_IMAGE_TAG,
        "cat",
        "/usr/local/share/slackdump/SOURCE_URL",
      ], { encoding: "utf8" }).trim();

      const expectedUrl = "https://github.com/rusq/slackdump/tree/v4.4.2";
      assert(
        sourceUrl === expectedUrl,
        `SOURCE_URL must be exact versioned tree URL; expected ${expectedUrl}, got ${sourceUrl}`
      );
      t.diagnostic(`✓ Upstream source URL: ${sourceUrl}`);
    } catch (err) {
      throw new Error(`Source URL check failed: ${err}`);
    }
  });

  // Test 5: No Go toolchain in final image (builder-specific tool)
  await t.test("Go toolchain not present in final image", () => {
    try {
      try {
        execFileSync(DOCKER_CMD, [
          "run",
          "--rm",
          CORE_IMAGE_TAG,
          "which",
          "go",
        ]);
        // If go is found, that's a failure (builder bloat)
        throw new Error("go toolchain found in final image (builder bloat detected)");
      } catch (err) {
        // Expected: go should NOT be found
        if (err.message.includes("builder bloat")) throw err;
        // Good: go not found, as expected
      }

      t.diagnostic("✓ Go toolchain (builder-only) not present in final image");
    } catch (err) {
      throw new Error(`Builder bloat check failed: ${err}`);
    }
  });

  // Test 6: Record measured image size for evidence
  await t.test("Record image size for delta measurement", () => {
    try {
      const sizeOutput = execFileSync(DOCKER_CMD, [
        "image",
        "inspect",
        CORE_IMAGE_TAG,
        "--format={{.Size}}",
      ], { encoding: "utf8" });

      const sizeBytes = parseInt(sizeOutput.trim());
      const sizeMB = sizeBytes / (1024 * 1024);

      t.diagnostic(`✓ Measured image size: ${sizeMB.toFixed(1)}MB`);
      t.diagnostic("  Evidence: delta tracks slackdump binary bundle cost");
    } catch (err) {
      throw new Error(`Image size measurement failed: ${err}`);
    }
  });
});
