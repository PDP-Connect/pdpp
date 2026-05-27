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
  readonly grantId: string;
  readonly clientId: string;
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
    readonly stream?: string;
    readonly connection_id?: string | null;
    readonly changes_since?: string;
    readonly change_count_hint?: number;
    readonly challenge?: string;
  };
}

function inGrantScope(scope: SubscriptionScope, stream: string, connectionId: string | null | undefined): boolean {
  const filterList = scope.filters?.streams;
  if (filterList && !filterList.includes(stream)) return false;
  const match = scope.streams.find((s) => s.name === stream);
  if (!match) return false;
  if (match.connection_id && connectionId && match.connection_id !== connectionId) return false;
  return true;
}

/**
 * Compute the opaque `changes_since` cursor a client can pass to
 * `rs.records.list` to enumerate the change. The cursor format matches the
 * existing `record_changes.version` semantics: a string carrying the version
 * after the changed row, so passing it back as `changes_since` excludes
 * already-seen versions.
 */
export function changeCursorAfter(change: Pick<RecordChangeDescriptor, "version">): string {
  return String(change.version);
}

export function deriveClientEventsFromRecordChange(
  change: RecordChangeDescriptor,
  subscriptions: ReadonlyArray<ActiveSubscription>,
): ReadonlyArray<DerivedEvent> {
  const out: DerivedEvent[] = [];
  for (const sub of subscriptions) {
    if (sub.status !== "active") continue;
    if (!inGrantScope(sub.scope, change.stream, change.connectionId ?? null)) continue;
    out.push({
      subscriptionId: sub.subscriptionId,
      type: "pdpp.records.changed",
      occurredAt: change.emittedAt,
      data: {
        stream: change.stream,
        ...(sub.scope.streams.find((s) => s.name === change.stream)?.connection_id
          ? { connection_id: change.connectionId ?? null }
          : {}),
        changes_since: changeCursorAfter(change),
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
