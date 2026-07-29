// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.client-event.derive` operation.
 *
 * Pure function: given a committed record-change descriptor and the active
 * client event subscriptions, produce the (projection-safe) envelopes that
 * should be enqueued for delivery. The output is a hint, not a record body —
 * derivation never returns field values, projected data, or resource ids
 * outside the subscription's bound scope snapshot.
 *
 * Boundary rules:
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, server-internal route/auth modules, or `process` / `process.env`.
 * - It SHALL NOT call back into ingest, storage, or delivery; callers wire
 *   that.
 */

export interface RecordChangeDescriptor {
  readonly connectionId?: string | null;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly emittedAt: string;
  /** Owner subject for the changed connector instance, when known. */
  readonly ownerSubjectId?: string | null;
  readonly stream: string;
  /** Monotonic per (connector_instance, stream) version from `record_changes`. */
  readonly version: number;
}

export interface SubscriptionScopeStream {
  /** Optional connection narrowing inherited from the grant. */
  readonly connection_id?: string | null;
  readonly name: string;
  readonly resources?: readonly string[];
  readonly time_range?: { start?: string | null; end?: string | null };
}

export interface SubscriptionScope {
  /** Optional client-supplied narrowing (subset of stream names from grant). */
  readonly filters?: { streams?: readonly string[] };
  readonly source?: { kind?: string; id?: string };
  readonly streams: readonly SubscriptionScopeStream[];
}

export interface ActiveSubscription {
  readonly authorityKind?: "client_grant" | "trusted_owner_agent";
  readonly clientId: string;
  readonly grantId: string | null;
  readonly scope: SubscriptionScope;
  readonly status: "active";
  readonly subjectId?: string | null;
  readonly subscriptionId: string;
}

export type DerivedEventType =
  | "pdpp.records.changed"
  | "pdpp.subscription.verify"
  | "pdpp.subscription.test"
  | "pdpp.grant.revoked";

export interface DerivedEvent {
  readonly data: {
    readonly connector_id?: string;
    readonly stream?: string;
    readonly connection_id?: string | null;
    readonly changes_since?: string;
    readonly change_count_hint?: number;
    readonly challenge?: string;
  };
  readonly occurredAt: string;
  readonly subscriptionId: string;
  readonly type: DerivedEventType;
}

function findScopeStream(scope: SubscriptionScope, stream: string): SubscriptionScopeStream | null {
  return scope.streams.find((s) => s.name === stream) ?? scope.streams.find((s) => s.name === "*") ?? null;
}

function inGrantScope(scope: SubscriptionScope, stream: string, connectionId: string | null | undefined): boolean {
  const filterList = scope.filters?.streams;
  if (filterList && !filterList.includes(stream)) {
    return false;
  }
  const match = findScopeStream(scope, stream);
  if (!match) {
    return false;
  }
  if (match.connection_id && connectionId && match.connection_id !== connectionId) {
    return false;
  }
  return true;
}

function subscriptionCanSeeChange(sub: ActiveSubscription, change: RecordChangeDescriptor): boolean {
  if (
    sub.authorityKind === "trusted_owner_agent" &&
    (!(sub.subjectId && change.ownerSubjectId) || sub.subjectId !== change.ownerSubjectId)
  ) {
    return false;
  }
  return inGrantScope(sub.scope, change.stream, change.connectionId ?? null);
}

function encodeChangesSinceCursor(version: number): string {
  // SQLite currently emits `{ kind, version }`; Postgres emits `{ v }`.
  // Include both names so event hints are readable by either existing backend
  // while remaining opaque to clients.
  return Buffer.from(JSON.stringify({ kind: "changes_since", v: version, version })).toString("base64");
}

/**
 * Compute the opaque `changes_since` cursor a client can pass back to
 * `rs.records.list` to enumerate the notified change. The records API returns
 * changes with versions greater than the cursor version, so the hint points to
 * the high-water mark immediately before this change.
 */
export function changeCursorBefore(change: Pick<RecordChangeDescriptor, "version">): string {
  return encodeChangesSinceCursor(Math.max(0, change.version - 1));
}

export function deriveClientEventsFromRecordChange(
  change: RecordChangeDescriptor,
  subscriptions: readonly ActiveSubscription[]
): readonly DerivedEvent[] {
  const out: DerivedEvent[] = [];
  for (const sub of subscriptions) {
    if (sub.status !== "active") {
      continue;
    }
    if (!subscriptionCanSeeChange(sub, change)) {
      continue;
    }
    const scopeStream = findScopeStream(sub.scope, change.stream);
    const includeConnectionId =
      sub.authorityKind === "trusted_owner_agent" || scopeStream?.name === "*" || Boolean(scopeStream?.connection_id);
    out.push({
      data: {
        ...(sub.authorityKind === "trusted_owner_agent" ? { connector_id: change.connectorId } : {}),
        stream: change.stream,
        ...(includeConnectionId ? { connection_id: change.connectionId ?? null } : {}),
        change_count_hint: 1,
        changes_since: changeCursorBefore(change),
      },
      occurredAt: change.emittedAt,
      subscriptionId: sub.subscriptionId,
      type: "pdpp.records.changed",
    });
  }
  return out;
}

/** Build a `subscription.verify` envelope. */
export function buildVerifyEvent(subscriptionId: string, challenge: string, occurredAt: string): DerivedEvent {
  return {
    data: { challenge },
    occurredAt,
    subscriptionId,
    type: "pdpp.subscription.verify",
  };
}

/** Build a `subscription.test` envelope. */
export function buildTestEvent(subscriptionId: string, occurredAt: string): DerivedEvent {
  return {
    data: {},
    occurredAt,
    subscriptionId,
    type: "pdpp.subscription.test",
  };
}

/** Build a `grant.revoked` envelope. */
export function buildGrantRevokedEvent(subscriptionId: string, occurredAt: string): DerivedEvent {
  return {
    data: {},
    occurredAt,
    subscriptionId,
    type: "pdpp.grant.revoked",
  };
}
