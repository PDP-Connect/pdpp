/**
 * Production `OwnerDeviceAuthStore` interface and SQLite-backed implementation.
 *
 * Semantic store seam for the RFC 8628-shaped owner device-authorization
 * flow. Callers (route handlers, controllers) MUST depend on this interface
 * rather than reaching into raw `owner_device_auth` SQLite rows, prepared
 * statements, or query builders. The interface speaks lifecycle:
 * initiate → poll exchange → approve / deny.
 *
 * The SQLite implementation here is the single runtime adapter. It wraps
 * the lifecycle helpers in `server/auth.js` so polling-interval, token
 * issuance, and spine semantics remain centralized in one module.
 *
 * Spec: openspec/changes/extract-low-risk-reference-stores/specs/
 *       reference-implementation-architecture/spec.md
 */

import {
  approveOwnerDeviceAuthorization,
  denyOwnerDeviceAuthorization,
  exchangeOwnerDeviceCode,
  getOwnerDeviceAuthorizationByUserCode,
  getOwnerDeviceAuthRowByApprovalId,
  initiateOwnerDeviceAuthorization,
} from '../auth.js';

/**
 * Construct the SQLite-backed `OwnerDeviceAuthStore`.
 *
 * No arguments: the underlying SQLite handle is owned by `server/db.js` and
 * resolved per-call from inside the `auth.js` lifecycle helpers. The store
 * MUST NOT expose that handle, prepared statements, or table rows to its
 * callers.
 *
 * @returns {OwnerDeviceAuthStore}
 */
export function createSqliteOwnerDeviceAuthStore() {
  return {
    /**
     * Initiate an owner device-authorization request and return the
     * RFC 8628-shaped envelope (device_code, user_code, verification_uri,
     * verification_uri_complete, interval, expires_in, trace_context).
     *
     * @param {string} clientId
     * @param {object} [opts]  baseUrl, expiresIn, interval, scenarioId
     * @returns {Promise<object>}
     */
    async initiate(clientId, opts) {
      return initiateOwnerDeviceAuthorization(clientId, opts);
    },

    /**
     * Resolve the public verification-UI view for the given user_code.
     * Returns `null` when the row is not pending (terminal state) or
     * has expired. The view exposes only the fields the verification UI
     * needs (no token, no device_code, no subject).
     *
     * @param {string} userCode
     * @returns {Promise<object | null>}
     */
    async getByUserCode(userCode) {
      return getOwnerDeviceAuthorizationByUserCode(userCode);
    },

    /**
     * Resolve the control-plane row for the given approval id. The
     * approval id is the opaque, non-redeemable public handle used by
     * the `_ref/approvals` projection. Returns the raw lifecycle fields
     * (status, client_id, subject_id, ...); route handlers are
     * responsible for projecting that to a non-leaky shape.
     *
     * @param {string} approvalId
     * @returns {Promise<object | null>}
     */
    async getByApprovalId(approvalId) {
      return getOwnerDeviceAuthRowByApprovalId(approvalId);
    },

    /**
     * Approve an owner device-authorization and mint an owner token.
     * Throws a typed PDPP error (`code: 'not_found' | 'invalid_client'`)
     * when the row is missing, terminal, expired, or bound to an unknown
     * client.
     *
     * @param {string} userCode
     * @param {string} [subjectId]  defaults to 'owner_local'
     * @returns {Promise<{ access_token: string, token_type: 'Bearer', expires_in: number, subject_id: string }>}
     */
    async approve(userCode, subjectId) {
      return approveOwnerDeviceAuthorization(userCode, subjectId);
    },

    /**
     * Deny an owner device-authorization. Throws a typed PDPP error
     * (`code: 'not_found'`) when the row is missing or terminal.
     * Idempotency for already-denied rows is route-level: the harness
     * does not re-deny, and `exchangeDeviceCode` is the surface that
     * reads `access_denied` for already-denied rows.
     *
     * @param {string} userCode
     * @param {string} [subjectId]  defaults to 'owner_local'
     * @returns {Promise<void>}
     */
    async deny(userCode, subjectId) {
      return denyOwnerDeviceAuthorization(userCode, subjectId);
    },

    /**
     * Polling token exchange. Throws a typed PDPP error with `.code` ∈
     * {`authorization_pending`, `slow_down`, `access_denied`,
     * `expired_token`, `invalid_grant`, `invalid_client`,
     * `invalid_request`} when the grant is not redeemable.
     *
     * @param {{ clientId: string, deviceCode: string }} input
     * @returns {Promise<{ access_token: string, token_type: 'Bearer', expires_in: number, trace_context: object | null }>}
     */
    async exchangeDeviceCode({ clientId, deviceCode }) {
      return exchangeOwnerDeviceCode({ clientId, deviceCode });
    },
  };
}

/**
 * @typedef {ReturnType<typeof createSqliteOwnerDeviceAuthStore>} OwnerDeviceAuthStore
 */
