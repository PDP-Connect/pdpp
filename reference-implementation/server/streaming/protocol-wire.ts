interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface ReferenceWireViewportPayload {
  deviceScaleFactor?: number;
  hasTouch?: boolean;
  height: number;
  mobile?: true;
  screenHeight?: number;
  screenWidth?: number;
  userAgent?: string;
  width: number;
}

export function parseReferenceWireInputPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function normalizeReferenceWireViewportPayload(value: unknown): ReferenceWireViewportPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const width = Math.floor(Number(input.width));
  const height = Math.floor(Number(input.height));
  if (!(Number.isFinite(width) && Number.isFinite(height)) || width <= 0 || height <= 0) {
    return null;
  }

  const viewport: ReferenceWireViewportPayload = {
    width,
    height,
  };
  const deviceScaleFactor = Number(input.deviceScaleFactor);
  if (Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0) {
    viewport.deviceScaleFactor = deviceScaleFactor;
  }
  const screenWidth = Number(input.screenWidth);
  if (Number.isFinite(screenWidth) && screenWidth > 0) {
    viewport.screenWidth = Math.max(viewport.width, Math.floor(screenWidth));
  }
  const screenHeight = Number(input.screenHeight);
  if (Number.isFinite(screenHeight) && screenHeight > 0) {
    viewport.screenHeight = Math.max(viewport.height, Math.floor(screenHeight));
  }
  if (typeof input.hasTouch === "boolean") {
    viewport.hasTouch = input.hasTouch;
  }
  if (input.mobile === true) {
    viewport.mobile = true;
  }
  if (typeof input.userAgent === "string" && input.userAgent.length > 0) {
    viewport.userAgent = input.userAgent.slice(0, 512);
  }
  return viewport;
}

export function parseReferenceWireInputTelemetryCursor(value: unknown): { since: number } {
  const sinceRaw = typeof value === "string" ? Number(value) : 0;
  return { since: Number.isFinite(sinceRaw) ? sinceRaw : 0 };
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
}): JsonObject {
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
}): JsonObject {
  return {
    session_id: typeof frame.sessionId === "number" ? frame.sessionId : Number(frame.sessionId),
    data_base64: typeof frame.data === "string" ? frame.data : "",
    metadata: frame.metadata ? toJsonValueOrNull(frame.metadata) : null,
  };
}

export function buildReferenceWireCompanionEventPayload(event: unknown): { name: string; data: unknown } | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const record = event as Record<string, unknown>;
  if (typeof record.kind !== "string") {
    return null;
  }

  switch (record.kind) {
    case "url_changed": {
      const data: Record<string, JsonValue> = {
        url: typeof record.url === "string" ? record.url : "",
      };
      if (typeof record.title === "string") {
        data.title = record.title;
      }
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
}): JsonObject {
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
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValueOrNull);
  }
  if (typeof value !== "object") {
    return null;
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child !== undefined) {
      result[key] = toJsonValueOrNull(child);
    }
  }
  return result;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
