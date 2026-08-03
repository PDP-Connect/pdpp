// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fail-closed check: refuse to attempt a live friend-journey run when the
// release artifacts it depends on are missing. This is a pure/offline check
// (no docker, no network) — it inspects the repo's own committed release
// surface, the same one deploy/docker/README.md documents as the blessed
// self-service path.
//
// Modeled on release-package-matrix.ts's snapshot/receipt approach and
// scripts/docker-smoke.sh's fail-loud posture: a missing compose file, a
// Dockerfile without the required build targets, or (for the browser
// profile) a missing browser-capable target must produce a named, actionable
// finding — never a silent skip that looks like a pass.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ReleaseArtifactFinding {
  detail: string;
  id: string;
  ok: boolean;
}

export interface ReleaseArtifactCheckResult {
  findings: ReleaseArtifactFinding[];
  ok: boolean;
}

const REQUIRED_DOCKERFILE_TARGETS = ["reference", "console"];
const BROWSER_DOCKERFILE_TARGET = "core-browser";

/**
 * Check that the blessed self-service Compose file and the Dockerfile
 * targets it builds actually exist in this checkout. Does not build or run
 * anything — a structural, offline check.
 */
export function checkReleaseArtifacts(repoRoot: string): ReleaseArtifactCheckResult {
  const findings: ReleaseArtifactFinding[] = [];

  const composePath = join(repoRoot, "deploy", "docker", "docker-compose.yml");
  const composeExists = existsSync(composePath);
  findings.push({
    id: "compose-file-present",
    ok: composeExists,
    detail: composeExists
      ? `found ${composePath}`
      : `missing ${composePath} — the blessed self-service Compose stack is not present in this checkout`,
  });

  const dockerfilePath = join(repoRoot, "Dockerfile");
  const dockerfileExists = existsSync(dockerfilePath);
  findings.push({
    id: "dockerfile-present",
    ok: dockerfileExists,
    detail: dockerfileExists ? `found ${dockerfilePath}` : `missing ${dockerfilePath}`,
  });

  if (dockerfileExists) {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    for (const target of REQUIRED_DOCKERFILE_TARGETS) {
      const hasTarget = new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${target}\\b`, "im").test(dockerfile);
      findings.push({
        id: `dockerfile-target-${target}`,
        ok: hasTarget,
        detail: hasTarget
          ? `Dockerfile declares build target '${target}'`
          : `Dockerfile is missing required build target '${target}' — the composed reference/console images cannot be built`,
      });
    }
    const hasBrowserTarget = new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${BROWSER_DOCKERFILE_TARGET}\\b`, "im").test(
      dockerfile
    );
    findings.push({
      id: "dockerfile-target-core-browser",
      ok: hasBrowserTarget,
      detail: hasBrowserTarget
        ? "Dockerfile declares the browser-capable 'core-browser' build target"
        : "Dockerfile is missing the 'core-browser' build target — the ChatGPT/browser-backed journey step will be structurally skipped (browser_runtime_unavailable), not attempted live",
    });
  }

  return { findings, ok: findings.every((f) => f.ok) };
}
