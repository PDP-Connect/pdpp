import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

test('reference streaming routes adapt package session/protocol APIs while preserving _ref ownership', () => {
  const sessionsShim = read('reference-implementation/server/streaming/sessions.ts');
  const routes = read('reference-implementation/server/streaming/routes.js');

  assert.match(sessionsShim, /from ['"]@opendatalabs\/remote-surface\/server['"]/);
  assert.match(routes, /from ['"]@opendatalabs\/remote-surface\/protocol['"]/);
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

test('dynamic n.eko allocation seams use package leases while Docker lifecycle stays reference-owned', () => {
  const leaseStore = read('reference-implementation/server/stores/browser-surface-lease-store.ts');
  const remoteSurfacePackage = read('packages/remote-surface/README.md');
  const compose = read('docker-compose.neko.yml');

  assert.match(leaseStore, /from ['"]@opendatalabs\/remote-surface\/leases['"]/);
  assert.match(remoteSurfacePackage, /Docker\/Compose\/sidecar allocation/);
  assert.match(compose, /neko:/);
  assert.doesNotMatch(remoteSurfacePackage, /docker\.sock/);
  assert.doesNotMatch(remoteSurfacePackage, /Docker Engine access is owned by the package/);
});
