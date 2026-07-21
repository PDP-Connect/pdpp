// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted MCP package picker — selection value encoding.
 *
 * The hosted MCP authorize-package consent page renders a multi-select form
 * where each row identifies one connector or one configured (connector,
 * connection) pair. The POST handler must recover the same tuple from the
 * submitted form values.
 *
 * Earlier encodings concatenated the raw connector identifier with `:` (for
 * example `connection:<connector_id>:<connection_id>`). That is unsafe: the
 * first-party reference connector ids are URL-shaped (`https://registry...`),
 * so naive `:` splitting truncated the connector id to `https` and produced
 * "Unknown connector: https" errors.
 *
 * The fix is structural, not a parser workaround. Selection values are
 * opaque-looking base64url(JSON) payloads:
 *
 *     base64url(JSON.stringify({ connector_id, connection_id|null }))
 *
 * Properties:
 *   - delimiter-free by construction — `:` cannot appear inside a base64url
 *     alphabet, so URL-shaped or future custom connector ids cannot collide
 *     with any wrapping delimiter;
 *   - stateless — no server-side picker session is required to round-trip a
 *     row's identity;
 *   - schema-checked on the server — the POST handler decodes, JSON.parses,
 *     and validates the shape rather than splitting strings;
 *   - canonical-key ready — the payload field name `connector_id` is the
 *     same shape the broader `canonicalize-connector-keys` change will fill
 *     with a canonical `connector_key`; only the value inside the payload
 *     changes, not the encoding.
 *
 * This module is deliberately tiny and synchronous so it can be unit-tested
 * independently of the AS HTTP surface and reused from the integration tests
 * that simulate picker submissions.
 */

function encodePayload(payload) {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodePayload(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let decoded;
  try {
    decoded = Buffer.from(trimmed, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded) return null;
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * Encode one picker row into an opaque selection value.
 *
 * @param {{ connectorId: string, connectionId?: string | null }} input
 * @returns {string} base64url(JSON) selection value
 */
export function encodeHostedMcpSelection(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('encodeHostedMcpSelection requires an object input');
  }
  const connectorId = typeof input.connectorId === 'string' ? input.connectorId.trim() : '';
  if (!connectorId) {
    throw new TypeError('encodeHostedMcpSelection requires a non-empty connectorId');
  }
  const connectionId = typeof input.connectionId === 'string' && input.connectionId.trim()
    ? input.connectionId.trim()
    : null;
  return encodePayload({ connector_id: connectorId, connection_id: connectionId });
}

/**
 * Parse a single submitted selection value.
 *
 * @param {unknown} raw — the form-submitted string
 * @returns {{ connectorId: string, connectionId: string | null } | null}
 *   normalized tuple, or `null` if the value is missing, malformed, or
 *   structurally invalid. Callers MUST treat `null` as "drop this row" and
 *   MUST NOT fall back to delimiter splitting.
 */
export function parseHostedMcpSelection(raw) {
  const payload = decodePayload(raw);
  if (!payload) return null;
  const connectorId = typeof payload.connector_id === 'string' ? payload.connector_id.trim() : '';
  if (!connectorId) return null;
  const connectionRaw = typeof payload.connection_id === 'string' ? payload.connection_id.trim() : '';
  const connectionId = connectionRaw ? connectionRaw : null;
  return { connectorId, connectionId };
}

function normalizeSubmittedValues(rawValues) {
  if (Array.isArray(rawValues)) {
    return rawValues;
  }
  if (typeof rawValues === 'string') {
    return [rawValues];
  }
  if (rawValues && typeof rawValues === 'object') {
    // qs yields a numeric-keyed object, not an array, when repeated params
    // exceed its arrayLimit. Hosted MCP forms can legitimately exceed that
    // with per-stream checkboxes.
    return Object.values(rawValues);
  }
  return [];
}

/**
 * Parse zero or more submitted selection values, deduplicating by
 * (connector_id, connection_id).
 *
 * Accepts either a single string (one selected row) or an array of strings
 * (multi-select). Malformed entries are dropped silently — callers should
 * separately enforce a non-empty result if at least one selection is
 * required.
 *
 * @param {unknown} rawValues
 * @returns {Array<{ connectorId: string, connectionId: string | null }>}
 */
export function parseHostedMcpSelections(rawValues) {
  const values = normalizeSubmittedValues(rawValues);
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const parsed = parseHostedMcpSelection(raw);
    if (!parsed) continue;
    const dedupeKey = JSON.stringify([parsed.connectorId, parsed.connectionId ?? '']);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(parsed);
  }
  return out;
}

/**
 * Encode one picker stream checkbox value. Each stream checkbox carries its
 * own source identity so the POST handler can dispatch a stream to the
 * matching `(connector_id, connection_id)` selection without cross-field
 * correlation. The encoded value is base64url(JSON) for the same
 * delimiter-free reasons that govern `encodeHostedMcpSelection`.
 *
 * @param {{ connectorId: string, connectionId?: string | null, streamName: string }} input
 * @returns {string}
 */
export function encodeHostedMcpStreamSelection(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('encodeHostedMcpStreamSelection requires an object input');
  }
  const connectorId = typeof input.connectorId === 'string' ? input.connectorId.trim() : '';
  if (!connectorId) {
    throw new TypeError('encodeHostedMcpStreamSelection requires a non-empty connectorId');
  }
  const streamName = typeof input.streamName === 'string' ? input.streamName.trim() : '';
  if (!streamName) {
    throw new TypeError('encodeHostedMcpStreamSelection requires a non-empty streamName');
  }
  const connectionId = typeof input.connectionId === 'string' && input.connectionId.trim()
    ? input.connectionId.trim()
    : null;
  return encodePayload({ connector_id: connectorId, connection_id: connectionId, stream: streamName });
}

/**
 * Parse a single submitted stream-selection value.
 *
 * @param {unknown} raw
 * @returns {{ connectorId: string, connectionId: string | null, streamName: string } | null}
 */
export function parseHostedMcpStreamSelection(raw) {
  const payload = decodePayload(raw);
  if (!payload) return null;
  const connectorId = typeof payload.connector_id === 'string' ? payload.connector_id.trim() : '';
  if (!connectorId) return null;
  const streamName = typeof payload.stream === 'string' ? payload.stream.trim() : '';
  if (!streamName) return null;
  const connectionRaw = typeof payload.connection_id === 'string' ? payload.connection_id.trim() : '';
  const connectionId = connectionRaw ? connectionRaw : null;
  return { connectorId, connectionId, streamName };
}

/**
 * Parse zero or more submitted stream-selection values, deduplicating by
 * (connector_id, connection_id, stream). The result is grouped by source key
 * so callers can join it against the source selections without an extra pass.
 *
 * The returned `bySource` map keys each source by the same JSON string used
 * for dedupe in `parseHostedMcpSelections`, so callers can look up a stream
 * subset for any selected source without recomputing the key.
 *
 * @param {unknown} rawValues
 * @returns {{
 *   entries: Array<{ connectorId: string, connectionId: string | null, streamName: string }>,
 *   bySource: Map<string, Set<string>>,
 * }}
 */
export function parseHostedMcpStreamSelections(rawValues) {
  const values = normalizeSubmittedValues(rawValues);
  const seenEntries = new Set();
  const entries = [];
  const bySource = new Map();
  for (const raw of values) {
    const parsed = parseHostedMcpStreamSelection(raw);
    if (!parsed) continue;
    const sourceKey = JSON.stringify([parsed.connectorId, parsed.connectionId ?? '']);
    const entryKey = `${sourceKey}::${parsed.streamName}`;
    if (seenEntries.has(entryKey)) continue;
    seenEntries.add(entryKey);
    entries.push(parsed);
    let streams = bySource.get(sourceKey);
    if (!streams) {
      streams = new Set();
      bySource.set(sourceKey, streams);
    }
    streams.add(parsed.streamName);
  }
  return { entries, bySource };
}

/**
 * Build the deterministic source dedupe key used by `parseHostedMcpSelections`
 * and `parseHostedMcpStreamSelections.bySource`. Exposed so callers building a
 * lookup from a `{ connectorId, connectionId }` tuple do not have to mirror
 * the internal JSON shape by hand.
 *
 * @param {{ connectorId: string, connectionId?: string | null }} selection
 * @returns {string}
 */
export function hostedMcpSourceKey(selection) {
  const connectorId = typeof selection?.connectorId === 'string' ? selection.connectorId : '';
  const connectionId = typeof selection?.connectionId === 'string' && selection.connectionId
    ? selection.connectionId
    : '';
  return JSON.stringify([connectorId, connectionId]);
}
