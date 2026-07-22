// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production-store-backed driver for the consent + owner-device-auth
 * conformance harness.
 *
 * Unlike `sqlite-consent-device-auth-driver.js`, which calls the
 * lifecycle helpers in `server/auth.js` directly, this driver consumes
 * the *production* `ConsentStore` and `OwnerDeviceAuthStore` interfaces
 * exposed under `server/stores/`. The harness running green against
 * this driver is the gate that says: real route handlers, which now
 * speak through the same stores, see the same lifecycle semantics the
 * conformance suite has pinned.
 *
 * The driver reaches into the underlying SQLite handle ONLY for the
 * harness's test-only seams (force-expire, rewind poll timer). Those
 * seams are local to the driver — they MUST NOT exist on the production
 * store interfaces. If the production interface ever needs them to make
 * the harness pass, that is a stop-condition.
 *
 * Spec: openspec/changes/extract-low-risk-reference-stores/specs/
 *       reference-implementation-architecture/spec.md
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDb, getDb, initDb, runWithSqliteBusyRetry } from '../../server/db.js';
import { registerConnector, seedPreRegisteredClients } from '../../server/auth.js';
import { createSqliteConsentStore } from '../../server/stores/consent-store.js';
import { createSqliteOwnerDeviceAuthStore } from '../../server/stores/owner-device-auth-store.js';

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
  return new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
}

function rewoundPolledAtIso(intervalSeconds) {
  const ms = (Number.isFinite(intervalSeconds) && intervalSeconds > 0
    ? intervalSeconds
    : 5) * 2 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

export function createProductionConsentDeviceAuthDriver() {
  let manifest = null;
  let consentStore = null;
  let ownerDeviceAuthStore = null;

  function ensureSetup() {
    if (!manifest) {
      throw new Error('ProductionConsentDeviceAuthDriver: setup() must be called first');
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
      consentStore = createSqliteConsentStore();
      ownerDeviceAuthStore = createSqliteOwnerDeviceAuthStore();
    },

    async teardown() {
      manifest = null;
      consentStore = null;
      ownerDeviceAuthStore = null;
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
    // Pending consent — driven through the production ConsentStore.
    // ---------------------------------------------------------------------

    async startPendingConsent(input = {}) {
      ensureSetup();
      const purposeCode = input.purpose_code || 'https://pdpp.org/purpose/personalization';
      const purposeDescription = input.purpose_description || 'consent-device-auth conformance';
      const accessMode = input.access_mode || 'continuous';
      const streams = input.streams || [{ name: 'top_artists', view: 'basic' }];

      const result = await consentStore.initiateGrant({
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
      const deviceCode = consentStore.parseRequestUri(result.request_uri);
      // The approval_id is generated and stored alongside the row by the
      // store. We resolve it here through a SQLite-only path because the
      // production store does not expose a "give me the approval_id for
      // this device_code" surface — by design: callers should resolve
      // approval ids from public projections, not from device codes.
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
      const view = await consentStore.getPendingConsentByRequestUri(requestUri);
      if (!view) return null;
      return {
        user_code: view.userCode,
        created_at: view.createdAt,
        expires_at: view.expiresAt,
      };
    },

    async lookupPendingConsentByApprovalId(approvalId) {
      const row = await consentStore.getPendingConsentByApprovalId(approvalId);
      if (!row) return null;
      return {
        status: row.status,
        approval_id: row.approval_id,
        grant_id: row.grant_id || null,
        subject_id: row.subject_id || null,
      };
    },

    async approvePendingConsent(requestUri) {
      const deviceCode = consentStore.parseRequestUri(requestUri);
      return consentStore.approveGrant(deviceCode);
    },

    async denyPendingConsent(requestUri) {
      const deviceCode = consentStore.parseRequestUri(requestUri);
      return consentStore.denyGrant(deviceCode);
    },

    async forceExpirePendingConsent(requestUri) {
      const deviceCode = consentStore.parseRequestUri(requestUri);
      // Test-only seam — local to the driver. The production ConsentStore
      // intentionally has no force-expire surface; expiry is a wall-clock
      // property exercised by rewinding the row's expires_at.
      await runWithSqliteBusyRetry(() => {
        getDb()
          .prepare('UPDATE pending_consents SET expires_at = ? WHERE device_code = ?')
          .run(pastIso(), deviceCode);
      });
    },

    // ---------------------------------------------------------------------
    // Owner device authorization — driven through the production
    // OwnerDeviceAuthStore.
    // ---------------------------------------------------------------------

    async startOwnerDeviceAuth(input = {}) {
      ensureSetup();
      const clientId = input.client_id || SAMPLE_CLIENT_ID;
      const interval = input.interval || 5;
      const expiresIn = input.expires_in || 300;
      const result = await ownerDeviceAuthStore.initiate(clientId, {
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
      const view = await ownerDeviceAuthStore.getByUserCode(userCode);
      if (!view) return null;
      return {
        client_id: view.client_id,
        interval: view.interval,
        created_at: view.created_at,
        expires_at: view.expires_at,
      };
    },

    async lookupOwnerDeviceAuthByApprovalId(approvalId) {
      const row = await ownerDeviceAuthStore.getByApprovalId(approvalId);
      if (!row) return null;
      return {
        status: row.status,
        approval_id: row.approval_id,
        client_id: row.client_id,
        subject_id: row.subject_id || null,
      };
    },

    async approveOwnerDeviceAuth(userCode) {
      return ownerDeviceAuthStore.approve(userCode);
    },

    async denyOwnerDeviceAuth(userCode) {
      return ownerDeviceAuthStore.deny(userCode);
    },

    async exchangeOwnerDeviceCode(input = {}) {
      return ownerDeviceAuthStore.exchangeDeviceCode({
        clientId: input.client_id,
        deviceCode: input.device_code,
      });
    },

    async forceExpireOwnerDeviceAuth(deviceCode) {
      // Test-only seam — see comment on forceExpirePendingConsent.
      await runWithSqliteBusyRetry(() => {
        getDb()
          .prepare('UPDATE owner_device_auth SET expires_at = ? WHERE device_code = ?')
          .run(pastIso(), deviceCode);
      });
    },

    async rewindOwnerDevicePollTimer(deviceCode) {
      // Test-only seam — see comment on forceExpirePendingConsent.
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
