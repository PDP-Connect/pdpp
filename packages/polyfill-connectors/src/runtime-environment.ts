/**
 * Runtime-environment detection helpers used by the connector runtime
 * to make container-aware routing decisions.
 *
 * The current consumer is `acquireBrowserForConnector` in
 * `browser-launch.ts`: when the connector runs inside a container AND
 * requests a browser, the runtime must fail closed if no host browser
 * bridge is configured. Launching an invisible in-container Chromium is
 * the silent-failure path we explicitly want to avoid (an interactive
 * connector — Cloudflare/OTP — would block on an `auto-login`
 * INTERACTION handshake forever with no operator-visible signal).
 *
 * Spec reference:
 *   openspec/changes/design-host-browser-bridge-for-docker/design.md
 *     § "Failure Mode When Unavailable" requires Docker runs to fail
 *     fast rather than launch an invisible headed browser.
 *
 * Detection signals (any one is sufficient):
 *
 *   1. `PDPP_REFERENCE_MODE === "composed"` — the dev/prod compose
 *      stacks export this from `docker-compose.yml`. This is the
 *      authoritative signal: a developer running `node --watch` outside
 *      Docker will not have it set.
 *
 *   2. `/.dockerenv` exists — Docker writes this sentinel inside every
 *      container image. Catches Compose runs that happened to omit the
 *      MODE env, plain `docker run`, and Podman in Docker-compat mode.
 *
 *   3. `PDPP_FORCE_CONTAINER` — explicit override for tests or for
 *      Kubernetes/non-Docker container runtimes that don't set
 *      `/.dockerenv`. Set to "1" to count as in-container.
 *
 * The detector is intentionally biased toward false-positive (declares
 * "in container" when uncertain) only when at least one signal is
 * present. An untouched host process won't match any signal and will
 * keep the existing host-direct behavior.
 */

import { existsSync } from "node:fs";

const DOCKER_ENV_SENTINEL = "/.dockerenv";

export interface ContainerDetectionEnv {
  PDPP_FORCE_CONTAINER?: string;
  PDPP_REFERENCE_MODE?: string;
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
  if (readFlag(env.PDPP_REFERENCE_MODE, "composed")) {
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
