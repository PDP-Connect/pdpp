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
 *    minted at run spawn time authenticates registrations for ANY
 *    interaction that arises during that run. The synthetic deviceId
 *    on the nonce path is `nonce:<runId>` so the same nonce-issued
 *    authority is consistent across the run's interactions.
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
  const type =
    code === 'authentication_error'
      ? 'authentication_error'
      : code === 'permission_error'
        ? 'permission_error'
        : code === 'not_found'
          ? 'invalid_request_error'
          : 'invalid_request_error';
  return { error: { type, code, message } };
}

function sendError(res, status, code, message) {
  res.status(status).json(pdppErrorBody(code, message));
}

/**
 * Validates a candidate wsUrl. Returns `{ host, port }` on success;
 * throws `RunTargetError('run_target_invalid_url' | 'run_target_non_loopback')`
 * on rejection. Never includes the full URL or path in thrown messages.
 */
function validateWsUrl(wsUrl) {
  if (typeof wsUrl !== 'string' || wsUrl.length === 0) {
    throw new RunTargetError('run_target_invalid_url', 'wsUrl is required');
  }
  let parsed;
  try {
    parsed = new URL(wsUrl);
  } catch {
    throw new RunTargetError('run_target_invalid_url', 'wsUrl is not a valid URL');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
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
  return { host, port: parsed.port || (parsed.protocol === 'wss:' ? '443' : '80') };
}

function validateNekoBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new RunTargetError('run_target_invalid_url', 'base_url is required');
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RunTargetError('run_target_invalid_url', 'base_url is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RunTargetError(
      'run_target_invalid_url',
      `base_url scheme must be http: or https:, got ${parsed.protocol}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new RunTargetError(
      'run_target_invalid_url',
      'base_url must not include credentials',
    );
  }
  if (parsed.search || parsed.hash) {
    throw new RunTargetError(
      'run_target_invalid_url',
      'base_url must not include query or fragment',
    );
  }
  const host = parsed.hostname;
  const href = parsed.href.endsWith('/') ? parsed.href.slice(0, -1) : parsed.href;
  return {
    baseUrl: href,
    host,
    port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
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

function normalizeJsonMetadata(value, fieldName = 'auth') {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonMetadata(item, fieldName));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = normalizeJsonMetadata(value[key], fieldName);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
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

function normalizeTargetDescriptor(input, { isNekoDescriptorApproved } = {}) {
  const source = input?.descriptor && typeof input.descriptor === 'object' ? input.descriptor : input;
  const backend = optionalString(source?.backend) || 'cdp';

  if (backend === 'cdp') {
    const wsUrl =
      typeof source.ws_url === 'string'
        ? source.ws_url
        : typeof source.wsUrl === 'string'
          ? source.wsUrl
          : input.wsUrl;
    const { host, port } = validateWsUrl(wsUrl);
    const descriptor = { backend: 'cdp', ws_url: wsUrl };
    return {
      backend: 'cdp',
      descriptor,
      resolverValue: wsUrl,
      host,
      port,
      comparisonKey: JSON.stringify(descriptor),
    };
  }

  if (backend === 'neko') {
    const baseUrl =
      typeof source.base_url === 'string'
        ? source.base_url
        : typeof source.baseUrl === 'string'
          ? source.baseUrl
          : input.baseUrl;
    const { baseUrl: normalizedBaseUrl, host, port } = validateNekoBaseUrl(baseUrl);
    const descriptor = { backend: 'neko', base_url: normalizedBaseUrl };
    const startUrl = optionalString(
      source.start_url ?? source.startUrl ?? input.start_url ?? input.startUrl,
    );
    if (startUrl !== undefined) descriptor.start_url = startUrl;
    const browserSessionId = optionalString(source.browser_session_id ?? source.browserSessionId);
    if (browserSessionId !== undefined) descriptor.browser_session_id = browserSessionId;
    const leaseId = optionalString(source.lease_id ?? source.leaseId);
    if (leaseId !== undefined) descriptor.lease_id = leaseId;
    const profileKey = optionalString(source.profile_key ?? source.profileKey);
    if (profileKey !== undefined) descriptor.profile_key = profileKey;
    const surfaceId = optionalString(source.surface_id ?? source.surfaceId);
    if (surfaceId !== undefined) descriptor.surface_id = surfaceId;
    const auth = normalizeAuthMetadata(source.auth ?? input.auth);
    if (auth !== undefined) descriptor.auth = auth;
    if (
      !NEKO_PRIVATE_HOSTS.has(host) &&
      (typeof isNekoDescriptorApproved !== 'function' ||
        isNekoDescriptorApproved(descriptor, {
          host,
          port,
          runId: input.runId,
          interactionId: input.interactionId,
        }) !== true)
    ) {
      throw new RunTargetError(
        'run_target_non_loopback',
        'base_url host must be 127.0.0.1, localhost, neko, or an approved managed n.eko surface',
      );
    }
    return {
      backend: 'neko',
      descriptor,
      resolverValue: descriptor,
      host,
      port,
      comparisonKey: JSON.stringify(descriptor),
    };
  }

  throw new RunTargetError(
    'run_target_invalid_backend',
    'streaming target backend must be cdp or neko',
  );
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
  // Map<compositeKey, Record>. Target URLs/auth are held in memory only; never
  // persisted or logged in full.
  const records = new Map();

  // Per-run nonce store for Mode A (in-process runtime). Map<runId, nonceHash>.
  // Stored as SHA-256 hex of the random token issued at spawn time. The raw
  // nonce is NEVER held here — only the hash. At verify time we hash the
  // presented token and constant-time compare against the stored hash.
  // The store is bound by `runId`: a nonce that authenticates for run X
  // cannot register/unregister for run Y. Nonces are intentionally
  // per-run (not per-interaction) — the run's connector child is the
  // single authority that emits manual_action interactions on the run's
  // behalf, so one credential covers all interactions in that run.
  // Cleared explicitly when the run ends; a stale entry would block a
  // future re-use of the same runId, which the controller MUST not do anyway.
  const nonceHashes = new Map();

  function log(level, msg, data) {
    if (!logger || typeof logger[level] !== 'function') return;
    try {
      logger[level]({ msg, ...(data || {}) });
    } catch {
      /* logger errors must not break the registration path */
    }
  }

  function evictExpired() {
    const t = now();
    for (const [key, record] of records) {
      if (record.expiry <= t) {
        records.delete(key);
        log('info', 'run_target_evicted_expired', {
          runId: record.runId,
          interactionId: record.interactionId,
        });
      }
    }
  }

  function register({
    runId,
    interactionId,
    wsUrl,
    ws_url,
    backend,
    baseUrl,
    base_url,
    startUrl,
    start_url,
    auth,
    descriptor,
    deviceId,
    pageUrl,
    pageTitle,
    reason,
  }) {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new RunTargetError('run_target_invalid_url', 'runId is required');
    }
    if (typeof interactionId !== 'string' || interactionId.length === 0) {
      throw new RunTargetError('run_target_invalid_url', 'interactionId is required');
    }
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new RunTargetError('run_target_invalid_url', 'deviceId is required');
    }
    const target = normalizeTargetDescriptor({
      backend,
      wsUrl,
      ws_url,
      baseUrl,
      base_url,
      startUrl,
      start_url,
      auth,
      descriptor,
      runId,
      interactionId,
    }, { isNekoDescriptorApproved });
    const { host, port } = target;

    evictExpired();

    const key = compositeKey(runId, interactionId);
    const existing = records.get(key);
    if (existing && existing.deviceId !== deviceId) {
      // Different-authority conflict: rejected. This is NOT an idempotent
      // re-PUT — it is another device trying to bind the same key.
      throw new RunTargetError(
        'run_target_already_registered_other_device',
        'Another device has already registered a streaming target for this run interaction',
        409,
      );
    }

    const registeredAt = now();
    const expiry = registeredAt + ttlMs;
    const registeredAtIso = new Date(registeredAt).toISOString();

    let action = 'registered';
    if (existing) {
      // Same-device re-PUT. Idempotent on identical target descriptor;
      // replace + warn on a different value so the swap is visible in the
      // diagnostic counter.
      action = existing.comparisonKey === target.comparisonKey ? 'reaffirmed' : 'replaced';
    }

    const record = {
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
      registeredAt: registeredAtIso,
      expiry,
    };
    records.set(key, record);

    // Log host:port only — the path encodes the page-target secret and must
    // never be logged.
    if (action === 'replaced') {
      // Warn-level so operators see when a manual_action's page identity
      // changed under their feet. The wsUrl itself is never logged; only
      // host/port deltas.
      log('warn', 'run_target_replaced', {
        runId,
        interactionId,
        backend: target.backend,
        host,
        port,
        deviceId,
        reason: record.reason,
      });
    } else if (action === 'registered') {
      log('info', 'run_target_registered', {
        runId,
        interactionId,
        backend: target.backend,
        host,
        port,
        deviceId,
        reason: record.reason,
      });
    }
    // `reaffirmed` is intentionally silent — same value, same device. A
    // log line per retry would be noise.

    return { runId, interactionId, expiry, action };
  }

  function unregister({ runId, interactionId, deviceId }) {
    if (typeof runId !== 'string' || runId.length === 0) return false;
    if (typeof interactionId !== 'string' || interactionId.length === 0) return false;
    const key = compositeKey(runId, interactionId);
    const record = records.get(key);
    if (!record) return false;
    if (record.deviceId !== deviceId) return false;
    records.delete(key);
    log('info', 'run_target_unregistered', { runId, interactionId, deviceId });
    return true;
  }

  /**
   * Forcibly drop a registry entry by (runId, interactionId) without checking
   * the deviceId that registered it. Used by the system (e.g. controller)
   * to clean up when an interaction resolves, bypassing the device-authority
   * check that guards the client-side unregister route. Idempotent: returns
   * true if an entry was removed, false if no entry existed. Logs at info
   * level when an entry is dropped.
   */
  function forceUnregister({ runId, interactionId }) {
    if (typeof runId !== 'string' || runId.length === 0) return false;
    if (typeof interactionId !== 'string' || interactionId.length === 0) return false;
    const key = compositeKey(runId, interactionId);
    const record = records.get(key);
    if (!record) return false;
    records.delete(key);
    log('info', 'run_target_force_unregistered', { runId, interactionId });
    return true;
  }

  function get({ runId, interactionId }) {
    if (typeof runId !== 'string' || runId.length === 0) return null;
    if (typeof interactionId !== 'string' || interactionId.length === 0) return null;
    const key = compositeKey(runId, interactionId);
    const record = records.get(key);
    if (!record) return null;
    if (record.expiry <= now()) {
      records.delete(key);
      log('info', 'run_target_evicted_expired', { runId, interactionId });
      return null;
    }
    if (record.backend === 'neko') return cloneJson(record.descriptor);
    return record.wsUrl;
  }

  /**
   * Debug helper: return an array of records for `runId` (one per
   * interaction). Includes target data because callers inside this process
   * already have the values; callers MUST NOT log URL paths or auth metadata.
   * This is a debugging convenience, not the resolver path — the streaming-
   * companion resolver always uses `get({ runId, interactionId })`.
   */
  function getByRun(runId) {
    if (typeof runId !== 'string' || runId.length === 0) return [];
    const t = now();
    const out = [];
    for (const [key, record] of records) {
      if (record.runId !== runId) continue;
      if (record.expiry <= t) {
        records.delete(key);
        log('info', 'run_target_evicted_expired', {
          runId: record.runId,
          interactionId: record.interactionId,
        });
        continue;
      }
      out.push(record);
    }
    return out;
  }

  /**
   * Mode-A per-run nonce registration. Called by the in-process runtime
   * controller at spawn time. Stores the SHA-256 hash of the nonce keyed
   * by `runId`; the raw nonce is never retained. Overwriting an existing
   * entry for the same runId is allowed (covers the legitimate retry case
   * — controller re-spawns the connector after a crash); the previous
   * nonce is discarded by the overwrite.
   */
  function registerNonce({ runId, nonce }) {
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new RunTargetError('run_target_invalid_url', 'runId is required');
    }
    if (typeof nonce !== 'string' || nonce.length === 0) {
      throw new RunTargetError('run_target_invalid_url', 'nonce is required');
    }
    nonceHashes.set(runId, hashNonce(nonce));
  }

  /**
   * Verify a presented bearer token against the stored nonce hash for
   * `runId`. Returns true when the nonce matches; false otherwise. The
   * comparison is constant-time so timing cannot reveal which characters
   * differ. A nonce that authenticates for run X cannot be used to act
   * on run Y because the lookup is keyed by `runId`. Within a single run
   * the nonce authenticates registrations for ANY interactionId — see
   * the per-run-not-per-interaction comment at `nonceHashes`.
   */
  function verifyNonce({ runId, presentedToken }) {
    if (typeof runId !== 'string' || runId.length === 0) return false;
    if (typeof presentedToken !== 'string' || presentedToken.length === 0) return false;
    const stored = nonceHashes.get(runId);
    if (!stored) return false;
    return constantTimeHexEqual(stored, hashNonce(presentedToken));
  }

  /**
   * Drop the nonce entry for `runId`. Idempotent. Called by the
   * controller's run-end finally block.
   */
  function clearNonce({ runId }) {
    if (typeof runId !== 'string' || runId.length === 0) return;
    nonceHashes.delete(runId);
  }

  /**
   * Extract a Bearer token from an Authorization header, RFC 6750 § 2.1.
   * Returns null when the header is absent or not a Bearer credential.
   */
  function extractBearerToken(req) {
    const header = req?.headers?.authorization || req?.headers?.Authorization;
    if (typeof header !== 'string') return null;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    return m ? m[1].trim() : null;
  }

  function attachRoutes(app, requireDeviceExporterAuth) {
    if (!app || typeof app.put !== 'function' || typeof app.post !== 'function' || typeof app.delete !== 'function') {
      throw new Error('attachRoutes: app must support .put(), .post(), and .delete()');
    }
    if (typeof requireDeviceExporterAuth !== 'function') {
      throw new Error('attachRoutes: requireDeviceExporterAuth middleware is required');
    }

    /**
     * Composed auth middleware: tries the per-run nonce first (cheap
     * in-memory lookup, no DB hit), then falls back to the existing
     * device-exporter middleware. Both paths produce the same authorized
     * state on the request (`req.deviceExporter = { deviceId }`) so the
     * route handler stays mode-agnostic.
     *
     * Why try nonce first: the device-exporter middleware can write its
     * own 401 envelope and end the response, which would mask a valid
     * nonce on the same request. We try the cheaper, more specific path
     * first and only fall through when no nonce credential is present.
     *
     * Nonce scoping reminder: the nonce verifies against `runId` only.
     * The same nonce authenticates registrations for any interactionId
     * within that run. The synthetic deviceId for the nonce path is
     * `nonce:<runId>`, which is unique per run and cannot collide with
     * a real device id (those live in the device-exporter table and have
     * a different prefix). That keeps the existing register/unregister
     * `deviceId` invariants intact at the composite-key level: a different
     * run's nonce cannot displace this run's record.
     */
    function requireAuth(req, res, next) {
      const presented = extractBearerToken(req);
      const runId = req?.params?.runId ? decodeURIComponent(req.params.runId) : '';
      if (presented && runId && verifyNonce({ runId, presentedToken: presented })) {
        req.deviceExporter = { deviceId: `nonce:${runId}` };
        return next();
      }
      // Fall through to the device-exporter middleware. It is responsible
      // for writing the 401 envelope on failure; we do not retry on its
      // outcome.
      return requireDeviceExporterAuth(req, res, next);
    }

    const RESOURCE_PATH =
      '/admin/runs/:runId/interactions/:interactionId/streaming-target';

    function handleRegister(req, res) {
      try {
        const runId = decodeURIComponent(req.params.runId);
        const interactionId = decodeURIComponent(req.params.interactionId);
        const body = req.body || {};
        const descriptor =
          body.target && typeof body.target === 'object'
            ? body.target
            : body.descriptor && typeof body.descriptor === 'object'
              ? body.descriptor
              : undefined;
        const wsUrl = typeof body.ws_url === 'string' ? body.ws_url : body.wsUrl;
        // Forward-compatible metadata. Accept snake_case (the client
        // and the rest of the device-exporter ingest envelope use
        // snake_case) and silently ignore unknown fields.
        const pageUrl = typeof body.page_url === 'string' ? body.page_url : body.pageUrl;
        const pageTitle = typeof body.page_title === 'string' ? body.page_title : body.pageTitle;
        const startUrl = typeof body.start_url === 'string' ? body.start_url : body.startUrl;
        const reason = typeof body.reason === 'string' ? body.reason : undefined;
        const deviceId = req.deviceExporter?.deviceId;
        if (typeof deviceId !== 'string' || deviceId.length === 0) {
          return sendError(
            res,
            403,
            'permission_error',
            'Device exporter authority is required to register a run streaming target',
          );
        }
        const { expiry, action } = register({
          runId,
          interactionId,
          wsUrl,
          ws_url: body.ws_url,
          backend: body.backend,
          baseUrl: body.baseUrl,
          base_url: body.base_url,
          startUrl,
          start_url: body.start_url,
          auth: body.auth,
          descriptor,
          deviceId,
          pageUrl,
          pageTitle,
          reason,
        });
        // Never echo wsUrl back. The caller already has it.
        return res.status(200).json({
          object: 'run_streaming_target',
          run_id: runId,
          interaction_id: interactionId,
          expiry,
          action,
        });
      } catch (err) {
        if (err instanceof RunTargetError) {
          return sendError(res, err.status, err.code, err.message);
        }
        log('warn', 'run_target_register_failed', { error: err?.message });
        return sendError(res, 500, 'server_error', 'Failed to register run streaming target');
      }
    }

    app.put(RESOURCE_PATH, requireAuth, handleRegister);
    app.post(RESOURCE_PATH, requireAuth, handleRegister);

    app.delete(RESOURCE_PATH, requireAuth, (req, res) => {
      try {
        const runId = decodeURIComponent(req.params.runId);
        const interactionId = decodeURIComponent(req.params.interactionId);
        const deviceId = req.deviceExporter?.deviceId;
        if (typeof deviceId !== 'string' || deviceId.length === 0) {
          return sendError(
            res,
            403,
            'permission_error',
            'Device exporter authority is required to unregister a run streaming target',
          );
        }
        const removed = unregister({ runId, interactionId, deviceId });
        if (!removed) {
          return sendError(
            res,
            404,
            'not_found',
            'No streaming target is registered for this run interaction by this device',
          );
        }
        return res.status(200).json({
          object: 'run_streaming_target_deleted',
          run_id: runId,
          interaction_id: interactionId,
        });
      } catch (err) {
        log('warn', 'run_target_unregister_failed', { error: err?.message });
        return sendError(res, 500, 'server_error', 'Failed to unregister run streaming target');
      }
    });
  }

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
    records.clear();
    nonceHashes.clear();
  }

  // Process-exit eviction: when the surrounding server runs as a long-lived
  // process, `exit` fires once on tear-down and the timer + records are
  // released. Tests construct many registries in one process; explicit
  // `shutdown()` is the supported idiom there. We do not attach a
  // `beforeExit` listener per-registry to avoid accumulating handlers and
  // emitting MaxListenersExceeded warnings under test concurrency.

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
      records,
      nonceHashes,
      ttlMs,
    },
  };
}
