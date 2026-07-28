// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { Agent as HttpsAgent } from "node:https";

import { allowUnboundedReadAcknowledged, exec, getOne, referenceQueries } from "../lib/db.ts";
import {
  classifyAssistanceNotification,
  NOTIFICATION_TIERS,
  projectNotificationDelivery,
  shouldFanoutRenderedVerdict,
} from "./notification-policy.ts";
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";
import type { DnsLookupAll } from "./ssrf-guard.ts";
import { createPinnedHttpsAgent, resolveAllowedAddresses } from "./ssrf-guard.ts";

const DEFAULT_TTL_SECONDS = 10 * 60;

/**
 * Owner-supplied push subscription as it arrives over the wire, before
 * `normalizeSubscription` proves the three required fields are present.
 */
export interface WebPushSubscriptionInput {
  endpoint?: unknown;
  keys?: { auth?: unknown; p256dh?: unknown } | null;
}

/** A subscription whose endpoint and both keys are known-present. */
export interface NormalizedWebPushSubscription {
  endpoint: string;
  keys: { auth: string; p256dh: string };
}

export interface WebPushPlatformInput {
  device_label?: unknown;
  platform?: unknown;
  user_agent?: unknown;
}

interface NormalizedWebPushPlatform {
  device_label: string | null;
  platform: string | null;
  user_agent: string | null;
}

/**
 * A `web_push_subscriptions` row. The SQLite and Postgres stores both select
 * this exact column list; the memory store builds the same shape in-process.
 */
export interface WebPushSubscriptionRecord extends NormalizedWebPushPlatform {
  auth: string;
  created_at: string;
  endpoint: string;
  id: string;
  keys?: { auth: string; p256dh: string };
  last_failure_at: string | null;
  last_failure_reason: string | null;
  last_success_at: string | null;
  last_used_at: string | null;
  owner_subject_id: string;
  p256dh: string;
  revoked_at: string | null;
  updated_at: string;
}

/** Owner-facing projection: never carries the raw `p256dh`/`auth` keys. */
export interface PublicWebPushSubscription extends NormalizedWebPushPlatform {
  created_at: string;
  endpoint: string | null;
  endpoint_redacted: string | null;
  id: string;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  last_success_at: string | null;
  last_used_at: string | null;
  owner_subject_id: string;
  revoked_at: string | null;
  updated_at: string;
}

/** A raw store row plus the `keys` object the sender needs. */
export interface RawWebPushSubscription extends WebPushSubscriptionRecord {
  keys: { auth: string; p256dh: string };
}

export interface WebPushListOptions {
  activeOnly?: boolean;
  includeEndpoint?: boolean;
}

export interface WebPushMarkFailureOptions {
  revoke?: boolean;
}

/**
 * The store surface the fanout paths depend on. The three concrete stores
 * (memory / SQLite / Postgres) differ in sync-vs-async return types, so the
 * shared contract states each result as `T | Promise<T>` — every caller
 * already `await`s, which is a no-op on the synchronous stores.
 */
export interface WebPushSubscriptionStore {
  clearForTests: () => void | Promise<void>;
  list: (
    ownerSubjectId: string,
    options?: WebPushListOptions
  ) => (PublicWebPushSubscription | null)[] | Promise<(PublicWebPushSubscription | null)[]>;
  listActiveRaw: (ownerSubjectId: unknown) => RawWebPushSubscription[] | Promise<RawWebPushSubscription[]>;
  markFailure: (endpoint: string, reason: string, options?: WebPushMarkFailureOptions) => void | Promise<void>;
  markSuccess: (endpoint: string) => void | Promise<void>;
  revoke: (
    ownerSubjectId: string,
    endpoint: unknown
  ) => PublicWebPushSubscription | null | Promise<PublicWebPushSubscription | null>;
  upsert: (
    ownerSubjectId: string,
    subscription: WebPushSubscriptionInput,
    platform?: WebPushPlatformInput
  ) => PublicWebPushSubscription | null | Promise<PublicWebPushSubscription | null>;
}

/**
 * Resolved VAPID configuration. Modeled as a discriminated union on `enabled`
 * because that flag IS the proof both keys resolved to non-empty strings (see
 * `resolveWebPushConfig`): every fanout returns early on `!config.enabled`, so
 * the send path only ever sees the enabled arm and can hand `setVapidDetails`
 * real strings without a cast.
 */
export type WebPushConfig =
  | {
      enabled: true;
      privateKey: string;
      publicKey: string;
      subject: string;
      unavailableReason: null;
    }
  | {
      enabled: false;
      privateKey: string | null;
      publicKey: string | null;
      subject: string;
      unavailableReason: string;
    };

/** The `console`-shaped sink each fanout logs transport warnings through. */
interface WebPushLog {
  warn?: (message: string) => void;
}

/** Result of fanning a payload out to every active owner subscription. */
export interface WebPushFanoutResult {
  attempted: number;
  failureReasons?: string[];
  sent: number;
  suppressed?: boolean;
  unavailable: boolean;
}

/**
 * Every fanout returns early when `config.enabled` is false, so a sender is
 * only ever invoked with the enabled arm — which is what makes the VAPID keys
 * statically known-present at the `setVapidDetails` call.
 */
export type EnabledWebPushConfig = Extract<WebPushConfig, { enabled: true }>;

export type WebPushSender = (
  subscription: NormalizedWebPushSubscription,
  payload: unknown,
  config: EnabledWebPushConfig
) => Promise<unknown>;

/**
 * `web-push`'s `sendNotification` surface, as this module drives it. Declared
 * structurally rather than imported so the test seam can pass a wrapped module
 * without depending on the package's own type layout.
 */
interface WebPushModuleApi {
  sendNotification: (
    subscription: NormalizedWebPushSubscription,
    payload: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;
  setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
}

export type GuardWebPushEndpointResult = { agent: HttpsAgent; ok: true } | { ok: false; reason: string };

/** Durable `notification_state` axis recorded on an attention record. */
export interface PushFanoutOutcome {
  reason: string | null;
  state: "failed" | "sent" | "suppressed";
}

/**
 * An `Error` carrying the HTTP-ish status fields this module attaches
 * (`normalizeSubscription`) or reads back off a `web-push` rejection
 * (`shouldRevokeForWebPushError`).
 */
interface WebPushCodedError extends Error {
  code?: string;
  status?: number;
  statusCode?: number;
}

/**
 * Wall-clock bound on a single Web Push send's underlying `https.request`.
 * `web-push` only installs Node's socket-inactivity timeout when the caller
 * supplies this option (`web-push-lib.js`: `httpsOptions.timeout =
 * requestDetails.timeout` only if `options.timeout` was set) — without it, a
 * push endpoint that accepts a connection and then hangs or blackholes it
 * leaves `sendNotification` pending indefinitely: the `finally` block that
 * destroys the pinned agent never runs, and the surrounding fanout
 * `Promise.all` never settles for that subscription. Matches the order of
 * magnitude of the other two guarded callers' bounds (CIMD: 5s, client-event
 * delivery: 10s) — see tmp/workstreams/ssrf-sol-final-0717.md P2.
 */
export const WEB_PUSH_SEND_TIMEOUT_MS = 10_000;

function nowIso(): string {
  return new Date().toISOString();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveWebPushConfig(env: NodeJS.ProcessEnv = process.env): WebPushConfig {
  const publicKey = nonEmptyString(env.PDPP_WEB_PUSH_VAPID_PUBLIC_KEY);
  const privateKey = nonEmptyString(env.PDPP_WEB_PUSH_VAPID_PRIVATE_KEY);
  const subject = nonEmptyString(env.PDPP_WEB_PUSH_VAPID_SUBJECT) || "mailto:pdpp-reference@example.invalid";
  // `publicKey && privateKey` is the same enabled predicate as before; testing
  // the two keys directly (rather than a precomputed boolean) is what lets the
  // compiler carry their non-null-ness into the `enabled: true` arm.
  if (publicKey && privateKey) {
    return {
      enabled: true,
      privateKey,
      publicKey,
      subject,
      unavailableReason: null,
    };
  }
  return {
    enabled: false,
    privateKey: privateKey || null,
    publicKey: publicKey || null,
    subject,
    unavailableReason: "VAPID public/private keys are not configured",
  };
}

function redactEndpoint(endpoint: string | null | undefined): string | null {
  if (!endpoint) {
    return null;
  }
  if (endpoint.length <= 18) {
    return "redacted";
  }
  return `${endpoint.slice(0, 12)}...${endpoint.slice(-6)}`;
}

function normalizeSubscription(input: WebPushSubscriptionInput | null | undefined): NormalizedWebPushSubscription {
  const endpoint = nonEmptyString(input?.endpoint);
  const p256dh = nonEmptyString(input?.keys?.p256dh);
  const auth = nonEmptyString(input?.keys?.auth);
  if (!(endpoint && p256dh && auth)) {
    const err: WebPushCodedError = new Error("Push subscription requires endpoint, keys.p256dh, and keys.auth");
    err.status = 400;
    err.code = "invalid_push_subscription";
    throw err;
  }
  return { endpoint, keys: { auth, p256dh } };
}

function normalizePlatform(input: WebPushPlatformInput = {}): NormalizedWebPushPlatform {
  return {
    device_label: nonEmptyString(input.device_label) || null,
    platform: nonEmptyString(input.platform) || null,
    user_agent: nonEmptyString(input.user_agent) || null,
  };
}

function publicRecord(
  record: WebPushSubscriptionRecord | null | undefined,
  { includeEndpoint = true }: { includeEndpoint?: boolean } = {}
): PublicWebPushSubscription | null {
  if (!record) {
    return null;
  }
  return {
    created_at: record.created_at,
    device_label: record.device_label,
    endpoint: includeEndpoint ? record.endpoint : redactEndpoint(record.endpoint),
    endpoint_redacted: redactEndpoint(record.endpoint),
    id: record.id,
    last_failure_at: record.last_failure_at,
    last_failure_reason: record.last_failure_reason,
    last_success_at: record.last_success_at,
    last_used_at: record.last_used_at,
    owner_subject_id: record.owner_subject_id,
    platform: record.platform,
    revoked_at: record.revoked_at,
    updated_at: record.updated_at,
    user_agent: record.user_agent,
  };
}

function rawSubscriptionRecord(record: WebPushSubscriptionRecord): RawWebPushSubscription {
  return {
    ...record,
    keys: {
      auth: record.auth,
      p256dh: record.p256dh,
    },
  };
}

function buildSubscriptionRecord(
  ownerSubjectId: string,
  subscription: WebPushSubscriptionInput,
  platform: WebPushPlatformInput = {}
): WebPushSubscriptionRecord {
  const normalized = normalizeSubscription(subscription);
  const metadata = normalizePlatform(platform);
  const timestamp = nowIso();
  return {
    auth: normalized.keys.auth,
    created_at: timestamp,
    endpoint: normalized.endpoint,
    id: `wps_${createHash("sha256").update(normalized.endpoint).digest("base64url").slice(0, 32)}`,
    last_failure_at: null,
    last_failure_reason: null,
    last_success_at: null,
    last_used_at: null,
    owner_subject_id: ownerSubjectId,
    p256dh: normalized.keys.p256dh,
    revoked_at: null,
    updated_at: timestamp,
    ...metadata,
  };
}

export function createMemoryWebPushSubscriptionStore(): WebPushSubscriptionStore {
  const byEndpoint = new Map<string, RawWebPushSubscription>();

  return {
    clearForTests() {
      byEndpoint.clear();
    },
    list(
      ownerSubjectId: string,
      { activeOnly = true, includeEndpoint = true }: WebPushListOptions = {}
    ): (PublicWebPushSubscription | null)[] {
      return [...byEndpoint.values()]
        .filter((record) => record.owner_subject_id === ownerSubjectId)
        .filter((record) => !(activeOnly && record.revoked_at))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((record) => publicRecord(record, { includeEndpoint }));
    },
    listActiveRaw(ownerSubjectId: unknown): RawWebPushSubscription[] {
      const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
      if (!normalizedOwnerSubjectId) {
        return [];
      }
      return [...byEndpoint.values()].filter(
        (record) => record.owner_subject_id === normalizedOwnerSubjectId && !record.revoked_at
      );
    },
    markFailure(endpoint: string, reason: string, { revoke = false }: WebPushMarkFailureOptions = {}): void {
      const record = byEndpoint.get(endpoint);
      if (!record) {
        return;
      }
      const timestamp = nowIso();
      record.last_failure_at = timestamp;
      record.last_failure_reason = String(reason || "push_send_failed").slice(0, 240);
      record.last_used_at = timestamp;
      if (revoke && !record.revoked_at) {
        record.revoked_at = timestamp;
      }
      record.updated_at = timestamp;
    },
    markSuccess(endpoint: string): void {
      const record = byEndpoint.get(endpoint);
      if (!record) {
        return;
      }
      const timestamp = nowIso();
      record.last_success_at = timestamp;
      record.last_used_at = timestamp;
      record.last_failure_reason = null;
      record.updated_at = timestamp;
    },
    revoke(ownerSubjectId: string, endpoint: unknown): PublicWebPushSubscription | null {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) {
        return null;
      }
      const existing = byEndpoint.get(normalizedEndpoint);
      if (!existing || existing.owner_subject_id !== ownerSubjectId) {
        return null;
      }
      existing.revoked_at = nowIso();
      existing.updated_at = existing.revoked_at;
      return publicRecord(existing);
    },
    upsert(
      ownerSubjectId: string,
      subscription: WebPushSubscriptionInput,
      platform: WebPushPlatformInput = {}
    ): PublicWebPushSubscription | null {
      const recordInput = buildSubscriptionRecord(ownerSubjectId, subscription, platform);
      const existing = byEndpoint.get(recordInput.endpoint);
      const record = {
        ...recordInput,
        created_at: existing?.created_at || recordInput.created_at,
        id: existing?.id || recordInput.id,
        keys: { auth: recordInput.auth, p256dh: recordInput.p256dh },
        last_failure_at: existing?.last_failure_at || null,
        last_failure_reason: existing?.last_failure_reason || null,
        last_success_at: existing?.last_success_at || null,
        last_used_at: existing?.last_used_at || null,
        revoked_at: null,
      };
      byEndpoint.set(record.endpoint, record);
      return publicRecord(record);
    },
  };
}

export function createSqliteWebPushSubscriptionStore(): WebPushSubscriptionStore {
  function getByEndpoint(endpoint: string): WebPushSubscriptionRecord | null {
    return getOne<WebPushSubscriptionRecord>(referenceQueries.webPushGetByEndpoint, [endpoint]);
  }

  return {
    clearForTests() {
      exec(referenceQueries.webPushDeleteAllForTests, []);
    },
    list(
      ownerSubjectId: string,
      { activeOnly = true, includeEndpoint = true }: WebPushListOptions = {}
    ): (PublicWebPushSubscription | null)[] {
      const query = activeOnly
        ? referenceQueries.webPushListActiveSubscriptions
        : referenceQueries.webPushListSubscriptions;
      return allowUnboundedReadAcknowledged<WebPushSubscriptionRecord>(query, [ownerSubjectId]).map((record) =>
        publicRecord(record, { includeEndpoint })
      );
    },
    listActiveRaw(ownerSubjectId: unknown): RawWebPushSubscription[] {
      const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
      if (!normalizedOwnerSubjectId) {
        return [];
      }
      return allowUnboundedReadAcknowledged<WebPushSubscriptionRecord>(
        referenceQueries.webPushListActiveSubscriptions,
        [normalizedOwnerSubjectId]
      ).map(rawSubscriptionRecord);
    },
    markFailure(endpoint: string, reason: string, { revoke = false }: WebPushMarkFailureOptions = {}): void {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) {
        return;
      }
      const timestamp = nowIso();
      exec(referenceQueries.webPushMarkFailure, [
        timestamp,
        String(reason || "push_send_failed").slice(0, 240),
        timestamp,
        revoke ? timestamp : null,
        timestamp,
        normalizedEndpoint,
      ]);
    },
    markSuccess(endpoint: string): void {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) {
        return;
      }
      const timestamp = nowIso();
      exec(referenceQueries.webPushMarkSuccess, [timestamp, timestamp, timestamp, normalizedEndpoint]);
    },
    revoke(ownerSubjectId: string, endpoint: unknown): PublicWebPushSubscription | null {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) {
        return null;
      }
      const timestamp = nowIso();
      const result = exec(referenceQueries.webPushRevokeSubscription, [
        timestamp,
        timestamp,
        ownerSubjectId,
        normalizedEndpoint,
      ]);
      if (!result.changes) {
        return null;
      }
      return publicRecord(getByEndpoint(normalizedEndpoint));
    },
    upsert(
      ownerSubjectId: string,
      subscription: WebPushSubscriptionInput,
      platform: WebPushPlatformInput = {}
    ): PublicWebPushSubscription | null {
      const record = buildSubscriptionRecord(ownerSubjectId, subscription, platform);
      exec(referenceQueries.webPushUpsertSubscription, [
        record.id,
        record.owner_subject_id,
        record.endpoint,
        record.p256dh,
        record.auth,
        record.created_at,
        record.updated_at,
        record.user_agent,
        record.platform,
        record.device_label,
      ]);
      return publicRecord(getByEndpoint(record.endpoint));
    },
  };
}

export function createPostgresWebPushSubscriptionStore(): WebPushSubscriptionStore {
  async function getByEndpoint(endpoint: string): Promise<WebPushSubscriptionRecord | null> {
    const result = await postgresQuery(
      `SELECT id, owner_subject_id, endpoint, p256dh, auth, created_at, updated_at, revoked_at, last_success_at, last_failure_at, last_failure_reason, last_used_at, user_agent, platform, device_label
       FROM web_push_subscriptions
       WHERE endpoint = $1`,
      [endpoint]
    );
    return (result.rows[0] as WebPushSubscriptionRecord | undefined) || null;
  }

  return {
    async clearForTests(): Promise<void> {
      await postgresQuery("DELETE FROM web_push_subscriptions");
    },
    async list(
      ownerSubjectId: string,
      { activeOnly = true, includeEndpoint = true }: WebPushListOptions = {}
    ): Promise<(PublicWebPushSubscription | null)[]> {
      const result = await postgresQuery<WebPushSubscriptionRecord>(
        `SELECT id, owner_subject_id, endpoint, p256dh, auth, created_at, updated_at, revoked_at, last_success_at, last_failure_at, last_failure_reason, last_used_at, user_agent, platform, device_label
         FROM web_push_subscriptions
         WHERE owner_subject_id = $1
           AND ($2::boolean = FALSE OR revoked_at IS NULL)
         ORDER BY updated_at DESC, id ASC`,
        [ownerSubjectId, Boolean(activeOnly)]
      );
      return result.rows.map((record: WebPushSubscriptionRecord) => publicRecord(record, { includeEndpoint }));
    },
    async listActiveRaw(ownerSubjectId: unknown): Promise<RawWebPushSubscription[]> {
      const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
      if (!normalizedOwnerSubjectId) {
        return [];
      }
      const result = await postgresQuery<WebPushSubscriptionRecord>(
        `SELECT id, owner_subject_id, endpoint, p256dh, auth, created_at, updated_at, revoked_at, last_success_at, last_failure_at, last_failure_reason, last_used_at, user_agent, platform, device_label
         FROM web_push_subscriptions
         WHERE owner_subject_id = $1
           AND revoked_at IS NULL
         ORDER BY updated_at DESC, id ASC`,
        [normalizedOwnerSubjectId]
      );
      return result.rows.map((record: WebPushSubscriptionRecord) => rawSubscriptionRecord(record));
    },
    async markFailure(
      endpoint: string,
      reason: string,
      { revoke = false }: WebPushMarkFailureOptions = {}
    ): Promise<void> {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) {
        return;
      }
      const timestamp = nowIso();
      await postgresQuery(
        `UPDATE web_push_subscriptions
         SET last_failure_at = $1,
             last_failure_reason = $2,
             last_used_at = $3,
             revoked_at = COALESCE($4, revoked_at),
             updated_at = $5
         WHERE endpoint = $6`,
        [
          timestamp,
          String(reason || "push_send_failed").slice(0, 240),
          timestamp,
          revoke ? timestamp : null,
          timestamp,
          normalizedEndpoint,
        ]
      );
    },
    async markSuccess(endpoint: string): Promise<void> {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) {
        return;
      }
      const timestamp = nowIso();
      await postgresQuery(
        `UPDATE web_push_subscriptions
         SET last_success_at = $1,
             last_used_at = $2,
             last_failure_reason = NULL,
             updated_at = $3
         WHERE endpoint = $4`,
        [timestamp, timestamp, timestamp, normalizedEndpoint]
      );
    },
    async revoke(ownerSubjectId: string, endpoint: unknown): Promise<PublicWebPushSubscription | null> {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) {
        return null;
      }
      const timestamp = nowIso();
      const result = await postgresQuery(
        `UPDATE web_push_subscriptions
         SET revoked_at = $1, updated_at = $2
         WHERE owner_subject_id = $3
           AND endpoint = $4`,
        [timestamp, timestamp, ownerSubjectId, normalizedEndpoint]
      );
      if (!result.rowCount) {
        return null;
      }
      return publicRecord(await getByEndpoint(normalizedEndpoint));
    },
    async upsert(
      ownerSubjectId: string,
      subscription: WebPushSubscriptionInput,
      platform: WebPushPlatformInput = {}
    ): Promise<PublicWebPushSubscription | null> {
      const record = buildSubscriptionRecord(ownerSubjectId, subscription, platform);
      await postgresQuery(
        `INSERT INTO web_push_subscriptions(
           id, owner_subject_id, endpoint, p256dh, auth, created_at, updated_at, revoked_at,
           user_agent, platform, device_label
         ) VALUES($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10)
         ON CONFLICT(endpoint) DO UPDATE SET
           owner_subject_id = EXCLUDED.owner_subject_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           updated_at = EXCLUDED.updated_at,
           revoked_at = NULL,
           user_agent = EXCLUDED.user_agent,
           platform = EXCLUDED.platform,
           device_label = EXCLUDED.device_label`,
        [
          record.id,
          record.owner_subject_id,
          record.endpoint,
          record.p256dh,
          record.auth,
          record.created_at,
          record.updated_at,
          record.user_agent,
          record.platform,
          record.device_label,
        ]
      );
      return publicRecord(await getByEndpoint(record.endpoint));
    },
  };
}

export function createWebPushSubscriptionStore(): WebPushSubscriptionStore {
  return isPostgresStorageBackend() ? createPostgresWebPushSubscriptionStore() : createSqliteWebPushSubscriptionStore();
}

let defaultWebPushSubscriptionStore: WebPushSubscriptionStore | null = null;
let defaultWebPushSubscriptionStoreBackend: string | null = null;

export function getDefaultWebPushSubscriptionStore(): WebPushSubscriptionStore {
  const backend = getStorageBackendKind();
  if (!defaultWebPushSubscriptionStore || defaultWebPushSubscriptionStoreBackend !== backend) {
    defaultWebPushSubscriptionStore = createWebPushSubscriptionStore();
    defaultWebPushSubscriptionStoreBackend = backend;
  }
  return defaultWebPushSubscriptionStore;
}

export function buildTestPushPayload({ now = nowIso() }: { now?: string } = {}) {
  return {
    body: "Your dashboard browser can receive Web Push alerts.",
    timestamp: now,
    title: "PDPP test notification",
    type: "pdpp.test_notification",
    url: "/",
  };
}

// Lock-screen safety classifier. The runtime treats interaction *kinds* as the
// authority on what may appear in a push body — the connector-supplied
// `message`/`schema`/`data` fields are never trusted on a lock screen.
//
//   - `secret`: the owner is about to type or paste a sensitive value
//     (OTP, credentials). The push body must stay maximally generic.
//   - `external`: the owner has to act somewhere else (manual browser
//     verification, approve a provider prompt). The body says so without
//     echoing connector copy.
//   - `informational`: a benign owner-action prompt (e.g. confirm a step
//     in the dashboard). Still no connector copy.
//
// Anything unknown is treated as `secret` — the safe default.
export type InteractionSensitivity = "external" | "informational" | "secret";

const INTERACTION_KIND_SENSITIVITY: Readonly<Record<string, InteractionSensitivity>> = Object.freeze({
  credentials: "secret",
  manual_action: "external",
  otp: "secret",
});

export function classifyInteractionSensitivity(kind: unknown): InteractionSensitivity {
  if (typeof kind !== "string" || kind.length === 0) {
    return "secret";
  }
  return INTERACTION_KIND_SENSITIVITY[kind] || "secret";
}

function interactionPushBody(sensitivity: InteractionSensitivity): string {
  switch (sensitivity) {
    case "external":
      return "A connector needs you to take an action.";
    case "informational":
      return "A connector run is waiting for owner action.";
    default:
      return "A connector needs owner input.";
  }
}

/**
 * The connector-emitted INTERACTION fields this module reads. The index
 * signature is load-bearing rather than lax: a real INTERACTION also carries
 * `message`/`schema`/`data`, and the lock-screen safety rule is that this
 * module must never read them. Admitting them as `unknown` keeps callers
 * passing whole envelopes honest while leaving the untrusted copy untyped.
 */
export interface PendingInteractionInput {
  kind?: unknown;
  request_id?: unknown;
  [key: string]: unknown;
}

export type PushRouteTo = "interaction" | "run";

export interface BuildPendingInteractionPushPayloadArgs {
  connectorDisplayName: string;
  interaction: PendingInteractionInput | null | undefined;
  routeTo?: PushRouteTo;
  runId: string;
}

export function buildPendingInteractionPushPayload({
  interaction,
  connectorDisplayName,
  routeTo = "interaction",
  runId,
}: BuildPendingInteractionPushPayloadArgs) {
  const kind = typeof interaction?.kind === "string" ? interaction.kind : "interaction";
  const interactionId = typeof interaction?.request_id === "string" ? interaction.request_id : "";
  const encodedRunId = encodeURIComponent(runId);
  const encodedInteractionId = encodeURIComponent(interactionId);
  const url =
    routeTo === "interaction" && kind === "manual_action"
      ? `/syncs/${encodedRunId}/stream?interaction_id=${encodedInteractionId}`
      : `/syncs/${encodedRunId}`;
  const sensitivity = classifyInteractionSensitivity(kind);
  // Freeze the payload shape so a future contributor cannot accidentally
  // attach connector-supplied free text (`interaction.message`, `.schema`,
  // `.data`) by spreading the interaction object in.
  return Object.freeze({
    body: interactionPushBody(sensitivity),
    connector_display_name: connectorDisplayName,
    interaction_id: interactionId,
    interaction_kind: kind,
    interaction_sensitivity: sensitivity,
    run_id: runId,
    timestamp: nowIso(),
    title: `PDPP ${connectorDisplayName}: action needed`,
    type: "pdpp.pending_interaction",
    url,
  });
}

// Predicate: should this connector progress message trigger a nonblocking
// owner-assistance Web Push? We only fan out for ASSISTANCE messages that
// actually require owner attention but expect no PDPP response (e.g. "approve
// the ChatGPT push in your phone app"). Blocking INTERACTION messages route
// through the existing brokerInteraction path.
export function shouldFanoutAssistanceProgress(
  message: { response_contract?: unknown; type?: unknown; [key: string]: unknown } | null | undefined
): boolean {
  if (message?.type !== "ASSISTANCE") {
    return false;
  }
  if (message.response_contract !== "none") {
    return false;
  }
  return classifyAssistanceNotification(message) === NOTIFICATION_TIERS.ACTION_REQUIRED;
}

/**
 * The connector-emitted ASSISTANCE fields this module reads. As with
 * `PendingInteractionInput`, the remaining envelope fields (`message`,
 * `data`, …) are admitted as `unknown` precisely because the push body must
 * never echo them.
 */
export interface AssistancePushInput {
  assistance_request_id?: unknown;
  owner_action?: unknown;
  [key: string]: unknown;
}

export interface BuildAssistancePushPayloadArgs {
  assistance: AssistancePushInput | null | undefined;
  connectorDisplayName: string;
  runId: string;
}

export function buildAssistancePushPayload({
  assistance,
  connectorDisplayName,
  runId,
}: BuildAssistancePushPayloadArgs) {
  const assistanceRequestId =
    typeof assistance?.assistance_request_id === "string" ? assistance.assistance_request_id : "";
  // Routing: assistance work happens outside PDPP, so we always send the
  // owner to the durable run page rather than a transient interaction stream.
  // Body copy is intentionally generic — assistance.message can carry
  // connector-supplied free text that we MUST NOT echo on a lock screen.
  // The payload is frozen so a future contributor cannot accidentally spread
  // the assistance object in and pipe `.message`/`.data` through.
  return Object.freeze({
    assistance_request_id: assistanceRequestId,
    body: "A connector needs you to act in another app.",
    connector_display_name: connectorDisplayName,
    notification_tier: NOTIFICATION_TIERS.ACTION_REQUIRED,
    owner_action: typeof assistance?.owner_action === "string" ? assistance.owner_action : null,
    response_contract: "none",
    run_id: runId,
    timestamp: nowIso(),
    title: `PDPP ${connectorDisplayName}: action needed`,
    type: "pdpp.assistance_requested",
    url: `/syncs/${encodeURIComponent(runId)}`,
  });
}

function shouldRevokeForWebPushError(err: unknown): boolean {
  const coded = err as WebPushCodedError | null | undefined;
  const status = Number(coded?.statusCode || coded?.status);
  return status === 404 || status === 410;
}

export function resolveWebPushModuleApi(webPushModule: unknown): WebPushModuleApi {
  return ((webPushModule as { default?: unknown } | null | undefined)?.default ?? webPushModule) as WebPushModuleApi;
}

/**
 * SSRF guard for the owner-supplied Web Push `endpoint`. Unlike the CIMD and
 * client-event-delivery guards, this one does NOT sit in front of a `fetch`
 * this module controls — `web-push`'s `sendNotification` builds and issues
 * the `https.request` itself, internally, from `subscription.endpoint`. The
 * library does accept a caller-supplied `agent` option (validated with
 * `instanceof https.Agent`), which is the only integration point available
 * without forking VAPID-header/body-encryption logic that must stay correct.
 * So this function resolves and validates the endpoint's host exactly like
 * the other two guards, then returns a `node:https.Agent` pinned to the
 * validated address(es) (`ssrf-guard.js`'s `createPinnedHttpsAgent`) for the
 * caller to pass through `options.agent` — send-time address binding at the
 * actual socket, not a pre-resolve-then-let-the-library-re-resolve check.
 *
 * Returns `{ ok: true, agent }` (agent to close after the send completes) or
 * `{ ok: false, reason }` when the endpoint must not be sent to.
 */
export async function guardWebPushEndpoint(
  endpoint: string,
  {
    dnsLookupImpl,
    isGlobalUnicastAddressImpl,
  }: {
    dnsLookupImpl?: DnsLookupAll;
    isGlobalUnicastAddressImpl?: (ip: string) => boolean;
  } = {}
): Promise<GuardWebPushEndpointResult> {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, reason: "endpoint is not a valid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "endpoint must use https scheme" };
  }
  // Spread each seam only when supplied: under `exactOptionalPropertyTypes` an
  // explicit `undefined` is not the same as an absent optional property, and
  // the guard's contract is "omitted means use the real DNS resolver".
  const resolved = await resolveAllowedAddresses(parsed.hostname, {
    ...(dnsLookupImpl ? { dnsLookupImpl } : {}),
    ...(isGlobalUnicastAddressImpl ? { isGlobalUnicastAddressImpl } : {}),
  });
  if (!resolved.ok) {
    switch (resolved.kind) {
      case "dns_failed":
        return { ok: false, reason: `DNS resolution failed for ${parsed.hostname}` };
      case "no_addresses":
        return { ok: false, reason: `DNS resolution returned no addresses for ${parsed.hostname}` };
      case "too_many_addresses":
        return {
          ok: false,
          reason: `endpoint host ${parsed.hostname} resolved to ${resolved.count} addresses, exceeding the bound of ${resolved.max}`,
        };
      case "forbidden_address":
        return {
          ok: false,
          reason: `endpoint host ${parsed.hostname} resolves to a non-public address ${resolved.address}`,
        };
    }
  }
  return { agent: createPinnedHttpsAgent(resolved.addresses), ok: true };
}

/**
 * `deps` is a test-only seam (production callers — `sendPayloadToOwnerSubscriptions`
 * — always call `sender(subscription, payload, config)`, exactly 3 positional
 * args, so this parameter is always undefined/defaulted in production).
 * `guardWebPushEndpointImpl` lets a test inject `dnsLookupImpl`/
 * `isGlobalUnicastAddressImpl` into the guard without real DNS, and
 * `webPushModuleImpl` lets a test point at a differently-configured `web-push`
 * import (used only to swap in a wrapped module for observing the exact
 * options `defaultSendNotification` forwards — the wrapped module still
 * calls through to the real `web-push` for VAPID/encryption, so it proves
 * production behavior, not a mock's behavior).
 */
export async function defaultSendNotification(
  subscription: NormalizedWebPushSubscription,
  payload: unknown,
  config: EnabledWebPushConfig,
  {
    guardWebPushEndpointImpl = guardWebPushEndpoint,
    webPushModuleImpl,
  }: {
    guardWebPushEndpointImpl?: (endpoint: string) => Promise<GuardWebPushEndpointResult>;
    webPushModuleImpl?: unknown;
  } = {}
): Promise<unknown> {
  const guard = await guardWebPushEndpointImpl(subscription.endpoint);
  if (!guard.ok) {
    const err: WebPushCodedError = new Error(`Web Push send blocked: ${guard.reason}`);
    err.code = "web_push_send_blocked";
    throw err;
  }
  const webPushPackageName = "web-push";
  const webPushModule = webPushModuleImpl ?? (await import(webPushPackageName));
  const webPush = resolveWebPushModuleApi(webPushModule);
  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  try {
    // `web-push` builds VAPID headers and the encrypted body itself from
    // `subscription`/`payload`/these options — unchanged from before this
    // guard. `agent` and `timeout` are the only additions: neither alters
    // protocol correctness. `agent` pins which literal address the library's
    // own `https.request` call (which we do not otherwise touch) is allowed
    // to dial. `timeout` bounds how long that request can stay open — without
    // it, an endpoint that accepts a connection and then hangs leaves this
    // call pending forever (see WEB_PUSH_SEND_TIMEOUT_MS above). On timeout,
    // `web-push` destroys its own request socket and this promise rejects,
    // which the `finally` below observes like any other outcome. `web-push`
    // never follows redirects (any non-2xx status, including 3xx, is
    // rejected as an "unexpected response code" — see web-push-lib.js's
    // `sendNotification`), so no separate redirect guard is needed here.
    return await webPush.sendNotification(subscription, JSON.stringify(payload), {
      agent: guard.agent,
      contentEncoding: "aes128gcm",
      TTL: DEFAULT_TTL_SECONDS,
      timeout: WEB_PUSH_SEND_TIMEOUT_MS,
    });
  } finally {
    // Runs on success, error, AND timeout (a timeout rejects the promise via
    // web-push's own request.destroy()/'error' handling) — fire-and-forget,
    // pool teardown is not itself a send outcome.
    guard.agent.destroy();
  }
}

interface SendPayloadToOwnerSubscriptionsArgs {
  config: EnabledWebPushConfig;
  log: WebPushLog;
  logContext: string;
  ownerSubjectId: string;
  payload: unknown;
  sender: WebPushSender;
  store: WebPushSubscriptionStore;
}

async function sendPayloadToOwnerSubscriptions({
  config,
  store,
  sender,
  ownerSubjectId,
  payload,
  log,
  logContext,
}: SendPayloadToOwnerSubscriptionsArgs): Promise<WebPushFanoutResult> {
  const subscriptions = await store.listActiveRaw(ownerSubjectId);
  let sent = 0;
  const failures: string[] = [];
  await Promise.all(
    subscriptions.map(async (record) => {
      try {
        await sender({ endpoint: record.endpoint, keys: record.keys }, payload, config);
        await store.markSuccess(record.endpoint);
        sent += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push(reason);
        await store.markFailure(record.endpoint, reason, { revoke: shouldRevokeForWebPushError(err) });
        log.warn?.(`[controller] web push ${logContext} failed: ${reason}`);
      }
    })
  );
  return { attempted: subscriptions.length, failureReasons: failures, sent, unavailable: false };
}

/**
 * Map a push-fanout result onto the durable `notification_state` axis on
 * an attention record. The spec contract requires the operator console
 * to be able to answer "did we tell the owner?" without rereading
 * transport logs.
 *
 *   - `attempted === 0 && unavailable`            → no channel configured. Record `suppressed`.
 *   - `attempted === 0 && suppressed`             → policy suppression (quiet hours, etc.). Record `suppressed`.
 *   - `attempted === 0`                           → no opted-in subscriptions. Record `suppressed`.
 *   - `sent > 0`                                  → at least one delivery accepted. Record `sent`.
 *   - `attempted > 0 && sent === 0`               → every subscription rejected. Record `failed`.
 */
/**
 * Accepts `unknown` rather than `WebPushFanoutResult` because the
 * `typeof result !== 'object'` branch below is a real, tested guard: callers
 * upstream of a transport failure can hand this a non-object, and it must
 * classify as `failed`/`no_result` instead of throwing.
 */
export function classifyPushFanoutOutcome(result: unknown): PushFanoutOutcome {
  if (!result || typeof result !== "object") {
    return { reason: "no_result", state: "failed" };
  }
  const fanout = result as Partial<WebPushFanoutResult>;
  if (fanout.unavailable) {
    return { reason: "channel_unavailable", state: "suppressed" };
  }
  if (fanout.suppressed) {
    return { reason: "policy_suppressed", state: "suppressed" };
  }
  const attempted = Number(fanout.attempted || 0);
  const sent = Number(fanout.sent || 0);
  if (attempted === 0) {
    return { reason: "no_opted_in_channel", state: "suppressed" };
  }
  if (sent > 0) {
    return { reason: null, state: "sent" };
  }
  const failures = Array.isArray(fanout.failureReasons) ? fanout.failureReasons.filter(Boolean) : [];
  const [top] = failures;
  return { reason: top ? `transport: ${top.slice(0, 120)}` : "transport_failed", state: "failed" };
}

/**
 * Optional durable-attention recorder. When provided, the fanout classifies
 * its delivery result into a `notification_state` and invokes the callback so
 * the operator console can render "we notified the owner" vs "delivery failed"
 * without rereading transport logs. Callback failure is logged but never
 * propagated: failing to record the outcome must not break notification fanout.
 */
export type RecordPushOutcome = (outcome: PushFanoutOutcome) => Promise<void>;

export interface FanoutPendingInteractionWebPushArgs {
  config?: WebPushConfig;
  connectorDisplayName: string;
  interaction: PendingInteractionInput | null | undefined;
  log?: WebPushLog;
  ownerSubjectId: unknown;
  recordOutcome?: RecordPushOutcome | null;
  routeTo?: PushRouteTo;
  runId: string;
  sender?: WebPushSender;
  store?: WebPushSubscriptionStore;
}

export async function fanoutPendingInteractionWebPush({
  config = resolveWebPushConfig(),
  store = getDefaultWebPushSubscriptionStore(),
  sender = defaultSendNotification,
  interaction,
  connectorDisplayName,
  ownerSubjectId,
  routeTo = "interaction",
  runId,
  log = console,
  recordOutcome = null,
}: FanoutPendingInteractionWebPushArgs): Promise<WebPushFanoutResult> {
  const result = await fanoutPendingInteractionWebPushImpl({
    config,
    connectorDisplayName,
    interaction,
    log,
    ownerSubjectId,
    routeTo,
    runId,
    sender,
    store,
  });
  if (typeof recordOutcome === "function") {
    const classified = classifyPushFanoutOutcome(result);
    try {
      await recordOutcome(classified);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] web push outcome recorder for run ${runId} failed: ${message}`);
    }
  }
  return result;
}

async function fanoutPendingInteractionWebPushImpl({
  config,
  store,
  sender,
  interaction,
  connectorDisplayName,
  ownerSubjectId,
  routeTo,
  runId,
  log,
}: Required<Pick<FanoutPendingInteractionWebPushArgs, "config" | "store" | "sender" | "routeTo" | "log">> &
  Pick<
    FanoutPendingInteractionWebPushArgs,
    "interaction" | "connectorDisplayName" | "ownerSubjectId" | "runId"
  >): Promise<WebPushFanoutResult> {
  await Promise.resolve();
  if (!config.enabled) {
    return { attempted: 0, sent: 0, unavailable: true };
  }
  const delivery = projectNotificationDelivery({
    channelOptedIn: true,
    tier: NOTIFICATION_TIERS.ACTION_REQUIRED,
  });
  if (!delivery.interruptive_eligible) {
    return { attempted: 0, sent: 0, suppressed: true, unavailable: false };
  }
  const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
  if (!normalizedOwnerSubjectId) {
    log.warn?.(`[controller] web push for run ${runId} skipped: missing owner subject`);
    return { attempted: 0, sent: 0, unavailable: false };
  }
  const payload = buildPendingInteractionPushPayload({ connectorDisplayName, interaction, routeTo, runId });
  return sendPayloadToOwnerSubscriptions({
    config,
    log,
    logContext: `for run ${runId}`,
    ownerSubjectId: normalizedOwnerSubjectId,
    payload,
    sender,
    store,
  });
}

export interface FanoutAssistanceWebPushArgs {
  assistance: AssistancePushInput | null | undefined;
  config?: WebPushConfig;
  connectorDisplayName: string;
  log?: WebPushLog;
  ownerSubjectId: unknown;
  recordOutcome?: RecordPushOutcome | null;
  runId: string;
  sender?: WebPushSender;
  store?: WebPushSubscriptionStore;
}

export async function fanoutAssistanceWebPush({
  config = resolveWebPushConfig(),
  store = getDefaultWebPushSubscriptionStore(),
  sender = defaultSendNotification,
  assistance,
  connectorDisplayName,
  ownerSubjectId,
  runId,
  log = console,
  recordOutcome = null,
}: FanoutAssistanceWebPushArgs): Promise<WebPushFanoutResult> {
  const result = await fanoutAssistanceWebPushImpl({
    assistance,
    config,
    connectorDisplayName,
    log,
    ownerSubjectId,
    runId,
    sender,
    store,
  });
  if (typeof recordOutcome === "function") {
    const classified = classifyPushFanoutOutcome(result);
    try {
      await recordOutcome(classified);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] web push assistance outcome recorder for run ${runId} failed: ${message}`);
    }
  }
  return result;
}

async function fanoutAssistanceWebPushImpl({
  config,
  store,
  sender,
  assistance,
  connectorDisplayName,
  ownerSubjectId,
  runId,
  log,
}: Required<Pick<FanoutAssistanceWebPushArgs, "config" | "store" | "sender" | "log">> &
  Pick<
    FanoutAssistanceWebPushArgs,
    "assistance" | "connectorDisplayName" | "ownerSubjectId" | "runId"
  >): Promise<WebPushFanoutResult> {
  await Promise.resolve();
  if (!config.enabled) {
    return { attempted: 0, sent: 0, unavailable: true };
  }
  const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
  if (!normalizedOwnerSubjectId) {
    log.warn?.(`[controller] web push assistance for run ${runId} skipped: missing owner subject`);
    return { attempted: 0, sent: 0, unavailable: false };
  }
  const payload = buildAssistancePushPayload({ assistance, connectorDisplayName, runId });
  return sendPayloadToOwnerSubscriptions({
    config,
    log,
    logContext: `assistance for run ${runId}`,
    ownerSubjectId: normalizedOwnerSubjectId,
    payload,
    sender,
    store,
  });
}

export interface FanoutTestWebPushArgs {
  config?: WebPushConfig;
  log?: WebPushLog;
  ownerSubjectId: unknown;
  sender?: WebPushSender;
  store?: WebPushSubscriptionStore;
}

export async function fanoutTestWebPush({
  config = resolveWebPushConfig(),
  store = getDefaultWebPushSubscriptionStore(),
  sender = defaultSendNotification,
  ownerSubjectId,
  log = console,
}: FanoutTestWebPushArgs): Promise<WebPushFanoutResult> {
  await Promise.resolve();
  if (!config.enabled) {
    return { attempted: 0, sent: 0, unavailable: true };
  }
  const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
  if (!normalizedOwnerSubjectId) {
    return { attempted: 0, sent: 0, unavailable: false };
  }
  const payload = buildTestPushPayload();
  return sendPayloadToOwnerSubscriptions({
    config,
    log,
    logContext: `test notification for ${normalizedOwnerSubjectId}`,
    ownerSubjectId: normalizedOwnerSubjectId,
    payload,
    sender,
    store,
  });
}

// ─── §10-F: Human-required-state escalation push ─────────────────────────────
//
// Emitted ONCE per transition into a human-required state (blocked or
// needs_attention). Hands-off is silent-until-it-isn't; this is the
// "then loud exactly once" path (spec §10-F).
//
// Lock-screen safety: body is hardcoded copy — never connector-supplied
// free text. The connector display name appears only in the title, which
// the service worker renders in a non-secret context.

export type EscalationReason = "blocked" | "needs_attention";

export interface BuildEscalationPushPayloadArgs {
  connectionUrl?: string;
  connectorDisplayName: string;
  reason: EscalationReason;
}

export function buildEscalationPushPayload({
  connectorDisplayName,
  reason,
  connectionUrl,
}: BuildEscalationPushPayloadArgs) {
  // Body copy is deliberately generic and reason-independent: whatever
  // caused the escalation (blocked credentials, repeated failures,
  // dead-but-429ing provider), the only actionable message is "check the
  // dashboard". Connector-specific copy must NOT appear in the body because
  // push bodies are visible on lock screens before the owner authenticates.
  const body = "Your attention is required to continue syncing.";
  const title = `PDPP ${connectorDisplayName}: action needed`;
  return Object.freeze({
    body,
    connector_display_name: connectorDisplayName,
    escalation_reason: reason,
    timestamp: nowIso(),
    title,
    type: "pdpp.escalation",
    url: connectionUrl || "/",
  });
}

/**
 * Structural mirror of `notification-policy.ts`'s own (unexported)
 * `RenderedVerdict`: the gate only reads `channel` and `required_actions`.
 */
export type EscalationRenderedVerdict = {
  channel?: string;
  required_actions?: Array<{ audience?: string; satisfied_when?: { kind?: string } }>;
} | null;

export interface FanoutEscalationWebPushArgs {
  config?: WebPushConfig;
  connectionUrl?: string;
  connectorDisplayName: string;
  log?: WebPushLog;
  ownerSubjectId: unknown;
  reason: EscalationReason;
  renderedVerdict?: EscalationRenderedVerdict;
  sender?: WebPushSender;
  store?: WebPushSubscriptionStore;
}

/**
 * Fan out a deduplicated "human required" escalation push to all active
 * subscriptions for the owner. Parallel to fanoutPendingInteractionWebPush
 * but for cross-run governance escalations (blocked/needs_attention) rather
 * than in-run interaction prompts.
 */
export async function fanoutEscalationWebPush({
  config = resolveWebPushConfig(),
  store = getDefaultWebPushSubscriptionStore(),
  sender = defaultSendNotification,
  connectorDisplayName,
  ownerSubjectId,
  reason,
  connectionUrl = "/",
  renderedVerdict,
  log = console,
}: FanoutEscalationWebPushArgs): Promise<WebPushFanoutResult> {
  await Promise.resolve();
  if (!config.enabled) {
    return { attempted: 0, sent: 0, unavailable: true };
  }
  if (renderedVerdict !== undefined && !shouldFanoutRenderedVerdict(renderedVerdict)) {
    return { attempted: 0, sent: 0, suppressed: true, unavailable: false };
  }
  const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
  if (!normalizedOwnerSubjectId) {
    log.warn?.(`[controller] escalation push skipped: missing owner subject (reason=${reason})`);
    return { attempted: 0, sent: 0, unavailable: false };
  }
  const payload = buildEscalationPushPayload({ connectionUrl, connectorDisplayName, reason });
  return sendPayloadToOwnerSubscriptions({
    config,
    log,
    logContext: `escalation (${reason}) for ${normalizedOwnerSubjectId}`,
    ownerSubjectId: normalizedOwnerSubjectId,
    payload,
    sender,
    store,
  });
}
