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
 *   1. Pending consent re-approval is allowed. A driver that does
 *      `mark_approved` without checking the prior status (or that uses an
 *      idempotent UPSERT keyed on device_code) lets the same consent get
 *      re-approved twice. The harness's "approval is terminal" scenario
 *      pins this — under this broken driver it MUST fail because the
 *      second approval call succeeds and re-mints a grant.
 *
 *   2. Owner-device denial does not transition the row to a terminal
 *      `denied` status; it simply removes the public-lookup entry. The
 *      polling exchange therefore reports `authorization_pending` (the
 *      poller never learns the request was denied). The harness's
 *      "denial is terminal — exchange throws access_denied" scenario
 *      pins this — under this broken driver it MUST fail because the
 *      exchange does not return `access_denied`.
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

const SAMPLE_CLIENT_ID = 'broken_in_memory_client';
const SAMPLE_CONNECTOR_ID = 'broken-in-memory://connector';

function genId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function userCodeForTest() {
  // Six hex chars, like the reference's randomBytes(3).toString('hex').toUpperCase().
  return Math.random().toString(16).slice(2, 8).toUpperCase().padEnd(6, '0');
}

function isPast(iso) {
  return new Date(iso).getTime() <= Date.now();
}

export function createBrokenInMemoryConsentDeviceAuthDriver() {
  /** @type {Map<string, any>} */
  const pendingConsents = new Map(); // request_uri -> row
  /** @type {Map<string, string>} */
  const approvalToRequestUri = new Map();
  /** @type {Map<string, any>} */
  const ownerDeviceAuth = new Map(); // device_code -> row
  /** @type {Map<string, string>} */
  const userCodeToDeviceCode = new Map();
  /** @type {Map<string, string>} */
  const ownerApprovalToDeviceCode = new Map();

  return {
    async setup() {
      pendingConsents.clear();
      approvalToRequestUri.clear();
      ownerDeviceAuth.clear();
      userCodeToDeviceCode.clear();
      ownerApprovalToDeviceCode.clear();
    },

    async teardown() {},

    getRegisteredClientId() {
      return SAMPLE_CLIENT_ID;
    },

    getRegisteredConnectorId() {
      return SAMPLE_CONNECTOR_ID;
    },

    // -----------------------------------------------------------------
    // Pending consent — break (1): re-approval is allowed.
    // -----------------------------------------------------------------

    async startPendingConsent(input = {}) {
      const requestUri = `urn:pdpp:pending-consent:${genId('dc')}`;
      const approvalId = genId('appr');
      const userCode = userCodeForTest();
      const row = {
        status: 'pending',
        request_uri: requestUri,
        approval_id: approvalId,
        user_code: userCode,
        purpose_code: input.purpose_code || 'broken/purpose',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        grant_id: null,
        subject_id: null,
      };
      pendingConsents.set(requestUri, row);
      approvalToRequestUri.set(approvalId, requestUri);
      return { request_uri: requestUri, approval_id: approvalId };
    },

    async lookupPendingConsentByRequestUri(requestUri) {
      const row = pendingConsents.get(requestUri);
      if (!row) return null;
      if (row.status !== 'pending') return null;
      if (isPast(row.expires_at)) return null;
      return {
        user_code: row.user_code,
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
    },

    async lookupPendingConsentByApprovalId(approvalId) {
      const requestUri = approvalToRequestUri.get(approvalId);
      if (!requestUri) return null;
      const row = pendingConsents.get(requestUri);
      if (!row) return null;
      return {
        status: row.status,
        approval_id: row.approval_id,
        grant_id: row.grant_id,
        subject_id: row.subject_id,
      };
    },

    async approvePendingConsent(requestUri) {
      const row = pendingConsents.get(requestUri);
      if (!row) {
        const err = new Error('Unknown device code');
        err.code = 'not_found';
        throw err;
      }
      if (isPast(row.expires_at)) {
        const err = new Error('expired');
        err.code = 'not_found';
        throw err;
      }
      // BREAK 1: do not check `status` — happily re-approve and re-mint.
      const grantId = genId('grt');
      const token = genId('tok');
      row.status = 'approved';
      row.grant_id = grantId;
      row.subject_id = 'owner_local';
      return {
        grant: { grant_id: grantId, version: '0.1.0' },
        token,
      };
    },

    async denyPendingConsent(requestUri) {
      const row = pendingConsents.get(requestUri);
      if (!row || row.status !== 'pending') return false;
      if (isPast(row.expires_at)) return false;
      row.status = 'denied';
      return true;
    },

    async forceExpirePendingConsent(requestUri) {
      const row = pendingConsents.get(requestUri);
      if (!row) return;
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    },

    // -----------------------------------------------------------------
    // Owner device authorization — break (2): denial is silent;
    //                              break (3): polling is unenforced.
    // -----------------------------------------------------------------

    async startOwnerDeviceAuth(input = {}) {
      const deviceCode = genId('dc_owner');
      const userCode = userCodeForTest();
      const approvalId = genId('appr');
      const row = {
        device_code: deviceCode,
        user_code: userCode,
        client_id: input.client_id || SAMPLE_CLIENT_ID,
        status: 'pending',
        approval_id: approvalId,
        interval_seconds: input.interval || 5,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
        last_polled_at: null,
        token_id: null,
        subject_id: null,
      };
      ownerDeviceAuth.set(deviceCode, row);
      userCodeToDeviceCode.set(userCode, deviceCode);
      ownerApprovalToDeviceCode.set(approvalId, deviceCode);
      return {
        device_code: deviceCode,
        user_code: userCode,
        interval: row.interval_seconds,
        expires_in: 300,
        approval_id: approvalId,
      };
    },

    async lookupOwnerDeviceAuthByUserCode(userCode) {
      const deviceCode = userCodeToDeviceCode.get(userCode);
      if (!deviceCode) return null;
      const row = ownerDeviceAuth.get(deviceCode);
      if (!row || row.status !== 'pending') return null;
      if (isPast(row.expires_at)) return null;
      return {
        client_id: row.client_id,
        interval: row.interval_seconds,
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
    },

    async lookupOwnerDeviceAuthByApprovalId(approvalId) {
      const deviceCode = ownerApprovalToDeviceCode.get(approvalId);
      if (!deviceCode) return null;
      const row = ownerDeviceAuth.get(deviceCode);
      if (!row) return null;
      return {
        status: row.status,
        approval_id: row.approval_id,
        client_id: row.client_id,
        subject_id: row.subject_id,
      };
    },

    async approveOwnerDeviceAuth(userCode) {
      const deviceCode = userCodeToDeviceCode.get(userCode);
      const row = deviceCode ? ownerDeviceAuth.get(deviceCode) : null;
      if (!row || row.status !== 'pending') {
        const err = new Error('Unknown user code');
        err.code = 'not_found';
        throw err;
      }
      if (isPast(row.expires_at)) {
        const err = new Error('expired');
        err.code = 'not_found';
        throw err;
      }
      const token = genId('tok');
      row.status = 'approved';
      row.token_id = token;
      row.subject_id = 'owner_local';
      return { access_token: token, token_type: 'Bearer', expires_in: 60 };
    },

    async denyOwnerDeviceAuth(userCode) {
      // BREAK 2: drop the user_code from public lookup but DO NOT mark
      // the row's status as `denied`. Pollers see it as pending forever
      // (until expiry), so the exchange returns `authorization_pending`
      // instead of `access_denied`.
      const deviceCode = userCodeToDeviceCode.get(userCode);
      if (!deviceCode) return;
      userCodeToDeviceCode.delete(userCode);
      // Note: we leave row.status === 'pending'.
    },

    async exchangeOwnerDeviceCode(input = {}) {
      const row = ownerDeviceAuth.get(input.device_code);
      if (!row || row.client_id !== input.client_id) {
        const err = new Error('invalid');
        err.code = 'invalid_grant';
        throw err;
      }
      if (row.status === 'pending' && isPast(row.expires_at)) {
        const err = new Error('expired');
        err.code = 'expired_token';
        throw err;
      }
      if (row.status === 'denied') {
        const err = new Error('denied');
        err.code = 'access_denied';
        throw err;
      }
      if (row.status === 'pending') {
        // BREAK 3: no slow_down enforcement — every poll returns
        // authorization_pending regardless of last_polled_at.
        row.last_polled_at = new Date().toISOString();
        const err = new Error('pending');
        err.code = 'authorization_pending';
        throw err;
      }
      return {
        access_token: row.token_id,
        token_type: 'Bearer',
        expires_in: 60,
      };
    },

    async forceExpireOwnerDeviceAuth(deviceCode) {
      const row = ownerDeviceAuth.get(deviceCode);
      if (!row) return;
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    },

    async rewindOwnerDevicePollTimer(deviceCode) {
      const row = ownerDeviceAuth.get(deviceCode);
      if (!row) return;
      row.last_polled_at = new Date(
        Date.now() - row.interval_seconds * 2 * 1000,
      ).toISOString();
    },
  };
}
