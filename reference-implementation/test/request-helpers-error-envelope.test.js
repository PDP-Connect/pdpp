// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure(ish), no-DB unit tests for the PDPP error-envelope + response helpers in
// server/request-helpers.ts, driven with a fake Express-shaped `res`. The envelope
// builder pdppError() is passed as a route dependency by 8 integration tests, and
// its resource_metadata output is asserted only through full-server HTTP tests —
// its pure construction rules (type-by-status, 401-ONLY resource_metadata gate,
// param/extras conditionals) had no direct unit coverage. getProtectedResourceMetadataUrl
// had zero coverage.
//
// Mutation surface:
//   pdppError -- error.type from typeFor(status); param included only when truthy;
//     available_connections/retry_with copied only from a valid extras shape;
//     resource_metadata + next_step attached ONLY on 401 AND when a metadata URL is
//     present in res.locals; request_id always ensured.
//   getProtectedResourceMetadataUrl -- reads res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL],
//     non-string/empty -> null.
//   ensureRequestId -- reuses an existing Request-Id header, else generates + sets one.
//   setReferenceTraceId -- sets the trace header only for a truthy id.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTECTED_RESOURCE_METADATA_URL_LOCAL,
  ensureRequestId,
  getProtectedResourceMetadataUrl,
  pdppError,
  setReferenceTraceId,
} from '../server/request-helpers.ts';

function makeRes() {
  const headers = {};
  return {
    locals: {},
    statusCode: null,
    body: null,
    status(s) {
      this.statusCode = s;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    getHeader(name) {
      return headers[name];
    },
    setHeader(name, value) {
      headers[name] = value;
    },
    _headers: headers,
  };
}

// ---------------------------------------------------------------------------
// pdppError
// ---------------------------------------------------------------------------

test('pdppError: builds a typed envelope with status, code, message and a request_id', () => {
  const res = makeRes();
  pdppError(res, 400, 'invalid_request', 'bad thing', 'field');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.type, 'invalid_request_error', 'type derived from status');
  assert.equal(res.body.error.code, 'invalid_request');
  assert.equal(res.body.error.message, 'bad thing');
  assert.equal(res.body.error.param, 'field', 'param included when truthy');
  assert.ok(typeof res.body.error.request_id === 'string' && res.body.error.request_id, 'request_id ensured');
});

test('pdppError: omits param when not provided', () => {
  const res = makeRes();
  pdppError(res, 404, 'not_found', 'missing');
  assert.equal(res.body.error.type, 'not_found_error');
  assert.ok(!('param' in res.body.error), 'no param key when null');
});

test('pdppError: attaches resource_metadata + next_step ONLY on 401 when a metadata URL is present', () => {
  const res = makeRes();
  res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL] = 'https://as.example/.well-known/oauth-protected-resource';
  pdppError(res, 401, 'expired_token', 'token expired');
  assert.equal(res.body.error.resource_metadata, 'https://as.example/.well-known/oauth-protected-resource');
  assert.ok(typeof res.body.error.next_step === 'string' && res.body.error.next_step.length > 0, 'next_step guidance attached');
});

test('pdppError: does NOT attach resource_metadata on a non-401 even when locals carry a URL', () => {
  const res = makeRes();
  res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL] = 'https://as.example/meta';
  pdppError(res, 403, 'forbidden', 'no access');
  assert.equal(res.body.error.resource_metadata, undefined, '403 must not leak resource_metadata');
  assert.equal(res.body.error.next_step, undefined);
});

test('pdppError: on 401 with NO metadata URL, omits resource_metadata (nothing to point at)', () => {
  const res = makeRes();
  pdppError(res, 401, 'invalid_token', 'nope');
  assert.equal(res.body.error.resource_metadata, undefined);
});

test('pdppError: copies available_connections + retry_with only from a valid extras shape', () => {
  const res = makeRes();
  pdppError(res, 409, 'ambiguous_connection', 'multiple', null, {
    available_connections: [{ connection_id: 'ci-1' }, { connection_id: 'ci-2' }],
    retry_with: 'connection_id',
  });
  assert.deepEqual(res.body.error.available_connections, [{ connection_id: 'ci-1' }, { connection_id: 'ci-2' }]);
  assert.equal(res.body.error.retry_with, 'connection_id');
});

test('pdppError: ignores malformed extras (non-array available_connections, non-string retry_with)', () => {
  const res = makeRes();
  pdppError(res, 409, 'ambiguous_connection', 'multiple', null, {
    available_connections: 'not-an-array',
    retry_with: 42,
  });
  assert.ok(!('available_connections' in res.body.error), 'non-array ignored');
  assert.ok(!('retry_with' in res.body.error), 'non-string ignored');
});

// ---------------------------------------------------------------------------
// getProtectedResourceMetadataUrl
// ---------------------------------------------------------------------------

test('getProtectedResourceMetadataUrl: returns the locals value, or null for missing/empty/non-string', () => {
  const res = makeRes();
  assert.equal(getProtectedResourceMetadataUrl(res), null, 'absent -> null');
  res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL] = 'https://as/meta';
  assert.equal(getProtectedResourceMetadataUrl(res), 'https://as/meta');
  res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL] = '';
  assert.equal(getProtectedResourceMetadataUrl(res), null, 'empty string -> null');
  res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL] = 123;
  assert.equal(getProtectedResourceMetadataUrl(res), null, 'non-string -> null');
});

// ---------------------------------------------------------------------------
// ensureRequestId
// ---------------------------------------------------------------------------

test('ensureRequestId: reuses an existing Request-Id header when present', () => {
  const res = makeRes();
  res.setHeader('Request-Id', '  req_existing  ');
  assert.equal(ensureRequestId(res), 'req_existing', 'trims and reuses');
});

test('ensureRequestId: generates and sets a Request-Id when absent', () => {
  const res = makeRes();
  const id = ensureRequestId(res);
  assert.ok(typeof id === 'string' && id.length > 0, 'a fresh id is returned');
  assert.equal(res.getHeader('Request-Id'), id, 'and stored on the response header');
});

// ---------------------------------------------------------------------------
// setReferenceTraceId
// ---------------------------------------------------------------------------

test('setReferenceTraceId: sets the trace header only for a truthy trace id', () => {
  const res = makeRes();
  setReferenceTraceId(res, 'trace-123');
  assert.equal(res.getHeader('PDPP-Reference-Trace-Id'), 'trace-123');

  const res2 = makeRes();
  setReferenceTraceId(res2, null);
  assert.equal(res2.getHeader('PDPP-Reference-Trace-Id'), undefined, 'no header for a falsy id');
});
