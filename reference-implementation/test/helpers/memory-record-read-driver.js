// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory driver for the record read conformance harness.
 *
 * Test-only second adapter for the existing record-read conformance suite.
 * Implements the harness's narrow, semantic driver shape directly — there is
 * no coupling to the SQLite reference (`server/records.js`, `server/db.js`,
 * `server/auth.js`) and no production `RecordStore` interface is being
 * extracted by this adapter.
 *
 * The driver pins the same observable behavior the SQLite reference does:
 *
 *   - asc/desc cursor pagination ordered by manifest cursor_field with the
 *     primary_key as the tiebreaker;
 *   - opaque, adapter-owned cursor tokens (a base64 JSON blob whose internal
 *     shape is *not* asserted by the harness);
 *   - a missing/null cursor bucket that sorts after present rows in asc and
 *     before in desc, ordered by pk within the bucket;
 *   - `changes_since=beginning` bootstrap that emits one record per live key
 *     and a `next_changes_since` watermark; subsequent reads with that
 *     watermark only surface keys that changed strictly after the watermark;
 *   - grant-level field projection (rows never carry fields outside
 *     `grantFields`) with request `fields` narrowing further but always
 *     keeping the manifest-required fields;
 *   - exact filters compared as strings, and range filters that exclude
 *     rows whose filter value is null.
 *
 * Cursors and `next_changes_since` tokens are deliberately *not* compatible
 * with the SQLite driver. The harness treats both as opaque adapter tokens
 * and never asserts equality across drivers, which is what lets the second
 * adapter prove portability instead of replaying SQLite-specific encodings.
 *
 * SHALL NOT be exported from production code, used as a polyfill connector
 * adapter, or treated as a `RecordStore` contract.
 *
 * Spec: openspec/changes/add-record-read-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import {
  CONFORMANCE_MANIFEST,
  CONFORMANCE_NULLABLE_CURSOR_STREAM,
  CONFORMANCE_STREAM,
} from './record-read-conformance.js';

const DEFAULT_EMITTED_AT = '2026-04-28T12:00:00.000Z';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function getStreamManifest(streamName) {
  return CONFORMANCE_MANIFEST.streams.find((s) => s.name === streamName) || null;
}

function getRequiredFields(streamName) {
  const m = getStreamManifest(streamName);
  return Array.isArray(m?.schema?.required) ? m.schema.required : [];
}

function getCursorField(streamName) {
  const m = getStreamManifest(streamName);
  return m?.cursor_field || null;
}

function getPrimaryKeyFields(streamName) {
  const m = getStreamManifest(streamName);
  if (Array.isArray(m?.primary_key)) return m.primary_key;
  if (typeof m?.primary_key === 'string') return [m.primary_key];
  return [];
}

function isMissing(value) {
  return value == null || value === '';
}

/**
 * Total order used by the missing-bucket scenario. Returns negative if
 * `a` sorts before `b` in ASCending order; the caller flips the sign for
 * desc. Missing values bucket *after* present values in asc.
 */
function compareCursorValues(a, b) {
  const am = isMissing(a);
  const bm = isMissing(b);
  if (am && bm) return 0;
  if (am) return 1;
  if (bm) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // Compare strings (date-time ISO strings sort lexicographically).
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function comparePrimaryKey(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) continue;
    if (av == null) return -1;
    if (bv == null) return 1;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function buildPosition(rawData, recordKey, streamName) {
  const cursorField = getCursorField(streamName);
  const pkFields = getPrimaryKeyFields(streamName);
  const primaryKey = pkFields.length
    ? pkFields.map((f) => (rawData?.[f] !== undefined ? rawData[f] : recordKey))
    : [recordKey];
  return {
    cursor_value: cursorField ? (rawData?.[cursorField] ?? null) : null,
    primary_key: primaryKey,
  };
}

function comparePositions(a, b, order) {
  const direction = order === 'asc' ? 1 : -1;
  const cv = compareCursorValues(a.cursor_value, b.cursor_value);
  if (cv !== 0) return cv * direction;
  const pkCmp = comparePrimaryKey(a.primary_key, b.primary_key);
  return pkCmp * direction;
}

/**
 * `position` is strictly *after* `cursor` (i.e. should be on the next page).
 */
function isStrictlyAfter(position, cursor, order) {
  return comparePositions(position, cursor, order) > 0;
}

function projectFields(data, fields) {
  if (!fields) return data;
  const out = {};
  for (const f of fields) if (f in data) out[f] = data[f];
  return out;
}

function intersectFields(grantFields, requestFields, requiredFields) {
  let effective = null;
  if (Array.isArray(grantFields) && grantFields.length) effective = [...grantFields];
  if (Array.isArray(requestFields) && requestFields.length) {
    if (effective) {
      effective = requestFields.filter((f) => effective.includes(f));
    } else {
      effective = [...requestFields];
    }
  }
  if (effective) {
    const seen = new Set(effective);
    for (const r of requiredFields) if (!seen.has(r)) {
      effective.push(r);
      seen.add(r);
    }
  }
  return effective;
}

function passesFilter(data, filter) {
  if (!filter) return true;
  for (const [field, raw] of Object.entries(filter)) {
    const value = data?.[field];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Range filter: nulls excluded from any range comparison, mirroring
      // the SQLite path's range-on-non-null behavior.
      if (value == null) return false;
      if (raw.gte != null && !(value >= raw.gte)) return false;
      if (raw.gt != null && !(value > raw.gt)) return false;
      if (raw.lte != null && !(value <= raw.lte)) return false;
      if (raw.lt != null && !(value < raw.lt)) return false;
    } else {
      // Exact filter: stringified compare so '5' === 5 the same way the
      // SQLite path's request-filter compiler accepts both shapes.
      if (String(value) !== String(raw)) return false;
    }
  }
  return true;
}

function encodeOpaque(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decodeOpaque(token) {
  try {
    return JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function createMemoryRecordReadDriver() {
  // streamName -> Map<key, { data, version, deleted, emitted_at }>
  const streams = new Map();
  // Monotonic per-driver version counter. Used both as the change-feed
  // ordering and as the watermark token for `changes_since`.
  let versionCounter = 0;
  // Linear change feed: every accepted upsert/delete in order.
  const changes = [];

  function ensureStream(name) {
    if (!streams.has(name)) streams.set(name, new Map());
    return streams.get(name);
  }

  return {
    async setup() {
      streams.clear();
      changes.length = 0;
      versionCounter = 0;
    },

    async teardown() {
      streams.clear();
      changes.length = 0;
      versionCounter = 0;
    },

    async seed(records, options = {}) {
      const streamName = options.stream || CONFORMANCE_STREAM;
      const live = ensureStream(streamName);
      for (const record of records) {
        const op = record.op || 'upsert';
        const emittedAt = record.emitted_at || DEFAULT_EMITTED_AT;

        if (op === 'delete') {
          const cur = live.get(record.key);
          if (!cur || cur.deleted) continue;
          versionCounter += 1;
          live.set(record.key, {
            data: cur.data,
            version: versionCounter,
            deleted: true,
            emitted_at: emittedAt,
          });
          changes.push({
            version: versionCounter,
            stream: streamName,
            key: record.key,
            data: cur.data,
            deleted: true,
            emitted_at: emittedAt,
          });
          continue;
        }

        const cur = live.get(record.key);
        const nextJson = JSON.stringify(record.data);
        if (cur && !cur.deleted && JSON.stringify(cur.data) === nextJson) {
          // No-op re-ingest: leave version/change-feed alone.
          continue;
        }
        versionCounter += 1;
        live.set(record.key, {
          data: record.data,
          version: versionCounter,
          deleted: false,
          emitted_at: emittedAt,
        });
        changes.push({
          version: versionCounter,
          stream: streamName,
          key: record.key,
          data: record.data,
          deleted: false,
          emitted_at: emittedAt,
        });
      }
    },

    async list(params = {}) {
      const streamName = params.stream || CONFORMANCE_STREAM;
      const live = ensureStream(streamName);
      const requiredFields = getRequiredFields(streamName);

      const effectiveFields = intersectFields(
        params.grantFields,
        params.fields,
        requiredFields,
      );

      // ---------- changes_since path ----------
      if (params.changes_since != null) {
        const sinceVersion = (() => {
          if (params.changes_since === 'beginning') return 0;
          const decoded = decodeOpaque(params.changes_since);
          if (decoded && Number.isInteger(decoded.v)) return decoded.v;
          const err = new Error('Malformed changes_since cursor');
          err.code = 'invalid_cursor';
          throw err;
        })();
        const sessionMaxVersion = versionCounter;

        // Roll up the latest change per key in (sinceVersion, sessionMaxVersion].
        const latestByKey = new Map();
        for (const c of changes) {
          if (c.stream !== streamName) continue;
          if (c.version <= sinceVersion) continue;
          if (c.version > sessionMaxVersion) continue;
          latestByKey.set(c.key, c);
        }

        const data = [];
        // Emit in version-asc order so the response is deterministic.
        const sorted = [...latestByKey.values()].sort((a, b) => a.version - b.version);
        for (const c of sorted) {
          if (c.deleted) {
            // A row that *was* visible and got deleted should still show as
            // deleted in the change feed. The harness scenarios do not test
            // delete behavior in changes_since explicitly, but the SQLite
            // driver emits a deleted shape, so do the same here.
            if (!passesFilter(c.data, params.filter)) continue;
            data.push({
              object: 'record',
              id: c.key,
              stream: streamName,
              deleted: true,
              emitted_at: c.emitted_at,
            });
            continue;
          }
          if (!passesFilter(c.data, params.filter)) continue;
          data.push({
            object: 'record',
            id: c.key,
            stream: streamName,
            data: projectFields(c.data, effectiveFields),
            emitted_at: c.emitted_at,
          });
        }

        return {
          object: 'list',
          has_more: false,
          data,
          next_changes_since: encodeOpaque({ v: sessionMaxVersion }),
        };
      }

      // ---------- regular cursor pagination path ----------
      const order = params.order === 'desc' ? 'desc' : 'asc';
      const limit = Math.min(
        Number.isInteger(params.limit) ? params.limit : (params.limit || DEFAULT_LIMIT),
        MAX_LIMIT,
      );

      // Materialize visible rows.
      const rows = [];
      for (const [key, row] of live.entries()) {
        if (row.deleted) continue;
        if (!passesFilter(row.data, params.filter)) continue;
        rows.push({
          key,
          data: row.data,
          emitted_at: row.emitted_at,
          position: buildPosition(row.data, key, streamName),
        });
      }
      rows.sort((a, b) => comparePositions(a.position, b.position, order));

      // Decode opaque cursor and skip everything <= it.
      let cursorPosition = null;
      if (params.cursor != null) {
        const decoded = decodeOpaque(params.cursor);
        if (!decoded || decoded.k !== 'memory:page' || decoded.order !== order) {
          const err = new Error('Malformed cursor');
          err.code = 'invalid_cursor';
          throw err;
        }
        cursorPosition = {
          cursor_value: decoded.cursor_value ?? null,
          primary_key: Array.isArray(decoded.primary_key) ? decoded.primary_key : [],
        };
      }

      const eligible = cursorPosition
        ? rows.filter((r) => isStrictlyAfter(r.position, cursorPosition, order))
        : rows;

      const pageRows = eligible.slice(0, limit);
      const hasMore = eligible.length > limit;

      const data = pageRows.map((r) => ({
        object: 'record',
        id: r.key,
        stream: streamName,
        data: projectFields(r.data, effectiveFields),
        emitted_at: r.emitted_at,
      }));

      const response = { object: 'list', has_more: hasMore, data };
      if (hasMore && pageRows.length) {
        const last = pageRows[pageRows.length - 1].position;
        response.next_cursor = encodeOpaque({
          k: 'memory:page',
          order,
          cursor_value: last.cursor_value ?? null,
          primary_key: last.primary_key,
        });
      }
      return response;
    },
  };
}
