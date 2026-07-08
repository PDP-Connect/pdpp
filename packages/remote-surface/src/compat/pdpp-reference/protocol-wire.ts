import { RemoteSurfaceProtocolError } from "../../protocol/errors.ts";

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

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

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
