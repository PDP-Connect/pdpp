/**
 * SQLite-backed driver for the consent + owner-device-auth conformance harness.
 *
 * Wraps the current reference auth helpers (`initiateGrant`, `getPendingConsent`,
 * `approveGrant`, `denyGrant`, `getPendingConsentRowByApprovalId`,
 * `initiateOwnerDeviceAuthorization`, `getOwnerDeviceAuthorizationByUserCode`,
 * `approveOwnerDeviceAuthorization`, `denyOwnerDeviceAuthorization`,
 * `exchangeOwnerDeviceCode`, `getOwnerDeviceAuthRowByApprovalId`) in the narrow
 * harness shape declared in `consent-device-auth-conformance.js`.
 *
 * The driver is the pinned baseline for the consent + owner-device-auth
 * conformance suite. It is not exported from production code and SHALL NOT
 * be treated as a production `ConsentStore` / `OwnerDeviceAuthStore` contract.
 *
 * Test-only seams (`forceExpirePendingConsent`, `forceExpireOwnerDeviceAuth`,
 * `rewindOwnerDevicePollTimer`) directly UPDATE the underlying SQLite handle
 * so the lifecycle scenarios can drive expiry/poll-timer transitions
 * deterministically without changing production code or production query
 * surfaces. The seams are local to the driver and never reachable from
 * exported production functions.
 *
 * Spec: openspec/changes/add-consent-device-auth-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDb, getDb, runWithSqliteBusyRetry } from '../../server/db.js';
import { initDb } from '../../server/db.js';
import {
  approveGrant,
  approveOwnerDeviceAuthorization,
  denyGrant,
  denyOwnerDeviceAuthorization,
  exchangeOwnerDeviceCode,
  getOwnerDeviceAuthRowByApprovalId,
  getOwnerDeviceAuthorizationByUserCode,
  getPendingConsent,
  getPendingConsentRowByApprovalId,
  initiateGrant,
  initiateOwnerDeviceAuthorization,
  parsePendingConsentRequestUri,
  registerConnector,
  seedPreRegisteredClients,
} from '../../server/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..', '..');

const SAMPLE_CLIENT_ID = 'concert_recommendation_app';
const SAMPLE_CLIENT_NAME = 'Concert Recommendation App';

function loadSpotifyManifest() {
  return JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
}

function pastIso() {
  // Two hours in the past — well outside the 300s default expiry.
  return new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
}

function rewoundPolledAtIso(intervalSeconds) {
  // Twice the polling interval ago — guarantees the next exchange call is
  // not rejected with `slow_down` regardless of clock granularity.
  const ms = (Number.isFinite(intervalSeconds) && intervalSeconds > 0
    ? intervalSeconds
    : 5) * 2 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

export function createSqliteConsentDeviceAuthDriver() {
  let manifest = null;

  function ensureSetup() {
    if (!manifest) {
      throw new Error('SqliteConsentDeviceAuthDriver: setup() must be called first');
    }
  }

  return {
    async setup() {
      initDb();
      manifest = loadSpotifyManifest();
      await registerConnector(manifest);
      await seedPreRegisteredClients([
        {
          client_id: SAMPLE_CLIENT_ID,
          metadata: {
            client_name: SAMPLE_CLIENT_NAME,
            token_endpoint_auth_method: 'none',
          },
        },
      ]);
    },

    async teardown() {
      manifest = null;
      closeDb();
    },

    getRegisteredClientId() {
      return SAMPLE_CLIENT_ID;
    },

    getRegisteredConnectorId() {
      ensureSetup();
      return manifest.connector_id;
    },

    // ---------------------------------------------------------------------
    // Pending consent.
    // ---------------------------------------------------------------------

    async startPendingConsent(input = {}) {
      ensureSetup();
      const purposeCode = input.purpose_code || 'https://pdpp.org/purpose/personalization';
      const purposeDescription = input.purpose_description || 'consent-device-auth conformance';
      const accessMode = input.access_mode || 'continuous';
      const streams = input.streams || [{ name: 'top_artists', view: 'basic' }];

      const result = await initiateGrant({
        client_id: SAMPLE_CLIENT_ID,
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            source: { kind: 'connector', id: manifest.connector_id },
            purpose_code: purposeCode,
            purpose_description: purposeDescription,
            access_mode: accessMode,
            streams,
          },
        ],
      });
      const deviceCode = parsePendingConsentRequestUri(result.request_uri);
      const row = getDb()
        .prepare('SELECT approval_id FROM pending_consents WHERE device_code = ?')
        .get(deviceCode);
      if (!row?.approval_id) {
        throw new Error(`pending_consents row missing approval_id for ${deviceCode}`);
      }
      return {
        request_uri: result.request_uri,
        approval_id: row.approval_id,
      };
    },

    async lookupPendingConsentByRequestUri(requestUri) {
      const deviceCode = parsePendingConsentRequestUri(requestUri);
      const view = await getPendingConsent(deviceCode);
      if (!view) return null;
      return {
        user_code: view.userCode,
        created_at: view.createdAt,
        expires_at: view.expiresAt,
      };
    },

    async lookupPendingConsentByApprovalId(approvalId) {
      const row = await getPendingConsentRowByApprovalId(approvalId);
      if (!row) return null;
      return {
        status: row.status,
        approval_id: row.approval_id,
        grant_id: row.grant_id || null,
        subject_id: row.subject_id || null,
      };
    },

    async approvePendingConsent(requestUri) {
      const deviceCode = parsePendingConsentRequestUri(requestUri);
      return approveGrant(deviceCode);
    },

    async denyPendingConsent(requestUri) {
      const deviceCode = parsePendingConsentRequestUri(requestUri);
      return denyGrant(deviceCode);
    },

    async forceExpirePendingConsent(requestUri) {
      const deviceCode = parsePendingConsentRequestUri(requestUri);
      // Test-only seam: rewind expires_at into the past so the next public
      // lookup / approve / deny call observes the row as expired. This
      // exercises the production isExpired() check (which compares against
      // wall-clock now) without freezing time.
      await runWithSqliteBusyRetry(() => {
        getDb()
          .prepare('UPDATE pending_consents SET expires_at = ? WHERE device_code = ?')
          .run(pastIso(), deviceCode);
      });
    },

    // ---------------------------------------------------------------------
    // Owner device authorization.
    // ---------------------------------------------------------------------

    async startOwnerDeviceAuth(input = {}) {
      ensureSetup();
      const clientId = input.client_id || SAMPLE_CLIENT_ID;
      const interval = input.interval || 5;
      const expiresIn = input.expires_in || 300;
      const result = await initiateOwnerDeviceAuthorization(clientId, {
        interval,
        expiresIn,
      });
      const row = getDb()
        .prepare('SELECT approval_id FROM owner_device_auth WHERE device_code = ?')
        .get(result.device_code);
      if (!row?.approval_id) {
        throw new Error(`owner_device_auth row missing approval_id for ${result.device_code}`);
      }
      return {
        device_code: result.device_code,
        user_code: result.user_code,
        interval: result.interval,
        expires_in: result.expires_in,
        verification_uri: result.verification_uri,
        approval_id: row.approval_id,
      };
    },

    async lookupOwnerDeviceAuthByUserCode(userCode) {
      const view = await getOwnerDeviceAuthorizationByUserCode(userCode);
      if (!view) return null;
      return {
        client_id: view.client_id,
        interval: view.interval,
        created_at: view.created_at,
        expires_at: view.expires_at,
      };
    },

    async lookupOwnerDeviceAuthByApprovalId(approvalId) {
      const row = await getOwnerDeviceAuthRowByApprovalId(approvalId);
      if (!row) return null;
      return {
        status: row.status,
        approval_id: row.approval_id,
        client_id: row.client_id,
        subject_id: row.subject_id || null,
      };
    },

    async approveOwnerDeviceAuth(userCode) {
      return approveOwnerDeviceAuthorization(userCode);
    },

    async denyOwnerDeviceAuth(userCode) {
      return denyOwnerDeviceAuthorization(userCode);
    },

    async exchangeOwnerDeviceCode(input = {}) {
      return exchangeOwnerDeviceCode({
        clientId: input.client_id,
        deviceCode: input.device_code,
      });
    },

    async forceExpireOwnerDeviceAuth(deviceCode) {
      await runWithSqliteBusyRetry(() => {
        getDb()
          .prepare('UPDATE owner_device_auth SET expires_at = ? WHERE device_code = ?')
          .run(pastIso(), deviceCode);
      });
    },

    async rewindOwnerDevicePollTimer(deviceCode) {
      const row = getDb()
        .prepare('SELECT interval_seconds FROM owner_device_auth WHERE device_code = ?')
        .get(deviceCode);
      const interval = row?.interval_seconds ?? 5;
      await runWithSqliteBusyRetry(() => {
        getDb()
          .prepare('UPDATE owner_device_auth SET last_polled_at = ? WHERE device_code = ?')
          .run(rewoundPolledAtIso(interval), deviceCode);
      });
    },
  };
}
