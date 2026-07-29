// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 *     tracing, and event emission stay in `server/auth.ts`.
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

const SAMPLE_CLIENT_ID = "memory_concert_recommendation_app";
const SAMPLE_CONNECTOR_ID = "memory://manifest/spotify";

const DEFAULT_PENDING_CONSENT_TTL_SECONDS = 300;
const DEFAULT_OWNER_DEVICE_TTL_SECONDS = 300;
const DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS = 5;

let memoryDriverInstanceCounter = 0;

type ConsentStatus = "pending" | "approved" | "denied" | "expired";
interface ConsentInput {
  access_mode?: string;
  client_id?: string;
  expires_in?: number;
  interval?: number;
  purpose_code?: string;
  purpose_description?: string;
  streams?: Record<string, unknown>[];
}
interface ConsentRow {
  approval_id: string;
  client_id?: string;
  created_at: string;
  device_code: string;
  expires_at: string;
  grant_id?: string | null;
  interval_seconds?: number;
  kind?: string;
  last_polled_at?: string | null;
  request_uri?: string;
  status: ConsentStatus;
  streams?: Record<string, unknown>[];
  subject_id?: string | null;
  token_id?: string | null;
  user_code?: string;
  [key: string]: unknown;
}

interface CodedError extends Error {
  code?: string;
}
function codedError(message: string): CodedError {
  return new Error(message) as CodedError;
}

function isPast(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

function isoFromNowSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createMemoryConsentDeviceAuthDriver() {
  // Deterministic IDs scoped to the driver instance so two parallel scenarios
  // can't collide. Combined with a per-instance prefix this avoids relying on
  // Math.random for harness identity.
  // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
  const instanceTag = (++memoryDriverInstanceCounter).toString(36);
  let scopedCounter = 0;
  function nextId(prefix: string): string {
    scopedCounter += 1;
    return `${prefix}_mem_${instanceTag}_${scopedCounter.toString(36)}`;
  }

  // Six-hex-char user code, like the reference's randomBytes(3).toString('hex').toUpperCase().
  let userCodeCounter = 0;
  function nextUserCode() {
    userCodeCounter += 1;
    return userCodeCounter.toString(16).toUpperCase().padStart(6, "0").slice(-6);
  }

  /** @type {Map<string, any>} */
  const pendingConsents = new Map<string, ConsentRow>(); // request_uri -> row
  /** @type {Map<string, string>} */
  const pendingApprovalIndex = new Map(); // approval_id -> request_uri

  /** @type {Map<string, any>} */
  const ownerDeviceAuth = new Map<string, ConsentRow>(); // device_code -> row
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

  function lookupPendingRow(requestUri: string): ConsentRow | null {
    return pendingConsents.get(requestUri) || null;
  }

  function transitionPendingExpired(row: ConsentRow): void {
    if (row.status === "pending") {
      row.status = "expired";
    }
  }

  // -------------------------------------------------------------------------
  // Owner-device helpers.
  // -------------------------------------------------------------------------

  function lookupOwnerRowByDeviceCode(deviceCode: string): ConsentRow | null {
    return ownerDeviceAuth.get(deviceCode) || null;
  }

  function lookupOwnerRowByUserCode(userCode: string): ConsentRow | null {
    const deviceCode = userCodeIndex.get(userCode);
    return deviceCode ? ownerDeviceAuth.get(deviceCode) || null : null;
  }

  function transitionOwnerExpired(row: ConsentRow): void {
    if (row.status === "pending") {
      row.status = "expired";
    }
  }

  return {
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async approveOwnerDeviceAuth(userCode: string) {
      const row = lookupOwnerRowByUserCode(userCode);
      if (!row) {
        const err = codedError("Unknown user code");
        err.code = "not_found";
        throw err;
      }
      if (row.status !== "pending") {
        // Terminal state — re-approval is rejected and the originally-
        // issued token (if any) stays bound to the row. Pins scenario 9b's
        // "approval is terminal" invariant.
        const err = codedError("Owner device authorization is not available");
        err.code = "not_found";
        throw err;
      }
      if (isPast(row.expires_at)) {
        transitionOwnerExpired(row);
        const err = codedError("Owner device authorization has expired");
        err.code = "not_found";
        throw err;
      }
      const token = nextId("owner_tok");
      row.status = "approved";
      row.token_id = token;
      row.subject_id = "owner_local";
      return {
        access_token: token,
        expires_in: 365 * 24 * 60 * 60,
        subject_id: "owner_local",
        token_type: "Bearer",
      };
    },

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async approvePendingConsent(requestUri: string) {
      const row = lookupPendingRow(requestUri);
      if (!row) {
        const err = codedError("Unknown device code");
        err.code = "not_found";
        throw err;
      }
      if (row.status !== "pending") {
        // Terminal state (approved, denied, expired) — re-approval is not
        // allowed. This pins scenario 2's "approval is terminal" invariant.
        const err = codedError("Pending consent request is not available");
        err.code = "not_found";
        throw err;
      }
      if (isPast(row.expires_at)) {
        transitionPendingExpired(row);
        const err = codedError("Pending consent request has expired");
        err.code = "not_found";
        throw err;
      }
      const grantId = nextId("grt");
      const token = nextId("tok");
      row.status = "approved";
      row.grant_id = grantId;
      row.token_id = token;
      row.subject_id = "owner_local";
      return {
        grant: { grant_id: grantId, version: "0.1.0" },
        token,
      };
    },

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async denyOwnerDeviceAuth(userCode: string) {
      const row = lookupOwnerRowByUserCode(userCode);
      if (!row) {
        const err = codedError("Unknown user code");
        err.code = "not_found";
        throw err;
      }
      if (row.status !== "pending") {
        const err = codedError("Owner device authorization is not available");
        err.code = "not_found";
        throw err;
      }
      if (isPast(row.expires_at)) {
        transitionOwnerExpired(row);
        const err = codedError("Owner device authorization has expired");
        err.code = "not_found";
        throw err;
      }
      // Mirror SQLite's `markOwnerDeviceAuthDenied`: flip status to `denied`
      // so polling exchange returns `access_denied`, not
      // `authorization_pending`. This is the invariant break-2 in the broken
      // driver — keep it correct here.
      row.status = "denied";
    },

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async denyPendingConsent(requestUri: string) {
      const row = lookupPendingRow(requestUri);
      if (row?.status !== "pending") {
        return false;
      }
      if (isPast(row.expires_at)) {
        transitionPendingExpired(row);
        return false;
      }
      row.status = "denied";
      return true;
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: localized test assertion preserves its explicit contract.
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async exchangeOwnerDeviceCode(input: { client_id?: string; device_code?: string } = {}) {
      const clientId = input.client_id;
      const deviceCode = input.device_code;
      if (!(clientId && deviceCode)) {
        const err = codedError("client_id and device_code are required");
        err.code = "invalid_request";
        throw err;
      }
      const row = lookupOwnerRowByDeviceCode(deviceCode);
      if (!row || row.client_id !== clientId) {
        const err = codedError("Unknown or invalid device_code");
        err.code = "invalid_grant";
        throw err;
      }

      if (row.status === "pending" && isPast(row.expires_at)) {
        transitionOwnerExpired(row);
        const err = codedError("Device code has expired");
        err.code = "expired_token";
        throw err;
      }
      if (row.status === "denied") {
        const err = codedError("The resource owner denied the request");
        err.code = "access_denied";
        throw err;
      }
      if (row.status === "expired") {
        const err = codedError("Device code has expired");
        err.code = "expired_token";
        throw err;
      }

      if (row.status === "pending") {
        if (row.last_polled_at) {
          const sinceLastPollMs = Date.now() - new Date(row.last_polled_at).getTime();
          if (sinceLastPollMs < (row.interval_seconds ?? DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS) * 1000) {
            const err = codedError("Polling too quickly");
            err.code = "slow_down";
            throw err;
          }
        }
        row.last_polled_at = nowIso();
        const err = codedError("Authorization still pending");
        err.code = "authorization_pending";
        throw err;
      }

      // Approved.
      if (!row.token_id) {
        const err = codedError("Owner token is not bound");
        err.code = "expired_token";
        throw err;
      }
      return {
        access_token: row.token_id,
        expires_in: 365 * 24 * 60 * 60,
        token_type: "Bearer",
      };
    },

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async forceExpireOwnerDeviceAuth(deviceCode: string): Promise<void> {
      const row = lookupOwnerRowByDeviceCode(deviceCode);
      if (!row) {
        return;
      }
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    },

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async forceExpirePendingConsent(requestUri: string): Promise<void> {
      const row = lookupPendingRow(requestUri);
      if (!row) {
        return;
      }
      // Test-only seam: rewind expires_at into the past so the next public
      // lookup / approve / deny call observes the row as expired. Mirrors
      // the SQLite driver, which UPDATEs the column directly.
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    },

    getRegisteredClientId() {
      return SAMPLE_CLIENT_ID;
    },

    getRegisteredConnectorId() {
      return SAMPLE_CONNECTOR_ID;
    },

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async lookupOwnerDeviceAuthByApprovalId(approvalId: string) {
      const deviceCode = ownerApprovalIndex.get(approvalId);
      if (!deviceCode) {
        return null;
      }
      const row = lookupOwnerRowByDeviceCode(deviceCode);
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

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async lookupOwnerDeviceAuthByUserCode(userCode: string) {
      const row = lookupOwnerRowByUserCode(userCode);
      if (!row) {
        return null;
      }
      if (row.status !== "pending") {
        return null;
      }
      if (isPast(row.expires_at)) {
        transitionOwnerExpired(row);
        return null;
      }
      return {
        client_id: row.client_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
        interval: row.interval_seconds,
      };
    },

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async lookupPendingConsentByApprovalId(approvalId: string) {
      const requestUri = pendingApprovalIndex.get(approvalId);
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

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async lookupPendingConsentByRequestUri(requestUri: string) {
      const row = lookupPendingRow(requestUri);
      if (!row) {
        return null;
      }
      if (row.status !== "pending") {
        return null;
      }
      if (isPast(row.expires_at)) {
        // Match the SQLite reference: surface expiry by transitioning the
        // row off `pending` so subsequent approve/deny calls see a terminal
        // state instead of racing the clock.
        transitionPendingExpired(row);
        return null;
      }
      return {
        created_at: row.created_at,
        expires_at: row.expires_at,
        user_code: row.user_code,
      };
    },

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async rewindOwnerDevicePollTimer(deviceCode: string): Promise<void> {
      const row = lookupOwnerRowByDeviceCode(deviceCode);
      if (!row) {
        return;
      }
      // Rewind by twice the interval so the next exchange cannot trip
      // `slow_down` for clock-granularity reasons. Mirrors the SQLite seam.
      const intervalMs = (row.interval_seconds ?? DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS) * 2 * 1000;
      row.last_polled_at = new Date(Date.now() - intervalMs).toISOString();
    },
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async setup() {
      pendingConsents.clear();
      pendingApprovalIndex.clear();
      ownerDeviceAuth.clear();
      userCodeIndex.clear();
      ownerApprovalIndex.clear();
      scopedCounter = 0;
      userCodeCounter = 0;
    },

    // ---------------------------------------------------------------------
    // Owner device authorization.
    // ---------------------------------------------------------------------

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async startOwnerDeviceAuth(input: ConsentInput = {}) {
      ensureSetup();
      const deviceCode = nextId("dc_owner");
      const userCode = nextUserCode();
      const approvalId = nextId("appr");
      const requestedInterval = input.interval ?? DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS;
      const interval =
        Number.isFinite(requestedInterval) && requestedInterval > 0
          ? requestedInterval
          : DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS;
      const requestedExpiry = input.expires_in ?? DEFAULT_OWNER_DEVICE_TTL_SECONDS;
      const expiresInSeconds =
        Number.isFinite(requestedExpiry) && requestedExpiry > 0 ? requestedExpiry : DEFAULT_OWNER_DEVICE_TTL_SECONDS;
      const createdAt = nowIso();
      const expiresAt = isoFromNowSeconds(expiresInSeconds);
      const clientId = input.client_id || SAMPLE_CLIENT_ID;
      const row: ConsentRow = {
        approval_id: approvalId,
        client_id: clientId,
        created_at: createdAt,
        device_code: deviceCode,
        expires_at: expiresAt,
        interval_seconds: interval,
        kind: "owner_device_auth",
        last_polled_at: null,
        status: "pending",
        subject_id: null,
        token_id: null,
        user_code: userCode,
      };
      ownerDeviceAuth.set(deviceCode, row);
      userCodeIndex.set(userCode, deviceCode);
      ownerApprovalIndex.set(approvalId, deviceCode);
      return {
        approval_id: approvalId,
        device_code: deviceCode,
        expires_in: expiresInSeconds,
        interval,
        user_code: userCode,
      };
    },

    // ---------------------------------------------------------------------
    // Pending consent.
    // ---------------------------------------------------------------------

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async startPendingConsent(input: ConsentInput = {}) {
      ensureSetup();
      const deviceCode = nextId("dc");
      const requestUri = `urn:pdpp:pending-consent:${deviceCode}`;
      const approvalId = nextId("appr");
      const userCode = nextUserCode();
      const createdAt = nowIso();
      const expiresAt = isoFromNowSeconds(DEFAULT_PENDING_CONSENT_TTL_SECONDS);
      const row: ConsentRow = {
        access_mode: input.access_mode || "continuous",
        approval_id: approvalId,
        created_at: createdAt,
        device_code: deviceCode,
        expires_at: expiresAt,
        grant_id: null,
        kind: "pending_consent",
        purpose_code: input.purpose_code || "https://pdpp.org/purpose/personalization",
        purpose_description: input.purpose_description || "memory consent-device-auth conformance",
        request_uri: requestUri,
        status: "pending",
        streams: Array.isArray(input.streams) ? input.streams : [{ name: "top_artists", view: "basic" }],
        subject_id: null,
        token_id: null,
        user_code: userCode,
      };
      pendingConsents.set(requestUri, row);
      pendingApprovalIndex.set(approvalId, requestUri);
      return { approval_id: approvalId, request_uri: requestUri };
    },

    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async teardown() {
      pendingConsents.clear();
      pendingApprovalIndex.clear();
      ownerDeviceAuth.clear();
      userCodeIndex.clear();
      ownerApprovalIndex.clear();
    },
  };
}
