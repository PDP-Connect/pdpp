// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-environment detection helpers used by the connector runtime
 * to make container-aware routing decisions.
 *
 * The current consumer is `acquireBrowserForConnector` in
 * `browser-launch.ts`: when the connector runs inside a container AND
 * requests a headed browser, the runtime must fail closed if no host
 * browser bridge is configured. Launching an invisible in-container
 * Chromium is the silent-failure path we explicitly want to avoid (an
 * interactive connector — Cloudflare/OTP — would block on an
 * `auto-login` INTERACTION handshake forever with no operator-visible
 * signal).
 *
 * Spec reference:
 *   openspec/changes/design-host-browser-bridge-for-docker/design.md
 *     § "Failure Mode When Unavailable" requires Docker runs to fail
 *     fast rather than launch an invisible headed browser.
 *
 * Detection signals (any one is sufficient):
 *
 *   1. `/.dockerenv` exists — Docker writes this sentinel inside every
 *      container image. Catches Compose runs, plain `docker run`, and
 *      Podman in Docker-compat mode.
 *
 *   2. `PDPP_FORCE_CONTAINER` — explicit override for tests or for
 *      Kubernetes/non-Docker container runtimes that don't set
 *      `/.dockerenv`. Set to "1" to count as in-container.
 *
 * Historical note: an earlier version also treated
 * `PDPP_REFERENCE_MODE=composed` as a container signal, on the
 * assumption that composed mode was only set inside Docker compose. That
 * assumption became stale once host-side dev scripts adopted composed
 * mode for single-origin development against a Next.js BFF. The signals
 * are now disjoint: `PDPP_REFERENCE_MODE` describes the *origin layout*
 * (one composed origin vs. direct AS/RS ports), and the container
 * detector consults only signals that are about the actual runtime
 * environment.
 *
 * The detector is biased toward false-positive (declares "in container"
 * when uncertain) only when at least one signal is present. An untouched
 * host process won't match any signal and will keep the existing
 * host-direct behavior.
 */

import { existsSync } from "node:fs";

const DOCKER_ENV_SENTINEL = "/.dockerenv";

export interface ContainerDetectionEnv {
  PDPP_FORCE_CONTAINER?: string;
}

export interface ContainerDetectionDeps {
  fileExists?: (path: string) => boolean;
}

function readFlag(value: string | undefined, expected: string): boolean {
  if (value === undefined) {
    return false;
  }
  return value.trim() === expected;
}

/**
 * Returns true when the current process appears to be running inside a
 * container. Pure: no I/O is performed beyond an `existsSync` against a
 * known sentinel path; tests can inject `fileExists` to control the
 * outcome deterministically without touching the host filesystem.
 */
export function isRunningInContainer(
  env: NodeJS.ProcessEnv | ContainerDetectionEnv = process.env,
  deps: ContainerDetectionDeps = {}
): boolean {
  if (readFlag(env.PDPP_FORCE_CONTAINER, "1")) {
    return true;
  }
  const fileExists = deps.fileExists ?? existsSync;
  try {
    return fileExists(DOCKER_ENV_SENTINEL);
  } catch {
    // existsSync is documented as never throwing, but a wrapped fs in
    // tests might. Treat any error as "not detected" rather than
    // claiming we are in a container.
    return false;
  }
}
