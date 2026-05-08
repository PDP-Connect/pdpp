import { createCdpCompanion } from './cdp-adapter.js';
import { createNekoCompanion } from './neko-adapter.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;

function createMissingTargetError(backend = 'streaming') {
  const err = new Error(`No ${backend} target registered for this run`);
  err.code = 'streaming_target_unregistered';
  return err;
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeCdpTarget(target) {
  if (typeof target === 'string' && target.length > 0) return target;
  if (!target || typeof target !== 'object') return null;
  return (
    optionalString(target.wsUrl) ||
    optionalString(target.ws_url) ||
    optionalString(target.cdp?.wsUrl) ||
    optionalString(target.cdp?.ws_url)
  );
}

function normalizeNekoTarget(target) {
  if (!target || typeof target !== 'object') return null;
  const source = target.neko && typeof target.neko === 'object' ? target.neko : target;
  const origin =
    optionalString(source.origin) ||
    optionalString(source.base_url) ||
    optionalString(source.baseUrl) ||
    optionalString(target.base_url) ||
    optionalString(target.baseUrl);
  if (!origin) return null;
  return { ...source, origin, base_url: origin };
}

function selectBackendTarget(target) {
  const backend = typeof target?.backend === 'string' ? target.backend : null;
  if (backend === 'neko') {
    const neko = normalizeNekoTarget(target);
    if (!neko) throw createMissingTargetError('n.eko');
    return { backend: 'neko', neko };
  }

  const wsUrl = normalizeCdpTarget(target);
  if (wsUrl) return { backend: 'cdp', wsUrl };

  const neko = normalizeNekoTarget(target);
  if (neko) return { backend: 'neko', neko };

  throw createMissingTargetError(backend || 'streaming');
}

function safeLog(logger, level, msg, data) {
  if (!logger || typeof logger[level] !== 'function') return;
  try {
    logger[level]({ msg, ...(data || {}) });
  } catch {
    /* logger errors must not break the streaming path */
  }
}

function createResolvedCompanion({
  run_id,
  interaction_id,
  browser_session_id,
  resolveTargetForInteraction,
  WebSocketCtor,
  fetchImpl,
  logger,
  commandTimeoutMs,
  openTimeoutMs,
  neko = {},
}) {
  let inner = null;
  let closed = false;
  let backend = null;
  let nekoTarget = null;
  const pendingFrames = new Map();
  const pendingEvents = new Map();

  function bindPending(next) {
    inner = next;
    for (const record of pendingFrames.values()) {
      record.innerUnsubscribe = inner.onFrame(record.handler);
    }
    if (typeof inner.onEvent === 'function') {
      for (const record of pendingEvents.values()) {
        record.innerUnsubscribe = inner.onEvent(record.handler);
      }
    }
  }

  function subscribe(pending, method, handler) {
    if (inner && typeof inner[method] === 'function') return inner[method](handler);
    const record = { handler, innerUnsubscribe: null };
    pending.set(handler, record);
    return () => {
      pending.delete(handler);
      if (record.innerUnsubscribe) {
        try {
          record.innerUnsubscribe();
        } catch {
          /* unsubscribe is best-effort */
        }
      }
    };
  }

  async function ensureInner() {
    if (inner) return inner;
    const resolved = await Promise.resolve(resolveTargetForInteraction(run_id, interaction_id));
    if (!resolved) throw createMissingTargetError();

    const selected = selectBackendTarget(resolved);
    backend = selected.backend;
    safeLog(logger, 'info', 'streaming_backend_selected', {
      run_id,
      interaction_id,
      browser_session_id,
      backend,
    });

    if (selected.backend === 'neko') {
      nekoTarget = selected.neko;
      bindPending(
        createNekoCompanion({
          ...neko,
          target: selected.neko,
          origin: selected.neko.origin,
          browser_session_id,
          fetchImpl,
          WebSocketCtor,
          logger,
        }),
      );
      return inner;
    }

    bindPending(
      createCdpCompanion({
        wsUrl: selected.wsUrl,
        browser_session_id,
        WebSocketCtor,
        logger,
        commandTimeoutMs,
        openTimeoutMs,
      }),
    );
    return inner;
  }

  return {
    get backend() {
      return backend || inner?.backend || 'cdp';
    },
    browser_session_id,
    async start(viewport) {
      if (closed) {
        const err = new Error('Streaming companion is closed');
        err.code = 'companion_closed';
        throw err;
      }
      const companion = await ensureInner();
      await companion.start(viewport);
    },
    async stop() {
      if (closed) return;
      closed = true;
      if (inner) await inner.stop();
      pendingFrames.clear();
      pendingEvents.clear();
    },
    onFrame(handler) {
      return subscribe(pendingFrames, 'onFrame', handler);
    },
    onEvent(handler) {
      return subscribe(pendingEvents, 'onEvent', handler);
    },
    async dispatch(event) {
      const companion = await ensureInner();
      await companion.dispatch(event);
    },
    async ackFrame(sessionId) {
      if (!inner || typeof inner.ackFrame !== 'function') return;
      await inner.ackFrame(sessionId);
    },
    async queryNekoStatus() {
      const companion = await ensureInner();
      if (typeof companion.queryNekoStatus !== 'function') return null;
      return companion.queryNekoStatus();
    },
    getNekoProxyTarget() {
      if (inner && typeof inner.getNekoProxyTarget === 'function') {
        return inner.getNekoProxyTarget();
      }
      if (!nekoTarget) return null;
      return { origin: nekoTarget.origin };
    },
    /** test-only escape hatch */
    _internal: {
      hasInner: () => inner !== null,
      isClosed: () => closed,
      getBackend: () => backend,
    },
  };
}

export function createDefaultStreamingCompanionFactory({
  resolveTargetForInteraction,
  WebSocketCtor = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  logger,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
  neko,
} = {}) {
  if (typeof resolveTargetForInteraction !== 'function') return null;
  if (typeof WebSocketCtor !== 'function') {
    throw new Error('createDefaultStreamingCompanionFactory: no WebSocket constructor available');
  }

  return ({ run_id, interaction_id, browser_session_id }) => {
    if (typeof run_id !== 'string' || run_id.length === 0) return null;
    if (typeof interaction_id !== 'string' || interaction_id.length === 0) return null;
    return createResolvedCompanion({
      run_id,
      interaction_id,
      browser_session_id,
      resolveTargetForInteraction,
      WebSocketCtor,
      fetchImpl,
      logger,
      commandTimeoutMs,
      openTimeoutMs,
      neko,
    });
  };
}
