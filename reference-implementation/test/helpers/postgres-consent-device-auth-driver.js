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

import pg from 'pg';

const { Client } = pg;

const SAMPLE_CLIENT_ID = 'postgres_concert_recommendation_app';
const SAMPLE_CONNECTOR_ID = 'postgres://manifest/spotify';

const DEFAULT_PENDING_CONSENT_TTL_SECONDS = 300;
const DEFAULT_OWNER_DEVICE_TTL_SECONDS = 300;
const DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS = 5;
const SCHEMA_PREFIX = 'pdpp_consent_proof_';

let postgresDriverInstanceCounter = 0;

function uniqueSchemaName() {
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e8).toString(36);
  return `${SCHEMA_PREFIX}${stamp}_${rand}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromNowSeconds(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function toIso(value) {
  if (!value) return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function isPast(value) {
  return new Date(value).getTime() <= Date.now();
}

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createPostgresConsentDeviceAuthDriver({ connectionString }) {
  if (!connectionString) {
    throw new Error('createPostgresConsentDeviceAuthDriver requires connectionString');
  }

  const schema = uniqueSchemaName();
  const instanceTag = (++postgresDriverInstanceCounter).toString(36);
  let scopedCounter = 0;
  let userCodeCounter = 0;
  let client = null;

  function nextId(prefix) {
    scopedCounter += 1;
    return `${prefix}_pg_${instanceTag}_${scopedCounter.toString(36)}`;
  }

  function nextUserCode() {
    userCodeCounter += 1;
    return userCodeCounter.toString(16).toUpperCase().padStart(6, '0').slice(-6);
  }

  function q(ident) {
    if (!/^[a-z0-9_]+$/.test(ident)) {
      throw new Error(`unsafe identifier rejected: ${ident}`);
    }
    return `"${ident}"`;
  }

  async function exec(sql, params = []) {
    return client.query(sql, params);
  }

  async function one(sql, params = []) {
    const result = await exec(sql, params);
    return result.rows[0] || null;
  }

  async function markPendingConsentExpired(row) {
    if (row?.status === 'pending') {
      await exec(
        `
        UPDATE pending_consents
        SET status = 'expired'
        WHERE request_uri = $1 AND status = 'pending'
        `,
        [row.request_uri],
      );
    }
  }

  async function markOwnerDeviceExpired(row) {
    if (row?.status === 'pending') {
      await exec(
        `
        UPDATE owner_device_auth
        SET status = 'expired'
        WHERE device_code = $1 AND status = 'pending'
        `,
        [row.device_code],
      );
    }
  }

  async function pendingConsentByRequestUri(requestUri) {
    return one('SELECT * FROM pending_consents WHERE request_uri = $1', [requestUri]);
  }

  async function ownerDeviceByUserCode(userCode) {
    return one('SELECT * FROM owner_device_auth WHERE user_code = $1', [userCode]);
  }

  async function ownerDeviceByDeviceCode(deviceCode) {
    return one('SELECT * FROM owner_device_auth WHERE device_code = $1', [deviceCode]);
  }

  return {
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

    async teardown() {
      if (!client) return;
      try {
        await exec(`DROP SCHEMA ${q(schema)} CASCADE`);
      } finally {
        await client.end();
        client = null;
      }
    },

    getRegisteredClientId() {
      return SAMPLE_CLIENT_ID;
    },

    getRegisteredConnectorId() {
      return SAMPLE_CONNECTOR_ID;
    },

    async startPendingConsent(input = {}) {
      const deviceCode = nextId('dc');
      const requestUri = `urn:pdpp:pending-consent:${deviceCode}`;
      const approvalId = nextId('appr');
      const userCode = nextUserCode();
      const createdAt = nowIso();
      const expiresAt = isoFromNowSeconds(DEFAULT_PENDING_CONSENT_TTL_SECONDS);
      const streams = Array.isArray(input.streams) ? input.streams : [{ name: 'top_artists', view: 'basic' }];

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
          input.purpose_code || 'https://pdpp.org/purpose/personalization',
          input.purpose_description || 'postgres consent-device-auth conformance',
          input.access_mode || 'continuous',
          JSON.stringify(streams),
          createdAt,
          expiresAt,
        ],
      );

      return { request_uri: requestUri, approval_id: approvalId };
    },

    async lookupPendingConsentByRequestUri(requestUri) {
      const row = await pendingConsentByRequestUri(requestUri);
      if (!row) return null;
      if (row.status !== 'pending') return null;
      if (isPast(row.expires_at)) {
        await markPendingConsentExpired(row);
        return null;
      }
      return {
        user_code: row.user_code,
        created_at: toIso(row.created_at),
        expires_at: toIso(row.expires_at),
      };
    },

    async lookupPendingConsentByApprovalId(approvalId) {
      const row = await one('SELECT * FROM pending_consents WHERE approval_id = $1', [approvalId]);
      if (!row) return null;
      return {
        status: row.status,
        approval_id: row.approval_id,
        grant_id: row.grant_id,
        subject_id: row.subject_id,
      };
    },

    async approvePendingConsent(requestUri) {
      const row = await pendingConsentByRequestUri(requestUri);
      if (!row) {
        throw codedError('Unknown device code', 'not_found');
      }
      if (row.status !== 'pending') {
        throw codedError('Pending consent request is not available', 'not_found');
      }
      if (isPast(row.expires_at)) {
        await markPendingConsentExpired(row);
        throw codedError('Pending consent request has expired', 'not_found');
      }

      const grantId = nextId('grt');
      const token = nextId('tok');
      await exec(
        `
        UPDATE pending_consents
        SET status = 'approved', grant_id = $2, token_id = $3, subject_id = 'owner_local'
        WHERE request_uri = $1 AND status = 'pending'
        `,
        [requestUri, grantId, token],
      );
      return {
        grant: { grant_id: grantId, version: '0.1.0' },
        token,
      };
    },

    async denyPendingConsent(requestUri) {
      const row = await pendingConsentByRequestUri(requestUri);
      if (!row || row.status !== 'pending') return false;
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
        [requestUri],
      );
      return result.rowCount > 0;
    },

    async forceExpirePendingConsent(requestUri) {
      await exec(
        `
        UPDATE pending_consents
        SET expires_at = NOW() - INTERVAL '1 second'
        WHERE request_uri = $1
        `,
        [requestUri],
      );
    },

    async startOwnerDeviceAuth(input = {}) {
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

      await exec(
        `
        INSERT INTO owner_device_auth (
          device_code, user_code, approval_id, client_id, status,
          interval_seconds, created_at, expires_at, last_polled_at,
          token_id, subject_id
        )
        VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, NULL, NULL, NULL)
        `,
        [deviceCode, userCode, approvalId, clientId, interval, createdAt, expiresAt],
      );

      return {
        device_code: deviceCode,
        user_code: userCode,
        interval,
        expires_in: expiresInSeconds,
        approval_id: approvalId,
      };
    },

    async lookupOwnerDeviceAuthByUserCode(userCode) {
      const row = await ownerDeviceByUserCode(userCode);
      if (!row) return null;
      if (row.status !== 'pending') return null;
      if (isPast(row.expires_at)) {
        await markOwnerDeviceExpired(row);
        return null;
      }
      return {
        client_id: row.client_id,
        interval: row.interval_seconds,
        created_at: toIso(row.created_at),
        expires_at: toIso(row.expires_at),
      };
    },

    async lookupOwnerDeviceAuthByApprovalId(approvalId) {
      const row = await one('SELECT * FROM owner_device_auth WHERE approval_id = $1', [approvalId]);
      if (!row) return null;
      return {
        status: row.status,
        approval_id: row.approval_id,
        client_id: row.client_id,
        subject_id: row.subject_id,
      };
    },

    async approveOwnerDeviceAuth(userCode) {
      const row = await ownerDeviceByUserCode(userCode);
      if (!row) {
        throw codedError('Unknown user code', 'not_found');
      }
      if (row.status !== 'pending') {
        throw codedError('Owner device authorization is not available', 'not_found');
      }
      if (isPast(row.expires_at)) {
        await markOwnerDeviceExpired(row);
        throw codedError('Owner device authorization has expired', 'not_found');
      }

      const token = nextId('owner_tok');
      await exec(
        `
        UPDATE owner_device_auth
        SET status = 'approved', token_id = $2, subject_id = 'owner_local'
        WHERE user_code = $1 AND status = 'pending'
        `,
        [userCode, token],
      );
      return {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 365 * 24 * 60 * 60,
        subject_id: 'owner_local',
      };
    },

    async denyOwnerDeviceAuth(userCode) {
      const row = await ownerDeviceByUserCode(userCode);
      if (!row) {
        throw codedError('Unknown user code', 'not_found');
      }
      if (row.status !== 'pending') {
        throw codedError('Owner device authorization is not available', 'not_found');
      }
      if (isPast(row.expires_at)) {
        await markOwnerDeviceExpired(row);
        throw codedError('Owner device authorization has expired', 'not_found');
      }

      await exec(
        `
        UPDATE owner_device_auth
        SET status = 'denied'
        WHERE user_code = $1 AND status = 'pending'
        `,
        [userCode],
      );
    },

    async exchangeOwnerDeviceCode(input = {}) {
      const clientId = input.client_id;
      const deviceCode = input.device_code;
      if (!clientId || !deviceCode) {
        throw codedError('client_id and device_code are required', 'invalid_request');
      }

      const row = await ownerDeviceByDeviceCode(deviceCode);
      if (!row || row.client_id !== clientId) {
        throw codedError('Unknown or invalid device_code', 'invalid_grant');
      }

      if (row.status === 'pending' && isPast(row.expires_at)) {
        await markOwnerDeviceExpired(row);
        throw codedError('Device code has expired', 'expired_token');
      }
      if (row.status === 'denied') {
        throw codedError('The resource owner denied the request', 'access_denied');
      }
      if (row.status === 'expired') {
        throw codedError('Device code has expired', 'expired_token');
      }

      if (row.status === 'pending') {
        if (row.last_polled_at) {
          const sinceLastPollMs = Date.now() - new Date(row.last_polled_at).getTime();
          if (sinceLastPollMs < row.interval_seconds * 1000) {
            throw codedError('Polling too quickly', 'slow_down');
          }
        }
        await exec(
          `
          UPDATE owner_device_auth
          SET last_polled_at = $2
          WHERE device_code = $1
          `,
          [deviceCode, nowIso()],
        );
        throw codedError('Authorization still pending', 'authorization_pending');
      }

      if (!row.token_id) {
        throw codedError('Owner token is not bound', 'expired_token');
      }
      return {
        access_token: row.token_id,
        token_type: 'Bearer',
        expires_in: 365 * 24 * 60 * 60,
      };
    },

    async forceExpireOwnerDeviceAuth(deviceCode) {
      await exec(
        `
        UPDATE owner_device_auth
        SET expires_at = NOW() - INTERVAL '1 second'
        WHERE device_code = $1
        `,
        [deviceCode],
      );
    },

    async rewindOwnerDevicePollTimer(deviceCode) {
      const row = await ownerDeviceByDeviceCode(deviceCode);
      if (!row) return;
      const intervalMs = (row.interval_seconds || DEFAULT_OWNER_DEVICE_INTERVAL_SECONDS) * 2 * 1000;
      await exec(
        `
        UPDATE owner_device_auth
        SET last_polled_at = $2
        WHERE device_code = $1
        `,
        [deviceCode, new Date(Date.now() - intervalMs).toISOString()],
      );
    },
  };
}
