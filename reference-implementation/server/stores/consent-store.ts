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
} from "../auth.ts";

interface TraceContext {
  readonly [key: string]: unknown;
}

interface InitiateGrantInput {
  readonly [key: string]: unknown;
}

interface InitiateGrantOptions {
  readonly baseUrl?: string;
  readonly scenarioId?: string;
  readonly [key: string]: unknown;
}

interface InitiateGrantResponse {
  readonly authorization_url: string;
  readonly expires_in: number;
  readonly request_uri: string;
  readonly trace_context: TraceContext;
}

interface PendingConsentView {
  readonly [key: string]: unknown;
}

interface ApprovalRow {
  readonly [key: string]: unknown;
}

interface GrantAndToken {
  readonly grant: unknown;
  readonly token: string;
}

interface ConsentStoreOptions {
  readonly [key: string]: unknown;
}

interface ConsentStore {
  approveGrant: (deviceCode: string, subjectId?: string, opts?: ConsentStoreOptions) => Promise<GrantAndToken>;
  denyGrant: (deviceCode: string) => Promise<boolean>;
  getPendingConsentByApprovalId: (approvalId: string) => Promise<ApprovalRow | null>;
  getPendingConsentByDeviceCode: (deviceCode: string, opts?: ConsentStoreOptions) => Promise<PendingConsentView | null>;
  getPendingConsentByRequestUri: (requestUri: string, opts?: ConsentStoreOptions) => Promise<PendingConsentView | null>;
  initiateGrant: (input: InitiateGrantInput, opts?: InitiateGrantOptions) => Promise<InitiateGrantResponse>;
  parseRequestUri: (requestUri: string) => string | null;
}

function isInitiateGrantResponse(
  value: Record<string, unknown>
): value is InitiateGrantResponse & Record<string, unknown> {
  return (
    typeof value.authorization_url === "string" &&
    typeof value.expires_in === "number" &&
    typeof value.request_uri === "string" &&
    value.trace_context !== null &&
    typeof value.trace_context === "object" &&
    !Array.isArray(value.trace_context)
  );
}

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
export function createConsentStore(): ConsentStore {
  return {
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
    approveGrant(deviceCode: string, subjectId?: string, opts?: ConsentStoreOptions): Promise<GrantAndToken> {
      return approveGrant(deviceCode, subjectId, opts) as Promise<GrantAndToken>;
    },

    /**
     * Deny a pending consent. Returns `true` if the row was pending and
     * is now denied, `false` if the row was already terminal/expired
     * (idempotent no-op).
     *
     * @param {string} deviceCode
     * @returns {Promise<boolean>}
     */
    denyGrant(deviceCode: string): Promise<boolean> {
      return denyGrant(deviceCode) as Promise<boolean>;
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
    getPendingConsentByApprovalId(approvalId: string): Promise<ApprovalRow | null> {
      return getPendingConsentRowByApprovalId(approvalId) as Promise<ApprovalRow | null>;
    },

    /**
     * Resolve the public consent view for the given device code. The
     * device code is the redeemable secret; route handlers SHOULD prefer
     * `getPendingConsentByRequestUri` where they have a `request_uri`.
     *
     * @param {string} deviceCode
     * @returns {Promise<object | null>}
     */
    getPendingConsentByDeviceCode(
      deviceCode: string,
      opts: ConsentStoreOptions = {}
    ): Promise<PendingConsentView | null> {
      return getPendingConsent(deviceCode, opts) as Promise<PendingConsentView | null>;
    },

    /**
     * Resolve the public consent view for the given request URI.
     * Returns `null` when the row is not pending (terminal state) or
     * has expired. Used by the consent UI surface.
     *
     * @param {string} requestUri
     * @returns {Promise<object | null>}
     */
    getPendingConsentByRequestUri(
      requestUri: string,
      opts: ConsentStoreOptions = {}
    ): Promise<PendingConsentView | null> {
      const deviceCode = parsePendingConsentRequestUri(requestUri);
      if (deviceCode === null) {
        return Promise.resolve(null);
      }
      return getPendingConsent(deviceCode, opts) as Promise<PendingConsentView | null>;
    },
    /**
     * Stage a third-party data-grant pending-consent request.
     *
     * @param {object} input  client + authorization_details payload
     * @param {object} [opts] reference-side opts (baseUrl, scenarioId, ...)
     * @returns {Promise<{ request_uri: string, authorization_url: string, expires_in: number, trace_context: object }>}
     */
    async initiateGrant(input: InitiateGrantInput, opts: InitiateGrantOptions = {}): Promise<InitiateGrantResponse> {
      const response = await initiateGrant(input, opts);
      if (!isInitiateGrantResponse(response)) {
        throw new Error("initiateGrant returned an invalid pending-consent response");
      }
      return response;
    },

    /**
     * Translate a `urn:ietf:params:oauth:request_uri:...` string back to
     * the underlying device_code. Surfaced from the store so callers do
     * not need to import URI helpers from `auth.js`.
     *
     * @param {string} requestUri
     * @returns {string}
     */
    parseRequestUri(requestUri: string): string | null {
      return parsePendingConsentRequestUri(requestUri) as string | null;
    },
  };
}

export function createSqliteConsentStore(): ConsentStore {
  return createConsentStore();
}
