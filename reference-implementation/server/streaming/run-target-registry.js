/**
 * Run-target registry (reference-internal).
 *
 * Holds an ephemeral, in-memory map from `(runId, interactionId)` to a
 * streaming target plus the device-exporter authority that registered it.
 * Legacy CDP targets resolve to a page-target WebSocket URL string; Neko
 * targets resolve to a normalized descriptor. Consumed by the streaming
 * companion factory's resolver when a viewer attaches to a specific
 * run-interaction streaming session.
 *
 * Key shape: composite `(runId, interactionId)`. Each manual_action
 * interaction has its own page identity (the page the human should see and
 * control); the registry never collapses two interactions of the same run
 * into a single "latest page" cell. See:
 *   openspec/changes/add-run-interaction-streaming-companion/design-notes/
 *   advisor-recommendation-streaming-page-target-resolution.md  (= tmp/answer.md)
 *
 * This is reference-runtime orchestration plumbing, NOT a PDPP wire
 * surface. It MUST NOT introduce manifest fields, capability vocabulary,
 * or Collection Profile conformance terms. The endpoints registered by
 * `attachRoutes` live under
 * `/admin/runs/:runId/interactions/:interactionId/streaming-target` to
 * make the admin/internal framing visible.
 *
 * Security shape (all enforced here, not by callers):
 *  - CDP `wsUrl` MUST parse as ws:/wss: and remain loopback
 *    (`127.0.0.1`/`localhost`). Neko `base_url` MUST parse as http:/https:
 *    and remain either loopback, the private Compose service host `neko`, or
 *    an explicitly approved managed n.eko surface descriptor.
 *  - Full target URLs and auth metadata are never logged, never echoed back
 *    in responses, and never included in error messages. Logs may carry
 *    `runId`, `interactionId`, `backend`, `host`, `port`.
 *  - DELETE requires the same `deviceId` that registered the record.
 *    A different device-exporter cannot unregister another device's
 *    target.
 *  - Nonces are scoped per-run (not per-interaction): a single nonce
 *    minted at run spawn time authenticates registrations for the run.
 *    Interaction exactness for managed n.eko descriptors is enforced by
 *    descriptor metadata (`interaction_id`) checked against the route key.
 *    The synthetic deviceId on the nonce path is `nonce:<runId>` so the
 *    same nonce-issued authority is consistent across the run's interactions.
 *  - Records expire after a short TTL (default 1h) and are evicted by
 *    explicit DELETE, lazy on-access sweep, periodic timer, and
 *    process exit.
 *
 * PUT semantics (idempotency rule):
 *  - Same-value re-PUT for an existing `(runId, interactionId)` succeeds
 *    silently (no log). Same-device, same-target is a routine retry.
 *  - Different-value PUT for an existing key REPLACES the prior value
 *    AND logs a `run_target_replaced` warning. The page identity has
 *    changed (e.g. the connector navigated to a popup); the registry
 *    accepts the new value rather than failing closed. The diagnostic
 *    counter lets us see whether replacement is rare-and-intentional or
 *    a sign of churn.
 *  - A different deviceId trying to PUT over an existing key is still
 *    rejected with 409 — that is a different-authority conflict and is
 *    not what idempotent re-PUT means.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const NEKO_PRIVATE_HOSTS = new Set([...LOOPBACK_HOSTS, 'neko']);
const WS_PROTOCOLS = new Set(['ws:', 'wss:']);
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const NEKO_HTTP_URL_FIELDS = {
  base: {
    inputName: 'base_url',
    outputName: 'baseUrl',
    missingMessage: 'base_url is required',
    trailingSlash: 'remove',
  },
  cdp: {
    inputName: 'cdp_http_url',
    outputName: 'cdpHttpUrl',
    missingMessage: 'cdp_http_url must be a non-empty URL when provided',
    trailingSlash: 'add',
  },
};
const NEKO_OPTIONAL_DESCRIPTOR_FIELDS = [
  { key: 'start_url', sourceNames: ['start_url', 'startUrl'], inputNames: ['start_url', 'startUrl'] },
  { key: 'browser_session_id', sourceNames: ['browser_session_id', 'browserSessionId'] },
  { key: 'lease_id', sourceNames: ['lease_id', 'leaseId'] },
  { key: 'profile_key', sourceNames: ['profile_key', 'profileKey'] },
  { key: 'surface_id', sourceNames: ['surface_id', 'surfaceId'] },
];
const ROUTE_STRING_FIELDS = [
  ['wsUrl', 'ws_url', 'wsUrl'],
  ['pageUrl', 'page_url', 'pageUrl'],
  ['pageTitle', 'page_title', 'pageTitle'],
  ['startUrl', 'start_url', 'startUrl'],
  ['reason', 'reason', null],
];

/** Encode a `(runId, interactionId)` pair into the internal Map key. */
function compositeKey(runId, interactionId) {
  return `${runId}::${interactionId}`;
}

/**
 * Hash a registration nonce before storing it. Nonces are bearer secrets
 * — we never keep the raw value in memory after issuance, so a heap dump
 * or process introspection cannot reveal the credential a child still
 * holds. SHA-256 hex (64 chars) is sufficient: nonces are random 32-byte
 * tokens, so collisions are not a concern, and a fast hash is fine
 * because we are not defending against an offline brute force — the
 * raw nonce only exists in env memory of two short-lived processes.
 */
function hashNonce(nonce) {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

/**
 * Constant-time compare of two equal-length hex strings. We hash the
 * presented token and compare against the stored hash so a timing
 * channel cannot leak information about the stored hash itself.
 */
function constantTimeHexEqual(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  if (aHex.length !== bHex.length) return false;
  const a = Buffer.from(aHex, 'utf8');
  const b = Buffer.from(bHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

class RunTargetError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RunTargetError';
    this.code = code;
    this.status = status;
  }
}

function pdppErrorBody(code, message) {
  // Replicates the envelope shape used by `pdppError` in `server/index.js`.
  // We do not import that helper because it lives in a 5887-line module and
  // also wires up resource-metadata / request-id behavior that the admin
  // routes do not need. Status-code → error-type is intentionally narrow:
  // the admin endpoint only ever returns 400, 401, 403, 404, 409, 500.
  let type = 'invalid_request_error';
  if (code === 'authentication_error') type = 'authentication_error';
  else if (code === 'permission_error') type = 'permission_error';
  return { error: { type, code, message } };
}

function sendError(res, status, code, message) {
  res.status(status).json(pdppErrorBody(code, message));
}

function firstStringField(object, fieldNames) {
  for (const fieldName of fieldNames) {
    if (typeof object[fieldName] === 'string') return object[fieldName];
  }
  return undefined;
}

function firstNonNullField(object, fieldNames) {
  for (const fieldName of fieldNames) {
    if (object[fieldName] !== undefined && object[fieldName] !== null) return object[fieldName];
  }
  return undefined;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function hasRunInteraction(runId, interactionId) {
  return isNonEmptyString(runId) && isNonEmptyString(interactionId);
}

function parseRequiredUrl(value, fieldName, missingMessage) {
  if (!isNonEmptyString(value)) {
    throw new RunTargetError('run_target_invalid_url', missingMessage);
  }
  try {
    return new URL(value);
  } catch {
    throw new RunTargetError('run_target_invalid_url', `${fieldName} is not a valid URL`);
  }
}

function defaultPort(parsed) {
  return parsed.port || (parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? '443' : '80');
}

function normalizeTrailingSlash(href, trailingSlash) {
  if (trailingSlash === 'remove') return href.endsWith('/') ? href.slice(0, -1) : href;
  return href.endsWith('/') ? href : `${href}/`;
}

/**
 * Validates a candidate wsUrl. Returns `{ host, port }` on success;
 * throws `RunTargetError('run_target_invalid_url' | 'run_target_non_loopback')`
 * on rejection. Never includes the full URL or path in thrown messages.
 */
function validateWsUrl(wsUrl) {
  const parsed = parseRequiredUrl(wsUrl, 'wsUrl', 'wsUrl is required');
  if (!WS_PROTOCOLS.has(parsed.protocol)) {
    throw new RunTargetError(
      'run_target_invalid_url',
      `wsUrl scheme must be ws: or wss:, got ${parsed.protocol}`,
    );
  }
  // Strip IPv6 brackets when present so the comparison is consistent.
  const host = parsed.hostname;
  // Accept loopback OR the private Compose service host `neko`. The neko
  // host is reachable only on the private docker-compose network and is
  // fronted by cdp-proxy.py inside the neko container — it carries the
  // same trust boundary as loopback, just across a sibling-container
  // private network. This permits the remote-CDP connector flow (the
  // chatgpt connector via PDPP_CHATGPT_REMOTE_CDP_URL) to register page
  // handoffs that point at neko's Chromium. base_url already permits
  // this host for the same reason; the asymmetry was an oversight.
  if (!NEKO_PRIVATE_HOSTS.has(host)) {
    throw new RunTargetError(
      'run_target_non_loopback',
      'wsUrl host must be 127.0.0.1, localhost, or neko',
    );
  }
  return { host, port: defaultPort(parsed) };
}

function validateNekoHttpUrl(url, field) {
  const parsed = parseRequiredUrl(url, field.inputName, field.missingMessage);
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new RunTargetError(
      'run_target_invalid_url',
      `${field.inputName} scheme must be http: or https:, got ${parsed.protocol}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new RunTargetError(
      'run_target_invalid_url',
      `${field.inputName} must not include credentials`,
    );
  }
  if (parsed.search || parsed.hash) {
    throw new RunTargetError(
      'run_target_invalid_url',
      `${field.inputName} must not include query or fragment`,
    );
  }
  return {
    [field.outputName]: normalizeTrailingSlash(parsed.href, field.trailingSlash),
    host: parsed.hostname,
    port: defaultPort(parsed),
  };
}

/**
 * Coerce an optional metadata field to a trimmed string or undefined.
 * The metadata fields (`pageUrl`, `pageTitle`, `reason`) are forward-
 * compatible diagnostic context — accepted, stored, and surfaced via
 * `getByRun()` for debug, but not consulted by the resolver.
 */
function optionalString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isJsonScalar(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeJsonObject(value, fieldName) {
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeJsonMetadata(value[key], fieldName);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

function normalizeJsonMetadata(value, fieldName = 'auth') {
  if (isJsonScalar(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonMetadata(item, fieldName));
  }
  if (value && typeof value === 'object') return normalizeJsonObject(value, fieldName);
  if (value === undefined) return undefined;
  throw new RunTargetError(
    'run_target_invalid_auth',
    `${fieldName} must contain JSON-compatible values`,
  );
}

function normalizeAuthMetadata(auth) {
  if (auth === undefined || auth === null) return undefined;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new RunTargetError('run_target_invalid_auth', 'auth must be an object');
  }
  return normalizeJsonMetadata(auth);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function registrationAction(existing, target) {
  if (!existing) return 'registered';
  return existing.comparisonKey === target.comparisonKey ? 'reaffirmed' : 'replaced';
}

function buildRecord({
  runId,
  interactionId,
  target,
  deviceId,
  pageUrl,
  pageTitle,
  reason,
  registeredAt,
  ttlMs,
}) {
  return {
    runId,
    interactionId,
    backend: target.backend,
    wsUrl: target.backend === 'cdp' ? target.resolverValue : undefined,
    baseUrl: target.backend === 'neko' ? target.descriptor.base_url : undefined,
    descriptor: cloneJson(target.descriptor),
    comparisonKey: target.comparisonKey,
    pageUrl: optionalString(pageUrl),
    pageTitle: optionalString(pageTitle),
    reason: optionalString(reason),
    deviceId,
    registeredAt: new Date(registeredAt).toISOString(),
    expiry: registeredAt + ttlMs,
  };
}

function selectRouteDescriptor(body) {
  if (body.target && typeof body.target === 'object') return body.target;
  if (body.descriptor && typeof body.descriptor === 'object') return body.descriptor;
  return undefined;
}

function selectRouteStringFields(body) {
  return Object.fromEntries(
    ROUTE_STRING_FIELDS.map(([key, snakeCase, camelCase]) => [
      key,
      typeof body[snakeCase] === 'string'
        ? body[snakeCase]
        : camelCase === null
          ? undefined
          : body[camelCase],
    ]),
  );
}

function registrationInputFromRoute(req, runId, interactionId, deviceId) {
  const body = req.body || {};
  const { wsUrl, pageUrl, pageTitle, startUrl, reason } = selectRouteStringFields(body);
  return {
    runId,
    interactionId,
    wsUrl,
    ws_url: body.ws_url,
    backend: body.backend,
    baseUrl: body.baseUrl,
    base_url: body.base_url,
    cdpHttpUrl: body.cdpHttpUrl,
    cdp_http_url: body.cdp_http_url,
    startUrl,
    start_url: body.start_url,
    auth: body.auth,
    descriptor: selectRouteDescriptor(body),
    deviceId,
    pageUrl,
    pageTitle,
    reason,
  };
}

function supportsRouteRegistration(app) {
  return app && typeof app.put === 'function' && typeof app.post === 'function' && typeof app.delete === 'function';
}

function normalizeOptionalDescriptorFields(descriptor, source, input) {
  for (const { key, sourceNames, inputNames = [] } of NEKO_OPTIONAL_DESCRIPTOR_FIELDS) {
    const value =
      firstNonNullField(source, sourceNames) ?? firstNonNullField(input, inputNames);
    const normalized = optionalString(value);
    if (normalized !== undefined) descriptor[key] = normalized;
  }
}

function assertNekoDescriptorApproved(
  descriptor,
  { host, port, cdpHost, cdpPort, runId, interactionId },
  isNekoDescriptorApproved,
) {
  if (NEKO_PRIVATE_HOSTS.has(host) && (cdpHost === null || NEKO_PRIVATE_HOSTS.has(cdpHost))) {
    return;
  }
  if (
    typeof isNekoDescriptorApproved === 'function' &&
    isNekoDescriptorApproved(descriptor, { host, port, cdpHost, cdpPort, runId, interactionId }) === true
  ) {
    return;
  }
  throw new RunTargetError(
    'run_target_non_loopback',
    'base_url host must be 127.0.0.1, localhost, neko, or an approved managed n.eko surface',
  );
}

function normalizedTarget(backend, descriptor, resolverValue, host, port) {
  return { backend, descriptor, resolverValue, host, port, comparisonKey: JSON.stringify(descriptor) };
}

function normalizeCdpTarget(input, source) {
  const wsUrl = firstStringField(source, ['ws_url', 'wsUrl']) ?? input.wsUrl;
  const { host, port } = validateWsUrl(wsUrl);
  return normalizedTarget('cdp', { backend: 'cdp', ws_url: wsUrl }, wsUrl, host, port);
}

function hasCdpHttpUrl(value) {
  return value !== undefined && value !== null && value !== '';
}

function normalizedDescriptorInteractionId(source, input) {
  if (source === input) return optionalString(source.interaction_id);
  return optionalString(firstNonNullField(source, ['interaction_id', 'interactionId']));
}

function addNekoCdpHttpUrl(descriptor, source, input) {
  const rawUrl = firstNonNullField(source, ['cdp_http_url', 'cdpHttpUrl']) ??
    firstNonNullField(input, ['cdp_http_url', 'cdpHttpUrl']);
  if (!hasCdpHttpUrl(rawUrl)) return { cdpHost: null, cdpPort: null };
  const normalized = validateNekoHttpUrl(rawUrl, NEKO_HTTP_URL_FIELDS.cdp);
  descriptor.cdp_http_url = normalized.cdpHttpUrl;
  return { cdpHost: normalized.host, cdpPort: normalized.port };
}

function normalizeNekoTarget(input, source, isNekoDescriptorApproved) {
  const baseUrl = firstStringField(source, ['base_url', 'baseUrl']) ?? input.baseUrl;
  const { baseUrl: normalizedBaseUrl, host, port } = validateNekoHttpUrl(
    baseUrl,
    NEKO_HTTP_URL_FIELDS.base,
  );
  const descriptor = { backend: 'neko', base_url: normalizedBaseUrl };
  const { cdpHost, cdpPort } = addNekoCdpHttpUrl(descriptor, source, input);
  normalizeOptionalDescriptorFields(descriptor, source, input);
  const descriptorInteractionId = normalizedDescriptorInteractionId(source, input);
  if (descriptorInteractionId !== undefined) descriptor.interaction_id = descriptorInteractionId;
  const auth = normalizeAuthMetadata(firstNonNullField(source, ['auth']) ?? input.auth);
  if (auth !== undefined) descriptor.auth = auth;
  assertNekoDescriptorApproved(
    descriptor,
    { host, port, cdpHost, cdpPort, runId: input.runId, interactionId: input.interactionId },
    isNekoDescriptorApproved,
  );
  return normalizedTarget('neko', descriptor, descriptor, host, port);
}

function normalizeTargetDescriptor(input, { isNekoDescriptorApproved } = {}) {
  const source = input?.descriptor && typeof input.descriptor === 'object' ? input.descriptor : input;
  const backend = optionalString(source?.backend) || 'cdp';
  if (backend === 'cdp') return normalizeCdpTarget(input, source);
  if (backend === 'neko') return normalizeNekoTarget(input, source, isNekoDescriptorApproved);
  throw new RunTargetError(
    'run_target_invalid_backend',
    'streaming target backend must be cdp or neko',
  );
}

function logRegistry(state, level, msg, data) {
  if (!state.logger || typeof state.logger[level] !== 'function') return;
  try {
    state.logger[level]({ msg, ...(data || {}) });
  } catch {
    /* logger errors must not break the registration path */
  }
}

function evictRegistryRecord(state, key, record) {
  state.records.delete(key);
  logRegistry(state, 'info', 'run_target_evicted_expired', {
    runId: record.runId,
    interactionId: record.interactionId,
  });
}

function evictIfRegistryRecordExpired(state, key, record, time) {
  if (record.expiry > time) return false;
  evictRegistryRecord(state, key, record);
  return true;
}

function evictExpiredRegistryRecords(state) {
  const time = state.now();
  for (const [key, record] of state.records) {
    evictIfRegistryRecordExpired(state, key, record, time);
  }
}

function logRegistryRegistration(state, action, record, target) {
  if (action === 'reaffirmed') return;
  logRegistry(state, action === 'replaced' ? 'warn' : 'info', `run_target_${action}`, {
    runId: record.runId,
    interactionId: record.interactionId,
    backend: target.backend,
    host: target.host,
    port: target.port,
    deviceId: record.deviceId,
    reason: record.reason,
  });
}

function registerRegistryTarget(state, input) {
  const { runId, interactionId, deviceId } = input;
  if (!isNonEmptyString(runId)) {
    throw new RunTargetError('run_target_invalid_url', 'runId is required');
  }
  if (!isNonEmptyString(interactionId)) {
    throw new RunTargetError('run_target_invalid_url', 'interactionId is required');
  }
  if (!isNonEmptyString(deviceId)) {
    throw new RunTargetError('run_target_invalid_url', 'deviceId is required');
  }
  const target = normalizeTargetDescriptor(input, state);
  evictExpiredRegistryRecords(state);

  const key = compositeKey(runId, interactionId);
  const existing = state.records.get(key);
  if (existing && existing.deviceId !== deviceId) {
    throw new RunTargetError(
      'run_target_already_registered_other_device',
      'Another device has already registered a streaming target for this run interaction',
      409,
    );
  }

  const registeredAt = state.now();
  const action = registrationAction(existing, target);
  const record = buildRecord({ ...input, target, registeredAt, ttlMs: state.ttlMs });
  state.records.set(key, record);
  logRegistryRegistration(state, action, record, target);
  return { runId, interactionId, expiry: record.expiry, action };
}

function unregisterRegistryTarget(state, { runId, interactionId, deviceId }) {
  if (!hasRunInteraction(runId, interactionId)) return false;
  const key = compositeKey(runId, interactionId);
  const record = state.records.get(key);
  if (!record || record.deviceId !== deviceId) return false;
  state.records.delete(key);
  logRegistry(state, 'info', 'run_target_unregistered', { runId, interactionId, deviceId });
  return true;
}

function forceUnregisterRegistryTarget(state, { runId, interactionId }) {
  if (!hasRunInteraction(runId, interactionId)) return false;
  const key = compositeKey(runId, interactionId);
  if (!state.records.has(key)) return false;
  state.records.delete(key);
  logRegistry(state, 'info', 'run_target_force_unregistered', { runId, interactionId });
  return true;
}

function getRegistryTarget(state, { runId, interactionId }) {
  if (!hasRunInteraction(runId, interactionId)) return null;
  const key = compositeKey(runId, interactionId);
  const record = state.records.get(key);
  if (!record || evictIfRegistryRecordExpired(state, key, record, state.now())) return null;
  return record.backend === 'neko' ? cloneJson(record.descriptor) : record.wsUrl;
}

function getRegistryTargetsByRun(state, runId) {
  if (!isNonEmptyString(runId)) return [];
  const time = state.now();
  const records = [];
  for (const [key, record] of state.records) {
    if (record.runId === runId && !evictIfRegistryRecordExpired(state, key, record, time)) {
      records.push(record);
    }
  }
  return records;
}

function registerRegistryNonce(state, { runId, nonce }) {
  if (!isNonEmptyString(runId)) {
    throw new RunTargetError('run_target_invalid_url', 'runId is required');
  }
  if (!isNonEmptyString(nonce)) {
    throw new RunTargetError('run_target_invalid_url', 'nonce is required');
  }
  state.nonceHashes.set(runId, hashNonce(nonce));
}

function verifyRegistryNonce(state, { runId, presentedToken }) {
  if (!hasRunInteraction(runId, presentedToken)) return false;
  const stored = state.nonceHashes.get(runId);
  return stored ? constantTimeHexEqual(stored, hashNonce(presentedToken)) : false;
}

function clearRegistryNonce(state, { runId }) {
  if (isNonEmptyString(runId)) state.nonceHashes.delete(runId);
}

function extractBearerToken(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function routeParameters(req) {
  return {
    runId: decodeURIComponent(req.params.runId),
    interactionId: decodeURIComponent(req.params.interactionId),
  };
}

function sendUnexpectedRouteError(res, err, log, event, message) {
  log('warn', event, { error: err?.message });
  return sendError(res, 500, 'server_error', message);
}

function handleRegisterRoute(req, res, { register, log }) {
  try {
    const { runId, interactionId } = routeParameters(req);
    const deviceId = req.deviceExporter?.deviceId;
    if (!isNonEmptyString(deviceId)) {
      return sendError(res, 403, 'permission_error', 'Device exporter authority is required to register a run streaming target');
    }
    const { expiry, action } = register(registrationInputFromRoute(req, runId, interactionId, deviceId));
    return res.status(200).json({
      object: 'run_streaming_target',
      run_id: runId,
      interaction_id: interactionId,
      expiry,
      action,
    });
  } catch (err) {
    if (err instanceof RunTargetError) return sendError(res, err.status, err.code, err.message);
    return sendUnexpectedRouteError(res, err, log, 'run_target_register_failed', 'Failed to register run streaming target');
  }
}

function handleUnregisterRoute(req, res, { unregister, log }) {
  try {
    const { runId, interactionId } = routeParameters(req);
    const deviceId = req.deviceExporter?.deviceId;
    if (!isNonEmptyString(deviceId)) {
      return sendError(res, 403, 'permission_error', 'Device exporter authority is required to unregister a run streaming target');
    }
    if (!unregister({ runId, interactionId, deviceId })) {
      return sendError(res, 404, 'not_found', 'No streaming target is registered for this run interaction by this device');
    }
    return res.status(200).json({
      object: 'run_streaming_target_deleted',
      run_id: runId,
      interaction_id: interactionId,
    });
  } catch (err) {
    return sendUnexpectedRouteError(res, err, log, 'run_target_unregister_failed', 'Failed to unregister run streaming target');
  }
}

function requireRunTargetAuth(req, res, next, { verifyNonce, requireDeviceExporterAuth }) {
  const presentedToken = extractBearerToken(req);
  const runId = req?.params?.runId ? decodeURIComponent(req.params.runId) : '';
  if (presentedToken && runId && verifyNonce({ runId, presentedToken })) {
    req.deviceExporter = { deviceId: `nonce:${runId}` };
    return next();
  }
  return requireDeviceExporterAuth(req, res, next);
}

function attachRegistryRoutes(app, requireDeviceExporterAuth, handlers) {
  if (!supportsRouteRegistration(app)) {
    throw new Error('attachRoutes: app must support .put(), .post(), and .delete()');
  }
  if (typeof requireDeviceExporterAuth !== 'function') {
    throw new Error('attachRoutes: requireDeviceExporterAuth middleware is required');
  }
  const resourcePath = '/admin/runs/:runId/interactions/:interactionId/streaming-target';
  const requireAuth = (req, res, next) => requireRunTargetAuth(req, res, next, {
    verifyNonce: handlers.verifyNonce,
    requireDeviceExporterAuth,
  });
  const register = (req, res) => handleRegisterRoute(req, res, handlers);
  const unregister = (req, res) => handleUnregisterRoute(req, res, handlers);
  app.put(resourcePath, requireAuth, register);
  app.post(resourcePath, requireAuth, register);
  app.delete(resourcePath, requireAuth, unregister);
}

/**
 * Create a run-target registry.
 *
 * @param {object}   [opts]
 * @param {number}   [opts.ttlMs=DEFAULT_TTL_MS]   Record TTL in ms.
 * @param {Function} [opts.now]                    Clock for tests.
 * @param {object}   [opts.logger]                 Pino-style logger.
 * @param {number}   [opts.sweepIntervalMs]        Periodic sweep interval.
 *                                                  Pass 0 to disable.
 * @param {Function} [opts.isNekoDescriptorApproved] Approval hook for managed
 *                                                  dynamic n.eko descriptors.
 */
export function createRunTargetRegistry({
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  logger = null,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  isNekoDescriptorApproved = null,
} = {}) {
  const state = {
    ttlMs,
    now,
    logger,
    isNekoDescriptorApproved,
    records: new Map(),
    nonceHashes: new Map(),
  };
  const register = (input) => registerRegistryTarget(state, input);
  const unregister = (input) => unregisterRegistryTarget(state, input);
  const forceUnregister = (input) => forceUnregisterRegistryTarget(state, input);
  const get = (input) => getRegistryTarget(state, input);
  const getByRun = (runId) => getRegistryTargetsByRun(state, runId);
  const registerNonce = (input) => registerRegistryNonce(state, input);
  const verifyNonce = (input) => verifyRegistryNonce(state, input);
  const clearNonce = (input) => clearRegistryNonce(state, input);
  const evictExpired = () => evictExpiredRegistryRecords(state);
  const log = (level, msg, data) => logRegistry(state, level, msg, data);
  const attachRoutes = (app, requireDeviceExporterAuth) => attachRegistryRoutes(
    app,
    requireDeviceExporterAuth,
    { register, unregister, verifyNonce, log },
  );

  let sweepTimer = null;
  if (Number.isFinite(sweepIntervalMs) && sweepIntervalMs > 0) {
    sweepTimer = setInterval(evictExpired, sweepIntervalMs);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  function shutdown() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    state.records.clear();
    state.nonceHashes.clear();
  }

  return {
    register,
    unregister,
    forceUnregister,
    get,
    getByRun,
    registerNonce,
    verifyNonce,
    clearNonce,
    attachRoutes,
    evictExpired,
    shutdown,
    _internal: {
      records: state.records,
      nonceHashes: state.nonceHashes,
      ttlMs,
    },
  };
}
