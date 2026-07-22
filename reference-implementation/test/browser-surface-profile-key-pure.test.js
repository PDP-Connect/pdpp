// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for runtime/browser-surface/profile-key.ts. No test
// imports this module by name. readBrowserSurfaceProfileKey derives the remote-
// browser profile key shared by runtime leasing AND operator health projection;
// its multi-account SCOPING rule (append :connectionId unless the instance IS the
// connector) is the isolation guarantee that keeps one connection's stale surface
// from poisoning another's health. A scoping regression silently cross-wires
// accounts.
//
// Mutation surface:
//   - profile_key sourced from manifest.capabilities.browser_surface.profile_key
//     when a non-blank string, else falls back to connectorId.
//   - scoped by connectorInstanceId: base key when instance === connector,
//     `${base}:${instance}` otherwise.

import assert from 'node:assert/strict';
import test from 'node:test';

import { readBrowserSurfaceProfileKey } from '../runtime/browser-surface/profile-key.ts';

function manifestWithProfileKey(profileKey) {
  return { capabilities: { browser_surface: { profile_key: profileKey } } };
}

test('readBrowserSurfaceProfileKey: default-account (instance === connector) uses the bare base key', () => {
  assert.equal(readBrowserSurfaceProfileKey('amazon', 'amazon', null), 'amazon');
});

test('readBrowserSurfaceProfileKey: a non-default connection is scoped with :connectionId', () => {
  assert.equal(
    readBrowserSurfaceProfileKey('amazon', 'amazon:acct2', null),
    'amazon:amazon:acct2',
    'multi-account instance appends its full id for isolation',
  );
  assert.equal(readBrowserSurfaceProfileKey('amazon', 'ci-99', null), 'amazon:ci-99');
});

test('readBrowserSurfaceProfileKey: a declared profile_key overrides the connectorId base', () => {
  assert.equal(
    readBrowserSurfaceProfileKey('amazon', 'amazon', manifestWithProfileKey('shared-surface')),
    'shared-surface',
  );
  assert.equal(
    readBrowserSurfaceProfileKey('amazon', 'ci-99', manifestWithProfileKey('shared-surface')),
    'shared-surface:ci-99',
    'declared base still scoped by the non-default instance',
  );
});

test('readBrowserSurfaceProfileKey: a blank / non-string profile_key falls back to connectorId', () => {
  assert.equal(readBrowserSurfaceProfileKey('amazon', 'amazon', manifestWithProfileKey('   ')), 'amazon');
  assert.equal(readBrowserSurfaceProfileKey('amazon', 'amazon', manifestWithProfileKey(42)), 'amazon');
  assert.equal(readBrowserSurfaceProfileKey('amazon', 'amazon', {}), 'amazon', 'no capabilities -> connectorId');
  assert.equal(readBrowserSurfaceProfileKey('amazon', 'amazon', null), 'amazon', 'null manifest -> connectorId');
});

test('readBrowserSurfaceProfileKey: the profile_key is trimmed before use', () => {
  assert.equal(readBrowserSurfaceProfileKey('amazon', 'amazon', manifestWithProfileKey('  shared  ')), 'shared');
});

test('readBrowserSurfaceProfileKey: two DIFFERENT non-default connections get DISTINCT keys (isolation)', () => {
  const a = readBrowserSurfaceProfileKey('amazon', 'ci-a', null);
  const b = readBrowserSurfaceProfileKey('amazon', 'ci-b', null);
  assert.notEqual(a, b, 'distinct connections must not share a profile key');
});
