/**
 * Run-interaction streaming companion routes (reference-only).
 *
 * Owner-authenticated mint:
 *   POST /_ref/runs/:runId/run-interaction-stream
 *     body: { interaction_id, viewport?: { width, height, screenWidth?, screenHeight?, deviceScaleFactor?, mobile? } }
 *     emits run.stream_session_requested
 *
 * Token-only frame channel (SSE):
 *   GET  /_ref/run-interaction-streams/:token/events
 *     emits run.stream_session_opened on attach, run.stream_session_resolved on close
 *
 * Token-only input dispatch:
 *   POST /_ref/run-interaction-streams/:token/input
 *     body: an input event matching `mapInputEventToCdp`
 *
 * Token-only viewport:
 *   POST /_ref/run-interaction-streams/:token/viewport
 *
 * Token-only n.eko viewer entry:
 *   GET  /_ref/run-interaction-streams/:token/neko
 *     sets a short-lived /neko cookie and redirects to the same-origin proxy
 *   GET  /_ref/run-interaction-streams/:token/neko/session
 *     sets the same cookie and returns direct n.eko client configuration
 *
 * The token is the only credential the viewer presents after mint. It is short
 * lived (default 5 min), single-attach, scoped to one (run, interaction,
 * browser session), and invalidated when the interaction resolves or the run
 * ends. The token never authorizes record reads, consent approval, grant
 * issuance, or unrelated browser access.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { emitSpineEvent } from '../../lib/spine.ts';

const NEKO_PROXY_COOKIE = 'pdpp_neko_stream';
const DEFAULT_NEKO_PROXY_PATH = '/neko/';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
]);

function pdppError(res, status, code, message, param = null) {
  const body = { error: { type: 'invalid_request_error', code, message } };
  if (param) body.error.param = param;
  if (status === 401) {
    res.status(status).header('WWW-Authenticate', 'Bearer realm="pdpp-stream"').json(body);
    return;
  }
  res.status(status).json(body);
}

function parseAllowedHosts(value) {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return new Set(
    entries
      .map((entry) => String(entry).trim().toLowerCase())
      .filter(Boolean),
  );
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('127.');
}

function assertAllowedNekoOrigin(origin, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    const err = new Error('n.eko proxy target origin is invalid');
    err.code = 'invalid_neko_origin';
    throw err;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error('n.eko proxy target must use http or https');
    err.code = 'invalid_neko_origin';
    throw err;
  }
  const host = parsed.hostname.toLowerCase();
  const hostPort = `${host}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
  if (isLoopbackHost(host) || allowedHosts.has(host) || allowedHosts.has(hostPort)) return parsed;
  const err = new Error('n.eko proxy target host is not allowlisted');
  err.code = 'neko_origin_not_allowed';
  throw err;
}

function parseCookieHeader(header) {
  const cookies = new Map();
  for (const part of String(header || '').split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join('=') || ''));
  }
  return cookies;
}

function stripCookie(header, cookieName) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${cookieName}=`))
    .join('; ');
}

function setNekoProxyCookie(res, token, maxAgeSeconds, cookieName) {
  const boundedMaxAge = Math.max(1, Math.min(600, Math.floor(maxAgeSeconds || 1)));
  res.header(
    'Set-Cookie',
    `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/neko; Max-Age=${boundedMaxAge}`,
  );
}

function serializeProxyBody(req, headers) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    delete headers['content-length'];
    return null;
  }
  if (req.body === undefined || req.body === null) {
    delete headers['content-length'];
    return null;
  }
  const body = Buffer.isBuffer(req.body)
    ? req.body
    : typeof req.body === 'string'
      ? Buffer.from(req.body)
      : Buffer.from(JSON.stringify(req.body));
  headers['content-length'] = String(body.length);
  return body;
}

function buildProxyHeaders(sourceHeaders, targetUrl, cookieName, { upgrade = false } = {}) {
  const headers = {};
  for (const [rawName, value] of Object.entries(sourceHeaders || {})) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (name === 'authorization') continue;
    if (name === 'host') continue;
    if (!upgrade && name === 'upgrade') continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (sourceHeaders?.cookie) {
    const cookie = stripCookie(sourceHeaders.cookie, cookieName);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
  }
  headers.host = targetUrl.host;
  if (upgrade) {
    headers.connection = 'Upgrade';
    headers.upgrade = sourceHeaders?.upgrade || 'websocket';
  }
  return headers;
}

function writeUpgradeError(socket, status, message) {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function proxyUpgradeRequest(rawReq, socket, head, targetUrl, cookieName) {
  const useTls = targetUrl.protocol === 'https:';
  const port = Number(targetUrl.port || (useTls ? 443 : 80));
  const headers = buildProxyHeaders(rawReq.headers, targetUrl, cookieName, { upgrade: true });
  const upstream = useTls
    ? tls.connect({ host: targetUrl.hostname, port, servername: targetUrl.hostname })
    : net.connect({ host: targetUrl.hostname, port });

  upstream.once('connect', () => {
    const path = `${targetUrl.pathname}${targetUrl.search}`;
    upstream.write(`${rawReq.method} ${path} HTTP/${rawReq.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(headers)) {
      upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write('\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.once('error', () => writeUpgradeError(socket, 502, 'Bad Gateway'));
  socket.once('error', () => upstream.destroy());
}

function safeRunId(req) {
  return decodeURIComponent(req.params.runId);
}

function pickViewport(input) {
  if (!input || typeof input !== 'object') return null;
  const width = Number(input.width);
  const height = Number(input.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const out = { width: Math.floor(width), height: Math.floor(height) };
  if (Number.isFinite(input.deviceScaleFactor) && input.deviceScaleFactor > 0) {
    out.deviceScaleFactor = Number(input.deviceScaleFactor);
  }
  if (Number.isFinite(input.screenWidth) && input.screenWidth > 0) {
    out.screenWidth = Math.max(out.width, Math.floor(input.screenWidth));
  }
  if (Number.isFinite(input.screenHeight) && input.screenHeight > 0) {
    out.screenHeight = Math.max(out.height, Math.floor(input.screenHeight));
  }
  if (typeof input.hasTouch === 'boolean') out.hasTouch = input.hasTouch;
  if (input.mobile === true) out.mobile = true;
  if (typeof input.userAgent === 'string' && input.userAgent.length > 0) {
    out.userAgent = input.userAgent.slice(0, 512);
  }
  return out;
}

function normalizeViewportForNeko(viewport) {
  if (!viewport) return null;
  // n.eko delivers pointer/touch input through the native browser window,
  // not through CDP Input.dispatch*. If we expose a high-DPR virtual screen
  // (screenWidth = width * dpr, deviceScaleFactor > 1), the video can look
  // sharp while native input lands in screen-pixel coordinates outside the
  // emulated CSS viewport. Keep n.eko in one coordinate space: CSS viewport,
  // X screen, WebRTC frame, and native input all use the same width/height.
  return {
    ...viewport,
    deviceScaleFactor: 1,
    screenHeight: viewport.height,
    screenWidth: viewport.width,
  };
}

function viewportForCompanionBackend(backend, viewport) {
  return backend === 'neko' ? normalizeViewportForNeko(viewport) : viewport;
}

function viewportsMatch(a, b) {
  if (a === b) return true;
  if (!a || !b) return a === b;
  const keys = ['width', 'height', 'screenWidth', 'screenHeight', 'deviceScaleFactor', 'hasTouch', 'mobile', 'userAgent'];
  return keys.every((key) => a[key] === b[key]);
}

async function resolveCompanionBackend(companion) {
  if (typeof companion?.resolveBackend === 'function') {
    return companion.resolveBackend();
  }
  return typeof companion?.backend === 'string' ? companion.backend : 'cdp';
}

/**
 * @param {object} deps
 * @param {object} deps.app                    fastify app
 * @param {object} deps.controller             controller exposing getPendingInteraction
 * @param {object} deps.ownerAuth              owner auth middleware bag
 * @param {object} deps.streamingSessions      session store (createStreamingSessionStore)
 * @param {Function|null} deps.companionFactory   ({ run_id, interaction_id }) => Companion.
 *                                                When `null`, mint fails closed with 503
 *                                                `streaming_companion_unavailable` instead of
 *                                                handing out a token that only fails at attach.
 * @param {Function} deps.makeBrowserSessionId optional id minter for tests
 * @param {Function} deps.now                  optional clock for tests
 * @param {Function} deps.emitTimelineEvent    optional override for tests; defaults to emitSpineEvent
 * @param {string} deps.nekoProxyPath          same-origin n.eko proxy path
 * @param {string|string[]} deps.nekoProxyAllowedHosts non-loopback n.eko hosts allowed for proxying
 * @param {{ username: string, password: string }|null} deps.nekoProxyAutoLogin n.eko auto-login query params
 */
export function registerStreamingRoutes({
  app,
  controller,
  ownerAuth,
  streamingSessions,
  companionFactory,
  makeBrowserSessionId,
  now = () => Date.now(),
  emitTimelineEvent = emitSpineEvent,
  nekoProxyPath = DEFAULT_NEKO_PROXY_PATH,
  nekoProxyAllowedHosts = [],
  nekoProxyCookieName = NEKO_PROXY_COOKIE,
  nekoProxyAutoLogin = null,
}) {
  if (!app || !ownerAuth || !streamingSessions) {
    throw new Error('registerStreamingRoutes: missing dependency');
  }
  if (companionFactory != null && typeof companionFactory !== 'function') {
    throw new Error('registerStreamingRoutes: companionFactory must be a function or null');
  }

  // Companion instances by browser_session_id. One companion per pending
  // interaction; reused for the SSE attach + input POSTs while the session is
  // alive.
  const companions = new Map();
  const allowedNekoHosts = parseAllowedHosts(nekoProxyAllowedHosts);
  const nekoAutoLogin =
    nekoProxyAutoLogin &&
    typeof nekoProxyAutoLogin === 'object' &&
    String(nekoProxyAutoLogin.username || '').trim() &&
    String(nekoProxyAutoLogin.password || '').trim()
      ? {
          username: String(nekoProxyAutoLogin.username).trim(),
          password: String(nekoProxyAutoLogin.password).trim(),
        }
      : null;

  function getCompanion(browser_session_id) {
    return companions.get(browser_session_id) || null;
  }

  async function destroyCompanion(browser_session_id) {
    const companion = companions.get(browser_session_id);
    if (!companion) return;
    companions.delete(browser_session_id);
    try {
      await companion.stop();
    } catch {
      // Best-effort teardown: companion errors must not bubble out of cleanup.
    }
  }

  async function emit(event_type, payload) {
    try {
      await emitTimelineEvent({
        event_type,
        actor_type: 'reference',
        actor_id: 'run-interaction-stream',
        object_type: 'run',
        object_id: payload.run_id,
        run_id: payload.run_id,
        interaction_id: payload.interaction_id,
        status: payload.status || 'started',
        data: payload.data || {},
      });
    } catch {
      // Spine emit best-effort: refusing to mint over a logging error would
      // give worse UX than a missing diagnostic event.
    }
  }

  function getNekoProxySession(token) {
    const session = streamingSessions.authorize({ token });
    const companion = getCompanion(session.browser_session_id);
    if (!companion || typeof companion.getNekoProxyTarget !== 'function') {
      const err = new Error('n.eko companion is not available');
      err.code = 'companion_unavailable';
      throw err;
    }
    const target = companion.getNekoProxyTarget();
    if (!target?.origin) {
      const err = new Error('n.eko proxy target is not available');
      err.code = 'neko_proxy_unavailable';
      throw err;
    }
    const origin = assertAllowedNekoOrigin(target.origin, allowedNekoHosts);
    return { session, companion, origin };
  }

  function getNekoCookieSession(req) {
    const token = parseCookieHeader(req.headers?.cookie).get(nekoProxyCookieName);
    if (!token) {
      const err = new Error('n.eko stream cookie is missing');
      err.code = 'invalid_token';
      throw err;
    }
    return getNekoProxySession(token);
  }

  function buildNekoTargetUrl(origin, reqUrl) {
    let path = reqUrl || nekoProxyPath;
    if (path === '/neko') {
      path = '/neko/';
    } else if (path.startsWith('/neko?')) {
      path = `/neko/${path.slice('/neko'.length)}`;
    }
    return new URL(path, origin);
  }

  function shouldInjectNekoBase(req, targetUrl, upstreamRes) {
    const method = String(req.method || 'GET').toUpperCase();
    const contentType = String(upstreamRes.headers?.['content-type'] || '');
    return method === 'GET' && targetUrl.pathname === '/neko/' && /^text\/html\b/i.test(contentType);
  }

  function withoutContentLength(headers) {
    const next = { ...(headers || {}) };
    for (const key of Object.keys(next)) {
      if (key.toLowerCase() === 'content-length') delete next[key];
    }
    return next;
  }

  function injectNekoEmbedChrome(html) {
    const base = '<base href="/neko/">';
    const style = `<style data-pdpp-neko-embed>
html,body,#neko,.neko-main{width:100%!important;height:100%!important;margin:0!important;overflow:hidden!important;background:#000!important}
body>p{display:none!important}
#neko .header-container,#neko .video-menu,#neko .chat,#neko .chat-container,#neko .sidebar,#neko .side,#neko .control-container,#neko .status-container,#neko .footer{display:none!important}
#neko .neko-main{display:block!important}
#neko .video-container,#neko .video,#neko .player{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;margin:0!important;padding:0!important;display:flex!important;background:#000!important}
#neko .player-container,#neko video,#neko textarea.overlay,#neko .player-aspect,#neko .emotes{inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important}
#neko textarea.overlay{resize:none!important}
</style>`;
    const script = `<script data-pdpp-neko-embed>
(function(){function focusOverlay(){var el=document.querySelector('textarea.overlay')||document.querySelector('textarea')||document.querySelector('input[type="text"]');if(el&&typeof el.focus==='function'){try{el.focus({preventScroll:true});}catch(_){el.focus();}}}document.documentElement.setAttribute('data-pdpp-neko-embed','1');document.addEventListener('pointerdown',focusOverlay,true);document.addEventListener('touchstart',focusOverlay,{capture:true,passive:true});window.addEventListener('message',function(event){if(event.origin!==location.origin)return;if(event.data&&event.data.type==='pdpp-neko-focus')focusOverlay();});setTimeout(focusOverlay,250);})();
</script>`;
    let next = html;
    if (!/<base\s/i.test(next)) {
      next = /<head(\s[^>]*)?>/i.test(next)
        ? next.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${base}`)
        : `${base}${next}`;
    }
    if (!/data-pdpp-neko-embed/.test(next)) {
      next = /<\/head>/i.test(next)
        ? next.replace(/<\/head>/i, `${style}${script}</head>`)
        : `${style}${script}${next}`;
    }
    return next;
  }

  async function handleNekoHttpProxy(req, res) {
    let authorized;
    try {
      authorized = getNekoCookieSession(req);
    } catch (err) {
      const status =
        err.code === 'session_not_attached' ? 409 : err.code === 'session_expired' ? 410 : 401;
      return pdppError(res, status, err.code || 'invalid_token', err.message);
    }

    const targetUrl = buildNekoTargetUrl(authorized.origin, req.raw?.url || req.url || nekoProxyPath);
    const headers = buildProxyHeaders(req.headers, targetUrl, nekoProxyCookieName);
    const body = serializeProxyBody(req, headers);
    const transport = targetUrl.protocol === 'https:' ? https : http;

    res.hijack();
    const raw = res.raw;
    const upstream = transport.request(
      {
        method: req.method,
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers,
      },
      (upstreamRes) => {
        if (shouldInjectNekoBase(req, targetUrl, upstreamRes)) {
          let html = '';
          upstreamRes.setEncoding('utf8');
          upstreamRes.on('data', (chunk) => {
            html += chunk;
          });
          upstreamRes.on('end', () => {
            raw.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, withoutContentLength(upstreamRes.headers));
            raw.end(injectNekoEmbedChrome(html));
          });
          return;
        }
        raw.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, upstreamRes.headers);
        upstreamRes.pipe(raw);
      },
    );
    upstream.once('error', () => {
      if (raw.destroyed) return;
      raw.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      raw.end(JSON.stringify({ error: { type: 'api_error', code: 'neko_proxy_failed' } }));
    });
    if (body) upstream.end(body);
    else upstream.end();
  }

  function handleNekoUpgrade(rawReq, socket, head) {
    const parsed = new URL(rawReq.url || '/', 'http://localhost');
    if (parsed.pathname !== '/neko' && !parsed.pathname.startsWith('/neko/')) return false;
    try {
      const authorized = getNekoCookieSession({ headers: rawReq.headers });
      const targetUrl = buildNekoTargetUrl(authorized.origin, rawReq.url || nekoProxyPath);
      proxyUpgradeRequest(rawReq, socket, head, targetUrl, nekoProxyCookieName);
      return true;
    } catch (err) {
      const status = err.code === 'session_expired' ? 410 : err.code === 'session_not_attached' ? 409 : 401;
      writeUpgradeError(socket, status, status === 410 ? 'Gone' : status === 409 ? 'Conflict' : 'Unauthorized');
      return true;
    }
  }

  // ── Mint ──────────────────────────────────────────────────────────────────
  app.post(
    '/_ref/runs/:runId/run-interaction-stream',
    ownerAuth.requireOwnerSession,
    async (req, res) => {
      try {
        if (!controller || typeof controller.getPendingInteraction !== 'function') {
          return pdppError(res, 404, 'not_found', 'Controller is not configured on this server');
        }
        const runId = safeRunId(req);
        const body = req.body || {};
        const interactionId = String(body.interaction_id || '').trim();
        if (!interactionId) {
          return pdppError(res, 400, 'invalid_request', 'interaction_id is required', 'interaction_id');
        }
        const pending = controller.getPendingInteraction(runId);
        if (!pending) {
          return pdppError(res, 409, 'no_pending_interaction', 'No pending interaction for this run');
        }
        if (pending.interaction_id !== interactionId) {
          return pdppError(
            res,
            409,
            'interaction_id_mismatch',
            `Pending interaction is ${pending.interaction_id}, not ${interactionId}`,
            'interaction_id',
          );
        }
        // Streaming companion is for `manual_action` — the only kind that needs
        // browser control rather than a credential/OTP form. The historical
        // `host_browser_required` kind was retired with the host-browser bridge
        // in `introduce-local-collector-runner`; surface a clear error if any
        // legacy connector still emits it.
        if (pending.kind !== 'manual_action') {
          return pdppError(
            res,
            409,
            'stream_not_supported_for_kind',
            `Streaming is not supported for interaction kind ${pending.kind}`,
          );
        }
        // Fail closed when no real CDP companion is configured. The viewer
        // must not receive a token that only errors at attach time; that
        // makes the dashboard primary action a dead button.
        if (typeof companionFactory !== 'function') {
          return pdppError(
            res,
            503,
            'streaming_companion_unavailable',
            'Streaming companion is not configured on this server. The connector runtime must register a CDP page-target ws URL for the run via the run-target registry, or a streamingCompanionFactory must be injected, to enable run-interaction streaming.',
          );
        }
        const viewport = pickViewport(body.viewport);
        // Stripe-style optional idempotency key. Lets the dashboard collapse a
        // duplicate mint (StrictMode double-invoke that slipped past the
        // event-handler fix, fetch retry, operator double-tap) into the same
        // session record so the prior token isn't superseded out from under
        // the in-flight viewer. Absent / blank / non-string => legacy mint
        // behaviour (always supersedes).
        const idempotencyKey =
          typeof body.idempotency_key === 'string' && body.idempotency_key.length > 0
            ? body.idempotency_key
            : null;
        const browser_session_id =
          (typeof makeBrowserSessionId === 'function' ? makeBrowserSessionId() : null) ||
          `bs_${Math.floor(now()).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

        const { token, session, idempotency_replayed } = streamingSessions.mint({
          run_id: runId,
          interaction_id: interactionId,
          browser_session_id,
          viewport,
          idempotency_key: idempotencyKey,
        });

        // On a replay we MUST reuse the existing companion bound to the
        // original session's browser_session_id. Building a second companion
        // and overwriting the map entry would tear the live one down at next
        // attach. The replayed session.browser_session_id may differ from the
        // freshly-generated one above, so always key the lookup off the
        // session record returned by the store.
        const effectiveBrowserSessionId = session.browser_session_id;
        let companion = companions.get(effectiveBrowserSessionId) || null;
        if (!companion) {
          companion = companionFactory({
            run_id: runId,
            interaction_id: interactionId,
            browser_session_id: effectiveBrowserSessionId,
          });
          companions.set(effectiveBrowserSessionId, companion);
        }

        // Don't double-emit the spine event on a pure replay — the original
        // mint already published `run.stream_session_requested`. Replays are a
        // dashboard-side hygiene mechanism, not a new logical request.
        if (!idempotency_replayed) {
          await emit('run.stream_session_requested', {
            run_id: runId,
            interaction_id: interactionId,
            status: 'started',
            data: {
              browser_session_id: effectiveBrowserSessionId,
              expires_at_ms: session.expires_at,
              viewport,
              kind: pending.kind,
            },
          });
        }

        return res.status(201).json({
          object: 'run_interaction_stream_session',
          run_id: runId,
          interaction_id: interactionId,
          browser_session_id: effectiveBrowserSessionId,
          token,
          expires_at_ms: session.expires_at,
          idempotency_replayed: idempotency_replayed === true,
          viewer_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/events`,
          input_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/input`,
          viewport_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/viewport`,
        });
      } catch (err) {
        return pdppError(res, 500, 'api_error', err.message || 'mint failed');
      }
    },
  );

  // ── SSE attach (token-only) ───────────────────────────────────────────────
  app.get('/_ref/run-interaction-streams/:token/events', async (req, res) => {
    let session;
    try {
      session = streamingSessions.attach({ token: req.params.token });
    } catch (err) {
      const status = err.code === 'session_consumed' ? 409 : err.code === 'session_expired' ? 410 : 401;
      return pdppError(res, status, err.code || 'invalid_token', err.message);
    }
    const companion = getCompanion(session.browser_session_id);
    if (!companion) {
      return pdppError(res, 410, 'companion_unavailable', 'Streaming companion is no longer attached');
    }

    res.hijack();
    const raw = res.raw;
    raw.statusCode = 200;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache, no-transform');
    raw.setHeader('Connection', 'keep-alive');
    raw.setHeader('X-Accel-Buffering', 'no');
    raw.flushHeaders?.();

    function writeEvent(name, data) {
      raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    writeEvent('attached', {
      run_id: session.run_id,
      interaction_id: session.interaction_id,
      browser_session_id: session.browser_session_id,
      viewport: session.viewport,
    });

    const unsubscribe = companion.onFrame((frame) => {
      writeEvent('frame', {
        session_id: frame.sessionId,
        data_base64: frame.data,
        metadata: frame.metadata || null,
      });
      // CDP `Page.startScreencast` only delivers the next frame after the
      // previous one is acknowledged. Without this ack the stream stalls
      // after the first frame against a real Chromium. Best-effort: a
      // failed ack must not crash the SSE response (the next frame's ack
      // can recover, and if the companion really is gone, teardown will
      // fire from the close handler).
      if (Number.isFinite(frame.sessionId) && typeof companion.ackFrame === 'function') {
        Promise.resolve(companion.ackFrame(frame.sessionId)).catch(() => {
          /* best-effort ack; surfaced via companion logger if configured */
        });
      }
    });
    // Out-of-band wire events: URL changes, popup open/close. These are
    // separate SSE event types so the viewer's EventSource can register a
    // handler per event name and ignore the rest. Companions that predate
    // this contract may not expose `onEvent`; treat the absence as "no
    // out-of-band events available" rather than failing attach.
    const unsubscribeEvents =
      typeof companion.onEvent === 'function'
        ? companion.onEvent((event) => {
            if (!event || typeof event.kind !== 'string') return;
            switch (event.kind) {
              case 'url_changed': {
                const data = { url: event.url };
                if (typeof event.title === 'string') data.title = event.title;
                writeEvent('url_changed', data);
                return;
              }
              case 'popup_opened':
                writeEvent('popup_opened', {
                  targetId: event.targetId,
                  url: event.url || '',
                });
                return;
              case 'popup_closed':
                writeEvent('popup_closed', { targetId: event.targetId });
                return;
              default:
              // Forward unknown event kinds as-is so newer companions can add
              // event types without a route change. Tests can assert against
              // the discriminator via the SSE event name.
                writeEvent(event.kind, event);
            }
          })
        : () => {};

    // SSE keepalive: write a comment ping every 15 seconds to reset the
    // keepaliveTimeout on Fastify/HTTP intermediaries (default 30s).
    // SSE comments (lines starting with `:`) are ignored by EventSource clients.
    const keepAliveInterval = setInterval(() => {
      try {
        raw.write(': keepalive\n\n');
      } catch {
        /* best-effort keepalive; socket may already be gone */
      }
    }, 15_000);

    let perConnectionClosed = false;
    /**
     * Per-SSE-connection cleanup. Fires when the viewer's socket drops for
     * any reason (browser tab close, network blip, HMR reload). Tears down
     * THIS connection's resources only (keepalive timer, frame/event
     * subscriptions). Does NOT invalidate the streaming session — the
     * companion stays alive, and the operator can reconnect with the same
     * token to resume frames. Session-terminal teardown is reserved for
     * companion_start_failed, invalidateForInteractionResolved, and TTL
     * expiry — events that mean the human assist is over, not that the
     * transport blipped.
     */
    function closePerConnection() {
      if (perConnectionClosed) return;
      perConnectionClosed = true;
      clearInterval(keepAliveInterval);
      try {
        unsubscribe();
      } catch {
        /* unsubscribe best-effort */
      }
      try {
        unsubscribeEvents();
      } catch {
        /* unsubscribe best-effort */
      }
    }

    /**
     * Session-terminal teardown. Invalidates the streaming session so no
     * subsequent input or attach can succeed, emits the spine event, and
     * destroys the underlying companion. Used only for events that end the
     * human-assist lifecycle, not for transport blips.
     */
    let terminalTorn = false;
    async function tearDownSession(reason) {
      if (terminalTorn) return;
      terminalTorn = true;
      closePerConnection();
      streamingSessions.invalidate({
        run_id: session.run_id,
        interaction_id: session.interaction_id,
        reason,
      });
      await emit('run.stream_session_resolved', {
        run_id: session.run_id,
        interaction_id: session.interaction_id,
        status: 'completed',
        data: { browser_session_id: session.browser_session_id, reason },
      });
      await destroyCompanion(session.browser_session_id);
      try {
        raw.end();
      } catch {
        /* socket may already be gone */
      }
    }

    req.raw.on('close', () => {
      closePerConnection();
    });

    try {
      const backend = await resolveCompanionBackend(companion);
      const startViewport = viewportForCompanionBackend(backend, session.viewport || null);
      await companion.start(startViewport);
      const settledBackend = await resolveCompanionBackend(companion);
      const settledViewport = viewportForCompanionBackend(settledBackend, session.viewport || null);
      if (settledViewport && !viewportsMatch(startViewport, settledViewport)) {
        await companion.dispatch({ type: 'viewport', ...settledViewport });
      }
    } catch (err) {
      writeEvent('error', { code: err.code || 'companion_start_failed', message: err.message });
      await tearDownSession('companion_start_failed');
      return;
    }

    const backend = typeof companion.backend === 'string' ? companion.backend : 'cdp';
    writeEvent('backend_ready', {
      backend,
      browser_owner_mode:
        backend === 'neko' && typeof companion.browserOwnerMode === 'function' ? companion.browserOwnerMode() : null,
      client_config_path:
        backend === 'neko'
          ? `/_ref/run-interaction-streams/${encodeURIComponent(req.params.token)}/neko/session`
          : null,
      iframe_path:
        backend === 'neko'
          ? `/_ref/run-interaction-streams/${encodeURIComponent(req.params.token)}/neko`
          : null,
      stealth_mode: backend === 'neko' && typeof companion.stealthMode === 'function' ? companion.stealthMode() : null,
    });

    await emit('run.stream_session_opened', {
      run_id: session.run_id,
      interaction_id: session.interaction_id,
      status: 'started',
      data: { browser_session_id: session.browser_session_id, viewport: session.viewport },
    });
  });

  // ── Input dispatch (token-only) ───────────────────────────────────────────
  app.post('/_ref/run-interaction-streams/:token/input', async (req, res) => {
    let session;
    try {
      session = streamingSessions.authorize({ token: req.params.token });
    } catch (err) {
      const status = err.code === 'session_not_attached' ? 409 : 401;
      return pdppError(res, status, err.code || 'invalid_token', err.message);
    }
    const companion = getCompanion(session.browser_session_id);
    if (!companion) {
      return pdppError(res, 410, 'companion_unavailable', 'Streaming companion is no longer attached');
    }
    try {
      await companion.dispatch(req.body || {});
    } catch (err) {
      return pdppError(res, 400, err.code || 'invalid_input', err.message);
    }
    return res.status(202).json({ object: 'run_interaction_stream_input_ack' });
  });

  // ── Viewport (token-only) ────────────────────────────────────────────────
  app.post('/_ref/run-interaction-streams/:token/viewport', async (req, res) => {
    let session;
    try {
      session = streamingSessions.authorize({ token: req.params.token });
    } catch (err) {
      const status = err.code === 'session_not_attached' ? 409 : 401;
      return pdppError(res, status, err.code || 'invalid_token', err.message);
    }
    const viewport = pickViewport(req.body || {});
    if (!viewport) {
      return pdppError(res, 400, 'invalid_request', 'viewport.width and viewport.height are required', 'viewport');
    }
    const companion = getCompanion(session.browser_session_id);
    if (!companion) {
      return pdppError(res, 410, 'companion_unavailable', 'Streaming companion is no longer attached');
    }
    try {
      const backend = await resolveCompanionBackend(companion);
      const companionViewport = viewportForCompanionBackend(backend, viewport);
      await companion.dispatch({ type: 'viewport', ...companionViewport });
    } catch (err) {
      return pdppError(res, 400, err.code || 'invalid_input', err.message);
    }
    return res.status(202).json({
      object: 'run_interaction_stream_viewport_ack',
      viewport: viewportForCompanionBackend(await resolveCompanionBackend(companion), viewport),
    });
  });

  // ── n.eko viewer entry + proxy (stream-token scoped) ───────────────────────
  function nekoProxyBasePath() {
    return nekoProxyPath.endsWith('/') ? nekoProxyPath.slice(0, -1) : nekoProxyPath;
  }

  function buildNekoClientConfig() {
    const serverPath = nekoProxyBasePath() || '/neko';
    return {
      object: 'run_interaction_neko_client',
      server_path: serverPath,
      status_path: `${serverPath}/__pdpp/status`,
      login: nekoAutoLogin
        ? {
            username: nekoAutoLogin.username,
            password: nekoAutoLogin.password,
          }
        : {
            username: 'user',
            password: 'neko',
          },
    };
  }

  function authorizeNekoEntryToken(req, res) {
    let authorized;
    try {
      authorized = getNekoProxySession(req.params.token);
    } catch (err) {
      const status =
        err.code === 'session_not_attached' ? 409 : err.code === 'session_expired' ? 410 : 401;
      pdppError(res, status, err.code || 'invalid_token', err.message);
      return null;
    }
    setNekoProxyCookie(
      res,
      req.params.token,
      (authorized.session.expires_at - now()) / 1000,
      nekoProxyCookieName,
    );
    return authorized;
  }

  async function handleNekoEntry(req, res) {
    if (!authorizeNekoEntryToken(req, res)) return;
    const entryPath = nekoProxyBasePath();
    const params = new URLSearchParams({ pdpp_stream: Math.floor(now()).toString(36), embed: '1' });
    if (nekoAutoLogin) {
      params.set('usr', nekoAutoLogin.username);
      params.set('pwd', nekoAutoLogin.password);
    }
    return res.redirect(302, `${entryPath}?${params.toString()}`);
  }

  async function handleNekoClientConfig(req, res) {
    if (!authorizeNekoEntryToken(req, res)) return;
    return res.status(200).json(buildNekoClientConfig());
  }

  app.get('/_ref/run-interaction-streams/:token/neko', handleNekoEntry);
  app.get('/_ref/run-interaction-streams/:token/neko/', handleNekoEntry);
  app.get('/_ref/run-interaction-streams/:token/neko/session', handleNekoClientConfig);
  app.get('/_ref/run-interaction-streams/:token/neko/session/', handleNekoClientConfig);

  async function handleNekoStatus(req, res) {
    let authorized;
    try {
      authorized = getNekoCookieSession(req);
    } catch (err) {
      const status =
        err.code === 'session_not_attached' ? 409 : err.code === 'session_expired' ? 410 : 401;
      return pdppError(res, status, err.code || 'invalid_token', err.message);
    }
    const companion = authorized.companion;
    if (!companion || typeof companion.queryNekoStatus !== 'function') {
      return res.status(200).json({
        object: 'run_interaction_neko_status',
        control_available: false,
      });
    }
    try {
      const status = await companion.queryNekoStatus();
      if (status == null) {
        return res.status(200).json({
          object: 'run_interaction_neko_status',
          control_available: false,
        });
      }
      const pageControlAvailable =
        !(status && typeof status === 'object' && status.page_cdp_available === false);
      return res.status(200).json({
        object: 'run_interaction_neko_status',
        control_available: pageControlAvailable,
        status,
      });
    } catch (err) {
      return res.status(200).json({
        object: 'run_interaction_neko_status',
        control_available: false,
        diagnostic_error: {
          code: err.code || 'neko_status_failed',
          message: err.message || 'n.eko status failed',
        },
      });
    }
  }

  app.get('/neko/__pdpp/status', handleNekoStatus);

  for (const method of ['get', 'post', 'put', 'delete', 'options']) {
    app[method]('/neko', handleNekoHttpProxy);
    app[method]('/neko/*', handleNekoHttpProxy);
  }

  return {
    /**
     * Hook for the controller to call when an interaction resolves or the run
     * ends. Invalidates the token and tears down the companion if any.
     */
    async invalidateForInteractionResolved({ run_id, interaction_id, reason }) {
      const summary = streamingSessions.getSummary({ run_id, interaction_id });
      if (!summary) return;
      streamingSessions.invalidate({ run_id, interaction_id, reason: reason || 'interaction_resolved' });
      await emit('run.stream_session_resolved', {
        run_id,
        interaction_id,
        status: 'completed',
        data: { browser_session_id: summary.browser_session_id, reason: reason || 'interaction_resolved' },
      });
      await destroyCompanion(summary.browser_session_id);
    },
    handleUpgrade: handleNekoUpgrade,
    _internal: { companions, getCompanion, handleNekoUpgrade },
  };
}
