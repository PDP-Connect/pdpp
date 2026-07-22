// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production `ConsentStore` interface and storage-backed implementation.
 *
 * Semantic store seam for the third-party data-grant pending-consent flow.
 * Callers (route handlers, controllers) MUST depend on this interface
 * rather than reaching into raw `pending_consents` SQLite rows, prepared
 * statements, or query builders. The interface speaks lifecycle:
 * initiate → lookup → approve / deny.
 *
 * The implementation wraps the lifecycle helpers in `server/auth.js` so
 * security, token, spine, and grant semantics remain centralized in one
 * module.
 *
 * Spec: openspec/changes/extract-low-risk-reference-stores/specs/
 *       reference-implementation-architecture/spec.md
 */

import {
  approveGrant,
  denyGrant,
  getPendingConsent,
  getPendingConsentRowByApprovalId,
  initiateGrant,
  parsePendingConsentRequestUri,
} from '../auth.js';

/**
 * Construct the storage-backed `ConsentStore`.
 *
 * No arguments: the underlying SQLite handle is owned by `server/db.js` and
 * resolved per-call from inside the `auth.js` lifecycle helpers. The store
 * MUST NOT expose that handle, prepared statements, or table rows to its
 * callers.
 *
 * @returns {ConsentStore}
 */
export function createConsentStore() {
  return {
    /**
     * Stage a third-party data-grant pending-consent request.
     *
     * @param {object} input  client + authorization_details payload
     * @param {object} [opts] reference-side opts (baseUrl, scenarioId, ...)
     * @returns {Promise<{ request_uri: string, authorization_url: string, expires_in: number, trace_context: object }>}
     */
    async initiateGrant(input, opts = {}) {
      return initiateGrant(input, opts);
    },

    /**
     * Resolve the public consent view for the given request URI.
     * Returns `null` when the row is not pending (terminal state) or
     * has expired. Used by the consent UI surface.
     *
     * @param {string} requestUri
     * @returns {Promise<object | null>}
     */
    async getPendingConsentByRequestUri(requestUri, opts = {}) {
      const deviceCode = parsePendingConsentRequestUri(requestUri);
      return getPendingConsent(deviceCode, opts);
    },

    /**
     * Resolve the public consent view for the given device code. The
     * device code is the redeemable secret; route handlers SHOULD prefer
     * `getPendingConsentByRequestUri` where they have a `request_uri`.
     *
     * @param {string} deviceCode
     * @returns {Promise<object | null>}
     */
    async getPendingConsentByDeviceCode(deviceCode, opts = {}) {
      return getPendingConsent(deviceCode, opts);
    },

    /**
     * Resolve the control-plane row for the given approval id. The
     * approval id is the opaque, non-redeemable public handle used by
     * the `_ref/approvals` projection. Returns the raw lifecycle fields
     * (status, grant_id, subject_id, ...) without joining to the live
     * device_code surface; route handlers are responsible for projecting
     * that to a non-leaky shape.
     *
     * @param {string} approvalId
     * @returns {Promise<object | null>}
     */
    async getPendingConsentByApprovalId(approvalId) {
      return getPendingConsentRowByApprovalId(approvalId);
    },

    /**
     * Approve a pending consent and mint the corresponding grant + token.
     * Throws a typed PDPP error (`code: 'not_found' | 'invalid_request' |
     * 'invalid_client'`) when the row is missing, terminal, expired, or
     * fails contract checks against the manifest.
     *
     * @param {string} deviceCode
     * @param {string} [subjectId]  defaults to 'owner_local'
     * @param {object} [opts]       e.g. `ai_training_consented`
     * @returns {Promise<{ grant: object, token: string }>}
     */
    async approveGrant(deviceCode, subjectId, opts) {
      return approveGrant(deviceCode, subjectId, opts);
    },

    /**
     * Deny a pending consent. Returns `true` if the row was pending and
     * is now denied, `false` if the row was already terminal/expired
     * (idempotent no-op).
     *
     * @param {string} deviceCode
     * @returns {Promise<boolean>}
     */
    async denyGrant(deviceCode) {
      return denyGrant(deviceCode);
    },

    /**
     * Translate a `urn:ietf:params:oauth:request_uri:...` string back to
     * the underlying device_code. Surfaced from the store so callers do
     * not need to import URI helpers from `auth.js`.
     *
     * @param {string} requestUri
     * @returns {string}
     */
    parseRequestUri(requestUri) {
      return parsePendingConsentRequestUri(requestUri);
    },
  };
}

export function createSqliteConsentStore() {
  return createConsentStore();
}

/**
 * @typedef {ReturnType<typeof createConsentStore>} ConsentStore
 */
