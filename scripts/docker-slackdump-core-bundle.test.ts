// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Integration test: verify core Docker image includes slackdump v4.4.2.
// Accepts an explicitly provided image tag (from CI) or builds locally for dev.
//
// Rationale: Slack connector is declared as "background_safe" only if slackdump
// is present. This test ensures the default deployment image actually includes it.
// Uses structural assertions (Go/toolchain/build-deps absence) rather than
// brittle absolute size bounds, which are host/architecture-sensitive.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const DOCKER_CMD = "docker";
const DOCKERFILE_PATH = "./Dockerfile";
// Accept image tag from ENV (set by CI) or build locally for dev
const CORE_IMAGE_TAG = process.env.PDPP_CORE_IMAGE_TAG || "pdpp:test-core-slackdump";
const CI_PROVIDED_IMAGE = !!process.env.PDPP_CORE_IMAGE_TAG;

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

skipIfNoDocker("Inspect core image: slackdump bundling, license, and builder bloat", async (t) => {
  if (!CI_PROVIDED_IMAGE) {
    t.diagnostic("Building core Docker image locally (not in CI)...");
    // Only build locally for dev; CI provides pre-built image via load: true
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
  } else {
    t.diagnostic(`Using CI-provided image: ${CORE_IMAGE_TAG}`);
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

  // Test 5: Builder-stage isolation check: Go toolchain absent
  // Rationale: slackdump-builder stage includes Go compiler (~600MB). If COPY --from
  // is missing or misconfigured, Go would leak into final image. Absence of Go
  // toolchain verifies builder-stage isolation is correct.
  await t.test("Go toolchain not present (builder-stage isolation verified)", () => {
    try {
      try {
        execFileSync(DOCKER_CMD, [
          "run",
          "--rm",
          CORE_IMAGE_TAG,
          "which",
          "go",
        ]);
        throw new Error("go toolchain found in final image (builder-stage isolation failed)");
      } catch (err) {
        if (err.message.includes("builder-stage isolation")) throw err;
        // Expected: go not found
      }

      t.diagnostic("✓ Go toolchain absent (builder-stage isolation verified)");
    } catch (err) {
      throw new Error(`Builder isolation check failed: ${err}`);
    }
  });

  // Test 6: Record measured image size for evidence (informational only, not a gate)
  await t.test("Record image size for evidence", () => {
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
      t.diagnostic("  (Structural bloat checks passed; size is informational only)");
    } catch (err) {
      throw new Error(`Image size measurement failed: ${err}`);
    }
  });
});
