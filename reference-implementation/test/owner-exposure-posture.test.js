/**
 * Owner-exposure posture — pure unit coverage (security audit S-1 / S-2, lane A1).
 *
 * The posture module is the single source of truth for "is this deployment
 * internet-facing, and therefore must owner auth be mandatory?" These tests pin
 * the classification matrix and the fail-closed decisions so a regression that
 * re-opens the owner control plane on a hosted deploy is caught here, before any
 * server boots.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLoopbackBindHost,
  resolveOwnerExposurePosture,
} from '../server/owner-exposure-posture.ts';

function posture(overrides = {}) {
  return resolveOwnerExposurePosture({
    hasOwnerPassword: false,
    bindHost: undefined,
    publicUrlOption: null,
    env: {},
    isTestContext: false,
    ...overrides,
  });
}

// ── loopback bind-host classification ────────────────────────────────────────
test('isLoopbackBindHost: loopback literals are loopback', () => {
  for (const host of ['127.0.0.1', '127.5.6.7', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackBindHost(host), true, `${host} should be loopback`);
  }
});

test('isLoopbackBindHost: all-interfaces and LAN binds are NOT loopback (exposed)', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'fly-local-6pn']) {
    assert.equal(isLoopbackBindHost(host), false, `${host} should be exposed, not loopback`);
  }
});

test('isLoopbackBindHost: undefined bindHost is treated as exposed (Node binds all interfaces)', () => {
  assert.equal(isLoopbackBindHost(undefined), false);
  assert.equal(isLoopbackBindHost(null), false);
});

// ── local-dev posture: password optional, open behavior preserved ────────────
test('local-dev (no signals, no password): not hosted, open fall-through, registry unlocked', () => {
  const p = posture();
  assert.equal(p.hosted, false);
  assert.equal(p.refuseBootReason, null, 'must not refuse boot in local-dev');
  assert.equal(p.allowUnauthenticatedOwnerWhenDisabled, true, 'open fall-through preserved');
  assert.equal(p.lockConnectorRegistry, false, 'register route stays open');
});

test('local-dev loopback PDPP_REFERENCE_ORIGIN is NOT a hosted signal', () => {
  const p = posture({ env: { PDPP_REFERENCE_ORIGIN: 'http://localhost:3000' } });
  assert.equal(p.hosted, false);
  assert.equal(p.refuseBootReason, null);
});

// ── hosted posture: non-loopback origin → password mandatory ─────────────────
test('hosted via non-loopback PDPP_REFERENCE_ORIGIN + no password → refuse boot', () => {
  const p = posture({ env: { PDPP_REFERENCE_ORIGIN: 'https://app.fly.dev' } });
  assert.equal(p.hosted, true);
  assert.ok(p.hostedSignals.includes('PDPP_REFERENCE_ORIGIN=<non-loopback>'));
  assert.ok(p.refuseBootReason, 'must refuse boot when hosted without a password');
  assert.match(p.refuseBootReason, /PDPP_OWNER_PASSWORD/);
});

test('hosted via non-loopback AS_PUBLIC_URL + no password → refuse boot', () => {
  const p = posture({ env: { AS_PUBLIC_URL: 'https://pdpp.example.com' } });
  assert.equal(p.hosted, true);
  assert.ok(p.refuseBootReason);
});

test('hosted via NODE_ENV=production + no password → refuse boot', () => {
  const p = posture({ env: { NODE_ENV: 'production' } });
  assert.equal(p.hosted, true);
  assert.ok(p.hostedSignals.includes('NODE_ENV=production'));
  assert.ok(p.refuseBootReason);
});

test('hosted via explicit non-loopback bindHost + no password → refuse boot', () => {
  const p = posture({ bindHost: '0.0.0.0' });
  assert.equal(p.hosted, true);
  assert.ok(p.hostedSignals.some((s) => s.startsWith('bindHost=')));
  assert.ok(p.refuseBootReason);
});

test('hosted via explicit asPublicUrl option + no password → refuse boot', () => {
  const p = posture({ publicUrlOption: 'https://app.fly.dev' });
  assert.equal(p.hosted, true);
  assert.ok(p.hostedSignals.includes('asPublicUrl=<non-loopback>'));
  assert.ok(p.refuseBootReason);
});

// ── hosted + password present → boot OK, fail-closed runtime, registry locked ─
test('hosted WITH password: boots, fails closed when disabled (n/a here), locks registry', () => {
  const p = posture({ env: { NODE_ENV: 'production' }, hasOwnerPassword: true });
  assert.equal(p.hosted, true);
  assert.equal(p.refuseBootReason, null, 'password present → boot allowed');
  assert.equal(p.allowUnauthenticatedOwnerWhenDisabled, false, 'hosted fails closed');
  assert.equal(p.lockConnectorRegistry, true, 'register route requires owner session');
});

// ── explicit overrides ───────────────────────────────────────────────────────
test('PDPP_ALLOW_UNAUTHENTICATED_OWNER=1 keeps the open posture even when hosted', () => {
  const p = posture({
    env: { NODE_ENV: 'production', PDPP_ALLOW_UNAUTHENTICATED_OWNER: '1' },
  });
  assert.equal(p.hosted, true, 'still classified hosted');
  assert.equal(p.refuseBootReason, null, 'override allows boot without a password');
  assert.equal(p.allowUnauthenticatedOwnerWhenDisabled, true, 'open fall-through restored');
  assert.equal(p.lockConnectorRegistry, false, 'override also unlocks the registry');
});

test('PDPP_HOSTED=0 forces local posture even with a non-loopback origin', () => {
  const p = posture({ env: { PDPP_HOSTED: '0', PDPP_REFERENCE_ORIGIN: 'https://app.fly.dev' } });
  assert.equal(p.hosted, false);
  assert.equal(p.refuseBootReason, null);
  assert.equal(p.allowUnauthenticatedOwnerWhenDisabled, true);
});

test('PDPP_HOSTED=1 forces hosted posture even on loopback', () => {
  const p = posture({ env: { PDPP_HOSTED: '1', PDPP_REFERENCE_ORIGIN: 'http://localhost:3000' } });
  assert.equal(p.hosted, true);
  assert.ok(p.hostedSignals.includes('PDPP_HOSTED=1'));
  assert.ok(p.refuseBootReason);
});

test('PDPP_LOCK_CONNECTOR_REGISTRY=1 locks the registry even in local-dev', () => {
  const p = posture({ env: { PDPP_LOCK_CONNECTOR_REGISTRY: '1' }, hasOwnerPassword: true });
  assert.equal(p.hosted, false, 'still local-dev for owner-auth purposes');
  assert.equal(p.lockConnectorRegistry, true, 'register route requires owner session');
});

// ── test-context hermeticity: inferred signals ignored, PDPP_HOSTED honored ──
test('test context ignores ALL inferred hosting signals (NODE_ENV/origin/asPublicUrl/bindHost)', () => {
  // Hundreds of tests set a non-loopback asPublicUrl / origin or a bind host to
  // exercise origin/metadata/CIMD logic without intending hosted owner-auth.
  // Under the test runner none of those may force the hosted boot-refusal.
  const inferred = posture({
    isTestContext: true,
    env: { NODE_ENV: 'production', PDPP_REFERENCE_ORIGIN: 'https://app.fly.dev', AS_PUBLIC_URL: 'https://app.fly.dev' },
    publicUrlOption: 'https://app.fly.dev',
    bindHost: '0.0.0.0',
  });
  assert.equal(inferred.hosted, false, 'inferred hosting signals are ignored under the test runner');
  assert.equal(inferred.refuseBootReason, null, 'no boot refusal from inferred signals in tests');
});

test('test context still honors the explicit PDPP_HOSTED override', () => {
  const forced = posture({ isTestContext: true, env: { PDPP_HOSTED: '1' } });
  assert.equal(forced.hosted, true, 'explicit PDPP_HOSTED is honored even in test context');
  assert.ok(forced.refuseBootReason, 'PDPP_HOSTED=1 without a password refuses boot even in tests');
});
