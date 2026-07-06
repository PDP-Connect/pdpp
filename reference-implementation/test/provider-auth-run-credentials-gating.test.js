/**
 * Mutation-killing unit tests for the connector/binding GATING and typed
 * error paths of `resolveProviderAuthRunEnv` in
 * `server/stores/provider-auth-run-credentials.js`.
 *
 * This is credential-adjacent (RED-tier) code, but the assertions only
 * OBSERVE behavior — they do not change it. The gating short-circuits are
 * reachable without any real credential store or DB:
 *
 *   - a connectorId other than the google-maps-data-portability key -> null
 *   - a source binding that is not the google_data_portability provider-auth
 *     account shape -> null
 *   - the matching connector+binding but a MISSING credential store -> a typed
 *     `credential_store_required` ProviderAuthRunCredentialError
 *   - a recovered credential whose kind is not `secret_bundle` ->
 *     `provider_auth_credential_kind_mismatch`
 *
 * The fail-CLOSED order matters: a mutant that lets a non-matching connector
 * fall through (touching the store), or that drops the kind-mismatch check,
 * turns red here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProviderAuthRunCredentialError,
  resolveProviderAuthRunEnv,
} from '../server/stores/provider-auth-run-credentials.js';

const GDP_BINDING = { kind: 'provider_auth_account', provider: 'google_data_portability' };

// A store that must NOT be called for the short-circuit cases; if it is, the
// test fails loudly rather than silently passing.
function poisonStore() {
  return {
    recoverSecret() {
      throw new Error('recoverSecret must not be called when the connector/binding does not match');
    },
  };
}

test('resolveProviderAuthRunEnv: a non-matching connectorId short-circuits to null before touching the store', async () => {
  const result = await resolveProviderAuthRunEnv({
    connectorId: 'github',
    connectorInstanceId: 'cin_1',
    ownerSubjectId: 'owner',
    sourceBinding: GDP_BINDING,
    credentialStore: poisonStore(),
  });
  assert.equal(result, null);
});

test('resolveProviderAuthRunEnv: a non-GDP source binding short-circuits to null', async () => {
  for (const binding of [
    null,
    {},
    { kind: 'connector', id: 'x' },
    { kind: 'provider_auth_account', provider: 'some_other_provider' },
    { kind: 'provider_native', provider: 'google_data_portability' },
  ]) {
    const result = await resolveProviderAuthRunEnv({
      connectorId: 'google-maps-data-portability',
      connectorInstanceId: 'cin_1',
      ownerSubjectId: 'owner',
      sourceBinding: binding,
      credentialStore: poisonStore(),
    });
    assert.equal(result, null, `binding ${JSON.stringify(binding)} must gate to null`);
  }
});

test('resolveProviderAuthRunEnv: matching connector+binding but NO store -> credential_store_required', async () => {
  await assert.rejects(
    () =>
      resolveProviderAuthRunEnv({
        connectorId: 'google-maps-data-portability',
        connectorInstanceId: 'cin_1',
        ownerSubjectId: 'owner',
        sourceBinding: GDP_BINDING,
        credentialStore: null,
      }),
    (err) => {
      assert.ok(err instanceof ProviderAuthRunCredentialError, `expected ProviderAuthRunCredentialError, got ${err.name}`);
      assert.equal(err.code, 'credential_store_required');
      return true;
    },
  );
});

test('resolveProviderAuthRunEnv: a non-secret_bundle credential kind -> provider_auth_credential_kind_mismatch', async () => {
  let called = false;
  const store = {
    async recoverSecret({ connectorInstanceId, ownerSubjectId }) {
      called = true;
      // The gating passed the connector-instance + owner through to the store.
      assert.equal(connectorInstanceId, 'cin_1');
      assert.equal(ownerSubjectId, 'owner');
      return { credentialKind: 'static_secret', secret: '{}' };
    },
  };

  await assert.rejects(
    () =>
      resolveProviderAuthRunEnv({
        connectorId: 'google-maps-data-portability',
        connectorInstanceId: 'cin_1',
        ownerSubjectId: 'owner',
        sourceBinding: GDP_BINDING,
        credentialStore: store,
      }),
    (err) => {
      assert.equal(err.code, 'provider_auth_credential_kind_mismatch');
      return true;
    },
  );
  assert.ok(called, 'the store must have been consulted once the gates passed');
});
