// Pure, no-DB unit tests for the DCR register operation's security logic in
// operations/as-dcr-register/index.ts. Only the summary helper was pinned before;
// the execute path's auth-token validation, registration_access derivation, and the
// issuer_subject_id ANTI-SPOOFING sanitization were unpinned.
//
// RED note: auth-surface. Tests OBSERVE the auth decisions with a stubbed
// registerDynamicClient; no client is actually registered.
//
// Mutation surface:
//   - DCR disabled -> invalid_request (404).
//   - malformed (non-Bearer) auth header -> invalid_client (401).
//   - Bearer token not in the allowlist -> invalid_client (401).
//   - registration_access: valid token -> initial_access_token; owner session ->
//     owner_session; neither -> public.
//   - issuer_subject_id is DELETED from the body (anonymous cannot self-tag) and
//     replaced with the owner session subject via extraMetadata for owner callers.

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAsDcrRegister } from '../operations/as-dcr-register/index.ts';

// Records what registerDynamicClient was called with and returns a canned client.
function capturingDeps() {
  const calls = [];
  return {
    calls,
    registerDynamicClient: async (sanitizedInput, extraMetadata) => {
      calls.push({ sanitizedInput, extraMetadata });
      return { client_id: 'new-cli', client_name: 'App', token_endpoint_auth_method: 'none', redirect_uris: ['u'] };
    },
  };
}

test('executeAsDcrRegister: DCR disabled is a 404 invalid_request', async () => {
  const out = await executeAsDcrRegister({ dcrEnabled: false, body: {}, initialAccessTokens: [] }, capturingDeps());
  assert.equal(out.outcome, 'failure');
  assert.equal(out.status, 404);
  assert.equal(out.errorCode, 'invalid_request');
});

test('executeAsDcrRegister: a malformed (non-Bearer) auth header is a 401 invalid_client', async () => {
  const out = await executeAsDcrRegister(
    { dcrEnabled: true, body: {}, authorizationHeader: 'Basic abc', initialAccessTokens: ['tok'] },
    capturingDeps(),
  );
  assert.equal(out.status, 401);
  assert.equal(out.errorCode, 'invalid_client');
});

test('executeAsDcrRegister: a Bearer token not in the allowlist is a 401 invalid_client', async () => {
  const out = await executeAsDcrRegister(
    { dcrEnabled: true, body: {}, authorizationHeader: 'Bearer wrong', initialAccessTokens: ['right'] },
    capturingDeps(),
  );
  assert.equal(out.status, 401);
  assert.equal(out.errorCode, 'invalid_client');
});

test('executeAsDcrRegister: a valid initial access token yields registration_access=initial_access_token and 201', async () => {
  const out = await executeAsDcrRegister(
    { dcrEnabled: true, body: { client_name: 'X' }, authorizationHeader: 'Bearer right', initialAccessTokens: ['right'] },
    capturingDeps(),
  );
  assert.equal(out.outcome, 'success');
  assert.equal(out.status, 201);
  assert.equal(out.spineData.registration_access, 'initial_access_token');
});

test('executeAsDcrRegister: an anonymous public caller gets registration_access=public', async () => {
  const out = await executeAsDcrRegister({ dcrEnabled: true, body: { client_name: 'X' }, initialAccessTokens: [] }, capturingDeps());
  assert.equal(out.spineData.registration_access, 'public');
});

test('executeAsDcrRegister: SECURITY — an anonymous caller CANNOT self-tag issuer_subject_id', async () => {
  const deps = capturingDeps();
  await executeAsDcrRegister(
    { dcrEnabled: true, body: { issuer_subject_id: 'ATTACKER', client_name: 'X' }, initialAccessTokens: [] },
    deps,
  );
  const { sanitizedInput, extraMetadata } = deps.calls[0];
  assert.ok(!('issuer_subject_id' in sanitizedInput), 'body issuer_subject_id is stripped');
  assert.deepEqual(extraMetadata, {}, 'no owner stamp for an anonymous caller');
});

test('executeAsDcrRegister: SECURITY — owner session subject is stamped, body value ignored', async () => {
  const deps = capturingDeps();
  const out = await executeAsDcrRegister(
    {
      dcrEnabled: true,
      body: { issuer_subject_id: 'ATTACKER', client_name: 'X' },
      ownerSessionSubjectId: 'real-owner',
      initialAccessTokens: [],
    },
    deps,
  );
  assert.equal(out.spineData.registration_access, 'owner_session');
  const { sanitizedInput, extraMetadata } = deps.calls[0];
  assert.ok(!('issuer_subject_id' in sanitizedInput), 'the attacker-supplied body value is removed');
  assert.deepEqual(extraMetadata, { issuer_subject_id: 'real-owner' }, 'the trusted session subject is stamped instead');
});

test('executeAsDcrRegister: success spine data reflects the registered client shape', async () => {
  const out = await executeAsDcrRegister({ dcrEnabled: true, body: { client_name: 'X' }, initialAccessTokens: [] }, capturingDeps());
  assert.equal(out.spineData.registration_mode, 'dynamic');
  assert.equal(out.spineData.client_name, 'App');
  assert.equal(out.spineData.token_endpoint_auth_method, 'none');
  assert.equal(out.spineData.redirect_uri_count, 1);
});
