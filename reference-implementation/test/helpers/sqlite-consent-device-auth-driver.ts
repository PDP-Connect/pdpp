// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveGrant,
  approveOwnerDeviceAuthorization,
  denyGrant,
  denyOwnerDeviceAuthorization,
  exchangeOwnerDeviceCode,
  getOwnerDeviceAuthorizationByUserCode,
  getOwnerDeviceAuthRowByApprovalId,
  getPendingConsent,
  getPendingConsentRowByApprovalId,
  initiateGrant,
  initiateOwnerDeviceAuthorization,
  parsePendingConsentRequestUri,
  registerConnector,
  seedPreRegisteredClients,
} from "../../server/auth.ts";
import { closeDb, getDb, initDb, runWithSqliteBusyRetry } from "../../server/db.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..", "..");

const SAMPLE_CLIENT_ID = "concert_recommendation_app";
const SAMPLE_CLIENT_NAME = "Concert Recommendation App";

interface SpotifyManifest extends Record<string, unknown> {
  connector_id: string;
}
interface ConsentInput {
  access_mode?: string;
  purpose_code?: string;
  purpose_description?: string;
  streams?: Record<string, unknown>[];
}
interface OwnerInput {
  client_id?: string;
  expires_in?: number;
  interval?: number;
}
interface ExchangeInput {
  client_id?: string;
  device_code?: string;
}
interface ApprovalRow {
  approval_id: string;
}
interface PollRow {
  interval_seconds?: number;
}

function loadSpotifyManifest(): SpotifyManifest {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));
}

function pastIso() {
  // Two hours in the past — well outside the 300s default expiry.
  return new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
}

function rewoundPolledAtIso(intervalSeconds: number): string {
  // Twice the polling interval ago — guarantees the next exchange call is
  // not rejected with `slow_down` regardless of clock granularity.
  const ms = (Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 5) * 2 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

function pendingConsentDeviceCode(requestUri: string): string {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  if (!deviceCode) {
    throw new Error(`invalid pending consent request_uri: ${requestUri}`);
  }
  return deviceCode;
}

export function createSqliteConsentDeviceAuthDriver() {
  let manifest: SpotifyManifest | null = null;

  function ensureSetup() {
    if (!manifest) {
      throw new Error("SqliteConsentDeviceAuthDriver: setup() must be called first");
    }
  }

  return {
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async approveOwnerDeviceAuth(userCode: string) {
      return approveOwnerDeviceAuthorization(userCode);
    },

    async approvePendingConsent(requestUri: string) {
      const deviceCode = pendingConsentDeviceCode(requestUri);
      const review = await getPendingConsent(deviceCode, { finalizeReview: true, subjectId: "owner_local" });
      if (review === null) {
        return approveGrant(deviceCode, "owner_local");
      }
      if (typeof review?.reviewRevision !== "string") {
        throw new Error("pending consent review revision was not materialized");
      }
      return approveGrant(deviceCode, "owner_local", { approval_review_revision: review.reviewRevision });
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async denyOwnerDeviceAuth(userCode: string) {
      return denyOwnerDeviceAuthorization(userCode);
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async denyPendingConsent(requestUri: string) {
      const deviceCode = pendingConsentDeviceCode(requestUri);
      return denyGrant(deviceCode);
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async exchangeOwnerDeviceCode(input: ExchangeInput = {}) {
      return exchangeOwnerDeviceCode({
        clientId: input.client_id,
        deviceCode: input.device_code,
      });
    },

    async forceExpireOwnerDeviceAuth(deviceCode: string) {
      await runWithSqliteBusyRetry(() => {
        getDb().prepare("UPDATE owner_device_auth SET expires_at = ? WHERE device_code = ?").run(pastIso(), deviceCode);
      });
    },

    async forceExpirePendingConsent(requestUri: string) {
      const deviceCode = parsePendingConsentRequestUri(requestUri);
      // Test-only seam: rewind expires_at into the past so the next public
      // lookup / approve / deny call observes the row as expired. This
      // exercises the production isExpired() check (which compares against
      // wall-clock now) without freezing time.
      await runWithSqliteBusyRetry(() => {
        getDb().prepare("UPDATE pending_consents SET expires_at = ? WHERE device_code = ?").run(pastIso(), deviceCode);
      });
    },

    getRegisteredClientId() {
      return SAMPLE_CLIENT_ID;
    },

    getRegisteredConnectorId() {
      ensureSetup();
      if (!manifest?.connector_id) {
        throw new Error("sqlite consent driver setup did not register a manifest");
      }
      return manifest.connector_id;
    },

    async lookupOwnerDeviceAuthByApprovalId(approvalId: string) {
      const row = await getOwnerDeviceAuthRowByApprovalId(approvalId);
      if (!row) {
        return null;
      }
      return {
        approval_id: row.approval_id,
        client_id: row.client_id,
        status: row.status,
        subject_id: row.subject_id || null,
      };
    },

    async lookupOwnerDeviceAuthByUserCode(userCode: string) {
      const view = await getOwnerDeviceAuthorizationByUserCode(userCode);
      if (!view) {
        return null;
      }
      return {
        client_id: view.client_id,
        created_at: view.created_at,
        expires_at: view.expires_at,
        interval: view.interval,
      };
    },

    async lookupPendingConsentByApprovalId(approvalId: string) {
      const row = await getPendingConsentRowByApprovalId(approvalId);
      if (!row) {
        return null;
      }
      return {
        approval_id: row.approval_id,
        grant_id: row.grant_id || null,
        status: row.status,
        subject_id: row.subject_id || null,
      };
    },

    async lookupPendingConsentByRequestUri(requestUri: string) {
      const deviceCode = pendingConsentDeviceCode(requestUri);
      const view = await getPendingConsent(deviceCode);
      if (!view) {
        return null;
      }
      return {
        created_at: view.createdAt,
        expires_at: view.expiresAt,
        user_code: view.userCode,
      };
    },

    async rewindOwnerDevicePollTimer(deviceCode: string) {
      const row = getDb()
        .prepare("SELECT interval_seconds FROM owner_device_auth WHERE device_code = ?")
        .get(deviceCode) as PollRow | undefined;
      const interval = row?.interval_seconds ?? 5;
      await runWithSqliteBusyRetry(() => {
        getDb()
          .prepare("UPDATE owner_device_auth SET last_polled_at = ? WHERE device_code = ?")
          .run(rewoundPolledAtIso(interval), deviceCode);
      });
    },
    async setup() {
      initDb();
      manifest = loadSpotifyManifest();
      await registerConnector(manifest);
      await seedPreRegisteredClients([
        {
          client_id: SAMPLE_CLIENT_ID,
          metadata: {
            client_name: SAMPLE_CLIENT_NAME,
            token_endpoint_auth_method: "none",
          },
        },
      ]);
    },

    // ---------------------------------------------------------------------
    // Owner device authorization.
    // ---------------------------------------------------------------------

    async startOwnerDeviceAuth(input: OwnerInput = {}) {
      ensureSetup();
      const clientId = input.client_id || SAMPLE_CLIENT_ID;
      const interval = input.interval || 5;
      const expiresIn = input.expires_in || 300;
      const result = await initiateOwnerDeviceAuthorization(clientId, {
        expiresIn,
        interval,
      });
      const row = getDb()
        .prepare("SELECT approval_id FROM owner_device_auth WHERE device_code = ?")
        .get(result.device_code) as ApprovalRow | undefined;
      if (!row?.approval_id) {
        throw new Error(`owner_device_auth row missing approval_id for ${result.device_code}`);
      }
      return {
        approval_id: row.approval_id,
        device_code: result.device_code,
        expires_in: result.expires_in,
        interval: result.interval,
        user_code: result.user_code,
        verification_uri: result.verification_uri,
      };
    },

    // ---------------------------------------------------------------------
    // Pending consent.
    // ---------------------------------------------------------------------

    async startPendingConsent(input: ConsentInput = {}) {
      ensureSetup();
      const purposeCode = input.purpose_code || "https://pdpp.dev/purpose/personalization";
      const purposeDescription = input.purpose_description || "consent-device-auth conformance";
      const accessMode = input.access_mode || "continuous";
      const streams = input.streams || [{ name: "top_artists", view: "basic" }];

      const result = await initiateGrant({
        authorization_details: [
          {
            access_mode: accessMode,
            purpose_code: purposeCode,
            purpose_description: purposeDescription,
            source: { id: manifest?.connector_id, kind: "connector" },
            streams,
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_id: SAMPLE_CLIENT_ID,
      });
      const deviceCode = parsePendingConsentRequestUri(result.request_uri);
      const row = getDb().prepare("SELECT approval_id FROM pending_consents WHERE device_code = ?").get(deviceCode) as
        | ApprovalRow
        | undefined;
      if (!row?.approval_id) {
        throw new Error(`pending_consents row missing approval_id for ${deviceCode}`);
      }
      return {
        approval_id: row.approval_id,
        request_uri: result.request_uri,
      };
    },

    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async teardown() {
      manifest = null;
      closeDb();
    },
  };
}
