// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore-all lint/correctness/noUnresolvedImports: remote-surface 1.5.1 is installed in the reference implementation workspace; the repository-root checker does not resolve that local package.
import {
  type CdpBackendLifecycle,
  type CdpCommandParams,
  type CdpCommandTransport,
  createCdpServerBackend,
} from "@opendatalabs/remote-surface/backends/cdp";
import type {
  RemoteSurfaceClipboardPayload,
  RemoteSurfaceInputPayload,
  RemoteSurfaceViewportPayload,
} from "@opendatalabs/remote-surface/protocol";
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
 * Surface mechanics are delegated to Remote Surface 1.5.1's assembled CDP
 * backend. The small adapter below only translates that backend's lifecycle
 * messages to the existing PDPP companion wire and preserves the target
 * router's URL/popup events.
 *
 * Lifecycle:
 *   createCdpCompanion({ wsUrl, ... }) → companion handle
 *     start(viewport)  - opens ws (lazily) and starts the assembled Remote
 *                        Surface CDP lifecycle, including focus detection.
 *     stop()           - stops screencast, closes ws.
 *     onFrame(handler) - subscribe to assembled frame events.
 *     dispatch(event)  - route Remote Surface input/viewport/clipboard payloads
 *                        through the assembled lifecycle.
 *     ackFrame(id)     - compatibility hook; the assembled backend already
 *                        acknowledges each CDP frame before emitting it.
 *
 * The adapter is intentionally tolerant: a single dropped command must not
 * crash the streaming session. Errors propagate via `start()` (which the route
 * surfaces to the viewer as an `error` SSE event) and via `dispatch()` (which
 * surfaces as a 4xx on the input POST).
 */
import { mapInputEventToCdp } from "./cdp-companion.ts";

type CdpMethod = string;

interface CdpJsonObject {
  readonly [key: string]: unknown;
}
type CdpSocketEventName = "open" | "error" | "close" | "message";
type CdpSocketMessageData = string | Uint8Array | { toString: (encoding?: string) => string };

interface CdpSocketEvent {
  readonly data?: CdpSocketMessageData;
  readonly error?: { readonly message?: string };
  readonly message?: string;
}

interface CdpSocket {
  addEventListener: (type: CdpSocketEventName, listener: (event: CdpSocketEvent) => void) => void;
  close: () => void;
  on?: (type: CdpSocketEventName, listener: (event: CdpSocketEvent) => void) => void;
  readonly readyState: number;
  send: (data: string) => void;
}

type CdpSocketConstructor = new (url: string) => CdpSocket;

interface CdpError {
  readonly code: number;
  readonly data?: unknown;
  readonly message: string;
}

interface CdpResponse<M extends CdpMethod = CdpMethod> {
  readonly error?: CdpError;
  readonly id: number;
  readonly result?: M extends CdpMethod ? CdpJsonObject : CdpJsonObject;
}

interface PageScreencastFrameMetadata {
  readonly deviceHeight?: number;
  readonly deviceWidth?: number;
  readonly offsetTop?: number;
  readonly pageScaleFactor?: number;
  readonly scrollOffsetX?: number;
  readonly scrollOffsetY?: number;
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

interface PageScreencastFrameEvent {
  readonly data: string;
  readonly metadata?: PageScreencastFrameMetadata;
  readonly sessionId: number;
}

interface TargetInfo {
  readonly openerId?: string;
  readonly targetId: string;
  readonly title?: string;
  readonly type: string;
  readonly url?: string;
}

interface TargetCreatedEvent {
  readonly targetInfo: TargetInfo;
}

interface TargetDestroyedEvent {
  readonly targetId: string;
}

interface TargetInfoChangedEvent {
  readonly targetInfo: TargetInfo;
}

interface PageFrame {
  readonly id: string;
  readonly parentId?: string;
  readonly url?: string;
}

interface PageFrameNavigatedEvent {
  readonly frame: PageFrame;
}

type CdpEvent =
  | { readonly method: "Page.screencastFrame"; readonly params: PageScreencastFrameEvent }
  | { readonly method: "Page.frameNavigated"; readonly params: PageFrameNavigatedEvent }
  | { readonly method: "Target.targetCreated"; readonly params: TargetCreatedEvent }
  | { readonly method: "Target.targetDestroyed"; readonly params: TargetDestroyedEvent }
  | { readonly method: "Target.targetInfoChanged"; readonly params: TargetInfoChangedEvent }
  | { readonly method: string; readonly params: CdpJsonObject };

type CdpMessage = CdpResponse | CdpEvent;
type CdpFrame = Omit<PageScreencastFrameEvent, "metadata"> & { readonly metadata: PageScreencastFrameMetadata | null };
interface CdpOutputEvent {
  readonly kind: string;
  readonly [key: string]: unknown;
}
type CdpFrameHandler = (frame: CdpFrame) => void;
type CdpProtocolFrameHandler = (frame: PageScreencastFrameEvent) => void;
type CdpEventHandler = (event: CdpOutputEvent) => void;
type CdpLogger = Record<string, ((data: CdpJsonObject) => void) | undefined>;
type CodedError = Error & { code?: string; cdp?: CdpError };
interface CdpCompanion {
  ackFrame: (sessionId: number) => Promise<void>;
  readonly browser_session_id: string;
  dispatch: (event: unknown) => Promise<void>;
  onEvent: (handler: CdpEventHandler) => () => void;
  onFrame: (handler: CdpFrameHandler) => () => void;
  readRemoteSelection: () => Promise<string>;
  start: (viewport?: Viewport) => Promise<void>;
  stop: () => Promise<void>;
}
type CdpLoggerLevel = "info" | "warn";
type Viewport = { width?: number; height?: number; deviceScaleFactor?: number; mobile?: boolean } | null | undefined;
type ResolveTarget = (runId: string, interactionId: string) => string | null | PromiseLike<string | null>;

function isCdpSocketMessageData(value: unknown): value is CdpSocketMessageData {
  return (
    typeof value === "string" ||
    value instanceof Uint8Array ||
    (isObject(value) && typeof value.toString === "function")
  );
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function errorWithCode(message: string, code: string): CodedError {
  return codedError(message, code);
}

function isCdpError(value: unknown): value is CdpError {
  if (!isObject(value)) {
    return false;
  }
  return typeof value.code === "number" && typeof value.message === "string";
}

function parsedCdpResponse(value: CdpJsonObject): CdpResponse | null {
  if (typeof value.id === "number") {
    return {
      id: value.id,
      ...(isCdpError(value.error) ? { error: value.error } : {}),
      ...(isObject(value.result) ? { result: value.result } : {}),
    };
  }
  return null;
}

function parsedScreencastFrame(value: CdpJsonObject): CdpEvent | null {
  if (typeof value.sessionId !== "number" || typeof value.data !== "string") {
    return null;
  }
  const metadata = isObject(value.metadata) ? value.metadata : null;
  return metadata
    ? { method: "Page.screencastFrame", params: { data: value.data, metadata, sessionId: value.sessionId } }
    : { method: "Page.screencastFrame", params: { data: value.data, sessionId: value.sessionId } };
}

function parsedFrameNavigated(value: CdpJsonObject): CdpEvent | null {
  if (!isObject(value.frame)) {
    return null;
  }
  return {
    method: "Page.frameNavigated",
    params: {
      frame: {
        id: typeof value.frame.id === "string" ? value.frame.id : "",
        ...(typeof value.frame.parentId === "string" ? { parentId: value.frame.parentId } : {}),
        ...(typeof value.frame.url === "string" ? { url: value.frame.url } : {}),
      },
    },
  };
}

function eventParams(value: unknown): CdpJsonObject | null {
  return isObject(value) ? value : null;
}

function parsedTargetInfo(
  value: CdpJsonObject,
  method: "Target.targetCreated" | "Target.targetInfoChanged"
): CdpEvent | null {
  const { targetInfo } = value;
  if (!isObject(targetInfo) || typeof targetInfo.targetId !== "string" || typeof targetInfo.type !== "string") {
    return null;
  }
  const info: TargetInfo = {
    targetId: targetInfo.targetId,
    type: targetInfo.type,
    ...(typeof targetInfo.openerId === "string" ? { openerId: targetInfo.openerId } : {}),
    ...(typeof targetInfo.url === "string" ? { url: targetInfo.url } : {}),
    ...(typeof targetInfo.title === "string" ? { title: targetInfo.title } : {}),
  };
  return { method, params: { targetInfo: info } };
}

type CdpEventParser = (value: CdpJsonObject) => CdpEvent | null;

const CDP_EVENT_PARSERS: Record<string, CdpEventParser> = {
  "Page.frameNavigated": parsedFrameNavigated,
  "Page.screencastFrame": parsedScreencastFrame,
  "Target.targetCreated": (value) => parsedTargetInfo(value, "Target.targetCreated"),
  "Target.targetDestroyed": (value) =>
    typeof value.targetId === "string"
      ? { method: "Target.targetDestroyed", params: { targetId: value.targetId } }
      : null,
  "Target.targetInfoChanged": (value) => parsedTargetInfo(value, "Target.targetInfoChanged"),
};

function parsedCdpEvent(value: CdpJsonObject): CdpEvent | null {
  if (typeof value.method !== "string") {
    return null;
  }
  const params = eventParams(value.params);
  if (!params) {
    return null;
  }
  return CDP_EVENT_PARSERS[value.method]?.(params) ?? { method: value.method, params };
}

function parsedCdpMessage(value: CdpJsonObject): CdpMessage | null {
  return parsedCdpResponse(value) ?? parsedCdpEvent(value);
}

function cdpParams(value: unknown): CdpCommandParams {
  return isObject(value) ? value : {};
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_OPEN_TIMEOUT_MS = 5000;

function codedError(message: string, code: string, properties: CdpJsonObject = {}): CodedError {
  return Object.assign(new Error(message), { code, ...properties });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isObject(value: unknown): value is CdpJsonObject {
  return value !== null && typeof value === "object";
}

/**
 * CDP's `Input.dispatchTouchEvent` does not reliably synthesize a `click`
 * DOM event the way real touchscreen hardware does through the compositor's
 * gesture recognizer — verified live against a Reddit reCAPTCHA checkbox: a
 * touch tap at the checkbox's exact coordinates left it unchecked, while a
 * mouse click at the same coordinates advanced the challenge. remote-surface
 * 1.5.2's neko backend already works around this for its own transport
 * (`NekoPointerController`, "canonical tap-to-click pattern": buttonDown +
 * buttonUp instead of native touch), but `dispatchCdpPointerInput` in
 * `@opendatalabs/remote-surface/backends/cdp` still branches on
 * `pointerType === "touch"` into a raw `Input.dispatchTouchEvent` for every
 * pointer action, with no such fallback.
 *
 * Rather than patch the installed dependency, this reroutes a touch/pen
 * press-or-release intent onto the same mouse path a real mouse pointerdown/
 * pointerup already takes (proven end-to-end above) — `clickCount: 1` is
 * required there for `Input.dispatchMouseEvent` to synthesize a real click
 * (see backend.js's own comment: a press/release without clickCount doesn't
 * focus inputs, toggle checkboxes, or follow links).
 *
 * `pointermove` is left alone: the report's own symptom ("scrolling works")
 * shows touch motion already reaches the remote page correctly, and CDP
 * touch drag has no analogous click-synthesis gap to route around.
 */
export function normalizeTouchPointerInputForCdp(event: CdpJsonObject): CdpJsonObject {
  if (event.type !== "pointer") {
    return event;
  }
  if (event.pointerType !== "touch" && event.pointerType !== "pen") {
    return event;
  }
  if (event.action !== "pointerdown" && event.action !== "pointerup" && event.action !== "pointercancel") {
    return event;
  }
  return {
    ...event,
    clickCount: typeof event.clickCount === "number" && event.clickCount > 0 ? event.clickCount : 1,
    pointerType: "mouse",
  };
}

function createLogger(
  logger: CdpLogger | undefined,
  context: CdpJsonObject
): (level: CdpLoggerLevel, msg: string, data?: CdpJsonObject) => void {
  return (level, msg, data = {}) => {
    const write = logger?.[level];
    if (typeof write !== "function") {
      return;
    }
    try {
      write.call(logger, { msg, ...context, ...(data || {}) });
    } catch {
      /* logger errors must not break the streaming path */
    }
  };
}

interface DeferredSubscriberRecord<T> {
  readonly handler: (value: T) => void;
  innerUnsubscribe: (() => void) | null;
}

function unsubscribe<T>(record: DeferredSubscriberRecord<T>): void {
  if (!record.innerUnsubscribe) {
    return;
  }
  try {
    record.innerUnsubscribe();
  } catch {
    /* unsubscribe is best-effort */
  }
  record.innerUnsubscribe = null;
}

function createDeferredSubscribers<T>() {
  const records = new Map<(value: T) => void, DeferredSubscriberRecord<T>>();
  return {
    add(handler: (value: T) => void): () => void {
      const record = { handler, innerUnsubscribe: null };
      records.set(handler, record);
      return () => {
        records.delete(handler);
        unsubscribe(record);
      };
    },
    adopt(subscribe: (handler: (value: T) => void) => () => void): void {
      for (const record of records.values()) {
        record.innerUnsubscribe = subscribe(record.handler);
      }
    },
    clear(): void {
      records.clear();
    },
  };
}

function hasInteractionIdentity(value: {
  run_id?: unknown;
  interaction_id?: unknown;
}): value is { run_id: string; interaction_id: string } {
  return isNonEmptyString(value.run_id) && isNonEmptyString(value.interaction_id);
}

function notifyHandlers<T>(
  handlers: Set<(value: T) => void>,
  value: T,
  log: ReturnType<typeof createLogger>,
  message: string,
  details: CdpJsonObject = {}
): void {
  for (const handler of handlers) {
    try {
      handler(value);
    } catch (err) {
      log("warn", message, { error: errorMessage(err), ...details });
    }
  }
}

function targetInfoOptionalFields(info: CdpJsonObject): { openerId?: string; url?: string; title?: string } {
  const fields: { openerId?: string; url?: string; title?: string } = {};
  if (typeof info.openerId === "string") {
    fields.openerId = info.openerId;
  }
  if (typeof info.url === "string") {
    fields.url = info.url;
  }
  if (typeof info.title === "string") {
    fields.title = info.title;
  }
  return fields;
}

function pageTargetInfo(params: unknown): TargetInfo | null {
  if (!isObject(params)) {
    return null;
  }
  const info = params.targetInfo;
  if (!isObject(info)) {
    return null;
  }
  if (info.type !== "page") {
    return null;
  }
  if (!isNonEmptyString(info.targetId)) {
    return null;
  }
  return {
    targetId: info.targetId,
    type: info.type,
    ...targetInfoOptionalFields(info),
  };
}

function mainFrameUrl(params: unknown): string | null {
  if (!isObject(params)) {
    return null;
  }
  const { frame } = params;
  if (!isObject(frame) || frame.parentId) {
    return null;
  }
  return typeof frame.url === "string" ? frame.url : null;
}

function urlChangedEvent(url: string, title: unknown): CdpOutputEvent {
  const event: { kind: "url_changed"; url: string; title?: string } = { kind: "url_changed", url };
  if (isNonEmptyString(title)) {
    event.title = title;
  }
  return event;
}

function targetIdFromWsUrl(wsUrl: string): string | null {
  try {
    const { pathname } = new URL(wsUrl);
    const prefix = "/devtools/page/";
    if (!pathname.startsWith(prefix)) {
      return null;
    }
    const targetId = pathname.slice(prefix.length);
    if (!isNonEmptyString(targetId) || targetId.includes("/")) {
      return null;
    }
    return decodeURIComponent(targetId);
  } catch {
    return null;
  }
}

function isBlankPageUrl(url: string | undefined): boolean {
  if (!isNonEmptyString(url)) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "about:" && parsed.pathname === "blank";
  } catch {
    return false;
  }
}

function popupOpenedEvent(info: TargetInfo): CdpOutputEvent {
  return {
    kind: "popup_opened",
    targetId: info.targetId,
    url: typeof info.url === "string" ? info.url : "",
  };
}

function createCdpEventRouter({
  emitFrame,
  emitEvent,
  ownPageTargetId,
}: {
  emitFrame: CdpProtocolFrameHandler;
  emitEvent: CdpEventHandler;
  ownPageTargetId?: string | null;
}): (message: CdpEvent) => void {
  const state: {
    lastEmittedUrl: string | null;
    lastKnownTitle: string | null;
    ownPageTargetId: string | null;
    pendingPopupTargetIds: Set<string>;
    popupTargetIds: Set<string>;
  } = {
    lastEmittedUrl: null,
    lastKnownTitle: null,
    ownPageTargetId: ownPageTargetId ?? null,
    pendingPopupTargetIds: new Set<string>(),
    popupTargetIds: new Set<string>(),
  };

  function emitUrlChanged(url: string | null): void {
    if (!isNonEmptyString(url) || url === state.lastEmittedUrl) {
      return;
    }
    state.lastEmittedUrl = url;
    emitEvent(urlChangedEvent(url, state.lastKnownTitle));
  }

  function rememberOwnPage(info: TargetInfo): void {
    if (state.ownPageTargetId !== null && info.targetId !== state.ownPageTargetId) {
      return;
    }
    state.ownPageTargetId = info.targetId;
    if (isNonEmptyString(info.title)) {
      state.lastKnownTitle = info.title;
    }
  }

  function announcePopup(info: TargetInfo): void {
    if (state.popupTargetIds.has(info.targetId)) {
      return;
    }
    state.pendingPopupTargetIds.delete(info.targetId);
    state.popupTargetIds.add(info.targetId);
    emitEvent(popupOpenedEvent(info));
  }

  // Target discovery can replay existing pages. The registered page owns the
  // stream; only a nonblank page explicitly opened by it is user-visible.
  // Hold blank child targets until they reveal whether they are real popups.
  function handleTargetCreated(params: TargetCreatedEvent): void {
    const info = pageTargetInfo(params);
    if (!info) {
      return;
    }
    if (state.ownPageTargetId === null) {
      rememberOwnPage(info);
      return;
    }
    if (info.targetId === state.ownPageTargetId) {
      rememberOwnPage(info);
      return;
    }
    if (info.openerId !== state.ownPageTargetId) {
      return;
    }
    if (isBlankPageUrl(info.url)) {
      state.pendingPopupTargetIds.add(info.targetId);
      return;
    }
    announcePopup(info);
  }

  function handleTargetDestroyed(params: TargetDestroyedEvent): void {
    const { targetId } = params;
    if (!isNonEmptyString(targetId)) {
      return;
    }
    state.pendingPopupTargetIds.delete(targetId);
    if (!state.popupTargetIds.delete(targetId)) {
      return;
    }
    emitEvent({ kind: "popup_closed", targetId });
  }

  function handleOwnTargetInfo(info: TargetInfo): void {
    if (typeof info.title === "string") {
      state.lastKnownTitle = info.title;
    }
    if (typeof info.url === "string") {
      emitUrlChanged(info.url);
    }
  }

  function handleTargetInfoChanged(params: TargetInfoChangedEvent): void {
    const info = pageTargetInfo(params);
    if (!info) {
      return;
    }
    if (state.ownPageTargetId === null || info.targetId === state.ownPageTargetId) {
      handleOwnTargetInfo(info);
      return;
    }
    if (state.pendingPopupTargetIds.has(info.targetId) && !isBlankPageUrl(info.url)) {
      announcePopup(info);
    }
  }

  return (message) => {
    switch (message.method) {
      case "Page.screencastFrame":
        emitFrame(message.params as PageScreencastFrameEvent);
        return;
      case "Page.frameNavigated":
        emitUrlChanged(mainFrameUrl(message.params));
        return;
      case "Target.targetCreated":
        handleTargetCreated(message.params as TargetCreatedEvent);
        return;
      case "Target.targetDestroyed":
        handleTargetDestroyed(message.params as TargetDestroyedEvent);
        return;
      case "Target.targetInfoChanged":
        handleTargetInfoChanged(message.params as TargetInfoChangedEvent);
        return;
    }
  };
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
}: {
  resolveTargetForInteraction?: ResolveTarget;
  WebSocketCtor?: CdpSocketConstructor;
  logger?: CdpLogger | undefined;
  commandTimeoutMs?: number | undefined;
  openTimeoutMs?: number | undefined;
} = {}):
  | ((args: { run_id?: string; interaction_id?: string; browser_session_id: string }) => CdpCompanion | null)
  | null {
  if (typeof resolveTargetForInteraction !== "function") {
    return null;
  }
  if (typeof WebSocketCtor !== "function") {
    throw new Error("createDefaultStreamingCompanionFactory: no WebSocket constructor available");
  }

  return ({ run_id, interaction_id, browser_session_id }) => {
    const identity = { interaction_id, run_id };
    if (!hasInteractionIdentity(identity)) {
      return null;
    }
    return createResolvedCompanion({
      browser_session_id,
      commandTimeoutMs,
      interaction_id: identity.interaction_id,
      logger,
      openTimeoutMs,
      resolveTargetForInteraction,
      run_id: identity.run_id,
      WebSocketCtor,
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
}: {
  run_id: string;
  interaction_id: string;
  browser_session_id: string;
  resolveTargetForInteraction: ResolveTarget;
  WebSocketCtor: CdpSocketConstructor;
  logger?: CdpLogger | undefined;
  commandTimeoutMs?: number | undefined;
  openTimeoutMs?: number | undefined;
}): CdpCompanion & { readonly _internal: { isClosed: () => boolean; hasInner: () => boolean } } {
  let inner: CdpCompanion | null = null;
  let closed = false;
  const pendingFrames = createDeferredSubscribers<CdpFrame>();
  const pendingEvents = createDeferredSubscribers<CdpOutputEvent>();
  const log = createLogger(logger, { browser_session_id, interaction_id, run_id });

  function adoptInner(next: CdpCompanion): void {
    inner = next;
    pendingFrames.adopt((handler) => next.onFrame(handler));
    pendingEvents.adopt((handler) => next.onEvent(handler));
  }

  async function resolveInner() {
    if (inner) {
      return;
    }
    const wsUrl = await Promise.resolve(resolveTargetForInteraction(run_id, interaction_id));
    if (!wsUrl) {
      throw codedError("No streaming target registered for this run", "streaming_target_unregistered");
    }
    log("info", "cdp_resolver_hit", {});
    const next = createCdpCompanion({
      browser_session_id,
      commandTimeoutMs,
      logger,
      openTimeoutMs,
      WebSocketCtor,
      wsUrl,
    });
    adoptInner(next);
  }

  async function startInner(viewport: Viewport): Promise<void> {
    if (closed) {
      throw codedError("Streaming companion is closed", "companion_closed");
    }
    await resolveInner();
    const next = inner;
    if (!next) {
      throw codedError("Streaming companion is not resolved", "companion_not_started");
    }
    await next.start(viewport);
  }

  async function stopInner() {
    if (!inner) {
      return;
    }
    try {
      await inner.stop();
    } catch (err) {
      log("warn", "cdp_inner_stop_failed", { error: errorMessage(err) });
    }
  }

  return {
    /** test-only escape hatch */
    _internal: {
      hasInner: () => inner !== null,
      isClosed: () => closed,
    },
    ackFrame(sessionId) {
      if (!inner) {
        return Promise.resolve();
      }
      return inner.ackFrame(sessionId);
    },
    browser_session_id,
    dispatch(event) {
      if (!inner) {
        throw codedError("Streaming companion is not started", "companion_not_started");
      }
      return inner.dispatch(event);
    },
    onEvent(handler) {
      if (inner) {
        return inner.onEvent(handler);
      }
      return pendingEvents.add(handler);
    },
    onFrame(handler) {
      if (inner) {
        return inner.onFrame(handler);
      }
      return pendingFrames.add(handler);
    },
    readRemoteSelection() {
      if (!inner) {
        return Promise.reject(codedError("Streaming companion is not started", "companion_not_started"));
      }
      return inner.readRemoteSelection();
    },
    async start(viewport) {
      await startInner(viewport);
    },
    async stop() {
      if (closed) {
        return;
      }
      closed = true;
      await stopInner();
      // Drop pre-start handler records that never got bound to an inner
      // companion (e.g. companion was stopped before start() ever ran).
      // Without this, a long-lived factory could accumulate references.
      pendingFrames.clear();
      pendingEvents.clear();
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
}: {
  wsUrl?: string;
  browser_session_id?: string;
  WebSocketCtor?: CdpSocketConstructor;
  logger?: CdpLogger | undefined;
  commandTimeoutMs?: number | undefined;
  openTimeoutMs?: number | undefined;
} = {}): CdpCompanion & {
  readonly _internal: {
    send: (method: CdpMethod, params?: CdpCommandParams) => Promise<CdpJsonObject>;
    isStarted: () => boolean;
    isClosed: () => boolean;
  };
} {
  if (typeof wsUrl !== "string" || wsUrl.length === 0) {
    throw new Error("createCdpCompanion: wsUrl is required");
  }
  const targetUrl = wsUrl;
  if (typeof WebSocketCtor !== "function") {
    throw new Error("createCdpCompanion: WebSocket constructor is required");
  }

  const browserSessionId = browser_session_id || "";
  const log = createLogger(logger, { browser_session_id: browserSessionId });

  const frameHandlers = new Set<CdpFrameHandler>();
  const eventHandlers = new Set<CdpEventHandler>();
  interface PendingCommand {
    readonly reject: (error: CodedError) => void;
    readonly resolve: (result: CdpJsonObject) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<number, PendingCommand>();
  let nextId = 1;
  let ws: CdpSocket | null = null;
  let openPromise: Promise<void> | null = null;
  let started = false;
  let closed = false;
  let serverBackend: ReturnType<typeof createCdpServerBackend> | null = null;
  let backendLifecycle: CdpBackendLifecycle | null = null;
  let backendLifecycleSubscription: { unsubscribe: () => void } | null = null;
  let frameSessionSubscription: { unsubscribe: () => void } | null = null;
  const pendingFrameSessionIds: number[] = [];
  const pendingFrameMetadata: (PageScreencastFrameMetadata | null)[] = [];
  const protocolEventHandlers = new Map<string, Set<(params: unknown) => void>>();

  let lastFrame: CdpFrame | null = null;

  function emitFrame(params: PageScreencastFrameEvent): void {
    // Wire shape mirrors the mock companion so the route writes identical SSE.
    const frame: CdpFrame = {
      data: params.data,
      metadata: params.metadata ?? null,
      sessionId: params.sessionId,
    };
    lastFrame = frame;
    notifyHandlers(frameHandlers, frame, log, "cdp_frame_handler_error");
  }

  function emitEvent(event: CdpOutputEvent): void {
    // Out-of-band events: { kind, ...payload }. The route layer fans these
    // out as named SSE events (event: url_changed, popup_opened, ...).
    notifyHandlers(eventHandlers, event, log, "cdp_event_handler_error", { kind: event.kind });
  }

  const routeCdpEvent = createCdpEventRouter({
    emitEvent,
    emitFrame: () => {
      // The assembled Remote Surface server backend owns frame decode/ack
      // lifecycle. The popup/URL router still observes the raw event below.
    },
    ownPageTargetId: targetIdFromWsUrl(targetUrl),
  });

  function closedCdpError(reason: unknown): CodedError {
    const error: CodedError = reason instanceof Error ? reason : new Error(String(reason || "cdp_closed"));
    error.code ||= "cdp_closed";
    return error;
  }

  function rejectPending(entry: PendingCommand, err: CodedError): void {
    clearTimeout(entry.timer);
    entry.reject(err);
  }

  function rejectAllPending(reason: unknown): void {
    const err = closedCdpError(reason);
    for (const [, entry] of pending) {
      rejectPending(entry, err);
    }
    pending.clear();
  }

  function cdpResponseError(error: CdpError): CodedError {
    return codedError(error.message || "cdp_error", "cdp_error", { cdp: error });
  }

  function settleCommandResponse(entry: PendingCommand, msg: CdpResponse): void {
    if (msg.error) {
      entry.reject(cdpResponseError(msg.error));
      return;
    }
    entry.resolve(msg.result || {});
  }

  function handleCommandResponse(msg: CdpResponse): void {
    const entry = pending.get(msg.id);
    if (!entry) {
      return;
    }
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    settleCommandResponse(entry, msg);
  }

  function handleCdpEvent(msg: CdpEvent): void {
    routeCdpEvent(msg);
    const handlers = protocolEventHandlers.get(msg.method);
    if (!handlers) {
      return;
    }
    for (const handler of handlers) {
      try {
        handler(msg.params);
      } catch (err) {
        log("warn", "cdp_protocol_event_handler_error", {
          error: errorMessage(err),
          method: msg.method,
        });
      }
    }
  }

  function parseCdpMessage(raw: CdpSocketMessageData): unknown {
    return JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  }

  function parseMessageOrNull(raw: CdpSocketMessageData): CdpMessage | null {
    try {
      const msg = parseCdpMessage(raw);
      if (!isObject(msg)) {
        return null;
      }
      return parsedCdpMessage(msg);
    } catch (err) {
      log("warn", "cdp_message_parse_failed", { error: errorMessage(err) });
      return null;
    }
  }

  function dispatchCdpMessage(msg: CdpMessage): void {
    if ("id" in msg) {
      handleCommandResponse(msg);
      return;
    }
    handleCdpEvent(msg);
  }

  function handleMessage(raw: CdpSocketMessageData): void {
    const msg = parseMessageOrNull(raw);
    if (msg) {
      dispatchCdpMessage(msg);
    }
  }

  interface SocketHandlers {
    readonly onClose: () => void;
    readonly onError: (event: CdpSocketEvent) => void;
    readonly onMessage: (event: CdpSocketEvent | CdpSocketMessageData) => void;
    readonly onOpen: () => void;
  }

  function attachSocketListeners(
    socket: CdpSocket,
    handlers: SocketHandlers,
    reject: (error: CodedError) => void
  ): void {
    // Both standard WebSocket (browser/native) and `ws` library expose
    // `addEventListener` and `on` patterns. Prefer the standard one.
    if (typeof socket.addEventListener === "function") {
      socket.addEventListener("open", handlers.onOpen);
      socket.addEventListener("error", handlers.onError);
      socket.addEventListener("close", handlers.onClose);
      socket.addEventListener("message", handlers.onMessage);
    } else if (typeof socket.on === "function") {
      socket.on("open", handlers.onOpen);
      socket.on("error", handlers.onError);
      socket.on("close", handlers.onClose);
      socket.on("message", handlers.onMessage);
    } else {
      const e = new Error("Unsupported WebSocket implementation");
      reject(errorWithCode(e.message, "cdp_socket_unsupported"));
      reject(e);
    }
  }

  function createOpenSocketHandlers(
    socket: CdpSocket,
    openTimer: ReturnType<typeof setTimeout>,
    resolve: () => void,
    reject: (error: CodedError) => void
  ): SocketHandlers {
    const onOpen = (): void => {
      clearTimeout(openTimer);
      log("info", "cdp_connected");
      resolve();
    };
    const onError = (event: CdpSocketEvent): void => {
      clearTimeout(openTimer);
      const message = event.message || event.error?.message || "cdp websocket error";
      const e = new Error(message);
      const coded = errorWithCode(e.message, "cdp_socket_error");
      if (ws === socket) {
        rejectAllPending(coded);
      }
      reject(coded);
    };
    const onClose = (): void => {
      clearTimeout(openTimer);
      const e = new Error("CDP websocket closed");
      const coded = errorWithCode(e.message, "cdp_closed");
      if (ws === socket) {
        rejectAllPending(coded);
      }
      ws = null;
      openPromise = null;
    };
    const onMessage = (event: CdpSocketEvent | CdpSocketMessageData): void => {
      handleMessage(isObject(event) && "data" in event && isCdpSocketMessageData(event.data) ? event.data : event);
    };

    return { onClose, onError, onMessage, onOpen };
  }

  function openCdpSocket(resolve: () => void, reject: (error: CodedError) => void): void {
    let socket: CdpSocket;
    try {
      socket = new WebSocketCtor(targetUrl);
    } catch (err: unknown) {
      const e = errorWithCode(`Failed to connect to CDP: ${errorMessage(err) || String(err)}`, "cdp_connect_failed");
      reject(e);
      return;
    }
    ws = socket;
    const openTimer = setTimeout(() => {
      const e = new Error(`CDP connection timed out after ${openTimeoutMs}ms`);
      const coded = errorWithCode(e.message, "cdp_connect_timeout");
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      reject(coded);
    }, openTimeoutMs);

    attachSocketListeners(socket, createOpenSocketHandlers(socket, openTimer, resolve, reject), reject);
  }

  function isOpenSocket(socket: CdpSocket | null): socket is CdpSocket {
    return Boolean(socket?.readyState === 1);
  }

  function openCompanionError() {
    return codedError("Streaming companion is closed", "companion_closed");
  }

  function existingOpenPromise(): Promise<void> | null {
    if (closed) {
      return Promise.reject(openCompanionError());
    }
    if (isOpenSocket(ws)) {
      return Promise.resolve();
    }
    return openPromise;
  }

  function ensureOpen(): Promise<void> {
    const existing = existingOpenPromise();
    if (existing) {
      return existing;
    }
    openPromise = new Promise<void>((resolve, reject) => {
      openCdpSocket(resolve, reject);
    }).catch((err: unknown): never => {
      openPromise = null;
      throw err;
    });

    return openPromise;
  }

  function registerPendingCommand(
    method: CdpMethod,
    resolve: (result: CdpJsonObject) => void,
    reject: (error: CodedError) => void
  ): { id: number; timer: ReturnType<typeof setTimeout> } {
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(codedError(`CDP command ${method} timed out`, "cdp_timeout"));
      }
    }, commandTimeoutMs);
    pending.set(id, { reject, resolve, timer });
    return { id, timer };
  }

  function sendRegisteredCommand(
    socket: CdpSocket,
    id: number,
    method: CdpMethod,
    params: CdpCommandParams,
    timer: ReturnType<typeof setTimeout>,
    reject: (error: CodedError) => void
  ): void {
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (err: unknown) {
      pending.delete(id);
      clearTimeout(timer);
      reject(
        codedError(`Failed to send CDP command ${method}: ${errorMessage(err) || String(err)}`, "cdp_send_failed")
      );
    }
  }

  function sendOpenCdpCommand(method: CdpMethod, params: CdpCommandParams): Promise<CdpJsonObject> {
    return new Promise<CdpJsonObject>((resolve, reject) => {
      const socket = ws;
      if (!isOpenSocket(socket)) {
        return reject(codedError("CDP websocket is not open", "cdp_not_open"));
      }
      const { id, timer } = registerPendingCommand(method, resolve, reject);
      sendRegisteredCommand(socket, id, method, params, timer, reject);
    });
  }

  function send(method: CdpMethod, params: CdpCommandParams = {}): Promise<CdpJsonObject> {
    return ensureOpen().then(() => sendOpenCdpCommand(method, params));
  }

  const cdpCommandTransport: CdpCommandTransport = {
    on(eventName, handler) {
      const handlers = protocolEventHandlers.get(eventName) ?? new Set<(params: unknown) => void>();
      handlers.add(handler);
      protocolEventHandlers.set(eventName, handlers);
      return {
        unsubscribe() {
          handlers.delete(handler);
          if (handlers.size === 0) {
            protocolEventHandlers.delete(eventName);
          }
        },
      };
    },
    send<Result = unknown>(method: string, params: CdpCommandParams = {}) {
      return send(method, params) as Promise<Result>;
    },
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is the one protocol boundary that translates Remote Surface's finite event union into PDPP's legacy frame and SSE event wire.
  function emitRemoteSurfaceBackendEvent(event: unknown): void {
    if (!isObject(event) || typeof event.type !== "string") {
      return;
    }
    if (event.type === "frame" && typeof event.data === "string") {
      const sessionId = pendingFrameSessionIds.shift();
      const metadata = pendingFrameMetadata.shift();
      const frameMetadata =
        metadata ?? (isObject(event.metadata) ? (event.metadata as PageScreencastFrameMetadata) : null);
      emitFrame({
        data: event.data,
        ...(frameMetadata === null ? {} : { metadata: frameMetadata }),
        sessionId: sessionId ?? (typeof event.sessionId === "number" ? event.sessionId : 0),
      });
      return;
    }
    if (event.type !== "backend_event" || typeof event.name !== "string") {
      return;
    }
    const payload = isObject(event.payload) ? event.payload : {};
    if (event.name === "keyboard_focus") {
      emitEvent({ kind: "keyboard_focus", ...payload });
      return;
    }
    emitEvent({ kind: event.name, ...payload });
  }

  function createServerBackend(viewport: Viewport): ReturnType<typeof createCdpServerBackend> {
    const maxWidth =
      typeof viewport?.width === "number" && Number.isFinite(viewport.width) ? Math.floor(viewport.width) : undefined;
    const maxHeight =
      typeof viewport?.height === "number" && Number.isFinite(viewport.height)
        ? Math.floor(viewport.height)
        : undefined;
    frameSessionSubscription = cdpCommandTransport.on("Page.screencastFrame", (params) => {
      if (isObject(params) && typeof params.sessionId === "number") {
        pendingFrameSessionIds.push(params.sessionId);
        pendingFrameMetadata.push(isObject(params.metadata) ? (params.metadata as PageScreencastFrameMetadata) : null);
      }
    });
    return createCdpServerBackend({
      detectTextInputFocus: true,
      screencast: {
        everyNthFrame: 1,
        format: "jpeg",
        quality: 70,
        ...(maxHeight === undefined ? {} : { maxHeight }),
        ...(maxWidth === undefined ? {} : { maxWidth }),
      },
      targetId: targetIdFromWsUrl(targetUrl) || browserSessionId || "pdpp-cdp-target",
      transport: cdpCommandTransport,
    });
  }

  async function setTargetDiscovery(discover: boolean, failureLog: string): Promise<void> {
    await send("Target.setDiscoverTargets", { discover }).catch((err) => {
      if (failureLog) {
        log("warn", failureLog, { error: errorMessage(err) });
      }
    });
  }

  async function start(viewport?: Viewport): Promise<void> {
    if (started) {
      return;
    }
    await ensureOpen();
    await setTargetDiscovery(true, "cdp_target_discovery_failed");
    serverBackend = createServerBackend(viewport);
    backendLifecycle = await serverBackend.start(
      viewport === null || viewport === undefined ? undefined : (viewport as RemoteSurfaceViewportPayload)
    );
    backendLifecycleSubscription = backendLifecycle.onEvent(emitRemoteSurfaceBackendEvent);
    started = true;
  }

  async function bestEffortSend(method: CdpMethod, params: CdpCommandParams = {}): Promise<void> {
    try {
      await send(method, params);
    } catch {
      /* best-effort */
    }
  }

  async function stopStreaming(): Promise<void> {
    if (!started) {
      return;
    }
    backendLifecycleSubscription?.unsubscribe();
    backendLifecycleSubscription = null;
    frameSessionSubscription?.unsubscribe();
    frameSessionSubscription = null;
    pendingFrameSessionIds.length = 0;
    pendingFrameMetadata.length = 0;
    backendLifecycle = null;
    await serverBackend?.stop().catch(() => {
      /* best-effort teardown */
    });
    serverBackend = null;
    await bestEffortSend("Target.setDiscoverTargets", { discover: false });
    started = false;
  }

  function closeSocket(): void {
    if (!ws) {
      return;
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  function clearCompanionState(): void {
    rejectAllPending(codedError("Streaming companion stopped", "companion_stopped"));
    openPromise = null;
    frameHandlers.clear();
    eventHandlers.clear();
    protocolEventHandlers.clear();
    lastFrame = null;
  }

  async function stop(): Promise<void> {
    if (closed) {
      return;
    }
    await stopStreaming();
    closed = true;
    closeSocket();
    clearCompanionState();
  }

  function onFrame(handler: CdpFrameHandler): () => boolean {
    frameHandlers.add(handler);
    if (lastFrame) {
      try {
        handler(lastFrame);
      } catch (err) {
        log("warn", "cdp_frame_handler_error", { error: errorMessage(err) });
      }
    }
    return () => frameHandlers.delete(handler);
  }

  function onEvent(handler: CdpEventHandler): () => boolean {
    eventHandlers.add(handler);
    return () => eventHandlers.delete(handler);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This adapter deliberately keeps the three assembled-session channels and the legacy CDP fallback in one explicit dispatch boundary.
  async function dispatch(event: unknown): Promise<void> {
    if (isObject(event) && typeof event.type === "string") {
      if (event.type === "pointer" || event.type === "keyboard" || event.type === "text") {
        if (!backendLifecycle) {
          throw codedError("Streaming companion is not started", "companion_not_started");
        }
        const normalized = event.type === "pointer" ? normalizeTouchPointerInputForCdp(event) : event;
        await backendLifecycle.input(normalized as unknown as RemoteSurfaceInputPayload);
        return;
      }
      if (event.type === "clipboard" && event.action === "local_to_remote") {
        if (!backendLifecycle) {
          throw codedError("Streaming companion is not started", "companion_not_started");
        }
        await backendLifecycle.clipboard?.(event as unknown as RemoteSurfaceClipboardPayload);
        return;
      }
      if (event.type === "viewport") {
        if (!backendLifecycle) {
          throw codedError("Streaming companion is not started", "companion_not_started");
        }
        await backendLifecycle.setViewport(event as unknown as RemoteSurfaceViewportPayload);
        return;
      }
    }
    const commands = mapInputEventToCdp(event);
    await commands.reduce(async (previous, cmd) => {
      await previous;
      // Errors here are surfaced to the route which returns a 4xx with the
      // CDP-side message. We do not retry: the viewer can resend.
      await send(cmd.method, cdpParams(cmd.params));
    }, Promise.resolve());
  }

  function readRemoteSelection(): Promise<string> {
    if (!backendLifecycle?.readRemoteSelection) {
      throw codedError("Remote selection is unavailable", "clipboard_unsupported");
    }
    return backendLifecycle.readRemoteSelection();
  }

  return {
    /** test-only escape hatch */
    _internal: {
      isClosed: () => closed,
      isStarted: () => started,
      send,
    },
    ackFrame: async () => {
      // CdpServerBackend acknowledges each frame as it receives it. The route
      // keeps this compatibility hook, but it must not send a second ack.
    },
    browser_session_id: browserSessionId,
    dispatch,
    onEvent,
    onFrame,
    readRemoteSelection,
    start,
    stop,
  };
}
