/**
 * Canonical `ref.client-event-subscriptions.get` operation.
 *
 * Owns the envelope for the operator-facing detail view that powers
 * `GET /_ref/event-subscriptions/:id`. Includes the bound grant's scope
 * snapshot, the full callback URL, and a bounded list of recent attempt
 * rows (capped at 25 by this operation). Never includes the
 * subscription's `secret`, `secret_hash`, or `secret_text`.
 *
 * Boundary rules: see the sibling
 * `ref-client-event-subscriptions-list/index.ts` header.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import type {
  SubscriptionAttemptRow,
  SubscriptionSummaryRow,
} from "../../server/stores/client-event-subscription-store.ts";
import type { SubscriptionScope } from "../rs-client-event-derive/index.ts";
import type { SubscriptionStatus } from "../as-client-event-subscriptions/index.ts";

export const REF_CLIENT_EVENT_SUBSCRIPTIONS_ATTEMPT_CAP = 25;

export class RefClientEventSubscriptionsNotFoundError extends Error {
  readonly code = "not_found" as const;
  readonly status = 404 as const;
  constructor(subscriptionId: string) {
    super(`subscription ${subscriptionId} not found`);
    this.name = "RefClientEventSubscriptionsNotFoundError";
  }
}

export interface RefClientEventSubscriptionAttempt {
  readonly attempt_id: number;
  readonly queue_id: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly attempted_at: string;
  readonly status_code: number | null;
  readonly ok: boolean;
  readonly latency_ms: number | null;
  readonly error: string | null;
  readonly response_snippet: string | null;
}

export interface RefClientEventSubscriptionDetail {
  readonly subscription_id: string;
  readonly client_id: string;
  readonly grant_id: string;
  readonly subject_id: string;
  readonly status: SubscriptionStatus;
  readonly disabled_reason: string | null;
  readonly callback_url: string;
  readonly callback_host: string;
  readonly scope: SubscriptionScope;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disabled_at: string | null;
  readonly pending_queue_count: number;
  readonly final_failure_count: number;
  readonly last_attempted_at: string | null;
  readonly last_attempt_ok: boolean | null;
  readonly last_attempt_status_code: number | null;
  readonly recent_attempts: RefClientEventSubscriptionAttempt[];
}

export interface RefClientEventSubscriptionsGetDependencies {
  getSubscriptionSummary(
    subscriptionId: string,
  ): Promise<SubscriptionSummaryRow | null> | SubscriptionSummaryRow | null;
  listAttemptsForSubscription(
    subscriptionId: string,
    limit: number,
  ): Promise<readonly SubscriptionAttemptRow[]> | readonly SubscriptionAttemptRow[];
}

function extractHost(callbackUrl: string): string {
  try {
    return new URL(callbackUrl).host;
  } catch {
    return callbackUrl;
  }
}

function parseScope(json: string): SubscriptionScope {
  try {
    return JSON.parse(json) as SubscriptionScope;
  } catch {
    // Defensive: if a row was somehow persisted with malformed scope_json
    // we surface an empty scope rather than crash the operator dashboard.
    return { source: undefined as unknown as string, streams: [] } as unknown as SubscriptionScope;
  }
}

export async function executeRefClientEventSubscriptionsGet(
  subscriptionId: string,
  dependencies: RefClientEventSubscriptionsGetDependencies,
): Promise<RefClientEventSubscriptionDetail> {
  const summary = await dependencies.getSubscriptionSummary(subscriptionId);
  if (!summary) {
    throw new RefClientEventSubscriptionsNotFoundError(subscriptionId);
  }
  const attempts = await dependencies.listAttemptsForSubscription(
    subscriptionId,
    REF_CLIENT_EVENT_SUBSCRIPTIONS_ATTEMPT_CAP,
  );
  return {
    subscription_id: summary.subscription_id,
    client_id: summary.client_id,
    grant_id: summary.grant_id,
    subject_id: summary.subject_id,
    status: summary.status,
    disabled_reason: summary.disabled_reason,
    callback_url: summary.callback_url,
    callback_host: extractHost(summary.callback_url),
    scope: parseScope(summary.scope_json),
    created_at: summary.created_at,
    updated_at: summary.updated_at,
    disabled_at: summary.disabled_at,
    pending_queue_count: summary.pending_queue_count,
    final_failure_count: summary.final_failure_count,
    last_attempted_at: summary.last_attempted_at,
    last_attempt_ok:
      summary.last_attempt_ok === null || summary.last_attempt_ok === undefined
        ? null
        : summary.last_attempt_ok !== 0,
    last_attempt_status_code: summary.last_attempt_status_code,
    recent_attempts: attempts.slice(0, REF_CLIENT_EVENT_SUBSCRIPTIONS_ATTEMPT_CAP).map((a) => ({
      attempt_id: a.attempt_id,
      queue_id: a.queue_id,
      event_id: a.event_id,
      event_type: a.event_type,
      attempted_at: a.attempted_at,
      status_code: a.status_code,
      ok: a.ok !== 0,
      latency_ms: a.latency_ms,
      error: a.error,
      response_snippet: a.response_snippet,
    })),
  };
}
