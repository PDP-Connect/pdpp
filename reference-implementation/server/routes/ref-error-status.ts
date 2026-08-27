// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Typed-error status/type tables for the reference resource server.
//
// Pure, dependency-free lookup tables extracted from `server/index.js` under
// the `split-reference-server-by-route-family` pattern. These encode the
// HTTP-status ↔ error-`type`/`code` contract that EVERY typed-error envelope
// the public read/MCP surface emits depends on (the envelopes external Claude /
// Daisy / ChatGPT consume): e.g. `ambiguous_connection → 409`,
// `connection_not_found → 404`, `insufficient_scope → 403`,
// `cursor_expired → 410`. Kept side-effect-free and closure-free so they are
// unit-testable in isolation and safe to import anywhere; the impure response
// shapers (`pdppError`/`handleError`/`oauthError`) remain in `index.js`.

/**
 * Map an HTTP status code to the canonical top-level error `type` used in the
 * `{ error: { type, code, message } }` envelope. Unknown statuses fall back to
 * the generic `api_error` (paired with HTTP 500 by callers).
 */
export function typeFor(status: number): string {
  if (status === 400) {
    return "invalid_request_error";
  }
  if (status === 401) {
    return "authentication_error";
  }
  if (status === 403) {
    return "permission_error";
  }
  if (status === 404) {
    return "not_found_error";
  }
  if (status === 410) {
    return "gone_error";
  }
  if (status === 413) {
    return "request_entity_too_large_error";
  }
  if (status === 429) {
    return "rate_limit_error";
  }
  return "api_error";
}

export interface RecoveryAdmissionWireExtras {
  readonly next_eligible_at?: string;
  readonly pending_pressure_gap_count?: number;
  readonly recovery_admission_reason?: string;
}

/**
 * Project controller recovery-admission facts onto the public typed-error
 * envelope. The controller uses camelCase internal fields; the HTTP envelope
 * uses snake_case so clients can react without parsing prose.
 */
export function recoveryAdmissionExtrasForWire(err: unknown): RecoveryAdmissionWireExtras {
  const source = err as
    | {
        recoveryAdmissionReason?: unknown;
        nextEligibleAt?: unknown;
        pendingPressureGapCount?: unknown;
      }
    | null
    | undefined;
  const extras: {
    next_eligible_at?: string;
    pending_pressure_gap_count?: number;
    recovery_admission_reason?: string;
  } = {};
  if (typeof source?.recoveryAdmissionReason === "string" && source.recoveryAdmissionReason) {
    extras.recovery_admission_reason = source.recoveryAdmissionReason;
  }
  if (typeof source?.nextEligibleAt === "string" && source.nextEligibleAt) {
    extras.next_eligible_at = source.nextEligibleAt;
  }
  if (
    typeof source?.pendingPressureGapCount === "number" &&
    Number.isFinite(source.pendingPressureGapCount) &&
    source.pendingPressureGapCount >= 0
  ) {
    extras.pending_pressure_gap_count = source.pendingPressureGapCount;
  }
  return extras;
}

/**
 * Map a domain error `code` to its HTTP status. Callers default to 500 for any
 * code not listed here (`codeToStatus[code] || 500`). This table is the single
 * source of truth for the status an envelope advertises per error code.
 */
export const codeToStatus: Readonly<Record<string, number>> = {
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
  // A revision exists but is not in a state the requested transition allows
  // (e.g. confirming an already-active or superseded revision).
  connector_instance_config_not_proposed: 409,
  connector_instance_config_revision_not_found: 404,
  // The caller's `base_revision`/`base_epoch` did not match the connection's
  // current pointer. 409 matches how every other optimistic-concurrency and
  // wrong-state conflict in this table is reported (`approval_conflict`,
  // `interaction_id_mismatch`, `static_secret_identity_conflict`). The caller
  // must rebase against the returned current revision and retry — the store
  // never merges and never last-write-wins.
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
  // only). Unmapped codes fall through to 500 (`codeToStatus[code] || 500` in
  // index.ts / request-helpers.ts), which would show the owner an opaque
  // server error for something he can fix in the form — so it is mapped here
  // deliberately, alongside its sibling `owner_subject_required: 400`.
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
  // Provider-pressure cooldown is active; the run was not started. The client
  // may retry after `next_eligible_at`. 425 Too Early is the closest standard
  // status for "this request is valid but the server is not ready to act yet."
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
