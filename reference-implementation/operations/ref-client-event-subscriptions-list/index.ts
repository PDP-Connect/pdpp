// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `ref.client-event-subscriptions.list` operation.
 *
 * Owns the envelope semantics for the reference-only operator oversight
 * surface that powers `GET /_ref/event-subscriptions`. Hosts (the Express
 * route in `server/index.js`) supply the store-backed reads via the
 * dependency contract; the operation projects each subscription into the
 * operator summary shape (status, callback host, attempt counts, last
 * attempt outcome) and assembles the `{object: 'list', data}` envelope.
 *
 * The projection deliberately strips `secret`, `secret_hash`, and
 * `secret_text` — the secret is the client's mutual-authentication
 * credential and the operator never needs it. See the design note in
 * openspec/changes/add-client-event-subscription-management/design.md
 * for the full rationale.
 *
 * Boundary rules:
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, raw SQL handles, sandbox modules,
 *   `reference-implementation/server/*` route or auth modules, or
 *   `process` / `process.env`.
 * - Substrate reads flow in through dependencies. The host wires the
 *   concrete reads (currently `listAllSubscriptions` and
 *   `getSubscriptionSummary` from the store module).
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import type {
  ListAllSubscriptionsFilters,
  SubscriptionSummaryRow,
} from "../../server/stores/client-event-subscription-store.ts";
import type {
  SubscriptionAuthorityKind,
  SubscriptionRow,
  SubscriptionStatus,
} from "../as-client-event-subscriptions/index.ts";

export interface RefClientEventSubscriptionsListInput {
  readonly clientId?: string | null;
  readonly grantId?: string | null;
  readonly status?: string | null;
}

export interface RefClientEventSubscriptionsListItem {
  readonly authority_kind: SubscriptionAuthorityKind;
  readonly callback_host: string;
  readonly client_id: string;
  readonly created_at: string;
  readonly disabled_at: string | null;
  readonly disabled_reason: string | null;
  readonly final_failure_count: number;
  readonly grant_id: string | null;
  readonly last_attempt_ok: boolean | null;
  readonly last_attempt_status_code: number | null;
  readonly last_attempted_at: string | null;
  readonly pending_queue_count: number;
  readonly status: SubscriptionStatus;
  readonly subscription_id: string;
  readonly updated_at: string;
}

export interface RefClientEventSubscriptionsListEnvelope {
  readonly data: RefClientEventSubscriptionsListItem[];
  readonly object: "list";
}

export interface RefClientEventSubscriptionsListDependencies {
  getSubscriptionSummary: (
    subscriptionId: string
  ) => Promise<SubscriptionSummaryRow | null> | SubscriptionSummaryRow | null;
  listAllSubscriptions: (
    filters: ListAllSubscriptionsFilters
  ) => Promise<readonly SubscriptionRow[]> | readonly SubscriptionRow[];
}

const KNOWN_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  "pending_verification",
  "active",
  "disabled",
  "disabled_failure",
  "disabled_revoked",
  "deleted",
]);

function normalizeStatus(value: string | null | undefined): SubscriptionStatus | null {
  if (!value) {
    return null;
  }
  if (!KNOWN_STATUSES.has(value as SubscriptionStatus)) {
    return null;
  }
  return value as SubscriptionStatus;
}

function extractHost(callbackUrl: string): string {
  try {
    return new URL(callbackUrl).host;
  } catch {
    return callbackUrl;
  }
}

function nullableBool(value: number | null): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value !== 0;
}

export async function executeRefClientEventSubscriptionsList(
  input: RefClientEventSubscriptionsListInput,
  dependencies: RefClientEventSubscriptionsListDependencies
): Promise<RefClientEventSubscriptionsListEnvelope> {
  // Reject unknown status values with an empty list — see spec scenario
  // "An operator filters the list by client, grant, or status". An unknown
  // status is a well-formed-but-not-matching filter, not a 4xx error.
  const requestedStatus = input.status ?? null;
  const resolvedStatus = normalizeStatus(requestedStatus);
  if (requestedStatus && !resolvedStatus) {
    return { data: [], object: "list" };
  }
  const rows = await dependencies.listAllSubscriptions({
    clientId: input.clientId ?? null,
    grantId: input.grantId ?? null,
    status: resolvedStatus,
  });
  const items: RefClientEventSubscriptionsListItem[] = [];
  for (const row of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const summary = await dependencies.getSubscriptionSummary(row.subscription_id);
    if (!summary) {
      continue;
    }
    items.push({
      authority_kind: summary.authority_kind,
      callback_host: extractHost(summary.callback_url),
      client_id: summary.client_id,
      created_at: summary.created_at,
      disabled_at: summary.disabled_at,
      disabled_reason: summary.disabled_reason,
      final_failure_count: summary.final_failure_count,
      grant_id: summary.grant_id,
      last_attempt_ok: nullableBool(summary.last_attempt_ok),
      last_attempt_status_code: summary.last_attempt_status_code,
      last_attempted_at: summary.last_attempted_at,
      pending_queue_count: summary.pending_queue_count,
      status: summary.status,
      subscription_id: summary.subscription_id,
      updated_at: summary.updated_at,
    });
  }
  return { data: items, object: "list" };
}
