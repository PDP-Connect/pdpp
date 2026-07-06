// Unit tests for the typed-error status/type tables extracted from
// server/index.js into server/routes/ref-error-status.ts. These pin the
// HTTP-status ↔ error-`type`/`code` contract that the typed-error envelopes
// (consumed by external Claude / Daisy / ChatGPT) advertise. Before this
// extraction the tables had no direct unit coverage.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  codeToStatus,
  recoveryAdmissionExtrasForWire,
  typeFor,
} from '../server/routes/ref-error-status.ts';

test('typeFor maps each known HTTP status to its canonical error type', () => {
  assert.equal(typeFor(400), 'invalid_request_error');
  assert.equal(typeFor(401), 'authentication_error');
  assert.equal(typeFor(403), 'permission_error');
  assert.equal(typeFor(404), 'not_found_error');
  assert.equal(typeFor(410), 'gone_error');
  assert.equal(typeFor(429), 'rate_limit_error');
});

test('typeFor falls back to api_error for unmapped statuses (incl. 500/409)', () => {
  assert.equal(typeFor(500), 'api_error');
  assert.equal(typeFor(409), 'api_error');
  assert.equal(typeFor(200), 'api_error');
  assert.equal(typeFor(418), 'api_error');
});

test('codeToStatus pins the acceptance-target typed-error envelope codes', () => {
  // The connection/disambiguation codes external Claude relies on:
  assert.equal(codeToStatus.ambiguous_connection, 409);
  assert.equal(codeToStatus.connection_not_found, 404);
  assert.equal(codeToStatus.insufficient_scope, 403);
  assert.equal(codeToStatus.cursor_expired, 410);
  assert.equal(codeToStatus.blob_not_found, 404);
  assert.equal(codeToStatus.invalid_request, 400);
  assert.equal(codeToStatus.connector_invalid, 400);
});

test('codeToStatus pins grant/auth and connector-instance code statuses', () => {
  for (const code of ['grant_expired', 'grant_revoked', 'grant_consumed', 'grant_invalid', 'field_not_granted', 'connector_instance_owner_mismatch']) {
    assert.equal(codeToStatus[code], 403, `${code} must be 403`);
  }
  assert.equal(codeToStatus.authentication_error, 401);
  assert.equal(codeToStatus.connector_instance_store_required, 500);
  assert.equal(codeToStatus.run_already_active, 409);
});

test('unknown error codes are absent so callers default to 500', () => {
  // The consumer pattern in index.js is `codeToStatus[code] || 500`.
  assert.equal(codeToStatus.this_code_does_not_exist, undefined);
  assert.equal(codeToStatus.this_code_does_not_exist || 500, 500);
  // api_error (the generic fallback code) is intentionally not in the table.
  assert.equal(codeToStatus.api_error, undefined);
});

test('typeFor(codeToStatus[code]) yields the envelope type for each mapped code', () => {
  // Round-trips that the {type,code,message} envelope produces in practice.
  assert.equal(typeFor(codeToStatus.connection_not_found), 'not_found_error');
  assert.equal(typeFor(codeToStatus.insufficient_scope), 'permission_error');
  assert.equal(typeFor(codeToStatus.cursor_expired), 'gone_error');
  assert.equal(typeFor(codeToStatus.invalid_request), 'invalid_request_error');
  // ambiguous_connection is 409 → falls back to api_error type (by design).
  assert.equal(typeFor(codeToStatus.ambiguous_connection), 'api_error');
});

test('recoveryAdmissionExtrasForWire projects controller fields into HTTP envelope names', () => {
  assert.deepEqual(
    recoveryAdmissionExtrasForWire({
      recoveryAdmissionReason: 'cooldown',
      nextEligibleAt: '2026-07-06T16:00:00.000Z',
      pendingPressureGapCount: 3,
    }),
    {
      recovery_admission_reason: 'cooldown',
      next_eligible_at: '2026-07-06T16:00:00.000Z',
      pending_pressure_gap_count: 3,
    },
  );
});

test('recoveryAdmissionExtrasForWire omits malformed fields', () => {
  assert.deepEqual(
    recoveryAdmissionExtrasForWire({
      recoveryAdmissionReason: '',
      nextEligibleAt: null,
      pendingPressureGapCount: -1,
    }),
    {},
  );
});
