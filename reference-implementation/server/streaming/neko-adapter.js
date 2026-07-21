// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * n.eko companion adapter.
 *
 * This is intentionally a small HTTP-polling bridge, not a native WebRTC
 * client. It authenticates with n.eko, polls the JPEG screen endpoint, and
 * emits frames in the same shape as the CDP companion so streaming routes can
 * treat both backends the same.
 */

import { createNekoBrowserClient } from './neko-browser-client.ts';

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_SCREENCAST_PATH = 'api/room/screen/cast.jpg';
const DEFAULT_SCREENSHOT_PATH = 'api/room/screen/shot.jpg';
const DEFAULT_LOGIN_PATH = 'api/login';
const DEFAULT_SCREEN_CONFIGURATIONS_PATH = 'api/room/screen/configurations';
const DEFAULT_WINDOW_SETTLE_TIMEOUT_MS = 5_000;
const DEFAULT_WINDOW_SETTLE_POLL_INTERVAL_MS = 50;
const MAX_FRAME_FETCHES_PER_POLL_CYCLE = 2;
const FOCUS_BINDING_NAME = '__pdppNekoFocusChanged';
const BROWSER_OWNER_MODES = new Set(['neko-owned', 'browser-owner']);
const STEALTH_MODES = new Set(['strict', 'assistive']);
const MAX_COVER_CROP_RATIO = 0.02;
const VERTICAL_CROP_WEIGHT = 2;

function firstEnvValue(env, names) {
  const values = names.map((name) => env[name]);
  return values.find((value) => value) || values.at(-1);
}

function readEnv(env = process.env || {}) {
  return {
    origin: env.NEKO_ORIGIN,
    username: firstEnvValue(env, ['NEKO_CONTROL_USERNAME', 'NEKO_ADMIN_USERNAME', 'NEKO_USERNAME', 'NEKO_USER']),
    password: firstEnvValue(env, ['NEKO_CONTROL_PASSWORD', 'NEKO_ADMIN_PASSWORD', 'NEKO_PASSWORD_ADMIN', 'NEKO_PASSWORD']),
    bearerToken: firstEnvValue(env, ['NEKO_BEARER_TOKEN', 'NEKO_BEARER', 'NEKO_API_TOKEN']),
    browserOwnerMode: firstEnvValue(env, ['PDPP_NEKO_BROWSER_OWNER_MODE', 'NEKO_BROWSER_OWNER_MODE']),
    screenshotPath: env.NEKO_SCREENSHOT_PATH,
    cdpHttpUrl: firstEnvValue(env, ['PDPP_NEKO_CDP_HTTP_URL', 'NEKO_CDP_HTTP_URL', 'NEKO_CDP_ORIGIN']),
    windowSettleEndpoint: firstEnvValue(env, ['PDPP_NEKO_WINDOW_SETTLE_URL', 'NEKO_WINDOW_SETTLE_URL']),
    pollIntervalMs: env.NEKO_POLL_INTERVAL_MS ? Number(env.NEKO_POLL_INTERVAL_MS) : undefined,
    stealthMode: firstEnvValue(env, ['PDPP_NEKO_STEALTH_MODE', 'NEKO_STEALTH_MODE']),
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
  if (normalized === 'balanced') return 'assistive';
  if (STEALTH_MODES.has(normalized)) return normalized;
  return browserOwnerMode === 'browser-owner' ? 'strict' : 'assistive';
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

function assignPositiveNumber(payload, name, value, { floor = false } = {}) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) payload[name] = floor ? Math.floor(number) : number;
}

function assignViewportFlag(payload, name, value) {
  if (value === true) payload[name] = true;
}

function assignViewportUserAgent(payload, userAgent) {
  if (typeof userAgent === 'string' && userAgent.length > 0) payload.userAgent = userAgent.slice(0, 512);
}

function assignDeviceScaleFactor(payload, viewport) {
  if (Number.isFinite(Number(viewport?.deviceScaleFactor))) {
    payload.deviceScaleFactor = Number(viewport.deviceScaleFactor);
  }
}

function buildViewportPayload(viewport, frameRate) {
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  const screenWidth = Number(viewport?.screenWidth);
  const screenHeight = Number(viewport?.screenHeight);
  const payload = {};
  assignPositiveNumber(payload, 'width', width);
  assignPositiveNumber(payload, 'height', height);
  assignPositiveNumber(payload, 'screenWidth', screenWidth, { floor: true });
  assignPositiveNumber(payload, 'screenHeight', screenHeight, { floor: true });
  const selectedScreenWidth = payload.screenWidth || payload.width;
  const selectedScreenHeight = payload.screenHeight || payload.height;
  if (selectedScreenWidth && selectedScreenHeight) payload.screen = `${selectedScreenWidth}x${selectedScreenHeight}@${frameRate}`;
  assignDeviceScaleFactor(payload, viewport);
  assignViewportFlag(payload, 'mobile', viewport?.mobile);
  assignViewportFlag(payload, 'hasTouch', viewport?.hasTouch);
  assignViewportUserAgent(payload, viewport?.userAgent);
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

function compareScorePart(a, b) {
  return a === b ? 0 : a - b;
}

function screenConfigSortParts(score, fits) {
  const targetAreaDelta = Math.abs(score.sourceArea - score.targetArea);
  return fits ? [score.scaleDelta, score.cropRatio, targetAreaDelta] : [score.cropRatio, score.scaleDelta, targetAreaDelta];
}

function compareNekoScreenConfigurations(a, b, targetWidth, targetHeight) {
  const aScore = screenConfigScore(a, targetWidth, targetHeight);
  const bScore = screenConfigScore(b, targetWidth, targetHeight);
  const aFits = aScore.cropRatio <= MAX_COVER_CROP_RATIO;
  const bFits = bScore.cropRatio <= MAX_COVER_CROP_RATIO;
  if (aFits !== bFits) return aFits ? -1 : 1;
  const aParts = screenConfigSortParts(aScore, aFits);
  const bParts = screenConfigSortParts(bScore, bFits);
  return aParts.map((part, index) => compareScorePart(part, bParts[index])).find(Boolean) || 0;
}

function rankNekoScreenConfigurations(configs, targetWidth, targetHeight) {
  return [...configs].sort((a, b) => compareNekoScreenConfigurations(a, b, targetWidth, targetHeight));
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

function metricNearlyEqual(actual, expected, tolerance = 1) {
  return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tolerance;
}

function pageMetricMismatch(name, actual, expected) {
  return metricNearlyEqual(actual, expected) ? null : [name, { actual: actual ?? null, expected }];
}

function pageMetricsMismatch(page, viewport) {
  if (!page || typeof page !== 'object') return null;
  const dimensions = viewportDimensions(viewport);
  if (!dimensions) return null;
  const expected = {
    innerWidth: dimensions.width,
    innerHeight: dimensions.height,
  };
  const mismatches = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => pageMetricMismatch(key, page[key], value)).filter(Boolean),
  );
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

function addAuthenticationHeaders(headers, bearer, cookie) {
  if (bearer) headers.Authorization = bearer;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function safeLog(logger, level, msg, data) {
  if (!logger || typeof logger[level] !== 'function') return;
  try {
    logger[level]({ msg, ...(data || {}) });
  } catch {
    /* logger errors must not break the streaming path */
  }
}

function assertFetchImplementation(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new Error('createNekoCompanion: fetch implementation is required');
}

function configuredSleep(options, target) {
  return (
    choose(options.sleep, target.sleep) ||
    createDefaultSleep({
      setTimeoutFn: choose(options.setTimeoutFn, target.setTimeoutFn, setTimeout),
      clearTimeoutFn: choose(options.clearTimeoutFn, target.clearTimeoutFn, clearTimeout),
    })
  );
}

function isBalancedStealthMode(stealthMode) {
  return String(stealthMode || '').trim().toLowerCase() === 'balanced';
}

function browserControlIsAvailable(cdpHttpUrl, stealthMode, browserClientOption, browserClientFactory) {
  return Boolean(cdpHttpUrl && stealthMode !== 'strict' && (browserClientOption || typeof browserClientFactory === 'function'));
}

function assistiveBrowserControlIsAllowed(browserControlAvailable, stealthMode) {
  return browserControlAvailable && stealthMode === 'assistive';
}

export function createNekoCompanion(options = {}) {
  const env = readEnv(options.env);
  const target = normalizeTarget(options.target);
  const fetchImpl = choose(options.fetchImpl, target.fetchImpl, globalThis.fetch);
  assertFetchImplementation(fetchImpl);

  const origin = normalizeOrigin(choose(options.origin, target.origin, target.base_url, target.baseUrl, env.origin));
  const browser_session_id = choose(options.browser_session_id, target.browser_session_id, 'neko-session');
  const logger = choose(options.logger, target.logger);
  const now = choose(options.now, target.now, Date.now);
  const sleep = configuredSleep(options, target);

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
      target.cdpHttpUrl,
      target.cdp_http_url,
      target.cdp?.httpUrl,
      target.cdp?.http_url,
      options.cdpHttpUrl,
      env.cdpHttpUrl,
    ),
  );
  const windowSettleEndpoint = choose(
    options.windowSettleEndpoint,
    target.windowSettleEndpoint,
    target.window_settle_endpoint,
    env.windowSettleEndpoint,
  );
  const managedSurface = typeof target.surface_id === 'string' && target.surface_id.length > 0;
  if (managedSurface && !windowSettleEndpoint) {
    throw presentationScreenError(
      'managed n.eko surface is missing its window-settle endpoint',
      'neko_window_settle_endpoint_required',
    );
  }
  const windowSettleTimeoutMs = Number(
    choose(options.windowSettleTimeoutMs, target.windowSettleTimeoutMs, DEFAULT_WINDOW_SETTLE_TIMEOUT_MS),
  );
  const windowSettlePollIntervalMs = Number(
    choose(options.windowSettlePollIntervalMs, target.windowSettlePollIntervalMs, DEFAULT_WINDOW_SETTLE_POLL_INTERVAL_MS),
  );
  const browserOwnerMode = normalizeBrowserOwnerMode(
    choose(options.browserOwnerMode, target.browserOwnerMode, target.browser_owner_mode, env.browserOwnerMode),
  );
  const requestedStealthMode = choose(options.stealthMode, target.stealthMode, target.stealth_mode, env.stealthMode);
  const stealthMode = normalizeStealthMode(
    requestedStealthMode,
    browserOwnerMode,
  );
  if (isBalancedStealthMode(requestedStealthMode)) {
    safeLog(logger, 'warn', 'neko_stealth_balanced_normalized', {
      normalized_stealth_mode: stealthMode,
    });
  }
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
  const browserClientOption = choose(options.browserClient, target.browserClient);
  const browserClientFactory = choose(
    options.createBrowserClient,
    options.browserClientFactory,
    target.createBrowserClient,
    target.browserClientFactory,
    createNekoBrowserClient,
  );
  const browserControlAvailable = browserControlIsAvailable(cdpHttpUrl, stealthMode, browserClientOption, browserClientFactory);
  const assistiveBrowserControlAllowed = assistiveBrowserControlIsAllowed(browserControlAvailable, stealthMode);
  let bearer = normalizeBearer(choose(options.bearerToken, target.bearerToken, options.bearer, target.bearer, env.bearerToken));
  let cookie = choose(options.cookie, target.cookie, null);

  const frameHandlers = new Set();
  const eventHandlers = new Set();
  let browserClient = null;
  let browserClientPromise = null;
  let browserClientConnected = false;
  let pageFocusSetupPromise = null;
  let pageFocusSetupComplete = false;
  let lastBrowserViewport = null;
  let started = false;
  let closed = false;
  let authReady = false;
  let frameSeq = 0;
  let currentViewport = null;
  let abortController = null;
  let pollLoopPromise = null;
  let navigationApplied = false;
  let screencastPipelineDisabled = false;
  const presentationLifecycle = choose(options.presentationLifecycle, target.presentationLifecycle, null);
  let presentationBaseline = null;
  let presentationEpoch = 0;
  let presentationMutationTail = Promise.resolve();

  function headers(extra = {}) {
    return addAuthenticationHeaders({ ...(target.headers || {}), ...(options.headers || {}), ...extra }, bearer, cookie);
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

  function markAuthenticationReady() {
    authReady = true;
  }

  function authenticationAlreadyConfigured() {
    return bearer || cookie;
  }

  function loginBody() {
    return Object.fromEntries([
      username ? ['username', username] : null,
      password ? ['password', password] : null,
    ].filter(Boolean));
  }

  function recordLoginCredentials(response, json) {
    const nextCookie = cookieHeaderFrom(response);
    if (nextCookie) cookie = nextCookie;
    const token = choose(json?.token, json?.access_token, json?.session, json?.NEKO_SESSION);
    if (token) bearer = normalizeBearer(token);
  }

  async function requestLogin(signal) {
    const response = await fetchImpl(loginUrl, {
      method: 'POST',
      signal,
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(loginBody()),
    });
    await ensureOk(response, 'neko_login_failed');
    return response;
  }

  async function authenticate(signal) {
    if (authReady) return;
    if (authenticationAlreadyConfigured()) {
      markAuthenticationReady();
      return;
    }
    const response = await requestLogin(signal);
    recordLoginCredentials(response, await responseJsonOrNull(response));
    markAuthenticationReady();
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

  function createBrowserControlError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function assertBrowserControlIsAvailable() {
    if (!browserControlAvailable) {
      throw createBrowserControlError('n.eko assistive browser control is not configured', 'neko_browser_control_unavailable');
    }
  }

  function assertBrowserControlIsNotAborted(signal) {
    if (signal?.aborted) {
      throw createBrowserControlError('n.eko browser control aborted', 'neko_browser_control_aborted');
    }
  }

  async function createBrowserClientFromFactory() {
    return await browserClientFactory({ cdpHttpUrl, logger });
  }

  function assertValidBrowserClient(client) {
    if (!client || typeof client !== 'object') {
      throw createBrowserControlError('n.eko browser client is invalid', 'neko_browser_control_invalid');
    }
  }

  async function connectClientIfNeeded(client, signal) {
    if (!browserClientConnected && typeof client.connect === 'function') await client.connect({ signal });
  }

  async function connectBrowserClient(signal) {
    const client = browserClientOption || (await createBrowserClientFromFactory());
    assertValidBrowserClient(client);
    browserClient = client;
    await connectClientIfNeeded(client, signal);
    browserClientConnected = true;
    return client;
  }

  function connectedBrowserClient() {
    return browserClientConnected && browserClient ? browserClient : null;
  }

  async function awaitBrowserClientConnection() {
    try {
      return await browserClientPromise;
    } catch (err) {
      browserClient = null;
      browserClientConnected = false;
      throw err;
    } finally {
      browserClientPromise = null;
    }
  }

  async function getBrowserClient(signal) {
    assertBrowserControlIsAvailable();
    assertBrowserControlIsNotAborted(signal);
    const connected = connectedBrowserClient();
    if (connected) return connected;
    if (browserClientPromise) return browserClientPromise;
    browserClientPromise = connectBrowserClient(signal);
    return awaitBrowserClientConnection();
  }

  function focusEventFromPayload(payload) {
    return {
      kind: 'keyboard_focus',
      focused: payload?.type === 'focus',
      element: payload && typeof payload === 'object' ? payload : null,
    };
  }

  function handleFocusPayload(payloadJson) {
    if (typeof payloadJson !== 'string') return;
    try {
      emitEvent(focusEventFromPayload(JSON.parse(payloadJson)));
    } catch (err) {
      safeLog(logger, 'warn', 'neko_focus_event_parse_failed', { error: err?.message });
    }
  }

  function focusDetectionIsUnavailable() {
    return !assistiveBrowserControlAllowed || pageFocusSetupComplete;
  }

  async function installFocusDetection(signal) {
    const client = await getBrowserClient(signal);
    const source = buildFocusDetectionScript();
    await client.exposeBinding(FOCUS_BINDING_NAME, (_source, payloadJson) => {
      handleFocusPayload(payloadJson);
    });
    await client.addInitScript(source);
    await client.evaluate(source);
    pageFocusSetupComplete = true;
  }

  function logFocusDetectionFailure(err) {
    safeLog(logger, 'warn', 'neko_focus_detection_failed', {
      browser_owner_mode: browserOwnerMode,
      stealth_mode: stealthMode,
      error: err?.message,
    });
  }

  async function finishFocusDetectionSetup() {
    try {
      await pageFocusSetupPromise;
    } catch (err) {
      pageFocusSetupPromise = null;
      logFocusDetectionFailure(err);
    }
  }

  async function setupFocusDetectionBestEffort(signal) {
    if (focusDetectionIsUnavailable()) return;
    if (pageFocusSetupPromise) return pageFocusSetupPromise;
    pageFocusSetupPromise = installFocusDetection(signal);
    await finishFocusDetectionSetup();
  }

  function releaseBrowserClient() {
    if (!browserClient) return null;
    const client = browserClient;
    browserClient = null;
    browserClientConnected = false;
    browserClientPromise = null;
    pageFocusSetupPromise = null;
    pageFocusSetupComplete = false;
    return client;
  }

  async function closeClientBestEffort(client) {
    try {
      if (typeof client.close === 'function') await client.close();
    } catch {
      /* ignore */
    }
  }

  async function closeBrowserClient() {
    const client = releaseBrowserClient();
    if (!client) return;
    await closeClientBestEffort(client);
  }

  function screenConfigurationEndpoints() {
    const config = { ...target, ...options };
    return {
      screenEndpoint: choose(config.screenEndpoint),
      configurationsEndpoint: choose(
        config.screenConfigurationsEndpoint,
        config.screenConfigurationsPath,
        config.screen_configurations_endpoint,
      ),
    };
  }

  async function selectScreenConfiguration(dimensions, endpoints, signal) {
    const response = await fetchWithAuth(resolveUrl(origin, endpoints.configurationsEndpoint), { method: 'GET', signal });
    await ensureOk(response, 'neko_screen_configurations_failed');
    const configs = (await responseJsonOrNull(response))?.map((item) => normalizeScreenConfig(item)).filter(Boolean);
    if (!configs?.length) {
      throw createBrowserControlError('n.eko screen configuration list is empty', 'neko_screen_configurations_empty');
    }
    const [candidate] = rankNekoScreenConfigurations(configs, dimensions.width, dimensions.height);
    return candidate;
  }

  async function applyScreenConfiguration(candidate, screenEndpoint, signal) {
    const response = await postJson(resolveUrl(origin, screenEndpoint), candidate, signal);
    return normalizeScreenConfig(await responseJsonOrNull(response)) || candidate;
  }

  function windowIsSettledForScreen(status, candidate) {
    return status?.settled === true
      && asFinitePositiveInt(status.width) === candidate.width
      && asFinitePositiveInt(status.height) === candidate.height;
  }

  async function waitForWindowSettled(candidate, signal) {
    if (!windowSettleEndpoint) return;
    const deadline = now() + windowSettleTimeoutMs;
    const settleUrl = new URL(resolveUrl(origin, windowSettleEndpoint));
    settleUrl.searchParams.set('width', candidate.width);
    settleUrl.searchParams.set('height', candidate.height);
    while (true) {
      const response = await fetchWithAuth(settleUrl.toString(), { method: 'GET', signal });
      await ensureOk(response, 'neko_window_settle_status_failed');
      if (windowIsSettledForScreen(await responseJsonOrNull(response), candidate)) return;
      if (now() >= deadline) {
        throw presentationScreenError('n.eko browser window did not settle to the applied screen', 'neko_window_settle_timeout');
      }
      await sleep(windowSettlePollIntervalMs, signal);
    }
  }

  function presentationScreenError(message, code) {
    return createBrowserControlError(message, code);
  }

  function presentationOperationIsCurrent(epoch) {
    return !closed && epoch === presentationEpoch;
  }

  function enqueuePresentationScreenOperation(epoch, operation) {
    const scheduled = presentationMutationTail.then(async () => {
      if (!presentationOperationIsCurrent(epoch)) return { discarded: true };
      return await operation();
    });
    presentationMutationTail = scheduled.catch(() => undefined);
    return scheduled;
  }

  async function capturePresentationBaseline(request, signal) {
    if (presentationBaseline) return presentationBaseline;
    const response = await fetchWithAuth(resolveUrl(origin, request.endpoints.screenEndpoint), {
      method: 'GET',
      signal,
    });
    await ensureOk(response, 'neko_screen_baseline_capture_failed');
    const baseline = normalizeScreenConfig(await responseJsonOrNull(response));
    if (!baseline) {
      throw presentationScreenError('n.eko screen baseline is invalid', 'neko_screen_baseline_invalid');
    }
    if (typeof presentationLifecycle?.captureBaseline === 'function') {
      await presentationLifecycle.captureBaseline({ baseline });
    }
    presentationBaseline = baseline;
    return baseline;
  }

  function reportScreenConfiguration(lastApplied, dimensions, candidate) {
    emitEvent({
      kind: 'screen_configuration',
      applied: lastApplied,
      requested: dimensions,
      selected: candidate,
    });
    if (!screenConfigFitsCover(lastApplied, dimensions.width, dimensions.height)) {
      safeLog(logger, 'warn', 'neko_screen_configuration_imperfect_fit', {
        applied: lastApplied,
        requested: dimensions,
      });
    }
  }

  function capturedScreenConfiguration(lastApplied) {
    return {
      width: estimateCapturedWidth(lastApplied.width),
      height: lastApplied.height,
      rate: lastApplied.rate,
    };
  }

  function screenConfigurationRequest(viewport) {
    const dimensions = viewportScreenDimensions(viewport);
    if (!dimensions) return null;
    const endpoints = screenConfigurationEndpoints();
    if (!endpoints.screenEndpoint) return null;
    return { dimensions, endpoints, selectConfiguration: Boolean(endpoints.configurationsEndpoint) };
  }

  async function applySelectedScreenConfiguration(request, signal) {
    const { dimensions, endpoints } = request;
    if (!request.selectConfiguration) return null;
    const candidate = await selectScreenConfiguration(dimensions, endpoints, signal);
    if (!candidate) return null;
    const lastApplied = await applyScreenConfiguration(candidate, endpoints.screenEndpoint, signal);
    if (!lastApplied) return null;
    const capturedScreen = capturedScreenConfiguration(lastApplied);
    await waitForWindowSettled(capturedScreen, signal);
    reportScreenConfiguration(lastApplied, dimensions, candidate);
    return capturedScreen;
  }

  async function setBrowserViewport(dimensions, signal) {
    try {
      const client = await getBrowserClient(signal);
      await client.setViewportSize(dimensions);
    } catch (err) {
      safeLog(logger, 'warn', 'neko_browser_viewport_failed', { error: err?.message });
    }
  }

  async function applyBrowserViewportBestEffort(viewport, signal) {
    if (!assistiveBrowserControlAllowed) return;
    const dimensions = viewportDimensions(viewport);
    if (!dimensions) return;
    await setBrowserViewport(dimensions, signal);
  }

  function shouldSkipInitialNavigation() {
    return !navigationUrl || navigationApplied;
  }

  function logInitialNavigationSkipped() {
    safeLog(logger, 'warn', 'neko_initial_navigation_skipped', {
      browser_owner_mode: browserOwnerMode,
      stealth_mode: stealthMode,
    });
  }

  async function navigateInitially(signal) {
    try {
      const client = await getBrowserClient(signal);
      await client.goto(navigationUrl);
      navigationApplied = true;
      return true;
    } catch (err) {
      safeLog(logger, 'warn', 'neko_initial_navigation_failed', { error: err?.message });
      throw err;
    }
  }

  async function applyInitialNavigation(signal) {
    if (shouldSkipInitialNavigation()) return false;
    if (!assistiveBrowserControlAllowed) {
      logInitialNavigationSkipped();
      return false;
    }
    return navigateInitially(signal);
  }

  async function insertTextViaBrowserClient(text, signal) {
    if (!assistiveBrowserControlAllowed) {
      throw createBrowserControlError('n.eko browser paste control is not configured', 'neko_browser_control_unavailable');
    }
    const client = await getBrowserClient(signal);
    await client.keyboard.insertText(text);
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

  async function copySelectionViaBrowserClient(signal) {
    if (!assistiveBrowserControlAllowed) {
      throw createBrowserControlError('n.eko browser copy control is not configured', 'neko_browser_control_unavailable');
    }
    await sleep(50, signal);
    const client = await getBrowserClient(signal);
    const text = await client.evaluate(buildCopySelectionExpression());
    if (typeof text === 'string' && text.length > 0) {
      emitEvent({ kind: 'clipboard', text });
    }
  }

  async function readPageViewportStatus(signal) {
    const client = await getBrowserClient(signal);
    const value = await client.evaluate(buildViewportStatusExpression());
    if (typeof value !== 'string') return null;
    try {
      return JSON.parse(value);
    } catch {
      return { raw: value };
    }
  }

  function recordRemainingPageMetricsMismatch(status, expectedViewport) {
    const remainingMismatch = pageMetricsMismatch(status.page, expectedViewport);
    if (remainingMismatch) status.page_metrics_mismatch_after_reapply = remainingMismatch;
  }

  function recordPageMetricsReapplyError(status, err) {
    status.page_metrics_reapply_error = {
      code: err?.code || 'neko_page_metrics_reapply_failed',
      message: err?.message || 'n.eko page metrics reapply failed',
    };
  }

  async function reapplyPageMetricsBestEffort(status, expectedViewport) {
    try {
      await applyBrowserViewportBestEffort(expectedViewport, abortController?.signal);
      status.page_metrics_reapplied = true;
      status.page = await readPageViewportStatus(abortController?.signal);
      recordRemainingPageMetricsMismatch(status, expectedViewport);
    } catch (err) {
      recordPageMetricsReapplyError(status, err);
    }
  }

  function markPageCdpSkipped(status) {
    status.page_cdp_available = false;
    status.page_cdp_skipped = {
      browser_owner_mode: browserOwnerMode,
      stealth_mode: stealthMode,
    };
  }

  function recordPageCdpError(status, err) {
    status.page_cdp_available = false;
    status.page_cdp_error = {
      code: err?.code || 'neko_page_status_failed',
      message: err?.message || 'n.eko page status failed',
    };
  }

  async function collectAvailablePageViewportStatus(status) {
    status.page_cdp_available = true;
    status.page = await readPageViewportStatus(abortController?.signal);
    const expectedViewport = lastBrowserViewport || currentViewport;
    const mismatch = pageMetricsMismatch(status.page, expectedViewport);
    if (mismatch) {
      status.page_metrics_mismatch = mismatch;
      await reapplyPageMetricsBestEffort(status, expectedViewport);
    }
  }

  async function collectPageViewportStatus(status) {
    if (!assistiveBrowserControlAllowed) {
      markPageCdpSkipped(status);
      return;
    }
    try {
      await collectAvailablePageViewportStatus(status);
    } catch (err) {
      recordPageCdpError(status, err);
    }
  }

  async function readScreenStatus() {
    const config = { ...target, ...options };
    const screenEndpoint = choose(config.screenEndpoint, 'api/room/screen');
    const response = await fetchWithAuth(resolveUrl(origin, screenEndpoint), {
      method: 'GET',
      signal: abortController?.signal,
    });
    return isOk(response) ? { available: true, value: await responseJsonOrNull(response) } : { available: false };
  }

  function recordScreenStatusError(status, err) {
    status.screen_error = {
      code: err?.code || 'neko_screen_status_failed',
      message: err?.message || 'n.eko screen status failed',
    };
  }

  async function collectScreenStatus(status) {
    try {
      await authenticate(abortController?.signal);
      const screen = await readScreenStatus();
      if (screen.available) status.screen = screen.value;
    } catch (err) {
      recordScreenStatusError(status, err);
    }
  }

  async function queryNekoStatus() {
    const status = {};
    await collectScreenStatus(status);
    status.window_skipped = {
      browser_owner_mode: browserOwnerMode,
      stealth_mode: stealthMode,
    };

    await collectPageViewportStatus(status);

    return status;
  }

  function mergeAppliedScreenIntoViewport(viewport, appliedScreen) {
    if (!appliedScreen) return viewport;
    if (viewportHasSeparateScreenDimensions(viewport)) {
      return { ...viewport, screenHeight: appliedScreen.height, screenWidth: appliedScreen.width };
    }
    return { ...viewport, height: appliedScreen.height, width: appliedScreen.width };
  }

  function viewportPayloadFor(viewport) {
    if (typeof target.viewportPayload === 'function') return target.viewportPayload(viewport);
    return target.viewportPayload || options.viewportPayload || buildViewportPayload(viewport, frameRate);
  }

  function viewportEndpoints(appliedScreen, screenConfigurationWasRequested) {
    const config = { ...target, ...options };
    const endpoints = endpointList(config, [
      'viewportEndpoint',
      'screenConfigEndpoint',
      'windowEndpoint',
      'windowControlEndpoint',
    ]);
    if (!appliedScreen && !screenConfigurationWasRequested && typeof config.screenEndpoint === 'string' && config.screenEndpoint.length > 0) {
      endpoints.push(config.screenEndpoint);
    }
    return endpoints;
  }

  async function postViewportToEndpoints(endpoints, payload, signal) {
    for (const endpoint of endpoints) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await postJson(resolveUrl(origin, endpoint), payload, signal);
      } catch (err) {
        safeLog(logger, 'warn', 'neko_viewport_update_failed', { endpoint, error: err?.message });
      }
    }
  }

  async function applyViewportBestEffort(viewport, signal, epoch) {
    if (!viewport || typeof viewport !== 'object') return null;
    const payload = viewportPayloadFor(viewport);
    const request = screenConfigurationRequest(viewport);
    let appliedScreen = null;
    if (request) {
      await capturePresentationBaseline(request, signal);
      if (!presentationOperationIsCurrent(epoch)) return null;
      appliedScreen = await applySelectedScreenConfiguration(request, signal);
    }
    if (!presentationOperationIsCurrent(epoch)) return null;
    await postViewportToEndpoints(viewportEndpoints(appliedScreen, Boolean(request?.selectConfiguration)), payload, signal);
    if (!presentationOperationIsCurrent(epoch)) return null;
    const browserViewport = mergeAppliedScreenIntoViewport(viewport, appliedScreen);
    lastBrowserViewport = browserViewport;
    await applyBrowserViewportBestEffort(browserViewport, signal);
    return browserViewport;
  }

  async function applyPresentationViewport(viewport, signal, epoch, authenticateBeforeApply = false) {
    const result = await enqueuePresentationScreenOperation(epoch, async () => {
      if (authenticateBeforeApply) await authenticate(signal);
      const applied = await applyViewportBestEffort(viewport, signal, epoch);
      return { applied };
    });
    return result?.discarded ? null : result?.applied || null;
  }

  async function restorePresentationBaseline() {
    if (!presentationBaseline) return;
    const restoreEpoch = ++presentationEpoch;
    const result = await enqueuePresentationScreenOperation(restoreEpoch, async () => {
      const endpoints = screenConfigurationEndpoints();
      if (!endpoints.screenEndpoint) {
        throw presentationScreenError('n.eko screen restore endpoint is not configured', 'neko_screen_restore_unavailable');
      }
      await authenticate(abortController?.signal);
      const restored = await applyScreenConfiguration(presentationBaseline, endpoints.screenEndpoint, abortController?.signal);
      if (!restored) {
        throw presentationScreenError('n.eko screen restore returned no configuration', 'neko_screen_restore_failed');
      }
      await waitForWindowSettled(restored, abortController?.signal);
      if (typeof presentationLifecycle?.markRestored === 'function') {
        await presentationLifecycle.markRestored({ baseline: presentationBaseline, restored });
      }
      presentationBaseline = null;
      return { restored };
    });
    if (result?.discarded) {
      throw presentationScreenError('n.eko screen restore was superseded', 'neko_screen_restore_superseded');
    }
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

  async function fetchScreenshotFallback(signal) {
    const fallback = await fetchWithAuth(screenshotFallbackUrl, { method: 'GET', signal });
    await ensureOk(fallback, 'neko_screenshot_failed');
    return responseToBase64(fallback);
  }

  async function fetchPrimaryScreencast(signal) {
    return fetchWithAuth(screencastUrl, { method: 'GET', signal });
  }

  function shouldUseScreenshotFallback(primary) {
    return statusOf(primary) === 400 && screenshotFallbackUrl !== screencastUrl;
  }

  async function resolvePrimaryScreencast(primary, signal) {
    if (isOk(primary)) return responseToBase64(primary);
    if (shouldUseScreenshotFallback(primary)) {
      screencastPipelineDisabled = true;
      return fetchScreenshotFallback(signal);
    }
    await ensureOk(primary, 'neko_screenshot_failed');
    return null;
  }

  async function fetchFrame(signal) {
    if (screencastPipelineDisabled) return fetchScreenshotFallback(signal);
    const primary = await fetchPrimaryScreencast(signal);
    return resolvePrimaryScreencast(primary, signal);
  }

  function shouldPoll(signal) {
    return !signal.aborted && started && !closed;
  }

  async function emitPolledFrame(data, signal, frameEpoch) {
    await presentationMutationTail;
    if (!data || !shouldPoll(signal)) return 'skipped';
    if (frameEpoch !== presentationEpoch) return 'stale';
    emitFrame(data);
    return 'emitted';
  }

  function logPollingFailure(signal, err) {
    if (!signal.aborted) safeLog(logger, 'warn', 'neko_frame_poll_failed', { error: err?.message });
  }

  async function pollFrame(signal) {
    try {
      for (let fetchCount = 0; fetchCount < MAX_FRAME_FETCHES_PER_POLL_CYCLE && shouldPoll(signal); fetchCount += 1) {
        const frameEpoch = presentationEpoch;
        const outcome = await emitPolledFrame(await fetchFrame(signal), signal, frameEpoch);
        if (outcome !== 'stale') return;
      }
    } catch (err) {
      logPollingFailure(signal, err);
    }
  }

  async function pollLoop(signal) {
    while (shouldPoll(signal)) {
      await pollFrame(signal);
      if (shouldPoll(signal)) await sleep(pollIntervalMs, signal);
    }
  }

  function closedCompanionError() {
    const err = new Error('Streaming companion is closed');
    err.code = 'companion_closed';
    return err;
  }

  async function initializeCompanion(viewport) {
    abortController = new AbortController();
    currentViewport = viewport || null;
    await authenticate(abortController.signal);
    const epoch = ++presentationEpoch;
    currentViewport = (await applyPresentationViewport(currentViewport, abortController.signal, epoch)) || currentViewport;
    await setupFocusDetectionBestEffort(abortController.signal);
    await applyInitialNavigation(abortController.signal);
    started = true;
    pollLoopPromise = pollLoop(abortController.signal).catch((err) => {
      safeLog(logger, 'warn', 'neko_poll_loop_failed', { error: err?.message });
    });
  }

  async function start(viewport) {
    if (closed) throw closedCompanionError();
    if (started) return;
    await initializeCompanion(viewport);
  }

  async function stop() {
    if (closed) return;
    started = false;
    await restorePresentationBaseline();
    closed = true;
    abortController?.abort();
    await pollLoopPromise;
    await closeBrowserClient();
    frameHandlers.clear();
    eventHandlers.clear();
  }

  async function dispatchViewport(event) {
    const epoch = ++presentationEpoch;
    currentViewport = event;
    currentViewport = (await applyPresentationViewport(event, abortController?.signal, epoch, true)) || currentViewport;
    return true;
  }

  async function dispatchPaste(event) {
    if (typeof event.text !== 'string' || !assistiveBrowserControlAllowed) return false;
    await authenticate(abortController?.signal);
    await insertTextViaBrowserClient(event.text, abortController?.signal);
    return true;
  }

  async function dispatchCopy() {
    if (!assistiveBrowserControlAllowed) return false;
    await authenticate(abortController?.signal);
    await copySelectionViaBrowserClient(abortController?.signal);
    return true;
  }

  async function dispatchInput(event) {
    const inputEndpoint = choose(options.inputEndpoint, target.inputEndpoint, target.dispatchEndpoint, options.dispatchEndpoint);
    if (!inputEndpoint) return;
    await authenticate(abortController?.signal);
    await postJson(resolveUrl(origin, inputEndpoint), event, abortController?.signal);
  }

  const eventDispatchers = {
    viewport: dispatchViewport,
    paste: dispatchPaste,
    copy: dispatchCopy,
  };

  async function dispatch(event) {
    const dispatchEvent = eventDispatchers[event?.type];
    if (dispatchEvent && (await dispatchEvent(event))) return;
    await dispatchInput(event);
  }

  function nekoProxyTarget() {
    const targetProperties = ['surface_id', 'lease_id', 'profile_key', 'interaction_id'];
    const populatedProperties = targetProperties.flatMap((name) => (target[name] ? [[name, target[name]]] : []));
    return { origin, ...Object.fromEntries(populatedProperties) };
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
    getNekoProxyTarget: nekoProxyTarget,
    /** test-only escape hatch */
    _internal: {
      isStarted: () => started,
      isClosed: () => closed,
      isAuthenticated: () => authReady,
      browserOwnerMode: () => browserOwnerMode,
      stealthMode: () => stealthMode,
    },
  };
  companion.queryNekoStatus = queryNekoStatus;
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

function factoryDefaults(options) {
  const nekoDefaults = options.neko && typeof options.neko === 'object' && !Array.isArray(options.neko) ? options.neko : {};
  return { ...options, ...nekoDefaults };
}

function factoryTargetResolver(options, envTarget) {
  if (typeof options.resolveTargetForInteraction === 'function') return options.resolveTargetForInteraction;
  return envTarget.origin ? () => envTarget : null;
}

function hasFactoryIdentifiers(run_id, interaction_id) {
  return typeof run_id === 'string' && run_id.length > 0 && typeof interaction_id === 'string' && interaction_id.length > 0;
}

function resolvedCompanionFactory(resolveTargetForInteraction, defaults) {
  return ({ run_id, interaction_id, browser_session_id } = {}) => {
    if (!hasFactoryIdentifiers(run_id, interaction_id)) return null;
    return createResolvedNekoCompanion({
      run_id,
      interaction_id,
      browser_session_id,
      resolveTargetForInteraction,
      defaults,
    });
  };
}

export function createDefaultStreamingCompanionFactory(options = {}) {
  const envTarget = readEnv(options.env);
  const defaults = factoryDefaults(options);
  const resolveTargetForInteraction = factoryTargetResolver(options, envTarget);
  if (!resolveTargetForInteraction) return null;
  return resolvedCompanionFactory(resolveTargetForInteraction, defaults);
}

export const createDefaultNekoStreamingCompanionFactory = createDefaultStreamingCompanionFactory;
