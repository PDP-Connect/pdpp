// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type TestContext, test } from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import type { BrowserSurface, BrowserSurfaceAllocator } from "@opendatalabs/remote-surface/leases";

const REGEXP_1 = /run\.stream_session_opened/;
const REGEXP_2 = /run\.stream_session_resolved/;
const REGEXP_3 = /@opendatalabs\/remote-surface/;
const REGEXP_4 = /@opendatalabs\/remote-surface/;
const REGEXP_5 = /@opendatalabs\/remote-surface/;
const REGEXP_6 = /streaming-target/;
const REGEXP_7 = /resolveStreamingRegistrationFromEnv/;
const REGEXP_8 = /PDPP_STREAMING_REGISTRATION_TOKEN/;
const REGEXP_9 = /neko:/;
const REGEXP_10 = /docker|container/i;
const REGEXP_11 = /from ['"]@opendatalabs\/remote-surface\/leases['"]/;
const REGEXP_12 = /from ['"]\.\/protocol-wire\.ts['"]/;
const REGEXP_13 = /@opendatalabs\/remote-surface/;
const REGEXP_14 = /\/_ref\/runs\/:runId\/run-interaction-stream/;
const REGEXP_15 = /from ['"]@opendatalabs\/remote-surface\/server['"]/;
const REGEXP_16 = /\/_ref\/run-interaction-streams\/:token\/events/;
const REGEXP_17 = /object: ["']run_interaction_stream_session["']/;
const REGEXP_18 = /run\.stream_session_requested/;

type LeasesModule = typeof import("@opendatalabs/remote-surface/leases");

function read(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

// @opendatalabs/remote-surface is an OPTIONAL dependency (see
// runtime/browser-surface/remote-surface-optional.ts). Assertions that inspect
// the consumer wiring only make sense when it is installed; skip them cleanly
// when it is absent, matching the shim's degrade-not-crash semantics. Boundary
// assertions that verify PDPP-owned ownership need no dependency and always run.
//
// The package is ESM-only (exports declares only "import"/"types" conditions,
// no "require"), so require.resolve() always throws here regardless of
// whether the package is installed — that false-negative silently skipped
// the one real package-consumer assertion below in every environment,
// including CI. Use dynamic import() instead, which resolves the same
// exports map require.resolve() cannot.
async function remoteSurfaceInstalled() {
  try {
    // biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
    await import("@opendatalabs/remote-surface/leases");
    return true;
  } catch {
    return false;
  }
}

function retainedIdleSurface(overrides: Partial<BrowserSurface> = {}): BrowserSurface {
  return {
    backend: "neko",
    cdp_url: "http://neko:9222",
    connector_id: "retained-connector",
    created_at: "2026-07-22T12:00:00.000Z",
    health: "ready",
    last_used_at: "2026-07-22T12:00:00.000Z",
    profile_key: "retained-profile",
    retained: true,
    stream_base_url: "http://neko:8080",
    surface_id: "retained_surface",
    ...overrides,
  };
}

async function loadLeaseManager(t: TestContext): Promise<LeasesModule | null> {
  try {
    // biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
    return await import("@opendatalabs/remote-surface/leases");
  } catch {
    t.skip("@opendatalabs/remote-surface not installed; skipping installed-package retention assertion");
    return null;
  }
}

function createRetainedSurfaceManager(leases: LeasesModule) {
  return new leases.BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 60_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set(["retained-connector", "background-connector"]),
      priorityRanks: leases.DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceCap: 1,
      surfaceMode: "dynamic",
    },
    initialSurfaces: [retainedIdleSurface()],
    now: () => new Date("2026-07-22T12:10:00.000Z"),
  });
}

test("reference streaming routes adapt package session APIs while owning the PDPP wire shape and preserving _ref ownership", () => {
  const sessionsShim = read("reference-implementation/server/streaming/sessions.ts");
  const routes = read("reference-implementation/server/streaming/routes.ts");
  const protocolWire = read("reference-implementation/server/streaming/protocol-wire.ts");

  // The package's SESSION store is still consumed through the sessions shim,
  // which translates the host-neutral package API into the reference's
  // snake_case (_ref/run_id/interaction_id) contract.
  assert.match(sessionsShim, REGEXP_15);

  // Post-extraction the package's protocol export dropped its PDPP-shaped wire
  // parsers (they were host-specific). PDPP now OWNS its wire shapes locally in
  // protocol-wire.ts, and routes.ts consumes that local module — not the
  // package protocol. protocol-wire.ts must not reach back into the package.
  assert.match(routes, REGEXP_12);
  assert.doesNotMatch(protocolWire, REGEXP_13, "protocol-wire.ts is reference-owned; it must not import the package");

  // _ref route ownership + event-name contract are unchanged.
  assert.match(routes, REGEXP_14);
  assert.match(routes, REGEXP_16);
  assert.match(routes, REGEXP_17);
  assert.match(routes, REGEXP_18);
  assert.match(routes, REGEXP_1);
  assert.match(routes, REGEXP_2);
});

test("run-target registry and connector handoff remain reference-owned host orchestration", () => {
  const registry = read("reference-implementation/server/streaming/run-target-registry.ts");
  const handoff = read("packages/polyfill-connectors/src/browser-handoff.ts");
  const registration = read("packages/polyfill-connectors/src/streaming-target-registration.ts");

  assert.doesNotMatch(registry, REGEXP_3);
  assert.doesNotMatch(handoff, REGEXP_4);
  assert.doesNotMatch(registration, REGEXP_5);
  assert.match(registry, REGEXP_6);
  assert.match(handoff, REGEXP_7);
  assert.match(registration, REGEXP_8);
});

test("dynamic n.eko allocation seams use package leases while Docker lifecycle stays reference-owned", async (t) => {
  const leaseStore = read("reference-implementation/server/stores/browser-surface-lease-store.ts");
  const compose = read("docker-compose.neko.yml");
  const allocator = read("reference-implementation/server/neko-surface-allocator-server.ts");

  // PDPP owns the Docker/n.eko container lifecycle — asserted from PDPP-side
  // files, not the package's own docs (the package lives in its own repo now
  // and asserts its "does not own Docker Engine access" invariant there).
  assert.match(compose, REGEXP_9, "PDPP owns the neko compose service");
  assert.match(allocator, REGEXP_10, "PDPP allocator owns Docker container lifecycle");

  // The lease store consumes the package's /leases seam — only meaningful when
  // the optional dependency is installed.
  if (!(await remoteSurfaceInstalled())) {
    t.skip("@opendatalabs/remote-surface not installed; skipping package-consumer assertion");
    return;
  }
  assert.match(leaseStore, REGEXP_11);
});

test("installed remote-surface excludes retained surfaces from idle-TTL reap", async (t) => {
  const leases = await loadLeaseManager(t);
  if (!leases) {
    return;
  }

  const manager = createRetainedSurfaceManager(leases);
  const stopped: unknown[] = [];
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface() {
      throw new Error("not exercised by this test");
    },
    getSurfaceStatus() {
      throw new Error("not exercised by this test");
    },
    listSurfaces() {
      throw new Error("not exercised by this test");
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async stopSurface(request) {
      stopped.push(request);
      return retainedIdleSurface({ health: "stopping" });
    },
  };

  const idleResult = await manager.cleanupIdleSurfaces(allocator);
  assert.deepEqual(idleResult.stopped, [], "retained surface must not be idle-TTL reaped");
  assert.deepEqual(stopped, [], "idle-TTL must not call the allocator for a retained surface");
});

test("installed remote-surface excludes retained surfaces from capacity-pressure reap", async (t) => {
  const leases = await loadLeaseManager(t);
  if (!leases) {
    return;
  }

  const manager = createRetainedSurfaceManager(leases);

  const waiting = manager.acquire({
    connectorId: "background-connector",
    priorityClass: "background",
    profileKey: "background-profile",
    runId: "background_run",
  });
  assert.equal(waiting.lease.status, "waiting_for_browser_surface");
  assert.equal(waiting.lease.wait_reason, "capacity_full");
  assert.equal(
    manager.planCapacityPressureReclaim(waiting.lease.lease_id),
    undefined,
    "capacity pressure must leave a retained idle surface alone"
  );
});
