// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production-store-backed driver for the consent + owner-device-auth
 * conformance harness.
 *
 * Unlike `sqlite-consent-device-auth-driver.js`, which calls the
 * lifecycle helpers in `server/auth.ts` directly, this driver consumes
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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerConnector, seedPreRegisteredClients } from "../../server/auth.ts";
import { closeDb, getDb, initDb, runWithSqliteBusyRetry } from "../../server/db.ts";
import { createSqliteConsentStore } from "../../server/stores/consent-store.ts";
import { createSqliteOwnerDeviceAuthStore } from "../../server/stores/owner-device-auth-store.ts";

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
interface OwnerStartResult {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
}
interface OwnerView {
  client_id: string;
  created_at: string;
  expires_at: string;
  interval: number;
}
interface OwnerApprovalRow {
  approval_id: string;
  client_id: string;
  status: string;
  subject_id?: string | null;
}
interface ApprovalResult {
  access_token?: string;
  grant?: { grant_id: string };
  token?: string;
  [key: string]: unknown;
}
interface OwnerStore {
  approve: (userCode: string) => Promise<unknown>;
  deny: (userCode: string) => Promise<unknown>;
  exchangeDeviceCode: (input: { clientId?: string | undefined; deviceCode?: string | undefined }) => Promise<unknown>;
  getByApprovalId: (approvalId: string) => Promise<OwnerApprovalRow | null>;
  getByUserCode: (userCode: string) => Promise<OwnerView | null>;
  initiate: (clientId: string, options: { interval: number; expiresIn: number }) => Promise<OwnerStartResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeApprovalResult(value: unknown): ApprovalResult {
  if (!isRecord(value)) {
    throw new Error("approval operation returned a non-object result");
  }
  if (value.grant !== undefined && (!isRecord(value.grant) || typeof value.grant.grant_id !== "string")) {
    throw new Error("approval operation returned an invalid grant");
  }
  if (value.token !== undefined && typeof value.token !== "string") {
    throw new Error("approval operation returned an invalid token");
  }
  if (value.access_token !== undefined && typeof value.access_token !== "string") {
    throw new Error("approval operation returned an invalid access token");
  }
  return value;
}

function loadSpotifyManifest(): SpotifyManifest {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));
}

function pastIso() {
  return new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
}

function rewoundPolledAtIso(intervalSeconds: number): string {
  const ms = (Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 5) * 2 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

export function createProductionConsentDeviceAuthDriver() {
  let manifest: SpotifyManifest | null = null;
  let consentStore: ReturnType<typeof createSqliteConsentStore> | null = null;
  let ownerDeviceAuthStore: OwnerStore | null = null;

  function ensureSetup() {
    if (!manifest) {
      throw new Error("ProductionConsentDeviceAuthDriver: setup() must be called first");
    }
  }

  return {
    async approveOwnerDeviceAuth(userCode: string) {
      return normalizeApprovalResult(await ownerDeviceAuthStore?.approve(userCode));
    },

    async approvePendingConsent(requestUri: string) {
      const deviceCode = consentStore?.parseRequestUri(requestUri);
      if (!deviceCode) {
        throw new Error("pending consent request URI is invalid");
      }
      const review = await consentStore?.getPendingConsentByDeviceCode(deviceCode, {
        finalizeReview: true,
        subjectId: "owner_local",
      });
      if (review === null) {
        return normalizeApprovalResult(await consentStore?.approveGrant(deviceCode, "owner_local"));
      }
      if (typeof review?.reviewRevision !== "string") {
        throw new Error("pending consent review revision was not materialized");
      }
      return normalizeApprovalResult(
        await consentStore?.approveGrant(deviceCode, "owner_local", {
          approval_review_revision: review.reviewRevision,
        })
      );
    },

    async denyOwnerDeviceAuth(userCode: string) {
      await ownerDeviceAuthStore?.deny(userCode);
    },

    denyPendingConsent(requestUri: string) {
      const store = consentStore;
      if (!store) {
        throw new Error("production consent driver has not been set up");
      }
      const deviceCode = store.parseRequestUri(requestUri);
      if (!deviceCode) {
        throw new Error(`invalid pending-consent request URI: ${requestUri}`);
      }
      return store.denyGrant(deviceCode);
    },

    async exchangeOwnerDeviceCode(input: ExchangeInput = {}) {
      return normalizeApprovalResult(
        await ownerDeviceAuthStore?.exchangeDeviceCode({
          clientId: input.client_id,
          deviceCode: input.device_code,
        })
      );
    },

    async forceExpireOwnerDeviceAuth(deviceCode: string) {
      // Test-only seam — see comment on forceExpirePendingConsent.
      await runWithSqliteBusyRetry(() => {
        getDb().prepare("UPDATE owner_device_auth SET expires_at = ? WHERE device_code = ?").run(pastIso(), deviceCode);
      });
    },

    async forceExpirePendingConsent(requestUri: string) {
      const deviceCode = consentStore?.parseRequestUri(requestUri);
      // Test-only seam — local to the driver. The production ConsentStore
      // intentionally has no force-expire surface; expiry is a wall-clock
      // property exercised by rewinding the row's expires_at.
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
        throw new Error("production consent driver setup did not register a manifest");
      }
      return manifest.connector_id;
    },

    async lookupOwnerDeviceAuthByApprovalId(approvalId: string) {
      const row = await ownerDeviceAuthStore?.getByApprovalId(approvalId);
      if (!row) {
        return null;
      }
      if (typeof row.status !== "string") {
        throw new Error("owner device row missing status");
      }
      return {
        approval_id: row.approval_id,
        client_id: row.client_id,
        status: row.status,
        subject_id: row.subject_id || null,
      };
    },

    async lookupOwnerDeviceAuthByUserCode(userCode: string) {
      const view = await ownerDeviceAuthStore?.getByUserCode(userCode);
      if (!view) {
        return null;
      }
      if (
        typeof view.interval !== "number" ||
        typeof view.created_at !== "string" ||
        typeof view.expires_at !== "string"
      ) {
        throw new Error("owner device view has invalid timing fields");
      }
      return {
        client_id: view.client_id,
        created_at: view.created_at,
        expires_at: view.expires_at,
        interval: view.interval,
      };
    },

    async lookupPendingConsentByApprovalId(approvalId: string) {
      const row = await consentStore?.getPendingConsentByApprovalId(approvalId);
      if (!row) {
        return null;
      }
      if (typeof row.status !== "string") {
        throw new Error("pending consent row missing status");
      }
      if (row.grant_id !== null && typeof row.grant_id !== "string") {
        throw new Error("pending consent row has invalid grant_id");
      }
      return {
        approval_id: row.approval_id,
        grant_id: row.grant_id || null,
        status: row.status,
        subject_id: row.subject_id || null,
      };
    },

    async lookupPendingConsentByRequestUri(requestUri: string) {
      const view = await consentStore?.getPendingConsentByRequestUri(requestUri);
      if (!view) {
        return null;
      }
      if (typeof view.userCode !== "string") {
        throw new Error("pending consent view missing user_code");
      }
      if (typeof view.createdAt !== "string" || typeof view.expiresAt !== "string") {
        throw new Error("pending consent view missing timestamps");
      }
      return {
        created_at: view.createdAt,
        expires_at: view.expiresAt,
        user_code: view.userCode,
      };
    },

    async rewindOwnerDevicePollTimer(deviceCode: string) {
      // Test-only seam — see comment on forceExpirePendingConsent.
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
      consentStore = createSqliteConsentStore();
      ownerDeviceAuthStore = createSqliteOwnerDeviceAuthStore() as OwnerStore;
    },

    // ---------------------------------------------------------------------
    // Owner device authorization — driven through the production
    // OwnerDeviceAuthStore.
    // ---------------------------------------------------------------------

    async startOwnerDeviceAuth(input: OwnerInput = {}) {
      ensureSetup();
      const clientId = input.client_id || SAMPLE_CLIENT_ID;
      const interval = input.interval || 5;
      const expiresIn = input.expires_in || 300;
      const ownerStore = ownerDeviceAuthStore;
      if (!ownerStore) {
        throw new Error("production consent driver has not been set up");
      }
      const result = await ownerStore.initiate(clientId, {
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
    // Pending consent — driven through the production ConsentStore.
    // ---------------------------------------------------------------------

    async startPendingConsent(input: ConsentInput = {}) {
      ensureSetup();
      const purposeCode = input.purpose_code || "https://pdpp.dev/purpose/personalization";
      const purposeDescription = input.purpose_description || "consent-device-auth conformance";
      const accessMode = input.access_mode || "continuous";
      const streams = input.streams || [{ name: "top_artists", view: "basic" }];

      const store = consentStore;
      if (!(store && manifest?.connector_id)) {
        throw new Error("production consent driver has not been set up");
      }
      const result = await store.initiateGrant({
        authorization_details: [
          {
            access_mode: accessMode,
            purpose_code: purposeCode,
            purpose_description: purposeDescription,
            source: { id: manifest.connector_id, kind: "connector" },
            streams,
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_id: SAMPLE_CLIENT_ID,
      });
      const deviceCode = store.parseRequestUri(result.request_uri);
      // The approval_id is generated and stored alongside the row by the
      // store. We resolve it here through a SQLite-only path because the
      // production store does not expose a "give me the approval_id for
      // this device_code" surface — by design: callers should resolve
      // approval ids from public projections, not from device codes.
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

    teardown() {
      manifest = null;
      consentStore = null;
      ownerDeviceAuthStore = null;
      closeDb();
      return Promise.resolve();
    },
  };
}
