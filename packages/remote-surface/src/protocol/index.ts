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
    lower.includes("/json/version") ||
    lower.includes("/devtools/browser/") ||
    lower.includes("docker.sock")
  );
}
