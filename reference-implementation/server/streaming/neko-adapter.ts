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

import { createNekoBrowserClient, type NekoBrowserClient } from "./neko-browser-client.ts";

type CodedError = Error & { code?: string; status?: number };
type UnknownRecord = Record<string, unknown>;
type AbortSignalLike = AbortSignal | undefined;
export type Sleep = (ms: number, signal?: AbortSignalLike) => Promise<void>;
type HeaderMap = Record<string, string>;
type ViewportPayload = Record<string, string | number | boolean>;
type NekoHeaders = Headers | (HeaderMap & { getSetCookie?: () => string[] });

interface NekoResponse {
  arrayBuffer?: () => Promise<ArrayBuffer>;
  buffer?: () => Promise<Uint8Array>;
  headers?: NekoHeaders;
  json?: () => Promise<unknown>;
  ok?: boolean;
  status?: number;
  text?: () => Promise<string>;
}

export interface NekoRequest {
  body?: string;
  headers?: HeaderMap;
  method?: string;
  signal?: AbortSignal | undefined;
}

export type NekoFetch = (url: string, request?: NekoRequest) => Promise<NekoResponse>;

export interface NekoScreenConfiguration {
  height: number;
  rate: number;
  width: number;
}

interface NekoScreenDimensions {
  height: number;
  width: number;
}

export interface NekoViewport extends UnknownRecord {
  deviceScaleFactor?: number;
  hasTouch?: boolean;
  height?: number;
  mobile?: boolean;
  screenHeight?: number;
  screenWidth?: number;
  userAgent?: string;
  width?: number;
}

export interface NekoFrame {
  data: string;
  metadata: {
    device_height: number | null;
    device_width: number | null;
    offset_top: number;
    page_scale_factor: number;
    scroll_offset_x: number;
    scroll_offset_y: number;
    timestamp: number;
  };
  sessionId: number;
}

export type NekoEvent =
  | { element: UnknownRecord | null; focused: boolean; kind: "keyboard_focus" }
  | { kind: "clipboard"; text: string }
  | {
      applied: NekoScreenConfiguration;
      kind: "screen_configuration";
      requested: NekoScreenDimensions;
      selected: NekoScreenConfiguration;
    };

export interface NekoPresentationLifecycle {
  captureBaseline?: (input: { baseline: NekoScreenConfiguration }) => Promise<void> | void;
  markRestored?: (input: {
    baseline: NekoScreenConfiguration;
    restored: NekoScreenConfiguration;
  }) => Promise<void> | void;
}

type NekoBrowserClientFactory = (input: {
  cdpHttpUrl: string | null;
  logger: NekoLogger | undefined;
}) => Promise<NekoBrowserClient> | NekoBrowserClient;

interface NekoLogger {
  [level: string]: ((entry: UnknownRecord) => void) | undefined;
}

export interface NekoCompanionOptions extends UnknownRecord {
  bearer?: string;
  bearerToken?: string;
  browser_session_id?: string;
  browserClient?: NekoBrowserClient;
  browserClientFactory?: NekoBrowserClientFactory;
  browserOwnerMode?: string;
  cdpHttpUrl?: string;
  clearTimeoutFn?: typeof clearTimeout;
  cookie?: string;
  createBrowserClient?: NekoBrowserClientFactory;
  dispatchEndpoint?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: NekoFetch;
  frameRate?: number;
  headers?: HeaderMap;
  inputEndpoint?: string;
  logger?: NekoLogger;
  loginPath?: string;
  navigation_url?: string;
  navigationUrl?: string;
  neko?: NekoCompanionOptions;
  now?: () => number;
  origin?: string;
  password?: string;
  pollIntervalMs?: number;
  presentationLifecycle?: NekoPresentationLifecycle;
  resolveTargetForInteraction?: ResolvedNekoCompanionOptions["resolveTargetForInteraction"];
  screenConfigurationsEndpoint?: string;
  screenConfigurationsPath?: string;
  screencastPath?: string;
  screenEndpoint?: string;
  screenshotFallbackPath?: string;
  screenshotPath?: string;
  setTimeoutFn?: typeof setTimeout;
  sleep?: Sleep;
  start_url?: string;
  startUrl?: string;
  stealthMode?: string;
  target?: NekoTargetInput;
  username?: string;
  viewportPayload?: ViewportPayload | ((viewport: NekoViewport) => ViewportPayload);
  windowSettleEndpoint?: string;
  windowSettlePollIntervalMs?: number;
  windowSettleTimeoutMs?: number;
}

export interface NekoTargetInput extends NekoCompanionOptions {
  base_url?: string;
  browser_owner_mode?: string;
  cdp?: { httpUrl?: string; http_url?: string };
  cdp_http_url?: string;
  interaction_id?: string;
  lease_id?: string;
  profile_key?: string;
  surface_id?: string;
}

export interface NekoCompanion {
  _internal: {
    browserOwnerMode: () => string;
    isAuthenticated: () => boolean;
    isClosed: () => boolean;
    isStarted: () => boolean;
    stealthMode: () => string;
  };
  ackFrame: () => Promise<void>;
  backend: "neko";
  browser_session_id: string;
  dispatch: (event: UnknownRecord) => Promise<void>;
  getNekoProxyTarget: () => ({ origin: string } & UnknownRecord) | null;
  onEvent: (handler: (event: NekoEvent) => void) => () => void;
  onFrame: (handler: (frame: NekoFrame) => void) => () => void;
  queryNekoStatus: () => Promise<UnknownRecord | null>;
  start: (viewport?: NekoViewport) => Promise<void>;
  stop: () => Promise<void>;
}

interface ScreenEndpoints {
  configurationsEndpoint?: string | undefined;
  screenEndpoint?: string | undefined;
}

interface ScreenConfigurationRequest {
  dimensions: NekoScreenDimensions;
  endpoints: ScreenEndpoints;
  selectConfiguration: boolean;
}

interface PresentationOperationResult {
  applied?: NekoViewport | null;
  discarded?: boolean;
  restored?: NekoScreenConfiguration;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_SCREENCAST_PATH = "api/room/screen/cast.jpg";
const DEFAULT_SCREENSHOT_PATH = "api/room/screen/shot.jpg";
const DEFAULT_LOGIN_PATH = "api/login";
const DEFAULT_WINDOW_SETTLE_TIMEOUT_MS = 5000;
const DEFAULT_WINDOW_SETTLE_POLL_INTERVAL_MS = 50;
const MAX_FRAME_FETCHES_PER_POLL_CYCLE = 2;
const FOCUS_BINDING_NAME = "__pdppNekoFocusChanged";
const BROWSER_OWNER_MODES = new Set(["neko-owned", "browser-owner"]);
const STEALTH_MODES = new Set(["strict", "assistive"]);
const MAX_COVER_CROP_RATIO = 0.02;
const VERTICAL_CROP_WEIGHT = 2;

function firstEnvValue(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  const values = names.map((name) => env[name]);
  return values.find((value) => value) || values.at(-1);
}

function readEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    bearerToken: firstEnvValue(env, ["NEKO_BEARER_TOKEN", "NEKO_BEARER", "NEKO_API_TOKEN"]),
    browserOwnerMode: firstEnvValue(env, ["PDPP_NEKO_BROWSER_OWNER_MODE", "NEKO_BROWSER_OWNER_MODE"]),
    cdpHttpUrl: firstEnvValue(env, ["PDPP_NEKO_CDP_HTTP_URL", "NEKO_CDP_HTTP_URL", "NEKO_CDP_ORIGIN"]),
    origin: env.NEKO_ORIGIN,
    password: firstEnvValue(env, [
      "NEKO_CONTROL_PASSWORD",
      "NEKO_ADMIN_PASSWORD",
      "NEKO_PASSWORD_ADMIN",
      "NEKO_PASSWORD",
    ]),
    pollIntervalMs: env.NEKO_POLL_INTERVAL_MS ? Number(env.NEKO_POLL_INTERVAL_MS) : undefined,
    screenshotPath: env.NEKO_SCREENSHOT_PATH,
    stealthMode: firstEnvValue(env, ["PDPP_NEKO_STEALTH_MODE", "NEKO_STEALTH_MODE"]),
    username: firstEnvValue(env, ["NEKO_CONTROL_USERNAME", "NEKO_ADMIN_USERNAME", "NEKO_USERNAME", "NEKO_USER"]),
    windowSettleEndpoint: firstEnvValue(env, ["PDPP_NEKO_WINDOW_SETTLE_URL", "NEKO_WINDOW_SETTLE_URL"]),
  };
}

function normalizeTarget(target: NekoTargetInput | string | undefined): NekoTargetInput {
  if (typeof target === "string") {
    return { origin: target };
  }
  if (target && typeof target === "object") {
    return target;
  }
  return {};
}

function choose<T>(...values: readonly T[]): T | undefined {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeBrowserOwnerMode(value: unknown): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return BROWSER_OWNER_MODES.has(normalized) ? normalized : "neko-owned";
}

function normalizeStealthMode(value: unknown, browserOwnerMode: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "balanced") {
    return "assistive";
  }
  if (STEALTH_MODES.has(normalized)) {
    return normalized;
  }
  return browserOwnerMode === "browser-owner" ? "strict" : "assistive";
}

function normalizeOrigin(origin: unknown): string {
  if (typeof origin !== "string" || origin.length === 0) {
    const err: CodedError = new Error("createNekoCompanion: origin is required");
    err.code = "neko_origin_required";
    throw err;
  }
  return origin.endsWith("/") ? origin : `${origin}/`;
}

function resolveUrl(origin: string, pathOrUrl: unknown): string {
  if (typeof pathOrUrl !== "string" || pathOrUrl.length === 0) {
    throw new Error("n.eko endpoint path is required");
  }
  return new URL(pathOrUrl, origin).toString();
}

function normalizeCdpHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.toString().endsWith("/") ? parsed.toString() : `${parsed.toString()}/`;
  } catch {
    return null;
  }
}

function normalizeNavigationUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    // Validate but preserve data: URLs byte-for-byte for playground fixtures.
    // biome-ignore lint/correctness/noUnusedInstantiation: Construction intentionally triggers the compatibility side effect.
    new URL(trimmed);
    return trimmed;
  } catch {
    const err: CodedError = new Error("n.eko navigation URL is invalid");
    err.code = "neko_navigation_url_invalid";
    // biome-ignore lint/style/useErrorCause: This compatibility path preserves the established error shape and propagation.
    throw err;
  }
}

function createDefaultSleep({
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: {
  clearTimeoutFn?: typeof clearTimeout;
  setTimeoutFn?: typeof setTimeout;
} = {}): Sleep {
  return (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeoutFn(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeoutFn(timer);
          resolve();
        },
        { once: true }
      );
    });
}

function isOk(response: NekoResponse | null | undefined): boolean {
  if (!response) {
    return false;
  }
  if (typeof response.ok === "boolean") {
    return response.ok;
  }
  return Number(response.status) >= 200 && Number(response.status) < 300;
}

function statusOf(response: NekoResponse | null | undefined): number {
  const status = response?.status;
  return Number.isFinite(Number(status)) ? Number(status) : 0;
}

function getHeader(response: NekoResponse | null | undefined, name: string): string | null {
  const headers = response?.headers;
  if (!headers) {
    return null;
  }
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  return headers instanceof Headers ? null : headers[name] || headers[name.toLowerCase()] || null;
}

function getSetCookieHeaders(response: NekoResponse | null | undefined): string[] {
  const headers = response?.headers;
  if (!headers) {
    return [];
  }
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const setCookie = getHeader(response, "set-cookie");
  return setCookie ? [setCookie] : [];
}

function cookieHeaderFrom(response: NekoResponse | null | undefined): string {
  return getSetCookieHeaders(response)
    .map((cookie) => String(cookie).split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function responseJsonOrNull(response: NekoResponse | null | undefined): Promise<unknown> {
  if (typeof response?.json !== "function") {
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function asFinitePositiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

async function responseToBase64(response: NekoResponse): Promise<string> {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (typeof response?.arrayBuffer === "function") {
    return Buffer.from(await response.arrayBuffer()).toString("base64");
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (typeof response?.buffer === "function") {
    return Buffer.from(await response.buffer()).toString("base64");
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (typeof response?.text === "function") {
    return Buffer.from(await response.text(), "binary").toString("base64");
  }
  throw new Error("n.eko screenshot response has no readable body");
}

function assignPositiveNumber(
  payload: ViewportPayload,
  name: string,
  value: unknown,
  { floor = false }: { floor?: boolean } = {}
): void {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    payload[name] = floor ? Math.floor(number) : number;
  }
}

function assignViewportFlag(payload: ViewportPayload, name: string, value: unknown): void {
  if (value === true) {
    payload[name] = true;
  }
}

function assignViewportUserAgent(payload: ViewportPayload, userAgent: unknown): void {
  if (typeof userAgent === "string" && userAgent.length > 0) {
    payload.userAgent = userAgent.slice(0, 512);
  }
}

function assignDeviceScaleFactor(payload: ViewportPayload, viewport: NekoViewport | null | undefined): void {
  const deviceScaleFactor = viewport?.deviceScaleFactor;
  if (Number.isFinite(Number(deviceScaleFactor))) {
    payload.deviceScaleFactor = Number(deviceScaleFactor);
  }
}

function buildViewportPayload(viewport: NekoViewport | null | undefined, frameRate: number): ViewportPayload {
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  const screenWidth = Number(viewport?.screenWidth);
  const screenHeight = Number(viewport?.screenHeight);
  const payload: ViewportPayload = {};
  assignPositiveNumber(payload, "width", width);
  assignPositiveNumber(payload, "height", height);
  assignPositiveNumber(payload, "screenWidth", screenWidth, { floor: true });
  assignPositiveNumber(payload, "screenHeight", screenHeight, { floor: true });
  const selectedScreenWidth = payload.screenWidth || payload.width;
  const selectedScreenHeight = payload.screenHeight || payload.height;
  if (selectedScreenWidth && selectedScreenHeight) {
    payload.screen = `${selectedScreenWidth}x${selectedScreenHeight}@${frameRate}`;
  }
  assignDeviceScaleFactor(payload, viewport);
  assignViewportFlag(payload, "mobile", viewport?.mobile);
  assignViewportFlag(payload, "hasTouch", viewport?.hasTouch);
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

function recordOrNull(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value));
}

function normalizeScreenConfig(value: unknown): NekoScreenConfiguration | null {
  const record = recordOrNull(value);
  if (!record) {
    return null;
  }
  const width = asFinitePositiveInt(record.width);
  const height = asFinitePositiveInt(record.height);
  if (!(width && height)) {
    return null;
  }
  const rate = asFinitePositiveInt(record.rate) || 30;
  return { height, rate, width };
}

function estimateCapturedWidth(width: number): number {
  return width - (width % 8);
}

function coverDisplayMetrics(
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number
): { cropRatio: number; scale: number } {
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

function screenConfigScore(
  config: NekoScreenConfiguration,
  targetWidth: number,
  targetHeight: number
): { cropRatio: number; scaleDelta: number; sourceArea: number; targetArea: number } {
  const projectedWidth = estimateCapturedWidth(config.width);
  const display = coverDisplayMetrics(projectedWidth, config.height, targetWidth, targetHeight);
  return {
    cropRatio: display.cropRatio,
    scaleDelta: Math.abs(Math.log(display.scale)),
    sourceArea: projectedWidth * config.height,
    targetArea: targetWidth * targetHeight,
  };
}

function screenConfigFitsCover(config: NekoScreenConfiguration, targetWidth: number, targetHeight: number): boolean {
  return screenConfigScore(config, targetWidth, targetHeight).cropRatio <= MAX_COVER_CROP_RATIO;
}

function compareScorePart(a: number, b: number): number {
  return a === b ? 0 : a - b;
}

function screenConfigSortParts(score: ReturnType<typeof screenConfigScore>, fits: boolean): number[] {
  const targetAreaDelta = Math.abs(score.sourceArea - score.targetArea);
  return fits
    ? [score.scaleDelta, score.cropRatio, targetAreaDelta]
    : [score.cropRatio, score.scaleDelta, targetAreaDelta];
}

function compareNekoScreenConfigurations(
  a: NekoScreenConfiguration,
  b: NekoScreenConfiguration,
  targetWidth: number,
  targetHeight: number
): number {
  const aScore = screenConfigScore(a, targetWidth, targetHeight);
  const bScore = screenConfigScore(b, targetWidth, targetHeight);
  const aFits = aScore.cropRatio <= MAX_COVER_CROP_RATIO;
  const bFits = bScore.cropRatio <= MAX_COVER_CROP_RATIO;
  if (aFits !== bFits) {
    return aFits ? -1 : 1;
  }
  const aParts = screenConfigSortParts(aScore, aFits);
  const bParts = screenConfigSortParts(bScore, bFits);
  return aParts.map((part, index) => compareScorePart(part, bParts[index] ?? 0)).find(Boolean) || 0;
}

function rankNekoScreenConfigurations(
  configs: readonly NekoScreenConfiguration[],
  targetWidth: number,
  targetHeight: number
): NekoScreenConfiguration[] {
  return [...configs].sort((a, b) => compareNekoScreenConfigurations(a, b, targetWidth, targetHeight));
}

function viewportDimensions(viewport: NekoViewport | null | undefined): { height: number; width: number } | null {
  const width = asFinitePositiveInt(viewport?.width);
  const height = asFinitePositiveInt(viewport?.height);
  return width && height ? { height, width } : null;
}

function viewportScreenDimensions(viewport: NekoViewport | null | undefined): { height: number; width: number } | null {
  const dimensions = viewportDimensions(viewport);
  if (!dimensions) {
    return null;
  }
  const screenWidth = asFinitePositiveInt(viewport?.screenWidth);
  const screenHeight = asFinitePositiveInt(viewport?.screenHeight);
  return screenWidth && screenHeight
    ? {
        height: Math.max(dimensions.height, screenHeight),
        width: Math.max(dimensions.width, screenWidth),
      }
    : dimensions;
}

function viewportHasSeparateScreenDimensions(viewport: NekoViewport | null | undefined): boolean {
  const dimensions = viewportDimensions(viewport);
  const screen = viewportScreenDimensions(viewport);
  return !!(dimensions && screen && (dimensions.width !== screen.width || dimensions.height !== screen.height));
}

function metricNearlyEqual(actual: unknown, expected: number, tolerance = 1): boolean {
  return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tolerance;
}

function pageMetricMismatch(
  name: string,
  actual: unknown,
  expected: number
): [string, { actual: unknown; expected: number }] | null {
  return metricNearlyEqual(actual, expected) ? null : [name, { actual: actual ?? null, expected }];
}

function pageMetricsMismatch(page: unknown, viewport: NekoViewport | null | undefined): UnknownRecord | null {
  const metrics = recordOrNull(page);
  if (!metrics) {
    return null;
  }
  const dimensions = viewportDimensions(viewport);
  if (!dimensions) {
    return null;
  }
  const expected = {
    innerHeight: dimensions.height,
    innerWidth: dimensions.width,
  };
  const mismatches = Object.fromEntries(
    Object.entries(expected).flatMap(([key, value]) => {
      const mismatch = pageMetricMismatch(key, metrics[key], value);
      return mismatch ? [mismatch] : [];
    })
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

function buildMetadata(viewport: NekoViewport | null | undefined, now: () => number): NekoFrame["metadata"] {
  return {
    device_height: Number.isFinite(Number(viewport?.height)) ? Number(viewport?.height) : null,
    device_width: Number.isFinite(Number(viewport?.width)) ? Number(viewport?.width) : null,
    offset_top: 0,
    page_scale_factor: Number.isFinite(Number(viewport?.deviceScaleFactor)) ? Number(viewport?.deviceScaleFactor) : 1,
    scroll_offset_x: 0,
    scroll_offset_y: 0,
    timestamp: now(),
  };
}

function normalizeBearer(token: unknown): string | null {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}

function endpointList(config: UnknownRecord, names: readonly string[]): string[] {
  return names.flatMap((name) => {
    const endpoint = config[name];
    return typeof endpoint === "string" && endpoint.length > 0 ? [endpoint] : [];
  });
}

function addAuthenticationHeaders(
  headers: HeaderMap,
  bearer: string | null | undefined,
  cookie: string | null | undefined
): HeaderMap {
  if (bearer) {
    headers.Authorization = bearer;
  }
  if (cookie) {
    headers.Cookie = cookie;
  }
  return headers;
}

function safeLog(logger: NekoLogger | undefined, level: string, msg: string, data?: UnknownRecord): void {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }
  try {
    logger[level]({ msg, ...(data || {}) });
  } catch {
    /* logger errors must not break the streaming path */
  }
}

function assertFetchImplementation(fetchImpl: unknown): asserts fetchImpl is NekoFetch {
  if (typeof fetchImpl !== "function") {
    throw new Error("createNekoCompanion: fetch implementation is required");
  }
}

function configuredSleep(options: NekoCompanionOptions, target: NekoTargetInput): Sleep {
  return (
    choose(options.sleep, target.sleep) ||
    createDefaultSleep({
      clearTimeoutFn: choose(options.clearTimeoutFn, target.clearTimeoutFn, clearTimeout) || clearTimeout,
      setTimeoutFn: choose(options.setTimeoutFn, target.setTimeoutFn, setTimeout) || setTimeout,
    })
  );
}

function isBalancedStealthMode(stealthMode: unknown): boolean {
  return (
    String(stealthMode || "")
      .trim()
      .toLowerCase() === "balanced"
  );
}

function browserControlIsAvailable(
  cdpHttpUrl: string | null,
  stealthMode: string,
  browserClientOption: NekoBrowserClient | undefined,
  browserClientFactory: NekoBrowserClientFactory
): boolean {
  return Boolean(
    cdpHttpUrl && stealthMode !== "strict" && (browserClientOption || typeof browserClientFactory === "function")
  );
}

function assistiveBrowserControlIsAllowed(browserControlAvailable: boolean, stealthMode: string): boolean {
  return browserControlAvailable && stealthMode === "assistive";
}

async function defaultNekoFetch(url: string, request: NekoRequest = {}): Promise<NekoResponse> {
  const init: RequestInit = {};
  if (request.method) {
    init.method = request.method;
  }
  if (request.headers) {
    init.headers = request.headers;
  }
  if (request.body) {
    init.body = request.body;
  }
  if (request.signal) {
    init.signal = request.signal;
  }
  return await globalThis.fetch(url, init);
}

function notifyHandlers<T>(
  handlers: Iterable<(value: T) => void>,
  value: T,
  reportFailure: (error: unknown) => void
): void {
  for (const handler of handlers) {
    try {
      handler(value);
    } catch (error) {
      reportFailure(error);
    }
  }
}

export function createNekoCompanion(options: NekoCompanionOptions = {}): NekoCompanion {
  const env = readEnv(options.env);
  const target = normalizeTarget(options.target);
  const configuredFetch = choose(options.fetchImpl, target.fetchImpl) || defaultNekoFetch;
  assertFetchImplementation(configuredFetch);
  const fetchImpl: NekoFetch = configuredFetch;

  const origin = normalizeOrigin(choose(options.origin, target.origin, target.base_url, target.baseUrl, env.origin));
  const browser_session_id =
    choose(options.browser_session_id, target.browser_session_id, "neko-session") || "neko-session";
  const logger = choose(options.logger, target.logger);
  const now = choose(options.now, target.now, Date.now) || Date.now;
  const sleep = configuredSleep(options, target);

  const loginUrl = resolveUrl(origin, choose(options.loginPath, target.loginPath, DEFAULT_LOGIN_PATH));
  const screencastUrl = resolveUrl(
    origin,
    choose(
      options.screencastPath,
      target.screencastPath,
      options.screenshotPath,
      target.screenshotPath,
      env.screenshotPath,
      DEFAULT_SCREENCAST_PATH
    )
  );
  const screenshotFallbackUrl = resolveUrl(
    origin,
    choose(options.screenshotFallbackPath, target.screenshotFallbackPath, DEFAULT_SCREENSHOT_PATH)
  );
  const pollIntervalMs = Number(
    choose(options.pollIntervalMs, target.pollIntervalMs, env.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
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
      env.cdpHttpUrl
    )
  );
  const windowSettleEndpoint = choose(
    options.windowSettleEndpoint,
    target.windowSettleEndpoint,
    target.window_settle_endpoint,
    env.windowSettleEndpoint
  );
  const managedSurface = typeof target.surface_id === "string" && target.surface_id.length > 0;
  if (managedSurface && !windowSettleEndpoint) {
    throw presentationScreenError(
      "managed n.eko surface is missing its window-settle endpoint",
      "neko_window_settle_endpoint_required"
    );
  }
  const windowSettleTimeoutMs = Number(
    choose(options.windowSettleTimeoutMs, target.windowSettleTimeoutMs, DEFAULT_WINDOW_SETTLE_TIMEOUT_MS)
  );
  const windowSettlePollIntervalMs = Number(
    choose(
      options.windowSettlePollIntervalMs,
      target.windowSettlePollIntervalMs,
      DEFAULT_WINDOW_SETTLE_POLL_INTERVAL_MS
    )
  );
  const browserOwnerMode = normalizeBrowserOwnerMode(
    choose(options.browserOwnerMode, target.browserOwnerMode, target.browser_owner_mode, env.browserOwnerMode)
  );
  const requestedStealthMode = choose(options.stealthMode, target.stealthMode, target.stealth_mode, env.stealthMode);
  const stealthMode = normalizeStealthMode(requestedStealthMode, browserOwnerMode);
  if (isBalancedStealthMode(requestedStealthMode)) {
    safeLog(logger, "warn", "neko_stealth_balanced_normalized", {
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
      target.navigate_url
    )
  );
  const browserClientOption = choose(options.browserClient, target.browserClient);
  const browserClientFactory =
    choose(
      options.createBrowserClient,
      options.browserClientFactory,
      target.createBrowserClient,
      target.browserClientFactory,
      createNekoBrowserClient
    ) || createNekoBrowserClient;
  const browserControlAvailable = browserControlIsAvailable(
    cdpHttpUrl,
    stealthMode,
    browserClientOption,
    browserClientFactory
  );
  const assistiveBrowserControlAllowed = assistiveBrowserControlIsAllowed(browserControlAvailable, stealthMode);
  let bearer = normalizeBearer(
    choose(options.bearerToken, target.bearerToken, options.bearer, target.bearer, env.bearerToken)
  );
  let cookie: string | null = choose(options.cookie, target.cookie, null) || null;

  const frameHandlers = new Set<(frame: NekoFrame) => void>();
  const eventHandlers = new Set<(event: NekoEvent) => void>();
  let browserClient: NekoBrowserClient | null = null;
  let browserClientPromise: Promise<NekoBrowserClient> | null = null;
  let browserClientConnected = false;
  let pageFocusSetupPromise: Promise<void> | null = null;
  let pageFocusSetupComplete = false;
  let lastBrowserViewport: NekoViewport | null = null;
  let started = false;
  let closed = false;
  let authReady = false;
  let frameSeq = 0;
  let currentViewport: NekoViewport | null = null;
  let abortController: AbortController | null = null;
  let pollLoopPromise: Promise<void> | null = null;
  let navigationApplied = false;
  let screencastPipelineDisabled = false;
  const presentationLifecycle = choose(options.presentationLifecycle, target.presentationLifecycle, null);
  let presentationBaseline: NekoScreenConfiguration | null = null;
  let presentationEpoch = 0;
  let presentationMutationTail = Promise.resolve();

  function headers(extra: HeaderMap = {}): HeaderMap {
    return addAuthenticationHeaders(
      { ...(target.headers || {}), ...(options.headers || {}), ...extra },
      bearer,
      cookie
    );
  }

  // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
  async function ensureOk(response: NekoResponse, code: string): Promise<NekoResponse> {
    if (isOk(response)) {
      return response;
    }
    const err: CodedError = new Error(`n.eko request failed with status ${statusOf(response)}`);
    err.code = code;
    err.status = statusOf(response);
    throw err;
  }

  // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
  async function fetchWithAuth(url: string, request: NekoRequest = {}): Promise<NekoResponse> {
    return fetchImpl(url, {
      ...request,
      headers: headers(request.headers),
    });
  }

  function markAuthenticationReady() {
    authReady = true;
  }

  function authenticationAlreadyConfigured(): string | null {
    return bearer || cookie;
  }

  function loginBody(): HeaderMap {
    const body: HeaderMap = {};
    if (username) {
      body.username = username;
    }
    if (password) {
      body.password = password;
    }
    return body;
  }

  function recordLoginCredentials(response: NekoResponse, json: unknown): void {
    const nextCookie = cookieHeaderFrom(response);
    if (nextCookie) {
      cookie = nextCookie;
    }
    const record = recordOrNull(json);
    const token = choose(record?.token, record?.access_token, record?.session, record?.NEKO_SESSION);
    if (token) {
      bearer = normalizeBearer(token);
    }
  }

  async function requestLogin(signal?: AbortSignalLike): Promise<NekoResponse> {
    const response = await fetchImpl(loginUrl, {
      body: JSON.stringify(loginBody()),
      headers: headers({ "Content-Type": "application/json" }),
      method: "POST",
      signal,
    });
    await ensureOk(response, "neko_login_failed");
    return response;
  }

  async function authenticate(signal?: AbortSignalLike): Promise<void> {
    if (authReady) {
      return;
    }
    if (authenticationAlreadyConfigured()) {
      markAuthenticationReady();
      return;
    }
    const response = await requestLogin(signal);
    recordLoginCredentials(response, await responseJsonOrNull(response));
    markAuthenticationReady();
  }

  async function postJson(url: string, payload: unknown, signal?: AbortSignalLike): Promise<NekoResponse> {
    const response = await fetchWithAuth(url, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal,
    });
    return ensureOk(response, "neko_post_failed");
  }

  function createBrowserControlError(message: string, code: string): CodedError {
    const err: CodedError = new Error(message);
    err.code = code;
    return err;
  }

  function assertBrowserControlIsAvailable() {
    if (!browserControlAvailable) {
      throw createBrowserControlError(
        "n.eko assistive browser control is not configured",
        "neko_browser_control_unavailable"
      );
    }
  }

  function assertBrowserControlIsNotAborted(signal?: AbortSignalLike): void {
    if (signal?.aborted) {
      throw createBrowserControlError("n.eko browser control aborted", "neko_browser_control_aborted");
    }
  }

  async function createBrowserClientFromFactory(): Promise<NekoBrowserClient> {
    return await browserClientFactory({ cdpHttpUrl, logger });
  }

  function assertValidBrowserClient(client: unknown): asserts client is NekoBrowserClient {
    if (!client || typeof client !== "object") {
      throw createBrowserControlError("n.eko browser client is invalid", "neko_browser_control_invalid");
    }
  }

  async function connectClientIfNeeded(client: NekoBrowserClient, _signal?: AbortSignalLike): Promise<void> {
    if (!browserClientConnected && typeof client.connect === "function") {
      await client.connect();
    }
  }

  async function connectBrowserClient(signal?: AbortSignalLike): Promise<NekoBrowserClient> {
    const client = browserClientOption || (await createBrowserClientFromFactory());
    assertValidBrowserClient(client);
    browserClient = client;
    await connectClientIfNeeded(client, signal);
    browserClientConnected = true;
    return client;
  }

  function connectedBrowserClient(): NekoBrowserClient | null {
    return browserClientConnected && browserClient ? browserClient : null;
  }

  async function awaitBrowserClientConnection(): Promise<NekoBrowserClient> {
    const pending = browserClientPromise;
    if (!pending) {
      throw createBrowserControlError("n.eko browser client connection is missing", "neko_browser_control_missing");
    }
    try {
      return await pending;
    } catch (err) {
      browserClient = null;
      browserClientConnected = false;
      throw err;
    } finally {
      browserClientPromise = null;
    }
  }

  // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
  async function getBrowserClient(signal?: AbortSignalLike): Promise<NekoBrowserClient> {
    assertBrowserControlIsAvailable();
    assertBrowserControlIsNotAborted(signal);
    const connected = connectedBrowserClient();
    if (connected) {
      return connected;
    }
    if (browserClientPromise) {
      return browserClientPromise;
    }
    browserClientPromise = connectBrowserClient(signal);
    return awaitBrowserClientConnection();
  }

  function focusEventFromPayload(payload: unknown): Extract<NekoEvent, { kind: "keyboard_focus" }> {
    return {
      element: recordOrNull(payload),
      focused: recordOrNull(payload)?.type === "focus",
      kind: "keyboard_focus",
    };
  }

  function logFocusPayloadParseFailure(error: unknown): void {
    safeLog(logger, "warn", "neko_focus_event_parse_failed", {
      error: error instanceof Error ? error.message : undefined,
    });
  }

  function handleFocusPayload(payloadJson: unknown): void {
    if (typeof payloadJson !== "string") {
      return;
    }
    try {
      emitEvent(focusEventFromPayload(JSON.parse(payloadJson)));
    } catch (error) {
      logFocusPayloadParseFailure(error);
    }
  }

  function focusDetectionIsUnavailable() {
    return !assistiveBrowserControlAllowed || pageFocusSetupComplete;
  }

  async function installFocusDetection(signal?: AbortSignalLike): Promise<void> {
    const client = await getBrowserClient(signal);
    const source = buildFocusDetectionScript();
    await client.exposeBinding(FOCUS_BINDING_NAME, (_source: unknown, payloadJson: unknown) => {
      handleFocusPayload(payloadJson);
    });
    await client.addInitScript(source);
    await client.evaluate(source);
    pageFocusSetupComplete = true;
  }

  function logFocusDetectionFailure(err: unknown): void {
    safeLog(logger, "warn", "neko_focus_detection_failed", {
      browser_owner_mode: browserOwnerMode,
      error: err instanceof Error ? err.message : undefined,
      stealth_mode: stealthMode,
    });
  }

  async function finishFocusDetectionSetup(): Promise<void> {
    try {
      await pageFocusSetupPromise;
    } catch (err) {
      pageFocusSetupPromise = null;
      logFocusDetectionFailure(err);
    }
  }

  async function setupFocusDetectionBestEffort(signal?: AbortSignalLike): Promise<void> {
    if (focusDetectionIsUnavailable()) {
      return;
    }
    if (pageFocusSetupPromise) {
      return pageFocusSetupPromise;
    }
    pageFocusSetupPromise = installFocusDetection(signal);
    await finishFocusDetectionSetup();
  }

  function releaseBrowserClient(): NekoBrowserClient | null {
    if (!browserClient) {
      return null;
    }
    const client = browserClient;
    browserClient = null;
    browserClientConnected = false;
    browserClientPromise = null;
    pageFocusSetupPromise = null;
    pageFocusSetupComplete = false;
    return client;
  }

  async function closeClientBestEffort(client: NekoBrowserClient): Promise<void> {
    try {
      if (typeof client.close === "function") {
        await client.close();
      }
    } catch {
      /* ignore */
    }
  }

  async function closeBrowserClient(): Promise<void> {
    const client = releaseBrowserClient();
    if (!client) {
      return;
    }
    await closeClientBestEffort(client);
  }

  function screenConfigurationEndpoints(): ScreenEndpoints {
    const config = { ...target, ...options };
    const configurationsEndpoint = choose(
      config.screenConfigurationsEndpoint,
      config.screenConfigurationsPath,
      config.screen_configurations_endpoint
    );
    return {
      configurationsEndpoint: typeof configurationsEndpoint === "string" ? configurationsEndpoint : undefined,
      screenEndpoint: typeof config.screenEndpoint === "string" ? config.screenEndpoint : undefined,
    };
  }

  async function selectScreenConfiguration(
    dimensions: NekoScreenDimensions,
    endpoints: Required<ScreenEndpoints>,
    signal?: AbortSignalLike
  ): Promise<NekoScreenConfiguration> {
    const response = await fetchWithAuth(resolveUrl(origin, endpoints.configurationsEndpoint), {
      method: "GET",
      signal,
    });
    await ensureOk(response, "neko_screen_configurations_failed");
    const configurations = await responseJsonOrNull(response);
    const configs = Array.isArray(configurations)
      ? configurations.flatMap((item) => {
          const config = normalizeScreenConfig(item);
          return config ? [config] : [];
        })
      : [];
    if (!configs?.length) {
      throw createBrowserControlError("n.eko screen configuration list is empty", "neko_screen_configurations_empty");
    }
    const [candidate] = rankNekoScreenConfigurations(configs, dimensions.width, dimensions.height);
    if (!candidate) {
      throw createBrowserControlError("n.eko screen configuration list is empty", "neko_screen_configurations_empty");
    }
    return candidate;
  }

  async function applyScreenConfiguration(
    candidate: NekoScreenConfiguration,
    screenEndpoint: string,
    signal?: AbortSignalLike
  ): Promise<NekoScreenConfiguration> {
    const response = await postJson(resolveUrl(origin, screenEndpoint), candidate, signal);
    return normalizeScreenConfig(await responseJsonOrNull(response)) || candidate;
  }

  function windowIsSettledForScreen(status: unknown, candidate: NekoScreenConfiguration): boolean {
    const record = recordOrNull(status);
    return (
      record?.settled === true &&
      asFinitePositiveInt(record.width) === candidate.width &&
      asFinitePositiveInt(record.height) === candidate.height
    );
  }

  async function windowSettleStatus(
    settleUrl: URL,
    candidate: NekoScreenConfiguration,
    signal?: AbortSignalLike
  ): Promise<boolean> {
    const response = await fetchWithAuth(settleUrl.toString(), { method: "GET", signal });
    await ensureOk(response, "neko_window_settle_status_failed");
    return windowIsSettledForScreen(await responseJsonOrNull(response), candidate);
  }

  function assertWindowSettleDeadline(deadline: number): void {
    if (now() >= deadline) {
      throw presentationScreenError(
        "n.eko browser window did not settle to the applied screen",
        "neko_window_settle_timeout"
      );
    }
  }

  async function waitForWindowSettled(candidate: NekoScreenConfiguration, signal?: AbortSignalLike): Promise<void> {
    if (!windowSettleEndpoint) {
      return;
    }
    const deadline = now() + windowSettleTimeoutMs;
    const settleUrl = new URL(resolveUrl(origin, windowSettleEndpoint));
    settleUrl.searchParams.set("width", String(candidate.width));
    settleUrl.searchParams.set("height", String(candidate.height));
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      if (await windowSettleStatus(settleUrl, candidate, signal)) {
        return;
      }
      assertWindowSettleDeadline(deadline);
      await sleep(windowSettlePollIntervalMs, signal);
    }
  }

  function presentationScreenError(message: string, code: string): CodedError {
    return createBrowserControlError(message, code);
  }

  function presentationOperationIsCurrent(epoch: number): boolean {
    return !closed && epoch === presentationEpoch;
  }

  function enqueuePresentationScreenOperation(
    epoch: number,
    operation: () => Promise<PresentationOperationResult>
  ): Promise<PresentationOperationResult> {
    const scheduled = presentationMutationTail.then(async () => {
      if (!presentationOperationIsCurrent(epoch)) {
        return { discarded: true };
      }
      return await operation();
    });
    presentationMutationTail = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  }

  async function capturePresentationBaseline(
    request: ScreenConfigurationRequest,
    signal?: AbortSignalLike
  ): Promise<NekoScreenConfiguration> {
    if (presentationBaseline) {
      return presentationBaseline;
    }
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const screenEndpoint = request.endpoints.screenEndpoint;
    if (!screenEndpoint) {
      throw presentationScreenError(
        "n.eko screen baseline endpoint is not configured",
        "neko_screen_baseline_unavailable"
      );
    }
    const response = await fetchWithAuth(resolveUrl(origin, screenEndpoint), {
      method: "GET",
      signal,
    });
    await ensureOk(response, "neko_screen_baseline_capture_failed");
    const baseline = normalizeScreenConfig(await responseJsonOrNull(response));
    if (!baseline) {
      throw presentationScreenError("n.eko screen baseline is invalid", "neko_screen_baseline_invalid");
    }
    if (typeof presentationLifecycle?.captureBaseline === "function") {
      await presentationLifecycle.captureBaseline({ baseline });
    }
    presentationBaseline = baseline;
    return baseline;
  }

  function reportScreenConfiguration(
    lastApplied: NekoScreenConfiguration,
    dimensions: NekoScreenDimensions,
    candidate: NekoScreenConfiguration
  ): void {
    emitEvent({
      applied: lastApplied,
      kind: "screen_configuration",
      requested: dimensions,
      selected: candidate,
    });
    if (!screenConfigFitsCover(lastApplied, dimensions.width, dimensions.height)) {
      safeLog(logger, "warn", "neko_screen_configuration_imperfect_fit", {
        applied: lastApplied,
        requested: dimensions,
      });
    }
  }

  function capturedScreenConfiguration(lastApplied: NekoScreenConfiguration): NekoScreenConfiguration {
    return {
      height: lastApplied.height,
      rate: lastApplied.rate,
      width: estimateCapturedWidth(lastApplied.width),
    };
  }

  function screenConfigurationRequest(viewport: NekoViewport): ScreenConfigurationRequest | null {
    const dimensions = viewportScreenDimensions(viewport);
    if (!dimensions) {
      return null;
    }
    const endpoints = screenConfigurationEndpoints();
    if (!endpoints.screenEndpoint) {
      return null;
    }
    return {
      dimensions,
      endpoints,
      selectConfiguration: Boolean(endpoints.configurationsEndpoint),
    };
  }

  async function applySelectedScreenConfiguration(
    request: ScreenConfigurationRequest,
    signal?: AbortSignalLike
  ): Promise<NekoScreenConfiguration | null> {
    const { dimensions, endpoints } = request;
    if (!request.selectConfiguration) {
      return null;
    }
    if (!(endpoints.configurationsEndpoint && endpoints.screenEndpoint)) {
      return null;
    }
    const candidate = await selectScreenConfiguration(
      dimensions,
      { configurationsEndpoint: endpoints.configurationsEndpoint, screenEndpoint: endpoints.screenEndpoint },
      signal
    );
    const lastApplied = await applyScreenConfiguration(candidate, endpoints.screenEndpoint, signal);
    const capturedScreen = capturedScreenConfiguration(lastApplied);
    await waitForWindowSettled(capturedScreen, signal);
    reportScreenConfiguration(lastApplied, dimensions, candidate);
    return capturedScreen;
  }

  async function setBrowserViewport(
    dimensions: { height: number; width: number },
    signal?: AbortSignalLike
  ): Promise<void> {
    try {
      const client = await getBrowserClient(signal);
      await client.setViewportSize(dimensions);
    } catch (err) {
      safeLog(logger, "warn", "neko_browser_viewport_failed", {
        error: err instanceof Error ? err.message : undefined,
      });
    }
  }

  async function applyBrowserViewportBestEffort(viewport: NekoViewport, signal?: AbortSignalLike): Promise<void> {
    if (!assistiveBrowserControlAllowed) {
      return;
    }
    const dimensions = viewportDimensions(viewport);
    if (!dimensions) {
      return;
    }
    await setBrowserViewport(dimensions, signal);
  }

  function shouldSkipInitialNavigation() {
    return !navigationUrl || navigationApplied;
  }

  function logInitialNavigationSkipped() {
    safeLog(logger, "warn", "neko_initial_navigation_skipped", {
      browser_owner_mode: browserOwnerMode,
      stealth_mode: stealthMode,
    });
  }

  async function navigateInitially(signal?: AbortSignalLike): Promise<boolean> {
    try {
      const client = await getBrowserClient(signal);
      if (!navigationUrl) {
        return false;
      }
      await client.goto(navigationUrl);
      navigationApplied = true;
      return true;
    } catch (err) {
      safeLog(logger, "warn", "neko_initial_navigation_failed", {
        error: err instanceof Error ? err.message : undefined,
      });
      throw err;
    }
  }

  // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
  async function applyInitialNavigation(signal?: AbortSignalLike): Promise<boolean> {
    if (shouldSkipInitialNavigation()) {
      return false;
    }
    if (!assistiveBrowserControlAllowed) {
      logInitialNavigationSkipped();
      return false;
    }
    return navigateInitially(signal);
  }

  async function insertTextViaBrowserClient(text: string, signal?: AbortSignalLike): Promise<void> {
    if (!assistiveBrowserControlAllowed) {
      throw createBrowserControlError(
        "n.eko browser paste control is not configured",
        "neko_browser_control_unavailable"
      );
    }
    const client = await getBrowserClient(signal);
    await client.keyboard.insertText(text);
  }

  function emitEvent(event: NekoEvent): void {
    notifyHandlers(eventHandlers, event, (error) => {
      safeLog(logger, "warn", "neko_event_handler_error", {
        error: error instanceof Error ? error.message : undefined,
        kind: event.kind,
      });
    });
  }

  async function copySelectionViaBrowserClient(signal?: AbortSignalLike): Promise<void> {
    if (!assistiveBrowserControlAllowed) {
      throw createBrowserControlError(
        "n.eko browser copy control is not configured",
        "neko_browser_control_unavailable"
      );
    }
    await sleep(50, signal);
    const client = await getBrowserClient(signal);
    const text = await client.evaluate(buildCopySelectionExpression());
    if (typeof text === "string" && text.length > 0) {
      emitEvent({ kind: "clipboard", text });
    }
  }

  async function readPageViewportStatus(signal?: AbortSignalLike): Promise<UnknownRecord | null> {
    const client = await getBrowserClient(signal);
    const value = await client.evaluate(buildViewportStatusExpression());
    if (typeof value !== "string") {
      return null;
    }
    try {
      return recordOrNull(JSON.parse(value)) || { raw: value };
    } catch {
      return { raw: value };
    }
  }

  function recordRemainingPageMetricsMismatch(status: UnknownRecord, expectedViewport: NekoViewport | null): void {
    const remainingMismatch = pageMetricsMismatch(status.page, expectedViewport);
    if (remainingMismatch) {
      status.page_metrics_mismatch_after_reapply = remainingMismatch;
    }
  }

  function recordPageMetricsReapplyError(status: UnknownRecord, err: unknown): void {
    status.page_metrics_reapply_error = {
      code:
        err instanceof Error && "code" in err && typeof err.code === "string"
          ? err.code
          : "neko_page_metrics_reapply_failed",
      message: err instanceof Error ? err.message : "n.eko page metrics reapply failed",
    };
  }

  async function reapplyPageMetricsBestEffort(
    status: UnknownRecord,
    expectedViewport: NekoViewport | null
  ): Promise<void> {
    if (!expectedViewport) {
      return;
    }
    try {
      await applyBrowserViewportBestEffort(expectedViewport, abortController?.signal);
      status.page_metrics_reapplied = true;
      status.page = await readPageViewportStatus(abortController?.signal);
      recordRemainingPageMetricsMismatch(status, expectedViewport);
    } catch (err) {
      recordPageMetricsReapplyError(status, err);
    }
  }

  function markPageCdpSkipped(status: UnknownRecord): void {
    status.page_cdp_available = false;
    status.page_cdp_skipped = {
      browser_owner_mode: browserOwnerMode,
      stealth_mode: stealthMode,
    };
  }

  function recordPageCdpError(status: UnknownRecord, err: unknown): void {
    status.page_cdp_available = false;
    status.page_cdp_error = {
      code:
        err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : "neko_page_status_failed",
      message: err instanceof Error ? err.message : "n.eko page status failed",
    };
  }

  async function collectAvailablePageViewportStatus(status: UnknownRecord): Promise<void> {
    status.page_cdp_available = true;
    status.page = await readPageViewportStatus(abortController?.signal);
    const expectedViewport = lastBrowserViewport || currentViewport;
    const mismatch = pageMetricsMismatch(status.page, expectedViewport);
    if (mismatch) {
      status.page_metrics_mismatch = mismatch;
      await reapplyPageMetricsBestEffort(status, expectedViewport);
    }
  }

  async function collectPageViewportStatus(status: UnknownRecord): Promise<void> {
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

  async function readScreenStatus(): Promise<{ available: boolean; value?: unknown }> {
    const config = { ...target, ...options };
    const screenEndpoint = choose(config.screenEndpoint, "api/room/screen");
    const response = await fetchWithAuth(resolveUrl(origin, screenEndpoint), {
      method: "GET",
      signal: abortController?.signal,
    });
    return isOk(response) ? { available: true, value: await responseJsonOrNull(response) } : { available: false };
  }

  function recordScreenStatusError(status: UnknownRecord, err: unknown): void {
    status.screen_error = {
      code:
        err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : "neko_screen_status_failed",
      message: err instanceof Error ? err.message : "n.eko screen status failed",
    };
  }

  async function collectScreenStatus(status: UnknownRecord): Promise<void> {
    try {
      await authenticate(abortController?.signal);
      const screen = await readScreenStatus();
      if (screen.available) {
        status.screen = screen.value;
      }
    } catch (err) {
      recordScreenStatusError(status, err);
    }
  }

  async function queryNekoStatus(): Promise<UnknownRecord> {
    const status: UnknownRecord = {};
    await collectScreenStatus(status);
    status.window_skipped = {
      browser_owner_mode: browserOwnerMode,
      stealth_mode: stealthMode,
    };

    await collectPageViewportStatus(status);

    return status;
  }

  function mergeAppliedScreenIntoViewport(
    viewport: NekoViewport,
    appliedScreen: NekoScreenConfiguration | null
  ): NekoViewport {
    if (!appliedScreen) {
      return viewport;
    }
    if (viewportHasSeparateScreenDimensions(viewport)) {
      return { ...viewport, screenHeight: appliedScreen.height, screenWidth: appliedScreen.width };
    }
    return { ...viewport, height: appliedScreen.height, width: appliedScreen.width };
  }

  function viewportPayloadFor(viewport: NekoViewport): ViewportPayload {
    if (typeof target.viewportPayload === "function") {
      return target.viewportPayload(viewport);
    }
    const payload = target.viewportPayload || options.viewportPayload;
    return typeof payload === "function" ? payload(viewport) : payload || buildViewportPayload(viewport, frameRate);
  }

  function viewportEndpoints(
    appliedScreen: NekoScreenConfiguration | null,
    screenConfigurationWasRequested: boolean
  ): string[] {
    const config = { ...target, ...options };
    const endpoints = endpointList(config, [
      "viewportEndpoint",
      "screenConfigEndpoint",
      "windowEndpoint",
      "windowControlEndpoint",
    ]);
    if (
      !(appliedScreen || screenConfigurationWasRequested) &&
      typeof config.screenEndpoint === "string" &&
      config.screenEndpoint.length > 0
    ) {
      endpoints.push(config.screenEndpoint);
    }
    return endpoints;
  }

  async function postViewportEndpoint(endpoint: string, payload: unknown, signal?: AbortSignalLike): Promise<void> {
    try {
      await postJson(resolveUrl(origin, endpoint), payload, signal);
    } catch (error) {
      safeLog(logger, "warn", "neko_viewport_update_failed", {
        endpoint,
        error: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async function postViewportToEndpoints(
    endpoints: readonly string[],
    payload: unknown,
    signal?: AbortSignalLike
  ): Promise<void> {
    for (const endpoint of endpoints) {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      await postViewportEndpoint(endpoint, payload, signal);
    }
  }

  async function applyScreenConfigurationForViewport(
    request: ScreenConfigurationRequest | null,
    signal: AbortSignalLike,
    epoch: number
  ): Promise<NekoScreenConfiguration | null> {
    if (!request) {
      return null;
    }
    await capturePresentationBaseline(request, signal);
    if (!presentationOperationIsCurrent(epoch)) {
      return null;
    }
    return applySelectedScreenConfiguration(request, signal);
  }

  async function applyViewportBestEffort(
    viewport: NekoViewport | null,
    signal: AbortSignalLike,
    epoch: number
  ): Promise<NekoViewport | null> {
    if (!viewport || typeof viewport !== "object") {
      return null;
    }
    const payload = viewportPayloadFor(viewport);
    const request = screenConfigurationRequest(viewport);
    const appliedScreen = await applyScreenConfigurationForViewport(request, signal, epoch);
    if (!presentationOperationIsCurrent(epoch)) {
      return null;
    }
    await postViewportToEndpoints(
      viewportEndpoints(appliedScreen, Boolean(request?.selectConfiguration)),
      payload,
      signal
    );
    if (!presentationOperationIsCurrent(epoch)) {
      return null;
    }
    const browserViewport = mergeAppliedScreenIntoViewport(viewport, appliedScreen);
    lastBrowserViewport = browserViewport;
    await applyBrowserViewportBestEffort(browserViewport, signal);
    return browserViewport;
  }

  async function applyPresentationViewport(
    viewport: NekoViewport | null,
    signal: AbortSignalLike,
    epoch: number,
    authenticateBeforeApply = false
  ): Promise<NekoViewport | null> {
    const result = await enqueuePresentationScreenOperation(epoch, async () => {
      if (authenticateBeforeApply) {
        await authenticate(signal);
      }
      const applied = await applyViewportBestEffort(viewport, signal, epoch);
      return { applied };
    });
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    return result?.discarded ? null : result?.applied || null;
  }

  async function restoreBaselineScreen(baseline: NekoScreenConfiguration): Promise<NekoScreenConfiguration> {
    const endpoints = screenConfigurationEndpoints();
    if (!endpoints.screenEndpoint) {
      throw presentationScreenError(
        "n.eko screen restore endpoint is not configured",
        "neko_screen_restore_unavailable"
      );
    }
    await authenticate(abortController?.signal);
    const restored = await applyScreenConfiguration(baseline, endpoints.screenEndpoint, abortController?.signal);
    await waitForWindowSettled(restored, abortController?.signal);
    if (typeof presentationLifecycle?.markRestored === "function") {
      await presentationLifecycle.markRestored({ baseline, restored });
    }
    presentationBaseline = null;
    return restored;
  }

  async function restorePresentationBaseline(): Promise<void> {
    if (!presentationBaseline) {
      return;
    }
    const baseline = presentationBaseline;
    // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
    const restoreEpoch = ++presentationEpoch;
    const result = await enqueuePresentationScreenOperation(restoreEpoch, async () => {
      const restored = await restoreBaselineScreen(baseline);
      return { restored };
    });
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    if (result?.discarded) {
      throw presentationScreenError("n.eko screen restore was superseded", "neko_screen_restore_superseded");
    }
  }

  function emitFrame(data: string): void {
    const frame = {
      data,
      metadata: buildMetadata(currentViewport, now),
      // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
      sessionId: ++frameSeq,
    };
    notifyHandlers(frameHandlers, frame, (error) => {
      safeLog(logger, "warn", "neko_frame_handler_error", {
        error: error instanceof Error ? error.message : undefined,
      });
    });
  }

  async function fetchScreenshotFallback(signal?: AbortSignalLike): Promise<string> {
    const fallback = await fetchWithAuth(screenshotFallbackUrl, { method: "GET", signal });
    await ensureOk(fallback, "neko_screenshot_failed");
    return responseToBase64(fallback);
  }

  // biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
  async function fetchPrimaryScreencast(signal?: AbortSignalLike): Promise<NekoResponse> {
    return fetchWithAuth(screencastUrl, { method: "GET", signal });
  }

  function shouldUseScreenshotFallback(primary: NekoResponse): boolean {
    return statusOf(primary) === 400 && screenshotFallbackUrl !== screencastUrl;
  }

  async function resolvePrimaryScreencast(primary: NekoResponse, signal?: AbortSignalLike): Promise<string | null> {
    if (isOk(primary)) {
      return responseToBase64(primary);
    }
    if (shouldUseScreenshotFallback(primary)) {
      screencastPipelineDisabled = true;
      return fetchScreenshotFallback(signal);
    }
    await ensureOk(primary, "neko_screenshot_failed");
    return null;
  }

  async function fetchFrame(signal?: AbortSignalLike): Promise<string | null> {
    if (screencastPipelineDisabled) {
      return fetchScreenshotFallback(signal);
    }
    const primary = await fetchPrimaryScreencast(signal);
    return resolvePrimaryScreencast(primary, signal);
  }

  function shouldPoll(signal: AbortSignal): boolean {
    return !signal.aborted && started && !closed;
  }

  async function emitPolledFrame(
    data: string | null,
    signal: AbortSignal,
    frameEpoch: number
  ): Promise<"emitted" | "skipped" | "stale"> {
    await presentationMutationTail;
    if (!(data && shouldPoll(signal))) {
      return "skipped";
    }
    if (frameEpoch !== presentationEpoch) {
      return "stale";
    }
    emitFrame(data);
    return "emitted";
  }

  function logPollingFailure(signal: AbortSignal, err: unknown): void {
    if (!signal.aborted) {
      safeLog(logger, "warn", "neko_frame_poll_failed", { error: err instanceof Error ? err.message : undefined });
    }
  }

  async function pollFrame(signal: AbortSignal): Promise<void> {
    try {
      for (let fetchCount = 0; fetchCount < MAX_FRAME_FETCHES_PER_POLL_CYCLE && shouldPoll(signal); fetchCount += 1) {
        const frameEpoch = presentationEpoch;
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
        const outcome = await emitPolledFrame(await fetchFrame(signal), signal, frameEpoch);
        if (outcome !== "stale") {
          return;
        }
      }
    } catch (err) {
      logPollingFailure(signal, err);
    }
  }

  async function pollLoop(signal: AbortSignal): Promise<void> {
    while (shouldPoll(signal)) {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      await pollFrame(signal);
      if (shouldPoll(signal)) {
        await sleep(pollIntervalMs, signal);
      }
    }
  }

  function closedCompanionError(): CodedError {
    const err: CodedError = new Error("Streaming companion is closed");
    err.code = "companion_closed";
    return err;
  }

  async function initializeCompanion(viewport?: NekoViewport): Promise<void> {
    abortController = new AbortController();
    currentViewport = viewport || null;
    await authenticate(abortController.signal);
    // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
    const epoch = ++presentationEpoch;
    currentViewport =
      (await applyPresentationViewport(currentViewport, abortController.signal, epoch)) || currentViewport;
    await setupFocusDetectionBestEffort(abortController.signal);
    await applyInitialNavigation(abortController.signal);
    started = true;
    pollLoopPromise = pollLoop(abortController.signal).catch((err) => {
      safeLog(logger, "warn", "neko_poll_loop_failed", { error: err?.message });
    });
  }

  async function start(viewport?: NekoViewport): Promise<void> {
    if (closed) {
      throw closedCompanionError();
    }
    if (started) {
      return;
    }
    await initializeCompanion(viewport);
  }

  async function stop() {
    if (closed) {
      return;
    }
    started = false;
    await restorePresentationBaseline();
    closed = true;
    abortController?.abort();
    await pollLoopPromise;
    await closeBrowserClient();
    frameHandlers.clear();
    eventHandlers.clear();
  }

  async function dispatchViewport(event: NekoViewport): Promise<boolean> {
    // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
    const epoch = ++presentationEpoch;
    currentViewport = event;
    currentViewport = (await applyPresentationViewport(event, abortController?.signal, epoch, true)) || currentViewport;
    return true;
  }

  async function dispatchPaste(event: UnknownRecord): Promise<boolean> {
    if (typeof event.text !== "string" || !assistiveBrowserControlAllowed) {
      return false;
    }
    await authenticate(abortController?.signal);
    await insertTextViaBrowserClient(event.text, abortController?.signal);
    return true;
  }

  async function dispatchCopy(): Promise<boolean> {
    if (!assistiveBrowserControlAllowed) {
      return false;
    }
    await authenticate(abortController?.signal);
    await copySelectionViaBrowserClient(abortController?.signal);
    return true;
  }

  async function dispatchInput(event: UnknownRecord): Promise<void> {
    const inputEndpoint = choose(
      options.inputEndpoint,
      target.inputEndpoint,
      target.dispatchEndpoint,
      options.dispatchEndpoint
    );
    if (!inputEndpoint) {
      return;
    }
    await authenticate(abortController?.signal);
    await postJson(resolveUrl(origin, inputEndpoint), event, abortController?.signal);
  }

  const eventDispatchers: Record<string, (event: UnknownRecord) => Promise<boolean>> = {
    copy: dispatchCopy,
    paste: dispatchPaste,
    viewport: dispatchViewport,
  };

  async function dispatch(event: UnknownRecord): Promise<void> {
    const dispatchEvent = typeof event.type === "string" ? eventDispatchers[event.type] : undefined;
    if (dispatchEvent && (await dispatchEvent(event))) {
      return;
    }
    await dispatchInput(event);
  }

  function nekoProxyTarget(): { origin: string } & UnknownRecord {
    const targetProperties = ["surface_id", "lease_id", "profile_key", "interaction_id"];
    const populatedProperties = targetProperties.flatMap((name) => (target[name] ? [[name, target[name]]] : []));
    return { origin, ...Object.fromEntries(populatedProperties) };
  }

  const companion: NekoCompanion = {
    /** test-only escape hatch */
    _internal: {
      browserOwnerMode: () => browserOwnerMode,
      isAuthenticated: () => authReady,
      isClosed: () => closed,
      isStarted: () => started,
      stealthMode: () => stealthMode,
    },
    async ackFrame() {
      // HTTP-polling n.eko screenshots do not use CDP back-pressure.
    },
    backend: "neko",
    browser_session_id,
    dispatch,
    getNekoProxyTarget: nekoProxyTarget,
    onEvent(handler: (event: NekoEvent) => void) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onFrame(handler: (frame: NekoFrame) => void) {
      frameHandlers.add(handler);
      return () => frameHandlers.delete(handler);
    },
    queryNekoStatus,
    start,
    stop,
  };
  return companion;
}

interface ResolvedNekoCompanionOptions {
  browser_session_id?: string;
  defaults: NekoCompanionOptions;
  interaction_id: string;
  resolveTargetForInteraction: (
    runId: string,
    interactionId: string
  ) => Promise<NekoTargetInput | null | undefined> | NekoTargetInput | null | undefined;
  run_id: string;
}

function createResolvedNekoCompanion({
  run_id,
  interaction_id,
  browser_session_id,
  resolveTargetForInteraction,
  defaults,
}: ResolvedNekoCompanionOptions): NekoCompanion {
  let inner: NekoCompanion | null = null;
  const pendingFrames = new Map<
    (frame: NekoFrame) => void,
    { handler: (frame: NekoFrame) => void; innerUnsubscribe: (() => void) | null }
  >();
  const pendingEvents = new Map<
    (event: NekoEvent) => void,
    { handler: (event: NekoEvent) => void; innerUnsubscribe: (() => void) | null }
  >();

  function bindPending(next: NekoCompanion): void {
    inner = next;
    for (const record of pendingFrames.values()) {
      record.innerUnsubscribe = inner.onFrame(record.handler);
    }
    for (const record of pendingEvents.values()) {
      record.innerUnsubscribe = inner.onEvent(record.handler);
    }
  }

  async function ensureInner(): Promise<NekoCompanion> {
    if (inner) {
      return inner;
    }
    const target = await Promise.resolve(resolveTargetForInteraction(run_id, interaction_id));
    if (!target) {
      const err: CodedError = new Error("No n.eko target registered for this run");
      err.code = "streaming_target_unregistered";
      throw err;
    }
    bindPending(createNekoCompanion({ ...defaults, target, ...(browser_session_id ? { browser_session_id } : {}) }));
    if (!inner) {
      const err: CodedError = new Error("n.eko companion did not initialize");
      err.code = "neko_companion_missing";
      throw err;
    }
    return inner;
  }

  function subscribeFrame(handler: (frame: NekoFrame) => void): () => void {
    if (inner) {
      return inner.onFrame(handler);
    }
    const record = { handler, innerUnsubscribe: null as (() => void) | null };
    pendingFrames.set(handler, record);
    return () => {
      pendingFrames.delete(handler);
      if (record.innerUnsubscribe) {
        record.innerUnsubscribe();
      }
    };
  }

  function subscribeEvent(handler: (event: NekoEvent) => void): () => void {
    if (inner) {
      return inner.onEvent(handler);
    }
    const record = { handler, innerUnsubscribe: null as (() => void) | null };
    pendingEvents.set(handler, record);
    return () => {
      pendingEvents.delete(handler);
      if (record.innerUnsubscribe) {
        record.innerUnsubscribe();
      }
    };
  }

  return {
    _internal: {
      browserOwnerMode: () => "neko-owned",
      isAuthenticated: () => false,
      isClosed: () => false,
      isStarted: () => Boolean(inner),
      stealthMode: () => "assistive",
    },
    async ackFrame() {
      // No-op for n.eko polling, even through the resolver wrapper.
    },
    backend: "neko",
    browser_session_id: browser_session_id || "neko-session",
    async dispatch(event: UnknownRecord) {
      const companion = await ensureInner();
      await companion.dispatch(event);
    },
    getNekoProxyTarget() {
      if (!inner || typeof inner.getNekoProxyTarget !== "function") {
        return null;
      }
      return inner.getNekoProxyTarget();
    },
    onEvent(handler: (event: NekoEvent) => void) {
      return subscribeEvent(handler);
    },
    onFrame(handler: (frame: NekoFrame) => void) {
      return subscribeFrame(handler);
    },
    async queryNekoStatus() {
      const companion = await ensureInner();
      if (typeof companion.queryNekoStatus !== "function") {
        return null;
      }
      return companion.queryNekoStatus();
    },
    async start(viewport?: NekoViewport) {
      const companion = await ensureInner();
      await companion.start(viewport);
    },
    async stop() {
      if (inner) {
        await inner.stop();
      }
      pendingFrames.clear();
      pendingEvents.clear();
    },
  };
}

function factoryDefaults(options: NekoCompanionOptions): NekoCompanionOptions {
  const nekoDefaults =
    options.neko && typeof options.neko === "object" && !Array.isArray(options.neko) ? options.neko : {};
  return { ...options, ...nekoDefaults };
}

function factoryTargetResolver(
  options: NekoCompanionOptions,
  envTarget: ReturnType<typeof readEnv>
): ResolvedNekoCompanionOptions["resolveTargetForInteraction"] | null {
  if (typeof options.resolveTargetForInteraction === "function") {
    return options.resolveTargetForInteraction;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const origin = envTarget.origin;
  return origin ? () => ({ origin }) : null;
}

interface FactoryIdentifiers {
  interactionId: string;
  runId: string;
}

function factoryIdentifiers(run_id: unknown, interaction_id: unknown): FactoryIdentifiers | null {
  if (typeof run_id !== "string" || run_id.length === 0) {
    return null;
  }
  if (typeof interaction_id !== "string" || interaction_id.length === 0) {
    return null;
  }
  return { interactionId: interaction_id, runId: run_id };
}

function resolvedCompanionFactory(
  resolveTargetForInteraction: ResolvedNekoCompanionOptions["resolveTargetForInteraction"],
  defaults: NekoCompanionOptions
): (input?: { browser_session_id?: string; interaction_id?: unknown; run_id?: unknown }) => NekoCompanion | null {
  return ({ run_id, interaction_id, browser_session_id } = {}) => {
    const identifiers = factoryIdentifiers(run_id, interaction_id);
    if (!identifiers) {
      return null;
    }
    return createResolvedNekoCompanion({
      interaction_id: identifiers.interactionId,
      run_id: identifiers.runId,
      ...(browser_session_id ? { browser_session_id } : {}),
      defaults,
      resolveTargetForInteraction,
    });
  };
}

export function createDefaultStreamingCompanionFactory(
  options: NekoCompanionOptions = {}
): ReturnType<typeof resolvedCompanionFactory> | null {
  const envTarget = readEnv(options.env);
  const defaults = factoryDefaults(options);
  const resolveTargetForInteraction = factoryTargetResolver(options, envTarget);
  if (!resolveTargetForInteraction) {
    return null;
  }
  return resolvedCompanionFactory(resolveTargetForInteraction, defaults);
}

export const createDefaultNekoStreamingCompanionFactory = createDefaultStreamingCompanionFactory;
