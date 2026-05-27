/**
 * SQLite-backed `ClientEventSubscriptionStore` and queue/attempt helpers.
 *
 * The reference operates on the registered SQL artifacts under
 * `server/queries/client-event-subscriptions/`. The store exposes the
 * interface the operation depends on and adds queue-claim/attempt-log
 * helpers used by the delivery worker.
 *
 * Postgres parity is intentionally deferred — the source-webhook tranche
 * also shipped SQLite-first. A follow-up change can mirror the DDL into
 * `postgres-storage.js` and split create/query helpers.
 */

import { exec, getOne, referenceQueries, allowUnboundedReadAcknowledged } from "../../lib/db.ts";
import type {
  ClientEventSubscriptionStore,
  QueuedEventForEnqueue,
  SubscriptionRow,
  SubscriptionStatus,
} from "../../operations/as-client-event-subscriptions/index.ts";

export interface QueueRow {
  readonly queue_id: number;
  readonly subscription_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly payload_json: string;
  readonly enqueued_at: string;
  readonly next_attempt_at: string;
  readonly attempt_count: number;
  readonly status: string;
  readonly callback_url: string;
  readonly secret_hash: string;
  readonly subscription_status: SubscriptionStatus;
}

export interface AttemptRow {
  readonly attempt_id: number;
  readonly queue_id: number;
  readonly attempted_at: string;
  readonly status_code: number | null;
  readonly ok: number;
  readonly latency_ms: number | null;
  readonly error: string | null;
  readonly response_snippet: string | null;
}

export function createSqliteClientEventSubscriptionStore(): ClientEventSubscriptionStore {
  return {
    insertSubscription(row: SubscriptionRow): void {
      exec(referenceQueries.clientEventSubscriptionsInsertSubscription, [
        row.subscription_id,
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
      return getOne<SubscriptionRow>(
        referenceQueries.clientEventSubscriptionsGetSubscriptionById,
        [id],
      );
    },
    listSubscriptionsByClient(clientId: string): SubscriptionRow[] {
      return [
        ...allowUnboundedReadAcknowledged<SubscriptionRow>(
          referenceQueries.clientEventSubscriptionsListSubscriptionsByClient,
          [clientId],
        ),
      ];
    },
    listSubscriptionsByGrant(grantId: string): SubscriptionRow[] {
      return [
        ...allowUnboundedReadAcknowledged<SubscriptionRow>(
          referenceQueries.clientEventSubscriptionsListSubscriptionsByGrant,
          [grantId],
        ),
      ];
    },
    updateStatus(id, status, updatedAt, disabledAt, disabledReason): void {
      exec(referenceQueries.clientEventSubscriptionsUpdateStatus, [
        status,
        updatedAt,
        disabledAt,
        disabledReason,
        id,
      ]);
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

export function listActiveSubscriptions(): SubscriptionRow[] {
  return [
    ...allowUnboundedReadAcknowledged<SubscriptionRow>(
      referenceQueries.clientEventSubscriptionsListActiveSubscriptions,
      [],
    ),
  ];
}

export function claimDueQueue(beforeIso: string): QueueRow[] {
  return [
    ...allowUnboundedReadAcknowledged<QueueRow>(
      referenceQueries.clientEventSubscriptionsClaimDueQueue,
      [beforeIso],
    ),
  ];
}

export function updateQueueAttempt(
  queueId: number,
  attemptCount: number,
  nextAttemptAt: string,
  status: "pending" | "delivered" | "final_failure" | "dropped",
  lastError: string | null,
): void {
  exec(referenceQueries.clientEventSubscriptionsUpdateQueueAttempt, [
    attemptCount,
    nextAttemptAt,
    status,
    lastError,
    queueId,
  ]);
}

export function insertAttempt(
  queueId: number,
  attemptedAt: string,
  statusCode: number | null,
  ok: boolean,
  latencyMs: number | null,
  error: string | null,
  responseSnippet: string | null,
): void {
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

export function listAttemptsForQueue(queueId: number): AttemptRow[] {
  return [
    ...allowUnboundedReadAcknowledged<AttemptRow>(
      referenceQueries.clientEventSubscriptionsListAttemptsForQueue,
      [queueId],
    ),
  ];
}

let defaultStore: ClientEventSubscriptionStore | null = null;
export function getDefaultClientEventSubscriptionStore(): ClientEventSubscriptionStore {
  if (!defaultStore) defaultStore = createSqliteClientEventSubscriptionStore();
  return defaultStore;
}
