// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real CDP companion adapter.
 *
 * Connects to a Chrome DevTools Protocol page-target WebSocket URL and speaks
 * JSON-RPC directly. We deliberately avoid Playwright/Puppeteer here — the
 * reference server should not pull a heavyweight browser-automation library
 * in just to relay input and frames.
 *
 * The adapter resolves the page-target ws URL through the
 * `(runId, interactionId)`-keyed registry (`run-target-registry.js`), which
 * the connector runtime / browser binding populates when a manual_action
 * interaction is created. Legacy env-var entry points
 * (`PDPP_RUN_INTERACTION_CDP_WS_URL`, `PDPP_RUN_INTERACTION_CDP_HTTP_URL`)
 * have been removed; the registry path is the only supported wireup.
 *
 * Wire mapping is delegated to `mapInputEventToCdp` / `buildScreencastParams`
 * in `cdp-companion.js`, which keeps frame/input shape identical to the mock
 * companion so tests cover the protocol surface deterministically.
 *
 * Lifecycle:
 *   createCdpCompanion({ wsUrl, ... }) → companion handle
 *     start(viewport)  - opens ws (lazily), enables Page domain, sets device
 *                        metrics, starts screencast.
 *     stop()           - stops screencast, closes ws.
 *     onFrame(handler) - subscribe to decoded `Page.screencastFrame` events.
 *     dispatch(event)  - run wire input event through `mapInputEventToCdp`,
 *                        send each command, await Page acks.
 *     ackFrame(id)     - send `Page.screencastFrameAck` so the next frame is
 *                        delivered (back-pressure).
 *
 * The adapter is intentionally tolerant: a single dropped command must not
 * crash the streaming session. Errors propagate via `start()` (which the route
 * surfaces to the viewer as an `error` SSE event) and via `dispatch()` (which
 * surfaces as a 4xx on the input POST).
 */
import { buildScreencastParams, mapInputEventToCdp } from './cdp-companion.ts';

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;

function codedError(message, code, properties = {}) {
  return Object.assign(new Error(message), { code, ...properties });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function createLogger(logger, context) {
  return (level, msg, data) => {
    const write = logger?.[level];
    if (typeof write !== 'function') return;
    try {
      write.call(logger, { msg, ...context, ...(data || {}) });
    } catch {
      /* logger errors must not break the streaming path */
    }
  };
}

function unsubscribe(record) {
  if (!record.innerUnsubscribe) return;
  try {
    record.innerUnsubscribe();
  } catch {
    /* unsubscribe is best-effort */
  }
  record.innerUnsubscribe = null;
}

function createDeferredSubscribers() {
  const records = new Map();
  return {
    add(handler) {
      const record = { handler, innerUnsubscribe: null };
      records.set(handler, record);
      return () => {
        records.delete(handler);
        unsubscribe(record);
      };
    },
    adopt(subscribe) {
      for (const record of records.values()) {
        record.innerUnsubscribe = subscribe(record.handler);
      }
    },
    clear() {
      records.clear();
    },
  };
}

function hasInteractionIdentity({ run_id, interaction_id }) {
  return isNonEmptyString(run_id) && isNonEmptyString(interaction_id);
}

function notifyHandlers(handlers, value, log, message, details = {}) {
  for (const handler of handlers) {
    try {
      handler(value);
    } catch (err) {
      log('warn', message, { error: err?.message, ...details });
    }
  }
}

function pageTargetInfo(params) {
  const info = params?.targetInfo;
  if (!isObject(info)) return null;
  return info.type === 'page' ? info : null;
}

function mainFrameUrl(params) {
  const frame = params?.frame;
  if (!isObject(frame) || frame.parentId) return null;
  return typeof frame.url === 'string' ? frame.url : null;
}

function urlChangedEvent(url, title) {
  const event = { kind: 'url_changed', url };
  if (isNonEmptyString(title)) event.title = title;
  return event;
}

function popupOpenedEvent(info) {
  return {
    kind: 'popup_opened',
    targetId: info.targetId,
    url: typeof info.url === 'string' ? info.url : '',
  };
}

function createCdpEventRouter({ emitFrame, emitEvent }) {
  const state = {
    lastEmittedUrl: null,
    lastKnownTitle: null,
    ownPageTargetId: null,
    knownPageTargetIds: new Set(),
  };

  function emitUrlChanged(url) {
    if (!isNonEmptyString(url) || url === state.lastEmittedUrl) return;
    state.lastEmittedUrl = url;
    emitEvent(urlChangedEvent(url, state.lastKnownTitle));
  }

  function rememberOwnPage(info) {
    state.ownPageTargetId = info.targetId || null;
    state.knownPageTargetIds.add(info.targetId);
    if (isNonEmptyString(info.title)) state.lastKnownTitle = info.title;
  }

  function handleTargetCreated(params) {
    const info = pageTargetInfo(params);
    if (!info) return;
    if (state.ownPageTargetId === null) {
      rememberOwnPage(info);
      return;
    }
    state.knownPageTargetIds.add(info.targetId);
    emitEvent(popupOpenedEvent(info));
  }

  function handleTargetDestroyed(params) {
    const targetId = params?.targetId;
    if (!isNonEmptyString(targetId)) return;
    if (!isKnownPopup(targetId)) return;
    state.knownPageTargetIds.delete(targetId);
    emitEvent({ kind: 'popup_closed', targetId });
  }

  function isKnownPopup(targetId) {
    return targetId !== state.ownPageTargetId && state.knownPageTargetIds.has(targetId);
  }

  function handleOwnTargetInfo(info) {
    if (typeof info.title === 'string') state.lastKnownTitle = info.title;
    if (typeof info.url === 'string') emitUrlChanged(info.url);
  }

  function handleTargetInfoChanged(params) {
    const info = pageTargetInfo(params);
    if (!info) return;
    if (state.ownPageTargetId !== null && info.targetId !== state.ownPageTargetId) return;
    handleOwnTargetInfo(info);
  }

  const handlers = {
    'Page.screencastFrame': emitFrame,
    'Page.frameNavigated': (params) => emitUrlChanged(mainFrameUrl(params)),
    'Target.targetCreated': handleTargetCreated,
    'Target.targetDestroyed': handleTargetDestroyed,
    'Target.targetInfoChanged': handleTargetInfoChanged,
  };

  return (method, params) => handlers[method]?.(params);
}

/**
 * Build the default companion factory.
 *
 * The factory requires `resolveTargetForInteraction(runId, interactionId)`,
 * which the AS app wires to the run-target registry
 * (`runTargetRegistry.get`). The connector runtime (or browser binding)
 * registers a per-(run, interaction) CDP page-target ws URL when it
 * decides which page the human should control; the resolver hands it to
 * the companion at attach time.
 *
 * The resolver signature is `(runId, interactionId)` — both arguments are
 * required because the registry is keyed by the composite. A run may have
 * multiple manual_action interactions over its lifetime, each bound to a
 * potentially-different page; "what page should the operator see?" is
 * always answered against the specific interaction.
 *
 * Behavior:
 *   - No resolver supplied → return `null`. The mint route fails closed with
 *     503 `streaming_companion_unavailable` rather than handing out a token
 *     that only errors at attach time.
 *   - Resolver supplied → return a factory that defers the wsUrl lookup until
 *     `start()`. This lets the connector runtime register between mint and
 *     attach. If the resolver returns null at start time, start() rejects
 *     with `streaming_target_unregistered`.
 *
 * `WebSocketCtor` is injectable for tests (a fake CDP server can hand back its
 * own ws constructor).
 */
export function createDefaultStreamingCompanionFactory({
  resolveTargetForInteraction,
  WebSocketCtor = globalThis.WebSocket,
  logger,
  commandTimeoutMs,
  openTimeoutMs,
} = {}) {
  if (typeof resolveTargetForInteraction !== 'function') return null;
  if (typeof WebSocketCtor !== 'function') {
    throw new Error('createDefaultStreamingCompanionFactory: no WebSocket constructor available');
  }

  return ({ run_id, interaction_id, browser_session_id }) => {
    if (!hasInteractionIdentity({ run_id, interaction_id })) return null;
    return createResolvedCompanion({
      run_id,
      interaction_id,
      browser_session_id,
      resolveTargetForInteraction,
      WebSocketCtor,
      logger,
      commandTimeoutMs,
      openTimeoutMs,
    });
  };
}

/**
 * Resolve-by-(run, interaction) companion. Defers the wsUrl lookup until
 * `start()` so the connector runtime / browser binding can register its
 * CDP target between mint and attach. If no record is registered by the
 * time start() runs, the companion rejects with
 * `streaming_target_unregistered`.
 */
function createResolvedCompanion({
  run_id,
  interaction_id,
  browser_session_id,
  resolveTargetForInteraction,
  WebSocketCtor,
  logger,
  commandTimeoutMs,
  openTimeoutMs,
}) {
  let inner = null;
  let closed = false;
  const pendingFrames = createDeferredSubscribers();
  const pendingEvents = createDeferredSubscribers();
  const log = createLogger(logger, { run_id, interaction_id, browser_session_id });

  function adoptInner(next) {
    inner = next;
    pendingFrames.adopt((handler) => inner.onFrame(handler));
    pendingEvents.adopt((handler) => inner.onEvent(handler));
  }

  async function resolveInner() {
    if (inner) return;
    const wsUrl = await Promise.resolve(resolveTargetForInteraction(run_id, interaction_id));
    if (!wsUrl) throw codedError('No streaming target registered for this run', 'streaming_target_unregistered');
    log('info', 'cdp_resolver_hit', {});
    adoptInner(createCdpCompanion({
      wsUrl,
      browser_session_id,
      WebSocketCtor,
      logger,
      commandTimeoutMs,
      openTimeoutMs,
    }));
  }

  async function startInner(viewport) {
    if (closed) throw codedError('Streaming companion is closed', 'companion_closed');
    await resolveInner();
    await inner.start(viewport);
  }

  async function stopInner() {
    if (!inner) return;
    try {
      await inner.stop();
    } catch (err) {
      log('warn', 'cdp_inner_stop_failed', { error: err?.message });
    }
  }

  return {
    browser_session_id,
    async start(viewport) {
      await startInner(viewport);
    },
    async stop() {
      if (closed) return;
      closed = true;
      await stopInner();
      // Drop pre-start handler records that never got bound to an inner
      // companion (e.g. companion was stopped before start() ever ran).
      // Without this, a long-lived factory could accumulate references.
      pendingFrames.clear();
      pendingEvents.clear();
    },
    onFrame(handler) {
      if (inner) return inner.onFrame(handler);
      return pendingFrames.add(handler);
    },
    onEvent(handler) {
      if (inner) return inner.onEvent(handler);
      return pendingEvents.add(handler);
    },
    async dispatch(event) {
      if (!inner) throw codedError('Streaming companion is not started', 'companion_not_started');
      return inner.dispatch(event);
    },
    async ackFrame(sessionId) {
      if (!inner) return;
      return inner.ackFrame(sessionId);
    },
    /** test-only escape hatch */
    _internal: {
      isClosed: () => closed,
      hasInner: () => inner !== null,
    },
  };
}

/**
 * Connects to a CDP page target WebSocket and exposes the streaming-companion
 * interface used by `routes.js`.
 */
export function createCdpCompanion({
  wsUrl,
  browser_session_id,
  WebSocketCtor = globalThis.WebSocket,
  logger,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
} = {}) {
  if (typeof wsUrl !== 'string' || wsUrl.length === 0) {
    throw new Error('createCdpCompanion: wsUrl is required');
  }
  if (typeof WebSocketCtor !== 'function') {
    throw new Error('createCdpCompanion: WebSocket constructor is required');
  }

  const log = createLogger(logger, { browser_session_id });

  const frameHandlers = new Set();
  const eventHandlers = new Set();
  const pending = new Map(); // id → { resolve, reject, timer }
  let nextId = 1;
  let ws = null;
  let openPromise = null;
  let started = false;
  let closed = false;

  let lastFrame = null;

  function emitFrame(params) {
    // Wire shape mirrors the mock companion so the route writes identical SSE.
    const frame = {
      sessionId: params.sessionId,
      data: params.data,
      metadata: params.metadata || null,
    };
    lastFrame = frame;
    notifyHandlers(frameHandlers, frame, log, 'cdp_frame_handler_error');
  }

  function emitEvent(event) {
    // Out-of-band events: { kind, ...payload }. The route layer fans these
    // out as named SSE events (event: url_changed, popup_opened, ...).
    notifyHandlers(eventHandlers, event, log, 'cdp_event_handler_error', { kind: event?.kind });
  }

  const routeCdpEvent = createCdpEventRouter({ emitFrame, emitEvent });

  function closedCdpError(reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason || 'cdp_closed'));
    error.code ||= 'cdp_closed';
    return error;
  }

  function rejectPending(entry, err) {
    clearTimeout(entry.timer);
    entry.reject(err);
  }

  function rejectAllPending(reason) {
    const err = closedCdpError(reason);
    for (const [, entry] of pending) {
      rejectPending(entry, err);
    }
    pending.clear();
  }

  function cdpResponseError(error) {
    return codedError(error.message || 'cdp_error', 'cdp_error', { cdp: error });
  }

  function settleCommandResponse(entry, msg) {
    if (msg.error) return entry.reject(cdpResponseError(msg.error));
    entry.resolve(msg.result || {});
  }

  function handleCommandResponse(msg) {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    settleCommandResponse(entry, msg);
  }

  function handleCdpEvent(msg) {
    routeCdpEvent(msg.method, msg.params || {});
  }

  function parseCdpMessage(raw) {
    return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  }

  function parseMessageOrNull(raw) {
    try {
      const msg = parseCdpMessage(raw);
      return isObject(msg) ? msg : null;
    } catch (err) {
      log('warn', 'cdp_message_parse_failed', { error: err?.message });
      return null;
    }
  }

  function dispatchCdpMessage(msg) {
    if ('id' in msg) {
      handleCommandResponse(msg);
      return;
    }
    if (typeof msg.method === 'string') handleCdpEvent(msg);
  }

  function handleMessage(raw) {
    const msg = parseMessageOrNull(raw);
    if (msg) dispatchCdpMessage(msg);
  }

  function attachSocketListeners(socket, handlers, reject) {
    // Both standard WebSocket (browser/native) and `ws` library expose
    // `addEventListener` and `on` patterns. Prefer the standard one.
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', handlers.onOpen);
      socket.addEventListener('error', handlers.onError);
      socket.addEventListener('close', handlers.onClose);
      socket.addEventListener('message', handlers.onMessage);
    } else if (typeof socket.on === 'function') {
      socket.on('open', handlers.onOpen);
      socket.on('error', handlers.onError);
      socket.on('close', handlers.onClose);
      socket.on('message', handlers.onMessage);
    } else {
      const e = new Error('Unsupported WebSocket implementation');
      e.code = 'cdp_socket_unsupported';
      reject(e);
    }
  }

  function createOpenSocketHandlers(socket, openTimer, resolve, reject) {
    const onOpen = () => {
      clearTimeout(openTimer);
      log('info', 'cdp_connected');
      resolve();
    };
    const onError = (event) => {
      clearTimeout(openTimer);
      const message = event?.message || event?.error?.message || 'cdp websocket error';
      const e = new Error(message);
      e.code = 'cdp_socket_error';
      if (ws === socket) rejectAllPending(e);
      reject(e);
    };
    const onClose = () => {
      clearTimeout(openTimer);
      const e = new Error('CDP websocket closed');
      e.code = 'cdp_closed';
      if (ws === socket) rejectAllPending(e);
      ws = null;
      openPromise = null;
    };
    const onMessage = (event) => {
      handleMessage(event && 'data' in event ? event.data : event);
    };

    return { onOpen, onError, onClose, onMessage };
  }

  function openCdpSocket(resolve, reject) {
    let socket;
    try {
      socket = new WebSocketCtor(wsUrl);
    } catch (err) {
      const e = new Error(`Failed to connect to CDP: ${err?.message || err}`);
      e.code = 'cdp_connect_failed';
      reject(e);
      return;
    }
    ws = socket;
    const openTimer = setTimeout(() => {
      const e = new Error(`CDP connection timed out after ${openTimeoutMs}ms`);
      e.code = 'cdp_connect_timeout';
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(e);
    }, openTimeoutMs);

    attachSocketListeners(socket, createOpenSocketHandlers(socket, openTimer, resolve, reject), reject);
  }

  function isOpenSocket(socket) {
    return socket && socket.readyState === 1;
  }

  function openCompanionError() {
    return codedError('Streaming companion is closed', 'companion_closed');
  }

  function existingOpenPromise() {
    if (closed) return Promise.reject(openCompanionError());
    if (isOpenSocket(ws)) return Promise.resolve();
    return openPromise;
  }

  function ensureOpen() {
    const existing = existingOpenPromise();
    if (existing) return existing;
    openPromise = new Promise((resolve, reject) => {
      openCdpSocket(resolve, reject);
    }).catch((err) => {
      openPromise = null;
      throw err;
    });

    return openPromise;
  }

  function registerPendingCommand(method, resolve, reject) {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(codedError(`CDP command ${method} timed out`, 'cdp_timeout'));
      }
    }, commandTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    return { id, timer };
  }

  function sendRegisteredCommand(socket, id, method, params, timer, reject) {
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(codedError(`Failed to send CDP command ${method}: ${err?.message || err}`, 'cdp_send_failed'));
    }
  }

  function sendOpenCdpCommand(method, params) {
    return new Promise((resolve, reject) => {
      const socket = ws;
      if (!isOpenSocket(socket)) return reject(codedError('CDP websocket is not open', 'cdp_not_open'));
      const { id, timer } = registerPendingCommand(method, resolve, reject);
      sendRegisteredCommand(socket, id, method, params, timer, reject);
    });
  }

  function send(method, params = {}) {
    return ensureOpen().then(() => sendOpenCdpCommand(method, params));
  }

  async function setTargetDiscovery(discover, failureLog) {
    await send('Target.setDiscoverTargets', { discover }).catch((err) => {
      if (failureLog) log('warn', failureLog, { error: err?.message });
    });
  }

  function hasViewportDimensions(viewport) {
    return viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height);
  }

  function deviceMetricsParams(viewport) {
    return {
      width: Math.floor(viewport.width),
      height: Math.floor(viewport.height),
      deviceScaleFactor: Number.isFinite(viewport.deviceScaleFactor) ? Number(viewport.deviceScaleFactor) : 1,
      mobile: viewport.mobile === true,
    };
  }

  async function setDeviceMetrics(viewport) {
    if (!hasViewportDimensions(viewport)) return;
    await send('Emulation.setDeviceMetricsOverride', deviceMetricsParams(viewport)).catch((err) => {
      log('warn', 'cdp_set_device_metrics_failed', { error: err?.message });
    });
  }

  async function start(viewport) {
    if (started) return;
    await ensureOpen();
    await send('Page.enable');
    await setTargetDiscovery(true, 'cdp_target_discovery_failed');
    await setDeviceMetrics(viewport);
    await send('Page.startScreencast', buildScreencastParams({ viewport }));
    started = true;
  }

  async function bestEffortSend(method, params) {
    try {
      await send(method, params);
    } catch {
      /* best-effort */
    }
  }

  async function stopStreaming() {
    if (!started) return;
    await bestEffortSend('Target.setDiscoverTargets', { discover: false });
    await bestEffortSend('Page.stopScreencast');
    started = false;
  }

  function closeSocket() {
    if (!ws) return;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  function clearCompanionState() {
    rejectAllPending(codedError('Streaming companion stopped', 'companion_stopped'));
    openPromise = null;
    frameHandlers.clear();
    eventHandlers.clear();
    lastFrame = null;
  }

  async function stop() {
    if (closed) return;
    closed = true;
    await stopStreaming();
    closeSocket();
    clearCompanionState();
  }

  function onFrame(handler) {
    frameHandlers.add(handler);
    if (lastFrame) {
      try {
        handler(lastFrame);
      } catch (err) {
        log('warn', 'cdp_frame_handler_error', { error: err?.message });
      }
    }
    return () => frameHandlers.delete(handler);
  }

  function onEvent(handler) {
    eventHandlers.add(handler);
    return () => eventHandlers.delete(handler);
  }

  async function dispatch(event) {
    const commands = mapInputEventToCdp(event);
    for (const cmd of commands) {
      // Errors here are surfaced to the route which returns a 4xx with the
      // CDP-side message. We do not retry: the viewer can resend.
      // eslint-disable-next-line no-await-in-loop
      await send(cmd.method, cmd.params);
    }
  }

  async function ackFrame(sessionId) {
    if (!Number.isFinite(sessionId)) return;
    try {
      await send('Page.screencastFrameAck', { sessionId: Number(sessionId) });
    } catch (err) {
      // A failed ack can stall future frames, but failing the input POST or
      // tearing the SSE is worse UX. Log and let the next ack recover.
      log('warn', 'cdp_screencast_ack_failed', { error: err?.message });
    }
  }

  return {
    browser_session_id,
    start,
    stop,
    onFrame,
    onEvent,
    dispatch,
    ackFrame,
    /** test-only escape hatch */
    _internal: {
      send,
      isStarted: () => started,
      isClosed: () => closed,
    },
  };
}
