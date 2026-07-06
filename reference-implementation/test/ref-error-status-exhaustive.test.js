// Exhaustive lock on the typed-error status/type tables in
// server/routes/ref-error-status.ts.
//
// The companion file ref-error-status.test.js spot-checks the acceptance-target
// codes external Claude/Daisy/ChatGPT rely on. THIS file pins the WHOLE
// contract: every code→status entry by name, the exact table size (so a stray
// added or dropped entry is caught), and the type mapping for every status the
// table can produce. Any single-code status flip, an off-by-one on the "425 Too
// Early" cooldown, or a change to the api_error fallback boundary fails here.
//
// Rationale: `codeToStatus` is the single source of truth consumed as
// `codeToStatus[code] ?? 500` across index.js and seven owner-connection route
// modules; a silent status drift changes the HTTP contract every typed-error
// envelope advertises without any route test necessarily noticing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { codeToStatus, typeFor } from '../server/routes/ref-error-status.ts';

// The canonical, full expected table. Kept as a literal (not derived from the
// module) so a mutation to the source cannot be masked by deriving from it.
const EXPECTED_CODE_TO_STATUS = {
  grant_stream_not_allowed: 403,
  grant_expired: 403,
  grant_revoked: 403,
  grant_consumed: 403,
  grant_invalid: 403,
  field_not_granted: 403,
  insufficient_scope: 403,
  invalid_field_path: 400,
  invalid_window: 400,
  invalid_argument: 400,
  invalid_cursor: 400,
  invalid_request: 400,
  invalid_client: 400,
  invalid_client_metadata: 400,
  connector_invalid: 400,
  invalid_record: 400,
  invalid_record_identity: 400,
  invalid_expand: 400,
  invalid_sort: 400,
  ambiguous_connector_instance: 400,
  ambiguous_connection: 409,
  ambiguous_schema_detail: 409,
  connection_not_found: 404,
  connection_run_active: 409,
  default_account_delete_unsupported: 409,
  connector_instance_connector_mismatch: 400,
  connector_instance_inactive: 400,
  connector_instance_not_revoked: 409,
  connector_instance_selector_required: 400,
  connector_instance_store_required: 500,
  owner_subject_required: 400,
  unknown_field: 400,
  unsupported_version: 400,
  authentication_error: 401,
  connector_instance_owner_mismatch: 403,
  field_not_found: 404,
  query_not_found: 404,
  blob_not_found: 404,
  connector_instance_not_found: 404,
  not_found: 404,
  field_not_text: 422,
  run_already_active: 409,
  no_pending_interaction: 409,
  interaction_id_mismatch: 409,
  invalid_status: 400,
  cursor_expired: 410,
  provider_pressure_cooldown: 425,
};

test('codeToStatus contains exactly the canonical set of codes (no additions or drops)', () => {
  const actualKeys = Object.keys(codeToStatus).sort();
  const expectedKeys = Object.keys(EXPECTED_CODE_TO_STATUS).sort();
  assert.deepEqual(actualKeys, expectedKeys, 'the set of error codes must match exactly');
  assert.equal(
    Object.keys(codeToStatus).length,
    Object.keys(EXPECTED_CODE_TO_STATUS).length,
    'the table size must not drift',
  );
});

test('every code maps to its exact canonical HTTP status', () => {
  for (const [code, status] of Object.entries(EXPECTED_CODE_TO_STATUS)) {
    assert.equal(codeToStatus[code], status, `${code} must map to ${status}`);
  }
});

test('the 403 permission family is complete and none leak a different status', () => {
  const expected403 = Object.entries(EXPECTED_CODE_TO_STATUS)
    .filter(([, s]) => s === 403)
    .map(([c]) => c)
    .sort();
  const actual403 = Object.entries(codeToStatus)
    .filter(([, s]) => s === 403)
    .map(([c]) => c)
    .sort();
  assert.deepEqual(actual403, expected403, 'the 403 set must be exactly the grant/scope/ownership codes');
});

test('provider_pressure_cooldown holds the unusual 425 Too Early status', () => {
  // A cooldown is a valid-but-not-yet-actionable request; 425 is deliberate and
  // must not be normalized to 429/503.
  assert.equal(codeToStatus.provider_pressure_cooldown, 425);
  // 425 is not in typeFor's known-status set, so its envelope type is api_error.
  assert.equal(typeFor(codeToStatus.provider_pressure_cooldown), 'api_error');
});

test('field_not_text is a 422 (well-formed request, unprocessable field), not a 400', () => {
  assert.equal(codeToStatus.field_not_text, 422);
});

test('typeFor produces the right envelope type for every status the table emits', () => {
  const statusToType = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    409: 'api_error', // 409 is deliberately not a distinct type
    410: 'gone_error',
    422: 'api_error', // 422 has no distinct type; falls back
    425: 'api_error',
    500: 'api_error',
  };
  const statusesInTable = new Set(Object.values(EXPECTED_CODE_TO_STATUS));
  for (const status of statusesInTable) {
    assert.ok(status in statusToType, `test must cover status ${status}`);
    assert.equal(typeFor(status), statusToType[status], `status ${status} → ${statusToType[status]}`);
  }
});

test('typeFor is exhaustive over its distinct-type statuses and falls back otherwise', () => {
  // The six statuses that map to a NON-generic type — flipping any of these
  // return values changes the type every envelope at that status advertises.
  assert.equal(typeFor(400), 'invalid_request_error');
  assert.equal(typeFor(401), 'authentication_error');
  assert.equal(typeFor(403), 'permission_error');
  assert.equal(typeFor(404), 'not_found_error');
  assert.equal(typeFor(410), 'gone_error');
  assert.equal(typeFor(429), 'rate_limit_error');
  // Everything else is the generic api_error.
  for (const status of [200, 402, 409, 418, 422, 425, 500, 503]) {
    assert.equal(typeFor(status), 'api_error', `status ${status} falls back to api_error`);
  }
});
