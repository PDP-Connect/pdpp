// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres-backed driver for the consent + owner-device-auth conformance harness.
 *
 * Test-only proof adapter for `add-postgres-storage-adapters`. It mirrors the
 * lifecycle obligations pinned by `consent-device-auth-conformance.js` directly
 * in Postgres, without importing SQLite helpers or production auth modules.
 *
 * The driver creates a fresh schema per scenario and drops it in teardown, so
 * parallel or crashed runs do not share state. It is gated by the caller's
 * `PDPP_TEST_POSTGRES_URL` check and SHALL NOT be imported from production
 * server paths.
 */

// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";

const { Client } = pg;

const SAMPLE_CLIENT_ID = "postgres_concert_recommendation_app";
const SAMPLE_CONNECTOR_ID = "postgres://manifest/spotify";

const DEFAULT_PENDING_CONSENT_TTL_SECONDS = 300;
const DEFAULT_OWNER_DEVICE_TTL_SECONDS = 300;
const DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS = 5;
const SCHEMA_PREFIX = "pdpp_consent_proof_";
type PgParam = string | number | boolean | null | Date;
interface PgRow {
  [key: string]: unknown;
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

let postgresDriverInstanceCounter = 0;

function uniqueSchemaName() {
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e8).toString(36);
  return `${SCHEMA_PREFIX}${stamp}_${rand}`.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromNowSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function toIso(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
}

function isPast(value: unknown): boolean {
  return new Date(String(value)).getTime() <= Date.now();
}

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function createPostgresConsentDeviceAuthDriver({ connectionString }: { connectionString: string }) {
  if (!connectionString) {
    throw new Error("createPostgresConsentDeviceAuthDriver requires connectionString");
  }

  const schema = uniqueSchemaName();
  // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
  const instanceTag = (++postgresDriverInstanceCounter).toString(36);
  let scopedCounter = 0;
  let userCodeCounter = 0;
  let client: InstanceType<typeof Client> | null = null;

  function nextId(prefix: string): string {
    scopedCounter += 1;
    return `${prefix}_pg_${instanceTag}_${scopedCounter.toString(36)}`;
  }

  function nextUserCode() {
    userCodeCounter += 1;
    return userCodeCounter.toString(16).toUpperCase().padStart(6, "0").slice(-6);
  }

  function q(ident: string): string {
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    if (!/^[a-z0-9_]+$/.test(ident)) {
      throw new Error(`unsafe identifier rejected: ${ident}`);
    }
    return `"${ident}"`;
  }

  async function exec(sql: string, params: PgParam[] = []): Promise<{ rows: PgRow[]; rowCount: number }> {
    const result = await client?.query<PgRow>(sql, params);
    if (!result) {
      throw new Error("Postgres consent driver has not been set up");
    }
    return { rowCount: result.rowCount ?? 0, rows: result.rows };
  }

  async function one(sql: string, params: PgParam[] = []): Promise<PgRow | null> {
    const result = await exec(sql, params);
    return result.rows[0] || null;
  }

  async function markPendingConsentExpired(row: PgRow | null): Promise<void> {
    if (row?.status === "pending") {
      await exec(
        `
        UPDATE pending_consents
        SET status = 'expired'
        WHERE request_uri = $1 AND status = 'pending'
        `,
        [String(row.request_uri)]
      );
    }
  }

  async function markOwnerDeviceExpired(row: PgRow | null): Promise<void> {
    if (row?.status === "pending") {
      await exec(
        `
        UPDATE owner_device_auth
        SET status = 'expired'
        WHERE device_code = $1 AND status = 'pending'
        `,
        [String(row.device_code)]
      );
    }
  }

  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  async function pendingConsentByRequestUri(requestUri: string): Promise<PgRow | null> {
    return one("SELECT * FROM pending_consents WHERE request_uri = $1", [requestUri]);
  }

  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  async function ownerDeviceByUserCode(userCode: string): Promise<PgRow | null> {
    return one("SELECT * FROM owner_device_auth WHERE user_code = $1", [userCode]);
  }

  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  async function ownerDeviceByDeviceCode(deviceCode: string): Promise<PgRow | null> {
    return one("SELECT * FROM owner_device_auth WHERE device_code = $1", [deviceCode]);
  }

  return {
    async approveOwnerDeviceAuth(userCode: string) {
      const row = await ownerDeviceByUserCode(userCode);
      if (!row) {
        throw codedError("Unknown user code", "not_found");
      }
      if (row.status === "approved" && typeof row.token_id === "string") {
        return {
          access_token: row.token_id,
          expires_in: 365 * 24 * 60 * 60,
          subject_id: row.subject_id || "owner_local",
          token_type: "Bearer",
        };
      }
      if (row.status !== "pending") {
        throw codedError("Owner device authorization is not available", "not_found");
      }
      if (isPast(row.expires_at)) {
        await markOwnerDeviceExpired(row);
        throw codedError("Owner device authorization has expired", "not_found");
      }

      const token = nextId("owner_tok");
      await exec(
        `
        UPDATE owner_device_auth
        SET status = 'approved', token_id = $2, subject_id = 'owner_local'
        WHERE user_code = $1 AND status = 'pending'
        `,
        [userCode, token]
      );
      return {
        access_token: token,
        expires_in: 365 * 24 * 60 * 60,
        subject_id: "owner_local",
        token_type: "Bearer",
      };
    },

    async approvePendingConsent(requestUri: string) {
      const row = await pendingConsentByRequestUri(requestUri);
      if (!row) {
        throw codedError("Unknown device code", "not_found");
      }
      if (row.status !== "pending") {
        throw codedError("Pending consent request is not available", "not_found");
      }
      if (isPast(row.expires_at)) {
        await markPendingConsentExpired(row);
        throw codedError("Pending consent request has expired", "not_found");
      }

      const grantId = nextId("grt");
      const token = nextId("tok");
      await exec(
        `
        UPDATE pending_consents
        SET status = 'approved', grant_id = $2, token_id = $3, subject_id = 'owner_local'
        WHERE request_uri = $1 AND status = 'pending'
        `,
        [requestUri, grantId, token]
      );
      return {
        grant: { grant_id: grantId, version: "0.1.0" },
        token,
      };
    },

    async denyOwnerDeviceAuth(userCode: string) {
      const row = await ownerDeviceByUserCode(userCode);
      if (!row) {
        throw codedError("Unknown user code", "not_found");
      }
      if (row.status !== "pending") {
        throw codedError("Owner device authorization is not available", "not_found");
      }
      if (isPast(row.expires_at)) {
        await markOwnerDeviceExpired(row);
        throw codedError("Owner device authorization has expired", "not_found");
      }

      await exec(
        `
        UPDATE owner_device_auth
        SET status = 'denied'
        WHERE user_code = $1 AND status = 'pending'
        `,
        [userCode]
      );
    },

    async denyPendingConsent(requestUri: string) {
      const row = await pendingConsentByRequestUri(requestUri);
      if (row?.status !== "pending") {
        return false;
      }
      if (isPast(row.expires_at)) {
        await markPendingConsentExpired(row);
        return false;
      }
      const result = await exec(
        `
        UPDATE pending_consents
        SET status = 'denied'
        WHERE request_uri = $1 AND status = 'pending'
        `,
        [requestUri]
      );
      return result.rowCount > 0;
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: localized test assertion preserves its explicit contract.
    async exchangeOwnerDeviceCode(input: ExchangeInput = {}) {
      const clientId = input.client_id;
      const deviceCode = input.device_code;
      if (!(clientId && deviceCode)) {
        throw codedError("client_id and device_code are required", "invalid_request");
      }

      const row = await ownerDeviceByDeviceCode(deviceCode);
      if (!row || row.client_id !== clientId) {
        throw codedError("Unknown or invalid device_code", "invalid_grant");
      }

      if (row.status === "pending" && isPast(row.expires_at)) {
        await markOwnerDeviceExpired(row);
        throw codedError("Device code has expired", "expired_token");
      }
      if (row.status === "denied") {
        throw codedError("The resource owner denied the request", "access_denied");
      }
      if (row.status === "expired") {
        throw codedError("Device code has expired", "expired_token");
      }

      if (row.status === "pending") {
        if (row.last_polled_at) {
          const sinceLastPollMs = Date.now() - new Date(String(row.last_polled_at)).getTime();
          if (sinceLastPollMs < Number(row.interval_seconds) * 1000) {
            throw codedError("Polling too quickly", "slow_down");
          }
        }
        await exec(
          `
          UPDATE owner_device_auth
          SET last_polled_at = $2
          WHERE device_code = $1
          `,
          [deviceCode, nowIso()]
        );
        throw codedError("Authorization still pending", "authorization_pending");
      }

      if (!row.token_id) {
        throw codedError("Owner token is not bound", "expired_token");
      }
      return {
        access_token: row.token_id,
        expires_in: 365 * 24 * 60 * 60,
        token_type: "Bearer",
      };
    },

    async forceExpireOwnerDeviceAuth(deviceCode: string) {
      await exec(
        `
        UPDATE owner_device_auth
        SET expires_at = NOW() - INTERVAL '1 second'
        WHERE device_code = $1
        `,
        [deviceCode]
      );
    },

    async forceExpirePendingConsent(requestUri: string) {
      await exec(
        `
        UPDATE pending_consents
        SET expires_at = NOW() - INTERVAL '1 second'
        WHERE request_uri = $1
        `,
        [requestUri]
      );
    },

    getRegisteredClientId() {
      return SAMPLE_CLIENT_ID;
    },

    getRegisteredConnectorId() {
      return SAMPLE_CONNECTOR_ID;
    },

    async lookupOwnerDeviceAuthByApprovalId(approvalId: string) {
      const row = await one("SELECT * FROM owner_device_auth WHERE approval_id = $1", [approvalId]);
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
        subject_id: row.subject_id,
      };
    },

    async lookupOwnerDeviceAuthByUserCode(userCode: string) {
      const row = await ownerDeviceByUserCode(userCode);
      if (!row) {
        return null;
      }
      if (row.status !== "pending") {
        return null;
      }
      if (isPast(row.expires_at)) {
        await markOwnerDeviceExpired(row);
        return null;
      }
      if (typeof row.interval_seconds !== "number") {
        throw new Error("owner device row missing interval");
      }
      return {
        client_id: row.client_id,
        created_at: toIso(row.created_at),
        expires_at: toIso(row.expires_at),
        interval: row.interval_seconds,
      };
    },

    async lookupPendingConsentByApprovalId(approvalId: string) {
      const row = await one("SELECT * FROM pending_consents WHERE approval_id = $1", [approvalId]);
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
        grant_id: row.grant_id,
        status: row.status,
        subject_id: row.subject_id,
      };
    },

    async lookupPendingConsentByRequestUri(requestUri: string) {
      const row = await pendingConsentByRequestUri(requestUri);
      if (!row) {
        return null;
      }
      if (row.status !== "pending") {
        return null;
      }
      if (isPast(row.expires_at)) {
        await markPendingConsentExpired(row);
        return null;
      }
      if (typeof row.user_code !== "string") {
        throw new Error("pending consent row missing user_code");
      }
      return {
        created_at: toIso(row.created_at),
        expires_at: toIso(row.expires_at),
        user_code: row.user_code,
      };
    },

    async rewindOwnerDevicePollTimer(deviceCode: string) {
      const row = await ownerDeviceByDeviceCode(deviceCode);
      if (!row) {
        return;
      }
      const intervalMs = (Number(row.interval_seconds) || DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS) * 2 * 1000;
      await exec(
        `
        UPDATE owner_device_auth
        SET last_polled_at = $2
        WHERE device_code = $1
        `,
        [deviceCode, new Date(Date.now() - intervalMs).toISOString()]
      );
    },
    async setup() {
      client = new Client({ connectionString });
      await client.connect();
      await exec(`CREATE SCHEMA ${q(schema)}`);
      await exec(`SET search_path TO ${q(schema)}`);

      await exec(`
        CREATE TABLE pending_consents (
          request_uri TEXT PRIMARY KEY,
          device_code TEXT NOT NULL UNIQUE,
          approval_id TEXT NOT NULL UNIQUE,
          user_code TEXT NOT NULL,
          status TEXT NOT NULL,
          purpose_code TEXT NOT NULL,
          purpose_description TEXT NOT NULL,
          access_mode TEXT NOT NULL,
          streams JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          grant_id TEXT,
          token_id TEXT,
          subject_id TEXT
        )
      `);

      await exec(`
        CREATE TABLE owner_device_auth (
          device_code TEXT PRIMARY KEY,
          user_code TEXT NOT NULL UNIQUE,
          approval_id TEXT NOT NULL UNIQUE,
          client_id TEXT NOT NULL,
          status TEXT NOT NULL,
          interval_seconds INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          last_polled_at TIMESTAMPTZ,
          token_id TEXT,
          subject_id TEXT
        )
      `);
    },

    async startOwnerDeviceAuth(input: OwnerInput = {}) {
      const deviceCode = nextId("dc_owner");
      const userCode = nextUserCode();
      const approvalId = nextId("appr");
      const interval =
        typeof input.interval === "number" && Number.isFinite(input.interval) && input.interval > 0
          ? input.interval
          : DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS;
      const expiresInSeconds =
        typeof input.expires_in === "number" && Number.isFinite(input.expires_in) && input.expires_in > 0
          ? input.expires_in
          : DEFAULT_OWNER_DEVICE_TTL_SECONDS;
      const createdAt = nowIso();
      const expiresAt = isoFromNowSeconds(expiresInSeconds);
      const clientId = input.client_id || SAMPLE_CLIENT_ID;

      await exec(
        `
        INSERT INTO owner_device_auth (
          device_code, user_code, approval_id, client_id, status,
          interval_seconds, created_at, expires_at, last_polled_at,
          token_id, subject_id
        )
        VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, NULL, NULL, NULL)
        `,
        [deviceCode, userCode, approvalId, clientId, interval, createdAt, expiresAt]
      );

      return {
        approval_id: approvalId,
        device_code: deviceCode,
        expires_in: expiresInSeconds,
        interval,
        user_code: userCode,
      };
    },

    async startPendingConsent(input: ConsentInput = {}) {
      const deviceCode = nextId("dc");
      const requestUri = `urn:pdpp:pending-consent:${deviceCode}`;
      const approvalId = nextId("appr");
      const userCode = nextUserCode();
      const createdAt = nowIso();
      const expiresAt = isoFromNowSeconds(DEFAULT_PENDING_CONSENT_TTL_SECONDS);
      const streams = Array.isArray(input.streams) ? input.streams : [{ name: "top_artists", view: "basic" }];

      await exec(
        `
        INSERT INTO pending_consents (
          request_uri, device_code, approval_id, user_code, status,
          purpose_code, purpose_description, access_mode, streams,
          created_at, expires_at, grant_id, token_id, subject_id
        )
        VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8::jsonb, $9, $10, NULL, NULL, NULL)
        `,
        [
          requestUri,
          deviceCode,
          approvalId,
          userCode,
          input.purpose_code || "https://pdpp.dev/purpose/personalization",
          input.purpose_description || "postgres consent-device-auth conformance",
          input.access_mode || "continuous",
          JSON.stringify(streams),
          createdAt,
          expiresAt,
        ]
      );

      return { approval_id: approvalId, request_uri: requestUri };
    },

    async teardown() {
      if (!client) {
        return;
      }
      try {
        await exec(`DROP SCHEMA ${q(schema)} CASCADE`);
      } finally {
        await client.end();
        client = null;
      }
    },
  };
}
