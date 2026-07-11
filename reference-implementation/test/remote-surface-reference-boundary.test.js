import { createRequire } from 'node:module';
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
const require = createRequire(import.meta.url);
function remoteSurfaceInstalled() {
  try {
    require.resolve('@opendatalabs/remote-surface/leases');
    return true;
  } catch {
    return false;
  }
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

test('dynamic n.eko allocation seams use package leases while Docker lifecycle stays reference-owned', (t) => {
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
  if (!remoteSurfaceInstalled()) {
    t.skip('@opendatalabs/remote-surface not installed; skipping package-consumer assertion');
    return;
  }
  assert.match(leaseStore, /from ['"]@opendatalabs\/remote-surface\/leases['"]/);
});
