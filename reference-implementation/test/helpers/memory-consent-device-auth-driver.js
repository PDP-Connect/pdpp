/**
 * Conforming in-memory driver for the consent + owner-device-auth conformance harness.
 *
 * Test-only second adapter that mirrors the SQLite reference's terminal-state
 * semantics, approval-id indirection, expiry behavior, owner-device polling
 * `slow_down` enforcement, denial-vs-approval terminal distinction, and
 * polling exchange shape — without touching SQLite, the file system, or the
 * production auth helpers. Its purpose is the storage-only security proof
 * for `define-reference-operation-environments` task 3.1: prove the existing
 * conformance harness can run against SQLite *and* a second conforming
 * adapter, not just the deliberately-broken falsifiability driver.
 *
 * Honesty boundaries:
 *
 *   - Does NOT issue real tokens, mint grants, or emit spine events. Tokens
 *     and grants are opaque deterministic strings sufficient for the harness
 *     scenarios. Production token introspection, grant issuance, scenario
 *     tracing, and event emission stay in `server/auth.js`.
 *   - Does NOT model registered clients, manifests, or DCR. The driver
 *     advertises a single sample client_id and connector_id via `setup()`
 *     so harness scenarios that depend on `getRegisteredClientId()` and
 *     `getRegisteredConnectorId()` have stable answers.
 *   - Mirrors `exchangeOwnerDeviceCode`'s precedence: invalid client/device
 *     pair → `invalid_grant`; pending+expired → `expired_token`; denied →
 *     `access_denied`; pending+slow_down (within interval) → `slow_down`;
 *     pending otherwise → `authorization_pending` (and the row's
 *     `last_polled_at` is updated). After approval, the bound `token_id`
 *     is returned.
 *   - Pending-consent and owner-device "force expire" / "rewind poll timer"
 *     test-only seams are implemented by directly mutating the in-memory
 *     row's `expires_at` / `last_polled_at` fields. They never run through
 *     production code.
 *
 * The driver is test-only and SHALL NOT be used as a production
 * `ConsentStore` / `OwnerDeviceAuthStore`. No production code imports it.
 *
 * Spec: openspec/changes/define-reference-operation-environments/tasks.md §3.1.
 */

const SAMPLE_CLIENT_ID = 'memory_concert_recommendation_app';
const SAMPLE_CONNECTOR_ID = 'memory://manifest/spotify';

const DEFAULT_PENDING_CONSENT_TTL_SECONDS = 300;
const DEFAULT_OWNER_DEVICE_TTL_SECONDS = 300;
const DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS = 5;

function isPast(iso) {
  return new Date(iso).getTime() <= Date.now();
}

function isoFromNowSeconds(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

export function createMemoryConsentDeviceAuthDriver() {
  // Deterministic IDs scoped to the driver instance so two parallel scenarios
  // can't collide. Combined with a per-instance prefix this avoids relying on
  // Math.random for harness identity.
  let instanceCounter = 0;
  const instanceTag = (++instanceCounter).toString(36);
  let scopedCounter = 0;
  function nextId(prefix) {
    scopedCounter += 1;
    return `${prefix}_mem_${instanceTag}_${scopedCounter.toString(36)}`;
  }

  // Six-hex-char user code, like the reference's randomBytes(3).toString('hex').toUpperCase().
  let userCodeCounter = 0;
  function nextUserCode() {
    userCodeCounter += 1;
    return userCodeCounter.toString(16).toUpperCase().padStart(6, '0').slice(-6);
  }

  /** @type {Map<string, any>} */
  const pendingConsents = new Map(); // request_uri -> row
  /** @type {Map<string, string>} */
  const pendingApprovalIndex = new Map(); // approval_id -> request_uri

  /** @type {Map<string, any>} */
  const ownerDeviceAuth = new Map(); // device_code -> row
  /** @type {Map<string, string>} */
  const userCodeIndex = new Map(); // user_code -> device_code
  /** @type {Map<string, string>} */
  const ownerApprovalIndex = new Map(); // approval_id -> device_code

  function ensureSetup() {
    // No-op for the memory driver — setup() always succeeds. Kept symmetrical
    // with the SQLite driver so a future requirement can plug in here.
  }

  // -------------------------------------------------------------------------
  // Pending-consent helpers.
  // -------------------------------------------------------------------------

  function lookupPendingRow(requestUri) {
    return pendingConsents.get(requestUri) || null;
  }

  function transitionPendingExpired(row) {
    if (row.status === 'pending') {
      row.status = 'expired';
    }
  }

  // -------------------------------------------------------------------------
  // Owner-device helpers.
  // -------------------------------------------------------------------------

  function lookupOwnerRowByDeviceCode(deviceCode) {
    return ownerDeviceAuth.get(deviceCode) || null;
  }

  function lookupOwnerRowByUserCode(userCode) {
    const deviceCode = userCodeIndex.get(userCode);
    return deviceCode ? ownerDeviceAuth.get(deviceCode) || null : null;
  }

  function transitionOwnerExpired(row) {
    if (row.status === 'pending') {
      row.status = 'expired';
    }
  }

  return {
    async setup() {
      pendingConsents.clear();
      pendingApprovalIndex.clear();
      ownerDeviceAuth.clear();
      userCodeIndex.clear();
      ownerApprovalIndex.clear();
      scopedCounter = 0;
      userCodeCounter = 0;
    },

    async teardown() {
      pendingConsents.clear();
      pendingApprovalIndex.clear();
      ownerDeviceAuth.clear();
      userCodeIndex.clear();
      ownerApprovalIndex.clear();
    },

    getRegisteredClientId() {
      return SAMPLE_CLIENT_ID;
    },

    getRegisteredConnectorId() {
      return SAMPLE_CONNECTOR_ID;
    },

    // ---------------------------------------------------------------------
    // Pending consent.
    // ---------------------------------------------------------------------

    async startPendingConsent(input = {}) {
      ensureSetup();
      const deviceCode = nextId('dc');
      const requestUri = `urn:pdpp:pending-consent:${deviceCode}`;
      const approvalId = nextId('appr');
      const userCode = nextUserCode();
      const createdAt = nowIso();
      const expiresAt = isoFromNowSeconds(DEFAULT_PENDING_CONSENT_TTL_SECONDS);
      const row = {
        kind: 'pending_consent',
        status: 'pending',
        request_uri: requestUri,
        device_code: deviceCode,
        approval_id: approvalId,
        user_code: userCode,
        purpose_code: input.purpose_code || 'https://pdpp.org/purpose/personalization',
        purpose_description: input.purpose_description || 'memory consent-device-auth conformance',
        access_mode: input.access_mode || 'continuous',
        streams: Array.isArray(input.streams)
          ? input.streams
          : [{ name: 'top_artists', view: 'basic' }],
        created_at: createdAt,
        expires_at: expiresAt,
        grant_id: null,
        token_id: null,
        subject_id: null,
      };
      pendingConsents.set(requestUri, row);
      pendingApprovalIndex.set(approvalId, requestUri);
      return { request_uri: requestUri, approval_id: approvalId };
    },

    async lookupPendingConsentByRequestUri(requestUri) {
      const row = lookupPendingRow(requestUri);
      if (!row) return null;
      if (row.status !== 'pending') return null;
      if (isPast(row.expires_at)) {
        // Match the SQLite reference: surface expiry by transitioning the
        // row off `pending` so subsequent approve/deny calls see a terminal
        // state instead of racing the clock.
        transitionPendingExpired(row);
        return null;
      }
      return {
        user_code: row.user_code,
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
    },

    async lookupPendingConsentByApprovalId(approvalId) {
      const requestUri = pendingApprovalIndex.get(approvalId);
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
      const row = lookupPendingRow(requestUri);
      if (!row) {
        const err = new Error('Unknown device code');
        err.code = 'not_found';
        throw err;
      }
      if (row.status !== 'pending') {
        // Terminal state (approved, denied, expired) — re-approval is not
        // allowed. This pins scenario 2's "approval is terminal" invariant.
        const err = new Error('Pending consent request is not available');
        err.code = 'not_found';
        throw err;
      }
      if (isPast(row.expires_at)) {
        transitionPendingExpired(row);
        const err = new Error('Pending consent request has expired');
        err.code = 'not_found';
        throw err;
      }
      const grantId = nextId('grt');
      const token = nextId('tok');
      row.status = 'approved';
      row.grant_id = grantId;
      row.token_id = token;
      row.subject_id = 'owner_local';
      return {
        grant: { grant_id: grantId, version: '0.1.0' },
        token,
      };
    },

    async denyPendingConsent(requestUri) {
      const row = lookupPendingRow(requestUri);
      if (!row || row.status !== 'pending') return false;
      if (isPast(row.expires_at)) {
        transitionPendingExpired(row);
        return false;
      }
      row.status = 'denied';
      return true;
    },

    async forceExpirePendingConsent(requestUri) {
      const row = lookupPendingRow(requestUri);
      if (!row) return;
      // Test-only seam: rewind expires_at into the past so the next public
      // lookup / approve / deny call observes the row as expired. Mirrors
      // the SQLite driver, which UPDATEs the column directly.
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    },

    // ---------------------------------------------------------------------
    // Owner device authorization.
    // ---------------------------------------------------------------------

    async startOwnerDeviceAuth(input = {}) {
      ensureSetup();
      const deviceCode = nextId('dc_owner');
      const userCode = nextUserCode();
      const approvalId = nextId('appr');
      const interval =
        Number.isFinite(input.interval) && input.interval > 0
          ? input.interval
          : DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS;
      const expiresInSeconds =
        Number.isFinite(input.expires_in) && input.expires_in > 0
          ? input.expires_in
          : DEFAULT_OWNER_DEVICE_TTL_SECONDS;
      const createdAt = nowIso();
      const expiresAt = isoFromNowSeconds(expiresInSeconds);
      const clientId = input.client_id || SAMPLE_CLIENT_ID;
      const row = {
        kind: 'owner_device_auth',
        status: 'pending',
        device_code: deviceCode,
        user_code: userCode,
        approval_id: approvalId,
        client_id: clientId,
        interval_seconds: interval,
        created_at: createdAt,
        expires_at: expiresAt,
        last_polled_at: null,
        token_id: null,
        subject_id: null,
      };
      ownerDeviceAuth.set(deviceCode, row);
      userCodeIndex.set(userCode, deviceCode);
      ownerApprovalIndex.set(approvalId, deviceCode);
      return {
        device_code: deviceCode,
        user_code: userCode,
        interval,
        expires_in: expiresInSeconds,
        approval_id: approvalId,
      };
    },

    async lookupOwnerDeviceAuthByUserCode(userCode) {
      const row = lookupOwnerRowByUserCode(userCode);
      if (!row) return null;
      if (row.status !== 'pending') return null;
      if (isPast(row.expires_at)) {
        transitionOwnerExpired(row);
        return null;
      }
      return {
        client_id: row.client_id,
        interval: row.interval_seconds,
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
    },

    async lookupOwnerDeviceAuthByApprovalId(approvalId) {
      const deviceCode = ownerApprovalIndex.get(approvalId);
      if (!deviceCode) return null;
      const row = lookupOwnerRowByDeviceCode(deviceCode);
      if (!row) return null;
      return {
        status: row.status,
        approval_id: row.approval_id,
        client_id: row.client_id,
        subject_id: row.subject_id,
      };
    },

    async approveOwnerDeviceAuth(userCode) {
      const row = lookupOwnerRowByUserCode(userCode);
      if (!row) {
        const err = new Error('Unknown user code');
        err.code = 'not_found';
        throw err;
      }
      if (row.status !== 'pending') {
        // Terminal state — re-approval is rejected and the originally-
        // issued token (if any) stays bound to the row. Pins scenario 9b's
        // "approval is terminal" invariant.
        const err = new Error('Owner device authorization is not available');
        err.code = 'not_found';
        throw err;
      }
      if (isPast(row.expires_at)) {
        transitionOwnerExpired(row);
        const err = new Error('Owner device authorization has expired');
        err.code = 'not_found';
        throw err;
      }
      const token = nextId('owner_tok');
      row.status = 'approved';
      row.token_id = token;
      row.subject_id = 'owner_local';
      return {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 365 * 24 * 60 * 60,
        subject_id: 'owner_local',
      };
    },

    async denyOwnerDeviceAuth(userCode) {
      const row = lookupOwnerRowByUserCode(userCode);
      if (!row) {
        const err = new Error('Unknown user code');
        err.code = 'not_found';
        throw err;
      }
      if (row.status !== 'pending') {
        const err = new Error('Owner device authorization is not available');
        err.code = 'not_found';
        throw err;
      }
      if (isPast(row.expires_at)) {
        transitionOwnerExpired(row);
        const err = new Error('Owner device authorization has expired');
        err.code = 'not_found';
        throw err;
      }
      // Mirror SQLite's `markOwnerDeviceAuthDenied`: flip status to `denied`
      // so polling exchange returns `access_denied`, not
      // `authorization_pending`. This is the invariant break-2 in the broken
      // driver — keep it correct here.
      row.status = 'denied';
    },

    async exchangeOwnerDeviceCode(input = {}) {
      const clientId = input.client_id;
      const deviceCode = input.device_code;
      if (!clientId || !deviceCode) {
        const err = new Error('client_id and device_code are required');
        err.code = 'invalid_request';
        throw err;
      }
      const row = lookupOwnerRowByDeviceCode(deviceCode);
      if (!row || row.client_id !== clientId) {
        const err = new Error('Unknown or invalid device_code');
        err.code = 'invalid_grant';
        throw err;
      }

      if (row.status === 'pending' && isPast(row.expires_at)) {
        transitionOwnerExpired(row);
        const err = new Error('Device code has expired');
        err.code = 'expired_token';
        throw err;
      }
      if (row.status === 'denied') {
        const err = new Error('The resource owner denied the request');
        err.code = 'access_denied';
        throw err;
      }
      if (row.status === 'expired') {
        const err = new Error('Device code has expired');
        err.code = 'expired_token';
        throw err;
      }

      if (row.status === 'pending') {
        if (row.last_polled_at) {
          const sinceLastPollMs = Date.now() - new Date(row.last_polled_at).getTime();
          if (sinceLastPollMs < row.interval_seconds * 1000) {
            const err = new Error('Polling too quickly');
            err.code = 'slow_down';
            throw err;
          }
        }
        row.last_polled_at = nowIso();
        const err = new Error('Authorization still pending');
        err.code = 'authorization_pending';
        throw err;
      }

      // Approved.
      if (!row.token_id) {
        const err = new Error('Owner token is not bound');
        err.code = 'expired_token';
        throw err;
      }
      return {
        access_token: row.token_id,
        token_type: 'Bearer',
        expires_in: 365 * 24 * 60 * 60,
      };
    },

    async forceExpireOwnerDeviceAuth(deviceCode) {
      const row = lookupOwnerRowByDeviceCode(deviceCode);
      if (!row) return;
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    },

    async rewindOwnerDevicePollTimer(deviceCode) {
      const row = lookupOwnerRowByDeviceCode(deviceCode);
      if (!row) return;
      // Rewind by twice the interval so the next exchange cannot trip
      // `slow_down` for clock-granularity reasons. Mirrors the SQLite seam.
      const intervalMs = (row.interval_seconds || DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS) * 2 * 1000;
      row.last_polled_at = new Date(Date.now() - intervalMs).toISOString();
    },
  };
}
