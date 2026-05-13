import type {
  JsonObject,
  JsonValue,
  RemoteSurfaceClipboardPayload,
  RemoteSurfaceEventPayload,
  RemoteSurfaceInputPayload,
  RemoteSurfaceViewportPayload,
} from "../protocol/index.ts";
import type { ViewportTransition } from "../client/viewport-classifier.ts";

export * from "./visual-quality.ts";

export type RemoteSurfaceDiagnosticsKind =
  | "adapter.lifecycle"
  | "backend.readiness"
  | "clipboard.action"
  | "event.channel"
  | "input.pipeline"
  | "media.settle"
  | "viewport.transition";

export type RemoteSurfaceInputClassification =
  | "clipboard-paste"
  | "keyboard"
  | "pointer"
  | "text"
  | "wheel";

export interface RemoteSurfaceDiagnosticReplay {
  readonly input?: JsonObject;
  readonly output: JsonObject;
}

interface BaseRemoteSurfaceDiagnosticsEvent {
  type: RemoteSurfaceDiagnosticsKind | string;
  timestamp: number;
  payload?: JsonObject;
  replay?: RemoteSurfaceDiagnosticReplay;
}

export interface InputPipelineDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
  type: "input.pipeline";
  payload: {
    classification: RemoteSurfaceInputClassification;
    inputType: RemoteSurfaceInputPayload["type"];
    action?: string;
    replayable: true;
  };
  replay: RemoteSurfaceDiagnosticReplay;
}

export interface ViewportTransitionDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
  type: "viewport.transition";
  payload: JsonObject & {
    kind: ViewportTransition["kind"];
    reason: string;
    remoteResize: ViewportTransition["remoteResize"];
    replayable: true;
  };
  replay: RemoteSurfaceDiagnosticReplay;
}

export interface ClipboardActionDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
  type: "clipboard.action";
  payload: JsonObject & {
    action: RemoteSurfaceClipboardPayload["action"];
    textLengthBucket?: string;
  };
}

export interface EventChannelDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
  type: "event.channel";
  payload: JsonObject & {
    eventType?: RemoteSurfaceEventPayload["type"];
    state?: string;
  };
}

export interface AdapterLifecycleDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
  type: "adapter.lifecycle";
  payload: JsonObject & {
    adapter: string;
    lifecycle: "created" | "ready" | "closed" | "error" | "revoked";
  };
}

export interface BackendReadinessDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
  type: "backend.readiness";
  payload: JsonObject & {
    backend: string;
    ready: boolean;
  };
}

export interface MediaSettleDiagnosticsEvent extends BaseRemoteSurfaceDiagnosticsEvent {
  type: "media.settle";
  payload: JsonObject & {
    status: "degraded" | "settled" | "settling";
  };
}

export type RemoteSurfaceDiagnosticsEvent =
  | AdapterLifecycleDiagnosticsEvent
  | BackendReadinessDiagnosticsEvent
  | ClipboardActionDiagnosticsEvent
  | EventChannelDiagnosticsEvent
  | InputPipelineDiagnosticsEvent
  | MediaSettleDiagnosticsEvent
  | ViewportTransitionDiagnosticsEvent
  | BaseRemoteSurfaceDiagnosticsEvent;

export interface RedactDiagnosticsOptions {
  replacement?: string;
  redactKeys?: readonly string[];
}

export interface RemoteSurfaceDiagnosticsBuffer {
  push(event: RemoteSurfaceDiagnosticsEvent): RemoteSurfaceDiagnosticsEvent;
  read(cursor?: number): RemoteSurfaceDiagnosticsReadResult;
  subscribe(listener: RemoteSurfaceDiagnosticsListener): RemoteSurfaceDiagnosticsSubscription;
  clear(): void;
  size(): number;
}

export interface RemoteSurfaceDiagnosticsReadResult {
  cursor: number;
  events: readonly RemoteSurfaceDiagnosticsEvent[];
}

export type RemoteSurfaceDiagnosticsListener = (event: RemoteSurfaceDiagnosticsEvent) => void;

export interface RemoteSurfaceDiagnosticsSubscription {
  unsubscribe(): void;
}

const DEFAULT_REDACTED = "[redacted]";
const DEFAULT_SECRET_KEYS = new Set([
  "access_token",
  "accesstoken",
  "auth",
  "authmetadata",
  "allocatorcredential",
  "allocatorcredentials",
  "allocatorpassword",
  "allocatorsecret",
  "allocatortoken",
  "apikey",
  "api_key",
  "authorization",
  "bearer",
  "cdpurl",
  "cdpwsurl",
  "cdpendpoint",
  "cookie",
  "credential",
  "credentials",
  "headers",
  "password",
  "refresh_token",
  "refreshtoken",
  "secret",
  "secretkey",
  "secret_key",
  "session_token",
  "sessiontoken",
  "clipboard",
  "targeturl",
  "text",
  "token",
  "url",
  "websocketdebuggerurl",
]);

export function redactDiagnosticsEvent(
  event: RemoteSurfaceDiagnosticsEvent,
  options: RedactDiagnosticsOptions = {},
): RemoteSurfaceDiagnosticsEvent {
  const replacement = options.replacement ?? DEFAULT_REDACTED;
  const redactKeys = new Set(
    [...DEFAULT_SECRET_KEYS, ...(options.redactKeys ?? [])].map((key) => key.toLowerCase()),
  );
  const payload = event.payload ? redactJsonObject(event.payload, redactKeys, replacement) : undefined;
  const replay = event.replay ? redactJsonObject(event.replay as unknown as JsonObject, redactKeys, replacement) : undefined;
  return {
    ...event,
    ...(payload ? { payload } : {}),
    ...(replay ? { replay: replay as unknown as RemoteSurfaceDiagnosticReplay } : {}),
  };
}

export function createDiagnosticsBuffer(options: {
  capacity: number;
  redact?: boolean;
  redaction?: RedactDiagnosticsOptions;
}): RemoteSurfaceDiagnosticsBuffer {
  const capacity = Math.max(0, Math.floor(options.capacity));
  const events: RemoteSurfaceDiagnosticsEvent[] = [];
  const listeners = new Set<RemoteSurfaceDiagnosticsListener>();
  let offset = 0;
  return {
    push(event) {
      const stored = options.redact === false ? event : redactDiagnosticsEvent(event, options.redaction);
      if (capacity === 0) {
        offset += 1;
        notifyDiagnosticsListeners(listeners, stored);
        return stored;
      }
      events.push(stored);
      while (events.length > capacity) {
        events.shift();
        offset += 1;
      }
      notifyDiagnosticsListeners(listeners, stored);
      return stored;
    },
    read(cursor = offset) {
      const start = Math.max(offset, Math.floor(cursor));
      const index = start - offset;
      return {
        cursor: offset + events.length,
        events: events.slice(index),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return {
        unsubscribe() {
          listeners.delete(listener);
        },
      };
    },
    clear() {
      offset += events.length;
      events.length = 0;
    },
    size() {
      return events.length;
    },
  };
}

export function buildInputPipelineDiagnosticsEvent({
  payload,
  timestamp = payload.timestamp ?? Date.now(),
}: {
  payload: RemoteSurfaceInputPayload;
  timestamp?: number;
}): InputPipelineDiagnosticsEvent {
  const classification = classifyRemoteSurfaceInput(payload);
  const action = "action" in payload ? payload.action : undefined;
  return {
    type: "input.pipeline",
    timestamp,
    payload: {
      classification,
      inputType: payload.type,
      ...(action ? { action } : {}),
      replayable: true,
    },
    replay: {
      input: payload as unknown as JsonObject,
      output: {
        classification,
        inputType: payload.type,
        ...(action ? { action } : {}),
      },
    },
  };
}

export function buildViewportTransitionDiagnosticsEvent({
  next,
  previous,
  timestamp = next.timestamp ?? Date.now(),
  transition,
}: {
  next: RemoteSurfaceViewportPayload;
  previous?: RemoteSurfaceViewportPayload | null;
  timestamp?: number;
  transition: ViewportTransition;
}): ViewportTransitionDiagnosticsEvent {
  return {
    type: "viewport.transition",
    timestamp,
    payload: {
      kind: transition.kind,
      keyboardInsetBottom: transition.keyboardInsetBottom,
      reason: transition.reason,
      remoteResize: transition.remoteResize,
      replayable: true,
    },
    replay: {
      input: {
        next: next as unknown as JsonObject,
        previous: (previous ?? null) as unknown as JsonValue,
      },
      output: transition as unknown as JsonObject,
    },
  };
}

export function buildClipboardActionDiagnosticsEvent({
  payload,
  textLengthBucket,
  timestamp = payload.timestamp ?? Date.now(),
}: {
  payload: RemoteSurfaceClipboardPayload;
  textLengthBucket?: string;
  timestamp?: number;
}): ClipboardActionDiagnosticsEvent {
  return {
    type: "clipboard.action",
    timestamp,
    payload: {
      action: payload.action,
      ...(textLengthBucket ? { textLengthBucket } : {}),
    },
  };
}

export function buildEventChannelDiagnosticsEvent({
  event,
  state,
  timestamp = event?.timestamp ?? Date.now(),
}: {
  event?: RemoteSurfaceEventPayload;
  state?: string;
  timestamp?: number;
}): EventChannelDiagnosticsEvent {
  return {
    type: "event.channel",
    timestamp,
    payload: {
      ...(event ? { eventType: event.type } : {}),
      ...(state ? { state } : {}),
    },
  };
}

export function buildAdapterLifecycleDiagnosticsEvent({
  adapter,
  lifecycle,
  payload,
  timestamp = Date.now(),
}: {
  adapter: string;
  lifecycle: AdapterLifecycleDiagnosticsEvent["payload"]["lifecycle"];
  payload?: JsonObject;
  timestamp?: number;
}): AdapterLifecycleDiagnosticsEvent {
  return {
    type: "adapter.lifecycle",
    timestamp,
    payload: {
      ...(payload ?? {}),
      adapter,
      lifecycle,
    },
  };
}

export function buildBackendReadinessDiagnosticsEvent({
  backend,
  payload,
  ready,
  timestamp = Date.now(),
}: {
  backend: string;
  payload?: JsonObject;
  ready: boolean;
  timestamp?: number;
}): BackendReadinessDiagnosticsEvent {
  return {
    type: "backend.readiness",
    timestamp,
    payload: {
      ...(payload ?? {}),
      backend,
      ready,
    },
  };
}

export function buildMediaSettleDiagnosticsEvent({
  payload,
  status,
  timestamp = Date.now(),
}: {
  payload?: JsonObject;
  status: MediaSettleDiagnosticsEvent["payload"]["status"];
  timestamp?: number;
}): MediaSettleDiagnosticsEvent {
  return {
    type: "media.settle",
    timestamp,
    payload: {
      ...(payload ?? {}),
      status,
    },
  };
}

export function classifyRemoteSurfaceInput(payload: RemoteSurfaceInputPayload): RemoteSurfaceInputClassification {
  if (payload.type === "pointer" && payload.action === "wheel") {
    return "wheel";
  }
  if (payload.type === "clipboard") {
    return "clipboard-paste";
  }
  return payload.type;
}

function notifyDiagnosticsListeners(
  listeners: Set<RemoteSurfaceDiagnosticsListener>,
  event: RemoteSurfaceDiagnosticsEvent,
): void {
  for (const listener of listeners) {
    listener(event);
  }
}

function redactJsonValue(value: JsonValue, redactKeys: Set<string>, replacement: string): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, redactKeys, replacement));
  }
  if (value && typeof value === "object") {
    return redactJsonObject(value, redactKeys, replacement);
  }
  if (typeof value === "string" && looksSensitiveString(value)) {
    return replacement;
  }
  return value;
}

function redactJsonObject(value: JsonObject, redactKeys: Set<string>, replacement: string): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactKeys.has(key.toLowerCase()) ? replacement : redactJsonValue(entry, redactKeys, replacement);
  }
  return out;
}

function looksSensitiveString(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith("bearer ") ||
    lower.startsWith("ws://") ||
    lower.startsWith("wss://") ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.includes("/devtools/browser/") ||
    lower.includes("/json/version") ||
    lower.includes("access_token=") ||
    lower.includes("authorization=") ||
    lower.includes("bearer%20") ||
    lower.includes("docker.sock")
  );
}
