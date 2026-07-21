// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the UNTESTED scope-set projection
 * `googleDataPortabilityScopesForConfiguredEnv` (`server/provider-auth/
 * google-data-portability.ts`). Given an injected env, it resolves the
 * configured Google Data Portability Maps resource groups into their OAuth
 * scope URLs, filtered to the manifest's allowed scope set.
 *
 * Contracts pinned (env injected — no process.env, no DB):
 *   - an absent/empty GOOGLE_DATAPORTABILITY_RESOURCE_GROUPS => the FULL default
 *     scope set;
 *   - a comma-separated list of valid groups => exactly those groups' scopes,
 *     in order, prefixed `https://www.googleapis.com/auth/dataportability.<g>`;
 *   - a JSON-array string is honored;
 *   - duplicates collapse;
 *   - an array of non-strings (e.g. `[123]`) filters to empty => default set;
 *   - an unsupported group throws GoogleDataPortabilityProviderAuthError with
 *     code `google_dataportability_resource_group_unsupported`.
 *
 * Pure with an injected env. No DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { googleDataPortabilityScopesForConfiguredEnv } from '../server/provider-auth/google-data-portability.ts';

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/dataportability.';

function scopesFor(resourceGroups) {
  return googleDataPortabilityScopesForConfiguredEnv(
    resourceGroups === undefined ? {} : { GOOGLE_DATAPORTABILITY_RESOURCE_GROUPS: resourceGroups },
  );
}

test('googleDataPortabilityScopesForConfiguredEnv: absent config yields the full default scope set', () => {
  const full = scopesFor(undefined);
  assert.ok(Array.isArray(full) && full.length > 1, `expected many scopes, got ${full.length}`);
  // Every scope carries the dataportability prefix.
  for (const scope of full) {
    assert.ok(scope.startsWith(SCOPE_PREFIX), `scope ${scope} must carry the dataportability prefix`);
  }
  // A representative known group is present.
  assert.ok(full.includes(`${SCOPE_PREFIX}maps.reviews`), 'default set includes maps.reviews');
});

test('googleDataPortabilityScopesForConfiguredEnv: empty string also yields the full default set', () => {
  assert.deepEqual(scopesFor(''), scopesFor(undefined), 'empty config == absent config');
});

test('googleDataPortabilityScopesForConfiguredEnv: a comma list maps valid groups to their scopes in order', () => {
  assert.deepEqual(
    scopesFor('maps.reviews,maps.photos_videos'),
    [`${SCOPE_PREFIX}maps.reviews`, `${SCOPE_PREFIX}maps.photos_videos`],
  );
});

test('googleDataPortabilityScopesForConfiguredEnv: a JSON-array string is honored', () => {
  assert.deepEqual(scopesFor('["maps.reviews"]'), [`${SCOPE_PREFIX}maps.reviews`]);
});

test('googleDataPortabilityScopesForConfiguredEnv: duplicate groups collapse to one scope', () => {
  assert.deepEqual(scopesFor('maps.reviews,maps.reviews'), [`${SCOPE_PREFIX}maps.reviews`]);
});

test('googleDataPortabilityScopesForConfiguredEnv: an array of non-strings falls back to the default set', () => {
  // [123] filters out (non-string) => unique empty => default resource groups.
  assert.deepEqual(scopesFor('[123]'), scopesFor(undefined), 'non-string members => default');
});

test('googleDataPortabilityScopesForConfiguredEnv: an unsupported group throws the typed provider-auth error', () => {
  assert.throws(
    () => scopesFor('maps.not_a_real_group'),
    (err) => {
      assert.equal(
        err.code,
        'google_dataportability_resource_group_unsupported',
        `code: ${err.code}`,
      );
      assert.ok(String(err.message).includes('maps.not_a_real_group'), `message names the group: ${err.message}`);
      return true;
    },
  );
});
