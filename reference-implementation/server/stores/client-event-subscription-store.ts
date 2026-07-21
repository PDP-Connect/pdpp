// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Backend-aware `ClientEventSubscriptionStore` plus queue/attempt helpers.
 *
 * Two parallel implementations sit behind a single resolver:
 *
 *   - SQLite: uses the registered `referenceQueries.clientEventSubscriptions*`
 *     artifacts via the bounded-statement wrapper in `lib/db.ts`. Methods
 *     return resolved Promises so callers can `await` uniformly.
 *   - Postgres: uses the matching DDL bootstrapped in `postgres-storage.js`
 *     and issues parameterized SQL via `postgresQuery`.
 *
 * `getDefaultClientEventSubscriptionStore()` picks the backend by reading
 * `isPostgresStorageBackend()`. Worker-facing helpers (`claimDueQueue`,
 * `updateQueueAttempt`, `insertAttempt`, `listAttemptsForQueue`,
 * `listActiveSubscriptions`) are also backend-aware.
 *
 * Spec: openspec/changes/add-client-event-subscriptions/specs/
 *       reference-implementation-architecture/spec.md
 */

import { allowUnboundedReadAcknowledged, exec, getOne, referenceQueries } from "../../lib/db.ts";
import type {
  ClientEventSubscriptionStore,
  QueuedEventForEnqueue,
  SubscriptionAuthorityKind,
  SubscriptionRow,
  SubscriptionStatus,
} from "../../operations/as-client-event-subscriptions/index.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.js";

export interface QueueRow {
  readonly attempt_count: number;
  readonly callback_url: string;
  readonly enqueued_at: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly next_attempt_at: string;
  readonly payload_json: string;
  readonly queue_id: number;
  readonly secret_text: string;
  readonly status: string;
  readonly subscription_id: string;
  readonly subscription_status: SubscriptionStatus;
  readonly verification_challenge: string | null;
}

export interface AttemptRow {
  readonly attempt_id: number;
  readonly attempted_at: string;
  readonly error: string | null;
  readonly latency_ms: number | null;
  readonly ok: number;
  readonly queue_id: number;
  readonly response_snippet: string | null;
  readonly status_code: number | null;
}

// ---------------------------------------------------------------------------
// SQLite-backed store
// ---------------------------------------------------------------------------

export function createSqliteClientEventSubscriptionStore(): ClientEventSubscriptionStore {
  // The `ClientEventSubscriptionStore` interface declares each method as
  // `Promise<X> | X` so SQLite can stay synchronous while Postgres awaits the
  // driver. Methods below return synchronously; the operation layer awaits
  // everything uniformly.
  return {
    insertSubscription(row: SubscriptionRow): void {
      exec(referenceQueries.clientEventSubscriptionsInsertSubscription, [
        row.subscription_id,
        row.authority_kind,
        row.grant_id,
        row.client_id,
        row.subject_id,
        row.callback_url,
        row.secret_hash,
        row.secret_text,
        row.scope_json,
        row.status,
        row.verification_challenge,
        row.created_at,
        row.updated_at,
      ]);
    },
    getSubscriptionById(id: string): SubscriptionRow | null {
      return getOne<SubscriptionRow>(referenceQueries.clientEventSubscriptionsGetSubscriptionById, [id]);
    },
    listSubscriptionsByClient(clientId: string): SubscriptionRow[] {
      return [
        ...allowUnboundedReadAcknowledged<SubscriptionRow>(
          referenceQueries.clientEventSubscriptionsListSubscriptionsByClient,
          [clientId]
        ),
      ];
    },
    listSubscriptionsByGrant(grantId: string): SubscriptionRow[] {
      return [
        ...allowUnboundedReadAcknowledged<SubscriptionRow>(
          referenceQueries.clientEventSubscriptionsListSubscriptionsByGrant,
          [grantId]
        ),
      ];
    },
    updateStatus(id, status, updatedAt, disabledAt, disabledReason): void {
      exec(referenceQueries.clientEventSubscriptionsUpdateStatus, [status, updatedAt, disabledAt, disabledReason, id]);
    },
    updateSecret(id, secretHash, secretText, updatedAt): void {
      exec(referenceQueries.clientEventSubscriptionsUpdateSecret, [secretHash, secretText, updatedAt, id]);
    },
    deleteSubscription(id): void {
      exec(referenceQueries.clientEventSubscriptionsDeleteSubscription, [id]);
    },
    enqueueEvent(event: QueuedEventForEnqueue): void {
      exec(referenceQueries.clientEventSubscriptionsInsertQueue, [
        event.subscriptionId,
        event.eventId,
        event.eventType,
        event.payloadJson,
        event.enqueuedAt,
        event.nextAttemptAt,
      ]);
    },
    dropQueuedForSubscription(id): void {
      exec(referenceQueries.clientEventSubscriptionsDropQueuedForSubscription, [id]);
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres-backed store
// ---------------------------------------------------------------------------

function pgScopeJsonToText(value: unknown): string {
  // Postgres returns JSONB columns as already-parsed JS objects. Round-trip to
  // text so SubscriptionRow.scope_json remains a string for the operation
  // layer, which parses it on read.
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function pgPayloadJsonToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function pgSubscriptionRow(raw: Record<string, unknown>): SubscriptionRow {
  return {
    subscription_id: String(raw.subscription_id),
    authority_kind: (raw.authority_kind ?? "client_grant") as SubscriptionAuthorityKind,
    grant_id: raw.grant_id === null || raw.grant_id === undefined ? null : String(raw.grant_id),
    client_id: String(raw.client_id),
    subject_id: String(raw.subject_id),
    callback_url: String(raw.callback_url),
    secret_hash: String(raw.secret_hash),
    secret_text: String(raw.secret_text),
    scope_json: pgScopeJsonToText(raw.scope_json),
    status: raw.status as SubscriptionStatus,
    verification_challenge:
      raw.verification_challenge === null || raw.verification_challenge === undefined
        ? null
        : String(raw.verification_challenge),
    created_at: String(raw.created_at),
    updated_at: String(raw.updated_at),
    disabled_at: raw.disabled_at === null || raw.disabled_at === undefined ? null : String(raw.disabled_at),
    disabled_reason:
      raw.disabled_reason === null || raw.disabled_reason === undefined ? null : String(raw.disabled_reason),
  };
}

export function createPostgresClientEventSubscriptionStore(): ClientEventSubscriptionStore {
  return {
    async insertSubscription(row: SubscriptionRow): Promise<void> {
      await postgresQuery(
        `INSERT INTO client_event_subscriptions(
           subscription_id, authority_kind, grant_id, client_id, subject_id, callback_url,
           secret_hash, secret_text, scope_json, status, verification_challenge,
           created_at, updated_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)`,
        [
          row.subscription_id,
          row.authority_kind,
          row.grant_id,
          row.client_id,
          row.subject_id,
          row.callback_url,
          row.secret_hash,
          row.secret_text,
          row.scope_json,
          row.status,
          row.verification_challenge,
          row.created_at,
          row.updated_at,
        ]
      );
    },
    async getSubscriptionById(id: string): Promise<SubscriptionRow | null> {
      const result = await postgresQuery(
        `SELECT subscription_id, authority_kind, grant_id, client_id, subject_id, callback_url,
                secret_hash, secret_text, scope_json, status, verification_challenge,
                created_at, updated_at, disabled_at, disabled_reason
           FROM client_event_subscriptions
          WHERE subscription_id = $1`,
        [id]
      );
      if (result.rowCount === 0) {
        return null;
      }
      return pgSubscriptionRow(result.rows[0]);
    },
    async listSubscriptionsByClient(clientId: string): Promise<SubscriptionRow[]> {
      const result = await postgresQuery(
        `SELECT subscription_id, authority_kind, grant_id, client_id, subject_id, callback_url,
                secret_hash, secret_text, scope_json, status, verification_challenge,
                created_at, updated_at, disabled_at, disabled_reason
           FROM client_event_subscriptions
          WHERE client_id = $1
          ORDER BY created_at, subscription_id`,
        [clientId]
      );
      return result.rows.map(pgSubscriptionRow);
    },
    async listSubscriptionsByGrant(grantId: string): Promise<SubscriptionRow[]> {
      const result = await postgresQuery(
        `SELECT subscription_id, authority_kind, grant_id, client_id, subject_id, callback_url,
                secret_hash, secret_text, scope_json, status, verification_challenge,
                created_at, updated_at, disabled_at, disabled_reason
           FROM client_event_subscriptions
          WHERE grant_id = $1
          ORDER BY created_at, subscription_id`,
        [grantId]
      );
      return result.rows.map(pgSubscriptionRow);
    },
    async updateStatus(id, status, updatedAt, disabledAt, disabledReason): Promise<void> {
      await postgresQuery(
        `UPDATE client_event_subscriptions
            SET status = $1,
                updated_at = $2,
                disabled_at = $3,
                disabled_reason = $4
          WHERE subscription_id = $5`,
        [status, updatedAt, disabledAt, disabledReason, id]
      );
    },
    async updateSecret(id, secretHash, secretText, updatedAt): Promise<void> {
      await postgresQuery(
        `UPDATE client_event_subscriptions
            SET secret_hash = $1,
                secret_text = $2,
                updated_at = $3
          WHERE subscription_id = $4`,
        [secretHash, secretText, updatedAt, id]
      );
    },
    async deleteSubscription(id): Promise<void> {
      await postgresQuery("DELETE FROM client_event_subscriptions WHERE subscription_id = $1", [id]);
    },
    async enqueueEvent(event: QueuedEventForEnqueue): Promise<void> {
      await postgresQuery(
        `INSERT INTO client_event_queue(
           subscription_id, event_id, event_type, payload_json,
           enqueued_at, next_attempt_at, attempt_count, status
         )
         VALUES($1, $2, $3, $4::jsonb, $5, $6, 0, 'pending')`,
        [event.subscriptionId, event.eventId, event.eventType, event.payloadJson, event.enqueuedAt, event.nextAttemptAt]
      );
    },
    async dropQueuedForSubscription(id): Promise<void> {
      await postgresQuery(
        `UPDATE client_event_queue
            SET status = 'dropped'
          WHERE subscription_id = $1
            AND status = 'pending'`,
        [id]
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Resolver — pick a store backend based on PDPP_STORAGE_BACKEND.
// ---------------------------------------------------------------------------

let sqliteStoreSingleton: ClientEventSubscriptionStore | null = null;
let postgresStoreSingleton: ClientEventSubscriptionStore | null = null;

export function getDefaultClientEventSubscriptionStore(): ClientEventSubscriptionStore {
  if (isPostgresStorageBackend()) {
    if (!postgresStoreSingleton) {
      postgresStoreSingleton = createPostgresClientEventSubscriptionStore();
    }
    return postgresStoreSingleton;
  }
  if (!sqliteStoreSingleton) {
    sqliteStoreSingleton = createSqliteClientEventSubscriptionStore();
  }
  return sqliteStoreSingleton;
}

/** Reset the cached singletons. Test-only — used between backend swaps. */
export function __resetClientEventSubscriptionStoreForTests(): void {
  sqliteStoreSingleton = null;
  postgresStoreSingleton = null;
}

// ---------------------------------------------------------------------------
// Worker-facing helpers
// ---------------------------------------------------------------------------

export async function listActiveSubscriptions(): Promise<SubscriptionRow[]> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT subscription_id, authority_kind, grant_id, client_id, subject_id, callback_url,
              secret_hash, secret_text, scope_json, status, verification_challenge,
              created_at, updated_at, disabled_at, disabled_reason
         FROM client_event_subscriptions
        WHERE status = 'active'
        ORDER BY created_at, subscription_id`,
      []
    );
    return result.rows.map(pgSubscriptionRow);
  }
  return [
    ...allowUnboundedReadAcknowledged<SubscriptionRow>(
      referenceQueries.clientEventSubscriptionsListActiveSubscriptions,
      []
    ),
  ];
}

function pgQueueRow(raw: Record<string, unknown>): QueueRow {
  return {
    queue_id: Number(raw.queue_id),
    subscription_id: String(raw.subscription_id),
    event_id: String(raw.event_id),
    event_type: String(raw.event_type),
    payload_json: pgPayloadJsonToText(raw.payload_json),
    enqueued_at: String(raw.enqueued_at),
    next_attempt_at: String(raw.next_attempt_at),
    attempt_count: Number(raw.attempt_count),
    status: String(raw.status),
    callback_url: String(raw.callback_url),
    secret_text: String(raw.secret_text),
    verification_challenge:
      raw.verification_challenge === null || raw.verification_challenge === undefined
        ? null
        : String(raw.verification_challenge),
    subscription_status: raw.subscription_status as SubscriptionStatus,
  };
}

export async function claimDueQueue(beforeIso: string): Promise<QueueRow[]> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT q.queue_id,
              q.subscription_id,
              q.event_id,
              q.event_type,
              q.payload_json,
              q.enqueued_at,
              q.next_attempt_at,
              q.attempt_count,
              q.status,
              s.callback_url,
              s.secret_text,
              s.verification_challenge,
              s.status AS subscription_status
         FROM client_event_queue q
         JOIN client_event_subscriptions s ON s.subscription_id = q.subscription_id
        WHERE q.status = 'pending'
          AND q.next_attempt_at <= $1
        ORDER BY q.next_attempt_at, q.queue_id
        LIMIT 100`,
      [beforeIso]
    );
    return result.rows.map(pgQueueRow);
  }
  return [
    ...allowUnboundedReadAcknowledged<QueueRow>(referenceQueries.clientEventSubscriptionsClaimDueQueue, [beforeIso]),
  ];
}

export async function updateQueueAttempt(
  queueId: number,
  attemptCount: number,
  nextAttemptAt: string,
  status: "pending" | "delivered" | "final_failure" | "dropped",
  lastError: string | null
): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `UPDATE client_event_queue
          SET attempt_count = $1,
              next_attempt_at = $2,
              status = $3,
              last_error = $4
        WHERE queue_id = $5`,
      [attemptCount, nextAttemptAt, status, lastError, queueId]
    );
    return;
  }
  exec(referenceQueries.clientEventSubscriptionsUpdateQueueAttempt, [
    attemptCount,
    nextAttemptAt,
    status,
    lastError,
    queueId,
  ]);
}

export async function insertAttempt(
  queueId: number,
  attemptedAt: string,
  statusCode: number | null,
  ok: boolean,
  latencyMs: number | null,
  error: string | null,
  responseSnippet: string | null
): Promise<void> {
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO client_event_attempts(
         queue_id, attempted_at, status_code, ok, latency_ms, error, response_snippet
       )
       VALUES($1, $2, $3, $4, $5, $6, $7)`,
      [queueId, attemptedAt, statusCode, ok ? 1 : 0, latencyMs, error, responseSnippet]
    );
    return;
  }
  exec(referenceQueries.clientEventSubscriptionsInsertAttempt, [
    queueId,
    attemptedAt,
    statusCode,
    ok ? 1 : 0,
    latencyMs,
    error,
    responseSnippet,
  ]);
}

// ---------------------------------------------------------------------------
// Operator oversight helpers (reference-only)
// ---------------------------------------------------------------------------
//
// Used by the `ref.client-event-subscriptions.*` operations that back the
// `/_ref/event-subscriptions*` routes. Same backend-aware shape as the
// other helpers above; the operator surface does not get its own resolver.
//
// Spec: openspec/changes/add-client-event-subscription-management/specs/
//       reference-implementation-architecture/spec.md

export interface ListAllSubscriptionsFilters {
  readonly clientId?: string | null;
  readonly grantId?: string | null;
  readonly status?: SubscriptionStatus | null;
}

export interface SubscriptionSummaryRow {
  readonly authority_kind: SubscriptionAuthorityKind;
  readonly callback_url: string;
  readonly client_id: string;
  readonly created_at: string;
  readonly disabled_at: string | null;
  readonly disabled_reason: string | null;
  readonly final_failure_count: number;
  readonly grant_id: string | null;
  readonly last_attempt_ok: number | null;
  readonly last_attempt_status_code: number | null;
  readonly last_attempted_at: string | null;
  readonly pending_queue_count: number;
  readonly scope_json: string;
  readonly status: SubscriptionStatus;
  readonly subject_id: string;
  readonly subscription_id: string;
  readonly updated_at: string;
}

export interface SubscriptionAttemptRow {
  readonly attempt_id: number;
  readonly attempted_at: string;
  readonly error: string | null;
  readonly event_id: string;
  readonly event_type: string;
  readonly latency_ms: number | null;
  readonly ok: number;
  readonly queue_id: number;
  readonly response_snippet: string | null;
  readonly status_code: number | null;
}

export async function listAllSubscriptions(filters: ListAllSubscriptionsFilters = {}): Promise<SubscriptionRow[]> {
  const clientId = filters.clientId ?? null;
  const grantId = filters.grantId ?? null;
  const status = filters.status ?? null;
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT subscription_id, authority_kind, grant_id, client_id, subject_id, callback_url,
              secret_hash, secret_text, scope_json, status, verification_challenge,
              created_at, updated_at, disabled_at, disabled_reason
         FROM client_event_subscriptions
        WHERE status != 'deleted'
          AND ($1::text IS NULL OR client_id = $1)
          AND ($2::text IS NULL OR grant_id = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY created_at DESC, subscription_id ASC`,
      [clientId, grantId, status]
    );
    return result.rows.map(pgSubscriptionRow);
  }
  return [
    ...allowUnboundedReadAcknowledged<SubscriptionRow>(referenceQueries.clientEventSubscriptionsListAllSubscriptions, [
      clientId,
      clientId,
      grantId,
      grantId,
      status,
      status,
    ]),
  ];
}

function pgSummaryRow(raw: Record<string, unknown>): SubscriptionSummaryRow {
  return {
    subscription_id: String(raw.subscription_id),
    authority_kind: (raw.authority_kind ?? "client_grant") as SubscriptionAuthorityKind,
    grant_id: raw.grant_id === null || raw.grant_id === undefined ? null : String(raw.grant_id),
    client_id: String(raw.client_id),
    subject_id: String(raw.subject_id),
    callback_url: String(raw.callback_url),
    scope_json: pgScopeJsonToText(raw.scope_json),
    status: raw.status as SubscriptionStatus,
    created_at: String(raw.created_at),
    updated_at: String(raw.updated_at),
    disabled_at: raw.disabled_at === null || raw.disabled_at === undefined ? null : String(raw.disabled_at),
    disabled_reason:
      raw.disabled_reason === null || raw.disabled_reason === undefined ? null : String(raw.disabled_reason),
    pending_queue_count: Number(raw.pending_queue_count ?? 0),
    final_failure_count: Number(raw.final_failure_count ?? 0),
    last_attempted_at:
      raw.last_attempted_at === null || raw.last_attempted_at === undefined ? null : String(raw.last_attempted_at),
    last_attempt_ok:
      raw.last_attempt_ok === null || raw.last_attempt_ok === undefined ? null : Number(raw.last_attempt_ok),
    last_attempt_status_code:
      raw.last_attempt_status_code === null || raw.last_attempt_status_code === undefined
        ? null
        : Number(raw.last_attempt_status_code),
  };
}

export async function getSubscriptionSummary(subscriptionId: string): Promise<SubscriptionSummaryRow | null> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT s.subscription_id,
              s.authority_kind,
              s.grant_id,
              s.client_id,
              s.subject_id,
              s.callback_url,
              s.scope_json,
              s.status,
              s.created_at,
              s.updated_at,
              s.disabled_at,
              s.disabled_reason,
              (SELECT COUNT(*) FROM client_event_queue q
                 WHERE q.subscription_id = s.subscription_id
                   AND q.status = 'pending') AS pending_queue_count,
              (SELECT COUNT(*) FROM client_event_queue q
                 WHERE q.subscription_id = s.subscription_id
                   AND q.status = 'final_failure') AS final_failure_count,
              (SELECT a.attempted_at FROM client_event_attempts a
                 JOIN client_event_queue q ON q.queue_id = a.queue_id
                 WHERE q.subscription_id = s.subscription_id
                 ORDER BY a.attempt_id DESC LIMIT 1) AS last_attempted_at,
              (SELECT a.ok FROM client_event_attempts a
                 JOIN client_event_queue q ON q.queue_id = a.queue_id
                 WHERE q.subscription_id = s.subscription_id
                 ORDER BY a.attempt_id DESC LIMIT 1) AS last_attempt_ok,
              (SELECT a.status_code FROM client_event_attempts a
                 JOIN client_event_queue q ON q.queue_id = a.queue_id
                 WHERE q.subscription_id = s.subscription_id
                 ORDER BY a.attempt_id DESC LIMIT 1) AS last_attempt_status_code
         FROM client_event_subscriptions s
        WHERE s.subscription_id = $1
          AND s.status != 'deleted'`,
      [subscriptionId]
    );
    if (result.rowCount === 0) {
      return null;
    }
    return pgSummaryRow(result.rows[0]);
  }
  return getOne<SubscriptionSummaryRow>(referenceQueries.clientEventSubscriptionsGetSubscriptionSummary, [
    subscriptionId,
  ]);
}

export async function listAttemptsForSubscription(
  subscriptionId: string,
  limit: number
): Promise<SubscriptionAttemptRow[]> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT a.attempt_id,
              a.queue_id,
              q.event_id,
              q.event_type,
              a.attempted_at,
              a.status_code,
              a.ok,
              a.latency_ms,
              a.error,
              a.response_snippet
         FROM client_event_attempts a
         JOIN client_event_queue q ON q.queue_id = a.queue_id
        WHERE q.subscription_id = $1
        ORDER BY a.attempt_id DESC
        LIMIT $2`,
      [subscriptionId, limit]
    );
    return result.rows.map((raw: Record<string, unknown>) => ({
      attempt_id: Number(raw.attempt_id),
      queue_id: Number(raw.queue_id),
      event_id: String(raw.event_id),
      event_type: String(raw.event_type),
      attempted_at: String(raw.attempted_at),
      status_code: raw.status_code == null ? null : Number(raw.status_code),
      ok: Number(raw.ok ?? 0),
      latency_ms: raw.latency_ms == null ? null : Number(raw.latency_ms),
      error: raw.error == null ? null : String(raw.error),
      response_snippet: raw.response_snippet == null ? null : String(raw.response_snippet),
    }));
  }
  return [
    ...allowUnboundedReadAcknowledged<SubscriptionAttemptRow>(
      referenceQueries.clientEventSubscriptionsListAttemptsForSubscription,
      [subscriptionId, limit]
    ),
  ];
}

export async function listAttemptsForQueue(queueId: number): Promise<AttemptRow[]> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT attempt_id, queue_id, attempted_at, status_code, ok, latency_ms, error, response_snippet
         FROM client_event_attempts
        WHERE queue_id = $1
        ORDER BY attempt_id`,
      [queueId]
    );
    return result.rows.map((raw: Record<string, unknown>) => ({
      attempt_id: Number(raw.attempt_id),
      queue_id: Number(raw.queue_id),
      attempted_at: String(raw.attempted_at),
      status_code: raw.status_code == null ? null : Number(raw.status_code),
      ok: Number(raw.ok ?? 0),
      latency_ms: raw.latency_ms == null ? null : Number(raw.latency_ms),
      error: raw.error == null ? null : String(raw.error),
      response_snippet: raw.response_snippet == null ? null : String(raw.response_snippet),
    }));
  }
  return [
    ...allowUnboundedReadAcknowledged<AttemptRow>(referenceQueries.clientEventSubscriptionsListAttemptsForQueue, [
      queueId,
    ]),
  ];
}
