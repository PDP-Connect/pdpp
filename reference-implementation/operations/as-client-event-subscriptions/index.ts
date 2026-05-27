/**
 * Canonical `as.client-event-subscriptions.*` operations.
 *
 * Pure operation layer for the outbound client event subscription surface.
 * Host adapter (Express) owns HTTP routing, bearer auth, request id
 * propagation, and response writing. The operation owns:
 *
 *  - input validation (callback URL shape, optional filters);
 *  - grant-scoped authorization (subscription must belong to the bearer's
 *    `(client_id, grant_id)`);
 *  - persistence via the injected store;
 *  - enqueueing a single `subscription.verify` event on create;
 *  - enqueueing a deterministic `subscription.test` event when requested;
 *  - revocation enqueue when the bound grant transitions to revoked.
 *
 * The operation does not sign or POST anything; the delivery worker owns
 * that. It does not depend on Fastify, SQLite, Postgres, or `process.env`.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  buildGrantRevokedEvent,
  buildTestEvent,
  buildVerifyEvent,
  type DerivedEvent,
  type SubscriptionScope,
} from "../rs-client-event-derive/index.ts";

export class ClientEventSubscriptionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ClientEventSubscriptionError";
    this.code = code;
    this.status = status;
  }
}

export interface BearerActor {
  readonly clientId: string;
  readonly grantId: string;
  readonly subjectId: string;
  /** Grant scope snapshot derived from the bearer's grant. */
  readonly grantScope: SubscriptionScope;
}

export interface SubscriptionRow {
  readonly subscription_id: string;
  readonly grant_id: string;
  readonly client_id: string;
  readonly subject_id: string;
  readonly callback_url: string;
  readonly secret_hash: string;
  readonly secret_text: string;
  readonly scope_json: string;
  readonly status: SubscriptionStatus;
  readonly verification_challenge: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disabled_at: string | null;
  readonly disabled_reason: string | null;
}

export type SubscriptionStatus =
  | "pending_verification"
  | "active"
  | "disabled"
  | "disabled_failure"
  | "disabled_revoked"
  | "deleted";

export interface QueuedEventForEnqueue {
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payloadJson: string;
  readonly enqueuedAt: string;
  readonly nextAttemptAt: string;
}

/**
 * Persistence interface for client event subscriptions.
 *
 * Every method returns a Promise so the operation layer can run uniformly
 * against either the SQLite-backed store (`server/stores/client-event-
 * subscription-store.ts`, sync under the hood, resolved Promises) or the
 * Postgres-backed store (`postgres-client-event-subscription-store.ts`,
 * real async via `postgresQuery`). The operation layer awaits everything
 * so it works with both.
 */
export interface ClientEventSubscriptionStore {
  insertSubscription(row: SubscriptionRow): Promise<void> | void;
  getSubscriptionById(id: string): Promise<SubscriptionRow | null> | SubscriptionRow | null;
  listSubscriptionsByClient(clientId: string): Promise<SubscriptionRow[]> | SubscriptionRow[];
  updateStatus(
    id: string,
    status: SubscriptionStatus,
    updatedAt: string,
    disabledAt: string | null,
    disabledReason: string | null,
  ): Promise<void> | void;
  updateSecret(
    id: string,
    secretHash: string,
    secretText: string,
    updatedAt: string,
  ): Promise<void> | void;
  deleteSubscription(id: string): Promise<void> | void;
  enqueueEvent(event: QueuedEventForEnqueue): Promise<void> | void;
  dropQueuedForSubscription(id: string): Promise<void> | void;
  listSubscriptionsByGrant(grantId: string): Promise<SubscriptionRow[]> | SubscriptionRow[];
}

export interface CreateSubscriptionInput {
  readonly actor: BearerActor;
  readonly callbackUrl: string;
  readonly filters?: { streams?: ReadonlyArray<string> };
}

export interface CreateSubscriptionOutput {
  readonly subscriptionId: string;
  readonly secret: string;
  readonly status: SubscriptionStatus;
  readonly callbackUrl: string;
  readonly createdAt: string;
}

const ALLOWED_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const CALLBACK_URL_MAX_BYTES = 2048;

function validateCallbackUrl(raw: string): URL {
  if (Buffer.byteLength(raw, "utf8") > CALLBACK_URL_MAX_BYTES) {
    throw new ClientEventSubscriptionError("invalid_request", "callback_url exceeds 2048 bytes");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ClientEventSubscriptionError("invalid_request", "callback_url must be an absolute URL");
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && ALLOWED_LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) return parsed;
  throw new ClientEventSubscriptionError(
    "invalid_request",
    "callback_url must use https:// (http://localhost permitted for development)",
  );
}

function narrowScope(actor: BearerActor, filters: { streams?: ReadonlyArray<string> } | undefined): SubscriptionScope {
  const grantScope = actor.grantScope;
  if (!filters?.streams || filters.streams.length === 0) return grantScope;
  const grantNames = new Set(grantScope.streams.map((s) => s.name));
  const unauthorized = filters.streams.filter((n) => !grantNames.has(n));
  if (unauthorized.length) {
    throw new ClientEventSubscriptionError(
      "invalid_request",
      `filter streams not in grant: ${unauthorized.join(", ")}`,
    );
  }
  return { ...grantScope, filters: { streams: [...filters.streams] } };
}

function newSubscriptionId(): string {
  return `sub_${randomBytes(12).toString("hex")}`;
}
function newEventId(): string {
  return `evt_${randomBytes(12).toString("hex")}`;
}
function newSecret(): string {
  return `pess_${randomBytes(24).toString("base64url")}`;
}
function newChallenge(): string {
  return randomBytes(16).toString("hex");
}
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export interface ClientEventSubscriptionDependencies {
  readonly store: ClientEventSubscriptionStore;
  readonly nowIso: () => string;
}

export async function executeCreateSubscription(
  input: CreateSubscriptionInput,
  deps: ClientEventSubscriptionDependencies,
): Promise<CreateSubscriptionOutput> {
  const callback = validateCallbackUrl(input.callbackUrl);
  const scope = narrowScope(input.actor, input.filters);
  const subscriptionId = newSubscriptionId();
  const secret = newSecret();
  const secretHash = hashSecret(secret);
  const challenge = newChallenge();
  const now = deps.nowIso();
  const row: SubscriptionRow = {
    subscription_id: subscriptionId,
    grant_id: input.actor.grantId,
    client_id: input.actor.clientId,
    subject_id: input.actor.subjectId,
    callback_url: callback.toString(),
    secret_hash: secretHash,
    secret_text: secret,
    scope_json: JSON.stringify(scope),
    status: "pending_verification",
    verification_challenge: challenge,
    created_at: now,
    updated_at: now,
    disabled_at: null,
    disabled_reason: null,
  };
  await deps.store.insertSubscription(row);
  const verifyEvent = buildVerifyEvent(subscriptionId, challenge, now);
  await enqueue(deps, verifyEvent, now);
  return {
    subscriptionId,
    secret,
    status: "pending_verification",
    callbackUrl: row.callback_url,
    createdAt: now,
  };
}

/**
 * Canonical, dereferenceable URL used as the CloudEvents `source` for every
 * envelope we emit. Clients can fetch this path on the resource server to
 * see the subscription's current state. The constant lives next to the
 * envelope writer so the wire shape and the route both update together.
 *
 * Mount point: `buildRsApp` in `server/index.js`. Advertised in the resource
 * server's protected-resource metadata as a `client_event_subscriptions`
 * RI extension capability.
 */
export const SUBSCRIPTION_RESOURCE_PATH = "/v1/event-subscriptions";

function eventSource(subscriptionId: string): string {
  return `${SUBSCRIPTION_RESOURCE_PATH}/${subscriptionId}`;
}

async function enqueue(
  deps: ClientEventSubscriptionDependencies,
  event: DerivedEvent,
  nowIso: string,
): Promise<void> {
  const eventId = newEventId();
  const payload = {
    specversion: "1.0-pdpp",
    id: eventId,
    type: event.type,
    source: eventSource(event.subscriptionId),
    subscription_id: event.subscriptionId,
    occurred_at: event.occurredAt,
    data: event.data,
  };
  await deps.store.enqueueEvent({
    subscriptionId: event.subscriptionId,
    eventId,
    eventType: event.type,
    payloadJson: JSON.stringify(payload),
    enqueuedAt: nowIso,
    nextAttemptAt: nowIso,
  });
}

export interface ProjectedSubscription {
  readonly subscription_id: string;
  readonly grant_id: string;
  readonly client_id: string;
  readonly callback_url: string;
  readonly status: SubscriptionStatus;
  readonly scope: SubscriptionScope;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disabled_reason: string | null;
}

function projectRow(row: SubscriptionRow): ProjectedSubscription {
  return {
    subscription_id: row.subscription_id,
    grant_id: row.grant_id,
    client_id: row.client_id,
    callback_url: row.callback_url,
    status: row.status,
    scope: JSON.parse(row.scope_json) as SubscriptionScope,
    created_at: row.created_at,
    updated_at: row.updated_at,
    disabled_reason: row.disabled_reason,
  };
}

async function loadOwnedSubscription(
  deps: ClientEventSubscriptionDependencies,
  actor: BearerActor,
  subscriptionId: string,
): Promise<SubscriptionRow> {
  const row = await deps.store.getSubscriptionById(subscriptionId);
  if (!row || row.client_id !== actor.clientId || row.grant_id !== actor.grantId) {
    throw new ClientEventSubscriptionError("not_found", "subscription not found", 404);
  }
  if (row.status === "deleted") {
    throw new ClientEventSubscriptionError("not_found", "subscription not found", 404);
  }
  return row;
}

export async function executeGetSubscription(
  actor: BearerActor,
  subscriptionId: string,
  deps: ClientEventSubscriptionDependencies,
): Promise<ProjectedSubscription> {
  return projectRow(await loadOwnedSubscription(deps, actor, subscriptionId));
}

export async function executeListSubscriptions(
  actor: BearerActor,
  deps: ClientEventSubscriptionDependencies,
): Promise<{ readonly data: ReadonlyArray<ProjectedSubscription> }> {
  const rows = (await deps.store.listSubscriptionsByClient(actor.clientId))
    .filter((row) => row.grant_id === actor.grantId && row.status !== "deleted");
  return { data: rows.map(projectRow) };
}

export interface UpdateSubscriptionInput {
  readonly enabled?: boolean;
  readonly rotateSecret?: boolean;
}

export interface UpdateSubscriptionOutput {
  readonly subscription: ProjectedSubscription;
  readonly secret?: string;
}

export async function executeUpdateSubscription(
  actor: BearerActor,
  subscriptionId: string,
  input: UpdateSubscriptionInput,
  deps: ClientEventSubscriptionDependencies,
): Promise<UpdateSubscriptionOutput> {
  const row = await loadOwnedSubscription(deps, actor, subscriptionId);
  const now = deps.nowIso();
  let newSecretValue: string | undefined;
  if (input.rotateSecret) {
    newSecretValue = newSecret();
    await deps.store.updateSecret(row.subscription_id, hashSecret(newSecretValue), newSecretValue, now);
  }
  if (typeof input.enabled === "boolean") {
    if (input.enabled) {
      if (row.status === "disabled" || row.status === "disabled_failure") {
        await deps.store.updateStatus(row.subscription_id, "active", now, null, null);
      } else if (row.status === "disabled_revoked") {
        throw new ClientEventSubscriptionError(
          "grant_revoked",
          "subscription is bound to a revoked grant and cannot be re-enabled",
          409,
        );
      }
    } else if (row.status === "active" || row.status === "pending_verification") {
      await deps.store.updateStatus(row.subscription_id, "disabled", now, now, "client_disabled");
    }
  }
  const updated = await deps.store.getSubscriptionById(row.subscription_id);
  if (!updated) throw new ClientEventSubscriptionError("not_found", "subscription not found", 404);
  return {
    subscription: projectRow(updated),
    ...(newSecretValue ? { secret: newSecretValue } : {}),
  };
}

export async function executeDeleteSubscription(
  actor: BearerActor,
  subscriptionId: string,
  deps: ClientEventSubscriptionDependencies,
): Promise<void> {
  const row = await loadOwnedSubscription(deps, actor, subscriptionId);
  const now = deps.nowIso();
  await deps.store.updateStatus(row.subscription_id, "deleted", now, now, "deleted");
  await deps.store.dropQueuedForSubscription(row.subscription_id);
}

export async function executeEnqueueTestEvent(
  actor: BearerActor,
  subscriptionId: string,
  deps: ClientEventSubscriptionDependencies,
): Promise<{ readonly eventId: string }> {
  const row = await loadOwnedSubscription(deps, actor, subscriptionId);
  if (row.status !== "active" && row.status !== "pending_verification") {
    throw new ClientEventSubscriptionError(
      "invalid_state",
      `cannot enqueue test event for subscription in status ${row.status}`,
      409,
    );
  }
  const now = deps.nowIso();
  const event = buildTestEvent(row.subscription_id, now);
  const eventId = newEventId();
  const payload = {
    specversion: "1.0-pdpp",
    id: eventId,
    type: event.type,
    source: eventSource(event.subscriptionId),
    subscription_id: event.subscriptionId,
    occurred_at: event.occurredAt,
    data: event.data,
  };
  await deps.store.enqueueEvent({
    subscriptionId: row.subscription_id,
    eventId,
    eventType: event.type,
    payloadJson: JSON.stringify(payload),
    enqueuedAt: now,
    nextAttemptAt: now,
  });
  return { eventId };
}

/**
 * Hook invoked from the grant-revoke flow. Marks all active or pending
 * subscriptions for the grant as disabled_revoked, drops their pending
 * queue rows, and emits at most one grant.revoked envelope per previously
 * active subscription.
 */
export async function executeApplyGrantRevoke(
  grantId: string,
  deps: ClientEventSubscriptionDependencies,
): Promise<{ readonly affected: number; readonly notified: number }> {
  const rows = await deps.store.listSubscriptionsByGrant(grantId);
  const now = deps.nowIso();
  let notified = 0;
  let affected = 0;
  for (const row of rows) {
    if (row.status === "deleted" || row.status === "disabled_revoked") continue;
    affected += 1;
    const wasActive = row.status === "active";
    await deps.store.dropQueuedForSubscription(row.subscription_id);
    await deps.store.updateStatus(row.subscription_id, "disabled_revoked", now, now, "grant_revoked");
    if (wasActive) {
      const event = buildGrantRevokedEvent(row.subscription_id, now);
      const eventId = newEventId();
      const payload = {
        specversion: "1.0-pdpp",
        id: eventId,
        type: event.type,
        source: eventSource(event.subscriptionId),
        subscription_id: event.subscriptionId,
        occurred_at: event.occurredAt,
        data: event.data,
      };
      await deps.store.enqueueEvent({
        subscriptionId: row.subscription_id,
        eventId,
        eventType: event.type,
        payloadJson: JSON.stringify(payload),
        enqueuedAt: now,
        nextAttemptAt: now,
      });
      notified += 1;
    }
  }
  return { affected, notified };
}

/** Verification handshake helpers. Called by the delivery worker. */
export async function executeVerificationOutcome(
  subscriptionId: string,
  outcome: "verified" | "failed",
  deps: ClientEventSubscriptionDependencies,
): Promise<SubscriptionRow> {
  const row = await deps.store.getSubscriptionById(subscriptionId);
  if (!row) throw new ClientEventSubscriptionError("not_found", "subscription not found", 404);
  const now = deps.nowIso();
  if (outcome === "verified" && row.status === "pending_verification") {
    await deps.store.updateStatus(row.subscription_id, "active", now, null, null);
  } else if (outcome === "failed") {
    await deps.store.updateStatus(row.subscription_id, "pending_verification", now, null, null);
  }
  return (await deps.store.getSubscriptionById(subscriptionId)) as SubscriptionRow;
}

export async function executeRecordDeliveryFailure(
  subscriptionId: string,
  deps: ClientEventSubscriptionDependencies,
): Promise<void> {
  const row = await deps.store.getSubscriptionById(subscriptionId);
  if (!row) return;
  if (row.status === "active" || row.status === "pending_verification") {
    const now = deps.nowIso();
    await deps.store.updateStatus(row.subscription_id, "disabled_failure", now, now, "delivery_failed");
    await deps.store.dropQueuedForSubscription(row.subscription_id);
  }
}
