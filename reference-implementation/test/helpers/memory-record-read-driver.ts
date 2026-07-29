// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory driver for the record read conformance harness.
 *
 * Test-only second adapter for the existing record-read conformance suite.
 * Implements the harness's narrow, semantic driver shape directly — there is
 * no coupling to the SQLite reference (`server/records.js`, `server/db.js`,
 * `server/auth.ts`) and no production `RecordStore` interface is being
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

import type { ReadPage, ReadRecord } from "./record-read-conformance.ts";
import { CONFORMANCE_MANIFEST, CONFORMANCE_STREAM } from "./record-read-conformance.ts";

type Scalar = string | number | boolean | null;
type RecordData = Record<string, Scalar>;
type Comparable = Scalar | undefined;

interface ManifestStream {
  cursor_field?: string;
  name: string;
  primary_key?: string[] | string;
  required?: string[];
  schema?: { required?: string[] };
}

interface StoredRow {
  data: RecordData;
  deleted: boolean;
  emitted_at: string;
  version: number;
}

interface ChangeRow extends StoredRow {
  key: string;
  stream: string;
}

interface Position {
  cursor_value: Comparable;
  primary_key: Comparable[];
}

interface PositionedRow {
  data: RecordData;
  emitted_at: string;
  key: string;
  position: Position;
}

interface MemoryReadParams {
  changes_since?: string;
  cursor?: string | null;
  fields?: string[];
  filter?: Record<string, Scalar | { gte?: Scalar; gt?: Scalar; lte?: Scalar; lt?: Scalar }>;
  grantFields?: string[];
  limit?: number;
  order?: "asc" | "desc";
  stream?: string;
}

interface OpaqueCursor {
  cursor_value?: Comparable;
  k?: string;
  order?: "asc" | "desc";
  primary_key?: Comparable[];
  v?: number;
}

const DEFAULT_EMITTED_AT = "2026-04-28T12:00:00.000Z";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function getStreamManifest(streamName: string): ManifestStream | null {
  return (CONFORMANCE_MANIFEST.streams as ManifestStream[]).find((s) => s.name === streamName) || null;
}

function getRequiredFields(streamName: string): string[] {
  const m = getStreamManifest(streamName);
  return Array.isArray(m?.schema?.required) ? m.schema.required : [];
}

function getCursorField(streamName: string): string | null {
  const m = getStreamManifest(streamName);
  return m?.cursor_field || null;
}

function getPrimaryKeyFields(streamName: string): string[] {
  const m = getStreamManifest(streamName);
  if (Array.isArray(m?.primary_key)) {
    return m.primary_key;
  }
  if (typeof m?.primary_key === "string") {
    return [m.primary_key];
  }
  return [];
}

function isMissing(value: Comparable): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Total order used by the missing-bucket scenario. Returns negative if
 * `a` sorts before `b` in ASCending order; the caller flips the sign for
 * desc. Missing values bucket *after* present values in asc.
 */
function compareCursorValues(a: Comparable, b: Comparable): number {
  const am = isMissing(a);
  const bm = isMissing(b);
  if (am && bm) {
    return 0;
  }
  if (am) {
    return 1;
  }
  if (bm) {
    return -1;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  // Compare strings (date-time ISO strings sort lexicographically).
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) {
    return -1;
  }
  if (sa > sb) {
    return 1;
  }
  return 0;
}

/**
 * Preserve JavaScript relational comparison for the scalar filter domain:
 * string/string is lexical and every other scalar pair is numeric.
 */
function compareFilterValues(a: Exclude<Scalar, null>, b: Exclude<Scalar, null>): number {
  if (typeof a === "string" && typeof b === "string") {
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  }
  return Number(a) - Number(b);
}

function comparePrimaryKey(a: Comparable[], b: Comparable[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) {
      continue;
    }
    if (av === undefined || bv === undefined) {
      return av === undefined ? -1 : 1;
    }
    if (av === null) {
      return -1;
    }
    if (bv === null) {
      return 1;
    }
    if (av < bv) {
      return -1;
    }
    if (av > bv) {
      return 1;
    }
  }
  return 0;
}

function buildPosition(rawData: RecordData, recordKey: string, streamName: string): Position {
  const cursorField = getCursorField(streamName);
  const pkFields = getPrimaryKeyFields(streamName);
  const primaryKey = pkFields.length
    ? // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      pkFields.map((f) => (rawData?.[f] === undefined ? recordKey : rawData[f]))
    : [recordKey];
  return {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    cursor_value: cursorField ? (rawData?.[cursorField] ?? null) : null,
    primary_key: primaryKey,
  };
}

function comparePositions(a: Position, b: Position, order: "asc" | "desc"): number {
  const direction = order === "asc" ? 1 : -1;
  const cv = compareCursorValues(a.cursor_value, b.cursor_value);
  if (cv !== 0) {
    return cv * direction;
  }
  const pkCmp = comparePrimaryKey(a.primary_key, b.primary_key);
  return pkCmp * direction;
}

/**
 * `position` is strictly *after* `cursor` (i.e. should be on the next page).
 */
function isStrictlyAfter(position: Position, cursor: Position, order: "asc" | "desc"): boolean {
  return comparePositions(position, cursor, order) > 0;
}

function projectFields(data: RecordData, fields: string[] | null): RecordData {
  if (!fields) {
    return data;
  }
  const out: RecordData = {};
  for (const f of fields) {
    if (f in data) {
      out[f] = data[f] ?? null;
    }
  }
  return out;
}

function intersectFields(
  grantFields: string[] | undefined,
  requestFields: string[] | undefined,
  requiredFields: string[]
): string[] | null {
  let effective: string[] | null = null;
  if (Array.isArray(grantFields) && grantFields.length) {
    effective = [...grantFields];
  }
  if (Array.isArray(requestFields) && requestFields.length) {
    if (effective) {
      effective = requestFields.filter((f) => effective?.includes(f) === true);
    } else {
      effective = [...requestFields];
    }
  }
  if (effective) {
    const seen = new Set(effective);
    for (const r of requiredFields) {
      if (!seen.has(r)) {
        effective.push(r);
        seen.add(r);
      }
    }
  }
  return effective;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Conformance fixture keeps the complete protocol case matrix local.
function passesFilter(data: RecordData, filter: MemoryReadParams["filter"]): boolean {
  if (!filter) {
    return true;
  }
  for (const [field, raw] of Object.entries(filter)) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    const value = data?.[field];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const range = raw;
      // Range filter: nulls excluded from any range comparison, mirroring
      // the SQLite path's range-on-non-null behavior.
      if (value === null || value === undefined) {
        return false;
      }
      if (range.gte !== null && range.gte !== undefined && !(compareFilterValues(value, range.gte) >= 0)) {
        return false;
      }
      if (range.gt !== null && range.gt !== undefined && !(compareFilterValues(value, range.gt) > 0)) {
        return false;
      }
      if (range.lte !== null && range.lte !== undefined && !(compareFilterValues(value, range.lte) <= 0)) {
        return false;
      }
      if (range.lt !== null && range.lt !== undefined && !(compareFilterValues(value, range.lt) < 0)) {
        return false;
      }
    } else if (String(value) !== String(raw)) {
      // Exact filter: stringified compare so '5' === 5 the same way the
      // SQLite path's request-filter compiler accepts both shapes.
      return false;
    }
  }
  return true;
}

function encodeOpaque(payload: OpaqueCursor): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function decodeOpaque(token: string): OpaqueCursor | null {
  try {
    return JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function createMemoryRecordReadDriver() {
  // streamName -> Map<key, { data, version, deleted, emitted_at }>
  const streams = new Map<string, Map<string, StoredRow>>();
  // Monotonic per-driver version counter. Used both as the change-feed
  // ordering and as the watermark token for `changes_since`.
  let versionCounter = 0;
  // Linear change feed: every accepted upsert/delete in order.
  const changes: ChangeRow[] = [];

  function ensureStream(name: string): Map<string, StoredRow> {
    if (!streams.has(name)) {
      streams.set(name, new Map<string, StoredRow>());
    }
    const stream = streams.get(name);
    if (!stream) {
      throw new Error(`stream map missing for ${name}`);
    }
    return stream;
  }

  return {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Conformance fixture keeps the complete protocol case matrix local.
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async list(params: MemoryReadParams = {}): Promise<ReadPage> {
      const streamName = params.stream || CONFORMANCE_STREAM;
      const live = ensureStream(streamName);
      const requiredFields = getRequiredFields(streamName);

      const effectiveFields = intersectFields(params.grantFields, params.fields, requiredFields);

      // ---------- changes_since path ----------
      if (params.changes_since !== null && params.changes_since !== undefined) {
        const sinceVersion = (() => {
          if (params.changes_since === "beginning") {
            return 0;
          }
          const decoded = decodeOpaque(params.changes_since);
          if (decoded && decoded.v !== undefined && Number.isInteger(decoded.v)) {
            return decoded.v;
          }
          throw Object.assign(new Error("Malformed changes_since cursor"), { code: "invalid_cursor" });
        })();
        const sessionMaxVersion = versionCounter;

        // Roll up the latest change per key in (sinceVersion, sessionMaxVersion].
        const latestByKey = new Map<string, ChangeRow>();
        for (const c of changes) {
          if (c.stream !== streamName) {
            continue;
          }
          if (c.version <= sinceVersion) {
            continue;
          }
          if (c.version > sessionMaxVersion) {
            continue;
          }
          latestByKey.set(c.key, c);
        }

        const data: ReadRecord[] = [];
        // Emit in version-asc order so the response is deterministic.
        const sorted = [...latestByKey.values()].sort((a, b) => a.version - b.version);
        for (const c of sorted) {
          if (c.deleted) {
            // A row that *was* visible and got deleted should still show as
            // deleted in the change feed. The harness scenarios do not test
            // delete behavior in changes_since explicitly, but the SQLite
            // driver emits a deleted shape, so do the same here.
            if (!passesFilter(c.data, params.filter)) {
              continue;
            }
            data.push({
              deleted: true,
              emitted_at: c.emitted_at,
              id: c.key,
              object: "record",
              stream: streamName,
            });
            continue;
          }
          if (!passesFilter(c.data, params.filter)) {
            continue;
          }
          data.push({
            data: projectFields(c.data, effectiveFields),
            emitted_at: c.emitted_at,
            id: c.key,
            object: "record",
            stream: streamName,
          });
        }

        return {
          data,
          has_more: false,
          next_changes_since: encodeOpaque({ v: sessionMaxVersion }),
          object: "list",
        };
      }

      // ---------- regular cursor pagination path ----------
      const order = params.order === "desc" ? "desc" : "asc";
      const requestedLimit = params.limit ?? DEFAULT_LIMIT;
      const limit = Math.min(Number.isInteger(requestedLimit) ? requestedLimit : DEFAULT_LIMIT, MAX_LIMIT);

      // Materialize visible rows.
      const rows: PositionedRow[] = [];
      for (const [key, row] of live.entries()) {
        if (row.deleted) {
          continue;
        }
        if (!passesFilter(row.data, params.filter)) {
          continue;
        }
        rows.push({
          data: row.data,
          emitted_at: row.emitted_at,
          key,
          position: buildPosition(row.data, key, streamName),
        });
      }
      rows.sort((a, b) => comparePositions(a.position, b.position, order));

      // Decode opaque cursor and skip everything <= it.
      // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
      let cursorPosition = null;
      if (params.cursor !== null && params.cursor !== undefined) {
        const decoded = decodeOpaque(params.cursor);
        if (decoded?.k !== "memory:page" || decoded.order !== order) {
          throw Object.assign(new Error("Malformed cursor"), { code: "invalid_cursor" });
        }
        cursorPosition = {
          cursor_value: decoded.cursor_value ?? null,
          primary_key: Array.isArray(decoded.primary_key) ? decoded.primary_key : [],
        };
      }

      const eligible = cursorPosition ? rows.filter((r) => isStrictlyAfter(r.position, cursorPosition, order)) : rows;

      const pageRows = eligible.slice(0, limit);
      const hasMore = eligible.length > limit;

      const data: ReadRecord[] = pageRows.map((r) => ({
        data: projectFields(r.data, effectiveFields),
        emitted_at: r.emitted_at,
        id: r.key,
        object: "record",
        stream: streamName,
      }));

      const response: ReadPage = { data, has_more: hasMore, object: "list" };
      if (hasMore && pageRows.length) {
        const lastRow = pageRows.at(-1);
        if (!lastRow) {
          throw new Error("page row missing after non-empty check");
        }
        const last = lastRow.position;
        response.next_cursor = encodeOpaque({
          cursor_value: last.cursor_value ?? null,
          k: "memory:page",
          order,
          primary_key: last.primary_key,
        });
      }
      return response;
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async seed(
      records: Array<{ key: string; data: RecordData; emitted_at?: string; op?: "upsert" | "delete" }>,
      options: { stream?: string } = {}
    ): Promise<void> {
      const streamName = options.stream || CONFORMANCE_STREAM;
      const live = ensureStream(streamName);
      for (const record of records) {
        const op = record.op || "upsert";
        const emittedAt = record.emitted_at || DEFAULT_EMITTED_AT;

        if (op === "delete") {
          const cur = live.get(record.key);
          if (!cur || cur.deleted) {
            continue;
          }
          versionCounter += 1;
          live.set(record.key, {
            data: cur.data,
            deleted: true,
            emitted_at: emittedAt,
            version: versionCounter,
          });
          changes.push({
            data: cur.data,
            deleted: true,
            emitted_at: emittedAt,
            key: record.key,
            stream: streamName,
            version: versionCounter,
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
          deleted: false,
          emitted_at: emittedAt,
          version: versionCounter,
        });
        changes.push({
          data: record.data,
          deleted: false,
          emitted_at: emittedAt,
          key: record.key,
          stream: streamName,
          version: versionCounter,
        });
      }
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async setup() {
      streams.clear();
      changes.length = 0;
      versionCounter = 0;
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async teardown() {
      streams.clear();
      changes.length = 0;
      versionCounter = 0;
    },
  };
}
