// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit tests for the DCR enable/initial-access-token
 * RESOLUTION helpers in `server/dcr-configuration.js` (the sibling
 * `dcr-configuration-policy.test.js` covers the rate limiter + client
 * metadata). These opts-driven resolvers have no by-name coverage.
 *
 *   - resolveDynamicClientRegistrationEnabled
 *       (opts override coerced via Boolean())
 *   - resolveDynamicClientRegistrationInitialAccessTokens
 *       (explicit opts array wins — INCLUDING an explicit empty array —
 *        and falsy entries are filtered out)
 *
 * The "explicit empty array wins over the fallback default" branch is the
 * load-bearing one: a mutant that treats `[]` as "unset" and falls through to
 * the local default would re-enable a bootstrap token an operator explicitly
 * cleared, and turns red here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDynamicClientRegistrationEnabled,
  resolveDynamicClientRegistrationInitialAccessTokens,
} from '../server/dcr-configuration.js';

test('resolveDynamicClientRegistrationEnabled: opts override is coerced with Boolean()', () => {
  assert.equal(resolveDynamicClientRegistrationEnabled({ enableDynamicClientRegistration: true }), true);
  assert.equal(resolveDynamicClientRegistrationEnabled({ enableDynamicClientRegistration: false }), false);
  // Truthy/falsy non-booleans are coerced, not passed through.
  assert.equal(resolveDynamicClientRegistrationEnabled({ enableDynamicClientRegistration: 1 }), true);
  assert.equal(resolveDynamicClientRegistrationEnabled({ enableDynamicClientRegistration: 0 }), false);
  assert.equal(resolveDynamicClientRegistrationEnabled({ enableDynamicClientRegistration: '' }), false);
  // The return type is always a real boolean.
  assert.equal(typeof resolveDynamicClientRegistrationEnabled({ enableDynamicClientRegistration: 'yes' }), 'boolean');
});

test('resolveDynamicClientRegistrationInitialAccessTokens: explicit opts array wins and filters falsy entries', () => {
  // An explicit non-empty array is used verbatim (minus falsy entries).
  assert.deepEqual(
    resolveDynamicClientRegistrationInitialAccessTokens({
      dynamicClientRegistrationInitialAccessTokens: ['tok_a', '', null, 'tok_b'],
    }),
    ['tok_a', 'tok_b'],
  );
});

test('resolveDynamicClientRegistrationInitialAccessTokens: an EXPLICIT empty array wins over the fallback default', () => {
  // The whole point of the Array.isArray branch: an operator that passes `[]`
  // wants NO bootstrap tokens and must NOT be given the local default.
  assert.deepEqual(
    resolveDynamicClientRegistrationInitialAccessTokens({ dynamicClientRegistrationInitialAccessTokens: [] }),
    [],
  );
});

test('resolveDynamicClientRegistrationInitialAccessTokens: no opts -> a non-empty default list (env/local fallback)', () => {
  // With no opts and (in the test env) no PDPP_DCR_INITIAL_ACCESS_TOKENS, the
  // reference-local default is returned so DCR is usable out of the box.
  const tokens = resolveDynamicClientRegistrationInitialAccessTokens();
  assert.ok(Array.isArray(tokens) && tokens.length > 0, 'default token list must be non-empty');
  assert.ok(
    tokens.every((t) => typeof t === 'string' && t.length > 0),
    'default tokens must be non-empty strings',
  );
});
