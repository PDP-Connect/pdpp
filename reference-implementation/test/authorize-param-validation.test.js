/**
 * Unit coverage for three UNTESTED OAuth `/authorize` parameter validators in
 * `server/routes/as-consent-ui-helpers.ts`. These shape and validate the query
 * params of the consent-authorize step, throwing typed OAuth errors (each with a
 * `.code`) on violation. This test OBSERVES the validation surface; it does not
 * change any consent behavior.
 *
 * Contracts pinned:
 *   - requireAuthorizeString(query, name): returns the TRIMMED value; throws
 *     `invalid_request` ("<name> is required") for missing/blank/non-string.
 *   - validateAuthorizePkce({responseType, codeChallenge, codeChallengeMethod}):
 *     response_type must be "code" (else `unsupported_response_type`);
 *     code_challenge_method must be "S256" (else `invalid_request`);
 *     code_challenge must be a 43..128-char string (else `invalid_request`).
 *   - parseAuthorizeAuthorizationDetails(query): null for absent/empty; passes an
 *     array/object through; parses a JSON-array string; throws `invalid_request`
 *     for a non-string non-object, for a JSON string that isn't an array, and for
 *     unparseable JSON (with the error code coerced to invalid_request).
 *
 * Pure — the module has zero imports. No DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requireAuthorizeString,
  validateAuthorizePkce,
  parseAuthorizeAuthorizationDetails,
} from '../server/routes/as-consent-ui-helpers.ts';

// Assert `fn` throws an Error whose `.code` === code and message includes part.
function assertThrowsCode(fn, code, messagePart) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    if (messagePart !== undefined) {
      assert.ok(String(err.message).includes(messagePart), `message ${JSON.stringify(err.message)} lacks ${JSON.stringify(messagePart)}`);
    }
    return true;
  });
}

// --- requireAuthorizeString -------------------------------------------------

test('requireAuthorizeString: returns the trimmed value for a non-blank string', () => {
  assert.equal(requireAuthorizeString({ client_id: '  abc  ' }, 'client_id'), 'abc');
});

test('requireAuthorizeString: throws invalid_request for missing / blank / non-string', () => {
  assertThrowsCode(() => requireAuthorizeString({}, 'client_id'), 'invalid_request', 'client_id is required');
  assertThrowsCode(() => requireAuthorizeString({ client_id: '   ' }, 'client_id'), 'invalid_request', 'client_id is required');
  assertThrowsCode(() => requireAuthorizeString({ client_id: 42 }, 'client_id'), 'invalid_request', 'client_id is required');
  assertThrowsCode(() => requireAuthorizeString(null, 'client_id'), 'invalid_request', 'client_id is required');
});

// --- validateAuthorizePkce --------------------------------------------------

test('validateAuthorizePkce: accepts response_type=code + S256 + a 43..128 char challenge', () => {
  assert.equal(
    validateAuthorizePkce({ responseType: 'code', codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256' }),
    undefined,
  );
  assert.equal(
    validateAuthorizePkce({ responseType: 'code', codeChallenge: 'a'.repeat(128), codeChallengeMethod: 'S256' }),
    undefined,
    '128 chars is the maximum',
  );
});

test('validateAuthorizePkce: a non-code response_type throws unsupported_response_type', () => {
  assertThrowsCode(
    () => validateAuthorizePkce({ responseType: 'token', codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256' }),
    'unsupported_response_type',
    'response_type must be code',
  );
});

test('validateAuthorizePkce: a non-S256 method throws invalid_request', () => {
  assertThrowsCode(
    () => validateAuthorizePkce({ responseType: 'code', codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'plain' }),
    'invalid_request',
    'code_challenge_method must be S256',
  );
});

test('validateAuthorizePkce: an out-of-range or non-string code_challenge throws invalid_request', () => {
  assertThrowsCode(
    () => validateAuthorizePkce({ responseType: 'code', codeChallenge: 'a'.repeat(42), codeChallengeMethod: 'S256' }),
    'invalid_request',
    'code_challenge must be 43-128 characters',
  );
  assertThrowsCode(
    () => validateAuthorizePkce({ responseType: 'code', codeChallenge: 'a'.repeat(129), codeChallengeMethod: 'S256' }),
    'invalid_request',
    'code_challenge must be 43-128 characters',
  );
  assertThrowsCode(
    () => validateAuthorizePkce({ responseType: 'code', codeChallenge: undefined, codeChallengeMethod: 'S256' }),
    'invalid_request',
    'code_challenge must be 43-128 characters',
  );
});

// --- parseAuthorizeAuthorizationDetails -------------------------------------

test('parseAuthorizeAuthorizationDetails: null for an absent or empty value', () => {
  assert.equal(parseAuthorizeAuthorizationDetails({}), null, 'absent');
  assert.equal(parseAuthorizeAuthorizationDetails({ authorization_details: '' }), null, 'empty string');
  assert.equal(parseAuthorizeAuthorizationDetails({ authorization_details: null }), null, 'null');
});

test('parseAuthorizeAuthorizationDetails: passes an array or object through', () => {
  const arr = [{ type: 'pdpp_read' }];
  assert.equal(parseAuthorizeAuthorizationDetails({ authorization_details: arr }), arr, 'array passthrough (same ref)');
  const obj = { type: 'pdpp_read' };
  assert.equal(parseAuthorizeAuthorizationDetails({ authorization_details: obj }), obj, 'object passthrough (same ref)');
});

test('parseAuthorizeAuthorizationDetails: parses a JSON-array string', () => {
  assert.deepEqual(
    parseAuthorizeAuthorizationDetails({ authorization_details: '[{"type":"pdpp_read"}]' }),
    [{ type: 'pdpp_read' }],
  );
});

test('parseAuthorizeAuthorizationDetails: a JSON string that is not an array throws invalid_request', () => {
  assertThrowsCode(
    () => parseAuthorizeAuthorizationDetails({ authorization_details: '{"type":"pdpp_read"}' }),
    'invalid_request',
    'authorization_details must decode to an array',
  );
});

test('parseAuthorizeAuthorizationDetails: unparseable JSON throws with code coerced to invalid_request', () => {
  assertThrowsCode(
    () => parseAuthorizeAuthorizationDetails({ authorization_details: 'not json at all' }),
    'invalid_request',
  );
});

test('parseAuthorizeAuthorizationDetails: a non-string non-object (number) throws invalid_request', () => {
  assertThrowsCode(
    () => parseAuthorizeAuthorizationDetails({ authorization_details: 42 }),
    'invalid_request',
    'authorization_details must be JSON',
  );
});
