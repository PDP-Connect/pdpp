/**
 * Deliberately broken in-memory driver for record-read harness falsifiability.
 *
 * This driver exists ONLY for the conformance harness's negative proof. It
 * implements a small in-memory store whose read path is intentionally wrong
 * in two specific ways:
 *
 *   1. Field projection is a no-op: the driver always returns the full
 *      record `data`, ignoring both `grantFields` and request `fields`. This
 *      is the failure mode that protects against ungranted/unrequested
 *      fields leaking to the wire.
 *
 *   2. Pagination uses a length-based offset rather than a cursor seek and
 *      encodes a buggy cursor that *overlaps* page boundaries by one row.
 *      This is the failure mode that protects against duplicate rows or
 *      gaps across pages.
 *
 * Other behaviors (filters, change-feed, null-cursor bucket order) are kept
 * faithful enough that the harness's *other* scenarios pass — the negative
 * proof only needs at least one scenario to detect each broken invariant.
 *
 * This driver SHALL NOT be used as a production adapter or environment
 * profile. It is only imported from the falsifiability test.
 */

import {
  CONFORMANCE_NULLABLE_CURSOR_STREAM,
  CONFORMANCE_STREAM,
} from './record-read-conformance.js';

const STREAM_CURSOR_FIELD = {
  [CONFORMANCE_STREAM]: 'created_at',
  [CONFORMANCE_NULLABLE_CURSOR_STREAM]: 'last_modified_on',
};

function compareCursorValues(a, b) {
  // null-bucket-last in asc order. Mirrors the spec.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function passesFilter(data, filter) {
  if (!filter) return true;
  for (const [field, raw] of Object.entries(filter)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const v = data?.[field];
      if (v == null) return false;
      if (raw.gte != null && !(v >= raw.gte)) return false;
      if (raw.gt != null && !(v > raw.gt)) return false;
      if (raw.lte != null && !(v <= raw.lte)) return false;
      if (raw.lt != null && !(v < raw.lt)) return false;
    } else {
      if (String(data?.[field]) !== String(raw)) return false;
    }
  }
  return true;
}

export function createBrokenInMemoryRecordReadDriver() {
  // streamName -> Map<key, { data, version, deleted, emitted_at }>
  const streams = new Map();
  let versionCounter = 0;
  // change feed across all streams: { version, stream, key, data, deleted, emitted_at }
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

    async teardown() {},

    async seed(records, options = {}) {
      const stream = options.stream || CONFORMANCE_STREAM;
      const live = ensureStream(stream);
      for (const record of records) {
        const op = record.op || 'upsert';
        if (op === 'delete') {
          if (!live.has(record.key) || live.get(record.key).deleted) continue;
          versionCounter += 1;
          const prev = live.get(record.key);
          live.set(record.key, {
            data: prev.data,
            version: versionCounter,
            deleted: true,
            emitted_at: record.emitted_at || prev.emitted_at,
          });
          changes.push({
            version: versionCounter,
            stream,
            key: record.key,
            data: prev.data,
            deleted: true,
            emitted_at: record.emitted_at || prev.emitted_at,
          });
          continue;
        }
        const cur = live.get(record.key);
        const nextJson = JSON.stringify(record.data);
        if (cur && !cur.deleted && JSON.stringify(cur.data) === nextJson) continue;
        versionCounter += 1;
        live.set(record.key, {
          data: record.data,
          version: versionCounter,
          deleted: false,
          emitted_at: record.emitted_at,
        });
        changes.push({
          version: versionCounter,
          stream,
          key: record.key,
          data: record.data,
          deleted: false,
          emitted_at: record.emitted_at,
        });
      }
    },

    async list(params = {}) {
      const streamName = params.stream || CONFORMANCE_STREAM;
      const live = ensureStream(streamName);

      // changes_since path (faithful enough; bug surface is in pagination
      // and projection above, not the change feed).
      if (params.changes_since != null) {
        const sinceVersion = params.changes_since === 'beginning'
          ? 0
          : Number.parseInt(JSON.parse(Buffer.from(params.changes_since, 'base64').toString()).v, 10) || 0;
        const sessionMax = versionCounter;

        // Roll up to latest change per key after sinceVersion.
        const latestByKey = new Map();
        for (const c of changes) {
          if (c.stream !== streamName) continue;
          if (c.version <= sinceVersion) continue;
          if (c.version > sessionMax) continue;
          latestByKey.set(c.key, c);
        }
        const visibleChanges = [];
        for (const c of latestByKey.values()) {
          if (c.deleted) {
            visibleChanges.push({
              object: 'record',
              id: c.key,
              stream: streamName,
              deleted: true,
              emitted_at: c.emitted_at,
            });
          } else {
            // BUG #1: projection is a no-op. Always return full data.
            visibleChanges.push({
              object: 'record',
              id: c.key,
              stream: streamName,
              data: c.data,
              emitted_at: c.emitted_at,
            });
          }
        }
        return {
          object: 'list',
          has_more: false,
          data: visibleChanges,
          next_changes_since: Buffer.from(JSON.stringify({ v: sessionMax })).toString('base64'),
        };
      }

      // Materialize visible rows (non-deleted), apply filter, sort.
      const cursorField = STREAM_CURSOR_FIELD[streamName] || 'created_at';
      const order = params.order === 'desc' ? 'desc' : 'asc';
      const limit = Math.min(params.limit || 25, 100);

      const rows = [];
      for (const [key, row] of live.entries()) {
        if (row.deleted) continue;
        if (!passesFilter(row.data, params.filter)) continue;
        rows.push({ key, data: row.data });
      }
      rows.sort((a, b) => {
        const av = a.data?.[cursorField];
        const bv = b.data?.[cursorField];
        const c = compareCursorValues(av, bv);
        if (c !== 0) return order === 'asc' ? c : -c;
        // pk tiebreaker
        if (a.key < b.key) return order === 'asc' ? -1 : 1;
        if (a.key > b.key) return order === 'asc' ? 1 : -1;
        return 0;
      });

      // BUG #2: cursor uses a length-based offset that overlaps page
      // boundaries by one. The encoded cursor records the offset *minus 1*,
      // so the next page repeats the last row of the prior page.
      let offset = 0;
      if (params.cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(params.cursor, 'base64').toString());
          offset = Number.isInteger(decoded.o) ? decoded.o : 0;
        } catch {
          offset = 0;
        }
      }

      const pageRows = rows.slice(offset, offset + limit);
      const nextOffset = offset + limit - 1; // <-- the off-by-one bug.
      const hasMore = nextOffset < rows.length - 1;

      // BUG #1: ignore grantFields and fields entirely.
      const data = pageRows.map((r) => ({
        object: 'record',
        id: r.key,
        stream: streamName,
        data: r.data,
        emitted_at: live.get(r.key).emitted_at,
      }));

      const response = { object: 'list', has_more: hasMore, data };
      if (hasMore && data.length) {
        response.next_cursor = Buffer.from(
          JSON.stringify({ o: nextOffset }),
        ).toString('base64');
      }
      return response;
    },
  };
}
