function uniqueFields(fields) {
  return fields.filter(
    (field, index, all) =>
      typeof field === 'string' && field.length > 0 && all.indexOf(field) === index,
  );
}

export function pickSemanticTimestamp(manifestStream, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const candidates = uniqueFields([
    manifestStream?.consent_time_field || null,
    manifestStream?.cursor_field || null,
  ]);
  for (const field of candidates) {
    const value = data[field];
    if (typeof value === 'string' && value.trim()) {
      return { field, value: value.trim() };
    }
  }
  return null;
}

function parseDateLike(value, boundary = 'exact') {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const normalized = dateOnly
    ? `${trimmed}${boundary === 'end' ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`
    : trimmed;
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? millis : null;
}

export function compareTimestampValues(left, right) {
  const leftMillis = parseDateLike(left);
  const rightMillis = parseDateLike(right);
  if (leftMillis !== null && rightMillis !== null) {
    return leftMillis - rightMillis;
  }
  return String(left || '').localeCompare(String(right || ''));
}

export function timestampWithinWindow(value, since, until) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (since) {
    const valueMillis = parseDateLike(value, 'start');
    const sinceMillis = parseDateLike(since, 'start');
    if (valueMillis !== null && sinceMillis !== null) {
      if (valueMillis < sinceMillis) return false;
    } else if (String(value) < String(since)) {
      return false;
    }
  }
  if (until) {
    const valueMillis = parseDateLike(value, 'end');
    const untilMillis = parseDateLike(until, 'end');
    if (valueMillis !== null && untilMillis !== null) {
      if (valueMillis > untilMillis) return false;
    } else if (String(value) > String(until)) {
      return false;
    }
  }
  return true;
}

export function chooseDisplayTimestamp({ semanticTimestamp, emittedAt, mode = 'native' }) {
  if (mode === 'native' && semanticTimestamp?.value) return semanticTimestamp.value;
  return emittedAt;
}

function buildSnippet(value, index, queryLength, radius = 60) {
  const start = Math.max(0, index - radius);
  const end = Math.min(value.length, index + queryLength + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < value.length ? '…' : '';
  return `${prefix}${value.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

function fieldPathToString(parts) {
  let result = '';
  for (const part of parts) {
    if (typeof part === 'number') {
      result += `[${part}]`;
      continue;
    }
    result += result ? `.${part}` : part;
  }
  return result;
}

function isAlphaNumeric(char) {
  return typeof char === 'string' && /[\p{L}\p{N}]/u.test(char);
}

function isSimpleWordQuery(query) {
  return /^[\p{L}\p{N}_-]+$/u.test(query);
}

function tokenizeQuery(query) {
  return String(query || '').match(/[\p{L}\p{N}]+/gu) || [];
}

function findMatchIndex(value, needle) {
  const lower = value.toLowerCase();
  if (!needle) return -1;
  if (!isSimpleWordQuery(needle)) return lower.indexOf(needle);

  let fromIndex = 0;
  while (fromIndex < lower.length) {
    const index = lower.indexOf(needle, fromIndex);
    if (index === -1) return -1;
    const before = index > 0 ? lower[index - 1] : null;
    const after = index + needle.length < lower.length ? lower[index + needle.length] : null;
    if (!isAlphaNumeric(before) && !isAlphaNumeric(after)) {
      return index;
    }
    fromIndex = index + needle.length;
  }
  return -1;
}

function searchValue(value, needle, parts) {
  if (typeof value === 'string') {
    const index = findMatchIndex(value, needle);
    if (index === -1) return null;
    return {
      field: fieldPathToString(parts),
      snippet: buildSnippet(value, index, needle.length),
    };
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    const rendered = String(value);
    const index = findMatchIndex(rendered, needle);
    if (index === -1) return null;
    return {
      field: fieldPathToString(parts),
      snippet: rendered,
    };
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const match = searchValue(value[i], needle, [...parts, i]);
      if (match) return match;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const match = searchValue(child, needle, [...parts, key]);
      if (match) return match;
    }
  }

  return null;
}

export function findQueryMatch(data, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return null;
  return searchValue(data, needle, []);
}

export function buildRecordSearchMatchExpression(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return null;

  const tokens = tokenizeQuery(trimmed);
  if (!tokens.length) return null;

  const isWordOrPhrase = /^[\p{L}\p{N}\s_-]+$/u.test(trimmed);
  const allInformative = tokens.every((token) => token.length >= 2);
  if (!isWordOrPhrase && !allInformative) {
    return null;
  }

  return tokens
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' AND ');
}

export function encodeOffsetCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Number.isInteger(decoded?.offset) || decoded.offset < 0) return null;
    return decoded.offset;
  } catch {
    return null;
  }
}
