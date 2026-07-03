import { createHash } from 'node:crypto';

import { allowUnboundedReadAcknowledged, exec, getOne, referenceQueries } from '../lib/db.ts';
import {
  NOTIFICATION_TIERS,
  classifyAssistanceNotification,
  projectNotificationDelivery,
  shouldFanoutRenderedVerdict,
} from './notification-policy.js';
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from './postgres-storage.js';

const DEFAULT_TTL_SECONDS = 10 * 60;

function nowIso() {
  return new Date().toISOString();
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveWebPushConfig(env = process.env) {
  const publicKey = nonEmptyString(env.PDPP_WEB_PUSH_VAPID_PUBLIC_KEY);
  const privateKey = nonEmptyString(env.PDPP_WEB_PUSH_VAPID_PRIVATE_KEY);
  const subject = nonEmptyString(env.PDPP_WEB_PUSH_VAPID_SUBJECT) || 'mailto:pdpp-reference@example.invalid';
  const enabled = Boolean(publicKey && privateKey);
  return {
    enabled,
    publicKey: publicKey || null,
    privateKey: privateKey || null,
    subject,
    unavailableReason: enabled ? null : 'VAPID public/private keys are not configured',
  };
}

function redactEndpoint(endpoint) {
  if (!endpoint) return null;
  if (endpoint.length <= 18) return 'redacted';
  return `${endpoint.slice(0, 12)}...${endpoint.slice(-6)}`;
}

function normalizeSubscription(input) {
  const endpoint = nonEmptyString(input?.endpoint);
  const p256dh = nonEmptyString(input?.keys?.p256dh);
  const auth = nonEmptyString(input?.keys?.auth);
  if (!endpoint || !p256dh || !auth) {
    const err = new Error('Push subscription requires endpoint, keys.p256dh, and keys.auth');
    err.status = 400;
    err.code = 'invalid_push_subscription';
    throw err;
  }
  return { endpoint, keys: { p256dh, auth } };
}

function normalizePlatform(input = {}) {
  return {
    user_agent: nonEmptyString(input.user_agent) || null,
    platform: nonEmptyString(input.platform) || null,
    device_label: nonEmptyString(input.device_label) || null,
  };
}

function publicRecord(record, { includeEndpoint = true } = {}) {
  if (!record) return null;
  return {
    id: record.id,
    owner_subject_id: record.owner_subject_id,
    endpoint: includeEndpoint ? record.endpoint : redactEndpoint(record.endpoint),
    endpoint_redacted: redactEndpoint(record.endpoint),
    created_at: record.created_at,
    updated_at: record.updated_at,
    revoked_at: record.revoked_at,
    last_success_at: record.last_success_at,
    last_failure_at: record.last_failure_at,
    last_failure_reason: record.last_failure_reason,
    last_used_at: record.last_used_at,
    user_agent: record.user_agent,
    platform: record.platform,
    device_label: record.device_label,
  };
}

function rawSubscriptionRecord(record) {
  if (!record) return null;
  return {
    ...record,
    keys: {
      p256dh: record.p256dh,
      auth: record.auth,
    },
  };
}

function buildSubscriptionRecord(ownerSubjectId, subscription, platform = {}) {
  const normalized = normalizeSubscription(subscription);
  const metadata = normalizePlatform(platform);
  const timestamp = nowIso();
  return {
    id: `wps_${createHash('sha256').update(normalized.endpoint).digest('base64url').slice(0, 32)}`,
    owner_subject_id: ownerSubjectId,
    endpoint: normalized.endpoint,
    p256dh: normalized.keys.p256dh,
    auth: normalized.keys.auth,
    created_at: timestamp,
    updated_at: timestamp,
    revoked_at: null,
    last_success_at: null,
    last_failure_at: null,
    last_failure_reason: null,
    last_used_at: null,
    ...metadata,
  };
}

export function createMemoryWebPushSubscriptionStore() {
  const byEndpoint = new Map();

  return {
    upsert(ownerSubjectId, subscription, platform = {}) {
      const recordInput = buildSubscriptionRecord(ownerSubjectId, subscription, platform);
      const existing = byEndpoint.get(recordInput.endpoint);
      const record = {
        ...recordInput,
        id: existing?.id || recordInput.id,
        keys: { p256dh: recordInput.p256dh, auth: recordInput.auth },
        created_at: existing?.created_at || recordInput.created_at,
        revoked_at: null,
        last_success_at: existing?.last_success_at || null,
        last_failure_at: existing?.last_failure_at || null,
        last_failure_reason: existing?.last_failure_reason || null,
        last_used_at: existing?.last_used_at || null,
      };
      byEndpoint.set(record.endpoint, record);
      return publicRecord(record);
    },
    list(ownerSubjectId, { activeOnly = true, includeEndpoint = true } = {}) {
      return [...byEndpoint.values()]
        .filter((record) => record.owner_subject_id === ownerSubjectId)
        .filter((record) => !activeOnly || !record.revoked_at)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((record) => publicRecord(record, { includeEndpoint }));
    },
    listActiveRaw(ownerSubjectId) {
      const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
      if (!normalizedOwnerSubjectId) return [];
      return [...byEndpoint.values()].filter(
        (record) => record.owner_subject_id === normalizedOwnerSubjectId && !record.revoked_at,
      );
    },
    revoke(ownerSubjectId, endpoint) {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) return null;
      const existing = byEndpoint.get(normalizedEndpoint);
      if (!existing || existing.owner_subject_id !== ownerSubjectId) return null;
      existing.revoked_at = nowIso();
      existing.updated_at = existing.revoked_at;
      return publicRecord(existing);
    },
    markSuccess(endpoint) {
      const record = byEndpoint.get(endpoint);
      if (!record) return;
      const timestamp = nowIso();
      record.last_success_at = timestamp;
      record.last_used_at = timestamp;
      record.last_failure_reason = null;
      record.updated_at = timestamp;
    },
    markFailure(endpoint, reason, { revoke = false } = {}) {
      const record = byEndpoint.get(endpoint);
      if (!record) return;
      const timestamp = nowIso();
      record.last_failure_at = timestamp;
      record.last_failure_reason = String(reason || 'push_send_failed').slice(0, 240);
      record.last_used_at = timestamp;
      if (revoke && !record.revoked_at) {
        record.revoked_at = timestamp;
      }
      record.updated_at = timestamp;
    },
    clearForTests() {
      byEndpoint.clear();
    },
  };
}

export function createSqliteWebPushSubscriptionStore() {
  function getByEndpoint(endpoint) {
    return getOne(referenceQueries.webPushGetByEndpoint, [endpoint]);
  }

  return {
    upsert(ownerSubjectId, subscription, platform = {}) {
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
    list(ownerSubjectId, { activeOnly = true, includeEndpoint = true } = {}) {
      const query = activeOnly ? referenceQueries.webPushListActiveSubscriptions : referenceQueries.webPushListSubscriptions;
      return allowUnboundedReadAcknowledged(query, [ownerSubjectId]).map((record) =>
        publicRecord(record, { includeEndpoint }),
      );
    },
    listActiveRaw(ownerSubjectId) {
      const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
      if (!normalizedOwnerSubjectId) return [];
      return allowUnboundedReadAcknowledged(referenceQueries.webPushListActiveSubscriptions, [
        normalizedOwnerSubjectId,
      ]).map(rawSubscriptionRecord);
    },
    revoke(ownerSubjectId, endpoint) {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) return null;
      const timestamp = nowIso();
      const result = exec(referenceQueries.webPushRevokeSubscription, [
        timestamp,
        timestamp,
        ownerSubjectId,
        normalizedEndpoint,
      ]);
      if (!result.changes) return null;
      return publicRecord(getByEndpoint(normalizedEndpoint));
    },
    markSuccess(endpoint) {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) return;
      const timestamp = nowIso();
      exec(referenceQueries.webPushMarkSuccess, [timestamp, timestamp, timestamp, normalizedEndpoint]);
    },
    markFailure(endpoint, reason, { revoke = false } = {}) {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) return;
      const timestamp = nowIso();
      exec(referenceQueries.webPushMarkFailure, [
        timestamp,
        String(reason || 'push_send_failed').slice(0, 240),
        timestamp,
        revoke ? timestamp : null,
        timestamp,
        normalizedEndpoint,
      ]);
    },
    clearForTests() {
      exec(referenceQueries.webPushDeleteAllForTests, []);
    },
  };
}

export function createPostgresWebPushSubscriptionStore() {
  async function getByEndpoint(endpoint) {
    const result = await postgresQuery(
      `SELECT id, owner_subject_id, endpoint, p256dh, auth, created_at, updated_at, revoked_at, last_success_at, last_failure_at, last_failure_reason, last_used_at, user_agent, platform, device_label
       FROM web_push_subscriptions
       WHERE endpoint = $1`,
      [endpoint],
    );
    return result.rows[0] || null;
  }

  return {
    async upsert(ownerSubjectId, subscription, platform = {}) {
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
        ],
      );
      return publicRecord(await getByEndpoint(record.endpoint));
    },
    async list(ownerSubjectId, { activeOnly = true, includeEndpoint = true } = {}) {
      const result = await postgresQuery(
        `SELECT id, owner_subject_id, endpoint, p256dh, auth, created_at, updated_at, revoked_at, last_success_at, last_failure_at, last_failure_reason, last_used_at, user_agent, platform, device_label
         FROM web_push_subscriptions
         WHERE owner_subject_id = $1
           AND ($2::boolean = FALSE OR revoked_at IS NULL)
         ORDER BY updated_at DESC, id ASC`,
        [ownerSubjectId, Boolean(activeOnly)],
      );
      return result.rows.map((record) => publicRecord(record, { includeEndpoint }));
    },
    async listActiveRaw(ownerSubjectId) {
      const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
      if (!normalizedOwnerSubjectId) return [];
      const result = await postgresQuery(
        `SELECT id, owner_subject_id, endpoint, p256dh, auth, created_at, updated_at, revoked_at, last_success_at, last_failure_at, last_failure_reason, last_used_at, user_agent, platform, device_label
         FROM web_push_subscriptions
         WHERE owner_subject_id = $1
           AND revoked_at IS NULL
         ORDER BY updated_at DESC, id ASC`,
        [normalizedOwnerSubjectId],
      );
      return result.rows.map(rawSubscriptionRecord);
    },
    async revoke(ownerSubjectId, endpoint) {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) return null;
      const timestamp = nowIso();
      const result = await postgresQuery(
        `UPDATE web_push_subscriptions
         SET revoked_at = $1, updated_at = $2
         WHERE owner_subject_id = $3
           AND endpoint = $4`,
        [timestamp, timestamp, ownerSubjectId, normalizedEndpoint],
      );
      if (!result.rowCount) return null;
      return publicRecord(await getByEndpoint(normalizedEndpoint));
    },
    async markSuccess(endpoint) {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) return;
      const timestamp = nowIso();
      await postgresQuery(
        `UPDATE web_push_subscriptions
         SET last_success_at = $1,
             last_used_at = $2,
             last_failure_reason = NULL,
             updated_at = $3
         WHERE endpoint = $4`,
        [timestamp, timestamp, timestamp, normalizedEndpoint],
      );
    },
    async markFailure(endpoint, reason, { revoke = false } = {}) {
      const normalizedEndpoint = nonEmptyString(endpoint);
      if (!normalizedEndpoint) return;
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
          String(reason || 'push_send_failed').slice(0, 240),
          timestamp,
          revoke ? timestamp : null,
          timestamp,
          normalizedEndpoint,
        ],
      );
    },
    async clearForTests() {
      await postgresQuery('DELETE FROM web_push_subscriptions');
    },
  };
}

export function createWebPushSubscriptionStore() {
  return isPostgresStorageBackend() ? createPostgresWebPushSubscriptionStore() : createSqliteWebPushSubscriptionStore();
}

let defaultWebPushSubscriptionStore = null;
let defaultWebPushSubscriptionStoreBackend = null;

export function getDefaultWebPushSubscriptionStore() {
  const backend = getStorageBackendKind();
  if (!defaultWebPushSubscriptionStore || defaultWebPushSubscriptionStoreBackend !== backend) {
    defaultWebPushSubscriptionStore = createWebPushSubscriptionStore();
    defaultWebPushSubscriptionStoreBackend = backend;
  }
  return defaultWebPushSubscriptionStore;
}

export function buildTestPushPayload({ now = nowIso() } = {}) {
  return {
    type: 'pdpp.test_notification',
    title: 'PDPP test notification',
    body: 'Your dashboard browser can receive Web Push alerts.',
    timestamp: now,
    url: '/',
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
const INTERACTION_KIND_SENSITIVITY = Object.freeze({
  otp: 'secret',
  credentials: 'secret',
  manual_action: 'external',
});

export function classifyInteractionSensitivity(kind) {
  if (typeof kind !== 'string' || kind.length === 0) return 'secret';
  return INTERACTION_KIND_SENSITIVITY[kind] || 'secret';
}

function interactionPushBody(sensitivity) {
  switch (sensitivity) {
    case 'external':
      return 'A connector needs you to take an action.';
    case 'informational':
      return 'A connector run is waiting for owner action.';
    case 'secret':
    default:
      return 'A connector needs owner input.';
  }
}

export function buildPendingInteractionPushPayload({ interaction, connectorDisplayName, routeTo = 'interaction', runId }) {
  const kind = typeof interaction?.kind === 'string' ? interaction.kind : 'interaction';
  const interactionId = typeof interaction?.request_id === 'string' ? interaction.request_id : '';
  const encodedRunId = encodeURIComponent(runId);
  const encodedInteractionId = encodeURIComponent(interactionId);
  const url =
    routeTo === 'interaction' && kind === 'manual_action'
      ? `/syncs/${encodedRunId}/stream?interaction_id=${encodedInteractionId}`
      : `/syncs/${encodedRunId}`;
  const sensitivity = classifyInteractionSensitivity(kind);
  // Freeze the payload shape so a future contributor cannot accidentally
  // attach connector-supplied free text (`interaction.message`, `.schema`,
  // `.data`) by spreading the interaction object in.
  return Object.freeze({
    type: 'pdpp.pending_interaction',
    title: `PDPP ${connectorDisplayName}: action needed`,
    body: interactionPushBody(sensitivity),
    connector_display_name: connectorDisplayName,
    run_id: runId,
    interaction_id: interactionId,
    interaction_kind: kind,
    interaction_sensitivity: sensitivity,
    timestamp: nowIso(),
    url,
  });
}

// Predicate: should this connector progress message trigger a nonblocking
// owner-assistance Web Push? We only fan out for ASSISTANCE messages that
// actually require owner attention but expect no PDPP response (e.g. "approve
// the ChatGPT push in your phone app"). Blocking INTERACTION messages route
// through the existing brokerInteraction path.
export function shouldFanoutAssistanceProgress(message) {
  if (!message || message.type !== 'ASSISTANCE') return false;
  if (message.response_contract !== 'none') return false;
  return classifyAssistanceNotification(message) === NOTIFICATION_TIERS.ACTION_REQUIRED;
}

export function buildAssistancePushPayload({ assistance, connectorDisplayName, runId }) {
  const assistanceRequestId =
    typeof assistance?.assistance_request_id === 'string' ? assistance.assistance_request_id : '';
  // Routing: assistance work happens outside PDPP, so we always send the
  // owner to the durable run page rather than a transient interaction stream.
  // Body copy is intentionally generic — assistance.message can carry
  // connector-supplied free text that we MUST NOT echo on a lock screen.
  // The payload is frozen so a future contributor cannot accidentally spread
  // the assistance object in and pipe `.message`/`.data` through.
  return Object.freeze({
    type: 'pdpp.assistance_requested',
    title: `PDPP ${connectorDisplayName}: action needed`,
    body: 'A connector needs you to act in another app.',
    connector_display_name: connectorDisplayName,
    run_id: runId,
    assistance_request_id: assistanceRequestId,
    owner_action: typeof assistance?.owner_action === 'string' ? assistance.owner_action : null,
    notification_tier: NOTIFICATION_TIERS.ACTION_REQUIRED,
    response_contract: 'none',
    timestamp: nowIso(),
    url: `/syncs/${encodeURIComponent(runId)}`,
  });
}

function shouldRevokeForWebPushError(err) {
  const status = Number(err?.statusCode || err?.status);
  return status === 404 || status === 410;
}

export function resolveWebPushModuleApi(webPushModule) {
  return webPushModule?.default ?? webPushModule;
}

async function defaultSendNotification(subscription, payload, config) {
  const webPushModule = await import('web-push');
  const webPush = resolveWebPushModuleApi(webPushModule);
  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return webPush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: DEFAULT_TTL_SECONDS,
    contentEncoding: 'aes128gcm',
  });
}

async function sendPayloadToOwnerSubscriptions({
  config,
  store,
  sender,
  ownerSubjectId,
  payload,
  log,
  logContext,
}) {
  const subscriptions = await store.listActiveRaw(ownerSubjectId);
  let sent = 0;
  const failures = [];
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
    }),
  );
  return { attempted: subscriptions.length, sent, unavailable: false, failureReasons: failures };
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
export function classifyPushFanoutOutcome(result) {
  if (!result || typeof result !== 'object') {
    return { state: 'failed', reason: 'no_result' };
  }
  if (result.unavailable) {
    return { state: 'suppressed', reason: 'channel_unavailable' };
  }
  if (result.suppressed) {
    return { state: 'suppressed', reason: 'policy_suppressed' };
  }
  const attempted = Number(result.attempted || 0);
  const sent = Number(result.sent || 0);
  if (attempted === 0) {
    return { state: 'suppressed', reason: 'no_opted_in_channel' };
  }
  if (sent > 0) {
    return { state: 'sent', reason: null };
  }
  const failures = Array.isArray(result.failureReasons) ? result.failureReasons.filter(Boolean) : [];
  const top = failures[0];
  return { state: 'failed', reason: top ? `transport: ${top.slice(0, 120)}` : 'transport_failed' };
}

/**
 * @param {object} args
 * @param {object} [args.config]
 * @param {object} [args.store]
 * @param {Function} [args.sender]
 * @param {object} args.interaction
 * @param {string} args.connectorDisplayName
 * @param {string} args.ownerSubjectId
 * @param {'interaction'|'run'} [args.routeTo]
 * @param {string} args.runId
 * @param {object} [args.log]
 * @param {((outcome: { state: string; reason: string | null }) => Promise<void>) | null} [args.recordOutcome]
 *   Optional durable-attention recorder. When provided, the fanout
 *   classifies its delivery result into a `notification_state` and
 *   invokes the callback so the operator console can render
 *   "we notified the owner" vs "delivery failed" without rereading
 *   transport logs. Callback failure is logged but never propagated:
 *   failing to record the outcome must not break notification fanout.
 */
export async function fanoutPendingInteractionWebPush({
  config = resolveWebPushConfig(),
  store = getDefaultWebPushSubscriptionStore(),
  sender = defaultSendNotification,
  interaction,
  connectorDisplayName,
  ownerSubjectId,
  routeTo = 'interaction',
  runId,
  log = console,
  recordOutcome = null,
}) {
  const result = await fanoutPendingInteractionWebPushImpl({
    config,
    store,
    sender,
    interaction,
    connectorDisplayName,
    ownerSubjectId,
    routeTo,
    runId,
    log,
  });
  if (typeof recordOutcome === 'function') {
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
}) {
  if (!config.enabled) {
    return { attempted: 0, sent: 0, unavailable: true };
  }
  const delivery = projectNotificationDelivery({
    channelOptedIn: true,
    tier: NOTIFICATION_TIERS.ACTION_REQUIRED,
  });
  if (!delivery.interruptive_eligible) {
    return { attempted: 0, sent: 0, unavailable: false, suppressed: true };
  }
  const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
  if (!normalizedOwnerSubjectId) {
    log.warn?.(`[controller] web push for run ${runId} skipped: missing owner subject`);
    return { attempted: 0, sent: 0, unavailable: false };
  }
  const payload = buildPendingInteractionPushPayload({ interaction, connectorDisplayName, routeTo, runId });
  return sendPayloadToOwnerSubscriptions({
    config,
    store,
    sender,
    ownerSubjectId: normalizedOwnerSubjectId,
    payload,
    log,
    logContext: `for run ${runId}`,
  });
}

/**
 * @param {object} args
 * @param {object} [args.config]
 * @param {object} [args.store]
 * @param {Function} [args.sender]
 * @param {Record<string, unknown>} args.assistance
 * @param {string} args.connectorDisplayName
 * @param {string} args.ownerSubjectId
 * @param {string} args.runId
 * @param {object} [args.log]
 * @param {((outcome: { state: string; reason: string | null }) => Promise<void>) | null} [args.recordOutcome]
 */
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
}) {
  const result = await fanoutAssistanceWebPushImpl({
    config,
    store,
    sender,
    assistance,
    connectorDisplayName,
    ownerSubjectId,
    runId,
    log,
  });
  if (typeof recordOutcome === 'function') {
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
}) {
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
    store,
    sender,
    ownerSubjectId: normalizedOwnerSubjectId,
    payload,
    log,
    logContext: `assistance for run ${runId}`,
  });
}

export async function fanoutTestWebPush({
  config = resolveWebPushConfig(),
  store = getDefaultWebPushSubscriptionStore(),
  sender = defaultSendNotification,
  ownerSubjectId,
  log = console,
}) {
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
    store,
    sender,
    ownerSubjectId: normalizedOwnerSubjectId,
    payload,
    log,
    logContext: `test notification for ${normalizedOwnerSubjectId}`,
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

export function buildEscalationPushPayload({ connectorDisplayName, reason, connectionUrl }) {
  // Body copy is deliberately generic and reason-independent: whatever
  // caused the escalation (blocked credentials, repeated failures,
  // dead-but-429ing provider), the only actionable message is "check the
  // dashboard". Connector-specific copy must NOT appear in the body because
  // push bodies are visible on lock screens before the owner authenticates.
  const body = 'Your attention is required to continue syncing.';
  const title = `PDPP ${connectorDisplayName}: action needed`;
  return Object.freeze({
    type: 'pdpp.escalation',
    title,
    body,
    connector_display_name: connectorDisplayName,
    escalation_reason: reason,
    timestamp: nowIso(),
    url: connectionUrl || '/',
  });
}

/**
 * Fan out a deduplicated "human required" escalation push to all active
 * subscriptions for the owner. Parallel to fanoutPendingInteractionWebPush
 * but for cross-run governance escalations (blocked/needs_attention) rather
 * than in-run interaction prompts.
 *
 * @param {object} args
 * @param {object} [args.config]
 * @param {object} [args.store]
 * @param {Function} [args.sender]
 * @param {string} args.connectorDisplayName
 * @param {string} args.ownerSubjectId
 * @param {'blocked'|'needs_attention'} args.reason
 * @param {string} [args.connectionUrl]
 * @param {object|null} [args.renderedVerdict]
 * @param {object} [args.log]
 */
export async function fanoutEscalationWebPush({
  config = resolveWebPushConfig(),
  store = getDefaultWebPushSubscriptionStore(),
  sender = defaultSendNotification,
  connectorDisplayName,
  ownerSubjectId,
  reason,
  connectionUrl = '/',
  renderedVerdict,
  log = console,
}) {
  if (!config.enabled) {
    return { attempted: 0, sent: 0, unavailable: true };
  }
  if (renderedVerdict !== undefined && !shouldFanoutRenderedVerdict(renderedVerdict)) {
    return { attempted: 0, sent: 0, unavailable: false, suppressed: true };
  }
  const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
  if (!normalizedOwnerSubjectId) {
    log.warn?.(`[controller] escalation push skipped: missing owner subject (reason=${reason})`);
    return { attempted: 0, sent: 0, unavailable: false };
  }
  const payload = buildEscalationPushPayload({ connectorDisplayName, reason, connectionUrl });
  return sendPayloadToOwnerSubscriptions({
    config,
    store,
    sender,
    ownerSubjectId: normalizedOwnerSubjectId,
    payload,
    log,
    logContext: `escalation (${reason}) for ${normalizedOwnerSubjectId}`,
  });
}
