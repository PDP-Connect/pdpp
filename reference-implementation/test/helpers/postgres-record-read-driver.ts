// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres-backed driver for the record read conformance harness.
 *
 * Test-only second adapter for the existing record-read conformance suite,
 * gated by `PDPP_TEST_POSTGRES_URL` against the Compose Postgres proof
 * service (see `add-compose-postgres-proof-service`). It exists to evidence
 * that the harness pins *portable* record-read semantics rather than SQLite
 * accidents — there is no production `RecordStore` interface, no runtime
 * Postgres backend, and no coupling to `server/records.js` or its SQL.
 *
 * Behavior pinned by this driver:
 *
 *   - rows live as JSONB in a single records table inside a fresh,
 *     uniquely-named per-scenario schema; the schema is dropped during
 *     `teardown()` so concurrent runs and partial failures do not leak
 *     into one another;
 *   - the change feed is a separate append-only `record_changes` table
 *     keyed by a per-(connector_id, stream) version counter and is the
 *     sole source of truth for `changes_since`;
 *   - cursor tokens are opaque to the harness — this driver encodes a
 *     base64 JSON `{ kind: 'pg:page', order, cursor_value, primary_key }`
 *     payload, which has no shared shape with the SQLite cursor and is
 *     never asserted against by the harness;
 *   - the missing/null cursor bucket is implemented in SQL using
 *     `cursor_value IS NULL` and ordered after present rows in asc and
 *     before in desc, with `primary_key` (one-element pk in the harness
 *     manifest) as the tiebreaker;
 *   - filter compilation is a thin layer on top of `record_data ->> field`
 *     for exact filters and a typed cast for range filters; the driver
 *     consults the harness manifest to choose `(::numeric)` vs
 *     `(::timestamptz)` casts.
 *
 * The driver is gated by its caller (the test file) and SHALL NOT be
 * imported from any production code path. It does not introduce
 * `PDPP_STORAGE_BACKEND`, `PDPP_DATABASE_URL`, or Kysely.
 *
 * Spec: openspec/changes/add-record-read-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 *       (second-adapter requirement from
 *        openspec/changes/add-second-conformance-adapters/).
 */

import { Client } from "pg";
import type { ReadPage, ReadRecord } from "./record-read-conformance.ts";
import { CONFORMANCE_MANIFEST, CONFORMANCE_STREAM } from "./record-read-conformance.ts";

const SCHEMA_PREFIX = "pdpp_recread_";
const DEFAULT_EMITTED_AT = "2026-04-28T12:00:00.000Z";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
type PgParam = string | number | boolean | null | Date;
interface PgRow {
  [key: string]: unknown;
}
interface ManifestStream {
  cursor_field?: string;
  name: string;
  primary_key?: string | string[];
  schema?: { required?: string[]; properties?: Record<string, { type?: string | string[]; format?: string }> };
}
interface Manifest {
  connector_id: string;
  streams: ManifestStream[];
}
interface SeedRecord {
  data: Record<string, unknown>;
  emitted_at?: string;
  key: string;
  op?: string;
}
interface SeedOptions {
  stream?: string;
}
interface RangeFilter {
  gt?: string | number;
  gte?: string | number;
  lt?: string | number;
  lte?: string | number;
}
interface ListParams {
  changes_since?: string;
  cursor?: string | null;
  fields?: string[];
  filter?: Record<string, string | number | RangeFilter | null>;
  grantFields?: string[];
  limit?: number;
  order?: "asc" | "desc";
  stream?: string;
}
interface CursorPosition {
  cursor_value: string | null;
  primary_key_text: string;
}

function uniqueSchemaName() {
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e8).toString(36);
  return `${SCHEMA_PREFIX}${stamp}_${rand}`.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function getStreamManifest(streamName: string): ManifestStream | null {
  return (CONFORMANCE_MANIFEST as Manifest).streams.find((s) => s.name === streamName) || null;
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

function fieldSchemaFor(streamName: string, field: string) {
  const m = getStreamManifest(streamName);
  return m?.schema?.properties?.[field] || null;
}

function nonNullSchemaTypes(schema: { type?: string | string[] } | null): string[] {
  const raw = schema?.type;
  if (raw === null || raw === undefined) {
    return [];
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((t): t is string => typeof t === "string" && t !== "null");
}

/**
 * Pick the SQL cast that matches the manifest-declared type. Numbers/integers
 * cast to numeric; date/date-time strings cast to timestamptz. Anything else
 * stays as text.
 */
function rangeCastFor(streamName: string, field: string): string {
  const fs = fieldSchemaFor(streamName, field);
  const types = nonNullSchemaTypes(fs);
  if (types.length === 1) {
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const only = types[0];
    if (only === "integer" || only === "number") {
      return "numeric";
    }
    if (only === "string" && (fs?.format === "date" || fs?.format === "date-time")) {
      return "timestamptz";
    }
  }
  return "text";
}

function projectFields(data: Record<string, unknown>, fields: string[] | null): Record<string, unknown> {
  if (!fields) {
    return data;
  }
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in data) {
      out[f] = data[f];
    }
  }
  return out;
}

function rowData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
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
      const existing = effective;
      effective = requestFields.filter((f) => existing.includes(f));
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

function encodeOpaque(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function decodeOpaque(token: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.connectionString  e.g. PDPP_TEST_POSTGRES_URL
 */
export function createPostgresRecordReadDriver({ connectionString }: { connectionString: string }) {
  if (!connectionString) {
    throw new Error("createPostgresRecordReadDriver requires connectionString");
  }

  const schema = uniqueSchemaName();
  let client: InstanceType<typeof Client> | null = null;

  function q(ident: string): string {
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    if (!/^[a-z0-9_]+$/.test(ident)) {
      throw new Error(`unsafe identifier rejected: ${ident}`);
    }
    return `"${ident}"`;
  }

  async function exec(sql: string, params: PgParam[] = []): Promise<{ rows: PgRow[]; rowCount: number }> {
    const result = await client?.query<PgRow>(sql, params);
    if (!result) {
      throw new Error("Postgres record-read driver has not been set up");
    }
    return { rowCount: result.rowCount ?? 0, rows: result.rows };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the test keeps the full observable scenario local for auditability.
  function buildFilterClause(
    streamName: string,
    filter: Record<string, string | number | RangeFilter | null> | undefined,
    params: PgParam[]
  ): string {
    if (!filter) {
      return "";
    }
    // biome-ignore lint/suspicious/noEvolvingTypes: the accumulator intentionally represents heterogeneous fixture observations.
    const clauses = [];
    for (const [field, raw] of Object.entries(filter)) {
      // Defensive: harness only sends a-z fields. Reject anything that
      // would let a stray key escape the JSONB extractor.
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      if (!/^[a-zA-Z0-9_]+$/.test(field)) {
        throw new Error(`unsafe filter field: ${field}`);
      }

      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const cast = rangeCastFor(streamName, field);
        const lhs = `(record_data->>'${field}')::${cast}`;
        // Range filters exclude null (record_data->>field IS NULL).
        clauses.push(`record_data ? '${field}' AND record_data->>'${field}' IS NOT NULL`);
        if (raw.gte !== null && raw.gte !== undefined) {
          params.push(raw.gte);
          clauses.push(`${lhs} >= $${params.length}::${cast}`);
        }
        if (raw.gt !== null && raw.gt !== undefined) {
          params.push(raw.gt);
          clauses.push(`${lhs} > $${params.length}::${cast}`);
        }
        if (raw.lte !== null && raw.lte !== undefined) {
          params.push(raw.lte);
          clauses.push(`${lhs} <= $${params.length}::${cast}`);
        }
        if (raw.lt !== null && raw.lt !== undefined) {
          params.push(raw.lt);
          clauses.push(`${lhs} < $${params.length}::${cast}`);
        }
      } else {
        params.push(String(raw));
        clauses.push(`record_data->>'${field}' = $${params.length}`);
      }
    }
    if (!clauses.length) {
      return "";
    }
    return ` AND ${clauses.join(" AND ")}`;
  }

  return {
    async _nextVersion(connectorId: string, streamName: string): Promise<number> {
      const res = await exec(
        `INSERT INTO version_counter (connector_id, stream, max_version)
         VALUES ($1, $2, 1)
         ON CONFLICT (connector_id, stream) DO UPDATE
           SET max_version = version_counter.max_version + 1
         RETURNING max_version`,
        [connectorId, streamName]
      );
      return Number(res.rows[0]?.max_version);
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the test keeps the full observable scenario local for auditability.
    async list(params: ListParams = {}): Promise<ReadPage> {
      const streamName = params.stream || CONFORMANCE_STREAM;
      const connectorId = CONFORMANCE_MANIFEST.connector_id;
      const requiredFields = getRequiredFields(streamName);
      const effectiveFields = intersectFields(params.grantFields, params.fields, requiredFields);

      // ---------- changes_since path ----------
      if (params.changes_since !== null && params.changes_since !== undefined) {
        const sinceVersion = (() => {
          if (params.changes_since === "beginning") {
            return 0;
          }
          const decoded = decodeOpaque(params.changes_since);
          if (decoded && Number.isInteger(decoded.v)) {
            return Number(decoded.v);
          }
          const err = Object.assign(new Error("Malformed changes_since cursor"), { code: "invalid_cursor" });
          throw err;
        })();

        const maxRow = await exec(
          `SELECT max_version FROM version_counter
           WHERE connector_id = $1 AND stream = $2`,
          [connectorId, streamName]
        );
        const sessionMax = maxRow.rows[0] ? Number(maxRow.rows[0].max_version) : 0;

        // Latest change per record_key in (sinceVersion, sessionMax].
        const res = await exec(
          `SELECT DISTINCT ON (record_key)
                  version, record_key, record_data, deleted, emitted_at
           FROM record_changes
           WHERE connector_id = $1 AND stream = $2
             AND version > $3 AND version <= $4
           ORDER BY record_key, version DESC`,
          [connectorId, streamName, sinceVersion, sessionMax]
        );

        // Re-sort by version asc for a deterministic feed.
        const sorted = [...res.rows].sort((a, b) => Number(a.version) - Number(b.version));
        const data: ReadRecord[] = [];
        for (const row of sorted) {
          if (row.deleted) {
            data.push({
              deleted: true,
              emitted_at: String(row.emitted_at),
              id: String(row.record_key),
              object: "record",
              stream: streamName,
            });
            continue;
          }
          data.push({
            data: projectFields(rowData(row.record_data), effectiveFields),
            emitted_at: String(row.emitted_at),
            id: String(row.record_key),
            object: "record",
            stream: streamName,
          });
        }
        return {
          data,
          has_more: false,
          next_changes_since: encodeOpaque({ v: sessionMax }),
          object: "list",
        };
      }

      // ---------- regular cursor pagination path ----------
      const order = params.order === "desc" ? "desc" : "asc";
      const requestedLimit = typeof params.limit === "number" ? params.limit : DEFAULT_LIMIT;
      const limit = Math.min(requestedLimit, MAX_LIMIT);

      let cursorPosition: CursorPosition | null = null;
      if (params.cursor !== null && params.cursor !== undefined) {
        const decoded = decodeOpaque(params.cursor);
        if (decoded?.k !== "pg:page" || decoded.order !== order) {
          const err = Object.assign(new Error("Malformed cursor"), { code: "invalid_cursor" });
          throw err;
        }
        const pkParts = Array.isArray(decoded.primary_key) ? decoded.primary_key : [];
        const pkText = pkParts.map((p) => String(p ?? "")).join("");
        cursorPosition = {
          cursor_value:
            decoded.cursor_value === null || decoded.cursor_value === undefined ? null : String(decoded.cursor_value),
          primary_key_text: pkText,
        };
      }

      const queryParams: PgParam[] = [connectorId, streamName];
      let where = "WHERE connector_id = $1 AND stream = $2 AND deleted = FALSE";
      where += buildFilterClause(streamName, params.filter, queryParams);

      // Cursor seek.
      // Asc:
      //   strictly-after = (cv = cursor_cv AND pk > cursor_pk)
      //                 OR (cv > cursor_cv) (both non-null)
      //                 OR (cv IS NULL AND cursor_cv IS NOT NULL)
      //                 within missing bucket: pk > cursor_pk.
      // Desc mirrors with NULLs first.
      if (cursorPosition) {
        const { cursor_value, primary_key_text } = cursorPosition;
        if (order === "asc") {
          if (cursor_value === null) {
            // Already in missing bucket; only later pk within missing.
            queryParams.push(primary_key_text);
            where += ` AND cursor_value IS NULL AND primary_key > $${queryParams.length}`;
          } else {
            queryParams.push(cursor_value, primary_key_text, cursor_value);
            const cvIdx = queryParams.length - 2;
            const pkIdx = queryParams.length - 1;
            const cv2Idx = queryParams.length;
            where += ` AND (
              (cursor_value = $${cvIdx} AND primary_key > $${pkIdx})
              OR (cursor_value IS NOT NULL AND cursor_value > $${cv2Idx})
              OR (cursor_value IS NULL)
            )`;
          }
        } else if (cursor_value === null) {
          // In missing bucket already (which sorts first in desc); only
          // later pk within missing... but desc means lower pk is "after".
          queryParams.push(primary_key_text);
          where += ` AND cursor_value IS NULL AND primary_key < $${queryParams.length}`;
        } else {
          queryParams.push(cursor_value, primary_key_text, cursor_value);
          const cvIdx = queryParams.length - 2;
          const pkIdx = queryParams.length - 1;
          const cv2Idx = queryParams.length;
          where += ` AND cursor_value IS NOT NULL AND (
              (cursor_value = $${cvIdx} AND primary_key < $${pkIdx})
              OR (cursor_value < $${cv2Idx})
            )`;
        }
      }

      // ORDER BY: missing bucket last in asc, first in desc; within
      // present rows order by cursor_value, pk; within missing order by pk.
      const dir = order === "asc" ? "ASC" : "DESC";
      const nullsPos = order === "asc" ? "NULLS LAST" : "NULLS FIRST";
      const orderBy = `ORDER BY cursor_value ${dir} ${nullsPos}, primary_key ${dir}`;

      // Fetch limit + 1 to compute has_more cheaply.
      queryParams.push(limit + 1);
      const fetchLimitIdx = queryParams.length;

      const sql = `
        SELECT record_key, record_data, emitted_at, cursor_value, primary_key
        FROM records
        ${where}
        ${orderBy}
        LIMIT $${fetchLimitIdx}
      `;

      const res = await exec(sql, queryParams);
      // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
      const rows = res.rows;
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);

      const data: ReadRecord[] = pageRows.map((r) => ({
        data: projectFields(rowData(r.record_data), effectiveFields),
        emitted_at: String(r.emitted_at),
        id: String(r.record_key),
        object: "record",
        stream: streamName,
      }));

      const response: ReadPage = { data, has_more: hasMore, object: "list" };
      if (hasMore && pageRows.length) {
        // biome-ignore lint/style/noNonNullAssertion: the assertion follows an explicit test guard that proves fixture presence.
        const last = pageRows.at(-1)!;
        const pkText = String(last.primary_key);
        const pkParts = pkText.split("");
        response.next_cursor = encodeOpaque({
          cursor_value: last.cursor_value ?? null,
          k: "pg:page",
          order,
          primary_key: pkParts,
        });
      }
      return response;
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the test keeps the full observable scenario local for auditability.
    async seed(records: SeedRecord[], options: SeedOptions = {}) {
      const streamName = options.stream || CONFORMANCE_STREAM;
      const cursorField = getCursorField(streamName);
      const pkFields = getPrimaryKeyFields(streamName);
      const connectorId = CONFORMANCE_MANIFEST.connector_id;

      for (const record of records) {
        const op = record.op || "upsert";
        const emittedAt = record.emitted_at || DEFAULT_EMITTED_AT;

        // Bump the per-(connector, stream) version counter; the
        // RETURNING clause hands us the next version to use.
        // Note: we increment per accepted change, so we look up the
        // current row first, decide whether the change is a no-op, and
        // only then bump the counter.
        // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
        const cur = await exec(
          `SELECT record_data, deleted FROM records
           WHERE connector_id = $1 AND stream = $2 AND record_key = $3`,
          [connectorId, streamName, record.key]
        );
        // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
        const curRow = cur.rows[0];

        if (op === "delete") {
          if (!curRow || curRow.deleted) {
            continue;
          }
          const nextV = await this._nextVersion(connectorId, streamName);
          await exec(
            `UPDATE records SET deleted = TRUE, version = $4, emitted_at = $5
             WHERE connector_id = $1 AND stream = $2 AND record_key = $3`,
            [connectorId, streamName, record.key, nextV, emittedAt]
          );
          await exec(
            `INSERT INTO record_changes
               (version, connector_id, stream, record_key, record_data, deleted, emitted_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, $6)`,
            [nextV, connectorId, streamName, record.key, JSON.stringify(curRow.record_data), emittedAt]
          );
          continue;
        }

        const nextJson = JSON.stringify(record.data);
        if (curRow && !curRow.deleted && JSON.stringify(curRow.record_data) === nextJson) {
          // No-op re-ingest.
          continue;
        }

        const nextV = await this._nextVersion(connectorId, streamName);
        const cursorValue: string | null =
          // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
          cursorField && record.data?.[cursorField] !== null && record.data?.[cursorField] !== undefined
            ? String(record.data[cursorField])
            : null;
        const pkParts = pkFields.length
          ? // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
            pkFields.map((f) => (record.data?.[f] === undefined ? record.key : record.data[f]))
          : [record.key];
        const pkText = pkParts.map((p) => String(p ?? "")).join("");

        await exec(
          `INSERT INTO records
             (connector_id, stream, record_key, record_data, emitted_at, version, deleted, cursor_value, primary_key)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, FALSE, $7, $8)
           ON CONFLICT (connector_id, stream, record_key) DO UPDATE
             SET record_data = EXCLUDED.record_data,
                 emitted_at = EXCLUDED.emitted_at,
                 version = EXCLUDED.version,
                 deleted = FALSE,
                 cursor_value = EXCLUDED.cursor_value,
                 primary_key = EXCLUDED.primary_key`,
          [connectorId, streamName, record.key, nextJson, emittedAt, nextV, cursorValue, pkText]
        );
        await exec(
          `INSERT INTO record_changes
             (version, connector_id, stream, record_key, record_data, deleted, emitted_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, FALSE, $6)`,
          [nextV, connectorId, streamName, record.key, nextJson, emittedAt]
        );
      }
    },
    async setup() {
      client = new Client({ connectionString });
      await client.connect();
      await exec(`CREATE SCHEMA ${q(schema)}`);
      await exec(`SET search_path TO ${q(schema)}`);

      // Live records: one row per (connector_id, stream, record_key).
      // `record_data` is JSONB; `cursor_value` is materialized as TEXT for
      // a uniform compare across types — the harness manifest's only
      // cursor fields are date-time ISO strings, which sort
      // lexicographically the same way `timestamptz` would, so a TEXT
      // column keeps the SQL simple without weakening the scenarios.
      await exec(`
        CREATE TABLE records (
          connector_id TEXT NOT NULL,
          stream TEXT NOT NULL,
          record_key TEXT NOT NULL,
          record_data JSONB NOT NULL,
          emitted_at TEXT NOT NULL,
          version BIGINT NOT NULL,
          deleted BOOLEAN NOT NULL DEFAULT FALSE,
          cursor_value TEXT,
          primary_key TEXT NOT NULL,
          PRIMARY KEY (connector_id, stream, record_key)
        )
      `);

      // Append-only change feed used by `changes_since`. One row per
      // version step; the latest row per record_key inside the
      // (since, sessionMax] window is what gets surfaced.
      await exec(`
        CREATE TABLE record_changes (
          version BIGINT PRIMARY KEY,
          connector_id TEXT NOT NULL,
          stream TEXT NOT NULL,
          record_key TEXT NOT NULL,
          record_data JSONB,
          deleted BOOLEAN NOT NULL,
          emitted_at TEXT NOT NULL
        )
      `);

      await exec(`
        CREATE TABLE version_counter (
          connector_id TEXT NOT NULL,
          stream TEXT NOT NULL,
          max_version BIGINT NOT NULL,
          PRIMARY KEY (connector_id, stream)
        )
      `);
    },

    async teardown() {
      if (!client) {
        return;
      }
      try {
        await exec(`DROP SCHEMA ${q(schema)} CASCADE`);
      } finally {
        await client.end();
        client = null;
      }
    },
  };
}
