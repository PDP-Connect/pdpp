/**
 * Sandbox fixture dependencies for canonical reference operations.
 *
 * The sandbox HTTP routes under `/sandbox/v1/**` are hosts for the same
 * canonical operations the native reference server runs (see
 * `reference-implementation/operations/**`). This module wires those
 * operations to the deterministic demo dataset in `./dataset.ts`.
 *
 * Boundary rules:
 * - Imports here MUST stay framework-free (no Next, no Fastify, no SQLite).
 * - This module exposes only operation-shaped capability helpers; sandbox
 *   route handlers compose them into request adapters.
 * - This module replaces website-local AS/RS response builders for live
 *   operations (e.g. the deleted `buildLiveStreamsList`).
 */

import type { RefDatasetSummaryDependencies } from "pdpp-reference-implementation/operations/ref-dataset-summary";
import type {
  RecordDetailDependencies,
  RecordDetailGrant,
  RecordDetailManifest,
  RecordDetailSourceDescriptor,
} from "pdpp-reference-implementation/operations/rs-records-detail";
import type {
  RecordsListDependencies,
  RecordsListGrant,
  RecordsListManifest,
  RecordsListQueryResult,
  RecordsListSourceDescriptor,
} from "pdpp-reference-implementation/operations/rs-records-list";
import type {
  ConnectorSchemaItem,
  SchemaGetDependencies,
  SchemaGetSourceDescriptor,
} from "pdpp-reference-implementation/operations/rs-schema-get";
import type {
  SearchLexicalAdvertisement,
  SearchLexicalDependencies,
  SearchLexicalGrant,
  SearchLexicalManifest,
  SearchLexicalPlanEntry,
  SearchLexicalSnapshot,
  SearchLexicalSnapshotResult,
} from "pdpp-reference-implementation/operations/rs-search-lexical";
import { SearchLexicalRequestError } from "pdpp-reference-implementation/operations/rs-search-lexical";
import type {
  StreamDetailDependencies,
  StreamDetailSourceDescriptor,
  StreamMetadataEnvelope,
} from "pdpp-reference-implementation/operations/rs-streams-detail";
import type {
  StreamSummary,
  StreamsListDependencies,
  StreamsListSourceDescriptor,
} from "pdpp-reference-implementation/operations/rs-streams-list";
import { buildLiveStreamMetadata } from "./builders.ts";
import { DEMO_CONNECTORS, DEMO_RECORDS, DEMO_STREAMS } from "./dataset.ts";
import type { DemoRecord } from "./types.ts";

function streamRecordCount(streamKey: string): number {
  return DEMO_RECORDS.filter((record) => record.stream === streamKey).length;
}

function latestRecordTimeForStream(streamKey: string): string | null {
  const matching = DEMO_RECORDS.filter((r) => r.stream === streamKey).map((r) => r.record_time);
  if (matching.length === 0) {
    return null;
  }
  return matching.sort().at(-1) ?? null;
}

export interface SandboxStreamsListFixtureOptions {
  /** When provided, only streams from this fixture connector are listed. */
  connectorId?: string;
}

/**
 * Build dependencies for `rs.streams.list` against the sandbox demo dataset.
 *
 * The default scope returns every demo stream across every demo connector,
 * matching the previous `buildLiveStreamsList` behavior. A `connector_id`
 * filter narrows the listing to one connector, again preserving the prior
 * sandbox query-param semantics.
 */
export function createSandboxStreamsListDependencies(
  options: SandboxStreamsListFixtureOptions = {}
): StreamsListDependencies {
  const filtered = options.connectorId
    ? DEMO_STREAMS.filter((s) => s.connector_id === options.connectorId)
    : DEMO_STREAMS;
  const summaries: StreamSummary[] = filtered.map((stream) => {
    const lastUpdated = latestRecordTimeForStream(stream.key) ?? stream.latest_record_time;
    return {
      object: "stream",
      name: stream.key,
      record_count: streamRecordCount(stream.key),
      last_updated: lastUpdated,
    };
  });
  const sourceDescriptor: StreamsListSourceDescriptor = options.connectorId
    ? { binding_kind: "connector", connector_id: options.connectorId }
    : { binding_kind: "connector" };

  return {
    listSummaries: () => Promise.resolve(summaries),
    getSourceDescriptor: () => sourceDescriptor,
  };
}

/**
 * Build dependencies for `rs.streams.detail` against the sandbox demo dataset.
 *
 * The sandbox runs every demo as an owner-shaped read against the demo
 * dataset; there are no client/grant projections to apply, so
 * `isStreamInGrant` is unreachable from sandbox routes (owner actor) and
 * `hasManifestStream` simply mirrors the demo stream catalog. The metadata
 * envelope is assembled by the same `buildLiveStreamMetadata` helper used by
 * `/sandbox/v1/schema`, which keeps the sandbox stream-detail and
 * stream-listed-in-schema shapes in sync.
 */
export function createSandboxStreamDetailDependencies(): StreamDetailDependencies {
  const streamByKey = new Map(DEMO_STREAMS.map((stream) => [stream.key, stream]));
  const sourceDescriptor: StreamDetailSourceDescriptor = { binding_kind: "connector" };

  return {
    getSourceDescriptor: () => sourceDescriptor,
    hasManifestStream: (name: string) => Promise.resolve(streamByKey.has(name)),
    // Sandbox routes always run as owner; this dependency is unreachable from
    // the sandbox host but the operation requires it on the type. Returning
    // `true` matches owner-equivalent visibility so any future client-actor
    // mounting of this fixture profile would behave like the demo schema.
    isStreamInGrant: () => true,
    buildStreamMetadata: (name: string) => {
      const stream = streamByKey.get(name);
      if (!stream) {
        // The operation only calls this after `hasManifestStream` returns
        // true, so an unknown name here is a fixture bug.
        throw new Error(`Sandbox fixture: unknown stream '${name}'`);
      }
      const metadata: StreamMetadataEnvelope = {
        ...buildLiveStreamMetadata(stream),
        object: "stream_metadata",
        name: stream.key,
      };
      return Promise.resolve(metadata);
    },
  };
}

/**
 * Build dependencies for `rs.schema.get` against the sandbox demo dataset.
 *
 * The sandbox runs every demo as an owner-shaped read; the connector items
 * are assembled from the demo connector list, with each connector's streams
 * built through the same `buildLiveStreamMetadata` helper used by the
 * stream-detail fixture and (previously) by the deleted public schema
 * builder. Keeping one envelope helper means the schema and stream-detail
 * shapes cannot drift.
 *
 * The aggregate source descriptor is `{binding_kind: 'connector'}` (no
 * `connector_id`) — schema discovery spans every demo connector, so no
 * single connector_id applies to the disclosure event. Per-connector items
 * carry their own `source.connector_id`.
 */
export function createSandboxSchemaGetDependencies(): SchemaGetDependencies {
  const sourceDescriptor: SchemaGetSourceDescriptor = { binding_kind: "connector" };
  const connectors: ConnectorSchemaItem[] = DEMO_CONNECTORS.map((connector) => {
    const streams = DEMO_STREAMS.filter((s) => s.connector_id === connector.connector_id);
    return {
      object: "connector",
      source: { binding_kind: "connector", connector_id: connector.connector_id },
      connector_id: connector.connector_id,
      stream_count: streams.length,
      streams: streams.map((stream) => ({
        ...buildLiveStreamMetadata(stream),
        object: "stream_metadata",
        name: stream.key,
      })),
    };
  });

  return {
    getSourceDescriptor: () => sourceDescriptor,
    listConnectorItems: () => Promise.resolve(connectors),
  };
}

// ─── rs.records.list / rs.records.get ─────────────────────────────────────
//
// Sandbox record-read fixtures. The sandbox runs every demo as an owner-
// shaped read; there is no client/grant projection to apply, so the
// operation's owner branch handles manifest visibility / not_found mapping.
// The fixture `queryRecords` and `getRecord` capabilities apply the legacy
// `buildLiveRecordsList` / `buildLiveRecordDetail` semantics:
//   - filter by stream and optional `connector_id`;
//   - sort newest first by `record_time`;
//   - paginate by integer offset (cursor is an integer string);
//   - return live record envelopes
//     `{object:'record', id, stream, data, emitted_at}`.
// Manifest/grant fixtures are minimal because the operation only reads
// `streams[].name` (manifest) and `streams[].name`/`streams[].fields`
// (grant); no field projection or view resolution is exercised by the
// sandbox routes today.

const SANDBOX_DEFAULT_PAGE_LIMIT = 25;
const SANDBOX_MAX_PAGE_LIMIT = 100;

function clampSandboxLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return SANDBOX_DEFAULT_PAGE_LIMIT;
  }
  return Math.min(Math.floor(limit), SANDBOX_MAX_PAGE_LIMIT);
}

function decodeSandboxCursor(cursor: unknown): number {
  if (typeof cursor !== "string" || !cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function encodeSandboxCursor(offset: number): string {
  return String(offset);
}

function compareRecordTimeDesc(a: DemoRecord, b: DemoRecord): number {
  if (a.record_time < b.record_time) {
    return 1;
  }
  if (a.record_time > b.record_time) {
    return -1;
  }
  return 0;
}

interface SandboxLiveRecord {
  data: Readonly<Record<string, unknown>>;
  emitted_at: string;
  id: string;
  object: "record";
  stream: string;
}

function recordToLiveRecord(record: DemoRecord): SandboxLiveRecord {
  return {
    object: "record",
    id: record.record_id,
    stream: record.stream,
    data: { ...record.fields },
    emitted_at: record.ingested_at,
  };
}

function sandboxManifest(): RecordsListManifest {
  return {
    streams: DEMO_STREAMS.map((stream) => ({ name: stream.key })),
  };
}

function sandboxOwnerGrantPlaceholder(): RecordsListGrant {
  // The operation's owner branch overwrites this with an owner read-grant
  // before any capability call; we just need a defined shape here.
  return { streams: [] };
}

export interface SandboxRecordsListFixtureOptions {
  /** When provided, only records whose `connector_id` matches are listed. */
  connectorId?: string;
}

/**
 * Build dependencies for `rs.records.list` against the sandbox demo dataset.
 *
 * The default scope returns every demo record for the requested stream. A
 * `connector_id` filter narrows the listing to one connector, preserving
 * the prior `buildLiveRecordsList` query-param semantics.
 */
export function createSandboxRecordsListDependencies(
  options: SandboxRecordsListFixtureOptions = {}
): RecordsListDependencies {
  const sourceDescriptor: RecordsListSourceDescriptor = options.connectorId
    ? { binding_kind: "connector", connector_id: options.connectorId }
    : { binding_kind: "connector" };

  return {
    getSourceDescriptor: () => sourceDescriptor,
    getManifest: () => sandboxManifest(),
    getGrant: () => sandboxOwnerGrantPlaceholder(),
    queryRecords: (stream, _grant, params) => {
      const matching = DEMO_RECORDS.filter((record) => {
        if (record.stream !== stream) {
          return false;
        }
        if (options.connectorId && record.connector_id !== options.connectorId) {
          return false;
        }
        return true;
      });
      const sorted = [...matching].sort(compareRecordTimeDesc);
      const limit = clampSandboxLimit(params.limit);
      const start = decodeSandboxCursor(params.cursor);
      const slice = sorted.slice(start, start + limit);
      const next = start + limit;
      const hasMore = next < sorted.length;
      const result: RecordsListQueryResult = {
        object: "list",
        has_more: hasMore,
        data: slice.map((record) => recordToLiveRecord(record) as unknown as Record<string, unknown>),
      };
      if (hasMore) {
        result.next_cursor = encodeSandboxCursor(next);
      }
      return Promise.resolve(result);
    },
    decorateRecord: (record) => record,
    // Sandbox demo records have no field/filter validation yet; the route
    // never previously enforced manifest field/filter shape, so this is a
    // no-op fixture validator.
    validateRequestFields: () => undefined,
  };
}

/**
 * Build dependencies for `rs.records.get` against the sandbox demo dataset.
 */
export function createSandboxRecordDetailDependencies(): RecordDetailDependencies {
  const sourceDescriptor: RecordDetailSourceDescriptor = { binding_kind: "connector" };
  return {
    getSourceDescriptor: () => sourceDescriptor,
    getManifest: (): RecordDetailManifest => ({
      streams: DEMO_STREAMS.map((stream) => ({ name: stream.key })),
    }),
    // Sandbox is owner-shaped; the operation's owner branch overwrites this
    // with an owner read-grant before any capability call.
    getGrant: (): RecordDetailGrant => ({ streams: [] }),
    getRecord: (stream, recordId) => {
      const record = DEMO_RECORDS.find((r) => r.stream === stream && r.record_id === recordId);
      if (!record) {
        return Promise.resolve(null);
      }
      return Promise.resolve(recordToLiveRecord(record) as unknown as Record<string, unknown>);
    },
    decorateRecord: (record) => record,
  };
}

// ─── rs.search.lexical ────────────────────────────────────────────────────
//
// Sandbox lexical-search fixture. The sandbox runs every demo as an owner-
// shaped read against the demo dataset; the canonical operation owns the
// public-contract slice (allowlist, advertisement gates, mode planning,
// cursor format, slice math, envelope, disclosure data) and only the
// adapter-bound concerns (plan compilation, snippet matching, snapshot
// storage, advertisement source, record-url formatting) are wired here.
//
// Matching strategy:
//   - case-insensitive substring scan over every string field of every
//     `DemoRecord`;
//   - lower-is-better score `1 / (1 + matchedFields.length + occurrences)`
//     (sandbox demo only — real bm25 is implementation-relative anyway);
//   - per-record snippet drawn from the field with the most occurrences,
//     with ellipsis padding;
//   - `streams[]` filter is applied at the plan stage so the operation's
//     soft owner-mode filter remains the only enforcement path.
//
// Request `filter[...]` evaluation:
//   - `buildSearchPlanForGrant` compiles the request `filter` payload
//     against the demo stream's declared fields and rejects unsupported
//     shapes with the canonical `invalid_request` error so the sandbox
//     API does not lie about filter semantics.
//   - Exact filter `filter[field]=value` is supported for top-level scalar
//     demo fields (string, number, currency_minor_units, boolean,
//     timestamp). Comparison is `String(record[field]) === String(value)`
//     to mirror native `compileRequestFilters` exact-match semantics.
//   - Range filter `filter[field][op]=value` (gte/gt/lte/lt) is rejected
//     with `invalid_request` because the sandbox demo manifest advertises
//     `query.range_filters: {}` for every stream — there is no range
//     support to honor. Updating that advertisement requires updating the
//     mock metadata and every affected mock route consistently, which is
//     out of scope for this slice.
//   - Unknown fields reject with `invalid_request`.
//   - Compiled filters travel on the plan entry so `buildSnapshot` can
//     apply them before substring matching.

const SANDBOX_SEARCH_SNIPPET_PADDING = 24;
const SANDBOX_SEARCH_DEFAULT_LIMIT = 25;
const SANDBOX_SEARCH_MAX_LIMIT = 100;

const SANDBOX_LEXICAL_ADVERTISEMENT: SearchLexicalAdvertisement = {
  supported: true,
  cross_stream: true,
  snippets: true,
  default_limit: SANDBOX_SEARCH_DEFAULT_LIMIT,
  max_limit: SANDBOX_SEARCH_MAX_LIMIT,
  score: {
    supported: true,
    kind: "bm25",
    order: "lower_is_better",
    value_semantics: "implementation_relative",
  },
};

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetAroundMatch(haystack: string, needle: string): string {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) {
    return haystack.slice(0, SANDBOX_SEARCH_SNIPPET_PADDING * 2);
  }
  const start = Math.max(0, idx - SANDBOX_SEARCH_SNIPPET_PADDING);
  const end = Math.min(haystack.length, idx + needle.length + SANDBOX_SEARCH_SNIPPET_PADDING);
  let snippet = haystack.slice(start, end);
  if (start > 0) {
    snippet = `…${snippet}`;
  }
  if (end < haystack.length) {
    snippet = `${snippet}…`;
  }
  return snippet;
}

interface SandboxRecordHit extends SearchLexicalSnapshotResult {
  emittedAt: string;
}

interface SandboxExactFilter {
  field: string;
  value: string;
}

/**
 * Compiled filter set for one (stream, filter[...]) pair. The fixture only
 * supports exact filters today; range filters are rejected at compile time
 * because the sandbox manifest does not advertise `query.range_filters`.
 */
interface SandboxCompiledFilters {
  exact: SandboxExactFilter[];
  streamName: string;
}

/**
 * Compile the request `filter[...]` payload against one demo stream's
 * declared fields. Throws `SearchLexicalRequestError(invalid_request)` for
 * unknown fields, unsupported range shapes, or non-scalar filter values —
 * the sandbox API obeys the same canonical request contract as native.
 */
function compileSandboxFilterForStream(filter: unknown, streamName: string): SandboxCompiledFilters {
  if (filter == null) {
    return { streamName, exact: [] };
  }
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw new SearchLexicalRequestError(
      "invalid_request",
      "filter must use filter[field]=value or filter[field][op]=value",
      "filter"
    );
  }
  const stream = DEMO_STREAMS.find((s) => s.key === streamName);
  if (!stream) {
    // The operation's plan compilation should not arrive here for streams
    // outside the manifest, but if a future caller does, surface the
    // configuration mistake rather than silently dropping the filter.
    throw new SearchLexicalRequestError("invalid_request", `Unknown stream: ${streamName}`, "streams");
  }
  const fieldByName = new Map(stream.fields.map((f) => [f.name, f]));
  const exact: SandboxExactFilter[] = [];
  for (const [fieldName, rawValue] of Object.entries(filter)) {
    const fieldDef = fieldByName.get(fieldName);
    if (!fieldDef) {
      throw new SearchLexicalRequestError("invalid_request", `Unknown field: ${fieldName}`, "filter");
    }
    if (rawValue !== null && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      // Range / object filters require the manifest to declare
      // `query.range_filters[fieldName]`. The sandbox demo manifest
      // declares no range filters, so this is always rejected.
      throw new SearchLexicalRequestError(
        "invalid_request",
        `Range filters are not declared for '${fieldName}'`,
        "filter"
      );
    }
    if (rawValue !== null && typeof rawValue === "object") {
      throw new SearchLexicalRequestError(
        "invalid_request",
        `Exact filter on '${fieldName}' must use a scalar value`,
        "filter"
      );
    }
    exact.push({ field: fieldName, value: String(rawValue) });
  }
  return { streamName, exact };
}

/**
 * Evaluate compiled exact filters against a record's data. Returns true
 * when every filter matches (or when there are no filters). Comparison is
 * `String(record[field]) === filter.value`, mirroring native
 * `passesRequestFilters` exact-match semantics.
 */
function recordPassesSandboxFilters(record: DemoRecord, filters: SandboxCompiledFilters | null): boolean {
  if (!filters || filters.exact.length === 0) {
    return true;
  }
  for (const f of filters.exact) {
    const raw = record.fields[f.field];
    if (String(raw) !== f.value) {
      return false;
    }
  }
  return true;
}

function matchSandboxRecord(record: DemoRecord, trimmed: string, lower: string): SandboxRecordHit | null {
  const matchedFields: string[] = [];
  let bestField: string | null = null;
  let bestOccurrences = 0;
  let bestSnippet: string | null = null;
  for (const [field, raw] of Object.entries(record.fields)) {
    const value = typeof raw === "string" ? raw : JSON.stringify(raw);
    const lowerValue = value.toLowerCase();
    if (!lowerValue.includes(lower)) {
      continue;
    }
    matchedFields.push(field);
    const occurrences = (lowerValue.match(new RegExp(escapeRegexLiteral(lower), "g")) ?? []).length;
    if (bestField === null || occurrences > bestOccurrences) {
      bestField = field;
      bestOccurrences = occurrences;
      bestSnippet = snippetAroundMatch(value, trimmed);
    }
  }
  if (bestField === null || bestSnippet === null) {
    return null;
  }
  const score = 1 / (1 + matchedFields.length + bestOccurrences);
  return {
    connectorId: record.connector_id,
    stream: record.stream,
    recordKey: record.record_id,
    emittedAt: record.ingested_at,
    matchedFields,
    snippet: { field: bestField, text: bestSnippet },
    score,
  };
}

function generateSandboxSnapshotId(): string {
  // `crypto.randomUUID` is available in modern runtimes (Node 19+, Edge,
  // browser); the sandbox runs on Next which guarantees it.
  return `snap_sb_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Build dependencies for `rs.search.lexical` against the sandbox demo
 * dataset.
 *
 * Snapshot persistence uses an in-memory `Map`. The sandbox is request-
 * scoped (a fresh module instance per Next request handler in the dev
 * server) but Next route modules are also long-lived in production: that
 * means cursor-based pagination across requests works inside the lifetime
 * of one server process, with no TTL eviction. For the demo dataset this
 * is bounded (sandbox records are < 100), so cache growth is negligible.
 */
export function createSandboxSearchLexicalDependencies(): SearchLexicalDependencies {
  const snapshotCache = new Map<string, SearchLexicalSnapshot>();
  return {
    getAdvertisement: () => SANDBOX_LEXICAL_ADVERTISEMENT,
    listOwnerVisibleConnectorIds: () => DEMO_CONNECTORS.map((c) => c.connector_id),
    resolveOwnerManifestForConnector: (connectorId: string): SearchLexicalManifest | null => {
      const streams = DEMO_STREAMS.filter((s) => s.connector_id === connectorId).map((s) => ({ name: s.key }));
      if (streams.length === 0) {
        return null;
      }
      return { connector_id: connectorId, streams };
    },
    buildOwnerReadGrantForManifest: (manifest: SearchLexicalManifest): SearchLexicalGrant => ({
      streams: (manifest.streams ?? []).map((s) => ({ name: s.name })),
    }),
    // Sandbox routes do not currently mount client-actor flows; the
    // operation's owner branch is the only consumer. This stub is here so
    // the dependency type is satisfied and future client-actor wiring stays
    // mechanical.
    resolveClientManifest: ({ grant }) => ({
      streams: (grant.streams ?? []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({ manifest, grant, streamsFilter, filter, filteredStream, connectorId }) => {
      const grantedStreams = new Set((grant.streams ?? []).map((s) => s.name));
      // Compile the request filter once. The operation guarantees that
      // when `filter` is present `filteredStream` names exactly one
      // `streams[]` value. The filter only applies to connectors whose
      // manifest carries that stream — `compileSandboxFilterForStream`
      // validates the filter against the demo stream's declared fields,
      // so unknown fields and unsupported range shapes raise
      // `invalid_request` here. Compiled filters are attached only to
      // the plan entry for the matched stream.
      const manifestStreamNames = new Set((manifest.streams ?? []).map((s) => s.name));
      const compiledFilter =
        filter != null && filteredStream != null && manifestStreamNames.has(filteredStream)
          ? compileSandboxFilterForStream(filter, filteredStream)
          : null;
      const plan: SearchLexicalPlanEntry[] = [];
      for (const stream of manifest.streams ?? []) {
        if (!grantedStreams.has(stream.name)) {
          continue;
        }
        if (streamsFilter && !streamsFilter.includes(stream.name)) {
          continue;
        }
        plan.push({
          streamName: stream.name,
          // Sandbox records are scanned through every string field; the
          // declared search-field list is not surfaced in fixtures yet, so
          // the operation receives a sentinel non-empty list to keep the
          // plan-emptiness check meaningful.
          searchableFields: ["__sandbox_any_string_field__"],
          connectorId: connectorId ?? null,
          // The fixture-only `compiledFilter` field rides on the plan
          // entry so `buildSnapshot` can evaluate filters per-stream
          // without re-parsing the request payload.
          compiledFilter: compiledFilter && compiledFilter.streamName === stream.name ? compiledFilter : null,
        });
      }
      return plan;
    },
    buildSnapshot: ({ q, perConnectorPlans }): SearchLexicalSnapshot => {
      const trimmed = q.trim();
      const lower = trimmed.toLowerCase();
      // Map `(connectorId, stream)` → compiled filter so per-record
      // evaluation can look up the filter in O(1) without scanning plans.
      const filtersByConnectorStream = new Map<string, SandboxCompiledFilters | null>();
      for (const plan of perConnectorPlans) {
        for (const entry of plan.planEntries) {
          const key = `${plan.connectorId ?? ""}::${entry.streamName}`;
          filtersByConnectorStream.set(
            key,
            (entry.compiledFilter as SandboxCompiledFilters | null | undefined) ?? null
          );
        }
      }
      const hits: SandboxRecordHit[] = [];
      for (const record of DEMO_RECORDS) {
        const key = `${record.connector_id}::${record.stream}`;
        if (!filtersByConnectorStream.has(key)) {
          continue;
        }
        const compiled = filtersByConnectorStream.get(key) ?? null;
        if (!recordPassesSandboxFilters(record, compiled)) {
          continue;
        }
        const hit = matchSandboxRecord(record, trimmed, lower);
        if (hit) {
          hits.push(hit);
        }
      }
      hits.sort((a, b) => {
        const av = a.score ?? Number.POSITIVE_INFINITY;
        const bv = b.score ?? Number.POSITIVE_INFINITY;
        if (av !== bv) {
          return av - bv;
        }
        return a.recordKey.localeCompare(b.recordKey);
      });
      return {
        snapshot_id: generateSandboxSnapshotId(),
        query: q,
        results: hits,
      };
    },
    persistSnapshot: (snapshot) => {
      snapshotCache.set(snapshot.snapshot_id, snapshot);
    },
    loadSnapshot: (snapshotId) => snapshotCache.get(snapshotId) ?? null,
    formatRecordUrl: ({ stream, recordKey }) =>
      `/sandbox/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordKey)}`,
  };
}

// ─── ref.dataset.summary ──────────────────────────────────────────────────
//
// Sandbox dataset-summary fixture for the operator-console hero band shape.
// The canonical operation owns envelope assembly (`object`,
// `total_retained_bytes`, top-connector sort/limit, empty-corpus collapse);
// only the raw aggregate inputs are wired here.
//
// Arithmetic preserved from the previous `buildLiveDatasetSummary` builder:
//   - counts come from `DEMO_*.length` (the previous sandbox semantics);
//   - record JSON bytes come from
//     `DEMO_RECORDS.reduce((sum, r) => sum + JSON.stringify(r.fields).length, 0)`;
//   - `record_changes_json_bytes` and `blob_bytes` are 0 (the sandbox has
//     no record-changes table or blob storage);
//   - record-time bounds and ingested-time bounds come from sorted record
//     arrays;
//   - top-connector candidates come from a per-connector `record_count`
//     map. The operation owns the sort, tiebreak, and limit so both
//     adapters cannot drift.
//
// The empty-corpus collapse rule (time bounds `null` when `record_count
// === 0`) is enforced by the operation, so the time-bound fixtures here
// don't have to short-circuit themselves — but they happen to return
// `{earliest: null, latest: null}` on an empty dataset anyway, which keeps
// behavior identical even if the operation gate were removed.

function sandboxDatasetCounts() {
  return {
    connector_count: DEMO_CONNECTORS.length,
    stream_count: DEMO_STREAMS.length,
    record_count: DEMO_RECORDS.length,
  };
}

function sandboxDatasetRetainedBytes() {
  const recordJsonBytes = DEMO_RECORDS.reduce((sum, r) => sum + JSON.stringify(r.fields).length, 0);
  return {
    record_json_bytes: recordJsonBytes,
    record_changes_json_bytes: 0,
    blob_bytes: 0,
  };
}

function sandboxDatasetTimeBounds(values: readonly string[]): {
  earliest: string | null;
  latest: string | null;
} {
  if (values.length === 0) {
    return { earliest: null, latest: null };
  }
  const sorted = [...values].sort();
  return { earliest: sorted[0] ?? null, latest: sorted.at(-1) ?? null };
}

function sandboxDatasetTopConnectorCandidates(): Array<{
  connector_id: string;
  record_count: number;
}> {
  const counts = new Map<string, number>();
  for (const record of DEMO_RECORDS) {
    counts.set(record.connector_id, (counts.get(record.connector_id) ?? 0) + 1);
  }
  return [...counts.entries()].map(([connector_id, record_count]) => ({
    connector_id,
    record_count,
  }));
}

/**
 * Build dependencies for `ref.dataset.summary` against the sandbox demo
 * dataset. Mirrors the previous `buildLiveDatasetSummary` arithmetic; the
 * canonical operation owns envelope assembly, top-connector sort/limit,
 * and the empty-corpus collapse.
 */
export function createSandboxRefDatasetSummaryDependencies(): RefDatasetSummaryDependencies {
  return {
    getCounts: () => sandboxDatasetCounts(),
    getRetainedBytes: () => sandboxDatasetRetainedBytes(),
    getRecordTimeBounds: () => sandboxDatasetTimeBounds(DEMO_RECORDS.map((r) => r.record_time)),
    getIngestedTimeBounds: () => sandboxDatasetTimeBounds(DEMO_RECORDS.map((r) => r.ingested_at)),
    listTopConnectorCandidates: () => sandboxDatasetTopConnectorCandidates(),
  };
}
