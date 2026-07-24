// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveDynamicNekoSmokeConfig } from './docker-neko-dynamic-allocator-smoke-config.mjs';

test('dynamic n.eko smoke derives disjoint resources from one inherited environment', () => {
  const inherited = {
    PDPP_NEKO_DYNAMIC_SMOKE_PROJECT_NAME: 'shared-project',
    PDPP_NEKO_PROFILE_STORAGE_ROOT: '/shared/profiles',
    PDPP_NEKO_DEPLOYMENT_ID: 'shared-deployment',
  };
  const first = deriveDynamicNekoSmokeConfig(inherited, 'a1b2c3');
  const second = deriveDynamicNekoSmokeConfig(inherited, 'd4e5f6');

  for (const field of ['projectName', 'profileRoot', 'deploymentId', 'surfaceA', 'surfaceB']) {
    assert.notEqual(first[field], second[field]);
  }
  assert.deepEqual(first.cleanupFilters(first.surfaceA), [
    'label=org.pdpp.reference.neko.deployment_id=shared-deployment-a1b2c3',
    'label=org.pdpp.reference.neko.surface_id=dynamic-smoke-a1b2c3-a',
  ]);
  assert.notDeepEqual(first.cleanupFilters(first.surfaceA), second.cleanupFilters(second.surfaceA));
});

test('dynamic n.eko smoke rejects inherited WebRTC port settings', () => {
  assert.throws(
    () => deriveDynamicNekoSmokeConfig({ PDPP_NEKO_WEBRTC_HOST_PORT_START: '59101' }, 'a1b2c3'),
    /must be unset/,
  );
});

test('dynamic n.eko smoke defaults deployment id to its derived project id', () => {
  const config = deriveDynamicNekoSmokeConfig({}, 'smoke-a1b2c3');
  assert.equal(config.deploymentId, config.projectName);
});
