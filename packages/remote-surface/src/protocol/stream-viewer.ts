export interface FrameMessage {
  data_base64: string;
  metadata?: { device_height?: number | undefined; device_width?: number | undefined } | null | undefined;
  session_id?: number | undefined;
}

/**
 * @deprecated Reference-shaped `AttachedMessage` and `parseAttachedMessage`
 *   moved to `@opendatalabs/remote-surface/reference`. These re-exports
 *   are preserved for the deprecation horizon recorded in the
 *   `republish-remote-surface-as-opendatalabs` OpenSpec change
 *   (planned removal: first post-publish minor). Import from the
 *   `./reference` subpath instead.
 */
export { parseAttachedMessage } from "../compat/pdpp-reference/stream-viewer-protocol.ts";
export type { AttachedMessage } from "../compat/pdpp-reference/stream-viewer-protocol.ts";

export interface BackendReadyMessage {
  backend: "cdp" | "neko" | string;
  browser_owner_mode?: string | null | undefined;
  client_config_path?: string | null | undefined;
  iframe_path?: string | null | undefined;
  stealth_mode?: string | null | undefined;
}

export interface UrlChangedMessage {
  title?: string | undefined;
  url: string;
}

export interface PopupOpenedMessage {
  targetId: string;
  url?: string | undefined;
}

export interface PopupClosedMessage {
  targetId: string;
}

export interface ClipboardMessage {
  text?: string;
}

export interface KeyboardFocusMessage {
  element?: {
    inputType?: string | undefined;
    tagName?: string | undefined;
  } | null | undefined;
  focused: boolean;
}

export interface StreamErrorMessage {
  code?: string | undefined;
  message?: string | undefined;
}

export type ProtocolParseResult<T> = { ok: true; value: T } | { error: string; ok: false };

type JsonObject = Record<string, unknown>;

function ok<T>(value: T): ProtocolParseResult<T> {
  return { ok: true, value };
}

function err<T>(error: string): ProtocolParseResult<T> {
  return { error, ok: false };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(data: string): ProtocolParseResult<JsonObject> {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isObject(parsed)) {
      return err("payload_not_object");
    }
    return ok(parsed);
  } catch {
    return err("payload_invalid_json");
  }
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function requiredString(payload: JsonObject, key: string): ProtocolParseResult<string> {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? ok(value) : err(`${key}_missing`);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOptionalFrameMetadata(value: unknown): FrameMessage["metadata"] {
  if (!isObject(value)) {
    return value === null ? null : undefined;
  }
  return {
    device_height: optionalNumber(value.device_height),
    device_width: optionalNumber(value.device_width),
  };
}

export function parseFrameMessage(data: string): ProtocolParseResult<FrameMessage> {
  const parsed = parseJsonObject(data);
  if (!parsed.ok) {
    return parsed;
  }
  const dataBase64 = requiredString(parsed.value, "data_base64");
  if (!dataBase64.ok) {
    return dataBase64;
  }
  return ok({
    data_base64: dataBase64.value,
    metadata: parseOptionalFrameMetadata(parsed.value.metadata),
    session_id: optionalNumber(parsed.value.session_id),
  });
}

export function parseBackendReadyMessage(data: string): ProtocolParseResult<BackendReadyMessage> {
  const parsed = parseJsonObject(data);
  if (!parsed.ok) {
    return parsed;
  }
  const backend = requiredString(parsed.value, "backend");
  if (!backend.ok) {
    return backend;
  }
  return ok({
    backend: backend.value,
    browser_owner_mode: optionalString(parsed.value.browser_owner_mode),
    client_config_path: optionalString(parsed.value.client_config_path),
    iframe_path: optionalString(parsed.value.iframe_path),
    stealth_mode: optionalString(parsed.value.stealth_mode),
  });
}

export function parseUrlChangedMessage(data: string): ProtocolParseResult<UrlChangedMessage> {
  const parsed = parseJsonObject(data);
  if (!parsed.ok) {
    return parsed;
  }
  const url = requiredString(parsed.value, "url");
  if (!url.ok) {
    return url;
  }
  return ok({
    title: optionalString(parsed.value.title) ?? undefined,
    url: url.value,
  });
}

export function parsePopupOpenedMessage(data: string): ProtocolParseResult<PopupOpenedMessage> {
  const parsed = parseJsonObject(data);
  if (!parsed.ok) {
    return parsed;
  }
  const targetId = requiredString(parsed.value, "targetId");
  if (!targetId.ok) {
    return targetId;
  }
  return ok({
    targetId: targetId.value,
    url: typeof parsed.value.url === "string" ? parsed.value.url : undefined,
  });
}

export function parsePopupClosedMessage(data: string): ProtocolParseResult<PopupClosedMessage> {
  const parsed = parseJsonObject(data);
  if (!parsed.ok) {
    return parsed;
  }
  const targetId = requiredString(parsed.value, "targetId");
  return targetId.ok ? ok({ targetId: targetId.value }) : targetId;
}

export function parseClipboardMessage(data: string): ProtocolParseResult<ClipboardMessage> {
  const parsed = parseJsonObject(data);
  if (!parsed.ok) {
    return parsed;
  }
  const text = optionalString(parsed.value.text);
  return typeof text === "string" ? ok({ text }) : err("text_missing");
}

export function parseKeyboardFocusMessage(data: string): ProtocolParseResult<KeyboardFocusMessage> {
  const parsed = parseJsonObject(data);
  if (!parsed.ok) {
    return parsed;
  }
  if (typeof parsed.value.focused !== "boolean") {
    return err("focused_missing");
  }
  let element: KeyboardFocusMessage["element"];
  if (isObject(parsed.value.element)) {
    element = {
      inputType: optionalString(parsed.value.element.inputType) ?? undefined,
      tagName: optionalString(parsed.value.element.tagName) ?? undefined,
    };
  } else if (parsed.value.element === null) {
    element = null;
  }
  return ok({ element, focused: parsed.value.focused });
}

export function parseStreamErrorMessage(data: string): ProtocolParseResult<StreamErrorMessage> {
  const parsed = parseJsonObject(data);
  if (!parsed.ok) {
    return parsed;
  }
  return ok({
    code: optionalString(parsed.value.code) ?? undefined,
    message: optionalString(parsed.value.message) ?? undefined,
  });
}
