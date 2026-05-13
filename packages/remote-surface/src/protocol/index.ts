export type RemoteSurfaceId = string;
export type RemoteSurfaceSessionId = RemoteSurfaceId;
export type RemoteSurfaceTargetId = RemoteSurfaceId;
export type RemoteSurfaceTokenId = RemoteSurfaceId;
export type RemoteSurfaceBackendKind = "neko" | "cdp" | "vnc" | "kasm" | "custom";

export type RemoteSurfaceRevocationReason =
  | "expired"
  | "superseded"
  | "resolved"
  | "host_cancelled"
  | "target_unavailable"
  | "backend_error"
  | "invalidated";

export interface RemoteSurfaceCapabilities {
  eventChannel: "sse" | "websocket" | "poll" | "none";
  input: readonly RemoteSurfaceInputMode[];
  clipboard: readonly RemoteSurfaceClipboardMode[];
  viewport: readonly RemoteSurfaceViewportMode[];
  diagnostics: readonly RemoteSurfaceDiagnosticsMode[];
  ownerBrowser: boolean;
  serverSideAutomationEndpoint: boolean;
}

export type RemoteSurfaceInputMode =
  | "pointer"
  | "keyboard"
  | "keysym"
  | "text"
  | "paste"
  | "touch"
  | "scroll";
export type RemoteSurfaceClipboardMode = "local_to_remote" | "remote_to_local" | "manual_fallback";
export type RemoteSurfaceViewportMode = "report" | "resize" | "classify_occlusion";
export type RemoteSurfaceDiagnosticsMode = "events" | "replay" | "redacted_buffer";

export interface RemoteSurfaceTokenDescriptor {
  tokenId: RemoteSurfaceTokenId;
  sessionId: RemoteSurfaceSessionId;
  issuedAt: number;
  expiresAt: number;
  scopes: readonly RemoteSurfaceTokenScope[];
}

export type RemoteSurfaceTokenScope =
  | "attach"
  | "events"
  | "input"
  | "viewport"
  | "clipboard"
  | "diagnostics";

export interface RemoteSurfaceSessionDescriptor {
  sessionId: RemoteSurfaceSessionId;
  targetId?: RemoteSurfaceTargetId;
  backend?: RemoteSurfaceBackendKind;
  capabilities: RemoteSurfaceCapabilities;
  issuedAt: number;
  expiresAt: number;
  attachedAt?: number;
  revokedAt?: number;
  revocationReason?: RemoteSurfaceRevocationReason;
  hostMetadata?: Readonly<Record<string, JsonValue>>;
}

export interface RemoteSurfaceTargetDescriptor {
  targetId: RemoteSurfaceTargetId;
  backend: RemoteSurfaceBackendKind;
  label?: string;
  capabilities: RemoteSurfaceCapabilities;
  clientDescriptor?: SafeRemoteSurfaceBackendDescriptor;
  hostMetadata?: Readonly<Record<string, JsonValue>>;
}

export interface SafeRemoteSurfaceBackendDescriptor {
  backend: RemoteSurfaceBackendKind;
  capabilities: RemoteSurfaceCapabilities;
  proxy?: RemoteSurfaceProxyDescriptor;
  session?: RemoteSurfaceClientSessionDescriptor;
}

export interface RemoteSurfaceProxyDescriptor {
  path: string;
  sameOrigin: true;
  allowedMethods?: readonly string[];
}

export interface RemoteSurfaceClientSessionDescriptor {
  path: string;
  sameOrigin: true;
  expiresAt?: number;
}

export type RemoteSurfaceFrameEvent = {
  type: "frame";
  sessionId: RemoteSurfaceSessionId;
  sequence: number;
  contentType: "image/jpeg" | "image/png";
  data: string;
  timestamp: number;
};

export type RemoteSurfaceBackendEvent = {
  type: "backend_event";
  sessionId: RemoteSurfaceSessionId;
  name: string;
  payload?: JsonObject;
  timestamp: number;
};

export type RemoteSurfaceLifecycleEvent = {
  type: "lifecycle";
  sessionId: RemoteSurfaceSessionId;
  state: "created" | "attached" | "ready" | "revoked" | "closed" | "error";
  reason?: string;
  timestamp: number;
};

export type RemoteSurfaceEventPayload =
  | RemoteSurfaceFrameEvent
  | RemoteSurfaceBackendEvent
  | RemoteSurfaceLifecycleEvent;

export type RemoteSurfaceInputPayload =
  | RemoteSurfacePointerInput
  | RemoteSurfaceKeyboardInput
  | RemoteSurfaceTextInput
  | RemoteSurfaceClipboardInput;

export interface RemoteSurfacePointerInput {
  type: "pointer";
  action: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "wheel";
  x: number;
  y: number;
  pointerType?: "mouse" | "touch" | "pen";
  pointerId?: number;
  button?: number;
  buttons?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: readonly RemoteSurfaceKeyModifier[];
  timestamp?: number;
}

export interface RemoteSurfaceKeyboardInput {
  type: "keyboard";
  action: "keydown" | "keyup" | "keypress";
  key?: string;
  code?: string;
  keysym?: number;
  modifiers?: readonly RemoteSurfaceKeyModifier[];
  timestamp?: number;
}

export interface RemoteSurfaceTextInput {
  type: "text";
  text: string;
  composition?: "start" | "update" | "commit" | "cancel";
  timestamp?: number;
}

export interface RemoteSurfaceClipboardInput {
  type: "clipboard";
  action: "paste";
  text: string;
  timestamp?: number;
}

export type RemoteSurfaceKeyModifier = "Alt" | "Control" | "Meta" | "Shift";

export interface RemoteSurfaceViewportPayload {
  type: "viewport";
  width: number;
  height: number;
  deviceScaleFactor?: number;
  screenWidth?: number;
  screenHeight?: number;
  hasTouch?: boolean;
  mobile?: boolean;
  orientation?: "portrait" | "landscape";
  visualViewport?: RemoteSurfaceVisualViewport;
  keyboardOcclusion?: RemoteSurfaceKeyboardOcclusion;
  timestamp?: number;
}

export interface RemoteSurfaceVisualViewport {
  width: number;
  height: number;
  offsetTop?: number;
  offsetLeft?: number;
  scale?: number;
}

export interface RemoteSurfaceKeyboardOcclusion {
  visible: boolean;
  height: number;
  reason?: "software_keyboard" | "browser_chrome" | "unknown";
}

export type RemoteSurfaceClipboardPayload =
  | {
      type: "clipboard";
      action: "local_to_remote";
      text: string;
      timestamp?: number;
    }
  | {
      type: "clipboard";
      action: "remote_to_local";
      text?: string;
      requestId?: string;
      timestamp?: number;
    }
  | {
      type: "clipboard";
      action: "capabilities";
      canReadLocal: boolean;
      canWriteLocal: boolean;
      canReadRemote: boolean;
      canWriteRemote: boolean;
      timestamp?: number;
    };

export interface RemoteSurfaceDiagnosticsPayload {
  type: "diagnostics";
  cursor?: string;
  events: readonly JsonObject[];
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export type ReferenceWireInputPayload = Record<string, unknown>;

export interface ReferenceWireViewportPayload {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  screenWidth?: number;
  screenHeight?: number;
  hasTouch?: boolean;
  mobile?: true;
  userAgent?: string;
}

export interface ReferenceWireInputTelemetryCursor {
  since: number;
}

export interface ReferenceWireInputTelemetryRecord {
  readonly [key: string]: JsonValue | undefined;
  seq?: number;
  serverAtMs?: number;
  source?: string;
  kind?: string;
}

export interface ReferenceWireBackendReadyPayload {
  backend: string;
  browser_owner_mode: string | null;
  client_config_path: string | null;
  iframe_path: string | null;
  stealth_mode: string | null;
}

export interface ReferenceWireAttachedPayload {
  run_id: string;
  interaction_id: string;
  browser_session_id: string;
  viewport: JsonValue;
}

export interface ReferenceWireFramePayload {
  session_id: number;
  data_base64: string;
  metadata: JsonValue;
}

export interface ReferenceWireNamedSseEvent {
  name: string;
  data: unknown;
}

export class RemoteSurfaceProtocolError extends Error {
  readonly path: string;

  constructor(message: string, path = "$") {
    super(`${path}: ${message}`);
    this.name = "RemoteSurfaceProtocolError";
    this.path = path;
  }
}

export function parseRemoteSurfaceEventPayload(value: unknown): RemoteSurfaceEventPayload {
  const payload = requireRecord(value);
  const type = requireString(payload.type, "$.type");
  if (type === "frame") {
    return {
      type,
      sessionId: requireString(payload.sessionId, "$.sessionId"),
      sequence: requireFiniteNumber(payload.sequence, "$.sequence"),
      contentType: requireOneOf(payload.contentType, ["image/jpeg", "image/png"], "$.contentType"),
      data: requireString(payload.data, "$.data"),
      timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp"),
    };
  }
  if (type === "backend_event") {
    return {
      type,
      sessionId: requireString(payload.sessionId, "$.sessionId"),
      name: requireString(payload.name, "$.name"),
      ...(payload.payload === undefined ? {} : { payload: requireJsonObject(payload.payload, "$.payload") }),
      timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp"),
    };
  }
  if (type === "lifecycle") {
    return {
      type,
      sessionId: requireString(payload.sessionId, "$.sessionId"),
      state: requireOneOf(payload.state, ["created", "attached", "ready", "revoked", "closed", "error"], "$.state"),
      ...(payload.reason === undefined ? {} : { reason: requireString(payload.reason, "$.reason") }),
      timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp"),
    };
  }
  throw new RemoteSurfaceProtocolError("unsupported event payload type", "$.type");
}

export function parseRemoteSurfaceInputPayload(value: unknown): RemoteSurfaceInputPayload {
  const payload = requireRecord(value);
  const type = requireString(payload.type, "$.type");
  if (type === "pointer") {
    return {
      type,
      action: requireOneOf(
        payload.action,
        ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel"],
        "$.action",
      ),
      x: requireFiniteNumber(payload.x, "$.x"),
      y: requireFiniteNumber(payload.y, "$.y"),
      ...(payload.pointerType === undefined
        ? {}
        : { pointerType: requireOneOf(payload.pointerType, ["mouse", "touch", "pen"], "$.pointerType") }),
      ...(payload.pointerId === undefined ? {} : { pointerId: requireFiniteNumber(payload.pointerId, "$.pointerId") }),
      ...(payload.button === undefined ? {} : { button: requireFiniteNumber(payload.button, "$.button") }),
      ...(payload.buttons === undefined ? {} : { buttons: requireFiniteNumber(payload.buttons, "$.buttons") }),
      ...(payload.deltaX === undefined ? {} : { deltaX: requireFiniteNumber(payload.deltaX, "$.deltaX") }),
      ...(payload.deltaY === undefined ? {} : { deltaY: requireFiniteNumber(payload.deltaY, "$.deltaY") }),
      ...(payload.modifiers === undefined ? {} : { modifiers: parseModifiers(payload.modifiers, "$.modifiers") }),
      ...(payload.timestamp === undefined ? {} : { timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp") }),
    };
  }
  if (type === "keyboard") {
    return {
      type,
      action: requireOneOf(payload.action, ["keydown", "keyup", "keypress"], "$.action"),
      ...(payload.key === undefined ? {} : { key: requireString(payload.key, "$.key") }),
      ...(payload.code === undefined ? {} : { code: requireString(payload.code, "$.code") }),
      ...(payload.keysym === undefined ? {} : { keysym: requireFiniteNumber(payload.keysym, "$.keysym") }),
      ...(payload.modifiers === undefined ? {} : { modifiers: parseModifiers(payload.modifiers, "$.modifiers") }),
      ...(payload.timestamp === undefined ? {} : { timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp") }),
    };
  }
  if (type === "text") {
    return {
      type,
      text: requireString(payload.text, "$.text"),
      ...(payload.composition === undefined
        ? {}
        : { composition: requireOneOf(payload.composition, ["start", "update", "commit", "cancel"], "$.composition") }),
      ...(payload.timestamp === undefined ? {} : { timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp") }),
    };
  }
  if (type === "clipboard") {
    return {
      type,
      action: requireOneOf(payload.action, ["paste"], "$.action"),
      text: requireString(payload.text, "$.text"),
      ...(payload.timestamp === undefined ? {} : { timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp") }),
    };
  }
  throw new RemoteSurfaceProtocolError("unsupported input payload type", "$.type");
}

export function parseRemoteSurfaceViewportPayload(value: unknown): RemoteSurfaceViewportPayload {
  const payload = requireRecord(value);
  const result: RemoteSurfaceViewportPayload = {
    type: requireOneOf(payload.type, ["viewport"], "$.type"),
    width: requirePositiveNumber(payload.width, "$.width"),
    height: requirePositiveNumber(payload.height, "$.height"),
    ...(payload.deviceScaleFactor === undefined
      ? {}
      : { deviceScaleFactor: requirePositiveNumber(payload.deviceScaleFactor, "$.deviceScaleFactor") }),
    ...(payload.screenWidth === undefined ? {} : { screenWidth: requirePositiveNumber(payload.screenWidth, "$.screenWidth") }),
    ...(payload.screenHeight === undefined
      ? {}
      : { screenHeight: requirePositiveNumber(payload.screenHeight, "$.screenHeight") }),
    ...(payload.hasTouch === undefined ? {} : { hasTouch: requireBoolean(payload.hasTouch, "$.hasTouch") }),
    ...(payload.mobile === undefined ? {} : { mobile: requireBoolean(payload.mobile, "$.mobile") }),
    ...(payload.orientation === undefined
      ? {}
      : { orientation: requireOneOf(payload.orientation, ["portrait", "landscape"], "$.orientation") }),
    ...(payload.timestamp === undefined ? {} : { timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp") }),
  };
  if (payload.visualViewport !== undefined) {
    const visualViewport = requireRecord(payload.visualViewport, "$.visualViewport");
    result.visualViewport = {
      width: requirePositiveNumber(visualViewport.width, "$.visualViewport.width"),
      height: requirePositiveNumber(visualViewport.height, "$.visualViewport.height"),
      ...(visualViewport.offsetTop === undefined
        ? {}
        : { offsetTop: requireFiniteNumber(visualViewport.offsetTop, "$.visualViewport.offsetTop") }),
      ...(visualViewport.offsetLeft === undefined
        ? {}
        : { offsetLeft: requireFiniteNumber(visualViewport.offsetLeft, "$.visualViewport.offsetLeft") }),
      ...(visualViewport.scale === undefined
        ? {}
        : { scale: requirePositiveNumber(visualViewport.scale, "$.visualViewport.scale") }),
    };
  }
  if (payload.keyboardOcclusion !== undefined) {
    const keyboardOcclusion = requireRecord(payload.keyboardOcclusion, "$.keyboardOcclusion");
    result.keyboardOcclusion = {
      visible: requireBoolean(keyboardOcclusion.visible, "$.keyboardOcclusion.visible"),
      height: requireFiniteNumber(keyboardOcclusion.height, "$.keyboardOcclusion.height"),
      ...(keyboardOcclusion.reason === undefined
        ? {}
        : {
            reason: requireOneOf(
              keyboardOcclusion.reason,
              ["software_keyboard", "browser_chrome", "unknown"],
              "$.keyboardOcclusion.reason",
            ),
          }),
    };
  }
  return result;
}

export function parseRemoteSurfaceClipboardPayload(value: unknown): RemoteSurfaceClipboardPayload {
  const payload = requireRecord(value);
  requireOneOf(payload.type, ["clipboard"], "$.type");
  const action = requireOneOf(payload.action, ["local_to_remote", "remote_to_local", "capabilities"], "$.action");
  if (action === "local_to_remote") {
    return {
      type: "clipboard",
      action,
      text: requireString(payload.text, "$.text"),
      ...(payload.timestamp === undefined ? {} : { timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp") }),
    };
  }
  if (action === "remote_to_local") {
    return {
      type: "clipboard",
      action,
      ...(payload.text === undefined ? {} : { text: requireString(payload.text, "$.text") }),
      ...(payload.requestId === undefined ? {} : { requestId: requireString(payload.requestId, "$.requestId") }),
      ...(payload.timestamp === undefined ? {} : { timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp") }),
    };
  }
  return {
    type: "clipboard",
    action,
    canReadLocal: requireBoolean(payload.canReadLocal, "$.canReadLocal"),
    canWriteLocal: requireBoolean(payload.canWriteLocal, "$.canWriteLocal"),
    canReadRemote: requireBoolean(payload.canReadRemote, "$.canReadRemote"),
    canWriteRemote: requireBoolean(payload.canWriteRemote, "$.canWriteRemote"),
    ...(payload.timestamp === undefined ? {} : { timestamp: requireFiniteNumber(payload.timestamp, "$.timestamp") }),
  };
}

export function parseRemoteSurfaceDiagnosticsPayload(value: unknown): RemoteSurfaceDiagnosticsPayload {
  const payload = requireRecord(value);
  requireOneOf(payload.type, ["diagnostics"], "$.type");
  const events = requireArray(payload.events, "$.events").map((event, index) =>
    requireJsonObject(event, `$.events[${index}]`),
  );
  return {
    type: "diagnostics",
    ...(payload.cursor === undefined ? {} : { cursor: requireString(payload.cursor, "$.cursor") }),
    events,
  };
}

export function parseReferenceWireInputPayload(value: unknown): ReferenceWireInputPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function normalizeReferenceWireViewportPayload(value: unknown): ReferenceWireViewportPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const width = Number(input.width);
  const height = Number(input.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const out: ReferenceWireViewportPayload = { width: Math.floor(width), height: Math.floor(height) };
  const deviceScaleFactor = Number(input.deviceScaleFactor);
  if (Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0) {
    out.deviceScaleFactor = deviceScaleFactor;
  }
  const screenWidth = Number(input.screenWidth);
  if (Number.isFinite(screenWidth) && screenWidth > 0) {
    out.screenWidth = Math.max(out.width, Math.floor(screenWidth));
  }
  const screenHeight = Number(input.screenHeight);
  if (Number.isFinite(screenHeight) && screenHeight > 0) {
    out.screenHeight = Math.max(out.height, Math.floor(screenHeight));
  }
  if (typeof input.hasTouch === "boolean") out.hasTouch = input.hasTouch;
  if (input.mobile === true) out.mobile = true;
  if (typeof input.userAgent === "string" && input.userAgent.length > 0) {
    out.userAgent = input.userAgent.slice(0, 512);
  }
  return out;
}

export function parseReferenceWireInputTelemetryCursor(value: unknown): ReferenceWireInputTelemetryCursor {
  const sinceRaw = typeof value === "string" ? Number(value) : 0;
  return { since: Number.isFinite(sinceRaw) ? sinceRaw : 0 };
}

export function parseReferenceWireInputTelemetryRecord(value: unknown): ReferenceWireInputTelemetryRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = requireJsonObject(value, "$");
  return record as ReferenceWireInputTelemetryRecord;
}

export function buildReferenceWireAttachedPayload({
  runId,
  interactionId,
  browserSessionId,
  viewport,
}: {
  runId: string;
  interactionId: string;
  browserSessionId: string;
  viewport: unknown;
}): ReferenceWireAttachedPayload {
  return {
    run_id: runId,
    interaction_id: interactionId,
    browser_session_id: browserSessionId,
    viewport: toJsonValueOrNull(viewport),
  };
}

export function buildReferenceWireFramePayload(frame: {
  sessionId?: unknown;
  data?: unknown;
  metadata?: unknown;
}): ReferenceWireFramePayload {
  return {
    session_id: typeof frame.sessionId === "number" ? frame.sessionId : Number(frame.sessionId),
    data_base64: typeof frame.data === "string" ? frame.data : "",
    metadata: frame.metadata ? toJsonValueOrNull(frame.metadata) : null,
  };
}

export function buildReferenceWireCompanionEventPayload(event: unknown): ReferenceWireNamedSseEvent | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const record = event as Record<string, unknown>;
  if (typeof record.kind !== "string") return null;
  switch (record.kind) {
    case "url_changed": {
      const data: Record<string, JsonValue> = { url: typeof record.url === "string" ? record.url : "" };
      if (typeof record.title === "string") data.title = record.title;
      return { name: "url_changed", data };
    }
    case "popup_opened":
      return {
        name: "popup_opened",
        data: {
          targetId: typeof record.targetId === "string" ? record.targetId : "",
          url: typeof record.url === "string" ? record.url : "",
        },
      };
    case "popup_closed":
      return {
        name: "popup_closed",
        data: { targetId: typeof record.targetId === "string" ? record.targetId : "" },
      };
    default:
      return { name: record.kind, data: event };
  }
}

export function buildReferenceWireBackendReadyPayload({
  backend,
  token,
  browserOwnerMode,
  stealthMode,
}: {
  backend: unknown;
  token: string;
  browserOwnerMode?: (() => unknown) | null;
  stealthMode?: (() => unknown) | null;
}): ReferenceWireBackendReadyPayload {
  const backendName = typeof backend === "string" ? backend : "cdp";
  const encodedToken = encodeURIComponent(token);
  return {
    backend: backendName,
    browser_owner_mode:
      backendName === "neko" && typeof browserOwnerMode === "function" ? nullableString(browserOwnerMode()) : null,
    client_config_path: backendName === "neko" ? `/_ref/run-interaction-streams/${encodedToken}/neko/session` : null,
    iframe_path: backendName === "neko" ? `/_ref/run-interaction-streams/${encodedToken}/neko` : null,
    stealth_mode: backendName === "neko" && typeof stealthMode === "function" ? nullableString(stealthMode()) : null,
  };
}

function toJsonValueOrNull(value: unknown): JsonValue {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string") return value as string;
  if (type === "boolean") return value as boolean;
  if (type === "number") {
    const numberValue = value as number;
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  if (Array.isArray(value)) return value.map(toJsonValueOrNull);
  if (type !== "object") return null;
  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child !== undefined) out[key] = toJsonValueOrNull(child);
  }
  return out;
}

export function parseSafeRemoteSurfaceBackendDescriptor(value: unknown): SafeRemoteSurfaceBackendDescriptor {
  const descriptor = requireRecord(value);
  assertNoUnsafeDescriptor(descriptor);
  const candidate: SafeRemoteSurfaceBackendDescriptor = {
    backend: parseBackendKind(descriptor.backend, "$.backend"),
    capabilities: parseCapabilities(descriptor.capabilities, "$.capabilities"),
  };
  if (descriptor.proxy !== undefined) {
    const proxy = requireRecord(descriptor.proxy, "$.proxy");
    candidate.proxy = {
      path: requireSafeSameOriginPath(proxy.path, "$.proxy.path"),
      sameOrigin: requireOneOf(proxy.sameOrigin, [true], "$.proxy.sameOrigin"),
      ...(proxy.allowedMethods === undefined
        ? {}
        : {
            allowedMethods: requireArray(proxy.allowedMethods, "$.proxy.allowedMethods").map((method, index) =>
              requireString(method, `$.proxy.allowedMethods[${index}]`),
            ),
          }),
    };
  }
  if (descriptor.session !== undefined) {
    const session = requireRecord(descriptor.session, "$.session");
    candidate.session = {
      path: requireSafeSameOriginPath(session.path, "$.session.path"),
      sameOrigin: requireOneOf(session.sameOrigin, [true], "$.session.sameOrigin"),
      ...(session.expiresAt === undefined ? {} : { expiresAt: requireFiniteNumber(session.expiresAt, "$.session.expiresAt") }),
    };
  }
  assertNoUnsafeDescriptor(candidate);
  return candidate;
}

export function parseRemoteSurfaceTargetDescriptor(value: unknown): RemoteSurfaceTargetDescriptor {
  const descriptor = requireRecord(value);
  const candidate: RemoteSurfaceTargetDescriptor = {
    targetId: requireString(descriptor.targetId, "$.targetId"),
    backend: parseBackendKind(descriptor.backend, "$.backend"),
    capabilities: parseCapabilities(descriptor.capabilities, "$.capabilities"),
    ...(descriptor.label === undefined ? {} : { label: requireString(descriptor.label, "$.label") }),
    ...(descriptor.clientDescriptor === undefined
      ? {}
      : { clientDescriptor: parseSafeRemoteSurfaceBackendDescriptor(descriptor.clientDescriptor) }),
    ...(descriptor.hostMetadata === undefined ? {} : { hostMetadata: requireJsonObject(descriptor.hostMetadata, "$.hostMetadata") }),
  };
  if (candidate.clientDescriptor) assertNoUnsafeDescriptor(candidate.clientDescriptor);
  return candidate;
}

const UNSAFE_DESCRIPTOR_KEYS = new Set([
  "accesstoken",
  "access_token",
  "allocatorcredential",
  "allocatorcredentials",
  "apikey",
  "api_key",
  "password",
  "authorization",
  "cdphttpurl",
  "cdpurl",
  "cdpwsurl",
  "clientsecret",
  "client_secret",
  "cookie",
  "credential",
  "credentials",
  "dockerhost",
  "dockersocket",
  "refreshtoken",
  "refresh_token",
  "secret",
  "secretkey",
  "secret_key",
  "sessiontoken",
  "session_token",
  "token",
  "websocketdebuggerurl",
  "wsendpoint",
]);

export function isSafeRemoteSurfaceBackendDescriptor(
  descriptor: SafeRemoteSurfaceBackendDescriptor,
): boolean {
  return findUnsafeDescriptorPaths(descriptor).length === 0;
}

export function assertNoUnsafeDescriptor(value: unknown): void {
  const paths = findUnsafeDescriptorPaths(value);
  if (paths.length > 0) {
    throw new RemoteSurfaceProtocolError(`unsafe browser-visible descriptor fields: ${paths.join(", ")}`);
  }
}

export function findUnsafeDescriptorPaths(value: unknown, path = "$"): string[] {
  const paths: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      paths.push(...findUnsafeDescriptorPaths(entry, `${path}[${index}]`));
    });
    return paths;
  }
  if (!value || typeof value !== "object") return paths;
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (UNSAFE_DESCRIPTOR_KEYS.has(key.toLowerCase())) {
      paths.push(childPath);
      continue;
    }
    if (typeof entry === "string" && looksLikeUnsafeEndpoint(entry)) {
      paths.push(childPath);
      continue;
    }
    paths.push(...findUnsafeDescriptorPaths(entry, childPath));
  }
  return paths;
}

function looksLikeUnsafeEndpoint(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith("ws://") ||
    lower.startsWith("wss://") ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.includes("/json/version") ||
    lower.includes("/devtools/browser/") ||
    lower.includes("docker.sock")
  );
}

function parseCapabilities(value: unknown, path: string): RemoteSurfaceCapabilities {
  const capabilities = requireRecord(value, path);
  return {
    eventChannel: requireOneOf(capabilities.eventChannel, ["sse", "websocket", "poll", "none"], `${path}.eventChannel`),
    input: requireArray(capabilities.input, `${path}.input`).map((mode, index) =>
      requireOneOf(
        mode,
        ["pointer", "keyboard", "keysym", "text", "paste", "touch", "scroll"],
        `${path}.input[${index}]`,
      ),
    ),
    clipboard: requireArray(capabilities.clipboard, `${path}.clipboard`).map((mode, index) =>
      requireOneOf(mode, ["local_to_remote", "remote_to_local", "manual_fallback"], `${path}.clipboard[${index}]`),
    ),
    viewport: requireArray(capabilities.viewport, `${path}.viewport`).map((mode, index) =>
      requireOneOf(mode, ["report", "resize", "classify_occlusion"], `${path}.viewport[${index}]`),
    ),
    diagnostics: requireArray(capabilities.diagnostics, `${path}.diagnostics`).map((mode, index) =>
      requireOneOf(mode, ["events", "replay", "redacted_buffer"], `${path}.diagnostics[${index}]`),
    ),
    ownerBrowser: requireBoolean(capabilities.ownerBrowser, `${path}.ownerBrowser`),
    serverSideAutomationEndpoint: requireBoolean(
      capabilities.serverSideAutomationEndpoint,
      `${path}.serverSideAutomationEndpoint`,
    ),
  };
}

function parseBackendKind(value: unknown, path: string): RemoteSurfaceBackendKind {
  return requireOneOf(value, ["neko", "cdp", "vnc", "kasm", "custom"], path);
}

function parseModifiers(value: unknown, path: string): readonly RemoteSurfaceKeyModifier[] {
  return requireArray(value, path).map((modifier, index) =>
    requireOneOf(modifier, ["Alt", "Control", "Meta", "Shift"], `${path}[${index}]`),
  );
}

function requireRecord(value: unknown, path = "$"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteSurfaceProtocolError("expected object", path);
  }
  return value as Record<string, unknown>;
}

function requireJsonObject(value: unknown, path: string): JsonObject {
  requireJsonValue(value, path);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteSurfaceProtocolError("expected JSON object", path);
  }
  return value as JsonObject;
}

function requireJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RemoteSurfaceProtocolError("expected finite JSON number", path);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => requireJsonValue(entry, `${path}[${index}]`));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = requireJsonValue(entry, `${path}.${key}`);
    }
    return result;
  }
  throw new RemoteSurfaceProtocolError("expected JSON value", path);
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new RemoteSurfaceProtocolError("expected array", path);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RemoteSurfaceProtocolError("expected non-empty string", path);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new RemoteSurfaceProtocolError("expected boolean", path);
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RemoteSurfaceProtocolError("expected finite number", path);
  }
  return value;
}

function requirePositiveNumber(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (number <= 0) throw new RemoteSurfaceProtocolError("expected positive number", path);
  return number;
}

function requireOneOf<const T extends readonly (boolean | number | string)[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (!allowed.includes(value as T[number])) {
    throw new RemoteSurfaceProtocolError(`expected one of ${allowed.join(", ")}`, path);
  }
  return value as T[number];
}

function requireSafeSameOriginPath(value: unknown, path: string): string {
  const stringValue = requireString(value, path);
  if (!stringValue.startsWith("/") || stringValue.startsWith("//") || looksLikeUnsafeEndpoint(stringValue)) {
    throw new RemoteSurfaceProtocolError("expected same-origin path", path);
  }
  return stringValue;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
export * from "./stream-viewer.ts";
