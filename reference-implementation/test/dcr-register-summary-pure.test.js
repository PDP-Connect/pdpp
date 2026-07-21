// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for summarizeDcrRegisterRequest in
// operations/as-dcr-register/index.ts. No test imports it by name. This pure
// function projects a Dynamic Client Registration request body into the audit
// summary embedded in the spine event for the registration attempt — so a
// regression silently corrupts the audit record of what was requested.
//
// Mutation surface:
//   - requested_client_name: string or null.
//   - requested_token_endpoint_auth_method: string or null.
//   - requested_redirect_uri_count: redirect_uris.length, or 0 when not an array.
//   - requested_metadata_fields: SORTED keys of the (object) body; [] for non-object.

import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeDcrRegisterRequest } from '../operations/as-dcr-register/index.ts';

test('summarizeDcrRegisterRequest: extracts client_name, auth method, redirect count, and sorted keys', () => {
  const summary = summarizeDcrRegisterRequest({
    client_name: 'My App',
    token_endpoint_auth_method: 'none',
    redirect_uris: ['https://a/cb', 'https://b/cb', 'https://c/cb'],
  });
  assert.equal(summary.requested_client_name, 'My App');
  assert.equal(summary.requested_token_endpoint_auth_method, 'none');
  assert.equal(summary.requested_redirect_uri_count, 3, 'counts the redirect URIs');
  assert.deepEqual(
    summary.requested_metadata_fields,
    ['client_name', 'redirect_uris', 'token_endpoint_auth_method'],
    'keys sorted ascending',
  );
});

test('summarizeDcrRegisterRequest: non-string client_name / auth method become null', () => {
  const summary = summarizeDcrRegisterRequest({ client_name: 42, token_endpoint_auth_method: {} });
  assert.equal(summary.requested_client_name, null);
  assert.equal(summary.requested_token_endpoint_auth_method, null);
});

test('summarizeDcrRegisterRequest: a non-array redirect_uris yields a count of 0', () => {
  assert.equal(summarizeDcrRegisterRequest({ redirect_uris: 'https://single' }).requested_redirect_uri_count, 0);
  assert.equal(summarizeDcrRegisterRequest({}).requested_redirect_uri_count, 0, 'absent redirect_uris -> 0');
});

test('summarizeDcrRegisterRequest: metadata field keys are sorted regardless of input order', () => {
  const summary = summarizeDcrRegisterRequest({ zeta: 1, alpha: 2, mid: 3 });
  assert.deepEqual(summary.requested_metadata_fields, ['alpha', 'mid', 'zeta']);
});

test('summarizeDcrRegisterRequest: a non-object / null / array body yields an empty summary', () => {
  for (const body of [null, undefined, 'string', 42, ['a', 'b']]) {
    const summary = summarizeDcrRegisterRequest(body);
    assert.equal(summary.requested_client_name, null, `client_name null for ${JSON.stringify(body)}`);
    assert.equal(summary.requested_token_endpoint_auth_method, null);
    assert.equal(summary.requested_redirect_uri_count, 0);
    assert.deepEqual(summary.requested_metadata_fields, [], 'no fields for a non-object body');
  }
});

test('summarizeDcrRegisterRequest: an empty-object body has no fields but valid null/zero shape', () => {
  const summary = summarizeDcrRegisterRequest({});
  assert.deepEqual(summary, {
    requested_client_name: null,
    requested_token_endpoint_auth_method: null,
    requested_redirect_uri_count: 0,
    requested_metadata_fields: [],
  });
});
