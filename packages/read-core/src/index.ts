// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const DEFAULT_RECORD_PREVIEW_LIMIT = 5;
const DEFAULT_RECORD_PREVIEW_CHAR_LIMIT = 1792;
const DEFAULT_RECORD_PREVIEW_FOOTER_RESERVE = 96;
const DEFAULT_RECORD_PREVIEW_MIN_RECORD_CHARS = 24;
const DEFAULT_RECORD_PREVIEW_TRUNCATED_MARKER =
  "record_preview_truncated=true; followup=rerun_limit; machine envelope in structuredContent.data";
const DEFAULT_FIELD_WINDOW_LIMIT_CHARS = 2048;
const DEFAULT_FIELD_WINDOW_LIMIT = 8;
const DEFAULT_BINARY_FIELD_LIMIT = 8;
const DEFAULT_JSON_FIELD_LIMIT = 8;
const DEFAULT_JSON_PREVIEW_CHAR_LIMIT = 512;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

const OMIT_FIELD_KEYS = new Set([
  "id",
  "record_id",
  "recordId",
  "connection_id",
  "connector_instance_id",
  "connector_key",
  "stream",
  "metadata",
  "_meta",
]);

type AnyRecord = Record<string, unknown>;
type AnyOptions = Record<string, unknown>;
type ResourceUriEncoder = (kind: string, payload: AnyRecord) => string;

declare const Buffer: {
  from: (value: string, encoding: string) => { toString: (encoding: string) => string };
};

export function stableInlineJson(value: unknown) {
  return JSON.stringify(value);
}

export function truncateText(value: unknown, limit: number) {
  const text = String(value ?? "");
  if (!Number.isFinite(limit) || limit <= 0) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 1) {
    return "…".slice(0, limit);
  }
  return `${text.slice(0, limit - 1)}…`;
}

export function extractRecordRows(body: unknown) {
  if (Array.isArray(body)) {
    return body;
  }
  const bodyObject = objectValue(body);
  if (Array.isArray(bodyObject?.records)) {
    return bodyObject.records;
  }
  if (Array.isArray(bodyObject?.data)) {
    return bodyObject.data;
  }
  const dataObject = objectValue(bodyObject?.data);
  if (Array.isArray(dataObject?.records)) {
    return dataObject.records;
  }
  return [];
}

export function summarizeRecordEvidence(body: unknown, label: string, options: AnyOptions = {}) {
  const limit = numberOption(options.recordLimit, DEFAULT_RECORD_PREVIEW_LIMIT);
  const charLimit = numberOption(options.charLimit, DEFAULT_RECORD_PREVIEW_CHAR_LIMIT);
  const footerReserve = numberOption(options.footerReserve, DEFAULT_RECORD_PREVIEW_FOOTER_RESERVE);
  const minRecordChars = numberOption(options.minRecordChars, DEFAULT_RECORD_PREVIEW_MIN_RECORD_CHARS);
  const truncatedMarker = stringOption(options.truncatedMarker, DEFAULT_RECORD_PREVIEW_TRUNCATED_MARKER);
  const records = extractRecordRows(body);
  const hasMore = envelopeField(body, "has_more") === true ? " has_more=true." : "";
  const handles = formatEnvelopeHandles(body);

  if (records.length === 0) {
    return `${label}: 0 record(s).${handles}`;
  }

  const shown = Math.min(records.length, limit);
  const lines = [`${label}: ${records.length} record(s).${hasMore}${handles} Showing up to ${shown}:`];
  const contentCeiling = charLimit - footerReserve;
  let used = lines[0].length;
  let truncated = false;

  for (const [index, record] of records.slice(0, limit).entries()) {
    const prefix = `record[${index}] `;
    const budget = contentCeiling - used - prefix.length - 1;
    if (budget < minRecordChars) {
      truncated = true;
      break;
    }
    const inlineRecord = stableInlineJson(sanitizeRecordForEvidence(record));
    if (inlineRecord.length > budget) {
      truncated = true;
    }
    const rendered = `${prefix}${truncateText(inlineRecord, budget)}`;
    lines.push(rendered);
    used += rendered.length + 1;
  }

  if (truncated && records.length > 1) {
    lines.push(truncatedMarker);
  } else if (records.length > limit) {
    lines.push(
      `more_records=${records.length - limit}; followup=rerun_cursor_or_limit; machine envelope in structuredContent.data`
    );
  }

  return lines.join("\n");
}

export function summarizeFieldWindowEvidence(body: unknown) {
  const bodyObject = objectValue(body);
  const field = objectValue(bodyObject?.field);
  const fieldPath = firstString(field?.path, bodyObject?.field_path, bodyObject?.field);
  const stream = firstString(bodyObject?.stream);
  const recordId = firstString(bodyObject?.record_id, bodyObject?.recordId);
  const connectionId = firstString(bodyObject?.connection_id, bodyObject?.connector_instance_id);
  const window = objectValue(bodyObject?.window) ?? {};
  const start = numberValue(window.start_chars);
  const end = numberValue(window.end_chars);
  const complete = window.complete === true;
  const nextCursor = firstString(window.next_cursor);
  const previousCursor = firstString(window.previous_cursor);
  let range = "chars";
  if (start !== null) {
    range = end === null ? `chars ${start}..` : `chars ${start}..${end}`;
  }
  const identity = [connectionId, stream, recordId].filter(Boolean).join("/");
  const cursorText = [
    nextCursor ? `next_cursor=${formatScalar(nextCursor)}` : null,
    previousCursor ? `previous_cursor=${formatScalar(previousCursor)}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return [
    `record=${identity || "unknown"} field=${fieldPath || "unknown"} ${range} complete=${complete}`,
    cursorText,
    String(window.text ?? ""),
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatEnvelopeHandles(body: unknown) {
  const parts: string[] = [];
  const nextCursor = envelopeField(body, "next_cursor");
  if (nextCursor) {
    parts.push(`next_cursor=${formatScalar(nextCursor)}`);
  }
  const nextChangesSince = envelopeField(body, "next_changes_since");
  if (nextChangesSince) {
    parts.push(`next_changes_since=${formatScalar(nextChangesSince)}`);
  }
  const count = envelopeCount(body);
  if (count) {
    parts.push(`count=${count}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}.` : "";
}

export function buildRecordContentLadder(record: unknown, options: AnyOptions = {}) {
  const identity = recordContentIdentity(record, objectValue(options.fallback) ?? {});
  if (!identity) {
    return null;
  }

  const encodeResourceUri = resourceUriEncoder(options.encodeResourceUri);
  const fieldWindows = recordContentFields(record, identity, {
    encodeResourceUri,
    fieldLimit: numberOption(options.fieldLimit, DEFAULT_FIELD_WINDOW_LIMIT),
    windowLimitChars: numberOption(options.windowLimitChars, DEFAULT_FIELD_WINDOW_LIMIT_CHARS),
  });
  const binaryFields = recordContentBinaryFields(record, {
    binaryLimit: numberOption(options.binaryLimit, DEFAULT_BINARY_FIELD_LIMIT),
  });
  const jsonFields = recordContentJsonFields(record, identity, {
    jsonLimit: numberOption(options.jsonLimit, DEFAULT_JSON_FIELD_LIMIT),
    jsonPreviewChars: numberOption(options.jsonPreviewChars, DEFAULT_JSON_PREVIEW_CHAR_LIMIT),
  });

  return {
    id: identity.id,
    connection_id: identity.connectionId,
    stream: identity.stream,
    record_id: identity.recordId,
    handle_semantics: "live_lookup",
    record_uri: encodeResourceUri("record", {
      connection_id: identity.connectionId,
      stream: identity.stream,
      record_id: identity.recordId,
    }),
    field_windows: fieldWindows,
    ...(jsonFields.length > 0 ? { json_fields: jsonFields } : {}),
    ...(binaryFields.length > 0 ? { binary_fields: binaryFields } : {}),
  };
}

export function buildRecordSetContentLadder(body: unknown, options: AnyOptions = {}) {
  const records = extractRecordRows(body)
    .map((record) => buildRecordContentLadder(record, options))
    .filter(Boolean)
    .slice(0, numberOption(options.recordLimit, DEFAULT_RECORD_PREVIEW_LIMIT));
  if (records.length === 0) {
    return null;
  }
  return {
    kind: "record_set",
    read_tool: stringOption(options.readTool, "read_record_field"),
    records,
  };
}

export function defaultEncodeResourceUri(kind: string, payload: AnyRecord) {
  return `pdpp://${kind}/${encodeContentHandle(kind, payload)}`;
}

export function encodeContentHandle(kind: string, payload: AnyRecord) {
  return base64UrlEncode(
    JSON.stringify({
      v: 1,
      kind,
      ...payload,
    })
  );
}

export function decodeContentHandle(handle: string, expectedKind: string) {
  const payload = JSON.parse(base64UrlDecode(String(handle)));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Content handle is malformed.");
  }
  const payloadObject = objectValue(payload);
  if (payloadObject?.v !== 1 || payloadObject?.kind !== expectedKind) {
    throw new Error("Content handle has the wrong kind or version.");
  }
  return payloadObject;
}

export function sanitizeRecordForEvidence(record: unknown) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return record;
  }
  const sanitized: AnyRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "data" && value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizePayloadObject(value);
      continue;
    }
    sanitized[key] = binaryFieldMetadata(key, value) ?? sanitizeEvidenceValue(value);
  }
  return sanitized;
}

export function binaryFieldMetadata(fieldPath: unknown, value: unknown) {
  if (typeof fieldPath !== "string" || fieldPath.length === 0 || OMIT_FIELD_KEYS.has(fieldPath)) {
    return null;
  }

  const blob = blobRefMetadata(value);
  if (blob) {
    return {
      field_path: fieldPath,
      binary_field: true,
      text_like: false,
      handle_semantics: "live_lookup",
      preview_status: "binary-only",
      ...blob,
    };
  }

  if (isLargeBase64Field(fieldPath, value)) {
    return {
      field_path: fieldPath,
      binary_field: true,
      text_like: false,
      handle_semantics: "live_lookup",
      preview_status: "binary-only",
      encoding: "base64",
      size_chars: value.length,
    };
  }

  return null;
}

function recordContentIdentity(record: unknown, fallback: AnyRecord = {}) {
  const recordObject = objectValue(record) ?? {};
  const payload = objectValue(recordObject.data) || objectValue(recordObject.record) || recordObject;
  const directId = firstString(
    fallback.id,
    recordObject.id,
    recordObject.result_id,
    recordObject.record_id,
    recordObject.recordId
  );
  const parsed = directId ? parseRecordResultId(directId) : null;
  const stream = firstString(
    fallback.stream,
    recordObject.stream,
    recordObject.stream_name,
    payload.stream,
    parsed?.stream
  );
  const recordId = firstString(
    fallback.recordId,
    fallback.record_id,
    recordObject.record_id,
    recordObject.recordId,
    payload.id,
    payload.record_id,
    parsed?.recordId
  );
  const connectionId = firstString(
    fallback.connectionId,
    fallback.connection_id,
    recordObject.connection_id,
    recordObject.connector_instance_id,
    payload.connection_id,
    parsed?.connectionId
  );

  if (!(stream && recordId)) {
    return null;
  }
  const id = connectionId ? `${connectionId}/${stream}:${recordId}` : `${stream}:${recordId}`;
  return { id, connectionId: connectionId ?? null, stream, recordId };
}

function recordContentFields(record: unknown, identity: AnyRecord, options: AnyOptions) {
  const payload =
    objectValue(objectValue(record)?.data) || objectValue(objectValue(record)?.record) || objectValue(record) || {};
  return Object.entries(payload)
    .filter((entry): entry is [string, string] => isContentStringField(entry[0], entry[1]))
    .slice(0, numberOption(options.fieldLimit))
    .map(([fieldPath, value]) => ({
      field_path: fieldPath,
      text_like: true,
      handle_semantics: "live_lookup",
      preview_status: value.length > numberOption(options.windowLimitChars) ? "truncated" : "complete",
      size_chars: value.length,
      read: {
        tool: "read_record_field",
        args: {
          id: identity.id,
          field_path: fieldPath,
          offset_chars: 0,
          limit_chars: numberOption(options.windowLimitChars),
        },
      },
      resource_uri: resourceUriEncoder(options.encodeResourceUri)("field-window", {
        connection_id: identity.connectionId,
        stream: identity.stream,
        record_id: identity.recordId,
        field_path: fieldPath,
        offset_chars: 0,
        limit_chars: numberOption(options.windowLimitChars),
      }),
    }));
}

function recordContentBinaryFields(record: unknown, options: AnyOptions) {
  const payload =
    objectValue(objectValue(record)?.data) || objectValue(objectValue(record)?.record) || objectValue(record) || {};
  return Object.entries(payload)
    .map(([fieldPath, value]) => binaryFieldMetadata(fieldPath, value))
    .filter(Boolean)
    .slice(0, numberOption(options.binaryLimit));
}

function recordContentJsonFields(record: unknown, identity: AnyRecord, options: AnyOptions) {
  const payload =
    objectValue(objectValue(record)?.data) || objectValue(objectValue(record)?.record) || objectValue(record) || {};
  return Object.entries(payload)
    .filter(([fieldPath, value]) => isJsonEvidenceField(fieldPath, value))
    .slice(0, numberOption(options.jsonLimit))
    .map(([fieldPath, value]) => {
      const rendered = stableInlineJson(value);
      return {
        field_path: fieldPath,
        json_field: true,
        text_like: false,
        handle_semantics: "live_lookup",
        preview_status: rendered.length > numberOption(options.jsonPreviewChars) ? "truncated" : "complete",
        size_chars: rendered.length,
        preview_text: truncateText(rendered, numberOption(options.jsonPreviewChars)),
        read: {
          tool: "fetch",
          args: {
            id: identity.id,
            fields: [fieldPath],
          },
        },
      };
    });
}

function isJsonEvidenceField(fieldPath: unknown, value: unknown) {
  if (typeof fieldPath !== "string" || fieldPath.length === 0 || OMIT_FIELD_KEYS.has(fieldPath)) {
    return false;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (blobRefMetadata(value)) {
    return false;
  }
  return true;
}

function sanitizePayloadObject(payload: AnyRecord) {
  const out: AnyRecord = {};
  for (const [key, value] of Object.entries(payload)) {
    const binary = binaryFieldMetadata(key, value);
    out[key] = binary ?? sanitizeEvidenceValue(value);
  }
  return out;
}

function sanitizeEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEvidenceValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const blob = blobRefMetadata(value);
  if (blob) {
    return {
      text_like: false,
      preview_status: "binary-only",
      ...blob,
    };
  }
  return sanitizePayloadObject(objectValue(value) ?? {});
}

function isContentStringField(fieldPath: unknown, value: unknown): fieldPath is string {
  return (
    typeof fieldPath === "string" &&
    fieldPath.length > 0 &&
    !OMIT_FIELD_KEYS.has(fieldPath) &&
    typeof value === "string" &&
    value.length > 0 &&
    !isLargeBase64Field(fieldPath, value) &&
    !fieldPath.includes("/") &&
    !fieldPath.includes("\\") &&
    fieldPath !== "." &&
    fieldPath !== ".." &&
    !fieldPath.includes("..")
  );
}

function isLargeBase64Field(_fieldPath: unknown, value: unknown): value is string {
  if (typeof value !== "string" || value.length < 256) {
    return false;
  }
  if (value.length % 4 !== 0) {
    return false;
  }
  if (new Set(value).size < 4) {
    return false;
  }
  return base64Pattern.test(value);
}

function blobRefMetadata(value: unknown) {
  const obj = objectValue(value);
  if (!obj) {
    return null;
  }

  const blobId = firstString(obj.blob_id, obj.blobId, obj.id);
  const fetchUrl = firstString(obj.fetch_url, obj.fetchUrl, obj.url, obj.href);
  const mimeType = firstString(obj.mime_type, obj.mimeType, obj.content_type, obj.contentType);
  const digest = firstString(obj.digest, obj.sha256, obj.content_digest, obj.contentDigest);
  const sizeBytes = numberValue(obj.size_bytes, obj.sizeBytes, obj.byte_length, obj.byteLength);

  if (!(blobId || fetchUrl || mimeType)) {
    return null;
  }

  return {
    ...(blobId ? { blob_id: blobId } : {}),
    ...(fetchUrl ? { fetch_url: fetchUrl } : {}),
    ...(mimeType ? { mime_type: mimeType } : {}),
    ...(digest ? { digest } : {}),
    ...(sizeBytes === null ? {} : { size_bytes: sizeBytes }),
  };
}

function parseRecordResultId(id: string) {
  const slash = id.indexOf("/");
  const colon = id.indexOf(":", slash + 1);
  if (colon <= 0) {
    return null;
  }
  if (slash > 0) {
    return {
      connectionId: id.slice(0, slash),
      stream: id.slice(slash + 1, colon),
      recordId: id.slice(colon + 1),
    };
  }
  return {
    connectionId: null,
    stream: id.slice(0, colon),
    recordId: id.slice(colon + 1),
  };
}

function envelopeField(body: unknown, key: string) {
  const bodyObject = objectValue(body);
  if (bodyObject && Object.hasOwn(bodyObject, key)) {
    return bodyObject[key];
  }
  const meta = objectValue(bodyObject?.meta);
  if (meta && Object.hasOwn(meta, key)) {
    return meta[key];
  }
  const data = objectValue(bodyObject?.data);
  if (data && Object.hasOwn(data, key)) {
    return data[key];
  }
}

function envelopeCount(body: unknown) {
  const count = envelopeField(body, "count");
  if (!count || typeof count !== "object") {
    return null;
  }
  const countObject = objectValue(count);
  const kind = firstString(countObject?.kind);
  const value = numberValue(countObject?.value);
  if (!kind || value === null) {
    return null;
  }
  return `${kind}:${value}`;
}

function objectValue(value: unknown): AnyRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value));
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function numberValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function formatScalar(value: unknown) {
  return JSON.stringify(value);
}

function numberOption(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOption(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function resourceUriEncoder(value: unknown): ResourceUriEncoder {
  return isResourceUriEncoder(value) ? value : defaultEncodeResourceUri;
}

function isResourceUriEncoder(value: unknown): value is ResourceUriEncoder {
  return typeof value === "function";
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}
