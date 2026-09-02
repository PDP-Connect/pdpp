// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Exhaustive mutation-killing pin of the public code -> HTTP-status contract in
 * server/routes/ref-error-status.ts.
 *
 * The existing `ref-error-status.test.js` spot-checks a subset of the
 * `codeToStatus` table (the disambiguation/grant/auth codes external Claude
 * relies on). That leaves many mapped codes unpinned — e.g. `field_not_text`
 * (422), `provider_pressure_cooldown` (425), `unsupported_version` (400),
 * `query_not_found` (404), the `connection_run_active`/`connector_instance_*`
 * 409/400 family. A mutation that flips any unpinned entry's status, or that
 * adds/removes an entry, would ship undetected.
 *
 * This test pins the WHOLE table as an exact snapshot: every code maps to its
 * declared status, no extra codes are present, and none are missing. It is the
 * single assertion that a status mutation anywhere in the public error contract
 * MUST break. It complements (does not replace) the semantic spot-checks in
 * `ref-error-status.test.js`.
 *
 * When the public error contract intentionally changes, this snapshot is the
 * one place that must be updated in lockstep — a deliberate speed bump on the
 * externally-observable status contract.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { codeToStatus, typeFor } from "../server/routes/ref-error-status.ts";

// The authoritative code -> status contract. Kept in exact lockstep with
// `codeToStatus` in server/routes/ref-error-status.ts.
const EXPECTED_CODE_TO_STATUS = {
  ambiguous_connection: 409,
  ambiguous_connector_instance: 400,
  ambiguous_schema_detail: 409,
  approval_conflict: 409,
  archive_reconnect_resume_failed: 502,
  authentication_error: 401,
  blob_not_found: 404,
  browser_enrollment_shell_required: 400,
  connection_is_grouping_canonical: 409,
  connection_not_found: 404,
  connection_run_active: 409,
  connection_tombstoned: 409,
  connector_instance_busy: 503,
  // The three config-revision codes. `stale_write` is a propose() whose
  // baseRevision/baseEpoch missed the current pointer, and `not_proposed` is a
  // confirm() against a revision that is not awaiting confirmation -- both are
  // well-formed requests the world moved underneath, so they join the other
  // 409s (approval_conflict, static_secret_identity_conflict) rather than
  // becoming 400s. `revision_not_found` is a plain missing resource.
  connector_instance_config_not_proposed: 409,
  connector_instance_config_revision_not_found: 404,
  connector_instance_config_stale_write: 409,
  connector_instance_connector_mismatch: 400,
  connector_instance_inactive: 400,
  connector_instance_not_active: 409,
  connector_instance_not_found: 404,
  connector_instance_not_paused: 409,
  connector_instance_not_revoked: 409,
  connector_instance_not_writable: 409,
  connector_instance_owner_mismatch: 403,
  connector_instance_selector_required: 400,
  connector_instance_store_required: 500,
  connector_invalid: 400,
  // The submitted value cannot be a secret (mask, placeholder, or whitespace
  // only). 400 because it is the owner's to correct in the form, not a server
  // fault — an unmapped code would fall through to 500 and read as our failure.
  credential_secret_invalid: 400,
  cursor_expired: 410,
  default_account_delete_unsupported: 409,
  field_not_found: 404,
  field_not_granted: 403,
  field_not_text: 422,
  grant_consumed: 403,
  grant_expired: 403,
  grant_invalid: 403,
  grant_revoked: 403,
  grant_stream_not_allowed: 403,
  ingest_batch_storage_error: 503,
  insufficient_scope: 403,
  interaction_id_mismatch: 409,
  invalid_argument: 400,
  invalid_authorization_details: 400,
  invalid_client: 400,
  invalid_client_metadata: 400,
  invalid_cursor: 400,
  invalid_expand: 400,
  invalid_field_path: 400,
  invalid_record: 400,
  invalid_record_identity: 400,
  invalid_request: 400,
  invalid_sort: 400,
  invalid_status: 400,
  invalid_window: 400,
  local_device_control_unsupported: 409,
  no_pending_interaction: 409,
  not_found: 404,
  owner_subject_required: 400,
  provider_pressure_cooldown: 425,
  query_not_found: 404,
  resource_limit: 413,
  run_already_active: 409,
  run_not_writable: 409,
  run_owner_mismatch: 403,
  run_terminal: 503,
  source_webhook_event_conflict: 409,
  "source.authorization_details_invalid": 400,
  static_secret_binding_invalid: 409,
  static_secret_draft_required: 409,
  static_secret_identity_ambiguous: 409,
  static_secret_identity_conflict: 409,
  static_secret_identity_mismatch: 409,
  static_secret_identity_missing: 502,
  static_secret_identity_revoked: 409,
  static_secret_identity_unavailable: 503,
  static_secret_identity_unverified_replacement: 409,
  stream_not_declared: 404,
  unknown_field: 400,
  unsupported_version: 400,
};

test("codeToStatus is an exact snapshot of the public code -> status contract", () => {
  // 1. No entry is missing and none has drifted.
  for (const [code, status] of Object.entries(EXPECTED_CODE_TO_STATUS)) {
    assert.equal(codeToStatus[code], status, `code ${code} SHALL map to HTTP ${status}`);
  }
  // 2. No entry has been added that this snapshot does not know about.
  const actualCodes = Object.keys(codeToStatus).sort();
  const expectedCodes = Object.keys(EXPECTED_CODE_TO_STATUS).sort();
  assert.deepEqual(
    actualCodes,
    expectedCodes,
    "codeToStatus key set SHALL match the pinned contract exactly (no added/removed codes)"
  );
});

test("every mapped status resolves to a defined canonical envelope type", () => {
  // typeFor is total: even the 409/422/425 codes (which fall back to api_error)
  // MUST yield a non-empty type string, since it becomes error.type on the wire.
  for (const [code, status] of Object.entries(EXPECTED_CODE_TO_STATUS)) {
    const type = typeFor(status);
    assert.equal(typeof type, "string", `typeFor(${status}) for ${code} SHALL be a string`);
    assert.ok(type.length > 0, `typeFor(${status}) for ${code} SHALL be non-empty`);
  }
});

test("the three formerly-uncovered codes carry their declared statuses", () => {
  // Regression anchors for owner_subject_required / query_not_found /
  // unsupported_version, whose emission paths this worker pinned separately.
  assert.equal(codeToStatus.owner_subject_required, 400);
  assert.equal(codeToStatus.query_not_found, 404);
  assert.equal(codeToStatus.unsupported_version, 400);
  assert.equal(typeFor(codeToStatus.query_not_found), "not_found_error");
  assert.equal(typeFor(codeToStatus.unsupported_version), "invalid_request_error");
});
