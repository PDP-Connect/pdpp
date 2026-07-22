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

export function stableInlineJson(value) {
  return JSON.stringify(value);
}

export function truncateText(value, limit) {
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

export function extractRecordRows(body) {
  if (Array.isArray(body)) {
    return body;
  }
  if (Array.isArray(body?.records)) {
    return body.records;
  }
  if (Array.isArray(body?.data)) {
    return body.data;
  }
  if (Array.isArray(body?.data?.records)) {
    return body.data.records;
  }
  return [];
}

export function summarizeRecordEvidence(body, label, options = {}) {
  const limit = options.recordLimit ?? DEFAULT_RECORD_PREVIEW_LIMIT;
  const charLimit = options.charLimit ?? DEFAULT_RECORD_PREVIEW_CHAR_LIMIT;
  const footerReserve = options.footerReserve ?? DEFAULT_RECORD_PREVIEW_FOOTER_RESERVE;
  const minRecordChars = options.minRecordChars ?? DEFAULT_RECORD_PREVIEW_MIN_RECORD_CHARS;
  const truncatedMarker = options.truncatedMarker ?? DEFAULT_RECORD_PREVIEW_TRUNCATED_MARKER;
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

export function summarizeFieldWindowEvidence(body) {
  const fieldPath = firstString(body?.field?.path, body?.field_path, body?.field);
  const stream = firstString(body?.stream);
  const recordId = firstString(body?.record_id, body?.recordId);
  const connectionId = firstString(body?.connection_id, body?.connector_instance_id);
  const window = objectValue(body?.window) ?? {};
  const start = numberValue(window.start_chars);
  const end = numberValue(window.end_chars);
  const complete = window.complete === true;
  const nextCursor = firstString(window.next_cursor);
  const previousCursor = firstString(window.previous_cursor);
  const range =
    start !== null && end !== null ? `chars ${start}..${end}` : start === null ? "chars" : `chars ${start}..`;
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

export function formatEnvelopeHandles(body) {
  const parts = [];
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

export function buildRecordContentLadder(record, options = {}) {
  const identity = recordContentIdentity(record, options.fallback);
  if (!identity) {
    return null;
  }

  const encodeResourceUri = options.encodeResourceUri ?? defaultEncodeResourceUri;
  const fieldWindows = recordContentFields(record, identity, {
    encodeResourceUri,
    fieldLimit: options.fieldLimit ?? DEFAULT_FIELD_WINDOW_LIMIT,
    windowLimitChars: options.windowLimitChars ?? DEFAULT_FIELD_WINDOW_LIMIT_CHARS,
  });
  const binaryFields = recordContentBinaryFields(record, {
    binaryLimit: options.binaryLimit ?? DEFAULT_BINARY_FIELD_LIMIT,
  });
  const jsonFields = recordContentJsonFields(record, identity, {
    jsonLimit: options.jsonLimit ?? DEFAULT_JSON_FIELD_LIMIT,
    jsonPreviewChars: options.jsonPreviewChars ?? DEFAULT_JSON_PREVIEW_CHAR_LIMIT,
  });

  return {
    connection_id: identity.connectionId,
    field_windows: fieldWindows,
    handle_semantics: "live_lookup",
    id: identity.id,
    record_id: identity.recordId,
    record_uri: encodeResourceUri("record", {
      connection_id: identity.connectionId,
      record_id: identity.recordId,
      stream: identity.stream,
    }),
    stream: identity.stream,
    ...(jsonFields.length > 0 ? { json_fields: jsonFields } : {}),
    ...(binaryFields.length > 0 ? { binary_fields: binaryFields } : {}),
  };
}

export function buildRecordSetContentLadder(body, options = {}) {
  const records = extractRecordRows(body)
    .map((record) => buildRecordContentLadder(record, options))
    .filter(Boolean)
    .slice(0, options.recordLimit ?? DEFAULT_RECORD_PREVIEW_LIMIT);
  if (records.length === 0) {
    return null;
  }
  return {
    kind: "record_set",
    read_tool: options.readTool ?? "read_record_field",
    records,
  };
}

export function defaultEncodeResourceUri(kind, payload) {
  return `pdpp://${kind}/${encodeContentHandle(kind, payload)}`;
}

export function encodeContentHandle(kind, payload) {
  return base64UrlEncode(
    JSON.stringify({
      kind,
      v: 1,
      ...payload,
    })
  );
}

export function decodeContentHandle(handle, expectedKind) {
  const payload = JSON.parse(base64UrlDecode(String(handle)));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Content handle is malformed.");
  }
  if (payload.v !== 1 || payload.kind !== expectedKind) {
    throw new Error("Content handle has the wrong kind or version.");
  }
  return payload;
}

export function sanitizeRecordForEvidence(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return record;
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "data" && value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizePayloadObject(value);
      continue;
    }
    sanitized[key] = binaryFieldMetadata(key, value) ?? sanitizeEvidenceValue(value);
  }
  return sanitized;
}

export function binaryFieldMetadata(fieldPath, value) {
  if (typeof fieldPath !== "string" || fieldPath.length === 0 || OMIT_FIELD_KEYS.has(fieldPath)) {
    return null;
  }

  const blob = blobRefMetadata(value);
  if (blob) {
    return {
      binary_field: true,
      field_path: fieldPath,
      handle_semantics: "live_lookup",
      preview_status: "binary-only",
      text_like: false,
      ...blob,
    };
  }

  if (isLargeBase64Field(fieldPath, value)) {
    return {
      binary_field: true,
      encoding: "base64",
      field_path: fieldPath,
      handle_semantics: "live_lookup",
      preview_status: "binary-only",
      size_chars: value.length,
      text_like: false,
    };
  }

  return null;
}

function recordContentIdentity(record, fallback = {}) {
  const payload = objectValue(record?.data) || objectValue(record?.record) || objectValue(record);
  const directId = firstString(fallback?.id, record?.id, record?.result_id, record?.record_id, record?.recordId);
  const parsed = directId ? parseRecordResultId(directId) : null;
  const stream = firstString(fallback?.stream, record?.stream, record?.stream_name, payload?.stream, parsed?.stream);
  const recordId = firstString(
    fallback?.recordId,
    fallback?.record_id,
    record?.record_id,
    record?.recordId,
    payload?.id,
    payload?.record_id,
    parsed?.recordId
  );
  const connectionId = firstString(
    fallback?.connectionId,
    fallback?.connection_id,
    record?.connection_id,
    record?.connector_instance_id,
    payload?.connection_id,
    parsed?.connectionId
  );

  if (!(stream && recordId)) {
    return null;
  }
  const id = connectionId ? `${connectionId}/${stream}:${recordId}` : `${stream}:${recordId}`;
  return { connectionId: connectionId ?? null, id, recordId, stream };
}

function recordContentFields(record, identity, options) {
  const payload = objectValue(record?.data) || objectValue(record?.record) || objectValue(record);
  return Object.entries(payload)
    .filter(([fieldPath, value]) => isContentStringField(fieldPath, value))
    .slice(0, options.fieldLimit)
    .map(([fieldPath, value]) => ({
      field_path: fieldPath,
      handle_semantics: "live_lookup",
      preview_status: value.length > options.windowLimitChars ? "truncated" : "complete",
      read: {
        args: {
          field_path: fieldPath,
          id: identity.id,
          limit_chars: options.windowLimitChars,
          offset_chars: 0,
        },
        tool: "read_record_field",
      },
      resource_uri: options.encodeResourceUri("field-window", {
        connection_id: identity.connectionId,
        field_path: fieldPath,
        limit_chars: options.windowLimitChars,
        offset_chars: 0,
        record_id: identity.recordId,
        stream: identity.stream,
      }),
      size_chars: value.length,
      text_like: true,
    }));
}

function recordContentBinaryFields(record, options) {
  const payload = objectValue(record?.data) || objectValue(record?.record) || objectValue(record);
  return Object.entries(payload)
    .map(([fieldPath, value]) => binaryFieldMetadata(fieldPath, value))
    .filter(Boolean)
    .slice(0, options.binaryLimit);
}

function recordContentJsonFields(record, identity, options) {
  const payload = objectValue(record?.data) || objectValue(record?.record) || objectValue(record);
  return Object.entries(payload)
    .filter(([fieldPath, value]) => isJsonEvidenceField(fieldPath, value))
    .slice(0, options.jsonLimit)
    .map(([fieldPath, value]) => {
      const rendered = stableInlineJson(value);
      return {
        field_path: fieldPath,
        handle_semantics: "live_lookup",
        json_field: true,
        preview_status: rendered.length > options.jsonPreviewChars ? "truncated" : "complete",
        preview_text: truncateText(rendered, options.jsonPreviewChars),
        read: {
          args: {
            fields: [fieldPath],
            id: identity.id,
          },
          tool: "fetch",
        },
        size_chars: rendered.length,
        text_like: false,
      };
    });
}

function isJsonEvidenceField(fieldPath, value) {
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

function sanitizePayloadObject(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    const binary = binaryFieldMetadata(key, value);
    out[key] = binary ?? sanitizeEvidenceValue(value);
  }
  return out;
}

function sanitizeEvidenceValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEvidenceValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const blob = blobRefMetadata(value);
  if (blob) {
    return {
      preview_status: "binary-only",
      text_like: false,
      ...blob,
    };
  }
  return sanitizePayloadObject(value);
}

function isContentStringField(fieldPath, value) {
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

function isLargeBase64Field(_fieldPath, value) {
  if (typeof value !== "string" || value.length < 256) {
    return false;
  }
  if (value.length % 4 !== 0) {
    return false;
  }
  if (new Set(value).size < 4) {
    return false;
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function blobRefMetadata(value) {
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

function parseRecordResultId(id) {
  const slash = id.indexOf("/");
  const colon = id.indexOf(":", slash + 1);
  if (colon <= 0) {
    return null;
  }
  if (slash > 0) {
    return {
      connectionId: id.slice(0, slash),
      recordId: id.slice(colon + 1),
      stream: id.slice(slash + 1, colon),
    };
  }
  return {
    connectionId: null,
    recordId: id.slice(colon + 1),
    stream: id.slice(0, colon),
  };
}

function envelopeField(body, key) {
  if (body && Object.hasOwn(body, key)) {
    return body[key];
  }
  if (body?.meta && Object.hasOwn(body.meta, key)) {
    return body.meta[key];
  }
  if (body?.data && typeof body.data === "object" && !Array.isArray(body.data) && Object.hasOwn(body.data, key)) {
    return body.data[key];
  }
}

function envelopeCount(body) {
  const count = envelopeField(body, "count");
  if (!count || typeof count !== "object") {
    return null;
  }
  const kind = firstString(count.kind);
  const value = numberValue(count.value);
  if (!kind || value === null) {
    return null;
  }
  return `${kind}:${value}`;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function numberValue(...values) {
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

function formatScalar(value) {
  return JSON.stringify(value);
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}
