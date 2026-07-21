// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
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
    await import('@opendatalabs/remote-surface/leases');
    return true;
  } catch {
    return false;
  }
}

function retainedIdleSurface(overrides = {}) {
  return {
    surface_id: 'retained_surface',
    backend: 'neko',
    profile_key: 'retained-profile',
    connector_id: 'retained-connector',
    cdp_url: 'http://neko:9222',
    stream_base_url: 'http://neko:8080',
    health: 'ready',
    created_at: '2026-07-22T12:00:00.000Z',
    last_used_at: '2026-07-22T12:00:00.000Z',
    retained: true,
    ...overrides,
  };
}

async function loadLeaseManager(t) {
  try {
    return await import('@opendatalabs/remote-surface/leases');
  } catch {
    t.skip('@opendatalabs/remote-surface not installed; skipping installed-package retention assertion');
    return null;
  }
}

function createRetainedSurfaceManager(leases) {
  return new leases.BrowserSurfaceLeaseManager({
    config: {
      managedConnectors: new Set(['retained-connector', 'background-connector']),
      surfaceCap: 1,
      leaseWaitTimeoutMs: 60_000,
      idleTtlMs: 60_000,
      defaultPriorityClass: 'background',
      priorityRanks: leases.DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceMode: 'dynamic',
    },
    now: () => new Date('2026-07-22T12:10:00.000Z'),
    initialSurfaces: [retainedIdleSurface()],
  });
}

test('reference streaming routes adapt package session APIs while owning the PDPP wire shape and preserving _ref ownership', () => {
  const sessionsShim = read('reference-implementation/server/streaming/sessions.ts');
  const routes = read('reference-implementation/server/streaming/routes.js');
  const protocolWire = read('reference-implementation/server/streaming/protocol-wire.ts');

  // The package's SESSION store is still consumed through the sessions shim,
  // which translates the host-neutral package API into the reference's
  // snake_case (_ref/run_id/interaction_id) contract.
  assert.match(sessionsShim, /from ['"]@opendatalabs\/remote-surface\/server['"]/);

  // Post-extraction the package's protocol export dropped its PDPP-shaped wire
  // parsers (they were host-specific). PDPP now OWNS its wire shapes locally in
  // protocol-wire.ts, and routes.js consumes that local module — not the
  // package protocol. protocol-wire.ts must not reach back into the package.
  assert.match(routes, /from ['"]\.\/protocol-wire\.ts['"]/);
  assert.doesNotMatch(protocolWire, /@opendatalabs\/remote-surface/, 'protocol-wire.ts is reference-owned; it must not import the package');

  // _ref route ownership + event-name contract are unchanged.
  assert.match(routes, /\/_ref\/runs\/:runId\/run-interaction-stream/);
  assert.match(routes, /\/_ref\/run-interaction-streams\/:token\/events/);
  assert.match(routes, /object: 'run_interaction_stream_session'/);
  assert.match(routes, /run\.stream_session_requested/);
  assert.match(routes, /run\.stream_session_opened/);
  assert.match(routes, /run\.stream_session_resolved/);
});

test('run-target registry and connector handoff remain reference-owned host orchestration', () => {
  const registry = read('reference-implementation/server/streaming/run-target-registry.js');
  const handoff = read('packages/polyfill-connectors/src/browser-handoff.ts');
  const registration = read('packages/polyfill-connectors/src/streaming-target-registration.ts');

  assert.doesNotMatch(registry, /@opendatalabs\/remote-surface/);
  assert.doesNotMatch(handoff, /@opendatalabs\/remote-surface/);
  assert.doesNotMatch(registration, /@opendatalabs\/remote-surface/);
  assert.match(registry, /streaming-target/);
  assert.match(handoff, /resolveStreamingRegistrationFromEnv/);
  assert.match(registration, /PDPP_STREAMING_REGISTRATION_TOKEN/);
});

test('dynamic n.eko allocation seams use package leases while Docker lifecycle stays reference-owned', async (t) => {
  const leaseStore = read('reference-implementation/server/stores/browser-surface-lease-store.ts');
  const compose = read('docker-compose.neko.yml');
  const allocator = read('reference-implementation/server/neko-surface-allocator-server.ts');

  // PDPP owns the Docker/n.eko container lifecycle — asserted from PDPP-side
  // files, not the package's own docs (the package lives in its own repo now
  // and asserts its "does not own Docker Engine access" invariant there).
  assert.match(compose, /neko:/, 'PDPP owns the neko compose service');
  assert.match(
    allocator,
    /docker|container/i,
    'PDPP allocator owns Docker container lifecycle',
  );

  // The lease store consumes the package's /leases seam — only meaningful when
  // the optional dependency is installed.
  if (!(await remoteSurfaceInstalled())) {
    t.skip('@opendatalabs/remote-surface not installed; skipping package-consumer assertion');
    return;
  }
  assert.match(leaseStore, /from ['"]@opendatalabs\/remote-surface\/leases['"]/);
});

test('installed remote-surface excludes retained surfaces from idle-TTL reap', async (t) => {
  const leases = await loadLeaseManager(t);
  if (!leases) return;

  const manager = createRetainedSurfaceManager(leases);
  const stopped = [];
  const allocator = {
    async stopSurface(request) {
      stopped.push(request);
      return retainedIdleSurface({ health: 'stopping' });
    },
  };

  const idleResult = await manager.cleanupIdleSurfaces(allocator);
  assert.deepEqual(idleResult.stopped, [], 'retained surface must not be idle-TTL reaped');
  assert.deepEqual(stopped, [], 'idle-TTL must not call the allocator for a retained surface');
});

test('installed remote-surface excludes retained surfaces from capacity-pressure reap', async (t) => {
  const leases = await loadLeaseManager(t);
  if (!leases) return;

  const manager = createRetainedSurfaceManager(leases);

  const waiting = manager.acquire({
    connectorId: 'background-connector',
    runId: 'background_run',
    profileKey: 'background-profile',
    priorityClass: 'background',
  });
  assert.equal(waiting.lease.status, 'waiting_for_browser_surface');
  assert.equal(waiting.lease.wait_reason, 'capacity_full');
  assert.equal(
    manager.planCapacityPressureReclaim(waiting.lease.lease_id),
    undefined,
    'capacity pressure must leave a retained idle surface alone',
  );
});
