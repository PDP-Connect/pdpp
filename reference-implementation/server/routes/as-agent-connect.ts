// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapters for the AS agent-connect route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family`. Each `mount...` function
// registers one route at the same point in registration order where
// `server/index.js` previously registered it inline. Auth posture, status
// codes, error envelopes, and operation delegation are all unchanged.
//
// Routes covered:
//   POST /agent-connect               - register a PAR request for CLI polling
//   POST /agent-connect/:attemptId/token - poll for / redeem the issued bearer
//
// Auth posture: none (unauthenticated). Possession of the opaque polling_code
// is the only gate on token redemption.
//
// The in-progress attempt state lives in an `AgentConnectAttemptStore` created
// by `createAgentConnectAttemptStore`. The store is instantiated once in
// `buildAsApp` and passed to both route adapters AND to the consent
// approve/deny handlers so all three share the same durable rows.

import { createHash, timingSafeEqual } from "node:crypto";
import { exec, getMany, getOne, referenceQueries } from "../../lib/db.ts";
import { parsePendingConsentRequestUri } from "../auth.ts";
import { applyCredentialResponseNoStoreHeaders } from "../credential-response-cache.ts";
import { isPostgresStorageBackend, postgresQuery, withPostgresTransaction } from "../postgres-storage.ts";
import type { PdppErrorFn, RouteArg } from "./_route-contract.ts";

// ─── Attempt store ───────────────────────────────────────────────────────────

export interface AgentConnectAttempt {
  readonly approvalUrl: string;
  readonly clientId: string | null;
  completedAt?: string;
  readonly createdAt: string;
  readonly expiresAt: number;
  grant?: Record<string, unknown>;
  grantId?: string | null;
  readonly id: string;
  readonly interval: number;
  readonly pollingCode: string;
  readonly pollingCodeHash?: string;
  readonly requestUri: string;
  responseJson?: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  token?: string;
  readonly tokenUrl: string;
}

export interface AgentConnectAttemptStore {
  /**
   * Complete all pending attempts matching `requestUri`. Called by the consent
   * approve handler with `status: 'approved'` (plus token/grant) and by the
   * deny handler with `status: 'denied'`.
   */
  complete: (
    requestUri: string | null | undefined,
    outcome:
      | { status: "approved"; token: string; grant: Record<string, unknown>; grantId?: string | null }
      | { status: "denied" | "expired" }
  ) => Promise<void>;
  /** Create and register a new pending attempt, if consent remains pending. */
  create: (opts: {
    id: string;
    now: number;
    pollingCode: string;
    requestUri: string;
    clientId: string | null;
    expiresAt: number;
    approvalUrl: string;
    tokenUrl: string;
  }) => Promise<AgentConnectAttempt | undefined>;
  /** Remove an attempt by id. */
  delete: (id: string) => Promise<void>;
  /**
   * Shorthand for `complete(requestUri, { status })` for non-approval outcomes.
   * Called by the consent deny handler.
   */
  fail: (requestUri: string | null | undefined, status: "denied" | "expired") => Promise<void>;
  /** Look up an attempt by id. */
  get: (id: string) => Promise<AgentConnectAttempt | undefined>;
  /** Evict expired/completed attempts (call before creating new ones). */
  prune: (now?: number) => Promise<void>;
  redeem: (
    id: string,
    pollingCode: string,
    now?: number
  ) => Promise<
    | { outcome: "missing" }
    | { outcome: "pending"; interval: number }
    | { outcome: "failed"; status: "denied" | "expired" }
    | { outcome: "approved"; body: Record<string, unknown>; replay: boolean }
  >;
}

let completeFailureForTest: (() => void) | null = null;
let cleanupAfterMissForTest: (() => void | Promise<void>) | null = null;
let cleanupBeforeExpireForTest: (() => void | Promise<void>) | null = null;
let createBeforePersistForTest: (() => void | Promise<void>) | null = null;
let completeBeforeMarkForTest: (() => void | Promise<void>) | null = null;

export function __setAgentConnectCompleteFailureForTest(fn: (() => void) | null): void {
  completeFailureForTest = fn;
}

export function __setAgentConnectCleanupAfterMissForTest(fn: (() => void | Promise<void>) | null): void {
  cleanupAfterMissForTest = fn;
}

export function __setAgentConnectCleanupBeforeExpireForTest(fn: (() => void | Promise<void>) | null): void {
  cleanupBeforeExpireForTest = fn;
}

export function __setAgentConnectCreateBeforePersistForTest(fn: (() => void | Promise<void>) | null): void {
  createBeforePersistForTest = fn;
}

export function __setAgentConnectCompleteBeforeMarkForTest(fn: (() => void | Promise<void>) | null): void {
  completeBeforeMarkForTest = fn;
}

interface RecoveredApprovedConsent {
  grant_id?: string | null;
  grant_json?: unknown;
  package_json?: unknown;
  token_id?: string | null;
}

function objectFromStoredJson(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return null;
}

function grantFromRecoveredConsent(recovered: RecoveredApprovedConsent): Record<string, unknown> | null {
  return objectFromStoredJson(recovered.grant_json) ?? objectFromStoredJson(recovered.package_json);
}

export function createAgentConnectAttemptStore(): AgentConnectAttemptStore {
  const hashPollingCode = (code: string) => createHash("sha256").update(code, "utf8").digest("base64url");
  const pollingCodeMatches = (hash: string, code: string) => {
    const expected = Buffer.from(hash);
    const actual = Buffer.from(hashPollingCode(code));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };
  const rowToAttempt = (row: Record<string, unknown>): AgentConnectAttempt => {
    const grantJson = row.grant_json;
    const attempt: AgentConnectAttempt = {
      approvalUrl: row.approval_url as string,
      clientId: (row.client_id as string | null | undefined) ?? null,
      createdAt: row.created_at as string,
      expiresAt: Number(row.expires_at_ms),
      grantId: (row.grant_id as string | null | undefined) ?? null,
      id: row.id as string,
      interval: Number(row.interval_seconds ?? 2),
      pollingCode: "",
      pollingCodeHash: row.polling_code_hash as string,
      requestUri: row.request_uri as string,
      responseJson: (row.response_json as string | null | undefined) ?? null,
      status: row.status as AgentConnectAttempt["status"],
      tokenUrl: row.token_url as string,
    };
    if (typeof row.completed_at === "string") {
      attempt.completedAt = row.completed_at;
    }
    if (typeof grantJson === "string") {
      attempt.grant = JSON.parse(grantJson) as Record<string, unknown>;
    } else if (grantJson && typeof grantJson === "object") {
      attempt.grant = grantJson as Record<string, unknown>;
    }
    if (typeof row.token === "string") {
      attempt.token = row.token;
    }
    return attempt;
  };
  const getRow = async (id: string): Promise<AgentConnectAttempt | undefined> => {
    if (isPostgresStorageBackend()) {
      const result = await postgresQuery("SELECT * FROM agent_connect_attempts WHERE id = $1", [id]);
      const [row] = result.rows;
      return row ? rowToAttempt(row) : undefined;
    }
    const row = getOne<Record<string, unknown>>(referenceQueries.authAgentConnectAttemptsGetById, [id]);
    return row ? rowToAttempt(row) : undefined;
  };
  const tokenIsActive = async (tokenId: string | undefined): Promise<boolean> => {
    if (!tokenId) {
      return false;
    }
    if (isPostgresStorageBackend()) {
      const result = await postgresQuery<{ ok: boolean }>(
        `SELECT EXISTS(
           SELECT 1
             FROM tokens
            WHERE token_id = $1
              AND revoked = FALSE
              AND (expires_at IS NULL OR expires_at > $2)
         ) AS ok`,
        [tokenId, new Date().toISOString()]
      );
      return Boolean(result.rows[0]?.ok);
    }
    const row = getOne<{ ok: number }>(referenceQueries.authAgentConnectAttemptsTokenActive, [
      tokenId,
      new Date().toISOString(),
    ]);
    return Boolean(row?.ok);
  };
  const revokeTokenIfNoLiveSibling = async (
    tokenId: string | undefined,
    requestUri: string,
    excludingId: string,
    now: number
  ): Promise<void> => {
    if (!tokenId) {
      return;
    }
    if (isPostgresStorageBackend()) {
      await postgresQuery(
        `UPDATE tokens
            SET revoked = TRUE
          WHERE token_id = $1
            AND revoked = FALSE
            AND NOT EXISTS (
              SELECT 1
                FROM agent_connect_attempts
               WHERE request_uri = $2
                 AND id != $3
                 AND status IN ('pending', 'approved')
                 AND expires_at_ms > $4
            )`,
        [tokenId, requestUri, excludingId, now]
      );
      return;
    }
    exec(referenceQueries.authAgentConnectAttemptsRevokeTokenIfNoLiveSibling, [tokenId, requestUri, excludingId, now]);
  };
  const deleteAttempt = async (id: string): Promise<void> => {
    if (isPostgresStorageBackend()) {
      await postgresQuery("DELETE FROM agent_connect_attempts WHERE id = $1", [id]);
      return;
    }
    exec(referenceQueries.authAgentConnectAttemptsDeleteById, [id]);
  };
  const markAttemptApproved = async (
    requestUri: string,
    token: string,
    grant: Record<string, unknown>,
    grantId: string | null
  ): Promise<void> => {
    if (completeBeforeMarkForTest) {
      await completeBeforeMarkForTest();
    }
    const completedAt = new Date().toISOString();
    const storedGrantId = (grant.grant_id as string | null | undefined) ?? grantId;
    if (isPostgresStorageBackend()) {
      const result = await postgresQuery(
        `UPDATE agent_connect_attempts
            SET status = 'approved', completed_at = $2, token = $3, grant_json = $4::jsonb, grant_id = $5
          WHERE request_uri = $1 AND status = 'pending'`,
        [requestUri, completedAt, token, JSON.stringify(grant), storedGrantId]
      );
      if (result.rowCount === 0) {
        const expired = await postgresQuery<{ id: string }>(
          "SELECT id FROM agent_connect_attempts WHERE request_uri = $1 AND status = 'expired' LIMIT 1",
          [requestUri]
        );
        const expiredId = expired.rows[0]?.id;
        if (expiredId) {
          await revokeTokenIfNoLiveSibling(token, requestUri, expiredId, Date.now());
        }
      }
      return;
    }
    const result = exec(referenceQueries.authAgentConnectAttemptsMarkApproved, [
      completedAt,
      token,
      JSON.stringify(grant),
      storedGrantId,
      requestUri,
    ]);
    if (result.changes === 0) {
      const expired = getOne<{ id: string }>(referenceQueries.authAgentConnectAttemptsGetExpiredByRequestUri, [
        requestUri,
      ]);
      if (expired) {
        await revokeTokenIfNoLiveSibling(token, requestUri, expired.id, Date.now());
      }
    }
  };
  const getRecoveredApprovedConsent = async (requestUri: string): Promise<RecoveredApprovedConsent | undefined> => {
    const deviceCode = parsePendingConsentRequestUri(requestUri);
    if (!deviceCode) {
      return;
    }
    if (isPostgresStorageBackend()) {
      const result = await postgresQuery(
        `SELECT pc.grant_id, pc.token_id, g.grant_json, gp.package_json
           FROM pending_consents pc
           LEFT JOIN grants g ON g.grant_id = pc.grant_id
           LEFT JOIN grant_packages gp ON gp.package_id = pc.grant_id
          WHERE pc.device_code = $1
            AND pc.status = 'approved'
            AND pc.token_id IS NOT NULL
            AND pc.grant_id IS NOT NULL
          LIMIT 1`,
        [deviceCode]
      );
      const [recovered] = result.rows as RecoveredApprovedConsent[];
      return recovered;
    }
    return (
      getOne<RecoveredApprovedConsent>(referenceQueries.authAgentConnectAttemptsRecoverApproved, [deviceCode]) ??
      undefined
    );
  };
  const getPendingConsentStatus = async (requestUri: string): Promise<string | null> => {
    const deviceCode = parsePendingConsentRequestUri(requestUri);
    if (!deviceCode) {
      return null;
    }
    if (isPostgresStorageBackend()) {
      const result = await postgresQuery<{ status?: string | null }>(
        "SELECT status FROM pending_consents WHERE device_code = $1",
        [deviceCode]
      );
      return result.rows[0]?.status ?? null;
    }
    return (
      getOne<{ status?: string | null }>(referenceQueries.authPendingConsentsGetByDeviceCode, [deviceCode])?.status ??
      null
    );
  };
  const markAttemptDenied = async (requestUri: string): Promise<void> => {
    const completedAt = new Date().toISOString();
    if (isPostgresStorageBackend()) {
      await postgresQuery(
        `UPDATE agent_connect_attempts
            SET status = 'denied', completed_at = $2
          WHERE request_uri = $1 AND status = 'pending'`,
        [requestUri, completedAt]
      );
      return;
    }
    exec(referenceQueries.authAgentConnectAttemptsMarkFailed, ["denied", completedAt, requestUri]);
  };
  const recoverApprovedAttempt = async (attempt: AgentConnectAttempt, now: number): Promise<AgentConnectAttempt> => {
    if (attempt.status !== "pending" || attempt.expiresAt <= now) {
      return attempt;
    }
    const recovered = await getRecoveredApprovedConsent(attempt.requestUri);
    if (!recovered?.token_id) {
      return attempt;
    }
    const grant = grantFromRecoveredConsent(recovered);
    if (!(grant && (await tokenIsActive(recovered.token_id)))) {
      return attempt;
    }
    await markAttemptApproved(attempt.requestUri, recovered.token_id, grant, recovered.grant_id ?? null);
    return (await getRow(attempt.id)) ?? attempt;
  };
  const reconcilePendingConsent = async (attempt: AgentConnectAttempt, now: number): Promise<AgentConnectAttempt> => {
    if (attempt.status !== "pending") {
      return attempt;
    }
    const consentStatus = await getPendingConsentStatus(attempt.requestUri);
    if (consentStatus === "approved") {
      return recoverApprovedAttempt(attempt, now);
    }
    if (consentStatus === "denied") {
      await markAttemptDenied(attempt.requestUri);
    } else if (consentStatus === "expired") {
      await markAttemptExpired(attempt.id);
    }
    return (await getRow(attempt.id)) ?? attempt;
  };
  const markAttemptExpired = async (id: string): Promise<boolean> => {
    const completedAt = new Date().toISOString();
    if (isPostgresStorageBackend()) {
      const result = await postgresQuery(
        `UPDATE agent_connect_attempts
            SET status = 'expired', completed_at = $2
          WHERE id = $1
            AND status IN ('pending', 'expired')`,
        [id, completedAt]
      );
      return (result.rowCount ?? 0) > 0;
    }
    const result = exec(referenceQueries.authAgentConnectAttemptsMarkExpiredById, [completedAt, id]);
    return result.changes > 0;
  };
  const cleanupExpiredAttempt = async (attempt: AgentConnectAttempt, now: number): Promise<void> => {
    const { requestUri, status } = attempt;
    if (!(attempt.token || status === "pending" || status === "expired")) {
      return;
    }
    let recovered = await getRecoveredApprovedConsent(requestUri);
    if (!(attempt.token || recovered?.token_id)) {
      if (cleanupAfterMissForTest) {
        await cleanupAfterMissForTest();
      }
      recovered = await getRecoveredApprovedConsent(requestUri);
    }
    if (cleanupBeforeExpireForTest) {
      await cleanupBeforeExpireForTest();
    }
    await markAttemptExpired(attempt.id);
    const latest = await getRow(attempt.id);
    const token =
      latest?.token ||
      attempt.token ||
      recovered?.token_id ||
      (await getRecoveredApprovedConsent(requestUri))?.token_id ||
      undefined;
    await revokeTokenIfNoLiveSibling(token, requestUri, attempt.id, now);
  };
  const deleteExpiredTombstoneIfConsentTerminal = (
    attempt: AgentConnectAttempt,
    now: number
  ): Promise<boolean> | boolean => {
    const deviceCode = parsePendingConsentRequestUri(attempt.requestUri);
    if (!deviceCode) {
      if (isPostgresStorageBackend()) {
        return postgresQuery("DELETE FROM agent_connect_attempts WHERE id = $1 AND status = 'expired'", [
          attempt.id,
        ]).then((deletedRow) => (deletedRow.rowCount ?? 0) > 0);
      }
      return exec(referenceQueries.authAgentConnectAttemptsDeleteExpiredById, [attempt.id]).changes > 0;
    }
    const nowIso = new Date(now).toISOString();
    if (isPostgresStorageBackend()) {
      return withPostgresTransaction(async (client) => {
        await client.query(
          `UPDATE pending_consents
              SET status = 'expired'
            WHERE device_code = $1
              AND status = 'pending'
              AND expires_at <= $2`,
          [deviceCode, nowIso]
        );
        const result = await client.query(
          `DELETE FROM agent_connect_attempts
            WHERE id = $1
              AND status = 'expired'
              AND NOT EXISTS (
                SELECT 1
                  FROM pending_consents
                 WHERE device_code = $2
                   AND status IN ('pending', 'approving', 'approved')
              )`,
          [attempt.id, deviceCode]
        );
        return (result.rowCount ?? 0) > 0;
      });
    }
    exec(referenceQueries.authPendingConsentsMarkExpiredIfDue, [deviceCode, nowIso]);
    const result = exec(referenceQueries.authAgentConnectAttemptsDeleteExpiredIfConsentTerminal, [
      attempt.id,
      deviceCode,
    ]);
    return result.changes > 0;
  };
  const cleanupExpiredPendingAttempts = async (now: number): Promise<void> => {
    for (;;) {
      let attempts: AgentConnectAttempt[];
      if (isPostgresStorageBackend()) {
        // biome-ignore lint/performance/noAwaitInLoops: each batch observes the prior batch's CAS tombstones.
        const result = await postgresQuery(
          `SELECT *
             FROM agent_connect_attempts
            WHERE status = 'pending'
              AND expires_at_ms <= $1
            ORDER BY id
            LIMIT 1000`,
          [now]
        );
        attempts = result.rows.map((row) => rowToAttempt(row as Record<string, unknown>));
      } else {
        const page = getMany<Record<string, unknown>>(
          referenceQueries.authAgentConnectAttemptsListExpiredPending,
          [now],
          { limit: 1000 }
        );
        attempts = page.rows.map(rowToAttempt);
      }
      if (attempts.length === 0) {
        return;
      }
      for (const attempt of attempts) {
        // biome-ignore lint/performance/noAwaitInLoops: cleanup is intentionally ordered so each CAS/revoke completes before the next batch row is observed.
        await cleanupExpiredAttempt(attempt, now);
      }
    }
  };
  const pruneExpiredHistoricTombstones = async (now: number): Promise<void> => {
    for (;;) {
      let deleted: number;
      if (isPostgresStorageBackend()) {
        // biome-ignore lint/performance/noAwaitInLoops: each bounded delete must finish before observing whether another page remains.
        const result = await postgresQuery(
          `WITH historic AS (
             SELECT id
             FROM agent_connect_attempts
             WHERE status = 'expired'
               AND expires_at_ms <= $1
               AND request_uri NOT LIKE 'urn:pdpp:pending-consent:%'
               AND token IS NULL
             ORDER BY id
             LIMIT 1000
           )
           DELETE FROM agent_connect_attempts AS attempts
           USING historic
           WHERE attempts.id = historic.id`,
          [now]
        );
        deleted = result.rowCount ?? 0;
      } else {
        deleted = exec(referenceQueries.authAgentConnectAttemptsDeleteExpiredHistoricPage, [now, 1000]).changes;
      }
      if (deleted < 1000) {
        return;
      }
    }
  };
  const pruneExpiredTombstones = async (now: number): Promise<void> => {
    for (;;) {
      let attempts: AgentConnectAttempt[];
      if (isPostgresStorageBackend()) {
        // biome-ignore lint/performance/noAwaitInLoops: each page observes prior safe deletes.
        const result = await postgresQuery(
          `SELECT attempts.*
             FROM agent_connect_attempts AS attempts
             LEFT JOIN pending_consents AS consent
               ON attempts.request_uri = 'urn:pdpp:pending-consent:' || consent.device_code
            WHERE attempts.status = 'expired'
              AND attempts.expires_at_ms <= $1
              AND (
                consent.device_code IS NULL
                OR consent.status IN ('denied', 'expired')
                OR (consent.status = 'pending' AND consent.expires_at <= $2)
              )
            ORDER BY attempts.id
            LIMIT 1000`,
          [now, new Date(now).toISOString()]
        );
        attempts = result.rows.map((row) => rowToAttempt(row as Record<string, unknown>));
      } else {
        const page = getMany<Record<string, unknown>>(
          referenceQueries.authAgentConnectAttemptsListExpiredTombstones,
          [now, new Date(now).toISOString()],
          { limit: 1000 }
        );
        attempts = page.rows.map(rowToAttempt);
      }
      if (attempts.length === 0) {
        return;
      }
      let deleted = 0;
      for (const attempt of attempts) {
        // The candidate query and delete accept the same canonical and historic
        // request-URI shapes, so each full page must make durable progress.
        // biome-ignore lint/performance/noAwaitInLoops: each durable delete must complete before the next page is inspected.
        const tombstoneDeleted = await deleteExpiredTombstoneIfConsentTerminal(attempt, now);
        if (tombstoneDeleted) {
          await cleanupExpiredAttempt(attempt, now);
          deleted += 1;
        }
      }
      if (deleted === 0 || attempts.length < 1000) {
        return;
      }
    }
  };

  return {
    async complete(requestUri, outcome): Promise<void> {
      if (!requestUri) {
        return;
      }
      completeFailureForTest?.();
      const completedAt = new Date().toISOString();
      if (isPostgresStorageBackend()) {
        if (outcome.status === "approved") {
          await markAttemptApproved(requestUri, outcome.token, outcome.grant, outcome.grantId ?? null);
          return;
        }
        await postgresQuery(
          `UPDATE agent_connect_attempts
              SET status = $2, completed_at = $3
            WHERE request_uri = $1 AND status = 'pending'`,
          [requestUri, outcome.status, completedAt]
        );
        return;
      }
      if (outcome.status === "approved") {
        await markAttemptApproved(requestUri, outcome.token, outcome.grant, outcome.grantId ?? null);
        return;
      }
      exec(referenceQueries.authAgentConnectAttemptsMarkFailed, [outcome.status, completedAt, requestUri]);
    },
    async create(opts): Promise<AgentConnectAttempt | undefined> {
      const createdAt = new Date().toISOString();
      const pollingCodeHash = hashPollingCode(opts.pollingCode);
      const attempt: AgentConnectAttempt = {
        approvalUrl: opts.approvalUrl,
        clientId: opts.clientId,
        createdAt,
        expiresAt: opts.expiresAt,
        id: opts.id,
        interval: 2,
        pollingCode: opts.pollingCode,
        pollingCodeHash,
        requestUri: opts.requestUri,
        status: "pending",
        tokenUrl: opts.tokenUrl,
      };
      const deviceCode = parsePendingConsentRequestUri(opts.requestUri);
      if (!deviceCode) {
        return;
      }
      if (createBeforePersistForTest) {
        await createBeforePersistForTest();
      }
      if (isPostgresStorageBackend()) {
        return withPostgresTransaction(async (client) => {
          const pending = await client.query(
            `SELECT 1
               FROM pending_consents
              WHERE device_code = $1
                AND status = 'pending'
                AND expires_at > $2
              FOR UPDATE`,
            [deviceCode, new Date(opts.now).toISOString()]
          );
          if (pending.rowCount !== 1) {
            return;
          }
          await client.query(
            `INSERT INTO agent_connect_attempts(
             id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
             interval_seconds, created_at, expires_at_ms
           ) VALUES($1, $2, $3, $4, 'pending', $5, $6, 2, $7, $8)`,
            [
              opts.id,
              opts.requestUri,
              opts.clientId,
              pollingCodeHash,
              opts.approvalUrl,
              opts.tokenUrl,
              createdAt,
              opts.expiresAt,
            ]
          );
          return attempt;
        });
      }
      const result = exec(referenceQueries.authAgentConnectAttemptsInsertIfConsentPending, [
        opts.id,
        opts.requestUri,
        opts.clientId,
        pollingCodeHash,
        opts.approvalUrl,
        opts.tokenUrl,
        createdAt,
        opts.expiresAt,
        deviceCode,
        new Date(opts.now).toISOString(),
      ]);
      if (result.changes !== 1) {
        return;
      }
      return attempt;
    },

    async delete(id): Promise<void> {
      await deleteAttempt(id);
    },

    async fail(requestUri, status): Promise<void> {
      await this.complete(requestUri, { status });
    },

    get(id): Promise<AgentConnectAttempt | undefined> {
      return getRow(id);
    },

    async prune(now = Date.now()): Promise<void> {
      await cleanupExpiredPendingAttempts(now);
      await pruneExpiredHistoricTombstones(now);
      await pruneExpiredTombstones(now);
      if (isPostgresStorageBackend()) {
        await postgresQuery(
          `DELETE FROM agent_connect_attempts
            WHERE status = 'denied'
               OR (status = 'approved' AND response_json IS NOT NULL AND expires_at_ms <= $1)`,
          [now]
        );
        return;
      }
      exec(referenceQueries.authAgentConnectAttemptsPrune, [now]);
    },

    async redeem(id, pollingCode, now = Date.now()) {
      let attempt = await getRow(id);
      if (!(attempt?.pollingCodeHash && pollingCodeMatches(attempt.pollingCodeHash, pollingCode))) {
        return { outcome: "missing" };
      }
      attempt = await reconcilePendingConsent(attempt, now);
      if (attempt.expiresAt <= now) {
        await cleanupExpiredAttempt(attempt, now);
        return { outcome: "failed", status: "expired" };
      }
      if (attempt.status === "pending") {
        return { interval: attempt.interval, outcome: "pending" };
      }
      if (attempt.status !== "approved") {
        await this.delete(attempt.id);
        return { outcome: "failed", status: attempt.status };
      }
      if (!(await tokenIsActive(attempt.token))) {
        await this.delete(attempt.id);
        return { outcome: "missing" };
      }
      if (attempt.responseJson) {
        return { body: JSON.parse(attempt.responseJson) as Record<string, unknown>, outcome: "approved", replay: true };
      }
      const body = {
        access_token: attempt.token,
        grant: attempt.grant,
        grant_id: attempt.grantId,
        token_type: "Bearer",
      };
      const responseJson = JSON.stringify(body);
      if (isPostgresStorageBackend()) {
        return withPostgresTransaction(async (client) => {
          const update = await client.query(
            `UPDATE agent_connect_attempts
                SET response_json = $2
              WHERE id = $1 AND status = 'approved' AND response_json IS NULL
              RETURNING response_json`,
            [id, responseJson]
          );
          if (update.rowCount === 1) {
            return { body, outcome: "approved", replay: false };
          }
          const reread = await client.query("SELECT response_json FROM agent_connect_attempts WHERE id = $1", [id]);
          const [row] = reread.rows;
          if (typeof row?.response_json === "string") {
            return {
              body: JSON.parse(row.response_json) as Record<string, unknown>,
              outcome: "approved",
              replay: true,
            };
          }
          return { outcome: "missing" };
        });
      }
      const result = exec(referenceQueries.authAgentConnectAttemptsSetResponseJson, [responseJson, id]);
      if (result.changes === 1) {
        return { body, outcome: "approved", replay: false };
      }
      const replay = await getRow(id);
      if (replay?.responseJson) {
        return { body: JSON.parse(replay.responseJson) as Record<string, unknown>, outcome: "approved", replay: true };
      }
      return { outcome: "missing" };
    },
  };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function buildAgentConnectError(status: string): { error: string; error_description: string } {
  if (status === "denied") {
    return { error: "access_denied", error_description: "Owner denied the scoped access request" };
  }
  if (status === "expired") {
    return { error: "expired_token", error_description: "The agent-connect request expired before approval" };
  }
  return { error: "authorization_pending", error_description: "Owner approval is still pending" };
}

function publicAttemptEnvelope(attempt: AgentConnectAttempt, now: number): Record<string, unknown> {
  return {
    approval_url: attempt.approvalUrl,
    expires_in: Math.max(Math.ceil((attempt.expiresAt - now) / 1000), 0),
    id: attempt.id,
    interval: attempt.interval,
    object: "agent_connect_attempt",
    poll_url: attempt.tokenUrl,
    status: attempt.status,
    token_url: attempt.tokenUrl,
  };
}

// ─── Route types ─────────────────────────────────────────────────────────────

interface RouteRequest {
  readonly body?: Record<string, unknown>;
  readonly params: Readonly<Record<string, string>>;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

// ─── POST /agent-connect ─────────────────────────────────────────────────────

interface PendingGrantResult {
  /** The client_id from the pending grant request, or null if not present. */
  readonly pendingClientId: string | null;
}

interface InitiateNativeGrantResult {
  readonly request_uri: string;
}

export interface MountAsAgentConnectContext {
  agentConnectAttemptStore: AgentConnectAttemptStore;
  /** How long (ms) a pending attempt lives before it expires. */
  agentConnectTtlMs: number;
  /** Build the owner approval URL for a given request_uri and base URL. */
  buildApprovalUrl: (baseUrl: string, requestUri: string) => string;
  /** Build the token poll URL for a given attempt id and base URL. */
  buildTokenUrl: (baseUrl: string, attemptId: string) => string;
  /** Generate a unique attempt id (e.g. `agc_<hex>`). */
  generateAttemptId: () => string;
  /** Generate an opaque polling code (e.g. `agc_poll_<hex>`). */
  generatePollingCode: () => string;
  /**
   * Looks up the pending consent request for a given request_uri.
   * Returns `{ pendingClientId }` where `pendingClientId` is null if the
   * request is unknown/expired or if no client_id is on the pending record.
   * Returns null if the pending request is not found.
   */
  getPendingGrantFromRequestUri: (
    requestUri: string,
    opts?: { baseUrl?: string | null }
  ) => Promise<PendingGrantResult | null>;
  handleError: (res: unknown, err: unknown) => void;
  /**
   * Initiates a grant for the native-manifest shortcut path (no explicit
   * request_uri). Returns `{ request_uri }`, or null if the server is not
   * in native mode (i.e. no nativeManifest configured).
   */
  initiateNativeGrant: (opts: {
    baseUrl: string;
    clientId: string;
    clientName: string;
  }) => Promise<InitiateNativeGrantResult | null>;
  /** Returns the current wall-clock time in ms (for `expiresAt` calculation). */
  now: () => number;
  /** Default client_id for the PDPP CLI. */
  pdppCliDefaultClientId: string;
  pdppError: PdppErrorFn;
  /** Resolve the public base URL for the AS from the inbound request. */
  resolveBaseUrl: (req: RouteRequest) => string;
}

async function resolveRequestUri(
  req: RouteRequest,
  baseUrl: string,
  clientId: string | null,
  ctx: MountAsAgentConnectContext
): Promise<{ requestUri: string; clientId: string | null } | null> {
  const bodyRequestUri = typeof req.body?.request_uri === "string" ? req.body.request_uri : null;
  if (bodyRequestUri) {
    return { clientId, requestUri: bodyRequestUri };
  }
  const clientName =
    typeof req.body?.client_name === "string" && req.body.client_name.trim() ? req.body.client_name.trim() : "PDPP CLI";
  const effectiveClientId = clientId ?? ctx.pdppCliDefaultClientId;
  const staged = await ctx.initiateNativeGrant({ baseUrl, clientId: effectiveClientId, clientName });
  if (!staged) {
    return null;
  }
  return { clientId: effectiveClientId, requestUri: staged.request_uri };
}

export function mountAsAgentConnect(app: AppLike, ctx: MountAsAgentConnectContext): void {
  // Narrow hosted completion handoff for CLI `connect`: the CLI first stages a
  // normal PAR request, then registers that request_uri here to receive a
  // polling handle. Owner approval still happens through the existing consent
  // page, but the bearer is returned only to the caller holding the polling
  // code, never rendered into the owner browser.
  const handler: RouteHandler = async (req, res) => {
    try {
      const baseUrl = ctx.resolveBaseUrl(req);
      const bodyClientId =
        typeof req.body?.client_id === "string" && req.body.client_id.trim() ? req.body.client_id : null;

      const resolved = await resolveRequestUri(req, baseUrl, bodyClientId, ctx);
      if (!resolved) {
        return ctx.pdppError(
          res,
          400,
          "invalid_request",
          "request_uri is required unless the reference provider is running with a native manifest"
        );
      }
      const { requestUri, clientId } = resolved;

      const pendingResult = await ctx.getPendingGrantFromRequestUri(requestUri, { baseUrl });
      if (!pendingResult) {
        return ctx.pdppError(res, 400, "expired_token", "Pending grant request is unknown or expired");
      }
      const { pendingClientId } = pendingResult;

      if (clientId && pendingClientId !== clientId) {
        return ctx.pdppError(res, 403, "invalid_client", "client_id does not match pending request");
      }

      const now = ctx.now();
      await ctx.agentConnectAttemptStore.prune(now);
      const id = ctx.generateAttemptId();
      const pollingCode = ctx.generatePollingCode();

      const attempt = await ctx.agentConnectAttemptStore.create({
        approvalUrl: ctx.buildApprovalUrl(baseUrl, requestUri),
        clientId: pendingClientId ?? clientId,
        expiresAt: now + ctx.agentConnectTtlMs,
        id,
        now,
        pollingCode,
        requestUri,
        tokenUrl: ctx.buildTokenUrl(baseUrl, id),
      });
      if (!attempt) {
        return ctx.pdppError(res, 400, "expired_token", "Pending grant request is unknown or expired");
      }

      applyCredentialResponseNoStoreHeaders(res);
      return res.status(201).json({
        ...publicAttemptEnvelope(attempt, now),
        polling_code: pollingCode,
      });
    } catch (err) {
      return ctx.handleError(res, err);
    }
  };
  app.post("/agent-connect", handler);
}

// ─── POST /agent-connect/:attemptId/token ────────────────────────────────────

export interface MountAsAgentConnectTokenContext {
  agentConnectAttemptStore: AgentConnectAttemptStore;
  handleError: (res: unknown, err: unknown) => void;
  pdppError: PdppErrorFn;
}

export function mountAsAgentConnectToken(app: AppLike, ctx: MountAsAgentConnectTokenContext): void {
  const handler: RouteHandler = async (req, res) => {
    try {
      const attemptId = req.params.attemptId ?? "";
      const pollingCode = typeof req.body?.polling_code === "string" ? req.body.polling_code : null;
      if (!pollingCode) {
        return ctx.pdppError(res, 401, "invalid_grant", "Unknown agent-connect polling handle");
      }
      const result = await ctx.agentConnectAttemptStore.redeem(attemptId, pollingCode);
      if (result.outcome === "missing") {
        return ctx.pdppError(res, 401, "invalid_grant", "Unknown agent-connect polling handle");
      }
      if (result.outcome === "pending") {
        return res.status(202).json({
          error: "authorization_pending",
          error_description: "Owner approval is still pending",
          interval: result.interval,
          status: "pending",
        });
      }
      if (result.outcome === "failed") {
        const error = buildAgentConnectError(result.status);
        return ctx.pdppError(res, result.status === "denied" ? 403 : 400, error.error, error.error_description);
      }
      applyCredentialResponseNoStoreHeaders(res);
      return res.json(result.body);
    } catch (err) {
      return ctx.handleError(res, err);
    }
  };
  app.post("/agent-connect/:attemptId/token", handler);
}
