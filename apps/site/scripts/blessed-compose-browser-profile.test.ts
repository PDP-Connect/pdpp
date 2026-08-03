// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The blessed self-service stack must stay ONE canonical route: a network-only
 * node by default, and the same file plus `--profile browser` when the owner
 * wants browser-backed sources.
 *
 * The load-bearing invariant is subtler than "does the profile exist". The
 * runtime treats a PRESENT `PDPP_NEKO_CDP_HTTP_URL` as proof that this
 * deployment has a browser surface. Defaulting the n.eko wiring
 * unconditionally therefore makes a node with no n.eko container claim a
 * surface it does not have — and a browser-backed source is then accepted at
 * setup and fails on the first sync, which is the exact trap the setup guard
 * exists to prevent. That regression was introduced once and caught only by
 * running the stack, so it is pinned here.
 *
 * These assertions read the compose file directly rather than shelling out to
 * `docker compose config`, so they run anywhere.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BLESSED_COMPOSE = new URL("../../../deploy/docker/docker-compose.yml", import.meta.url);

// Every n.eko variable that, if non-empty, would make the runtime believe a
// browser surface exists or force it into a surface-requiring mode.
const SURFACE_IMPLYING_VARS = [
  "PDPP_NEKO_BASE_URL",
  "PDPP_NEKO_CDP_HTTP_URL",
  "PDPP_NEKO_WINDOW_SETTLE_URL",
  "PDPP_NEKO_PROXY_ALLOWED_HOSTS",
  "PDPP_NEKO_SURFACE_MODE",
  "PDPP_NEKO_SURFACE_CAP",
  "PDPP_NEKO_BROWSER_OWNER_MODE",
] as const;

async function compose(): Promise<string> {
  return readFile(fileURLToPath(BLESSED_COMPOSE), "utf8");
}

test("n.eko wiring defaults are gated on the managed-connector list", async () => {
  const src = await compose();
  for (const name of SURFACE_IMPLYING_VARS) {
    const line = src.split("\n").find((candidate) => candidate.trim().startsWith(`${name}:`));
    assert.ok(line, `${name} must be declared on the reference service`);
    // `${PDPP_NEKO_MANAGED_CONNECTORS:+...}` expands only when the owner has
    // opted in. Without that guard the value is always present and the node
    // claims a browser surface it may not have.
    assert.match(
      line,
      /\$\{PDPP_NEKO_MANAGED_CONNECTORS:\+/,
      `${name} must default through \${PDPP_NEKO_MANAGED_CONNECTORS:+...} so a network-only node reports no browser surface`
    );
  }
});

test("the browser surface is an opt-in profile on the same canonical stack", async () => {
  const src = await compose();
  assert.match(src, /^ {2}neko:$/m, "the blessed stack must define the n.eko service itself");
  assert.match(src, /profiles: \["browser"\]/, "n.eko must be profile-gated so the default stack stays network-only");
  // One canonical route: no second compose file, no clone-and-build path.
  assert.doesNotMatch(src, /docker-compose\.neko\.yml/, "the blessed stack must not defer to a second compose file");
});

test("the browser surface is not published to the host", async () => {
  const src = await compose();
  // Take the lines from `  neko:` up to the next top-level key (another
  // service, or the `volumes:` block).
  const lines = src.split("\n");
  const start = lines.findIndex((line) => line === "  neko:");
  assert.ok(start >= 0, "the n.eko service must be declared");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line) && line.trimEnd().endsWith(":") && !line.startsWith("    "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n");
  // Only the console is published. A reachable browser surface on the host
  // would be an unauthenticated remote-control port.
  assert.doesNotMatch(body, /^\s+ports:/m, "the n.eko service must not publish a host port");
  assert.match(body, /shm_size: 2gb/, "Chromium needs more than Docker's default 64MB of shared memory");
});
