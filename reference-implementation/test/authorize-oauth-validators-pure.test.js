// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the OAuth /authorize parameter validators in
// server/routes/as-consent-ui-helpers.ts. These 5 pure functions had ZERO by-name
// coverage (the module's existing tests cover the hosted-MCP picker rendering).
//
// RED note: these are auth-surface validators. The tests only OBSERVE the
// accept/reject decision and the typed OAuth error codes; no token/grant/consent
// state is created or modified.
//
// Mutation surface:
//   validateAuthorizePkce -- response_type MUST be 'code' (else
//     unsupported_response_type), code_challenge_method MUST be 'S256' (else
//     invalid_request), code_challenge length in [43,128] inclusive.
//   requireAuthorizeString -- non-empty string required, trims, invalid_request.
//   parseAuthorizeAuthorizationDetails -- null/'' -> null; array/object passthrough;
//     JSON string must decode to an ARRAY; else invalid_request.
//   requireRegisteredRedirectUri -- exact match OR RFC-8252 loopback (port-flexible)
//     match; else invalid_request.
//   buildHostedMcpAuthorizationDetailsForConnector -- wildcard-stream continuous
//     data-access entry for a connector.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHostedMcpAuthorizationDetailsForConnector,
  parseAuthorizeAuthorizationDetails,
  requireAuthorizeString,
  requireRegisteredRedirectUri,
  validateAuthorizePkce,
} from '../server/routes/as-consent-ui-helpers.ts';

function expectCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// validateAuthorizePkce
// ---------------------------------------------------------------------------

const goodChallenge = 'a'.repeat(43); // minimum valid length

test('validateAuthorizePkce: a valid code/S256/43-char request passes', () => {
  assert.doesNotThrow(() =>
    validateAuthorizePkce({ responseType: 'code', codeChallengeMethod: 'S256', codeChallenge: goodChallenge }),
  );
});

test('validateAuthorizePkce: non-code response_type is unsupported_response_type', () => {
  expectCode(
    () => validateAuthorizePkce({ responseType: 'token', codeChallengeMethod: 'S256', codeChallenge: goodChallenge }),
    'unsupported_response_type',
  );
});

test('validateAuthorizePkce: non-S256 challenge method is invalid_request', () => {
  expectCode(
    () => validateAuthorizePkce({ responseType: 'code', codeChallengeMethod: 'plain', codeChallenge: goodChallenge }),
    'invalid_request',
  );
});

test('validateAuthorizePkce: code_challenge length bounds are 43..128 inclusive', () => {
  const base = { responseType: 'code', codeChallengeMethod: 'S256' };
  // 43 and 128 accepted (inclusive boundaries)
  assert.doesNotThrow(() => validateAuthorizePkce({ ...base, codeChallenge: 'a'.repeat(43) }), 'len 43 ok');
  assert.doesNotThrow(() => validateAuthorizePkce({ ...base, codeChallenge: 'a'.repeat(128) }), 'len 128 ok');
  // 42 and 129 rejected
  expectCode(() => validateAuthorizePkce({ ...base, codeChallenge: 'a'.repeat(42) }), 'invalid_request');
  expectCode(() => validateAuthorizePkce({ ...base, codeChallenge: 'a'.repeat(129) }), 'invalid_request');
  // non-string rejected
  expectCode(() => validateAuthorizePkce({ ...base, codeChallenge: undefined }), 'invalid_request');
});

// ---------------------------------------------------------------------------
// requireAuthorizeString
// ---------------------------------------------------------------------------

test('requireAuthorizeString: returns a trimmed non-empty string', () => {
  assert.equal(requireAuthorizeString({ client_id: '  abc  ' }, 'client_id'), 'abc');
});

test('requireAuthorizeString: missing / blank / non-string is invalid_request', () => {
  expectCode(() => requireAuthorizeString({}, 'client_id'), 'invalid_request');
  expectCode(() => requireAuthorizeString({ client_id: '   ' }, 'client_id'), 'invalid_request');
  expectCode(() => requireAuthorizeString({ client_id: 42 }, 'client_id'), 'invalid_request');
  expectCode(() => requireAuthorizeString(null, 'client_id'), 'invalid_request');
});

// ---------------------------------------------------------------------------
// parseAuthorizeAuthorizationDetails
// ---------------------------------------------------------------------------

test('parseAuthorizeAuthorizationDetails: absent/empty -> null', () => {
  assert.equal(parseAuthorizeAuthorizationDetails({}), null);
  assert.equal(parseAuthorizeAuthorizationDetails({ authorization_details: '' }), null);
  assert.equal(parseAuthorizeAuthorizationDetails(null), null);
});

test('parseAuthorizeAuthorizationDetails: array passes through unchanged', () => {
  const arr = [{ type: 'x' }];
  assert.equal(parseAuthorizeAuthorizationDetails({ authorization_details: arr }), arr);
});

test('parseAuthorizeAuthorizationDetails: a JSON string decoding to an array is parsed', () => {
  const out = parseAuthorizeAuthorizationDetails({ authorization_details: '[{"type":"x"}]' });
  assert.deepEqual(out, [{ type: 'x' }]);
});

test('parseAuthorizeAuthorizationDetails: a JSON string that is NOT an array is invalid_request', () => {
  expectCode(() => parseAuthorizeAuthorizationDetails({ authorization_details: '{"type":"x"}' }), 'invalid_request');
});

test('parseAuthorizeAuthorizationDetails: malformed JSON string is invalid_request', () => {
  expectCode(() => parseAuthorizeAuthorizationDetails({ authorization_details: '[not valid' }), 'invalid_request');
});

// ---------------------------------------------------------------------------
// requireRegisteredRedirectUri
// ---------------------------------------------------------------------------

test('requireRegisteredRedirectUri: exact match passes; anything else is invalid_request', () => {
  const client = { metadata: { redirect_uris: ['https://app.example/cb'] } };
  assert.doesNotThrow(() => requireRegisteredRedirectUri(client, 'https://app.example/cb'));
  expectCode(() => requireRegisteredRedirectUri(client, 'https://evil.example/cb'), 'invalid_request');
});

test('requireRegisteredRedirectUri: no registered URIs always rejects', () => {
  expectCode(() => requireRegisteredRedirectUri({ metadata: {} }, 'https://app.example/cb'), 'invalid_request');
  expectCode(() => requireRegisteredRedirectUri(null, 'https://app.example/cb'), 'invalid_request');
});

test('requireRegisteredRedirectUri: RFC-8252 loopback match ignores the port but not the path', () => {
  const client = { metadata: { redirect_uris: ['http://127.0.0.1:1234/cb'] } };
  // Same loopback host + path, different port -> allowed (native app dynamic port).
  assert.doesNotThrow(() => requireRegisteredRedirectUri(client, 'http://127.0.0.1:55555/cb'));
  // Different PATH on the same loopback host -> rejected.
  expectCode(() => requireRegisteredRedirectUri(client, 'http://127.0.0.1:55555/other'), 'invalid_request');
});

// ---------------------------------------------------------------------------
// buildHostedMcpAuthorizationDetailsForConnector
// ---------------------------------------------------------------------------

test('buildHostedMcpAuthorizationDetailsForConnector: wildcard-stream continuous data-access entry', () => {
  const details = buildHostedMcpAuthorizationDetailsForConnector('gmail');
  assert.equal(details.length, 1);
  const entry = details[0];
  assert.equal(entry.type, 'https://pdpp.org/data-access');
  assert.deepEqual(entry.source, { kind: 'connector', id: 'gmail' });
  assert.equal(entry.access_mode, 'continuous');
  assert.deepEqual(entry.streams, [{ name: '*' }], 'wildcard stream selection');
});
