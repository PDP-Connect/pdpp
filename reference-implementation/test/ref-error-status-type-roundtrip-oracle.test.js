// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';

import { typeFor, codeToStatus } from '../server/routes/ref-error-status.ts';

function expectedTypeByStatus(status) {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 410:
      return 'gone_error';
    case 429:
      return 'rate_limit_error';
    default:
      return 'api_error';
  }
}

test('typeFor pins the exact public status-to-type map', () => {
  assert.equal(typeFor(400), 'invalid_request_error');
  assert.equal(typeFor(401), 'authentication_error');
  assert.equal(typeFor(403), 'permission_error');
  assert.equal(typeFor(404), 'not_found_error');
  assert.equal(typeFor(410), 'gone_error');
  assert.equal(typeFor(429), 'rate_limit_error');
});

test('typeFor falls back to api_error for unmapped status classes', () => {
  assert.equal(typeFor(409), 'api_error');
  assert.equal(typeFor(422), 'api_error');
  assert.equal(typeFor(425), 'api_error');
  assert.equal(typeFor(500), 'api_error');
  assert.equal(typeFor(200), 'api_error');
  assert.equal(typeFor(418), 'api_error');
});

test('typeFor(codeToStatus[code]) pins every mapped code round trip', () => {
  for (const [code, status] of Object.entries(codeToStatus)) {
    const actualType = typeFor(status);

    assert.equal(typeof actualType, 'string', `${code} (${status}) must produce a string type`);
    assert.notEqual(actualType, '', `${code} (${status}) must produce a non-empty type`);
    assert.equal(
      actualType,
      expectedTypeByStatus(status),
      `${code} (${status}) must round-trip to ${expectedTypeByStatus(status)}`,
    );
  }

  const namedCodeTypes = {
    ambiguous_connection: 'api_error',
    field_not_text: 'api_error',
    provider_pressure_cooldown: 'api_error',
    connector_instance_store_required: 'api_error',
    grant_stream_not_allowed: 'permission_error',
    connection_not_found: 'not_found_error',
    invalid_request: 'invalid_request_error',
    cursor_expired: 'gone_error',
    authentication_error: 'authentication_error',
  };

  for (const [code, expectedType] of Object.entries(namedCodeTypes)) {
    assert.ok(Object.hasOwn(codeToStatus, code), `${code} must be present in codeToStatus`);
    assert.equal(typeFor(codeToStatus[code]), expectedType, `${code} must round-trip to ${expectedType}`);
  }
});
