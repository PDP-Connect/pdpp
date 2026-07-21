/**
 * Mutation-killing completeness test for the `codeToStatus` error-code ->
 * HTTP-status table in `server/routes/ref-error-status.ts`.
 *
 * `ref-error-status.test.js` pins a representative SAMPLE. This suite pins the
 * FULL table: the exact status for every declared code, and the exact set of
 * declared codes. A mutant that changes ANY single code's status (e.g.
 * field_not_text 422->400, provider_pressure_cooldown 425->429), or adds/drops
 * a code, turns red here — including the rare 409/410/422/425/500 statuses the
 * sample test does not individually cover.
 *
 * This is a value-lock on a public contract (the typed-error envelope external
 * Claude / Daisy / ChatGPT consume), so it is intentionally exhaustive.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { codeToStatus, typeFor } from '../server/routes/ref-error-status.ts';

// The full expected code -> status contract. Keep in lockstep with the source
// table; any drift is a deliberate contract change that must update this map.
const EXPECTED = {
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

test('codeToStatus: every declared code maps to its exact expected HTTP status', () => {
  for (const [code, status] of Object.entries(EXPECTED)) {
    assert.equal(codeToStatus[code], status, `${code} must map to ${status}, got ${codeToStatus[code]}`);
  }
});

test('codeToStatus: the declared code SET matches exactly (no additions/removals)', () => {
  const actual = Object.keys(codeToStatus).sort();
  const expected = Object.keys(EXPECTED).sort();
  assert.deepEqual(actual, expected, 'codeToStatus keys drifted from the pinned contract');
});

test('codeToStatus: the rare non-4xx/standard statuses are individually locked', () => {
  // These are the easy-to-miss ones the sample suite does not assert directly.
  assert.equal(codeToStatus.field_not_text, 422, 'unprocessable-entity for non-text field windows');
  assert.equal(codeToStatus.provider_pressure_cooldown, 425, 'Too Early for provider cooldown');
  assert.equal(codeToStatus.cursor_expired, 410, 'Gone for an expired cursor');
  assert.equal(codeToStatus.connector_instance_store_required, 500, 'server-config error');
  // 422 and 425 are NOT among typeFor's explicit statuses, so they fall back to
  // the generic api_error envelope type (documenting the contract seam).
  assert.equal(typeFor(422), 'api_error');
  assert.equal(typeFor(425), 'api_error');
  // 410 IS explicitly mapped.
  assert.equal(typeFor(410), 'gone_error');
});
