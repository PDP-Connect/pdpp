import assert from 'node:assert/strict';
import test from 'node:test';

import { codeToStatus } from '../server/routes/ref-error-status.ts';

const EXPECTED = {
  grant_stream_not_allowed: 403,
  grant_expired: 403,
  grant_revoked: 403,
  grant_consumed: 403,
  grant_invalid: 403,
  field_not_granted: 403,
  insufficient_scope: 403,
  connector_instance_owner_mismatch: 403,

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
  connector_instance_connector_mismatch: 400,
  connector_instance_inactive: 400,
  connector_instance_selector_required: 400,
  owner_subject_required: 400,
  unknown_field: 400,
  unsupported_version: 400,
  invalid_status: 400,

  authentication_error: 401,

  connection_not_found: 404,
  field_not_found: 404,
  query_not_found: 404,
  blob_not_found: 404,
  connector_instance_not_found: 404,
  not_found: 404,

  ambiguous_connection: 409,
  ambiguous_schema_detail: 409,
  connection_run_active: 409,
  default_account_delete_unsupported: 409,
  connector_instance_not_revoked: 409,
  run_already_active: 409,
  no_pending_interaction: 409,
  interaction_id_mismatch: 409,

  cursor_expired: 410,

  field_not_text: 422,

  provider_pressure_cooldown: 425,

  connector_instance_store_required: 500,
};

test('codeToStatus maps every pinned error code to its exact HTTP status', () => {
  for (const [code, status] of Object.entries(EXPECTED)) {
    assert.equal(codeToStatus[code], status, `${code} must map to ${status}`);
  }
});

test('codeToStatus has no added or removed codes versus the pinned contract', () => {
  assert.deepEqual(Object.keys(codeToStatus).sort(), Object.keys(EXPECTED).sort());
});

test('codeToStatus contains all 47 committed error codes', () => {
  assert.equal(Object.keys(codeToStatus).length, 47);
});
