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

export function createWebPushSubscriptionStore() {
  const byEndpoint = new Map();

  function publicRecord(record, { includeEndpoint = true } = {}) {
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

  return {
    upsert(ownerSubjectId, subscription, platform = {}) {
      const normalized = normalizeSubscription(subscription);
      const metadata = normalizePlatform(platform);
      const existing = byEndpoint.get(normalized.endpoint);
      const timestamp = nowIso();
      const record = {
        id: existing?.id || `wps_${Buffer.from(normalized.endpoint).toString('base64url').slice(0, 24)}`,
        owner_subject_id: ownerSubjectId,
        endpoint: normalized.endpoint,
        keys: normalized.keys,
        created_at: existing?.created_at || timestamp,
        updated_at: timestamp,
        revoked_at: null,
        last_success_at: existing?.last_success_at || null,
        last_failure_at: existing?.last_failure_at || null,
        last_failure_reason: existing?.last_failure_reason || null,
        last_used_at: existing?.last_used_at || null,
        ...metadata,
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

export const defaultWebPushSubscriptionStore = createWebPushSubscriptionStore();

export function buildPendingInteractionPushPayload({ interaction, connectorDisplayName, runId }) {
  const kind = typeof interaction?.kind === 'string' ? interaction.kind : 'interaction';
  const interactionId = typeof interaction?.request_id === 'string' ? interaction.request_id : '';
  const encodedRunId = encodeURIComponent(runId);
  const encodedInteractionId = encodeURIComponent(interactionId);
  const url =
    kind === 'manual_action'
      ? `/dashboard/runs/${encodedRunId}/stream?interaction_id=${encodedInteractionId}`
      : `/dashboard/runs/${encodedRunId}`;
  return {
    type: 'pdpp.pending_interaction',
    title: `PDPP ${connectorDisplayName}: action needed`,
    body: kind === 'credentials' || kind === 'otp' ? 'A connector needs owner input.' : 'A connector run is waiting for owner action.',
    connector_display_name: connectorDisplayName,
    run_id: runId,
    interaction_id: interactionId,
    interaction_kind: kind,
    timestamp: nowIso(),
    url,
  };
}

function shouldRevokeForWebPushError(err) {
  const status = Number(err?.statusCode || err?.status);
  return status === 404 || status === 410;
}

async function defaultSendNotification(subscription, payload, config) {
  const webPush = await import('web-push');
  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return webPush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: DEFAULT_TTL_SECONDS,
    contentEncoding: 'aes128gcm',
  });
}

export async function fanoutPendingInteractionWebPush({
  config = resolveWebPushConfig(),
  store = defaultWebPushSubscriptionStore,
  sender = defaultSendNotification,
  interaction,
  connectorDisplayName,
  ownerSubjectId,
  runId,
  log = console,
}) {
  if (!config.enabled) {
    return { attempted: 0, sent: 0, unavailable: true };
  }
  const normalizedOwnerSubjectId = nonEmptyString(ownerSubjectId);
  if (!normalizedOwnerSubjectId) {
    log.warn?.(`[controller] web push for run ${runId} skipped: missing owner subject`);
    return { attempted: 0, sent: 0, unavailable: false };
  }
  const payload = buildPendingInteractionPushPayload({ interaction, connectorDisplayName, runId });
  const subscriptions = store.listActiveRaw(normalizedOwnerSubjectId);
  let sent = 0;
  await Promise.all(
    subscriptions.map(async (record) => {
      try {
        await sender({ endpoint: record.endpoint, keys: record.keys }, payload, config);
        store.markSuccess(record.endpoint);
        sent += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        store.markFailure(record.endpoint, reason, { revoke: shouldRevokeForWebPushError(err) });
        log.warn?.(`[controller] web push for run ${runId} failed: ${reason}`);
      }
    }),
  );
  return { attempted: subscriptions.length, sent, unavailable: false };
}
