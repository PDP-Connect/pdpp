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
    if (typeof run_id !== 'string' || run_id.length === 0) {
      // No runId means we cannot consult the resolver. Fail closed by
      // returning null so the route layer can surface a clear error rather
      // than silently constructing a companion that has no target.
      return null;
    }
    if (typeof interaction_id !== 'string' || interaction_id.length === 0) {
      // The registry is composite-keyed; without an interactionId we have
      // no key to look up. Fail closed for the same reason as above.
      return null;
    }
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
  const pendingHandlers = new Map();

  const log = (level, msg, data) => {
    if (!logger || typeof logger[level] !== 'function') return;
    try {
      logger[level]({ msg, run_id, interaction_id, browser_session_id, ...(data || {}) });
    } catch {
      /* logger errors must not break the streaming path */
    }
  };

  function adoptInner(next) {
    inner = next;
    for (const record of pendingHandlers.values()) {
      record.innerUnsubscribe = inner.onFrame(record.handler);
    }
  }

  // Pre-start `onEvent` subscribers for out-of-band wire events (URL changes,
  // popups). Mirrors `pendingHandlers` for frames so the route layer can wire
  // a handler immediately after `companion = factory(...)`, before
  // `companion.start()` resolves the underlying CDP target.
  const pendingEventHandlers = new Map();

  function adoptInnerForEvents() {
    for (const record of pendingEventHandlers.values()) {
      record.innerUnsubscribe = inner.onEvent(record.handler);
    }
  }

  // Wrap adoptInner to also bind event handlers when the inner appears.
  const baseAdoptInner = adoptInner;
  function adoptInnerWithEvents(next) {
    baseAdoptInner(next);
    adoptInnerForEvents();
  }

  return {
    browser_session_id,
    async start(viewport) {
      if (closed) {
        const e = new Error('Streaming companion is closed');
        e.code = 'companion_closed';
        throw e;
      }
      if (!inner) {
        const wsUrl = await Promise.resolve(resolveTargetForInteraction(run_id, interaction_id));
        if (!wsUrl) {
          const e = new Error('No streaming target registered for this run');
          e.code = 'streaming_target_unregistered';
          throw e;
        }
        log('info', 'cdp_resolver_hit', {});
        adoptInnerWithEvents(
          createCdpCompanion({
            wsUrl,
            browser_session_id,
            WebSocketCtor,
            logger,
            commandTimeoutMs,
            openTimeoutMs,
          }),
        );
      }
      await inner.start(viewport);
    },
    async stop() {
      if (closed) return;
      closed = true;
      if (inner) {
        try {
          await inner.stop();
        } catch (err) {
          log('warn', 'cdp_inner_stop_failed', { error: err?.message });
        }
      }
      // Drop pre-start handler records that never got bound to an inner
      // companion (e.g. companion was stopped before start() ever ran).
      // Without this, a long-lived factory could accumulate references.
      pendingHandlers.clear();
      pendingEventHandlers.clear();
    },
    onFrame(handler) {
      if (inner) return inner.onFrame(handler);
      const record = { handler, innerUnsubscribe: null };
      pendingHandlers.set(handler, record);
      return () => {
        pendingHandlers.delete(handler);
        if (record.innerUnsubscribe) {
          try {
            record.innerUnsubscribe();
          } catch {
            /* unsubscribe is best-effort */
          }
          record.innerUnsubscribe = null;
        }
      };
    },
    onEvent(handler) {
      if (inner) return inner.onEvent(handler);
      const record = { handler, innerUnsubscribe: null };
      pendingEventHandlers.set(handler, record);
      return () => {
        pendingEventHandlers.delete(handler);
        if (record.innerUnsubscribe) {
          try {
            record.innerUnsubscribe();
          } catch {
            /* unsubscribe is best-effort */
          }
          record.innerUnsubscribe = null;
        }
      };
    },
    async dispatch(event) {
      if (!inner) {
        const e = new Error('Streaming companion is not started');
        e.code = 'companion_not_started';
        throw e;
      }
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

  const log = (level, msg, data) => {
    if (!logger || typeof logger[level] !== 'function') return;
    try {
      logger[level]({ msg, browser_session_id, ...(data || {}) });
    } catch {
      /* logger errors must not propagate into the streaming path */
    }
  };

  const frameHandlers = new Set();
  const eventHandlers = new Set();
  const pending = new Map(); // id → { resolve, reject, timer }
  let nextId = 1;
  let ws = null;
  let openPromise = null;
  let started = false;
  let closed = false;

  // Out-of-band wire event state. We cache the last URL/title we emitted so we
  // do not flood the viewer with redundant `url_changed` events when CDP
  // re-fires a `frameNavigated` for the same destination, and so a
  // `Target.targetInfoChanged` that only updates the title can still attach
  // the title onto subsequent URL events. Targets we have seen as `page` are
  // tracked so `targetDestroyed` only emits `popup_closed` for ones we
  // previously announced.
  let lastEmittedUrl = null;
  let lastKnownTitle = null;
  const knownPageTargetIds = new Set();
  // Best-effort: once we observe our own `attached` page target we remember
  // its targetId so we can attribute targetInfoChanged events that update
  // *our* title rather than a popup's.
  let ownPageTargetId = null;
  let lastFrame = null;

  function emitFrame(params) {
    // Wire shape mirrors the mock companion so the route writes identical SSE.
    const frame = {
      sessionId: params.sessionId,
      data: params.data,
      metadata: params.metadata || null,
    };
    lastFrame = frame;
    for (const handler of frameHandlers) {
      try {
        handler(frame);
      } catch (err) {
        log('warn', 'cdp_frame_handler_error', { error: err?.message });
      }
    }
  }

  function emitEvent(event) {
    // Out-of-band events: { kind, ...payload }. The route layer fans these
    // out as named SSE events (event: url_changed, popup_opened, ...).
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        log('warn', 'cdp_event_handler_error', { error: err?.message, kind: event?.kind });
      }
    }
  }

  function maybeEmitUrlChanged(url) {
    if (typeof url !== 'string' || url.length === 0) return;
    if (url === lastEmittedUrl) return;
    lastEmittedUrl = url;
    const payload = { kind: 'url_changed', url };
    if (typeof lastKnownTitle === 'string' && lastKnownTitle.length > 0) {
      payload.title = lastKnownTitle;
    }
    emitEvent(payload);
  }

  function handlePageFrameNavigated(params) {
    const frame = params && params.frame;
    if (!frame || typeof frame !== 'object') return;
    // `Page.frameNavigated` fires for sub-frames (iframes) too. The main frame
    // is the only one whose URL is interesting to the operator and is
    // identifiable by the absence of `parentId`. Filtering avoids flooding the
    // viewer with iframe nav noise (ads, oauth child frames, etc.).
    if (frame.parentId) return;
    if (typeof frame.url !== 'string') return;
    maybeEmitUrlChanged(frame.url);
  }

  function handleTargetCreated(params) {
    const info = params && params.targetInfo;
    if (!info || typeof info !== 'object') return;
    if (info.type !== 'page') return;
    // The connector's own page target also flows through targetCreated when
    // discovery is first turned on. We treat any *additional* page target as
    // a popup so the operator sees auth flows, callback windows, etc. The
    // initial page is the one our adapter is connected to — but we cannot
    // reliably know its targetId from the per-target session, so the first
    // `targetCreated` we see (which corresponds to our own page when discovery
    // initially enumerates) gets recorded as `ownPageTargetId` and suppressed.
    if (ownPageTargetId === null) {
      ownPageTargetId = info.targetId || null;
      knownPageTargetIds.add(info.targetId);
      // Capture the initial title for our page so the first url_changed event
      // can include it.
      if (typeof info.title === 'string' && info.title.length > 0) {
        lastKnownTitle = info.title;
      }
      return;
    }
    knownPageTargetIds.add(info.targetId);
    emitEvent({
      kind: 'popup_opened',
      targetId: info.targetId,
      url: typeof info.url === 'string' ? info.url : '',
    });
  }

  function handleTargetDestroyed(params) {
    const targetId = params && params.targetId;
    if (typeof targetId !== 'string' || targetId.length === 0) return;
    // Only emit `popup_closed` for targets we previously announced as popups.
    // The operator's own page target closing means the session is going away
    // entirely; teardown is handled by the existing socket-close path.
    if (targetId === ownPageTargetId) return;
    if (!knownPageTargetIds.has(targetId)) return;
    knownPageTargetIds.delete(targetId);
    emitEvent({ kind: 'popup_closed', targetId });
  }

  function handleTargetInfoChanged(params) {
    const info = params && params.targetInfo;
    if (!info || typeof info !== 'object') return;
    if (info.type !== 'page') return;
    // For *our* page target, `targetInfoChanged` is the most reliable carrier
    // for the page title (Page.getTitle is in the Runtime/DOM neighborhood we
    // forbid under the patchright stealth allowlist). Cache it and let the
    // next `url_changed` pick it up.
    if (ownPageTargetId === null || info.targetId === ownPageTargetId) {
      if (typeof info.title === 'string') {
        lastKnownTitle = info.title;
      }
      // SPA in-document nav also fires `targetInfoChanged` with a new URL but
      // no `Page.frameNavigated`. Forward that path so SPA route changes also
      // produce a `url_changed` event.
      if (typeof info.url === 'string') {
        maybeEmitUrlChanged(info.url);
      }
      return;
    }
    // For a popup target whose URL has changed, no spec'd wire event covers
    // this today. We could add `popup_url_changed` later if the viewer asks
    // for it; for now we only emit on open/close.
  }

  function rejectAllPending(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason || 'cdp_closed'));
    if (!err.code) err.code = 'cdp_closed';
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function handleCommandResponse(msg) {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      const e = new Error(msg.error.message || 'cdp_error');
      e.code = 'cdp_error';
      e.cdp = msg.error;
      entry.reject(e);
    } else {
      entry.resolve(msg.result || {});
    }
  }

  function handleCdpEvent(msg) {
    switch (msg.method) {
      case 'Page.screencastFrame':
        emitFrame(msg.params || {});
        return;
      case 'Page.frameNavigated':
        handlePageFrameNavigated(msg.params || {});
        return;
      case 'Target.targetCreated':
        handleTargetCreated(msg.params || {});
        return;
      case 'Target.targetDestroyed':
        handleTargetDestroyed(msg.params || {});
        return;
      case 'Target.targetInfoChanged':
        handleTargetInfoChanged(msg.params || {});
        return;
      default:
      // Unrecognized CDP event — ignore. Other domains' events arriving
      // here would indicate a misconfiguration; we still avoid throwing.
    }
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch (err) {
      log('warn', 'cdp_message_parse_failed', { error: err?.message });
      return;
    }
    if (msg && typeof msg === 'object' && 'id' in msg) {
      handleCommandResponse(msg);
      return;
    }
    if (msg && typeof msg === 'object' && typeof msg.method === 'string') {
      handleCdpEvent(msg);
    }
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

  function ensureOpen() {
    if (closed) {
      const err = new Error('Streaming companion is closed');
      err.code = 'companion_closed';
      return Promise.reject(err);
    }
    if (ws && ws.readyState === 1) return Promise.resolve();
    if (openPromise) return openPromise;

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
        const e = new Error(`CDP command ${method} timed out`);
        e.code = 'cdp_timeout';
        reject(e);
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
      const e = new Error(`Failed to send CDP command ${method}: ${err?.message || err}`);
      e.code = 'cdp_send_failed';
      reject(e);
    }
  }

  function sendOpenCdpCommand(method, params) {
    return new Promise((resolve, reject) => {
      const socket = ws;
      if (!socket || socket.readyState !== 1) {
        const e = new Error('CDP websocket is not open');
        e.code = 'cdp_not_open';
        reject(e);
        return;
      }
      const { id, timer } = registerPendingCommand(method, resolve, reject);
      sendRegisteredCommand(socket, id, method, params, timer, reject);
    });
  }

  function send(method, params = {}) {
    return ensureOpen().then(() => sendOpenCdpCommand(method, params));
  }

  async function start(viewport) {
    if (started) return;
    await ensureOpen();
    await send('Page.enable');
    // Best-effort: enabling Target discovery turns on browser-wide
    // `targetCreated` / `targetDestroyed` / `targetInfoChanged` events on
    // this session. Without it the per-page session never sees popups. If
    // the underlying transport/Chromium rejects this (some embedders restrict
    // Target on a per-target connection) we still proceed — the streaming
    // session keeps working for screencast + input, the operator just loses
    // popup awareness for this run.
    await send('Target.setDiscoverTargets', { discover: true }).catch((err) => {
      log('warn', 'cdp_target_discovery_failed', { error: err?.message });
    });
    if (viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: Math.floor(viewport.width),
        height: Math.floor(viewport.height),
        deviceScaleFactor: Number.isFinite(viewport.deviceScaleFactor) ? Number(viewport.deviceScaleFactor) : 1,
        mobile: viewport.mobile === true,
      }).catch((err) => {
        // Setting device metrics is best-effort; some Chromium versions reject
        // particular combinations. Surface in logs but do not abort the
        // streaming session — the screencast will still work at the page's
        // current dimensions.
        log('warn', 'cdp_set_device_metrics_failed', { error: err?.message });
      });
    }
    await send('Page.startScreencast', buildScreencastParams({ viewport }));
    started = true;
  }

  async function stop() {
    if (closed) return;
    closed = true;
    if (started) {
      // Best-effort: turn discovery back off so we stop receiving Target
      // events. This is purely housekeeping — closing the socket below makes
      // the events un-deliverable anyway — but it prevents a small window
      // between stopScreencast and ws.close() where a target event could
      // still arrive and re-enter user-supplied handlers we are about to
      // drop.
      try {
        await send('Target.setDiscoverTargets', { discover: false });
      } catch {
        /* best-effort */
      }
      try {
        await send('Page.stopScreencast');
      } catch {
        /* best-effort */
      }
      started = false;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    rejectAllPending(Object.assign(new Error('Streaming companion stopped'), { code: 'companion_stopped' }));
    openPromise = null;
    // Drop all handler references so the socket-close path cannot re-enter
    // user code after stop(). Defense-in-depth on top of the close handler
    // already short-circuiting on `closed`.
    frameHandlers.clear();
    eventHandlers.clear();
    lastFrame = null;
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
