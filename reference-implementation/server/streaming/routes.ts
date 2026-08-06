// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
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
 * Token-only clipboard:
 *   POST /_ref/run-interaction-streams/:token/clipboard
 *
 * Token-only n.eko viewer entry:
 *   GET  /_ref/run-interaction-streams/:token/neko
 *     sets a short-lived /neko cookie and redirects to the same-origin proxy
 *   GET  /_ref/run-interaction-streams/:token/neko/session
 *     sets the same cookie and returns direct n.eko client configuration
 *
 * The token is the only credential the viewer presents after mint. It is short
 * lived (default 5 min), reconnect-safe for repeated SSE attaches, scoped to
 * one (run, interaction, browser session), and invalidated when the interaction
 * resolves or the run ends. The token never authorizes record reads, consent
 * approval, grant issuance, or unrelated browser access.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { isNullish } from "../../lib/nullish.ts";
import { emitSpineEvent } from "../../lib/spine.ts";
import { createInputTelemetry } from "./input-telemetry.ts";
import type { ReferenceWireViewportPayload } from "./protocol-wire.ts";
import {
  buildReferenceWireAttachedPayload,
  buildReferenceWireBackendReadyPayload,
  buildReferenceWireCompanionEventPayload,
  buildReferenceWireFramePayload,
  normalizeReferenceWireViewportPayload,
  parseReferenceWireInputPayload,
  parseReferenceWireInputTelemetryCursor,
} from "./protocol-wire.ts";
import { registerRemoteTelemetrySink } from "./remote-telemetry-registry.ts";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

type RecordFields = Record<string, unknown>;
type CodedError = Error & { code?: string; param?: string | null; status?: number };
type Timer = ReturnType<typeof setTimeout>;
type RouteNext = (error?: unknown) => void;
type RouteHandler = (req: StreamingRequest, res: StreamingReply, next?: RouteNext) => unknown;

interface StreamingRequest {
  body?: unknown;
  headers: http.IncomingHttpHeaders;
  method?: string;
  params: Record<string, string | undefined>;
  query: Record<string, unknown>;
  raw: http.IncomingMessage;
  url?: string;
}

interface StreamingReply {
  header: (name: string, value: string) => StreamingReply;
  hijack: () => void;
  json: (body: unknown) => StreamingReply;
  raw: http.ServerResponse;
  redirect: (status: number, location: string) => StreamingReply;
  status: (status: number) => StreamingReply;
}

interface StreamingRouteApp {
  delete: (path: string, ...handlers: RouteHandler[]) => void;
  get: (path: string, ...handlers: RouteHandler[]) => void;
  options: (path: string, ...handlers: RouteHandler[]) => void;
  patch: (path: string, ...handlers: RouteHandler[]) => void;
  post: (path: string, ...handlers: RouteHandler[]) => void;
  put: (path: string, ...handlers: RouteHandler[]) => void;
}

interface PendingInteraction {
  interaction_id: string;
  kind?: string;
}

interface StreamingController {
  getPendingInteraction: (runId: string) => PendingInteraction | null;
}

interface OwnerAuth {
  requireOwnerSession: RouteHandler;
}

interface StreamingSession {
  browser_session_id: string;
  expires_at: number;
  interaction_id: string;
  run_id: string;
  viewport: ReferenceWireViewportPayload | null;
}

interface StreamingSessions {
  attach: (input: { token: string | undefined }) => StreamingSession;
  authorize: (input: { token: string | undefined }) => StreamingSession;
  invalidate: (input: { interaction_id: string; reason: string; run_id: string }) => StreamingSession | null;
  mint: (input: {
    browser_session_id: string;
    idempotency_key: string | null;
    interaction_id: string;
    run_id: string;
    viewport: ReferenceWireViewportPayload | null;
  }) => { idempotency_replayed: boolean; session: StreamingSession; token: string };
}

interface StreamFrame {
  data?: unknown;
  metadata?: unknown;
  sessionId?: unknown;
}

interface NekoProxyTarget {
  lease_id?: string;
  origin: string;
  surface_id?: string;
}

interface StreamingCompanion {
  ackFrame?: (sessionId: unknown) => Promise<void>;
  backend?: string;
  browserOwnerMode?: () => unknown;
  dispatch: (event: unknown) => Promise<void>;
  getNekoProxyTarget?: () => NekoProxyTarget | null;
  onEvent?: (handler: (event: unknown) => void) => () => void;
  onFrame: (handler: (frame: StreamFrame) => void) => () => void;
  queryNekoStatus?: () => Promise<unknown>;
  readRemoteSelection?: () => Promise<string>;
  resolveBackend?: () => Promise<string>;
  start: (viewport: ReferenceWireViewportPayload | null) => Promise<void>;
  stealthMode?: () => unknown;
  stop: () => Promise<void>;
}

interface CompanionFactoryInput {
  browser_session_id: string;
  interaction_id: string;
  run_id: string;
  target: BrowserSurfaceTarget | null;
}

type CompanionFactory = (input: CompanionFactoryInput) => StreamingCompanion | null;

interface RunEventsPage {
  data?: unknown;
  events?: unknown;
}

type ListRunEventsPage = (runId: string, page: { cursor: null; limit: number }) => Promise<RunEventsPage>;

interface BrowserSurfaceLease {
  connector_id: string;
  lease_id: string;
  profile_key: string;
  run_id: string;
  status: string;
  surface_id: string;
}

interface BrowserSurface {
  active_lease_id: string;
  cdp_url?: string;
  connector_id: string;
  health: string;
  profile_key: string;
  stream_base_url?: string;
  surface_id: string;
}

interface BrowserSurfaceLeaseManager {
  getSurface: (surfaceId: string) => BrowserSurface | null;
  listLeases: () => BrowserSurfaceLease[];
}

interface BrowserSurfaceTarget {
  backend: "neko";
  base_url: string;
  cdp_http_url?: string;
  interaction_id: string;
  lease_id: string;
  profile_key: string;
  surface_id: string;
  window_settle_endpoint: string;
}

interface PresentationLifecycle {
  browser_session_id: string;
  companion: StreamingCompanion;
  expires_at: number;
  expiryTimer: Timer | null;
  interaction_id: string;
  run_id: string;
  terminalization: Promise<void> | null;
}

type TimelineEmitter = (event: {
  actor_id: string;
  actor_type: string;
  data: unknown;
  event_type: string;
  interaction_id: string;
  object_id: string;
  object_type: string;
  run_id: string;
  status: string;
}) => Promise<unknown>;

interface WindowSettleProbeResponse {
  json: () => Promise<unknown>;
  ok: boolean;
}
type WindowSettleProbe = (endpoint: string) => Promise<WindowSettleProbeResponse>;
type PresentationFailureHandler = (input: {
  browser_session_id: string;
  error: unknown;
  interaction_id: string;
  lease_id: string | null;
  reason: string;
  run_id: string;
  surface_id: string | null;
}) => Promise<unknown>;
type StructuredLogger = { info: (record: RecordFields, message: string) => void } | null;

interface RegisterStreamingRoutesOptions {
  app: StreamingRouteApp;
  browserSurfaceLeaseManager?: BrowserSurfaceLeaseManager | null;
  clearTimeoutImpl?: (timer: Timer) => void;
  companionFactory: CompanionFactory | null;
  controller: StreamingController | null;
  emitTimelineEvent?: TimelineEmitter;
  /** Force-delete one exact connector-owned target at an interaction barrier. */
  forceUnregisterStreamingTarget?: ((runId: string, interactionId: string) => boolean | Promise<boolean>) | null;
  /**
   * Readiness-only hook for a non-n.eko target already registered by the
   * connector runtime. The route intentionally receives a boolean rather
   * than the CDP URL: raw page-target authority stays inside the companion
   * factory and registry.
   */
  hasDirectStreamingTargetForInteraction?:
    | ((runId: string, interactionId: string) => boolean | Promise<boolean>)
    | null;
  isNekoProxyTargetApproved?:
    | ((target: NekoProxyTarget, context: { origin: URL; session: StreamingSession }) => boolean)
    | null;
  listRunEventsPage?: ListRunEventsPage | null;
  logger?: StructuredLogger;
  makeBrowserSessionId?: (() => string) | null;
  makePresentationAttachmentId?: () => string;
  nekoProxyAllowedHosts?: string | string[];
  nekoProxyAutoLogin?: { password?: unknown; username?: unknown } | null;
  nekoProxyCookieName?: string;
  nekoProxyPath?: string;
  nekoWindowSettleProbe?: WindowSettleProbe | null;
  now?: () => number;
  onPresentationRestoreFailure?: PresentationFailureHandler | null;
  ownerAuth: OwnerAuth;
  presentationAttachmentCookieName?: string;
  setTimeoutImpl?: (handler: () => void, delayMs: number) => Timer;
  streamingSessions: StreamingSessions;
}

interface TransportObservationFields {
  backend?: string;
  error_code?: string;
  stage?: string;
  status_code?: number;
  target_protocol?: string;
  transport?: string;
}

function recordOrEmpty(value: unknown): RecordFields {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordFields) : {};
}

function codedError(value: unknown): CodedError | null {
  return value instanceof Error ? (value as CodedError) : null;
}

function errorCode(value: unknown, fallback: string): string {
  return codedError(value)?.code ?? fallback;
}

function errorMessage(value: unknown, fallback: string): string {
  const error = codedError(value);
  return error ? error.message : fallback;
}

const NEKO_PROXY_COOKIE = "pdpp_neko_stream";
const PRESENTATION_ATTACHMENT_COOKIE = "pdpp_stream_attachment";
const DEFAULT_NEKO_PROXY_PATH = "/neko/";
const NEKO_PROXY_MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
]);
const FIRST_TRANSPORT_EVENTS = new Set([
  "stream_backend_ready_emitted",
  "stream_neko_client_config_issued",
  "stream_neko_proxy_target_resolved",
  "stream_sse_attach_started",
]);
const MAX_TRANSPORT_OBSERVATION_KEYS_PER_SESSION = 12;
const OBSERVATION_BACKENDS = new Set(["cdp", "neko"]);
const OBSERVATION_STAGES = new Set([
  "neko_client_config",
  "neko_entry",
  "neko_proxy_http",
  "neko_proxy_websocket_upgrade",
  "neko_status",
]);
const OBSERVATION_TRANSPORTS = new Set(["http_proxy", "websocket_upgrade"]);
const OBSERVATION_TARGET_PROTOCOLS = new Set(["http", "https"]);
const OBSERVATION_ERROR_CODES = new Set([
  "companion_start_failed",
  "companion_unavailable",
  "invalid_neko_origin",
  "neko_origin_not_allowed",
  "neko_proxy_unavailable",
  "unknown",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
]);
const HTML_CONTENT_TYPE_PATTERN = /^text\/html\b/i;
const NEKO_BASE_ELEMENT_PATTERN = /<base\s/i;
const HTML_HEAD_ELEMENT_PATTERN = /<head(\s[^>]*)?>/i;
const PDPP_NEKO_EMBED_MARKER_PATTERN = /data-pdpp-neko-embed/;
const HTML_HEAD_END_PATTERN = /<\/head>/i;

function proxySessionErrorStatus(value: unknown): number {
  const code = codedError(value)?.code;
  if (code === "session_not_attached") {
    return 409;
  }
  if (code === "session_expired") {
    return 410;
  }
  return 401;
}

function streamAttachErrorStatus(value: unknown): number {
  return codedError(value)?.code === "session_consumed" ? 409 : proxySessionErrorStatus(value);
}

function upgradeStatusMessage(status: number): string {
  if (status === 410) {
    return "Gone";
  }
  if (status === 409) {
    return "Conflict";
  }
  return "Unauthorized";
}

interface NormalizedTransportObservation {
  errorCode: string;
  stage: string;
  targetProtocol: string;
  transport: string;
}

function normalizedObservationValue(value: string | undefined, allowedValues: Set<string>): string {
  return value !== undefined && allowedValues.has(value) ? value : "unknown";
}

function normalizeTransportObservation(fields: TransportObservationFields): NormalizedTransportObservation {
  return {
    errorCode: normalizedObservationValue(fields.error_code, OBSERVATION_ERROR_CODES),
    stage: normalizedObservationValue(fields.stage, OBSERVATION_STAGES),
    targetProtocol: normalizedObservationValue(fields.target_protocol, OBSERVATION_TARGET_PROTOCOLS),
    transport: normalizedObservationValue(fields.transport, OBSERVATION_TRANSPORTS),
  };
}

function isTransportFailureEvent(event: string): boolean {
  return event.endsWith("_failed") || event.endsWith("_unavailable") || event.endsWith("_rejected");
}

function shouldDeduplicateTransportEvent(event: string): boolean {
  return FIRST_TRANSPORT_EVENTS.has(event) || isTransportFailureEvent(event);
}

function reserveTransportObservationKey(
  observedKeys: Map<string, Set<string>>,
  browserSessionId: string,
  key: string
): boolean {
  const seen = observedKeys.get(browserSessionId) ?? new Set<string>();
  if (seen.has(key) || seen.size >= MAX_TRANSPORT_OBSERVATION_KEYS_PER_SESSION) {
    return false;
  }
  seen.add(key);
  observedKeys.set(browserSessionId, seen);
  return true;
}

function buildTransportObservationRecord(
  event: string,
  session: StreamingSession,
  fields: TransportObservationFields,
  normalized: NormalizedTransportObservation
): RecordFields {
  const record: RecordFields = {
    browser_session_id: session.browser_session_id,
    event,
    interaction_id: session.interaction_id,
    run_id: session.run_id,
  };
  if (event === "stream_backend_ready_emitted") {
    record.backend = normalizedObservationValue(fields.backend, OBSERVATION_BACKENDS);
  }
  if (event === "stream_neko_proxy_target_resolved") {
    record.stage = normalized.stage;
    record.target_protocol = normalized.targetProtocol;
  }
  if (isTransportFailureEvent(event)) {
    record.stage = normalized.stage;
    record.transport = normalized.transport;
    record.error_code = normalized.errorCode;
  }
  return record;
}

function pdppError(
  res: StreamingReply,
  status: number,
  code: string,
  message: string,
  param: string | null = null
): StreamingReply {
  const error: { code: string; message: string; param?: string; type: string } = {
    code,
    message,
    type: "invalid_request_error",
  };
  if (param) {
    error.param = param;
  }
  const body = { error };
  if (status === 401) {
    return res.status(status).header("WWW-Authenticate", 'Bearer realm="pdpp-stream"').json(body);
  }
  return res.status(status).json(body);
}

function parseAllowedHosts(value: unknown): Set<string> {
  let entries: unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (typeof value === "string") {
    entries = value.split(",");
  } else {
    entries = [];
  }
  return new Set(entries.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean));
}

function isLoopbackHost(hostname: unknown): boolean {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("127.");
}

function assertAllowedNekoOrigin(
  origin: string,
  allowedHosts: Set<string>,
  approvedOrigin: ((origin: URL) => boolean) | null
): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch (cause) {
    const err: CodedError = new Error("n.eko proxy target origin is invalid", { cause });
    err.code = "invalid_neko_origin";
    throw err;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const err: CodedError = new Error("n.eko proxy target must use http or https");
    err.code = "invalid_neko_origin";
    throw err;
  }
  const host = parsed.hostname.toLowerCase();
  const hostPort = `${host}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  if (typeof approvedOrigin === "function" && approvedOrigin(parsed) === true) {
    return parsed;
  }
  if (isLoopbackHost(host) || allowedHosts.has(host) || allowedHosts.has(hostPort)) {
    return parsed;
  }
  const err: CodedError = new Error("n.eko proxy target host is not allowlisted");
  err.code = "neko_origin_not_allowed";
  throw err;
}

function parseCookieHeader(header: string | string[] | undefined): Map<string, string> {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies.set(rawName, decodeURIComponent(rawValue.join("=") || ""));
  }
  return cookies;
}

function stripCookie(header: string | string[] | undefined, cookieNames: string | string[]): string {
  const names = new Set(Array.isArray(cookieNames) ? cookieNames : [cookieNames]);
  return String(header || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf("=");
      const name = separator === -1 ? part : part.slice(0, separator);
      return part && !names.has(name);
    })
    .join("; ");
}

function setNekoProxyCookie(res: StreamingReply, token: string, maxAgeSeconds: number, cookieName: string): void {
  const boundedMaxAge = Math.max(1, Math.min(600, Math.floor(maxAgeSeconds || 1)));
  res.header(
    "Set-Cookie",
    `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/neko; Max-Age=${boundedMaxAge}`
  );
}

function setPresentationAttachmentCookie(
  res: StreamingReply,
  attachmentId: string,
  maxAgeSeconds: number,
  cookieName: string
): void {
  const boundedMaxAge = Math.max(1, Math.min(600, Math.floor(maxAgeSeconds || 1)));
  const value = `${cookieName}=${encodeURIComponent(attachmentId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${boundedMaxAge}`;
  // SSE hijacks the Fastify reply before its normal header flush. Write to
  // the raw response so the controller cookie survives that handoff.
  if (res.raw && typeof res.raw.setHeader === "function") {
    res.raw.setHeader("Set-Cookie", value);
    return;
  }
  res.header("Set-Cookie", value);
}

function serializeProxyBody(req: StreamingRequest, headers: http.OutgoingHttpHeaders): Buffer | null {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return null;
  }
  const { body: requestBody } = req;
  if (requestBody === undefined || requestBody === null) {
    return null;
  }
  let body: Buffer;
  if (Buffer.isBuffer(requestBody)) {
    body = requestBody;
  } else if (typeof requestBody === "string") {
    body = Buffer.from(requestBody);
  } else {
    body = Buffer.from(JSON.stringify(requestBody));
  }
  headers["content-length"] = String(body.length);
  return body;
}

function buildProxyHeaders(
  sourceHeaders: http.IncomingHttpHeaders,
  targetUrl: URL,
  cookieNames: string | string[],
  { upgrade = false }: { upgrade?: boolean } = {}
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [rawName, value] of Object.entries(sourceHeaders || {})) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) {
      continue;
    }
    if (name === "authorization") {
      continue;
    }
    if (name === "host") {
      continue;
    }
    if (name === "content-length") {
      continue;
    }
    if (!upgrade && name === "upgrade") {
      continue;
    }
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (sourceHeaders?.cookie) {
    const cookie = stripCookie(sourceHeaders.cookie, cookieNames);
    if (cookie) {
      headers.cookie = cookie;
    }
  }
  headers.host = targetUrl.host;
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = sourceHeaders?.upgrade || "websocket";
  }
  return headers;
}

function writeUpgradeError(socket: import("node:net").Socket, status: number, message: string): void {
  if (socket.destroyed) {
    return;
  }
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function proxyUpgradeRequest(
  rawReq: http.IncomingMessage,
  socket: import("node:net").Socket,
  head: Buffer,
  targetUrl: URL,
  cookieNames: string | string[],
  observe: (event: string, fields: TransportObservationFields) => void = () => undefined
): void {
  const useTls = targetUrl.protocol === "https:";
  const port = Number(targetUrl.port || (useTls ? 443 : 80));
  const headers = buildProxyHeaders(rawReq.headers, targetUrl, cookieNames, { upgrade: true });
  const upstream = useTls
    ? tls.connect({ host: targetUrl.hostname, port, servername: targetUrl.hostname })
    : net.connect({ host: targetUrl.hostname, port });

  upstream.once("connect", () => {
    const path = `${targetUrl.pathname}${targetUrl.search}`;
    upstream.write(`${rawReq.method} ${path} HTTP/${rawReq.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(headers)) {
      upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write("\r\n");
    if (head?.length) {
      upstream.write(head);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.once("error", (err) => {
    observe("stream_neko_proxy_upstream_failed", {
      error_code: safeNetworkErrorCode(err),
      transport: "websocket_upgrade",
    });
    writeUpgradeError(socket, 502, "Bad Gateway");
  });
  socket.once("error", () => upstream.destroy());
}

function safeNetworkErrorCode(err: unknown): string {
  const code = codedError(err)?.code ?? null;
  return code && OBSERVATION_ERROR_CODES.has(code) ? code : "unknown";
}

function safeRunId(req: StreamingRequest): string {
  return decodeURIComponent(req.params.runId ?? "");
}

// Closed set of stream-reach give-up reasons. Mirrors the client classifier in
// `apps/console/.../stream/stream-reach-diagnostics.ts`. The package boundary
// (reference server cannot import from the console app) means this list is
// duplicated, not shared; the server is the authoritative clamp so a malformed
// or hostile client cannot widen the spine's reason vocabulary.
const STREAM_REACH_REASONS = new Set([
  "invalid_token",
  "session_consumed",
  "session_expired",
  "companion_unavailable",
  "unreachable_origin",
  "unknown",
]);

function sanitizeStreamReachReason(value: unknown): string {
  return typeof value === "string" && STREAM_REACH_REASONS.has(value) ? value : "unknown";
}

// HTTP status observed by the client's give-up probe. Kept as a small bounded
// integer or null; never an arbitrary client-supplied value in the spine.
function sanitizeStreamReachHttpStatus(value: unknown): number | null {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function pickViewport(input: unknown): ReferenceWireViewportPayload | null {
  return normalizeReferenceWireViewportPayload(input);
}

function normalizeViewportForNeko(viewport: ReferenceWireViewportPayload | null): ReferenceWireViewportPayload | null {
  if (!viewport) {
    return null;
  }
  // n.eko delivers pointer/touch input through the native browser window,
  // not through CDP Input.dispatch*. If we expose a high-DPR virtual screen
  // (screenWidth = width * dpr, deviceScaleFactor > 1), the video can look
  // sharp while native input lands in screen-pixel coordinates outside the
  // emulated CSS viewport. Keep n.eko in one coordinate space: CSS viewport,
  // X screen, WebRTC frame, and native input all use the same width/height.
  //
  // CRITICAL — mobile / hasTouch / userAgent emulation is intentionally
  // stripped for n.eko backends. Reasons:
  //   1. Stealth: Emulation.setUserAgentOverride lies the UA but does NOT
  //      lie about TLS fingerprint, Client Hints (sec-ch-ua-platform), GPU
  //      profile, or process model. Cloudflare detects the inconsistency
  //      instantly and re-challenges the user. See docs/reference/neko-stealth-design-brief.md.
  //   2. Input bouncing: when mobile=true + hasTouch=true, Chromium
  //      dispatches synthetic TouchEvents in parallel with the real mouse
  //      events that n.eko forwards from the user's tap. The dual-channel
  //      input causes focus/blur churn, which manifests as the soft
  //      keyboard opening and immediately closing on the user's phone.
  //
  // Mobile users still get a streamed video — they just see the desktop
  // rendering of the target site, which is what every real human-on-mobile
  // browser-as-a-service product (Browserbase, Browserless, Cloudflare's
  // Browser Rendering) does too.
  const { hasTouch: _hasTouch, mobile: _mobile, userAgent: _userAgent, ...sanitized } = viewport;
  return {
    ...sanitized,
    deviceScaleFactor: 1,
    screenHeight: viewport.height,
    screenWidth: viewport.width,
  };
}

function viewportForCompanionBackend(
  backend: string,
  viewport: ReferenceWireViewportPayload | null
): ReferenceWireViewportPayload | null {
  if (!viewport) {
    return viewport;
  }
  if (backend === "neko") {
    return normalizeViewportForNeko(viewport);
  }
  // CDP backend (reference container's Patchright-driven Chrome) is also
  // streamed via WebRTC to the user. The same stealth + input-bouncing
  // arguments from normalizeViewportForNeko apply here: emulating mobile
  // creates a UA/TLS/fingerprint inconsistency that bot-protection systems
  // (Cloudflare Turnstile, etc.) detect, AND it makes Chromium dispatch
  // synthetic TouchEvents alongside the mouse events the streaming layer
  // forwards from the user's tap, causing focus/blur churn and soft-keyboard
  // flicker. Strip the same fields for CDP as we do for neko.
  const { hasTouch: _hasTouch, mobile: _mobile, userAgent: _userAgent, ...sanitized } = viewport;
  return sanitized;
}

function viewportsMatch(a: ReferenceWireViewportPayload | null, b: ReferenceWireViewportPayload | null): boolean {
  if (a === b) {
    return true;
  }
  if (!(a && b)) {
    return a === b;
  }
  const keys: (keyof ReferenceWireViewportPayload)[] = [
    "width",
    "height",
    "screenWidth",
    "screenHeight",
    "deviceScaleFactor",
    "hasTouch",
    "mobile",
    "userAgent",
  ];
  return keys.every((key) => a[key] === b[key]);
}

function resolveCompanionBackend(companion: StreamingCompanion): Promise<string> {
  if (typeof companion.resolveBackend === "function") {
    return companion.resolveBackend();
  }
  return Promise.resolve(typeof companion.backend === "string" ? companion.backend : "cdp");
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
 * @param {Function} deps.listRunEventsPage    optional bounded run timeline reader for no-response assistance minting
 * @param {Function} deps.hasDirectStreamingTargetForInteraction readiness-only
 *                                                lookup for a registered Core CDP target
 * @param {object} deps.browserSurfaceLeaseManager optional active browser-surface lease manager
 * @param {string} deps.nekoProxyPath          same-origin n.eko proxy path
 * @param {string|string[]} deps.nekoProxyAllowedHosts non-loopback n.eko hosts allowed for proxying
 * @param {Function} deps.isNekoProxyTargetApproved dynamic n.eko proxy approval hook
 * @param {{ username: string, password: string }|null} deps.nekoProxyAutoLogin n.eko auto-login query params
 * @param {Function} deps.makePresentationAttachmentId optional controller-attachment id minter for tests
 * @param {Function|null} deps.onPresentationRestoreFailure terminal recovery hook for failed screen restore
 * @param {Function} deps.setTimeoutImpl optional presentation-expiry scheduler for tests
 * @param {Function} deps.clearTimeoutImpl optional presentation-expiry canceller for tests
 * @param {object|null} deps.logger structured server logger for non-authoritative stream observations
 */
export function registerStreamingRoutes({
  app,
  controller,
  ownerAuth,
  streamingSessions,
  companionFactory,
  makeBrowserSessionId,
  hasDirectStreamingTargetForInteraction = null,
  now = () => Date.now(),
  emitTimelineEvent = emitSpineEvent,
  listRunEventsPage = null,
  browserSurfaceLeaseManager = null,
  forceUnregisterStreamingTarget = null,
  nekoProxyPath = DEFAULT_NEKO_PROXY_PATH,
  nekoProxyAllowedHosts = [],
  isNekoProxyTargetApproved = null,
  nekoProxyCookieName = NEKO_PROXY_COOKIE,
  nekoProxyAutoLogin = null,
  nekoWindowSettleProbe = null,
  presentationAttachmentCookieName = PRESENTATION_ATTACHMENT_COOKIE,
  makePresentationAttachmentId = () => randomBytes(18).toString("base64url"),
  onPresentationRestoreFailure = null,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = null,
}: RegisterStreamingRoutesOptions): {
  _internal: {
    companions: Map<string, StreamingCompanion>;
    getCompanion: (input: {
      browserSessionId: string;
      interactionId: string;
      runId: string;
    }) => StreamingCompanion | null;
    handleNekoUpgrade: (rawReq: http.IncomingMessage, socket: import("node:net").Socket, head: Buffer) => boolean;
  };
  handleUpgrade: (rawReq: http.IncomingMessage, socket: import("node:net").Socket, head: Buffer) => boolean;
  invalidateForInteractionResolved: (input: {
    interaction_id: string;
    reason: string;
    run_id: string;
  }) => Promise<void>;
  restoreOrRetirePresentationForRun: (input: { reason: string; run_id: string }) => Promise<void>;
} {
  if (!(app && ownerAuth && streamingSessions)) {
    throw new Error("registerStreamingRoutes: missing dependency");
  }
  if (!isNullish(companionFactory) && typeof companionFactory !== "function") {
    throw new Error("registerStreamingRoutes: companionFactory must be a function or null");
  }
  if (
    !isNullish(hasDirectStreamingTargetForInteraction) &&
    typeof hasDirectStreamingTargetForInteraction !== "function"
  ) {
    throw new Error("registerStreamingRoutes: hasDirectStreamingTargetForInteraction must be a function or null");
  }
  if (!isNullish(forceUnregisterStreamingTarget) && typeof forceUnregisterStreamingTarget !== "function") {
    throw new Error("registerStreamingRoutes: forceUnregisterStreamingTarget must be a function or null");
  }
  if (typeof makePresentationAttachmentId !== "function") {
    throw new Error("registerStreamingRoutes: makePresentationAttachmentId must be a function");
  }
  if (nekoWindowSettleProbe !== null && typeof nekoWindowSettleProbe !== "function") {
    throw new Error("registerStreamingRoutes: nekoWindowSettleProbe must be a function or null");
  }

  // Companion instances are fenced by the complete streaming identity. A
  // browser_session_id is an opaque viewer label and may be reused by a test,
  // reconnect, or a later run; it is never sufficient authority to select a
  // page-target companion.
  const companions = new Map<string, StreamingCompanion>();
  // The browser-session token is deliberately reconnect-safe, so it is not
  // enough to identify the controlling presentation. The first SSE attach
  // mints an HttpOnly same-origin attachment id. A reconnect with that cookie
  // remains the controller; every other attachment is observational.
  const controllingAttachments = new Map<string, string>();
  // Bearer records expire by design. A presentation lifecycle cannot: it owns
  // a mutated shared screen until restoration or safe retirement completes.
  const presentationLifecycles = new Map<string, PresentationLifecycle>();
  // Serialize controller viewport requests before they reach a companion. The
  // n.eko companion also fences screen mutations, but this host-level queue
  // preserves request order across every streaming backend and reconnect.
  const presentationViewportDispatches = new Map<string, Promise<void>>();
  // Per-session input telemetry ring. Records four event kinds:
  //   wire.input.received / wire.input.dispatched / wire.input.error /
  //   remote.page.<eventType>. Polled by the viewer via
  //   GET /_ref/run-interaction-streams/:token/input-telemetry?since=<seq>
  // and merged into the same /api/stream-debug sink as phone-side events,
  // joined on `correlationId`. Debug-only, never affects streaming UX.
  const inputTelemetry = createInputTelemetry();
  // Companions can register a per-session remote-page event sink by calling
  // companion.attachRemoteTelemetry(fn). The factory (cdp-adapter / playground
  // remote-cdp factory) wires Patchright `exposeBinding` to forward in-page
  // `__pdppRemoteTelemetry(payload)` calls here. The forwarding path is
  // best-effort and never throws back into the page.
  const remoteTelemetrySinks = new Map<string, () => void>(); // run/interaction/browser session → unsubscribe fn
  const allowedNekoHosts = parseAllowedHosts(nekoProxyAllowedHosts);
  const observedTransportKeys = new Map<string, Set<string>>();

  function streamingIdentityKey({
    browserSessionId,
    interactionId,
    runId,
  }: {
    browserSessionId: string;
    interactionId: string;
    runId: string;
  }): string {
    return `${runId}\0${interactionId}\0${browserSessionId}`;
  }

  function sessionIdentityKey(session: StreamingSession): string {
    return streamingIdentityKey({
      browserSessionId: session.browser_session_id,
      interactionId: session.interaction_id,
      runId: session.run_id,
    });
  }

  function pushInputTelemetry(sessionKey: string, record: RecordFields): void {
    try {
      inputTelemetry.push(sessionKey, record);
    } catch {
      /* telemetry must never affect streaming */
    }
  }

  function clearBrowserSessionDiagnostics(session: {
    browser_session_id: string;
    interaction_id: string;
    run_id: string;
  }): void {
    const sessionKey = streamingIdentityKey({
      browserSessionId: session.browser_session_id,
      interactionId: session.interaction_id,
      runId: session.run_id,
    });
    observedTransportKeys.delete(sessionKey);
    controllingAttachments.delete(sessionKey);
    presentationViewportDispatches.delete(sessionKey);
    const unsubscribe = remoteTelemetrySinks.get(sessionKey);
    remoteTelemetrySinks.delete(sessionKey);
    try {
      unsubscribe?.();
    } catch {
      /* best-effort */
    }
    try {
      inputTelemetry.drop(sessionKey);
    } catch {
      /* best-effort */
    }
  }
  // Diagnostic-only transport observations. They never affect auth,
  // readiness, proxying, or retries. Omit target hosts, URLs, cookies, and tokens.
  function observeStreamTransport(
    event: string,
    session: StreamingSession | null,
    fields: TransportObservationFields = {}
  ): void {
    if (!logger || typeof logger.info !== "function" || !session) {
      return;
    }
    const normalized = normalizeTransportObservation(fields);
    const key = `${event}\0${normalized.stage}\0${normalized.transport}\0${normalized.errorCode}`;
    if (
      shouldDeduplicateTransportEvent(event) &&
      !reserveTransportObservationKey(observedTransportKeys, sessionIdentityKey(session), key)
    ) {
      return;
    }
    try {
      logger.info(buildTransportObservationRecord(event, session, fields, normalized), "stream transport observation");
    } catch {
      /* Observability must not affect streaming. */
    }
  }
  const nekoAutoLogin =
    nekoProxyAutoLogin &&
    typeof nekoProxyAutoLogin === "object" &&
    String(nekoProxyAutoLogin.username || "").trim() &&
    String(nekoProxyAutoLogin.password || "").trim()
      ? {
          password: String(nekoProxyAutoLogin.password).trim(),
          username: String(nekoProxyAutoLogin.username).trim(),
        }
      : null;

  function getCompanion({
    browserSessionId,
    interactionId,
    runId,
  }: {
    browserSessionId: string;
    interactionId: string;
    runId: string;
  }): StreamingCompanion | null {
    return companions.get(streamingIdentityKey({ browserSessionId, interactionId, runId })) || null;
  }

  function registerRemoteInputTelemetry(browserSessionId: string, interactionId: string, runId: string): void {
    const sessionKey = streamingIdentityKey({ browserSessionId, interactionId, runId });
    try {
      const unsubscribe = registerRemoteTelemetrySink(runId, (payload) => {
        const remotePayload = recordOrEmpty(payload);
        if (Object.keys(remotePayload).length === 0) {
          return;
        }
        pushInputTelemetry(sessionKey, {
          kind: typeof remotePayload.type === "string" ? `remote.page.${remotePayload.type}` : "remote.page.unknown",
          source: "remote_page",
          ...remotePayload,
        });
      });
      remoteTelemetrySinks.set(sessionKey, unsubscribe);
    } catch {
      /* sink registration is best-effort */
    }
  }

  function getOrCreateCompanion(
    factory: CompanionFactory,
    {
      browserSessionId,
      interactionId,
      runId,
      target,
    }: {
      browserSessionId: string;
      interactionId: string;
      runId: string;
      target: BrowserSurfaceTarget | null;
    }
  ): StreamingCompanion | null {
    const sessionKey = streamingIdentityKey({ browserSessionId, interactionId, runId });
    const existing = companions.get(sessionKey);
    if (existing) {
      return existing;
    }
    const companion = factory({
      browser_session_id: browserSessionId,
      interaction_id: interactionId,
      run_id: runId,
      target,
    });
    if (companion) {
      companions.set(sessionKey, companion);
    }
    registerRemoteInputTelemetry(browserSessionId, interactionId, runId);
    return companion;
  }

  async function mintStreamSession({
    body,
    companionFactory: factory,
    interactionId,
    mintScope,
    runId,
  }: {
    body: RecordFields;
    companionFactory: CompanionFactory;
    interactionId: string;
    mintScope: { kind: string; target: BrowserSurfaceTarget | null };
    runId: string;
  }): Promise<RecordFields> {
    const viewport = pickViewport(body.viewport);
    // Stripe-style optional idempotency key. Lets the dashboard collapse a
    // duplicate mint into the same session record so the prior token is not
    // superseded out from under an in-flight viewer.
    const idempotencyKey =
      typeof body.idempotency_key === "string" && body.idempotency_key.length > 0 ? body.idempotency_key : null;
    const browserSessionId =
      (typeof makeBrowserSessionId === "function" ? makeBrowserSessionId() : null) ||
      `bs_${Math.floor(now()).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const {
      token,
      session,
      idempotency_replayed: idempotencyReplayed,
    } = streamingSessions.mint({
      browser_session_id: browserSessionId,
      idempotency_key: idempotencyKey,
      interaction_id: interactionId,
      run_id: runId,
      viewport,
    });

    const priorLifecycle = presentationLifecycleFor(runId, interactionId);
    if (priorLifecycle && priorLifecycle.browser_session_id !== session.browser_session_id) {
      await terminalizePresentation(priorLifecycle, {
        // The direct-CDP target is owned by the active interaction, not by
        // this bearer/session. Keep it available for the replacement viewer;
        // the replacement mint has already fenced the old bearer above.
        cleanupTarget: () => Promise.resolve(),
        invalidateBearer: false,
        reason: "stream_session_superseded",
      });
    }

    // A replay must reuse the companion bound to the original session.
    const effectiveBrowserSessionId = session.browser_session_id;
    const companion = getOrCreateCompanion(factory, {
      browserSessionId: effectiveBrowserSessionId,
      interactionId,
      runId,
      target: mintScope.target,
    });
    if (!presentationLifecycleFor(runId, interactionId) && companion) {
      rememberPresentationLifecycle(session, companion);
    }

    if (!idempotencyReplayed) {
      await emit("run.stream_session_requested", {
        data: {
          browser_session_id: effectiveBrowserSessionId,
          expires_at_ms: session.expires_at,
          kind: mintScope.kind,
          viewport,
        },
        interaction_id: interactionId,
        run_id: runId,
        status: "started",
      });
    }

    return {
      browser_session_id: effectiveBrowserSessionId,
      clipboard_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/clipboard`,
      expires_at_ms: session.expires_at,
      idempotency_replayed: idempotencyReplayed === true,
      input_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/input`,
      interaction_id: interactionId,
      object: "run_interaction_stream_session",
      run_id: runId,
      token,
      viewer_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/events`,
      viewport_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/viewport`,
    };
  }

  function authorizeStreamAttachment(
    req: StreamingRequest,
    res: StreamingReply
  ): { companion: StreamingCompanion; controllingAttachment: boolean; session: StreamingSession } | null {
    let session: StreamingSession;
    try {
      session = streamingSessions.attach({ token: req.params.token });
    } catch (err) {
      const status = streamAttachErrorStatus(err);
      pdppError(res, status, errorCode(err, "invalid_token"), errorMessage(err, "invalid token"));
      return null;
    }
    const companion = getCompanion({
      browserSessionId: session.browser_session_id,
      interactionId: session.interaction_id,
      runId: session.run_id,
    });
    if (!companion) {
      pdppError(res, 410, "companion_unavailable", "Streaming companion is no longer attached");
      return null;
    }
    observeStreamTransport("stream_sse_attach_started", session);
    try {
      return {
        companion,
        controllingAttachment: attachPresentationController(session, req, res),
        session,
      };
    } catch (err) {
      pdppError(res, 500, errorCode(err, "api_error"), errorMessage(err, "stream attachment setup failed"));
      return null;
    }
  }

  function authorizeControllingCompanion(
    req: StreamingRequest,
    res: StreamingReply
  ): { companion: StreamingCompanion; session: StreamingSession } | null {
    let session: StreamingSession;
    try {
      session = streamingSessions.authorize({ token: req.params.token });
    } catch (err) {
      const status = errorCode(err, "") === "session_not_attached" ? 409 : 401;
      pdppError(res, status, errorCode(err, "invalid_token"), errorMessage(err, "invalid token"));
      return null;
    }
    if (!isControllingPresentationAttachment(session, req)) {
      pdppError(
        res,
        409,
        "presentation_attachment_not_controlling",
        "Only the controlling stream attachment may send presentation input"
      );
      return null;
    }
    const companion = getCompanion({
      browserSessionId: session.browser_session_id,
      interactionId: session.interaction_id,
      runId: session.run_id,
    });
    if (!companion) {
      pdppError(res, 410, "companion_unavailable", "Streaming companion is no longer attached");
      return null;
    }
    return { companion, session };
  }

  function presentationKey(run_id: string, interaction_id: string): string {
    return `${run_id}\0${interaction_id}`;
  }

  function presentationLifecycleFor(run_id: string, interaction_id: string): PresentationLifecycle | null {
    return presentationLifecycles.get(presentationKey(run_id, interaction_id)) || null;
  }

  function clearPresentationExpiry(lifecycle: PresentationLifecycle): void {
    if (lifecycle.expiryTimer === null) {
      return;
    }
    clearTimeoutImpl(lifecycle.expiryTimer);
    lifecycle.expiryTimer = null;
  }

  function schedulePresentationExpiry(lifecycle: PresentationLifecycle): void {
    const delayMs = Math.max(0, lifecycle.expires_at - now());
    lifecycle.expiryTimer = setTimeoutImpl(async () => {
      try {
        await invalidateForInteractionResolved({
          interaction_id: lifecycle.interaction_id,
          reason: "stream_session_expired",
          run_id: lifecycle.run_id,
        });
      } catch {
        // A failed restore invokes terminal recovery. The bearer record is
        // already expired, so there is no safe retry through token auth.
      }
    }, delayMs);
    lifecycle.expiryTimer?.unref?.();
  }

  function rememberPresentationLifecycle(
    session: StreamingSession,
    companion: StreamingCompanion
  ): PresentationLifecycle {
    const lifecycle: PresentationLifecycle = {
      browser_session_id: session.browser_session_id,
      companion,
      expires_at: session.expires_at,
      expiryTimer: null,
      interaction_id: session.interaction_id,
      run_id: session.run_id,
      terminalization: null,
    };
    presentationLifecycles.set(presentationKey(lifecycle.run_id, lifecycle.interaction_id), lifecycle);
    schedulePresentationExpiry(lifecycle);
    return lifecycle;
  }

  async function dispatchPresentationViewport(
    session: StreamingSession,
    companion: StreamingCompanion,
    viewport: ReferenceWireViewportPayload
  ): Promise<void> {
    const sessionKey = sessionIdentityKey(session);
    const prior = presentationViewportDispatches.get(sessionKey) || Promise.resolve();
    const dispatched = prior.catch(() => undefined).then(() => companion.dispatch({ type: "viewport", ...viewport }));
    presentationViewportDispatches.set(sessionKey, dispatched);
    try {
      await dispatched;
    } finally {
      if (presentationViewportDispatches.get(sessionKey) === dispatched) {
        presentationViewportDispatches.delete(sessionKey);
      }
    }
  }

  async function destroyCompanion(
    session: {
      browser_session_id: string;
      interaction_id: string;
      run_id: string;
    },
    {
      fallbackCompanion = null,
      propagateStopFailure = false,
    }: { fallbackCompanion?: StreamingCompanion | null; propagateStopFailure?: boolean } = {}
  ): Promise<void> {
    const sessionKey = streamingIdentityKey({
      browserSessionId: session.browser_session_id,
      interactionId: session.interaction_id,
      runId: session.run_id,
    });
    const companion = companions.get(sessionKey) || fallbackCompanion;
    clearBrowserSessionDiagnostics(session);
    if (!companion) {
      return;
    }
    companions.delete(sessionKey);
    try {
      await companion.stop();
    } catch (err) {
      if (propagateStopFailure) {
        throw err;
      }
      // Best-effort teardown: companion errors must not bubble out of cleanup.
    }
  }

  function attachmentIdFrom(req: StreamingRequest, session: StreamingSession): string | null {
    return parseCookieHeader(req.headers?.cookie).get(presentationAttachmentCookieNameFor(session)) || null;
  }

  function presentationAttachmentCookieNameFor(session: StreamingSession): string {
    const sessionId = String(session.browser_session_id || "");
    const scope = createHash("sha256").update(sessionId).digest("base64url");
    return `${presentationAttachmentCookieName}_${scope}`;
  }

  function attachPresentationController(
    session: StreamingSession,
    req: StreamingRequest,
    res: StreamingReply
  ): boolean {
    const sessionKey = sessionIdentityKey(session);
    const existing = controllingAttachments.get(sessionKey);
    const presented = attachmentIdFrom(req, session);
    if (existing) {
      return existing === presented;
    }
    const attachmentId = makePresentationAttachmentId();
    if (typeof attachmentId !== "string" || attachmentId.length === 0) {
      throw new Error("presentation attachment id minter returned an invalid id");
    }
    controllingAttachments.set(sessionKey, attachmentId);
    setPresentationAttachmentCookie(
      res,
      attachmentId,
      (session.expires_at - now()) / 1000,
      presentationAttachmentCookieNameFor(session)
    );
    return true;
  }

  function isControllingPresentationAttachment(session: StreamingSession, req: StreamingRequest): boolean {
    const controllerAttachment = controllingAttachments.get(sessionIdentityKey(session));
    return Boolean(controllerAttachment && controllerAttachment === attachmentIdFrom(req, session));
  }

  async function terminalizePresentation(
    lifecycle: PresentationLifecycle,
    {
      invalidateBearer,
      cleanupTarget = () => forceUnregisterStreamingTargetForInteraction(lifecycle.run_id, lifecycle.interaction_id),
      reason,
    }: { cleanupTarget?: () => Promise<void>; invalidateBearer: boolean; reason?: string }
  ): Promise<void> {
    if (lifecycle.terminalization) {
      return await lifecycle.terminalization;
    }

    const terminalReason = reason || "interaction_resolved";
    clearPresentationExpiry(lifecycle);
    if (invalidateBearer) {
      streamingSessions.invalidate({
        interaction_id: lifecycle.interaction_id,
        reason: terminalReason,
        run_id: lifecycle.run_id,
      });
    }
    const presentationTarget = lifecycle.companion.getNekoProxyTarget?.() || null;
    const terminalization = (async () => {
      try {
        await destroyCompanion(lifecycle, {
          fallbackCompanion: lifecycle.companion,
          propagateStopFailure: true,
        });
        await emit("run.stream_session_resolved", {
          data: { browser_session_id: lifecycle.browser_session_id, reason: terminalReason },
          interaction_id: lifecycle.interaction_id,
          run_id: lifecycle.run_id,
          status: "completed",
        });
      } catch (err) {
        try {
          if (typeof onPresentationRestoreFailure === "function") {
            await onPresentationRestoreFailure({
              browser_session_id: lifecycle.browser_session_id,
              error: err,
              interaction_id: lifecycle.interaction_id,
              lease_id: presentationTarget?.lease_id || null,
              reason: terminalReason,
              run_id: lifecycle.run_id,
              surface_id: presentationTarget?.surface_id || null,
            });
          }
        } finally {
          await emit("run.stream_session_resolved", {
            data: {
              browser_session_id: lifecycle.browser_session_id,
              reason: terminalReason,
              restore_failed: true,
            },
            interaction_id: lifecycle.interaction_id,
            run_id: lifecycle.run_id,
            status: "surface_failed",
          });
        }
        const restoreError: CodedError = new Error(
          "Presentation screen restore failed; the interaction was not resumed"
        );
        restoreError.code = "presentation_restore_failed";
        restoreError.cause = err;
        throw restoreError;
      } finally {
        await cleanupTarget();
      }
    })();
    lifecycle.terminalization = terminalization;
    try {
      return await terminalization;
    } finally {
      const key = presentationKey(lifecycle.run_id, lifecycle.interaction_id);
      if (presentationLifecycles.get(key) === lifecycle) {
        presentationLifecycles.delete(key);
      }
    }
  }

  async function invalidateForInteractionResolved({
    run_id,
    interaction_id,
    reason,
  }: {
    interaction_id: string;
    reason: string;
    run_id: string;
  }): Promise<void> {
    const lifecycle = presentationLifecycleFor(run_id, interaction_id);
    if (!lifecycle) {
      const invalidated = streamingSessions.invalidate({
        interaction_id,
        reason: reason || "interaction_resolved",
        run_id,
      });
      if (invalidated?.browser_session_id) {
        clearBrowserSessionDiagnostics(invalidated);
      }
      await forceUnregisterStreamingTargetForInteraction(run_id, interaction_id);
      return;
    }
    await terminalizePresentation(lifecycle, { invalidateBearer: true, reason });
  }

  async function restoreOrRetirePresentationForRun({
    run_id,
    reason,
  }: {
    reason: string;
    run_id: string;
  }): Promise<void> {
    const lifecycles = [...presentationLifecycles.values()].filter((candidate) => candidate.run_id === run_id);
    await Promise.all(
      lifecycles.map((lifecycle) =>
        terminalizePresentation(lifecycle, { invalidateBearer: true, reason: reason || "run_cleanup" })
      )
    );
  }

  async function emit(
    event_type: string,
    payload: { data?: unknown; interaction_id: string; run_id: string; status?: string }
  ): Promise<void> {
    try {
      await emitTimelineEvent({
        actor_id: "run-interaction-stream",
        actor_type: "reference",
        data: payload.data || {},
        event_type,
        interaction_id: payload.interaction_id,
        object_id: payload.run_id,
        object_type: "run",
        run_id: payload.run_id,
        status: payload.status || "started",
      });
    } catch {
      // Spine emit best-effort: refusing to mint over a logging error would
      // give worse UX than a missing diagnostic event.
    }
  }

  function mintError(status: number, code: string, message: string, param: string | null = null): CodedError {
    const err: CodedError = new Error(message);
    err.status = status;
    err.code = code;
    err.param = param;
    return err;
  }

  function eventData(event: RecordFields): RecordFields {
    return recordOrEmpty(event.data);
  }

  function eventAssistanceId(event: RecordFields): string | null {
    const data = eventData(event);
    if (typeof data.assistance_request_id === "string" && data.assistance_request_id.length > 0) {
      return data.assistance_request_id;
    }
    if (typeof event.interaction_id === "string" && event.interaction_id.length > 0) {
      return event.interaction_id;
    }
    return null;
  }

  function hasBrowserSurfaceAttachment(data: RecordFields): boolean {
    return (
      Array.isArray(data.attachments) &&
      data.attachments.some((attachment) => recordOrEmpty(attachment).kind === "browser_surface")
    );
  }

  function isTerminalAssistanceEvent(event: RecordFields): boolean {
    return (
      event.event_type === "run.assistance_cancelled" ||
      event.event_type === "run.assistance_escalated" ||
      event.event_type === "run.assistance_resolved" ||
      event.event_type === "run.assistance_timed_out"
    );
  }

  function isNoResponseBrowserAssistanceData(data: RecordFields): boolean {
    return (
      data.progress_posture === "blocked" &&
      data.owner_action === "operate_attachment" &&
      data.response_contract === "none" &&
      hasBrowserSurfaceAttachment(data)
    );
  }

  function collectTerminalAssistanceIds(events: RecordFields[]): Set<string> {
    const terminalIds = new Set<string>();
    for (const event of events) {
      if (isTerminalAssistanceEvent(event)) {
        const id = eventAssistanceId(event);
        if (id) {
          terminalIds.add(id);
        }
      }
    }
    return terminalIds;
  }

  function noResponseBrowserAssistanceIdOf(event: RecordFields, terminalIds: Set<string>): string | null {
    if (event.event_type !== "run.assistance_requested") {
      return null;
    }
    const id = eventAssistanceId(event);
    if (!id || terminalIds.has(id)) {
      return null;
    }
    return isNoResponseBrowserAssistanceData(eventData(event)) ? id : null;
  }

  function currentNoResponseBrowserAssistanceId(events: RecordFields[]): string | null {
    const terminalIds = collectTerminalAssistanceIds(events);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const id = noResponseBrowserAssistanceIdOf(events[index] ?? {}, terminalIds);
      if (id) {
        return id;
      }
    }
    return null;
  }

  async function isCurrentNoResponseBrowserAssistance(runId: string, assistanceId: string): Promise<boolean> {
    if (typeof listRunEventsPage !== "function") {
      return false;
    }
    const page = await listRunEventsPage(runId, { cursor: null, limit: 5000 });
    let rawEvents: unknown[] = [];
    if (Array.isArray(page.events)) {
      rawEvents = page.events;
    } else if (Array.isArray(page.data)) {
      rawEvents = page.data;
    }
    const events = rawEvents.map(recordOrEmpty);
    return currentNoResponseBrowserAssistanceId(events) === assistanceId;
  }

  async function assertManagedSurfaceWindowSettleBehavior(surface: BrowserSurface): Promise<string> {
    if (typeof surface.cdp_url !== "string" || surface.cdp_url.length === 0) {
      throw mintError(
        503,
        "managed_surface_window_settle_unavailable",
        "The managed browser surface cannot prove its window-settle readiness."
      );
    }
    if (!nekoWindowSettleProbe) {
      throw mintError(
        503,
        "managed_surface_window_settle_unavailable",
        "The managed browser surface cannot prove its window-settle readiness."
      );
    }
    let settleEndpoint: string;
    try {
      settleEndpoint = new URL("/pdpp/window-settle", surface.cdp_url).toString();
    } catch (cause) {
      const error = mintError(
        503,
        "managed_surface_window_settle_unavailable",
        "The managed browser surface cannot prove its window-settle readiness."
      );
      error.cause = cause;
      throw error;
    }
    try {
      const response = await nekoWindowSettleProbe(settleEndpoint);
      if (!response?.ok) {
        throw new Error("window settle endpoint was not successful");
      }
      const status = recordOrEmpty(await response.json());
      const { height, width } = status;
      if (
        status.settled !== true ||
        typeof width !== "number" ||
        !Number.isInteger(width) ||
        width < 1 ||
        typeof height !== "number" ||
        !Number.isInteger(height) ||
        height < 1
      ) {
        throw new Error("window settle endpoint returned an invalid status");
      }
    } catch (cause) {
      const error = mintError(
        503,
        "managed_surface_window_settle_unavailable",
        "The managed browser surface is restarting. Please retry this action."
      );
      error.cause = cause;
      throw error;
    }
    return settleEndpoint;
  }

  async function buildBrowserSurfaceAssistanceTarget(
    runId: string,
    assistanceId: string
  ): Promise<BrowserSurfaceTarget | null> {
    if (!browserSurfaceLeaseManager || typeof browserSurfaceLeaseManager.listLeases !== "function") {
      return null;
    }
    const lease = browserSurfaceLeaseManager
      .listLeases()
      .find((candidate) => candidate?.run_id === runId && candidate.status === "leased");
    if (!lease?.surface_id || typeof browserSurfaceLeaseManager.getSurface !== "function") {
      return null;
    }
    const surface = browserSurfaceLeaseManager.getSurface(lease.surface_id);
    if (surface?.health !== "ready") {
      return null;
    }
    if (surface.surface_id !== lease.surface_id) {
      return null;
    }
    if (surface.connector_id !== lease.connector_id) {
      return null;
    }
    if (surface.active_lease_id !== lease.lease_id) {
      return null;
    }
    if (surface.profile_key !== lease.profile_key) {
      return null;
    }
    if (!surface.stream_base_url) {
      return null;
    }
    // The surface's persisted endpoint is diagnostic/legacy lifecycle data;
    // the live, no-query behavior probe above is the only attachment gate.
    // Keep passing the endpoint required by the presentation lifecycle, but
    // derive it from the same origin we just proved rather than metadata.
    const windowSettleEndpoint = await assertManagedSurfaceWindowSettleBehavior(surface);
    return {
      backend: "neko",
      base_url: surface.stream_base_url,
      ...(surface.cdp_url ? { cdp_http_url: surface.cdp_url } : {}),
      interaction_id: assistanceId,
      lease_id: lease.lease_id,
      profile_key: lease.profile_key,
      surface_id: surface.surface_id,
      window_settle_endpoint: windowSettleEndpoint,
    };
  }

  async function directStreamingTargetReady(runId: string, interactionId: string): Promise<boolean> {
    if (typeof hasDirectStreamingTargetForInteraction !== "function") {
      return false;
    }
    return await hasDirectStreamingTargetForInteraction(runId, interactionId);
  }

  async function forceUnregisterStreamingTargetForInteraction(runId: string, interactionId: string): Promise<void> {
    if (typeof forceUnregisterStreamingTarget !== "function") {
      return;
    }
    try {
      await forceUnregisterStreamingTarget(runId, interactionId);
    } catch {
      // Run-final registry purge remains authoritative if this best-effort
      // interaction barrier races a controller shutdown.
    }
  }

  async function resolvePendingMintScope(
    runId: string,
    interactionId: string,
    pending: PendingInteraction
  ): Promise<{ kind: string; target: BrowserSurfaceTarget | null }> {
    if (pending.interaction_id !== interactionId) {
      throw mintError(
        409,
        "interaction_id_mismatch",
        `Pending interaction is ${pending.interaction_id}, not ${interactionId}`,
        "interaction_id"
      );
    }
    const pendingKind = pending.kind;
    if (pendingKind !== "manual_action" && pendingKind !== "otp") {
      throw mintError(
        409,
        "stream_not_supported_for_kind",
        `Streaming is not supported for interaction kind ${pendingKind ?? "unknown"}`
      );
    }
    const target = await buildBrowserSurfaceAssistanceTarget(runId, interactionId);
    if (!target && typeof hasDirectStreamingTargetForInteraction === "function") {
      const ready = await directStreamingTargetReady(runId, interactionId);
      if (!ready) {
        throw mintError(
          503,
          "streaming_companion_unavailable",
          "A browser-control interaction is current, but no ready browser surface is registered for this run."
        );
      }
    }
    return { kind: pendingKind, target };
  }

  async function resolveNoResponseMintScope(
    runId: string,
    interactionId: string
  ): Promise<{ kind: string; target: BrowserSurfaceTarget | null }> {
    const target = await buildBrowserSurfaceAssistanceTarget(runId, interactionId);
    if (target || (await directStreamingTargetReady(runId, interactionId))) {
      return { kind: "manual_action", target };
    }
    throw mintError(
      503,
      "streaming_companion_unavailable",
      "A browser-surface assistance request is current, but no ready browser surface is registered for this run."
    );
  }

  async function resolveMintScope(
    runId: string,
    interactionId: string
  ): Promise<{ kind: string; target: BrowserSurfaceTarget | null }> {
    if (!controller) {
      throw mintError(404, "not_found", "Controller is not configured on this server");
    }
    const pending = controller.getPendingInteraction(runId);
    if (pending) {
      return await resolvePendingMintScope(runId, interactionId, pending);
    }
    if (await isCurrentNoResponseBrowserAssistance(runId, interactionId)) {
      return await resolveNoResponseMintScope(runId, interactionId);
    }
    throw mintError(409, "no_pending_interaction", "No pending interaction for this run");
  }

  function getNekoProxySession(
    token: string | undefined,
    stage = "neko_proxy"
  ): { companion: StreamingCompanion; origin: URL; session: StreamingSession } {
    const session = streamingSessions.authorize({ token });
    const companion = getCompanion({
      browserSessionId: session.browser_session_id,
      interactionId: session.interaction_id,
      runId: session.run_id,
    });
    if (!companion || typeof companion.getNekoProxyTarget !== "function") {
      observeStreamTransport("stream_neko_proxy_target_unavailable", session, {
        error_code: "companion_unavailable",
        stage,
      });
      const err: CodedError = new Error("n.eko companion is not available");
      err.code = "companion_unavailable";
      throw err;
    }
    const target = companion.getNekoProxyTarget();
    if (!target?.origin) {
      observeStreamTransport("stream_neko_proxy_target_unavailable", session, {
        error_code: "neko_proxy_unavailable",
        stage,
      });
      const err: CodedError = new Error("n.eko proxy target is not available");
      err.code = "neko_proxy_unavailable";
      throw err;
    }
    let origin: URL;
    try {
      origin = assertAllowedNekoOrigin(target.origin, allowedNekoHosts, (parsed) =>
        typeof isNekoProxyTargetApproved === "function"
          ? isNekoProxyTargetApproved(target, { origin: parsed, session })
          : false
      );
    } catch (err) {
      observeStreamTransport("stream_neko_proxy_target_rejected", session, {
        error_code: safeNetworkErrorCode(err),
        stage,
      });
      throw err;
    }
    observeStreamTransport("stream_neko_proxy_target_resolved", session, {
      stage,
      target_protocol: origin.protocol.slice(0, -1),
    });
    return { companion, origin, session };
  }

  function getNekoCookieSession(
    req: Pick<StreamingRequest, "headers">,
    stage = "neko_proxy_http"
  ): { companion: StreamingCompanion; origin: URL; session: StreamingSession } {
    const token = parseCookieHeader(req.headers?.cookie).get(nekoProxyCookieName);
    if (!token) {
      const err: CodedError = new Error("n.eko stream cookie is missing");
      err.code = "invalid_token";
      throw err;
    }
    return getNekoProxySession(token, stage);
  }

  function isStateChangingNekoProxyMethod(method: unknown): boolean {
    return NEKO_PROXY_MUTATING_METHODS.has(String(method || "GET").toUpperCase());
  }

  function buildNekoTargetUrl(origin: URL, reqUrl: string | undefined): URL {
    const base = new URL(origin.href);
    const incoming = new URL(reqUrl || nekoProxyPath, "http://pdpp.local");
    let suffix = incoming.pathname;
    if (suffix === "/neko") {
      suffix = "/";
    } else if (suffix.startsWith("/neko/")) {
      suffix = suffix.slice("/neko".length);
    }

    const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
    if (basePath) {
      const suffixPath = suffix.startsWith("/") ? suffix : `/${suffix}`;
      base.pathname = `${basePath}${suffixPath}`;
    } else if (incoming.pathname === "/neko") {
      base.pathname = "/neko/";
    } else if (incoming.pathname.startsWith("/neko")) {
      base.pathname = incoming.pathname;
    } else {
      base.pathname = suffix;
    }
    base.search = incoming.search;
    base.hash = "";
    return base;
  }

  function shouldInjectNekoBase(req: StreamingRequest, targetUrl: URL, upstreamRes: http.IncomingMessage): boolean {
    const method = String(req.method || "GET").toUpperCase();
    const contentType = String(upstreamRes.headers?.["content-type"] || "");
    return method === "GET" && targetUrl.pathname === "/neko/" && HTML_CONTENT_TYPE_PATTERN.test(contentType);
  }

  function withoutContentLength(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const next = { ...(headers || {}) };
    for (const key of Object.keys(next)) {
      if (key.toLowerCase() === "content-length") {
        delete next[key];
      }
    }
    return next;
  }

  function injectNekoEmbedChrome(html: string): string {
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
    if (!NEKO_BASE_ELEMENT_PATTERN.test(next)) {
      next = HTML_HEAD_ELEMENT_PATTERN.test(next)
        ? next.replace(HTML_HEAD_ELEMENT_PATTERN, (match: string) => `${match}${base}`)
        : `${base}${next}`;
    }
    if (!PDPP_NEKO_EMBED_MARKER_PATTERN.test(next)) {
      next = HTML_HEAD_END_PATTERN.test(next)
        ? next.replace(HTML_HEAD_END_PATTERN, `${style}${script}</head>`)
        : `${style}${script}${next}`;
    }
    return next;
  }

  function handleNekoHttpProxy(req: StreamingRequest, res: StreamingReply): void {
    let authorized: { companion: StreamingCompanion; origin: URL; session: StreamingSession };
    try {
      authorized = getNekoCookieSession(req, "neko_proxy_http");
    } catch (err) {
      const status = proxySessionErrorStatus(err);
      pdppError(res, status, errorCode(err, "invalid_token"), errorMessage(err, "invalid token"));
      return;
    }

    // Remote-surface Core §3.2 admission rule: n.eko's generic proxy is
    // another presentation mutation transport, not an observer bypass.
    if (isStateChangingNekoProxyMethod(req.method) && !isControllingPresentationAttachment(authorized.session, req)) {
      pdppError(
        res,
        409,
        "presentation_attachment_not_controlling",
        "Only the controlling stream attachment may mutate the presentation through the n.eko proxy"
      );
      return;
    }

    const targetUrl = buildNekoTargetUrl(authorized.origin, req.raw?.url || req.url || nekoProxyPath);
    const headers = buildProxyHeaders(req.headers, targetUrl, [
      nekoProxyCookieName,
      presentationAttachmentCookieNameFor(authorized.session),
    ]);
    const body = serializeProxyBody(req, headers);
    const transport = targetUrl.protocol === "https:" ? https : http;
    res.hijack();
    const { raw } = res;
    const upstream = transport.request(
      {
        headers,
        hostname: targetUrl.hostname,
        method: req.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        port: targetUrl.port || undefined,
        protocol: targetUrl.protocol,
      },
      (upstreamRes) => {
        if (shouldInjectNekoBase(req, targetUrl, upstreamRes)) {
          let html = "";
          upstreamRes.setEncoding("utf8");
          upstreamRes.on("data", (chunk) => {
            html += chunk;
          });
          upstreamRes.on("end", () => {
            raw.writeHead(
              upstreamRes.statusCode || 502,
              upstreamRes.statusMessage,
              withoutContentLength(upstreamRes.headers)
            );
            raw.end(injectNekoEmbedChrome(html));
          });
          return;
        }
        raw.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, upstreamRes.headers);
        upstreamRes.pipe(raw);
      }
    );
    upstream.once("error", (err) => {
      observeStreamTransport("stream_neko_proxy_upstream_failed", authorized.session, {
        error_code: safeNetworkErrorCode(err),
        stage: "neko_proxy_http",
        transport: "http_proxy",
      });
      if (raw.destroyed) {
        return;
      }
      raw.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      raw.end(JSON.stringify({ error: { code: "neko_proxy_failed", type: "api_error" } }));
    });
    if (body) {
      upstream.end(body);
    } else {
      upstream.end();
    }
  }

  function handleNekoUpgrade(rawReq: http.IncomingMessage, socket: import("node:net").Socket, head: Buffer): boolean {
    const parsed = new URL(rawReq.url || "/", "http://localhost");
    if (parsed.pathname !== "/neko" && !parsed.pathname.startsWith("/neko/")) {
      return false;
    }
    try {
      const authorized = getNekoCookieSession({ headers: rawReq.headers }, "neko_proxy_websocket_upgrade");
      const targetUrl = buildNekoTargetUrl(authorized.origin, rawReq.url || nekoProxyPath);
      proxyUpgradeRequest(
        rawReq,
        socket,
        head,
        targetUrl,
        [nekoProxyCookieName, presentationAttachmentCookieNameFor(authorized.session)],
        (event, fields) =>
          observeStreamTransport(event, authorized.session, {
            ...(fields.error_code === undefined ? {} : { error_code: fields.error_code }),
            stage: "neko_proxy_websocket_upgrade",
            ...(fields.transport === undefined ? {} : { transport: fields.transport }),
          })
      );
      return true;
    } catch (err) {
      const status = proxySessionErrorStatus(err);
      writeUpgradeError(socket, status, upgradeStatusMessage(status));
      return true;
    }
  }

  // ── Mint ──────────────────────────────────────────────────────────────────
  app.post("/_ref/runs/:runId/run-interaction-stream", ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      if (!controller || typeof controller.getPendingInteraction !== "function") {
        return pdppError(res, 404, "not_found", "Controller is not configured on this server");
      }
      const runId = safeRunId(req);
      const body = recordOrEmpty(req.body);
      const interactionId = String(body.interaction_id || "").trim();
      if (!interactionId) {
        return pdppError(res, 400, "invalid_request", "interaction_id is required", "interaction_id");
      }
      const mintScope = await resolveMintScope(runId, interactionId);
      // Fail closed when no real CDP companion is configured. The viewer
      // must not receive a token that only errors at attach time; that
      // makes the dashboard primary action a dead button.
      if (typeof companionFactory !== "function") {
        return pdppError(
          res,
          503,
          "streaming_companion_unavailable",
          "Streaming companion is not configured on this server. The connector runtime must register a CDP page-target ws URL for the run via the run-target registry, or a streamingCompanionFactory must be injected, to enable run-interaction streaming."
        );
      }
      const responseBody = await mintStreamSession({
        body,
        companionFactory,
        interactionId,
        mintScope,
        runId,
      });
      return res.status(201).json(responseBody);
    } catch (err) {
      const failure = codedError(err);
      if (typeof failure?.status === "number" && typeof failure.code === "string") {
        return pdppError(res, failure.status, failure.code, failure.message, failure.param ?? null);
      }
      return pdppError(res, 500, "api_error", errorMessage(err, "mint failed"));
    }
  });

  // ── Stream-reach give-up beacon (owner-authenticated) ──────────────────────
  // After the viewer's pre-attach retry loop gives up, the client classifies
  // the give-up (via one token-scoped status probe it runs itself, because
  // EventSource hides the attach HTTP status) and reports the typed reason here
  // so the failure class is auditable from the run timeline. This route never
  // receives the stream token, proxy cookie, or raw viewer URL — only the
  // closed-set reason and the observed HTTP status. The reason is clamped
  // server-side so a malformed client cannot widen the spine's vocabulary.
  app.post(
    "/_ref/runs/:runId/run-interaction-stream/reach-failure",
    ownerAuth.requireOwnerSession,
    async (req, res) => {
      if (!controller || typeof controller.getPendingInteraction !== "function") {
        return pdppError(res, 404, "not_found", "Controller is not configured on this server");
      }
      const runId = safeRunId(req);
      const body = recordOrEmpty(req.body);
      const interactionId = String(body.interaction_id || "").trim();
      if (!interactionId) {
        return pdppError(res, 400, "invalid_request", "interaction_id is required", "interaction_id");
      }
      // Bind the beacon to the run's interaction scope so a stray POST cannot
      // attribute a reach failure to the wrong interaction. A give-up often
      // coincides with the interaction having just resolved or expired (that is
      // frequently *why* reach failed), so we do NOT require the interaction to
      // still be pending. When an interaction IS still pending for this run, it
      // must match the reported id; when none is pending, the beacon is accepted
      // as a diagnostic for an interaction that has already ended. The mint
      // route already proved the run/interaction pairing was real when it issued
      // the token, and this route grants no authority — it only records a
      // diagnostic spine event behind the owner-session gate.
      const pending = controller.getPendingInteraction(runId);
      if (pending && pending.interaction_id !== interactionId) {
        return pdppError(
          res,
          409,
          "interaction_id_mismatch",
          `Pending interaction is ${pending.interaction_id}, not ${interactionId}`,
          "interaction_id"
        );
      }
      const reason = sanitizeStreamReachReason(body.reason);
      const httpStatus = sanitizeStreamReachHttpStatus(body.http_status);
      // Status is a descriptive sub-resource status, NOT `failed`/`rejected`.
      // A connector run can succeed even when the operator's stream viewer gave
      // up reaching the surface, so this diagnostic must not pollute run-summary
      // status (`summarizeEvents` flags any `failed`/`rejected` event as a
      // terminal failure). This mirrors `run.browser_surface_probe_failed`,
      // which uses `surface_failed` for the same reason.
      await emit("run.stream_reach_failed", {
        data: { http_status: httpStatus, reason },
        interaction_id: interactionId,
        run_id: runId,
        status: "stream_reach_failed",
      });
      return res.status(202).json({
        http_status: httpStatus,
        interaction_id: interactionId,
        object: "run_interaction_stream_reach_failure",
        reason,
        run_id: runId,
      });
    }
  );

  // ── SSE attach (token-only) ───────────────────────────────────────────────
  app.get("/_ref/run-interaction-streams/:token/events", async (req, res) => {
    const authorized = authorizeStreamAttachment(req, res);
    if (!authorized) {
      return;
    }
    const { companion, controllingAttachment, session } = authorized;

    res.hijack();
    const { raw } = res;
    raw.statusCode = 200;
    raw.setHeader("Content-Type", "text/event-stream");
    raw.setHeader("Cache-Control", "no-cache, no-transform");
    raw.setHeader("Connection", "keep-alive");
    raw.setHeader("X-Accel-Buffering", "no");
    raw.flushHeaders?.();

    function writeEvent(name: string, data: unknown): void {
      raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    writeEvent(
      "attached",
      buildReferenceWireAttachedPayload({
        browserSessionId: session.browser_session_id,
        interactionId: session.interaction_id,
        runId: session.run_id,
        viewport: session.viewport,
      })
    );
    if (!controllingAttachment) {
      writeEvent("presentation_observer", { browser_session_id: session.browser_session_id });
    }

    const unsubscribe = companion.onFrame((frame) => {
      writeEvent("frame", buildReferenceWireFramePayload(frame));
      // CDP `Page.startScreencast` only delivers the next frame after the
      // previous one is acknowledged. Without this ack the stream stalls
      // after the first frame against a real Chromium. Best-effort: a
      // failed ack must not crash the SSE response (the next frame's ack
      // can recover, and if the companion really is gone, teardown will
      // fire from the close handler).
      if (Number.isFinite(frame.sessionId) && typeof companion.ackFrame === "function") {
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
      typeof companion.onEvent === "function"
        ? companion.onEvent((event) => {
            const payload = buildReferenceWireCompanionEventPayload(event);
            if (!payload) {
              return;
            }
            // Forward unknown event kinds as-is so newer companions can add
            // event types without a route change. Tests can assert against
            // the discriminator via the SSE event name.
            writeEvent(payload.name, payload.data);
          })
        : () => undefined;

    // SSE keepalive: write a comment ping every 15 seconds to reset the
    // keepaliveTimeout on Fastify/HTTP intermediaries (default 30s).
    // SSE comments (lines starting with `:`) are ignored by EventSource clients.
    const keepAliveInterval = setInterval(() => {
      try {
        raw.write(": keepalive\n\n");
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
      if (perConnectionClosed) {
        return;
      }
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
    async function tearDownSession(reason: string): Promise<void> {
      if (terminalTorn) {
        return;
      }
      terminalTorn = true;
      closePerConnection();
      try {
        await invalidateForInteractionResolved({
          interaction_id: session.interaction_id,
          reason,
          run_id: session.run_id,
        });
      } catch {
        // The terminalizer has invalidated the token and invoked the surface
        // recovery hook. This connection is already terminal; do not turn a
        // failed restore into a socket-close retry loop.
      }
      try {
        raw.end();
      } catch {
        /* socket may already be gone */
      }
    }

    req.raw.on("close", () => {
      closePerConnection();
    });

    try {
      const backend = await resolveCompanionBackend(companion);
      const startViewport = viewportForCompanionBackend(backend, session.viewport || null);
      await companion.start(startViewport);
      const settledBackend = await resolveCompanionBackend(companion);
      const settledViewport = viewportForCompanionBackend(settledBackend, session.viewport || null);
      if (settledViewport && !viewportsMatch(startViewport, settledViewport)) {
        await companion.dispatch({ type: "viewport", ...settledViewport });
      }
    } catch (err) {
      observeStreamTransport("stream_companion_start_failed", session, { error_code: safeNetworkErrorCode(err) });
      writeEvent("error", {
        code: errorCode(err, "companion_start_failed"),
        message: errorMessage(err, "companion start failed"),
      });
      await tearDownSession("companion_start_failed");
      return;
    }

    const backend = typeof companion.backend === "string" ? companion.backend : "cdp";
    writeEvent(
      "backend_ready",
      buildReferenceWireBackendReadyPayload({
        backend,
        token: req.params.token ?? "",
        ...(companion.browserOwnerMode ? { browserOwnerMode: companion.browserOwnerMode.bind(companion) } : {}),
        ...(companion.stealthMode ? { stealthMode: companion.stealthMode.bind(companion) } : {}),
      })
    );
    observeStreamTransport("stream_backend_ready_emitted", session, { backend });

    await emit("run.stream_session_opened", {
      data: { browser_session_id: session.browser_session_id, viewport: session.viewport },
      interaction_id: session.interaction_id,
      run_id: session.run_id,
      status: "started",
    });
  });

  // ── Input dispatch (token-only) ───────────────────────────────────────────
  app.post("/_ref/run-interaction-streams/:token/input", async (req, res) => {
    const authorized = authorizeControllingCompanion(req, res);
    if (!authorized) {
      return;
    }
    const { companion, session } = authorized;
    // Layer C telemetry: capture receipt of the wire event with its
    // correlationId (set by the phone-side overlay). The body is the raw
    // wire shape (type/action/x/y/...), so we record it verbatim minus the
    // correlationId promoted to a top-level field.
    const body = parseReferenceWireInputPayload(req.body);
    const correlationId = typeof body.correlationId === "string" ? body.correlationId : null;
    const wireSeq = typeof body.wireSeq === "number" ? body.wireSeq : null;
    const receivedAtMs = Date.now();
    const sessionKey = sessionIdentityKey(session);
    pushInputTelemetry(sessionKey, {
      action: body.action || null,
      correlationId,
      eventType: body.type || null,
      kind: "wire.input.received",
      source: "server",
      wireSeq,
      x: typeof body.x === "number" ? body.x : null,
      y: typeof body.y === "number" ? body.y : null,
    });
    try {
      await companion.dispatch(body);
      pushInputTelemetry(sessionKey, {
        action: body.action || null,
        correlationId,
        dispatchLatencyMs: Date.now() - receivedAtMs,
        eventType: body.type || null,
        kind: "wire.input.dispatched",
        source: "server",
        wireSeq,
      });
    } catch (err) {
      pushInputTelemetry(sessionKey, {
        action: body.action || null,
        correlationId,
        errorCode: errorCode(err, "invalid_input"),
        errorMessage: errorMessage(err, String(err)),
        eventType: body.type || null,
        kind: "wire.input.error",
        source: "server",
        wireSeq,
      });
      return pdppError(res, 400, errorCode(err, "invalid_input"), errorMessage(err, "invalid input"));
    }
    return res.status(202).json({ object: "run_interaction_stream_input_ack" });
  });

  // ── Clipboard (token-only) ───────────────────────────────────────────────
  // This is the host adaptation for the assembled Remote Surface session's
  // clipboard channel. It deliberately shares the input route's
  // controlling-attachment check so a stale bearer cannot read or write the
  // remote page selection.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This route is the explicit validation boundary for two clipboard directions and their distinct failure semantics.
  app.post("/_ref/run-interaction-streams/:token/clipboard", async (req, res) => {
    const authorized = authorizeControllingCompanion(req, res);
    if (!authorized) {
      return;
    }
    const { companion } = authorized;
    const { action, requestId, text } = recordOrEmpty(req.body);
    if (action === "local_to_remote") {
      if (typeof text !== "string") {
        return pdppError(res, 400, "invalid_request", "clipboard text is required", "text");
      }
      try {
        await companion.dispatch({ action, text, type: "clipboard" });
      } catch (err) {
        return pdppError(res, 400, errorCode(err, "invalid_input"), errorMessage(err, "clipboard input failed"));
      }
      return res.status(202).json({ object: "run_interaction_stream_clipboard_ack" });
    }
    if (action === "remote_to_local") {
      if (typeof companion.readRemoteSelection !== "function") {
        return pdppError(res, 409, "clipboard_unsupported", "Remote selection is unavailable");
      }
      try {
        const remoteText = await companion.readRemoteSelection();
        return res.status(200).json({
          object: "run_interaction_stream_remote_selection",
          requestId: typeof requestId === "number" ? requestId : null,
          text: remoteText,
        });
      } catch (err) {
        return pdppError(
          res,
          400,
          errorCode(err, "clipboard_read_failed"),
          errorMessage(err, "remote selection read failed")
        );
      }
    }
    return pdppError(res, 400, "invalid_request", "unsupported clipboard action", "action");
  });

  // ── Input telemetry drain (debug-only) ───────────────────────────────────
  // The viewer polls this every ~500ms (gated by ?stream_debug=1) to merge
  // server-side and remote-page events with phone-side events in the
  // on-screen overlay. Token-only auth; response shape is { seq, records }.
  app.get("/_ref/run-interaction-streams/:token/input-telemetry", (req, res) => {
    let session: StreamingSession;
    try {
      session = streamingSessions.authorize({ token: req.params.token });
    } catch (err) {
      const status = errorCode(err, "") === "session_not_attached" ? 409 : 401;
      return pdppError(res, status, errorCode(err, "invalid_token"), errorMessage(err, "invalid token"));
    }
    const { since } = parseReferenceWireInputTelemetryCursor(req.query.since);
    const { seq, records } = inputTelemetry.readSince(sessionIdentityKey(session), since);
    return res.status(200).json({
      object: "run_interaction_stream_input_telemetry",
      records,
      seq,
    });
  });

  // ── Viewport (token-only) ────────────────────────────────────────────────
  app.post("/_ref/run-interaction-streams/:token/viewport", async (req, res) => {
    let session: StreamingSession;
    try {
      session = streamingSessions.authorize({ token: req.params.token });
    } catch (err) {
      const status = errorCode(err, "") === "session_not_attached" ? 409 : 401;
      return pdppError(res, status, errorCode(err, "invalid_token"), errorMessage(err, "invalid token"));
    }
    const viewport = pickViewport(req.body || {});
    if (!viewport) {
      return pdppError(res, 400, "invalid_request", "viewport.width and viewport.height are required", "viewport");
    }
    if (!isControllingPresentationAttachment(session, req)) {
      return pdppError(
        res,
        409,
        "presentation_attachment_not_controlling",
        "Only the controlling stream attachment may change the presentation viewport"
      );
    }
    const companion = getCompanion({
      browserSessionId: session.browser_session_id,
      interactionId: session.interaction_id,
      runId: session.run_id,
    });
    if (!companion) {
      return pdppError(res, 410, "companion_unavailable", "Streaming companion is no longer attached");
    }
    try {
      const backend = await resolveCompanionBackend(companion);
      const companionViewport = viewportForCompanionBackend(backend, viewport);
      if (!companionViewport) {
        throw new Error("viewport is required");
      }
      await dispatchPresentationViewport(session, companion, companionViewport);
    } catch (err) {
      return pdppError(res, 400, errorCode(err, "invalid_input"), errorMessage(err, "invalid input"));
    }
    return res.status(202).json({
      object: "run_interaction_stream_viewport_ack",
      viewport: viewportForCompanionBackend(await resolveCompanionBackend(companion), viewport),
    });
  });

  // ── n.eko viewer entry + proxy (stream-token scoped) ───────────────────────
  function nekoProxyBasePath(): string {
    return nekoProxyPath.endsWith("/") ? nekoProxyPath.slice(0, -1) : nekoProxyPath;
  }

  function buildNekoClientConfig(): JsonObject {
    const serverPath = nekoProxyBasePath() || "/neko";
    return {
      login: nekoAutoLogin
        ? {
            password: nekoAutoLogin.password,
            username: nekoAutoLogin.username,
          }
        : {
            password: "neko",
            username: "user",
          },
      object: "run_interaction_neko_client",
      server_path: serverPath,
      status_path: `${serverPath}/__pdpp/status`,
    };
  }

  function authorizeNekoEntryToken(
    req: StreamingRequest,
    res: StreamingReply,
    stage: string
  ): { companion: StreamingCompanion; origin: URL; session: StreamingSession } | null {
    let authorized: { companion: StreamingCompanion; origin: URL; session: StreamingSession };
    try {
      authorized = getNekoProxySession(req.params.token, stage);
    } catch (err) {
      const status = proxySessionErrorStatus(err);
      pdppError(res, status, errorCode(err, "invalid_token"), errorMessage(err, "invalid token"));
      return null;
    }
    setNekoProxyCookie(
      res,
      req.params.token ?? "",
      (authorized.session.expires_at - now()) / 1000,
      nekoProxyCookieName
    );
    return authorized;
  }

  function handleNekoEntry(req: StreamingRequest, res: StreamingReply): StreamingReply | undefined {
    if (!authorizeNekoEntryToken(req, res, "neko_entry")) {
      return;
    }
    const entryPath = nekoProxyBasePath();
    const params = new URLSearchParams();
    // The viewer contract preserves this query order: callers historically
    // receive pdpp_stream before the presentation-only embed marker.
    params.set("pdpp_stream", Math.floor(now()).toString(36));
    params.set("embed", "1");
    if (nekoAutoLogin) {
      params.set("usr", nekoAutoLogin.username);
      params.set("pwd", nekoAutoLogin.password);
    }
    return res.redirect(302, `${entryPath}?${params.toString()}`);
  }

  function handleNekoClientConfig(req: StreamingRequest, res: StreamingReply): StreamingReply | undefined {
    const authorized = authorizeNekoEntryToken(req, res, "neko_client_config");
    if (!authorized) {
      return;
    }
    observeStreamTransport("stream_neko_client_config_issued", authorized.session, { status_code: 200 });
    return res.status(200).json(buildNekoClientConfig());
  }

  app.get("/_ref/run-interaction-streams/:token/neko", handleNekoEntry);
  app.get("/_ref/run-interaction-streams/:token/neko/", handleNekoEntry);
  app.get("/_ref/run-interaction-streams/:token/neko/session", handleNekoClientConfig);
  app.get("/_ref/run-interaction-streams/:token/neko/session/", handleNekoClientConfig);

  async function handleNekoStatus(req: StreamingRequest, res: StreamingReply): Promise<StreamingReply> {
    let authorized: { companion: StreamingCompanion; origin: URL; session: StreamingSession };
    try {
      authorized = getNekoCookieSession(req, "neko_status");
    } catch (err) {
      const status = proxySessionErrorStatus(err);
      return pdppError(res, status, errorCode(err, "invalid_token"), errorMessage(err, "invalid token"));
    }
    const { companion } = authorized;
    if (!companion || typeof companion.queryNekoStatus !== "function") {
      return res.status(200).json({
        control_available: false,
        object: "run_interaction_neko_status",
      });
    }
    try {
      const status = await companion.queryNekoStatus();
      if (isNullish(status)) {
        return res.status(200).json({
          control_available: false,
          object: "run_interaction_neko_status",
        });
      }
      return res.status(200).json({
        control_available: true,
        native_control_available: true,
        object: "run_interaction_neko_status",
        status,
      });
    } catch (err) {
      return res.status(200).json({
        control_available: false,
        diagnostic_error: {
          code: errorCode(err, "neko_status_failed"),
          message: errorMessage(err, "n.eko status failed"),
        },
        object: "run_interaction_neko_status",
      });
    }
  }

  app.get("/neko/__pdpp/status", handleNekoStatus);

  const nekoProxyRouteMethods: ((path: string, handler: RouteHandler) => void)[] = [
    app.get.bind(app),
    app.post.bind(app),
    app.put.bind(app),
    app.delete.bind(app),
    app.patch.bind(app),
    app.options.bind(app),
  ];
  for (const registerProxyRoute of nekoProxyRouteMethods) {
    registerProxyRoute("/neko", handleNekoHttpProxy);
    registerProxyRoute("/neko/*", handleNekoHttpProxy);
  }

  return {
    _internal: { companions, getCompanion, handleNekoUpgrade },
    handleUpgrade: handleNekoUpgrade,
    /**
     * Hook for the controller to call when an interaction resolves or the run
     * ends. Invalidates the token and tears down the companion if any.
     */
    invalidateForInteractionResolved,
    restoreOrRetirePresentationForRun,
  };
}
