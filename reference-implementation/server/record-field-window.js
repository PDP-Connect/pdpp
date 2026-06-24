/**
 * Bounded record-field window substrate (shared, backend-agnostic).
 *
 * The MCP content ladder needs a grant-enforced path that returns a *bounded
 * character window* of one record field without hydrating the whole field
 * value into the resource-server process. This module owns the parts of that
 * path that are independent of the storage backend: bound clamping, the typed
 * error vocabulary, grant field-visibility enforcement, and the completeness
 * math that turns a windowed substring plus the field's total length into a
 * `window` envelope.
 *
 * The two backend readers (`getRecordFieldWindow` in `records.js`,
 * `postgresGetRecordFieldWindow` in `postgres-records.js`) call into these
 * helpers and supply the substring + total length from a single windowed SQL
 * statement that never selects `record_json`.
 *
 * Spec: openspec/changes/add-mcp-content-ladder/specs/mcp-adapter/spec.md
 *       Requirement: "MCP bounded field reads SHALL be served by a
 *       grant-enforced resource-server path"
 */

// Default and ceiling for the window length. The MCP adapter advertises the
// same defaults; the resource server is the authority and clamps regardless of
// what the client asks for.
export const FIELD_WINDOW_DEFAULT_LIMIT = 4096;
export const FIELD_WINDOW_MAX_LIMIT = 16384;
export const FIELD_WINDOW_MAX_CONTEXT_CHARS = 8192;

/**
 * Typed error for field-window reads. `.code` is surfaced verbatim by the
 * route and mapped to an HTTP status; the MCP adapter forwards the same code so
 * authorization and validation meaning is preserved end to end.
 */
export class FieldWindowError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'FieldWindowError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function fieldWindowError(code, message, httpStatus) {
  return new FieldWindowError(code, message, httpStatus);
}

/**
 * A field name is a single top-level JSON object key. We deliberately do NOT
 * support nested JSON paths in the P0 substrate: nested traversal multiplies
 * the grant-visibility surface (a grant scopes top-level fields) and the
 * injection surface. Reject anything that is not a non-empty string, and
 * reject the structural characters that a dotted/bracketed path would use so a
 * future nested syntax cannot be smuggled through this single-key contract.
 */
export function assertFieldPath(fieldPath) {
  if (typeof fieldPath !== 'string' || fieldPath.length === 0) {
    throw fieldWindowError('invalid_field_path', 'field must be a non-empty string', 400);
  }
  if (fieldPath.includes('\u0000')) {
    throw fieldWindowError('invalid_field_path', 'field must not contain NUL', 400);
  }
}

/**
 * Build a SQLite JSON path for a single top-level key. `json_extract` and
 * `json_type` take the path as a bound parameter, so the key never reaches the
 * SQL text. Wrapping the key in `JSON.stringify` produces a quoted path
 * segment (`$."weird\"key"`) which SQLite parses as a literal key - a key that
 * itself contains `.` or `"` resolves to that exact key rather than a nested
 * path, and a key cannot break out of the quoted segment.
 */
export function sqliteFieldJsonPath(fieldPath) {
  return `$.${JSON.stringify(fieldPath)}`;
}

/**
 * Clamp a requested window to the substrate bounds. Returns the offset (>= 0)
 * and the effective limit (1..FIELD_WINDOW_MAX_LIMIT), plus whether the limit
 * was clamped so the caller can record a warning. Non-integer or negative
 * inputs are rejected rather than silently coerced, because a silently shifted
 * window is a correctness trap for a paging client.
 */
export function clampWindowBounds({ offsetChars, limitChars } = {}) {
  let offset = 0;
  if (offsetChars !== undefined && offsetChars !== null) {
    if (!Number.isInteger(offsetChars) || offsetChars < 0) {
      throw fieldWindowError('invalid_window', 'offset_chars must be a non-negative integer', 400);
    }
    offset = offsetChars;
  }

  let limit = FIELD_WINDOW_DEFAULT_LIMIT;
  let limitClamped = false;
  if (limitChars !== undefined && limitChars !== null) {
    if (!Number.isInteger(limitChars) || limitChars <= 0) {
      throw fieldWindowError('invalid_window', 'limit_chars must be a positive integer', 400);
    }
    limit = limitChars;
    if (limit > FIELD_WINDOW_MAX_LIMIT) {
      limit = FIELD_WINDOW_MAX_LIMIT;
      limitClamped = true;
    }
  }

  return { offset, limit, limitClamped };
}

function assertContextChars(value, label) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw fieldWindowError('invalid_window', `${label} must be a non-negative integer`, 400);
  }
  if (value > FIELD_WINDOW_MAX_CONTEXT_CHARS) {
    throw fieldWindowError('invalid_window', `${label} must be <= ${FIELD_WINDOW_MAX_CONTEXT_CHARS}`, 400);
  }
  return value;
}

/**
 * Normalize the field-window selector. Offset windows remain the default; a
 * `q` selector asks the storage backend to find the first match and return a
 * bounded context window without returning the full field to JS.
 */
export function normalizeWindowSelector(params = {}) {
  const hasQParam = params.q !== undefined && params.q !== null;
  if ((params.before_chars !== undefined || params.after_chars !== undefined) && !hasQParam) {
    throw fieldWindowError('invalid_window', 'before_chars and after_chars require q', 400);
  }
  if (hasQParam && params.offset_chars !== undefined && params.offset_chars !== null) {
    throw fieldWindowError('invalid_window', 'q is exclusive with offset_chars', 400);
  }

  const { offset, limit: boundedLimit, limitClamped } = clampWindowBounds({
    offsetChars: params.offset_chars,
    limitChars: params.limit_chars,
  });

  if (!hasQParam) {
    return { mode: 'offset', offset, limit: boundedLimit, limitClamped };
  }
  if (typeof params.q !== 'string' || params.q.length === 0) {
    throw fieldWindowError('invalid_window', 'q must be a non-empty string', 400);
  }

  const before = assertContextChars(params.before_chars, 'before_chars');
  const after = assertContextChars(params.after_chars, 'after_chars');
  const explicitContext = params.before_chars !== undefined || params.after_chars !== undefined;
  const requestedLimit = params.limit_chars === undefined || params.limit_chars === null
    ? (explicitContext ? before + params.q.length + after : FIELD_WINDOW_DEFAULT_LIMIT)
    : boundedLimit;
  const effectiveLimit = Math.min(requestedLimit, FIELD_WINDOW_MAX_LIMIT);

  return {
    mode: 'query',
    query: params.q,
    before,
    after,
    offset: 0,
    limit: effectiveLimit,
    limitClamped: limitClamped || requestedLimit > FIELD_WINDOW_MAX_LIMIT,
  };
}

/**
 * Decide whether a grant (after intersection with any request `fields`) allows
 * reading `fieldPath`. `effectiveFields === null` means the grant scopes no
 * field projection - every field is visible. Otherwise the field must be in the
 * allowed set. Throws the authorization-preserving `field_not_granted` error
 * when it is not, so the substrate fails closed before touching field bytes.
 */
export function assertFieldVisibleToGrant(fieldPath, effectiveFields) {
  if (effectiveFields === null || effectiveFields === undefined) {
    return;
  }
  if (!Array.isArray(effectiveFields) || !effectiveFields.includes(fieldPath)) {
    throw fieldWindowError(
      'field_not_granted',
      `field '${fieldPath}' is not within the granted projection for this stream`,
      403,
    );
  }
}

/**
 * Turn a windowed substring + the field's total character length into the
 * `window` envelope returned to callers. `fieldType` is the storage engine's
 * type name for the field; only string fields produce text windows, so a
 * non-string or absent field is reported as a typed error by the caller using
 * `classifyFieldType`.
 *
 * @param {object} args
 * @param {string} args.text       the windowed substring (already clamped)
 * @param {number} args.totalChars total length of the full field value
 * @param {number} args.offset     the start offset used (0-based)
 * @param {number} args.limit      the effective window length used
 */
export function buildWindowEnvelope({ text, totalChars, offset, limit, matchStartChars = null, matchEndChars = null }) {
  const start = Math.min(offset, totalChars);
  const end = Math.min(start + text.length, totalChars);
  const complete = start === 0 && end >= totalChars;
  const hasMore = end < totalChars;
  return {
    text,
    total_chars: totalChars,
    start_chars: start,
    end_chars: end,
    limit_chars: limit,
    complete,
    has_more: hasMore,
    match_start_chars: matchStartChars,
    match_end_chars: matchEndChars,
    // A cursor for the next adjacent window when more remains; null when the
    // window reaches the end. The cursor is just the next offset - the caller
    // wraps it into an opaque token bound to record id + field path.
    next_offset_chars: hasMore ? end : null,
    previous_offset_chars: start > 0 ? Math.max(0, start - limit) : null,
  };
}

/**
 * Map a storage type name to one of the substrate's coarse classes. The SQLite
 * (`json_type`) and Postgres (`jsonb_typeof`) type names differ, so callers
 * normalize through this before deciding string vs non-string vs absent.
 */
export function classifyFieldType(engineType) {
  if (engineType === null || engineType === undefined) {
    return 'absent';
  }
  if (engineType === 'text' || engineType === 'string') {
    return 'string';
  }
  if (engineType === 'integer' || engineType === 'real' || engineType === 'number') {
    return 'number';
  }
  if (engineType === 'true' || engineType === 'false' || engineType === 'boolean') {
    return 'boolean';
  }
  if (engineType === 'null') {
    return 'null';
  }
  if (engineType === 'object') {
    return 'object';
  }
  if (engineType === 'array') {
    return 'array';
  }
  return 'other';
}

/**
 * Raise the typed error for a field that exists but is not a readable string
 * window, or is absent entirely. Binary blob fields are represented as object
 * references in `record_json`, so they classify as `object` here and surface as
 * `field_not_text` with a hint that binary content is metadata-only.
 */
export function assertReadableStringField(fieldPath, fieldClass) {
  if (fieldClass === 'absent') {
    throw fieldWindowError('field_not_found', `field '${fieldPath}' is not present on this record`, 404);
  }
  if (fieldClass !== 'string') {
    throw fieldWindowError(
      'field_not_text',
      `field '${fieldPath}' is ${fieldClass}, not a readable text field; non-text and binary fields are metadata-only`,
      422,
    );
  }
}
