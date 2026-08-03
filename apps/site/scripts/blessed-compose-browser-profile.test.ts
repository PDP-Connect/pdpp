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
const MANAGED_CONNECTORS_GUARD_RE = /\$\{PDPP_NEKO_MANAGED_CONNECTORS:\+/;
const NEKO_SERVICE_RE = /^ {2}neko:$/m;
const BROWSER_PROFILE_RE = /profiles: \["browser"\]/;
const SECOND_COMPOSE_FILE_RE = /docker-compose\.neko\.yml/;
const TOP_LEVEL_SERVICE_RE = /^ {2}\S/m;
const HOST_PORT_RE = /^\s+ports:/m;
const SHM_SIZE_RE = /shm_size: 2gb/;
const PROFILE_MOUNT_RE = /^\s+- pdpp-neko-profile:\/home\/user\/\.config\/chromium$/m;
const PROFILE_VOLUME_RE = /^volumes:\n(?:.*\n)*?\s+pdpp-neko-profile:\s*$/m;
const DYNAMIC_PROFILE_ROOT_RE = /PDPP_NEKO_PROFILE_STORAGE_ROOT/;
const DYNAMIC_PROFILE_PATH_RE = /\/var\/lib\/pdpp\/neko-profiles/;
const PUBLISHED_WEB_PORT_RE = /^\s*-\s*"\$\{PDPP_WEB_PORT/;
const PORTS_BLOCK_RE = /^\s+ports:$/gm;

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

function compose(): Promise<string> {
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
      MANAGED_CONNECTORS_GUARD_RE,
      `${name} must default through \${PDPP_NEKO_MANAGED_CONNECTORS:+...} so a network-only node reports no browser surface`
    );
  }
});

test("the browser surface is an opt-in profile on the same canonical stack", async () => {
  const src = await compose();
  assert.match(src, NEKO_SERVICE_RE, "the blessed stack must define the n.eko service itself");
  assert.match(src, BROWSER_PROFILE_RE, "n.eko must be profile-gated so the default stack stays network-only");
  // One canonical route: no second compose file, no clone-and-build path.
  assert.doesNotMatch(src, SECOND_COMPOSE_FILE_RE, "the blessed stack must not defer to a second compose file");
});

function nekoServiceBody(src: string): string {
  const lines = src.split("\n");
  const start = lines.indexOf("  neko:");
  assert.ok(start >= 0, "the n.eko service must be declared");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => TOP_LEVEL_SERVICE_RE.test(line) && line.trimEnd().endsWith(":") && !line.startsWith("    ")
  );
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

test("the browser surface is not published to the host", async () => {
  const src = await compose();
  // Take the lines from `  neko:` up to the next top-level key (another
  // service, or the `volumes:` block).
  const body = nekoServiceBody(src);
  // Only the console is published. A reachable browser surface on the host
  // would be an unauthenticated remote-control port.
  assert.doesNotMatch(body, HOST_PORT_RE, "the n.eko service must not publish a host port");
  assert.match(body, SHM_SIZE_RE, "Chromium needs more than Docker's default 64MB of shared memory");
});

test("the browser surface's Chromium profile is backed by a project-scoped named volume", async () => {
  const src = await compose();
  const body = nekoServiceBody(src);
  // Chromium's user-data-dir (start-chromium.sh:
  // --user-data-dir=/home/user/.config/chromium) must be backed by a volume
  // that outlives container recreation (`down`+`up`, an image rebuild, the
  // documented `docker compose pull && docker compose up -d` upgrade path),
  // or sign-in state for every browser-backed connector is silently lost on
  // the next recreate.
  assert.match(
    body,
    PROFILE_MOUNT_RE,
    "the n.eko service must mount a named volume over Chromium's user-data-dir so profile/auth state survives container recreation"
  );
  assert.match(
    src,
    PROFILE_VOLUME_RE,
    "pdpp-neko-profile must be declared as a top-level (project-scoped) named volume, not a host bind or an inline anonymous volume"
  );
});

test("the browser-profile volume name does not collide with the dynamic allocator's host-bind path", async () => {
  const src = await compose();
  // The dynamic allocator (docker-compose.neko.yml, driven by
  // scripts/reference-stack.sh) persists profiles via a HOST BIND at
  // PDPP_NEKO_PROFILE_STORAGE_ROOT (default /var/lib/pdpp/neko-profiles),
  // scoped per allocated surface — a completely different mechanism from
  // this file's single named volume for the one static browser service.
  // Neither the volume name nor its mount source may reference that path,
  // or the two isolation mechanisms could be confused or made to collide.
  assert.doesNotMatch(
    src,
    DYNAMIC_PROFILE_ROOT_RE,
    "the blessed self-service stack must not reference the dynamic allocator's host-bind profile-storage variable"
  );
  assert.doesNotMatch(
    src,
    DYNAMIC_PROFILE_PATH_RE,
    "the blessed self-service stack must not reuse the dynamic allocator's host-bind profile-storage path"
  );
});

test("enabling the browser profile does not change the published web port", async () => {
  const src = await compose();
  // Regression guard: the profile-storage volume added to the neko service
  // must not have moved/duplicated the one host-published port declaration
  // (web:3000), and no second `ports:` entry should appear stack-wide.
  const portLines = src.split("\n").filter((line) => PUBLISHED_WEB_PORT_RE.test(line));
  assert.equal(portLines.length, 1, "exactly one published port mapping (web) must exist in the blessed stack");
  const allPortsBlocks = src.match(PORTS_BLOCK_RE) ?? [];
  assert.equal(allPortsBlocks.length, 1, "exactly one service (web) may declare a ports: block in the blessed stack");
});
