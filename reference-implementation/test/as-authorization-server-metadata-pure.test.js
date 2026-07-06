// Pure, no-DB unit tests for the RFC 8414 authorization-server-metadata operation
// in operations/as-authorization-server-metadata/index.ts. No test imports this
// module by name. It projects deployment inputs into the AS metadata builder input;
// the endpoint URL construction, the DCR-gated registration_endpoint, and the
// registration_modes_supported composition are the wire-contract surface.
//
// The builder dependency is stubbed to an identity pass-through so we can assert
// on the exact builder input the operation constructs.
//
// Mutation surface:
//   - endpoint URLs derived from `${issuer}/...`.
//   - registrationEndpoint is `${issuer}/oauth/register` when DCR enabled, else null.
//   - registrationModesSupported: ['dynamic','pre_registered_public'] when DCR on,
//     ['pre_registered_public'] when off; + 'client_id_metadata_document' when cimd.
//   - fixed capabilities: code_challenge_methods = ['S256'], response_types = ['code'].

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAsAuthorizationServerMetadata } from '../operations/as-authorization-server-metadata/index.ts';

// Identity builder: return the builder input verbatim so we can assert on it.
const passthroughDeps = { buildAuthorizationServerMetadata: (input) => input };

function build(input) {
  return executeAsAuthorizationServerMetadata(input, passthroughDeps);
}

test('executeAsAuthorizationServerMetadata: derives all endpoints from the issuer', () => {
  const out = build({ issuer: 'https://as.example', dynamicClientRegistrationEnabled: true });
  assert.equal(out.issuer, 'https://as.example');
  assert.equal(out.authorizationEndpoint, 'https://as.example/oauth/authorize');
  assert.equal(out.introspectionEndpoint, 'https://as.example/introspect');
  assert.equal(out.pushedAuthorizationRequestEndpoint, 'https://as.example/oauth/par');
  assert.equal(out.tokenEndpoint, 'https://as.example/oauth/token');
  assert.equal(out.deviceAuthorizationEndpoint, 'https://as.example/oauth/device_authorization');
  assert.equal(out.agentConnectEndpoint, 'https://as.example/agent-connect');
});

test('executeAsAuthorizationServerMetadata: registration_endpoint is set when DCR enabled', () => {
  const out = build({ issuer: 'https://as.example', dynamicClientRegistrationEnabled: true });
  assert.equal(out.registrationEndpoint, 'https://as.example/oauth/register');
});

test('executeAsAuthorizationServerMetadata: registration_endpoint is NULL when DCR disabled', () => {
  const out = build({ issuer: 'https://as.example', dynamicClientRegistrationEnabled: false });
  assert.equal(out.registrationEndpoint, null, 'no registration endpoint advertised when DCR off');
});

test('executeAsAuthorizationServerMetadata: registration modes include "dynamic" only when DCR enabled', () => {
  const on = build({ issuer: 'https://x', dynamicClientRegistrationEnabled: true });
  assert.deepEqual(on.registrationModesSupported, ['dynamic', 'pre_registered_public']);
  const off = build({ issuer: 'https://x', dynamicClientRegistrationEnabled: false });
  assert.deepEqual(off.registrationModesSupported, ['pre_registered_public'], 'dynamic dropped when DCR off');
});

test('executeAsAuthorizationServerMetadata: cimd appends client_id_metadata_document to registration modes', () => {
  const withCimd = build({ issuer: 'https://x', dynamicClientRegistrationEnabled: true, cimdEnabled: true });
  assert.deepEqual(withCimd.registrationModesSupported, ['dynamic', 'pre_registered_public', 'client_id_metadata_document']);
  assert.equal(withCimd.cimdEnabled, true, 'cimd flag threaded to the builder');

  const withCimdNoDcr = build({ issuer: 'https://x', dynamicClientRegistrationEnabled: false, cimdEnabled: true });
  assert.deepEqual(withCimdNoDcr.registrationModesSupported, ['pre_registered_public', 'client_id_metadata_document']);
});

test('executeAsAuthorizationServerMetadata: cimd defaults off (not appended)', () => {
  const out = build({ issuer: 'https://x', dynamicClientRegistrationEnabled: true });
  assert.ok(!out.registrationModesSupported.includes('client_id_metadata_document'), 'cimd default off');
  assert.equal(out.cimdEnabled, false);
});

test('executeAsAuthorizationServerMetadata: pins the fixed OAuth capability vocabularies', () => {
  const out = build({ issuer: 'https://x', dynamicClientRegistrationEnabled: true });
  assert.deepEqual(out.codeChallengeMethodsSupported, ['S256'], 'PKCE S256 only');
  assert.deepEqual(out.responseTypesSupported, ['code'], 'code response type only');
  assert.deepEqual(out.tokenEndpointAuthMethodsSupported, ['none']);
  assert.ok(out.grantTypesSupported.includes('refresh_token'));
  assert.ok(out.grantTypesSupported.includes('authorization_code'));
  assert.ok(out.grantTypesSupported.includes('urn:ietf:params:oauth:grant-type:device_code'));
  assert.deepEqual(out.authorizationDetailsTypesSupported, ['https://pdpp.org/data-access']);
});

test('executeAsAuthorizationServerMetadata: passes through pre-registered public clients', () => {
  const clients = [{ client_id: 'cli', client_name: 'CLI', token_endpoint_auth_method: 'none' }];
  const out = build({ issuer: 'https://x', dynamicClientRegistrationEnabled: false, preRegisteredPublicClients: clients });
  assert.deepEqual(out.preRegisteredPublicClients, clients);
});
