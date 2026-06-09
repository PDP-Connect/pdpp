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
  if (status === 429) {
    return "rate_limit_error";
  }
  return "api_error";
}

/**
 * Map a domain error `code` to its HTTP status. Callers default to 500 for any
 * code not listed here (`codeToStatus[code] || 500`). This table is the single
 * source of truth for the status an envelope advertises per error code.
 */
export const codeToStatus: Readonly<Record<string, number>> = {
  grant_stream_not_allowed: 403,
  grant_expired: 403,
  grant_revoked: 403,
  grant_consumed: 403,
  grant_invalid: 403,
  field_not_granted: 403,
  insufficient_scope: 403,
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
  connector_instance_selector_required: 400,
  connector_instance_store_required: 500,
  owner_subject_required: 400,
  unknown_field: 400,
  unsupported_version: 400,
  authentication_error: 401,
  connector_instance_owner_mismatch: 403,
  blob_not_found: 404,
  connector_instance_not_found: 404,
  not_found: 404,
  run_already_active: 409,
  no_pending_interaction: 409,
  interaction_id_mismatch: 409,
  invalid_status: 400,
  cursor_expired: 410,
  // Provider-pressure cooldown is active; the run was not started. The client
  // may retry after `next_eligible_at`. 425 Too Early is the closest standard
  // status for "this request is valid but the server is not ready to act yet."
  provider_pressure_cooldown: 425,
};
