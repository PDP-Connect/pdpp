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
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  /** Owner subject for the changed connector instance, when known. */
  readonly ownerSubjectId?: string | null;
  readonly connectionId?: string | null;
  readonly stream: string;
  /** Monotonic per (connector_instance, stream) version from `record_changes`. */
  readonly version: number;
  readonly emittedAt: string;
}

export interface SubscriptionScopeStream {
  readonly name: string;
  /** Optional connection narrowing inherited from the grant. */
  readonly connection_id?: string | null;
  readonly resources?: ReadonlyArray<string>;
  readonly time_range?: { start?: string | null; end?: string | null };
}

export interface SubscriptionScope {
  readonly source?: { kind?: string; id?: string };
  readonly streams: ReadonlyArray<SubscriptionScopeStream>;
  /** Optional client-supplied narrowing (subset of stream names from grant). */
  readonly filters?: { streams?: ReadonlyArray<string> };
}

export interface ActiveSubscription {
  readonly subscriptionId: string;
  readonly authorityKind?: "client_grant" | "trusted_owner_agent";
  readonly grantId: string | null;
  readonly clientId: string;
  readonly subjectId?: string | null;
  readonly scope: SubscriptionScope;
  readonly status: "active";
}

export type DerivedEventType =
  | "pdpp.records.changed"
  | "pdpp.subscription.verify"
  | "pdpp.subscription.test"
  | "pdpp.grant.revoked";

export interface DerivedEvent {
  readonly subscriptionId: string;
  readonly type: DerivedEventType;
  readonly occurredAt: string;
  readonly data: {
    readonly connector_id?: string;
    readonly stream?: string;
    readonly connection_id?: string | null;
    readonly changes_since?: string;
    readonly change_count_hint?: number;
    readonly challenge?: string;
  };
}

function findScopeStream(
  scope: SubscriptionScope,
  stream: string,
): SubscriptionScopeStream | null {
  return scope.streams.find((s) => s.name === stream) ?? scope.streams.find((s) => s.name === "*") ?? null;
}

function inGrantScope(scope: SubscriptionScope, stream: string, connectionId: string | null | undefined): boolean {
  const filterList = scope.filters?.streams;
  if (filterList && !filterList.includes(stream)) return false;
  const match = findScopeStream(scope, stream);
  if (!match) return false;
  if (match.connection_id && connectionId && match.connection_id !== connectionId) return false;
  return true;
}

function subscriptionCanSeeChange(sub: ActiveSubscription, change: RecordChangeDescriptor): boolean {
  if (sub.authorityKind === "trusted_owner_agent") {
    if (!sub.subjectId || !change.ownerSubjectId || sub.subjectId !== change.ownerSubjectId) return false;
  }
  return inGrantScope(sub.scope, change.stream, change.connectionId ?? null);
}

function encodeChangesSinceCursor(version: number): string {
  // SQLite currently emits `{ kind, version }`; Postgres emits `{ v }`.
  // Include both names so event hints are readable by either existing backend
  // while remaining opaque to clients.
  return Buffer.from(JSON.stringify({ kind: "changes_since", version, v: version })).toString("base64");
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
  subscriptions: ReadonlyArray<ActiveSubscription>,
): ReadonlyArray<DerivedEvent> {
  const out: DerivedEvent[] = [];
  for (const sub of subscriptions) {
    if (sub.status !== "active") continue;
    if (!subscriptionCanSeeChange(sub, change)) continue;
    const scopeStream = findScopeStream(sub.scope, change.stream);
    const includeConnectionId =
      sub.authorityKind === "trusted_owner_agent" || scopeStream?.name === "*" || Boolean(scopeStream?.connection_id);
    out.push({
      subscriptionId: sub.subscriptionId,
      type: "pdpp.records.changed",
      occurredAt: change.emittedAt,
      data: {
        ...(sub.authorityKind === "trusted_owner_agent" ? { connector_id: change.connectorId } : {}),
        stream: change.stream,
        ...(includeConnectionId ? { connection_id: change.connectionId ?? null } : {}),
        changes_since: changeCursorBefore(change),
        change_count_hint: 1,
      },
    });
  }
  return out;
}

/** Build a `subscription.verify` envelope. */
export function buildVerifyEvent(
  subscriptionId: string,
  challenge: string,
  occurredAt: string,
): DerivedEvent {
  return {
    subscriptionId,
    type: "pdpp.subscription.verify",
    occurredAt,
    data: { challenge },
  };
}

/** Build a `subscription.test` envelope. */
export function buildTestEvent(subscriptionId: string, occurredAt: string): DerivedEvent {
  return {
    subscriptionId,
    type: "pdpp.subscription.test",
    occurredAt,
    data: {},
  };
}

/** Build a `grant.revoked` envelope. */
export function buildGrantRevokedEvent(subscriptionId: string, occurredAt: string): DerivedEvent {
  return {
    subscriptionId,
    type: "pdpp.grant.revoked",
    occurredAt,
    data: {},
  };
}
