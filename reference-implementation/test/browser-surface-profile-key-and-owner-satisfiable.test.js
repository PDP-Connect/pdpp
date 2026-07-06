/**
 * Unit coverage for two UNTESTED pure projection helpers:
 *
 *   1. readBrowserSurfaceProfileKey (`runtime/browser-surface/profile-key.ts`)
 *      — resolves the remote-browser profile key shared by runtime leasing and
 *      operator health projection. It deep-drills the manifest
 *      (`capabilities.browser_surface.profile_key`), trims it, falls back to the
 *      connector id when absent/blank, and instance-scopes the result with a
 *      `:${connectorInstanceId}` suffix unless the instance id EQUALS the
 *      connector id (single-account case).
 *
 *   2. ownerSatisfiableActions (`runtime/satisfaction-watcher.ts`) — filters a
 *      required-action list to those an OWNER can act on: audience === "owner"
 *      AND satisfied_when.kind !== "none" AND terminal !== true.
 *
 * Both are pure (no DB/server). No fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readBrowserSurfaceProfileKey } from '../runtime/browser-surface/profile-key.ts';
import { ownerSatisfiableActions } from '../runtime/satisfaction-watcher.ts';

// --- readBrowserSurfaceProfileKey -------------------------------------------

test('readBrowserSurfaceProfileKey: reads capabilities.browser_surface.profile_key and trims it', () => {
  const key = readBrowserSurfaceProfileKey('amazon', 'amazon', {
    capabilities: { browser_surface: { profile_key: '  neko-pool-a  ' } },
  });
  assert.equal(key, 'neko-pool-a', `key: ${key}`);
});

test('readBrowserSurfaceProfileKey: falls back to the connector id when profile_key is absent or blank', () => {
  assert.equal(readBrowserSurfaceProfileKey('amazon', 'amazon', null), 'amazon', 'null manifest => connectorId');
  assert.equal(
    readBrowserSurfaceProfileKey('amazon', 'amazon', { capabilities: {} }),
    'amazon',
    'no browser_surface => connectorId',
  );
  assert.equal(
    readBrowserSurfaceProfileKey('amazon', 'amazon', { capabilities: { browser_surface: { profile_key: '   ' } } }),
    'amazon',
    'blank profile_key => connectorId',
  );
  assert.equal(
    readBrowserSurfaceProfileKey('amazon', 'amazon', { capabilities: { browser_surface: { profile_key: 42 } } }),
    'amazon',
    'non-string profile_key => connectorId',
  );
});

test('readBrowserSurfaceProfileKey: instance-scopes when the instance id differs from the connector id', () => {
  // Explicit profile key + differing instance id => "<key>:<instanceId>".
  assert.equal(
    readBrowserSurfaceProfileKey('amazon', 'cin_1', { capabilities: { browser_surface: { profile_key: 'pk' } } }),
    'pk:cin_1',
  );
  // Fallback (connectorId) key + differing instance id => "<connectorId>:<instanceId>".
  assert.equal(readBrowserSurfaceProfileKey('amazon', 'cin_2', null), 'amazon:cin_2');
});

test('readBrowserSurfaceProfileKey: does NOT scope when instance id equals connector id (single account)', () => {
  assert.equal(
    readBrowserSurfaceProfileKey('amazon', 'amazon', { capabilities: { browser_surface: { profile_key: 'pk' } } }),
    'pk',
    'no suffix when instance id === connector id',
  );
});

// --- ownerSatisfiableActions ------------------------------------------------

function action(overrides) {
  return {
    id: 'a',
    audience: 'owner',
    satisfied_when: { kind: 'credential' },
    terminal: false,
    ...overrides,
  };
}

test('ownerSatisfiableActions: keeps owner, actionable (kind!=none), non-terminal actions', () => {
  const actions = [
    action({ id: 'owner-cred' }),
    action({ id: 'owner-otp', satisfied_when: { kind: 'otp' } }),
  ];
  assert.deepEqual(
    ownerSatisfiableActions(actions).map((a) => a.id),
    ['owner-cred', 'owner-otp'],
    'both owner-actionable non-terminal actions kept',
  );
});

test('ownerSatisfiableActions: drops non-owner audiences', () => {
  const actions = [
    action({ id: 'owner', audience: 'owner' }),
    action({ id: 'client', audience: 'client' }),
    action({ id: 'maintainer', audience: 'maintainer' }),
  ];
  assert.deepEqual(ownerSatisfiableActions(actions).map((a) => a.id), ['owner'], 'only owner-audience survives');
});

test('ownerSatisfiableActions: drops satisfied_when.kind === "none" (nothing for the owner to do)', () => {
  const actions = [
    action({ id: 'actionable', satisfied_when: { kind: 'credential' } }),
    action({ id: 'kind-none', satisfied_when: { kind: 'none' } }),
  ];
  assert.deepEqual(ownerSatisfiableActions(actions).map((a) => a.id), ['actionable'], 'kind=none excluded');
});

test('ownerSatisfiableActions: drops terminal actions', () => {
  const actions = [
    action({ id: 'live', terminal: false }),
    action({ id: 'terminal', terminal: true }),
  ];
  assert.deepEqual(ownerSatisfiableActions(actions).map((a) => a.id), ['live'], 'terminal excluded');
});

test('ownerSatisfiableActions: empty result when no action qualifies', () => {
  const actions = [
    action({ id: 'client', audience: 'client' }),
    action({ id: 'none', satisfied_when: { kind: 'none' } }),
    action({ id: 'terminal', terminal: true }),
  ];
  assert.deepEqual(ownerSatisfiableActions(actions), [], 'no qualifying action => []');
});
