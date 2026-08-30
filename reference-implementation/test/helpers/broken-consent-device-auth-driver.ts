// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deliberately broken in-memory driver for the consent + owner-device-auth
 * conformance harness. Used to prove falsifiability — i.e. that the harness
 * actually catches realistic regressions instead of being a green-path
 * wrapper.
 *
 * The breaks here are not random. Each one mimics a plausible storage-driver
 * mistake that would compromise the reference's security/lifecycle posture:
 *
 *   1. Pending consent re-approval mints a second result. A driver that does
 *      `mark_approved` without checking the prior status (or that uses an
 *      idempotent UPSERT keyed on device_code) lets the same consent get
 *      re-approved twice. The harness's durable-resume scenario pins this:
 *      the second call may succeed, but it MUST return the persisted result.
 *
 *   2. Owner-device approval collapses a denied row into `not_found`, the
 *      code for an unknown user_code. The polling exchange still reports
 *      `access_denied`, isolating the approval-error discriminator that the
 *      harness must reject.
 *
 *   3. Polling-rate enforcement is missing. A back-to-back poll always
 *      returns `authorization_pending` regardless of how recently the
 *      previous poll was. The harness's "polling faster than the interval
 *      throws slow_down" scenario pins this — under this broken driver
 *      the second rapid poll receives `authorization_pending` instead
 *      of `slow_down`.
 *
 * If the conformance harness is sound, at least one scenario MUST fail
 * when exercised against this broken driver. The `*-falsifiability.test.js`
 * companion file asserts that.
 *
 * The broken driver is test-only and SHALL NOT be used as a production
 * adapter, environment profile, or default drop-in.
 *
 * Spec: openspec/changes/add-consent-device-auth-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

const SAMPLE_CLIENT_ID = "broken_in_memory_client";
const SAMPLE_CONNECTOR_ID = "broken-in-memory://connector";

interface BrokenConsentRow {
  approval_id: string;
  client_id?: string;
  created_at: string;
  device_code?: string;
  expires_at: string;
  grant_id?: string | null;
  interval_seconds?: number;
  last_polled_at?: string | null;
  purpose_code?: string;
  request_uri?: string;
  status: "pending" | "approved" | "denied" | "expired";
  subject_id?: string | null;
  token_id?: string | null;
  user_code?: string;
}
interface BrokenConsentInput {
  client_id?: string;
  interval?: number;
  purpose_code?: string;
}
interface CodedError extends Error {
  code?: string;
}
function codedError(message: string): CodedError {
  return new Error(message) as CodedError;
}

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function userCodeForTest(): string {
  // Six hex chars, like the reference's randomBytes(3).toString('hex').toUpperCase().
  return Math.random().toString(16).slice(2, 8).toUpperCase().padEnd(6, "0");
}

function isPast(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

export function createBrokenInMemoryConsentDeviceAuthDriver() {
  /** @type {Map<string, any>} */
  const pendingConsents = new Map<string, BrokenConsentRow>(); // request_uri -> row
  /** @type {Map<string, string>} */
  const approvalToRequestUri = new Map();
  /** @type {Map<string, any>} */
  const ownerDeviceAuth = new Map<string, BrokenConsentRow>(); // device_code -> row
  /** @type {Map<string, string>} */
  const userCodeToDeviceCode = new Map();
  /** @type {Map<string, string>} */
  const ownerApprovalToDeviceCode = new Map();

  return {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async approveOwnerDeviceAuth(userCode: string) {
      const deviceCode = userCodeToDeviceCode.get(userCode);
      const row = deviceCode ? ownerDeviceAuth.get(deviceCode) : null;
      if (row?.status !== "pending") {
        const err = codedError("Unknown user code");
        err.code = "not_found";
        throw err;
      }
      if (isPast(row.expires_at)) {
        const err = codedError("expired");
        err.code = "not_found";
        throw err;
      }
      const token = genId("tok");
      row.status = "approved";
      row.token_id = token;
      row.subject_id = "owner_local";
      return { access_token: token, expires_in: 60, token_type: "Bearer" };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async approvePendingConsent(requestUri: string) {
      const row = pendingConsents.get(requestUri);
      if (!row) {
        const err = codedError("Unknown device code");
        err.code = "not_found";
        throw err;
      }
      if (isPast(row.expires_at)) {
        const err = codedError("expired");
        err.code = "not_found";
        throw err;
      }
      // BREAK 1: do not check `status` — happily re-approve and re-mint.
      const grantId = genId("grt");
      const token = genId("tok");
      row.status = "approved";
      row.grant_id = grantId;
      row.subject_id = "owner_local";
      return {
        grant: { grant_id: grantId, version: "0.1.0" },
        token,
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async denyOwnerDeviceAuth(userCode: string): Promise<void> {
      // BREAK 2: keep the terminal status so exchange remains correct, but
      // approveOwnerDeviceAuth maps this denied row to not_found instead of
      // approval_conflict.
      const deviceCode = userCodeToDeviceCode.get(userCode);
      if (!deviceCode) {
        return;
      }
      const row = ownerDeviceAuth.get(deviceCode);
      if (row) {
        row.status = "denied";
      }
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async denyPendingConsent(requestUri: string) {
      const row = pendingConsents.get(requestUri);
      if (row?.status !== "pending") {
        return false;
      }
      if (isPast(row.expires_at)) {
        return false;
      }
      row.status = "denied";
      return true;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async exchangeOwnerDeviceCode(input: { client_id?: string; device_code?: string } = {}) {
      const row = input.device_code ? ownerDeviceAuth.get(input.device_code) : null;
      if (!row || row.client_id !== input.client_id) {
        const err = codedError("invalid");
        err.code = "invalid_grant";
        throw err;
      }
      if (row.status === "pending" && isPast(row.expires_at)) {
        const err = codedError("expired");
        err.code = "expired_token";
        throw err;
      }
      if (row.status === "denied") {
        const err = codedError("denied");
        err.code = "access_denied";
        throw err;
      }
      if (row.status === "pending") {
        // BREAK 3: no slow_down enforcement — every poll returns
        // authorization_pending regardless of last_polled_at.
        row.last_polled_at = new Date().toISOString();
        const err = codedError("pending");
        err.code = "authorization_pending";
        throw err;
      }
      return {
        access_token: row.token_id,
        expires_in: 60,
        token_type: "Bearer",
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async forceExpireOwnerDeviceAuth(deviceCode: string): Promise<void> {
      const row = ownerDeviceAuth.get(deviceCode);
      if (!row) {
        return;
      }
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async forceExpirePendingConsent(requestUri: string): Promise<void> {
      const row = pendingConsents.get(requestUri);
      if (!row) {
        return;
      }
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    },

    getRegisteredClientId() {
      return SAMPLE_CLIENT_ID;
    },

    getRegisteredConnectorId() {
      return SAMPLE_CONNECTOR_ID;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async lookupOwnerDeviceAuthByApprovalId(approvalId: string) {
      const deviceCode = ownerApprovalToDeviceCode.get(approvalId);
      if (!deviceCode) {
        return null;
      }
      const row = ownerDeviceAuth.get(deviceCode);
      if (!row) {
        return null;
      }
      return {
        approval_id: row.approval_id,
        client_id: row.client_id,
        status: row.status,
        subject_id: row.subject_id,
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async lookupOwnerDeviceAuthByUserCode(userCode: string) {
      const deviceCode = userCodeToDeviceCode.get(userCode);
      if (!deviceCode) {
        return null;
      }
      const row = ownerDeviceAuth.get(deviceCode);
      if (row?.status !== "pending") {
        return null;
      }
      if (isPast(row.expires_at)) {
        return null;
      }
      return {
        client_id: row.client_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
        interval: row.interval_seconds,
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async lookupPendingConsentByApprovalId(approvalId: string) {
      const requestUri = approvalToRequestUri.get(approvalId);
      if (!requestUri) {
        return null;
      }
      const row = pendingConsents.get(requestUri);
      if (!row) {
        return null;
      }
      return {
        approval_id: row.approval_id,
        grant_id: row.grant_id,
        status: row.status,
        subject_id: row.subject_id,
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async lookupPendingConsentByRequestUri(requestUri: string) {
      const row = pendingConsents.get(requestUri);
      if (!row) {
        return null;
      }
      if (row.status !== "pending") {
        return null;
      }
      if (isPast(row.expires_at)) {
        return null;
      }
      return {
        created_at: row.created_at,
        expires_at: row.expires_at,
        user_code: row.user_code,
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async rewindOwnerDevicePollTimer(deviceCode: string): Promise<void> {
      const row = ownerDeviceAuth.get(deviceCode);
      if (!row) {
        return;
      }
      row.last_polled_at = new Date(Date.now() - (row.interval_seconds ?? 5) * 2 * 1000).toISOString();
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setup() {
      pendingConsents.clear();
      approvalToRequestUri.clear();
      ownerDeviceAuth.clear();
      userCodeToDeviceCode.clear();
      ownerApprovalToDeviceCode.clear();
    },

    // -----------------------------------------------------------------
    // Owner device authorization — break (2): denied approval is reported
    //                              as unknown; break (3): polling is
    //                              unenforced.
    // -----------------------------------------------------------------

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async startOwnerDeviceAuth(input: BrokenConsentInput = {}) {
      const deviceCode = genId("dc_owner");
      const userCode = userCodeForTest();
      const approvalId = genId("appr");
      const row: BrokenConsentRow = {
        approval_id: approvalId,
        client_id: input.client_id || SAMPLE_CLIENT_ID,
        created_at: new Date().toISOString(),
        device_code: deviceCode,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        interval_seconds: input.interval || 5,
        last_polled_at: null,
        status: "pending",
        subject_id: null,
        token_id: null,
        user_code: userCode,
      };
      ownerDeviceAuth.set(deviceCode, row);
      userCodeToDeviceCode.set(userCode, deviceCode);
      ownerApprovalToDeviceCode.set(approvalId, deviceCode);
      const intervalSeconds = row.interval_seconds;
      if (typeof intervalSeconds !== "number") {
        throw new Error("broken owner-device row missing interval");
      }
      return {
        approval_id: approvalId,
        device_code: deviceCode,
        expires_in: 300,
        interval: intervalSeconds,
        user_code: userCode,
      };
    },

    // -----------------------------------------------------------------
    // Pending consent — break (1): re-approval is allowed.
    // -----------------------------------------------------------------

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async startPendingConsent(input: BrokenConsentInput = {}) {
      const requestUri = `urn:pdpp:pending-consent:${genId("dc")}`;
      const approvalId = genId("appr");
      const userCode = userCodeForTest();
      const row: BrokenConsentRow = {
        approval_id: approvalId,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        grant_id: null,
        purpose_code: input.purpose_code || "broken/purpose",
        request_uri: requestUri,
        status: "pending",
        subject_id: null,
        user_code: userCode,
      };
      pendingConsents.set(requestUri, row);
      approvalToRequestUri.set(approvalId, requestUri);
      return { approval_id: approvalId, request_uri: requestUri };
    },

    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    async teardown() {},
  };
}
