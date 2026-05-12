/**
 * n.eko companion adapter.
 *
 * This is intentionally a small HTTP-polling bridge, not a native WebRTC
 * client. It authenticates with n.eko, polls the JPEG screen endpoint, and
 * emits frames in the same shape as the CDP companion so streaming routes can
 * treat both backends the same.
 */

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_SCREENCAST_PATH = 'api/room/screen/cast.jpg';
const DEFAULT_SCREENSHOT_PATH = 'api/room/screen/shot.jpg';
const DEFAULT_LOGIN_PATH = 'api/login';
const DEFAULT_SCREEN_CONFIGURATIONS_PATH = 'api/room/screen/configurations';
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_CDP_OPEN_TIMEOUT_MS = 5_000;
const FOCUS_BINDING_NAME = '__pdppNekoFocusChanged';
const BROWSER_OWNER_MODES = new Set(['neko-owned', 'browser-owner']);
const STEALTH_MODES = new Set(['strict', 'balanced', 'assistive']);
const BROWSER_CHROME_TARGET_RE = /^(chrome|chrome-extension|devtools|edge|chrome-error):/;
const PRIMARY_PAGE_TARGET_RE = /^(https?|data|file):/;
const MAX_COVER_CROP_RATIO = 0.02;
const VERTICAL_CROP_WEIGHT = 2;

function readEnv(env = process.env || {}) {
  return {
    origin: env.NEKO_ORIGIN,
    username: env.NEKO_USERNAME || env.NEKO_USER,
    password: env.NEKO_PASSWORD,
    bearerToken: env.NEKO_BEARER_TOKEN || env.NEKO_BEARER || env.NEKO_API_TOKEN,
    browserOwnerMode: env.PDPP_NEKO_BROWSER_OWNER_MODE || env.NEKO_BROWSER_OWNER_MODE,
    screenshotPath: env.NEKO_SCREENSHOT_PATH,
    cdpHttpUrl: env.PDPP_NEKO_CDP_HTTP_URL || env.NEKO_CDP_HTTP_URL || env.NEKO_CDP_ORIGIN,
    pollIntervalMs: env.NEKO_POLL_INTERVAL_MS ? Number(env.NEKO_POLL_INTERVAL_MS) : undefined,
    stealthMode: env.PDPP_NEKO_STEALTH_MODE || env.NEKO_STEALTH_MODE,
  };
}

function normalizeTarget(target) {
  if (typeof target === 'string') return { origin: target };
  if (target && typeof target === 'object') return target;
  return {};
}

function choose(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeBrowserOwnerMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return BROWSER_OWNER_MODES.has(normalized) ? normalized : 'neko-owned';
}

function normalizeStealthMode(value, browserOwnerMode) {
  const normalized = String(value || '').trim().toLowerCase();
  if (STEALTH_MODES.has(normalized)) return normalized;
  return browserOwnerMode === 'browser-owner' ? 'strict' : 'balanced';
}

function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) {
    const err = new Error('createNekoCompanion: origin is required');
    err.code = 'neko_origin_required';
    throw err;
  }
  return origin.endsWith('/') ? origin : `${origin}/`;
}

function resolveUrl(origin, pathOrUrl) {
  if (typeof pathOrUrl !== 'string' || pathOrUrl.length === 0) {
    throw new Error('n.eko endpoint path is required');
  }
  return new URL(pathOrUrl, origin).toString();
}

function normalizeCdpHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    return parsed.toString().endsWith('/') ? parsed.toString() : `${parsed.toString()}/`;
  } catch {
    return null;
  }
}

function normalizeNavigationUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    // Validate but preserve data: URLs byte-for-byte for playground fixtures.
    new URL(trimmed);
    return trimmed;
  } catch {
    const err = new Error('n.eko navigation URL is invalid');
    err.code = 'neko_navigation_url_invalid';
    throw err;
  }
}

function resolveCdpUrl(origin, path) {
  return new URL(path, origin).toString();
}

function normalizeCdpWebSocketUrl(wsUrl, cdpHttpUrl) {
  const parsed = new URL(wsUrl);
  const cdp = new URL(cdpHttpUrl);
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0') {
    parsed.hostname = cdp.hostname;
    parsed.port = cdp.port || (cdp.protocol === 'https:' ? '443' : '80');
  }
  if (cdp.protocol === 'https:') parsed.protocol = 'wss:';
  if (!parsed.port && cdp.port) parsed.port = cdp.port;
  return parsed.toString();
}

function isBrowserChromeTargetUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  return BROWSER_CHROME_TARGET_RE.test(value);
}

function pageTargetRank(target) {
  const url = String(target?.url || '').trim().toLowerCase();
  if (PRIMARY_PAGE_TARGET_RE.test(url)) return 0;
  if (url === '' || url === 'about:blank') return 1;
  return 2;
}

function addSocketListener(socket, event, handler) {
  if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener(event, handler);
    return;
  }
  if (typeof socket?.on === 'function') {
    socket.on(event, handler);
  }
}

function createDefaultSleep({ setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  return (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeoutFn(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeoutFn(timer);
          resolve();
        },
        { once: true },
      );
    });
}

function isOk(response) {
  if (!response) return false;
  if (typeof response.ok === 'boolean') return response.ok;
  return Number(response.status) >= 200 && Number(response.status) < 300;
}

function statusOf(response) {
  return Number.isFinite(Number(response?.status)) ? Number(response.status) : 0;
}

function getHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || null;
}

function getSetCookieHeaders(response) {
  const headers = response?.headers;
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const setCookie = getHeader(response, 'set-cookie');
  return setCookie ? [setCookie] : [];
}

function cookieHeaderFrom(response) {
  return getSetCookieHeaders(response)
    .map((cookie) => String(cookie).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function responseJsonOrNull(response) {
  if (typeof response?.json !== 'function') return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function asFinitePositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

async function responseToBase64(response) {
  if (typeof response?.arrayBuffer === 'function') {
    return Buffer.from(await response.arrayBuffer()).toString('base64');
  }
  if (typeof response?.buffer === 'function') {
    return Buffer.from(await response.buffer()).toString('base64');
  }
  if (typeof response?.text === 'function') {
    return Buffer.from(await response.text(), 'binary').toString('base64');
  }
  throw new Error('n.eko screenshot response has no readable body');
}

function buildViewportPayload(viewport, frameRate) {
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  const screenWidth = Number(viewport?.screenWidth);
  const screenHeight = Number(viewport?.screenHeight);
  const payload = {};
  if (Number.isFinite(width) && width > 0) payload.width = width;
  if (Number.isFinite(height) && height > 0) payload.height = height;
  if (Number.isFinite(screenWidth) && screenWidth > 0) payload.screenWidth = Math.floor(screenWidth);
  if (Number.isFinite(screenHeight) && screenHeight > 0) payload.screenHeight = Math.floor(screenHeight);
  const selectedScreenWidth = payload.screenWidth || payload.width;
  const selectedScreenHeight = payload.screenHeight || payload.height;
  if (selectedScreenWidth && selectedScreenHeight) payload.screen = `${selectedScreenWidth}x${selectedScreenHeight}@${frameRate}`;
  if (Number.isFinite(Number(viewport?.deviceScaleFactor))) {
    payload.deviceScaleFactor = Number(viewport.deviceScaleFactor);
  }
  if (viewport?.mobile === true) payload.mobile = true;
  if (viewport?.hasTouch === true) payload.hasTouch = true;
  if (typeof viewport?.userAgent === 'string' && viewport.userAgent.length > 0) {
    payload.userAgent = viewport.userAgent.slice(0, 512);
  }
  return payload;
}

function buildFocusDetectionScript() {
  return `
(() => {
  if (window.__pdppNekoFocusListenerActive) return;
  window.__pdppNekoFocusListenerActive = true;
  const bindingName = ${JSON.stringify(FOCUS_BINDING_NAME)};
  function send(payload) {
    const binding = window[bindingName];
    if (typeof binding !== 'function') return;
    binding(JSON.stringify(payload));
  }
  function editableInfo(element) {
    if (!element) return null;
    const tagName = String(element.tagName || '').toUpperCase();
    const isEditable =
      tagName === 'INPUT' ||
      tagName === 'TEXTAREA' ||
      element.isContentEditable === true;
    if (!isEditable) return null;
    const rect = element.getBoundingClientRect();
    return {
      type: 'focus',
      tagName,
      inputType: element.type || '',
      id: element.id || '',
      name: element.name || '',
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }
  document.addEventListener('focusin', (event) => {
    const payload = editableInfo(event.target);
    if (payload) send(payload);
  }, true);
  document.addEventListener('focusout', () => {
    send({ type: 'blur' });
  }, true);
})();
`;
}

function normalizeScreenConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const width = asFinitePositiveInt(value.width);
  const height = asFinitePositiveInt(value.height);
  if (!width || !height) return null;
  const rate = asFinitePositiveInt(value.rate) || 30;
  return { width, height, rate };
}

function estimateCapturedWidth(width) {
  return width - (width % 8);
}

function coverDisplayMetrics(width, height, targetWidth, targetHeight) {
  const scale = Math.max(targetWidth / width, targetHeight / height);
  const displayedWidth = width * scale;
  const displayedHeight = height * scale;
  const horizontalCropArea = Math.max(0, displayedWidth - targetWidth) * targetHeight;
  const verticalCropArea = Math.max(0, displayedHeight - targetHeight) * targetWidth;
  return {
    cropRatio: (horizontalCropArea + verticalCropArea * VERTICAL_CROP_WEIGHT) / (targetWidth * targetHeight),
    scale,
  };
}

function screenConfigScore(config, targetWidth, targetHeight) {
  const projectedWidth = estimateCapturedWidth(config.width);
  const display = coverDisplayMetrics(projectedWidth, config.height, targetWidth, targetHeight);
  return {
    cropRatio: display.cropRatio,
    scaleDelta: Math.abs(Math.log(display.scale)),
    sourceArea: projectedWidth * config.height,
    targetArea: targetWidth * targetHeight,
  };
}

function screenConfigFitsCover(config, targetWidth, targetHeight) {
  return screenConfigScore(config, targetWidth, targetHeight).cropRatio <= MAX_COVER_CROP_RATIO;
}

function rankNekoScreenConfigurations(configs, targetWidth, targetHeight) {
  return [...configs].sort((a, b) => {
    const aScore = screenConfigScore(a, targetWidth, targetHeight);
    const bScore = screenConfigScore(b, targetWidth, targetHeight);
    const aFits = aScore.cropRatio <= MAX_COVER_CROP_RATIO;
    const bFits = bScore.cropRatio <= MAX_COVER_CROP_RATIO;
    if (aFits !== bFits) return aFits ? -1 : 1;
    if (aFits && bFits) {
      if (aScore.scaleDelta !== bScore.scaleDelta) return aScore.scaleDelta - bScore.scaleDelta;
      if (aScore.cropRatio !== bScore.cropRatio) return aScore.cropRatio - bScore.cropRatio;
      return Math.abs(aScore.sourceArea - aScore.targetArea) - Math.abs(bScore.sourceArea - bScore.targetArea);
    }
    if (aScore.cropRatio !== bScore.cropRatio) return aScore.cropRatio - bScore.cropRatio;
    if (aScore.scaleDelta !== bScore.scaleDelta) return aScore.scaleDelta - bScore.scaleDelta;
    return Math.abs(aScore.sourceArea - aScore.targetArea) - Math.abs(bScore.sourceArea - bScore.targetArea);
  });
}

function viewportDimensions(viewport) {
  const width = asFinitePositiveInt(viewport?.width);
  const height = asFinitePositiveInt(viewport?.height);
  return width && height ? { width, height } : null;
}

function viewportScreenDimensions(viewport) {
  const dimensions = viewportDimensions(viewport);
  if (!dimensions) return null;
  const screenWidth = asFinitePositiveInt(viewport?.screenWidth);
  const screenHeight = asFinitePositiveInt(viewport?.screenHeight);
  return screenWidth && screenHeight
    ? {
        width: Math.max(dimensions.width, screenWidth),
        height: Math.max(dimensions.height, screenHeight),
      }
    : dimensions;
}

function viewportHasSeparateScreenDimensions(viewport) {
  const dimensions = viewportDimensions(viewport);
  const screen = viewportScreenDimensions(viewport);
  return !!(dimensions && screen && (dimensions.width !== screen.width || dimensions.height !== screen.height));
}

function viewportVisibleAreaOverride(viewport) {
  if (!viewportHasSeparateScreenDimensions(viewport)) return null;
  const screen = viewportScreenDimensions(viewport);
  if (!screen) return null;
  return {
    x: 0,
    y: 0,
    width: screen.width,
    height: screen.height,
    scale: 1,
  };
}

function viewportDeviceScaleFactor(viewport) {
  const dpr = Number(viewport?.deviceScaleFactor);
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

function viewportIsMobile(viewport) {
  return viewport?.mobile === true;
}

function viewportHasTouch(viewport) {
  return viewport?.hasTouch === true || viewport?.mobile === true;
}

function viewportUserAgent(viewport) {
  return typeof viewport?.userAgent === 'string' && viewport.userAgent.length > 0
    ? viewport.userAgent.slice(0, 512)
    : null;
}

function metricNearlyEqual(actual, expected, tolerance = 1) {
  return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tolerance;
}

function pageMetricsMismatch(page, viewport) {
  if (!page || typeof page !== 'object') return null;
  const dimensions = viewportDimensions(viewport);
  if (!dimensions) return null;
  const screenDimensions = viewportScreenDimensions(viewport) || dimensions;
  const expected = {
    innerWidth: dimensions.width,
    innerHeight: dimensions.height,
    screenWidth: screenDimensions.width,
    screenHeight: screenDimensions.height,
    devicePixelRatio: viewportDeviceScaleFactor(viewport),
    hasTouch: viewportHasTouch(viewport),
    userAgent: viewportUserAgent(viewport),
  };
  const mismatches = {};
  for (const key of ['innerWidth', 'innerHeight', 'screenWidth', 'screenHeight']) {
    if (!metricNearlyEqual(page[key], expected[key])) {
      mismatches[key] = { actual: page[key] ?? null, expected: expected[key] };
    }
  }
  if (!metricNearlyEqual(page.devicePixelRatio, expected.devicePixelRatio, 0.01)) {
    mismatches.devicePixelRatio = {
      actual: page.devicePixelRatio ?? null,
      expected: expected.devicePixelRatio,
    };
  }
  if (expected.hasTouch && typeof page.hasTouch === 'boolean' && page.hasTouch !== expected.hasTouch) {
    mismatches.hasTouch = { actual: page.hasTouch, expected: expected.hasTouch };
  }
  if (expected.userAgent && typeof page.userAgent === 'string' && page.userAgent !== expected.userAgent) {
    mismatches.userAgent = { actual: page.userAgent, expected: expected.userAgent };
  }
  return Object.keys(mismatches).length > 0 ? mismatches : null;
}

function buildViewportStatusExpression() {
  // Also drain `window.__pdppPlaygroundEvents` (a small ring buffer the
  // playground page maintains for click/focus/scroll telemetry) into
  // the status payload, then clear it so subsequent polls return only
  // new events. The viewer side correlates these by timestamp against
  // local touch/click telemetry to verify wrong-position press
  // detection. Read-only on every page that doesn't expose the buffer
  // (returns []), so safe in production.
  return `(() => {
    const drained = Array.isArray(window.__pdppPlaygroundEvents)
      ? window.__pdppPlaygroundEvents.splice(0, window.__pdppPlaygroundEvents.length)
      : [];
    return JSON.stringify({
      url: location.href,
      title: document.title,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenWidth: window.screen && window.screen.width,
      screenHeight: window.screen && window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      touchEventPresent: 'ontouchstart' in window,
      hasTouch: (navigator.maxTouchPoints || 0) > 0,
      activeElement: document.activeElement ? {
        tagName: document.activeElement.tagName,
        type: document.activeElement.type || '',
        id: document.activeElement.id || '',
        name: document.activeElement.name || '',
        isContentEditable: document.activeElement.isContentEditable === true
      } : null,
      playgroundEvents: drained
    });
  })()`;
}

export function buildCopySelectionExpression() {
  return `(() => {
    const active = document.activeElement;
    const isTextInput = active && active.tagName === 'INPUT' && String(active.type || '').toLowerCase() !== 'password';
    const isTextarea = active && active.tagName === 'TEXTAREA';
    if ((isTextInput || isTextarea) && typeof active.value === 'string') {
      try {
        const start = typeof active.selectionStart === 'number' ? active.selectionStart : null;
        const end = typeof active.selectionEnd === 'number' ? active.selectionEnd : null;
        if (start !== null && end !== null && end > start) {
          return active.value.slice(start, end);
        }
      } catch (_) {
        // Some input types expose selectionStart but throw when read.
      }
    }
    return document.getSelection()?.toString() ?? '';
  })()`;
}

function buildMetadata(viewport, now) {
  return {
    device_width: Number.isFinite(Number(viewport?.width)) ? Number(viewport.width) : null,
    device_height: Number.isFinite(Number(viewport?.height)) ? Number(viewport.height) : null,
    offset_top: 0,
    page_scale_factor: Number.isFinite(Number(viewport?.deviceScaleFactor)) ? Number(viewport.deviceScaleFactor) : 1,
    timestamp: now(),
    scroll_offset_x: 0,
    scroll_offset_y: 0,
  };
}

function normalizeBearer(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  return token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
}

function endpointList(config, names) {
  return names
    .map((name) => config[name])
    .filter((endpoint) => typeof endpoint === 'string' && endpoint.length > 0);
}

function safeLog(logger, level, msg, data) {
  if (!logger || typeof logger[level] !== 'function') return;
  try {
    logger[level]({ msg, ...(data || {}) });
  } catch {
    /* logger errors must not break the streaming path */
  }
}

export function createNekoCompanion(options = {}) {
  const env = readEnv(options.env);
  const target = normalizeTarget(options.target);
  const fetchImpl = choose(options.fetchImpl, target.fetchImpl, globalThis.fetch);
  if (typeof fetchImpl !== 'function') {
    throw new Error('createNekoCompanion: fetch implementation is required');
  }

  const origin = normalizeOrigin(choose(options.origin, target.origin, target.base_url, target.baseUrl, env.origin));
  const browser_session_id = choose(options.browser_session_id, target.browser_session_id, 'neko-session');
  const logger = choose(options.logger, target.logger);
  const now = choose(options.now, target.now, Date.now);
  const sleep =
    choose(options.sleep, target.sleep) ||
    createDefaultSleep({
      setTimeoutFn: choose(options.setTimeoutFn, target.setTimeoutFn, setTimeout),
      clearTimeoutFn: choose(options.clearTimeoutFn, target.clearTimeoutFn, clearTimeout),
    });

  const loginUrl = resolveUrl(origin, choose(options.loginPath, target.loginPath, DEFAULT_LOGIN_PATH));
  const screencastUrl = resolveUrl(
    origin,
    choose(options.screencastPath, target.screencastPath, options.screenshotPath, target.screenshotPath, env.screenshotPath, DEFAULT_SCREENCAST_PATH),
  );
  const screenshotFallbackUrl = resolveUrl(
    origin,
    choose(options.screenshotFallbackPath, target.screenshotFallbackPath, DEFAULT_SCREENSHOT_PATH),
  );
  const pollIntervalMs = Number(
    choose(options.pollIntervalMs, target.pollIntervalMs, env.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
  );
  const frameRate = Number(choose(options.frameRate, target.frameRate, 30));
  const username = choose(options.username, target.username, env.username);
  const password = choose(options.password, target.password, env.password);
  const cdpHttpUrl = normalizeCdpHttpUrl(
    choose(
      options.cdpHttpUrl,
      target.cdpHttpUrl,
      target.cdp_http_url,
      target.cdp?.httpUrl,
      target.cdp?.http_url,
      env.cdpHttpUrl,
    ),
  );
  const WebSocketCtor = choose(options.WebSocketCtor, target.WebSocketCtor, globalThis.WebSocket);
  const cdpControlAvailable = Boolean(cdpHttpUrl && typeof WebSocketCtor === 'function');
  const browserOwnerMode = normalizeBrowserOwnerMode(
    choose(options.browserOwnerMode, target.browserOwnerMode, target.browser_owner_mode, env.browserOwnerMode),
  );
  const stealthMode = normalizeStealthMode(
    choose(options.stealthMode, target.stealthMode, target.stealth_mode, env.stealthMode),
    browserOwnerMode,
  );
  const navigationUrl = normalizeNavigationUrl(
    choose(
      options.startUrl,
      options.start_url,
      options.navigationUrl,
      options.navigation_url,
      options.navigateUrl,
      options.navigate_url,
      target.startUrl,
      target.start_url,
      target.navigationUrl,
      target.navigation_url,
      target.navigateUrl,
      target.navigate_url,
    ),
  );
  const browserWindowCdpAllowed = cdpControlAvailable && stealthMode !== 'strict';
  const pageEmulationCdpAllowed = cdpControlAvailable && stealthMode !== 'strict';
  // Page.navigate is the one CDP command that is functionally identical to
  // a real user typing a URL into the omnibox — it does not enable any
  // event domain, does not inject any script, and leaves no trace beyond
  // a normal Network.* sequence that every page load already produces.
  // Without this, strict mode leaves the n.eko browser sitting on its
  // bootup data: URL, so the user never reaches the manual_action target.
  const pageNavigationCdpAllowed = cdpControlAvailable;
  const pageFocusCdpAllowed = cdpControlAvailable && stealthMode !== 'strict';
  const assistivePageCdpAllowed = cdpControlAvailable && stealthMode === 'assistive';
  const cdpCommandTimeoutMs = Number(
    choose(options.commandTimeoutMs, target.commandTimeoutMs, DEFAULT_CDP_COMMAND_TIMEOUT_MS),
  );
  const cdpOpenTimeoutMs = Number(choose(options.openTimeoutMs, target.openTimeoutMs, DEFAULT_CDP_OPEN_TIMEOUT_MS));
  let bearer = normalizeBearer(choose(options.bearerToken, target.bearerToken, options.bearer, target.bearer, env.bearerToken));
  let cookie = choose(options.cookie, target.cookie, null);

  const frameHandlers = new Set();
  const eventHandlers = new Set();
  let pageCdpConnection = null;
  let pageCdpConnectionPromise = null;
  let pageCdpSessionId = null;
  let pageFocusSetupPromise = null;
  let pageFocusSetupComplete = false;
  let lastCdpViewport = null;
  let started = false;
  let closed = false;
  let authReady = false;
  let frameSeq = 0;
  let currentViewport = null;
  let abortController = null;
  let pollLoopPromise = null;
  let navigationApplied = false;
  let screencastPipelineDisabled = false;

  function headers(extra = {}) {
    const out = { ...(target.headers || {}), ...(options.headers || {}), ...extra };
    if (bearer) out.Authorization = bearer;
    if (cookie) out.Cookie = cookie;
    return out;
  }

  async function ensureOk(response, code) {
    if (isOk(response)) return response;
    const err = new Error(`n.eko request failed with status ${statusOf(response)}`);
    err.code = code;
    err.status = statusOf(response);
    throw err;
  }

  async function fetchWithAuth(url, request = {}) {
    return fetchImpl(url, {
      ...request,
      headers: headers(request.headers),
    });
  }

  async function authenticate(signal) {
    if (authReady) return;
    if (bearer || (!username && !password)) {
      authReady = true;
      return;
    }

    const body = username ? { username, password } : { password };
    const response = await fetchImpl(loginUrl, {
      method: 'POST',
      signal,
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    await ensureOk(response, 'neko_login_failed');

    const nextCookie = cookieHeaderFrom(response);
    if (nextCookie) cookie = nextCookie;
    const json = await responseJsonOrNull(response);
    const token = choose(json?.token, json?.access_token, json?.session, json?.NEKO_SESSION);
    if (token) bearer = normalizeBearer(token);
    authReady = true;
  }

  async function postJson(url, payload, signal) {
    const response = await fetchWithAuth(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return ensureOk(response, 'neko_post_failed');
  }

  function createCdpError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function rejectCdpPending(connection, reason) {
    for (const [, entry] of connection.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    connection.pending.clear();
  }

  function parseCdpMessage(raw) {
    const value = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    return JSON.parse(text);
  }

  function createCdpConnection(wsUrl, label, signal) {
    return new Promise((resolve, reject) => {
      if (!cdpControlAvailable) {
        reject(createCdpError('n.eko CDP control is not configured', 'neko_cdp_unavailable'));
        return;
      }
      if (signal?.aborted) {
        reject(createCdpError('n.eko CDP connection aborted', 'neko_cdp_aborted'));
        return;
      }

      let socket;
      try {
        socket = new WebSocketCtor(wsUrl);
      } catch (err) {
        reject(createCdpError(`Failed to open n.eko CDP socket: ${err?.message || err}`, 'neko_cdp_connect_failed'));
        return;
      }

      let opened = false;
      let settled = false;
      const connection = {
        socket,
        pending: new Map(),
        nextId: 1,
        isOpen() {
          return socket.readyState === 1;
        },
        close() {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
        },
        send(method, params = {}, sessionId = null) {
          if (signal?.aborted) {
            return Promise.reject(createCdpError('n.eko CDP command aborted', 'neko_cdp_aborted'));
          }
          if (socket.readyState !== 1) {
            return Promise.reject(createCdpError('n.eko CDP socket is not open', 'neko_cdp_not_open'));
          }
          return new Promise((commandResolve, commandReject) => {
            const id = connection.nextId++;
            const timer = setTimeout(() => {
              if (connection.pending.delete(id)) {
                commandReject(createCdpError(`n.eko CDP command timed out: ${method}`, 'neko_cdp_timeout'));
              }
            }, cdpCommandTimeoutMs);
            connection.pending.set(id, { resolve: commandResolve, reject: commandReject, timer });
            try {
              const message = { id, method, params };
              if (sessionId) message.sessionId = sessionId;
              socket.send(JSON.stringify(message));
            } catch (err) {
              connection.pending.delete(id);
              clearTimeout(timer);
              commandReject(createCdpError(`Failed to send n.eko CDP command: ${method}`, 'neko_cdp_send_failed'));
            }
          });
        },
      };

      const openTimer = setTimeout(() => {
        if (opened) return;
        settled = true;
        connection.close();
        reject(createCdpError(`n.eko CDP ${label} connection timed out`, 'neko_cdp_connect_timeout'));
      }, cdpOpenTimeoutMs);
      const onAbort = () => {
        connection.close();
        rejectCdpPending(connection, createCdpError('n.eko CDP connection aborted', 'neko_cdp_aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      addSocketListener(socket, 'open', () => {
        opened = true;
        settled = true;
        clearTimeout(openTimer);
        resolve(connection);
      });
      addSocketListener(socket, 'message', (event) => {
        let msg;
        try {
          msg = parseCdpMessage(event);
        } catch (err) {
          safeLog(logger, 'warn', 'neko_cdp_message_parse_failed', { label, error: err?.message });
          return;
        }
        handlePageCdpEvent(msg);
        if (!msg || typeof msg !== 'object' || !('id' in msg)) return;
        const entry = connection.pending.get(msg.id);
        if (!entry) return;
        connection.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          const err = createCdpError(msg.error.message || 'n.eko CDP command failed', 'neko_cdp_command_failed');
          err.cdp = msg.error;
          entry.reject(err);
        } else {
          entry.resolve(msg.result || {});
        }
      });
      addSocketListener(socket, 'error', (event) => {
        const message = event?.message || event?.error?.message || 'n.eko CDP socket error';
        const err = createCdpError(message, 'neko_cdp_socket_error');
        rejectCdpPending(connection, err);
        if (!settled) {
          settled = true;
          clearTimeout(openTimer);
          reject(err);
        }
      });
      addSocketListener(socket, 'close', () => {
        const err = createCdpError('n.eko CDP socket closed', 'neko_cdp_closed');
        rejectCdpPending(connection, err);
        if (!settled) {
          settled = true;
          clearTimeout(openTimer);
          reject(err);
        }
        signal?.removeEventListener?.('abort', onAbort);
      });
    });
  }

  async function fetchCdpJson(path, signal) {
    const response = await fetchImpl(resolveCdpUrl(cdpHttpUrl, path), { method: 'GET', signal });
    await ensureOk(response, 'neko_cdp_http_failed');
    return responseJsonOrNull(response);
  }

  async function getNekoPageTarget(signal) {
    const targets = await fetchCdpJson('json', signal);
    if (!Array.isArray(targets)) {
      throw createCdpError('n.eko CDP target list is invalid', 'neko_cdp_target_invalid');
    }
    const pages = targets
      .filter((item) => item?.type === 'page' && item.webSocketDebuggerUrl && !isBrowserChromeTargetUrl(item.url))
      .sort((a, b) => pageTargetRank(a) - pageTargetRank(b));
    const page = pages[0];
    if (!page?.webSocketDebuggerUrl) {
      throw createCdpError('n.eko CDP page target not found', 'neko_cdp_target_missing');
    }
    return {
      ...page,
      webSocketDebuggerUrl: normalizeCdpWebSocketUrl(page.webSocketDebuggerUrl, cdpHttpUrl),
    };
  }

  async function getNekoBrowserWebSocketUrl(signal) {
    const version = await fetchCdpJson('json/version', signal);
    if (!version?.webSocketDebuggerUrl) {
      throw createCdpError('n.eko CDP browser target not found', 'neko_cdp_browser_missing');
    }
    return normalizeCdpWebSocketUrl(version.webSocketDebuggerUrl, cdpHttpUrl);
  }

  async function sendBrowserCdp(method, params, signal) {
    const wsUrl = await getNekoBrowserWebSocketUrl(signal);
    const connection = await createCdpConnection(wsUrl, 'browser', signal);
    try {
      return await connection.send(method, params);
    } finally {
      connection.close();
    }
  }

  async function getPageCdpConnection(signal) {
    if (pageCdpConnection?.isOpen() && pageCdpSessionId) return pageCdpConnection;
    if (pageCdpConnectionPromise) return pageCdpConnectionPromise;

    pageCdpConnectionPromise = (async () => {
      const page = await getNekoPageTarget(signal);
      const wsUrl = await getNekoBrowserWebSocketUrl(signal);
      const connection = await createCdpConnection(wsUrl, 'page', signal);
      const attached = await connection.send('Target.attachToTarget', {
        targetId: page.id,
        flatten: true,
      });
      if (typeof attached?.sessionId !== 'string' || attached.sessionId.length === 0) {
        connection.close();
        throw createCdpError('n.eko CDP target attach failed', 'neko_cdp_attach_failed');
      }
      pageCdpSessionId = attached.sessionId;
      pageCdpConnection = connection;
      return connection;
    })();

    try {
      return await pageCdpConnectionPromise;
    } catch (err) {
      pageCdpConnection = null;
      pageCdpSessionId = null;
      throw err;
    } finally {
      pageCdpConnectionPromise = null;
    }
  }

  async function sendPageCdp(method, params, signal) {
    const connection = await getPageCdpConnection(signal);
    return connection.send(method, params, pageCdpSessionId);
  }

  function handlePageCdpEvent(message) {
    if (!message || typeof message !== 'object') return;
    if (message.sessionId && pageCdpSessionId && message.sessionId !== pageCdpSessionId) return;
    if (message.method !== 'Runtime.bindingCalled') return;
    const params = message.params || {};
    if (params.name !== FOCUS_BINDING_NAME || typeof params.payload !== 'string') return;
    try {
      const payload = JSON.parse(params.payload);
      emitEvent({
        kind: 'keyboard_focus',
        focused: payload?.type === 'focus',
        element: payload && typeof payload === 'object' ? payload : null,
      });
    } catch (err) {
      safeLog(logger, 'warn', 'neko_focus_event_parse_failed', { error: err?.message });
    }
  }

  async function setupFocusDetectionBestEffort(signal) {
    if (!pageFocusCdpAllowed || pageFocusSetupComplete) return;
    if (pageFocusSetupPromise) return pageFocusSetupPromise;
    pageFocusSetupPromise = (async () => {
      await sendPageCdp('Runtime.enable', {}, signal);
      await sendPageCdp('Page.enable', {}, signal);
      await sendPageCdp('Runtime.addBinding', { name: FOCUS_BINDING_NAME }, signal);
      const source = buildFocusDetectionScript();
      await sendPageCdp('Page.addScriptToEvaluateOnNewDocument', { source }, signal);
      await sendPageCdp('Runtime.evaluate', { expression: source }, signal);
      pageFocusSetupComplete = true;
    })();
    try {
      await pageFocusSetupPromise;
    } catch (err) {
      pageFocusSetupPromise = null;
      closePageCdpConnection();
      safeLog(logger, 'warn', 'neko_focus_detection_failed', {
        browser_owner_mode: browserOwnerMode,
        stealth_mode: stealthMode,
        error: err?.message,
      });
    }
  }

  function closePageCdpConnection() {
    if (!pageCdpConnection) return;
    try {
      pageCdpConnection.close();
    } catch {
      /* ignore */
    }
    pageCdpConnection = null;
    pageCdpSessionId = null;
    pageFocusSetupPromise = null;
    pageFocusSetupComplete = false;
  }

  async function applyScreenConfigurationBestEffort(viewport, signal) {
    const dimensions = viewportScreenDimensions(viewport);
    if (!dimensions) return null;
    const config = { ...target, ...options };
    const screenEndpoint = choose(config.screenEndpoint);
    const configurationsEndpoint = choose(
      config.screenConfigurationsEndpoint,
      config.screenConfigurationsPath,
      config.screen_configurations_endpoint,
    );
    if (!screenEndpoint || !configurationsEndpoint) return null;

    const response = await fetchWithAuth(resolveUrl(origin, configurationsEndpoint), { method: 'GET', signal });
    await ensureOk(response, 'neko_screen_configurations_failed');
    const configs = (await responseJsonOrNull(response))
      ?.map((item) => normalizeScreenConfig(item))
      .filter(Boolean);
    if (!configs?.length) {
      throw createCdpError('n.eko screen configuration list is empty', 'neko_screen_configurations_empty');
    }

    const [candidate] = rankNekoScreenConfigurations(configs, dimensions.width, dimensions.height);
    if (!candidate) return null;
    const appliedResponse = await postJson(resolveUrl(origin, screenEndpoint), candidate, signal);
    const appliedBody = await responseJsonOrNull(appliedResponse);
    const lastApplied = normalizeScreenConfig(appliedBody) || candidate;
    if (!lastApplied) return null;
    if (!screenConfigFitsCover(lastApplied, dimensions.width, dimensions.height)) {
      safeLog(logger, 'warn', 'neko_screen_configuration_imperfect_fit', {
        applied: lastApplied,
        requested: dimensions,
      });
    }
    return {
      width: estimateCapturedWidth(lastApplied.width),
      height: lastApplied.height,
      rate: lastApplied.rate,
    };
  }

  async function applyCdpViewportBestEffort(viewport, signal) {
    if (!cdpControlAvailable) return;
    const dimensions = viewportDimensions(viewport);
    if (!dimensions) return;
    const screenDimensions = viewportScreenDimensions(viewport) || dimensions;
    const visibleAreaOverride = viewportVisibleAreaOverride(viewport);
    const deviceScaleFactor = viewportDeviceScaleFactor(viewport);
    const mobile = viewportIsMobile(viewport);
    const hasTouch = viewportHasTouch(viewport);
    const screenOrientation =
      dimensions.height >= dimensions.width
        ? { type: 'portraitPrimary', angle: 0 }
        : { type: 'landscapePrimary', angle: 90 };

    if (browserWindowCdpAllowed) {
      try {
        const page = await getNekoPageTarget(signal);
        const targetInfo = await sendBrowserCdp('Browser.getWindowForTarget', { targetId: page.id }, signal);
        if (Number.isFinite(Number(targetInfo?.windowId))) {
          await sendBrowserCdp(
            'Browser.setWindowBounds',
            {
              windowId: targetInfo.windowId,
              bounds: {
                left: 0,
                top: 0,
                width: screenDimensions.width,
                height: screenDimensions.height,
                windowState: 'normal',
              },
            },
            signal,
          );
        }
      } catch (err) {
        safeLog(logger, 'warn', 'neko_cdp_window_bounds_failed', { error: err?.message });
      }
    }

    if (pageEmulationCdpAllowed) {
      try {
        await sendPageCdp(
          'Emulation.setDeviceMetricsOverride',
          {
            width: dimensions.width,
            height: dimensions.height,
            deviceScaleFactor,
            mobile,
            screenWidth: screenDimensions.width,
            screenHeight: screenDimensions.height,
            positionX: 0,
            positionY: 0,
            screenOrientation,
            ...(visibleAreaOverride ? { viewport: visibleAreaOverride } : {}),
          },
          signal,
        );
      } catch (err) {
        safeLog(logger, 'warn', 'neko_cdp_device_metrics_failed', { error: err?.message });
      }
    }

    if (pageEmulationCdpAllowed) {
      try {
        await sendPageCdp(
          'Emulation.setTouchEmulationEnabled',
          hasTouch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false, maxTouchPoints: 0 },
          signal,
        );
        await sendPageCdp(
          'Emulation.setEmitTouchEventsForMouse',
          { enabled: false, configuration: mobile ? 'mobile' : 'desktop' },
          signal,
        );
      } catch (err) {
        safeLog(logger, 'warn', 'neko_cdp_touch_emulation_failed', { error: err?.message });
      }
    }

    const userAgent = viewportUserAgent(viewport);
    if (userAgent && assistivePageCdpAllowed) {
      try {
        await sendPageCdp('Emulation.setUserAgentOverride', { userAgent }, signal);
      } catch (err) {
        safeLog(logger, 'warn', 'neko_cdp_user_agent_failed', { error: err?.message });
      }
    }
  }

  async function applyInitialNavigation(signal) {
    if (!navigationUrl || navigationApplied) return false;
    if (!pageNavigationCdpAllowed) {
      const err = createCdpError(
        'n.eko CDP navigation control is not configured',
        'neko_cdp_navigation_unavailable',
      );
      safeLog(logger, 'warn', 'neko_initial_navigation_skipped', {
        browser_owner_mode: browserOwnerMode,
        stealth_mode: stealthMode,
      });
      throw err;
    }

    try {
      await sendPageCdp('Page.navigate', { url: navigationUrl }, signal);
      navigationApplied = true;
      return true;
    } catch (err) {
      safeLog(logger, 'warn', 'neko_initial_navigation_failed', { error: err?.message });
      throw err;
    }
  }

  async function insertTextViaCdp(text, signal) {
    if (!assistivePageCdpAllowed) {
      throw createCdpError('n.eko CDP paste control is not configured', 'neko_cdp_unavailable');
    }
    await sendPageCdp('Input.insertText', { text }, signal);
  }

  function emitEvent(event) {
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        safeLog(logger, 'warn', 'neko_event_handler_error', { kind: event?.kind, error: err?.message });
      }
    }
  }

  async function copySelectionViaCdp(signal) {
    if (!assistivePageCdpAllowed) {
      throw createCdpError('n.eko CDP copy control is not configured', 'neko_cdp_unavailable');
    }
    await sleep(50, signal);
    const result = await sendPageCdp(
      'Runtime.evaluate',
      {
        expression: buildCopySelectionExpression(),
        returnByValue: true,
      },
      signal,
    );
    const text = result?.result?.value;
    if (typeof text === 'string' && text.length > 0) {
      emitEvent({ kind: 'clipboard', text });
    }
  }

  async function readPageViewportStatus(signal) {
    const result = await sendPageCdp(
      'Runtime.evaluate',
      {
        expression: buildViewportStatusExpression(),
        returnByValue: true,
      },
      signal,
    );
    const value = result?.result?.value;
    if (typeof value !== 'string') return null;
    try {
      return JSON.parse(value);
    } catch {
      return { raw: value };
    }
  }

  async function queryNekoStatus() {
    const status = {};

    try {
      await authenticate(abortController?.signal);
      const config = { ...target, ...options };
      const screenEndpoint = choose(config.screenEndpoint, 'api/room/screen');
      const response = await fetchWithAuth(resolveUrl(origin, screenEndpoint), {
        method: 'GET',
        signal: abortController?.signal,
      });
      if (isOk(response)) status.screen = await responseJsonOrNull(response);
    } catch (err) {
      status.screen_error = {
        code: err?.code || 'neko_screen_status_failed',
        message: err?.message || 'n.eko screen status failed',
      };
    }

    let page = null;
    if (browserWindowCdpAllowed) {
      try {
        page = await getNekoPageTarget(abortController?.signal);
        status.target = {
          id: page.id || null,
          url: page.url || null,
        };
        const targetInfo = await sendBrowserCdp(
          'Browser.getWindowForTarget',
          { targetId: page.id },
          abortController?.signal,
        );
        if (targetInfo && typeof targetInfo === 'object') status.window = targetInfo;
      } catch (err) {
        status.window_error = {
          code: err?.code || 'neko_window_status_failed',
          message: err?.message || 'n.eko window status failed',
        };
      }
    } else {
      status.window_skipped = {
        browser_owner_mode: browserOwnerMode,
        stealth_mode: stealthMode,
      };
    }

    if (assistivePageCdpAllowed) {
      try {
        status.page_cdp_available = true;
        status.page = await readPageViewportStatus(abortController?.signal);
        const expectedViewport = lastCdpViewport || currentViewport;
        const mismatch = pageMetricsMismatch(status.page, expectedViewport);
        if (mismatch) {
          status.page_metrics_mismatch = mismatch;
          closePageCdpConnection();
          try {
            await applyCdpViewportBestEffort(expectedViewport, abortController?.signal);
            status.page_metrics_reapplied = true;
            status.page = await readPageViewportStatus(abortController?.signal);
            const remainingMismatch = pageMetricsMismatch(status.page, expectedViewport);
            if (remainingMismatch) {
              status.page_metrics_mismatch_after_reapply = remainingMismatch;
            }
          } catch (err) {
            closePageCdpConnection();
            status.page_metrics_reapply_error = {
              code: err?.code || 'neko_page_metrics_reapply_failed',
              message: err?.message || 'n.eko page metrics reapply failed',
            };
          }
        }
      } catch (err) {
        closePageCdpConnection();
        status.page_cdp_available = false;
        status.page_cdp_error = {
          code: err?.code || 'neko_page_status_failed',
          message: err?.message || 'n.eko page status failed',
        };
      }
    } else {
      status.page_cdp_available = false;
      status.page_cdp_skipped = {
        browser_owner_mode: browserOwnerMode,
        stealth_mode: stealthMode,
      };
    }

    return status;
  }

  async function applyViewportBestEffort(viewport, signal) {
    if (!viewport || typeof viewport !== 'object') return null;
    const payload =
      typeof target.viewportPayload === 'function'
        ? target.viewportPayload(viewport)
        : target.viewportPayload || options.viewportPayload || buildViewportPayload(viewport, frameRate);
    let appliedScreen = null;
    try {
      appliedScreen = await applyScreenConfigurationBestEffort(viewport, signal);
    } catch (err) {
      safeLog(logger, 'warn', 'neko_screen_configuration_failed', { error: err?.message });
    }

    const config = { ...target, ...options };
    const endpoints = endpointList(config, [
      'viewportEndpoint',
      'screenConfigEndpoint',
      'windowEndpoint',
      'windowControlEndpoint',
    ]);
    if (!appliedScreen && typeof config.screenEndpoint === 'string' && config.screenEndpoint.length > 0) {
      endpoints.push(config.screenEndpoint);
    }

    for (const endpoint of endpoints) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await postJson(resolveUrl(origin, endpoint), payload, signal);
      } catch (err) {
        safeLog(logger, 'warn', 'neko_viewport_update_failed', { endpoint, error: err?.message });
      }
    }

    const cdpViewport = appliedScreen
      ? viewportHasSeparateScreenDimensions(viewport)
        ? {
            ...viewport,
            screenHeight: appliedScreen.height,
            screenWidth: appliedScreen.width,
          }
        : {
            ...viewport,
            height: appliedScreen.height,
            width: appliedScreen.width,
          }
      : viewport;
    lastCdpViewport = cdpViewport;
    await applyCdpViewportBestEffort(cdpViewport, signal);
    return cdpViewport;
  }

  function emitFrame(data) {
    const frame = {
      sessionId: ++frameSeq,
      data,
      metadata: buildMetadata(currentViewport, now),
    };
    for (const handler of frameHandlers) {
      try {
        handler(frame);
      } catch (err) {
        safeLog(logger, 'warn', 'neko_frame_handler_error', { error: err?.message });
      }
    }
  }

  async function fetchFrame(signal) {
    if (screencastPipelineDisabled) {
      const fallback = await fetchWithAuth(screenshotFallbackUrl, { method: 'GET', signal });
      await ensureOk(fallback, 'neko_screenshot_failed');
      return responseToBase64(fallback);
    }
    const primary = await fetchWithAuth(screencastUrl, { method: 'GET', signal });
    if (isOk(primary)) return responseToBase64(primary);
    if (statusOf(primary) === 400 && screenshotFallbackUrl !== screencastUrl) {
      screencastPipelineDisabled = true;
      const fallback = await fetchWithAuth(screenshotFallbackUrl, { method: 'GET', signal });
      await ensureOk(fallback, 'neko_screenshot_failed');
      return responseToBase64(fallback);
    }
    await ensureOk(primary, 'neko_screenshot_failed');
    return null;
  }

  async function pollLoop(signal) {
    while (!signal.aborted && started && !closed) {
      try {
        const data = await fetchFrame(signal);
        if (data && !signal.aborted && started && !closed) emitFrame(data);
      } catch (err) {
        if (!signal.aborted) safeLog(logger, 'warn', 'neko_frame_poll_failed', { error: err?.message });
      }
      if (!signal.aborted && started && !closed) await sleep(pollIntervalMs, signal);
    }
  }

  async function start(viewport) {
    if (closed) {
      const err = new Error('Streaming companion is closed');
      err.code = 'companion_closed';
      throw err;
    }
    if (started) return;
    abortController = new AbortController();
    currentViewport = viewport || null;
    await authenticate(abortController.signal);
    currentViewport = (await applyViewportBestEffort(currentViewport, abortController.signal)) || currentViewport;
    const navigated = await applyInitialNavigation(abortController.signal);
    if (navigated && lastCdpViewport) {
      // Page navigation can clear target-scoped emulation in Chromium. Reopen
      // the page session and re-apply metrics so the rendered page matches the
      // already-selected n.eko screen size from the first viewport pass.
      closePageCdpConnection();
      await applyCdpViewportBestEffort(lastCdpViewport, abortController.signal);
    }
    await setupFocusDetectionBestEffort(abortController.signal);
    started = true;
    pollLoopPromise = pollLoop(abortController.signal).catch((err) => {
      safeLog(logger, 'warn', 'neko_poll_loop_failed', { error: err?.message });
    });
  }

  async function stop() {
    if (closed) return;
    closed = true;
    started = false;
    abortController?.abort();
    await pollLoopPromise;
    closePageCdpConnection();
    frameHandlers.clear();
    eventHandlers.clear();
  }

  async function dispatch(event) {
    if (event?.type === 'viewport') {
      currentViewport = event;
      await authenticate(abortController?.signal);
      currentViewport = (await applyViewportBestEffort(event, abortController?.signal)) || currentViewport;
      return;
    }

    if (event?.type === 'paste' && typeof event.text === 'string') {
      if (assistivePageCdpAllowed) {
        await authenticate(abortController?.signal);
        await insertTextViaCdp(event.text, abortController?.signal);
        return;
      }
    }

    if (event?.type === 'copy') {
      if (assistivePageCdpAllowed) {
        await authenticate(abortController?.signal);
        await copySelectionViaCdp(abortController?.signal);
        return;
      }
    }

    const inputEndpoint = choose(options.inputEndpoint, target.inputEndpoint, target.dispatchEndpoint, options.dispatchEndpoint);
    if (!inputEndpoint) return;
    await authenticate(abortController?.signal);
    await postJson(resolveUrl(origin, inputEndpoint), event, abortController?.signal);
  }

  const companion = {
    backend: 'neko',
    browser_session_id,
    start,
    stop,
    onFrame(handler) {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    dispatch,
    async ackFrame() {
      // HTTP-polling n.eko screenshots do not use CDP back-pressure.
    },
    getNekoProxyTarget() {
      return { origin };
    },
    /** test-only escape hatch */
    _internal: {
      isStarted: () => started,
      isClosed: () => closed,
      isAuthenticated: () => authReady,
      browserOwnerMode: () => browserOwnerMode,
      stealthMode: () => stealthMode,
    },
  };
  if (cdpControlAvailable) {
    companion.queryNekoStatus = queryNekoStatus;
  }
  return companion;
}

function createResolvedNekoCompanion({
  run_id,
  interaction_id,
  browser_session_id,
  resolveTargetForInteraction,
  defaults,
}) {
  let inner = null;
  const pendingFrames = new Map();
  const pendingEvents = new Map();

  function bindPending(next) {
    inner = next;
    for (const record of pendingFrames.values()) record.innerUnsubscribe = inner.onFrame(record.handler);
    for (const record of pendingEvents.values()) record.innerUnsubscribe = inner.onEvent(record.handler);
  }

  async function ensureInner() {
    if (inner) return inner;
    const target = await Promise.resolve(resolveTargetForInteraction(run_id, interaction_id));
    if (!target) {
      const err = new Error('No n.eko target registered for this run');
      err.code = 'streaming_target_unregistered';
      throw err;
    }
    bindPending(createNekoCompanion({ ...defaults, target, browser_session_id }));
    return inner;
  }

  function subscribe(pending, method, handler) {
    if (inner) return inner[method](handler);
    const record = { handler, innerUnsubscribe: null };
    pending.set(handler, record);
    return () => {
      pending.delete(handler);
      if (record.innerUnsubscribe) record.innerUnsubscribe();
    };
  }

  return {
    backend: 'neko',
    browser_session_id,
    async start(viewport) {
      const companion = await ensureInner();
      await companion.start(viewport);
    },
    async stop() {
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
    async ackFrame() {
      // No-op for n.eko polling, even through the resolver wrapper.
    },
    async queryNekoStatus() {
      const companion = await ensureInner();
      if (typeof companion.queryNekoStatus !== 'function') return null;
      return companion.queryNekoStatus();
    },
    getNekoProxyTarget() {
      if (!inner || typeof inner.getNekoProxyTarget !== 'function') return null;
      return inner.getNekoProxyTarget();
    },
  };
}

export function createDefaultStreamingCompanionFactory(options = {}) {
  const envTarget = readEnv(options.env);
  const resolveTargetForInteraction =
    typeof options.resolveTargetForInteraction === 'function'
      ? options.resolveTargetForInteraction
      : envTarget.origin
        ? () => envTarget
        : null;

  if (!resolveTargetForInteraction) return null;

  return ({ run_id, interaction_id, browser_session_id } = {}) => {
    if (typeof run_id !== 'string' || run_id.length === 0) return null;
    if (typeof interaction_id !== 'string' || interaction_id.length === 0) return null;
    return createResolvedNekoCompanion({
      run_id,
      interaction_id,
      browser_session_id,
      resolveTargetForInteraction,
      defaults: options,
    });
  };
}

export const createDefaultNekoStreamingCompanionFactory = createDefaultStreamingCompanionFactory;
