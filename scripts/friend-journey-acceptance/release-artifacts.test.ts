// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkReleaseArtifacts } from "./release-artifacts.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("checkReleaseArtifacts passes closed against the real checkout's release surface", () => {
  const result = checkReleaseArtifacts(REPO_ROOT);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  const ids = result.findings.map((f) => f.id);
  assert.ok(ids.includes("compose-file-present"));
  assert.ok(ids.includes("dockerfile-present"));
  assert.ok(ids.includes("dockerfile-target-reference"));
  assert.ok(ids.includes("dockerfile-target-console"));
  assert.ok(ids.includes("dockerfile-target-core-browser"));
});

test("checkReleaseArtifacts fails closed when the repo root has no compose file or Dockerfile", () => {
  const result = checkReleaseArtifacts("/nonexistent-friend-e2e-repo-root");
  assert.equal(result.ok, false);
  const compose = result.findings.find((f) => f.id === "compose-file-present");
  assert.equal(compose?.ok, false);
  const dockerfile = result.findings.find((f) => f.id === "dockerfile-present");
  assert.equal(dockerfile?.ok, false);
  // No Dockerfile-target findings should be emitted when the Dockerfile itself is missing.
  assert.equal(
    result.findings.some((f) => f.id.startsWith("dockerfile-target-")),
    false
  );
});
