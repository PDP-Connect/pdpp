import type { JsonObject, JsonValue } from "../protocol/index.ts";

export interface RemoteSurfaceDiagnosticsEvent {
  type: string;
  timestamp: number;
  payload?: JsonObject;
}

export interface RedactDiagnosticsOptions {
  replacement?: string;
  redactKeys?: readonly string[];
}

export interface RemoteSurfaceDiagnosticsBuffer {
  push(event: RemoteSurfaceDiagnosticsEvent): RemoteSurfaceDiagnosticsEvent;
  read(cursor?: number): RemoteSurfaceDiagnosticsReadResult;
  clear(): void;
  size(): number;
}

export interface RemoteSurfaceDiagnosticsReadResult {
  cursor: number;
  events: readonly RemoteSurfaceDiagnosticsEvent[];
}

const DEFAULT_REDACTED = "[redacted]";
const DEFAULT_SECRET_KEYS = new Set([
  "access_token",
  "accesstoken",
  "allocatorcredential",
  "allocatorcredentials",
  "apikey",
  "api_key",
  "authorization",
  "cdpurl",
  "cdpwsurl",
  "cookie",
  "credential",
  "credentials",
  "password",
  "refresh_token",
  "refreshtoken",
  "secret",
  "secretkey",
  "secret_key",
  "session_token",
  "sessiontoken",
  "clipboard",
  "text",
  "token",
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
  return payload ? { ...event, payload } : { type: event.type, timestamp: event.timestamp };
}

export function createDiagnosticsBuffer(options: {
  capacity: number;
  redact?: boolean;
  redaction?: RedactDiagnosticsOptions;
}): RemoteSurfaceDiagnosticsBuffer {
  const capacity = Math.max(0, Math.floor(options.capacity));
  const events: RemoteSurfaceDiagnosticsEvent[] = [];
  let offset = 0;
  return {
    push(event) {
      const stored = options.redact === false ? event : redactDiagnosticsEvent(event, options.redaction);
      if (capacity === 0) {
        offset += 1;
        return stored;
      }
      events.push(stored);
      while (events.length > capacity) {
        events.shift();
        offset += 1;
      }
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
    clear() {
      offset += events.length;
      events.length = 0;
    },
    size() {
      return events.length;
    },
  };
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
    lower.includes("/devtools/browser/") ||
    lower.includes("docker.sock")
  );
}
