/**
 * Real CDP companion adapter.
 *
 * Connects to a Chrome DevTools Protocol page-target WebSocket URL and speaks
 * JSON-RPC directly. We deliberately avoid Playwright/Puppeteer here — the
 * reference server should not pull a heavyweight browser-automation library
 * in just to relay input and frames.
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
import { buildScreencastParams, mapInputEventToCdp } from './cdp-companion.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;

/**
 * Resolve a fixed CDP page-target WebSocket URL. Operators that already know
 * the per-page WS URL (e.g. piped from a managed browser orchestrator) can set
 * this directly; a richer deployment would resolve a per-`browser_session_id`
 * URL from a control-plane registry. We document this gap in the OpenSpec
 * design as optimistic reference behavior.
 */
export function resolveCdpWsUrlFromEnv(env = process.env) {
  const url = env.PDPP_RUN_INTERACTION_CDP_WS_URL;
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve a Chrome DevTools HTTP base (e.g. `http://127.0.0.1:9222`). When set,
 * the default factory creates a fresh page target per streaming session via
 * `/json/new`, reads its `webSocketDebuggerUrl`, and tears it down on stop. This
 * is the operator-friendly default — pointing at `chrome --remote-debugging-port`
 * is easier than copying out a single page-target ws URL — but it remains
 * reference-only. A real Collection-Profile-aware deployment would resolve the
 * target per `browser_session_id` from a control-plane registry instead.
 */
export function resolveCdpHttpUrlFromEnv(env = process.env) {
  const url = env.PDPP_RUN_INTERACTION_CDP_HTTP_URL;
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Create a fresh CDP page target via Chrome's DevTools HTTP endpoint. Returns
 * the target's WebSocket debugger URL plus a best-effort `close()` that asks
 * Chrome to close the target on companion teardown.
 *
 * Errors from this function are typed so the route layer can map them onto
 * operator-readable messages — a malformed HTTP base or a Chromium that doesn't
 * advertise `webSocketDebuggerUrl` should fail at attach/start, not at first
 * input event.
 */
export async function createCdpTargetFromHttp({
  httpUrl,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof httpUrl !== 'string' || httpUrl.length === 0) {
    const e = new Error('createCdpTargetFromHttp: httpUrl is required');
    e.code = 'cdp_http_url_missing';
    throw e;
  }
  if (typeof fetchImpl !== 'function') {
    const e = new Error('createCdpTargetFromHttp: no fetch implementation available');
    e.code = 'cdp_http_fetch_missing';
    throw e;
  }
  let base;
  try {
    base = trimTrailingSlash(new URL(httpUrl).toString());
  } catch (err) {
    const e = new Error(`Invalid PDPP_RUN_INTERACTION_CDP_HTTP_URL: ${err?.message || err}`);
    e.code = 'cdp_http_url_invalid';
    throw e;
  }
  const newUrl = `${base}/json/new?about:blank`;
  let response;
  try {
    response = await fetchImpl(newUrl, { method: 'PUT' });
  } catch (err) {
    // Chrome historically accepts both PUT and GET on /json/new; some builds
    // only honor GET. Retry once before giving up so the operator-facing error
    // reflects the underlying network reality, not a verb mismatch.
    try {
      response = await fetchImpl(newUrl, { method: 'GET' });
    } catch (err2) {
      const e = new Error(`Failed to reach CDP HTTP endpoint ${newUrl}: ${err2?.message || err2}`);
      e.code = 'cdp_http_unreachable';
      throw e;
    }
  }
  if (!response || !response.ok) {
    const status = response?.status ?? 'unknown';
    const e = new Error(`CDP HTTP /json/new returned status ${status}`);
    e.code = 'cdp_http_create_failed';
    e.status = status;
    throw e;
  }
  let target;
  try {
    target = await response.json();
  } catch (err) {
    const e = new Error(`CDP HTTP /json/new returned non-JSON body: ${err?.message || err}`);
    e.code = 'cdp_http_parse_failed';
    throw e;
  }
  const webSocketDebuggerUrl =
    target && typeof target.webSocketDebuggerUrl === 'string' ? target.webSocketDebuggerUrl : '';
  if (!webSocketDebuggerUrl) {
    const e = new Error('CDP HTTP /json/new response did not include webSocketDebuggerUrl');
    e.code = 'cdp_http_no_ws_url';
    e.target = target;
    throw e;
  }
  const targetId = target && typeof target.id === 'string' ? target.id : null;
  return {
    webSocketDebuggerUrl,
    targetId,
    raw: target,
    async close() {
      // Best-effort: a missing target id (some Chromium builds omit it) means
      // we cannot ask Chrome to close, but the operator can still close the
      // target manually via the inspector.
      if (!targetId) return;
      try {
        await fetchImpl(`${base}/json/close/${encodeURIComponent(targetId)}`, { method: 'GET' });
      } catch {
        // Teardown is best-effort: we never want a stuck Chrome to crash the
        // streaming session lifecycle on the server side.
      }
    },
  };
}

/**
 * Build the default companion factory. Three modes, in priority order:
 *
 *   1. Explicit `wsUrl` (or `PDPP_RUN_INTERACTION_CDP_WS_URL`) — connect
 *      directly to a single page-target WebSocket.
 *   2. Explicit `httpUrl` (or `PDPP_RUN_INTERACTION_CDP_HTTP_URL`) — resolve a
 *      fresh page target per session via DevTools HTTP, then connect to its
 *      `webSocketDebuggerUrl`. This is the operator-friendly default.
 *   3. Neither set — return `null` so the mint route fails closed with
 *      `streaming_companion_unavailable` instead of handing out a token that
 *      only errors at attach time.
 *
 * `WebSocketCtor` and `fetch` are injectable for tests (a fake CDP server can
 * hand back its own ws constructor and a fake `fetch`).
 */
export function createDefaultStreamingCompanionFactory({
  wsUrl = resolveCdpWsUrlFromEnv(),
  httpUrl = resolveCdpHttpUrlFromEnv(),
  WebSocketCtor = globalThis.WebSocket,
  fetch: fetchImpl = globalThis.fetch,
  logger,
  commandTimeoutMs,
  openTimeoutMs,
} = {}) {
  if (!wsUrl && !httpUrl) return null;
  if (typeof WebSocketCtor !== 'function') {
    throw new Error('createDefaultStreamingCompanionFactory: no WebSocket constructor available');
  }
  if (wsUrl) {
    return ({ browser_session_id }) =>
      createCdpCompanion({
        wsUrl,
        browser_session_id,
        WebSocketCtor,
        logger,
        commandTimeoutMs,
        openTimeoutMs,
      });
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('createDefaultStreamingCompanionFactory: no fetch implementation available for HTTP target resolution');
  }
  return ({ browser_session_id }) =>
    createHttpResolvedCompanion({
      httpUrl,
      browser_session_id,
      WebSocketCtor,
      fetch: fetchImpl,
      logger,
      commandTimeoutMs,
      openTimeoutMs,
    });
}

/**
 * Wraps `createCdpCompanion` with lazy DevTools HTTP target creation. The
 * inner CDP companion is created on `start()` once we know the WebSocket URL;
 * `stop()` closes both the inner companion and the DevTools target.
 */
function createHttpResolvedCompanion({
  httpUrl,
  browser_session_id,
  WebSocketCtor,
  fetch: fetchImpl,
  logger,
  commandTimeoutMs,
  openTimeoutMs,
}) {
  let inner = null;
  let target = null;
  let closed = false;
  // Subscribers can attach onFrame before start() resolves the inner companion;
  // we proxy the registration so frames flow once the inner companion exists.
  const pendingFrameHandlers = new Set();

  const log = (level, msg, data) => {
    if (!logger || typeof logger[level] !== 'function') return;
    try {
      logger[level]({ msg, browser_session_id, ...(data || {}) });
    } catch {
      /* logger errors must not break the streaming path */
    }
  };

  return {
    browser_session_id,
    async start(viewport) {
      if (closed) {
        const e = new Error('Streaming companion is closed');
        e.code = 'companion_closed';
        throw e;
      }
      if (!inner) {
        target = await createCdpTargetFromHttp({ httpUrl, fetch: fetchImpl });
        inner = createCdpCompanion({
          wsUrl: target.webSocketDebuggerUrl,
          browser_session_id,
          WebSocketCtor,
          logger,
          commandTimeoutMs,
          openTimeoutMs,
        });
        // Replay pending subscribers so frames reach the SSE attach handler
        // even if it subscribed before start() finished resolving the target.
        for (const handler of pendingFrameHandlers) {
          inner.onFrame(handler);
        }
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
      if (target) {
        try {
          await target.close();
        } catch (err) {
          log('warn', 'cdp_target_close_failed', { error: err?.message });
        }
        target = null;
      }
    },
    onFrame(handler) {
      if (inner) return inner.onFrame(handler);
      pendingFrameHandlers.add(handler);
      return () => {
        pendingFrameHandlers.delete(handler);
        // We cannot un-subscribe an already-installed handler from inner here
        // because the handler is the same identity; createCdpCompanion's
        // onFrame closes over the same Set, so deletion still works.
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
      target: () => target,
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
  const pending = new Map(); // id → { resolve, reject, timer }
  let nextId = 1;
  let ws = null;
  let openPromise = null;
  let started = false;
  let closed = false;

  function emitFrame(params) {
    // Wire shape mirrors the mock companion so the route writes identical SSE.
    const frame = {
      sessionId: params.sessionId,
      data: params.data,
      metadata: params.metadata || null,
    };
    for (const handler of frameHandlers) {
      try {
        handler(frame);
      } catch (err) {
        log('warn', 'cdp_frame_handler_error', { error: err?.message });
      }
    }
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

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch (err) {
      log('warn', 'cdp_message_parse_failed', { error: err?.message });
      return;
    }
    if (msg && typeof msg === 'object' && 'id' in msg) {
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
      return;
    }
    if (msg && typeof msg === 'object' && msg.method === 'Page.screencastFrame') {
      emitFrame(msg.params || {});
    }
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

      // Both standard WebSocket (browser/native) and `ws` library expose
      // `addEventListener` and `on` patterns. Prefer the standard one.
      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', onOpen);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
        socket.addEventListener('message', onMessage);
      } else if (typeof socket.on === 'function') {
        socket.on('open', onOpen);
        socket.on('error', onError);
        socket.on('close', onClose);
        socket.on('message', onMessage);
      } else {
        const e = new Error('Unsupported WebSocket implementation');
        e.code = 'cdp_socket_unsupported';
        reject(e);
      }
    }).catch((err) => {
      openPromise = null;
      throw err;
    });

    return openPromise;
  }

  function send(method, params = {}) {
    return ensureOpen().then(
      () =>
        new Promise((resolve, reject) => {
          if (!ws || ws.readyState !== 1) {
            const e = new Error('CDP websocket is not open');
            e.code = 'cdp_not_open';
            reject(e);
            return;
          }
          const id = nextId++;
          const timer = setTimeout(() => {
            if (pending.delete(id)) {
              const e = new Error(`CDP command ${method} timed out`);
              e.code = 'cdp_timeout';
              reject(e);
            }
          }, commandTimeoutMs);
          pending.set(id, { resolve, reject, timer });
          try {
            ws.send(JSON.stringify({ id, method, params }));
          } catch (err) {
            pending.delete(id);
            clearTimeout(timer);
            const e = new Error(`Failed to send CDP command ${method}: ${err?.message || err}`);
            e.code = 'cdp_send_failed';
            reject(e);
          }
        }),
    );
  }

  async function start(viewport) {
    if (started) return;
    await ensureOpen();
    await send('Page.enable');
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
  }

  function onFrame(handler) {
    frameHandlers.add(handler);
    return () => frameHandlers.delete(handler);
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
