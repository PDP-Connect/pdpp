/**
 * Pure response builders for the sandbox demo instance.
 *
 * These functions are framework-free: they take dataset rows and a small set
 * of options, and return plain JSON shapes. Both demo route handlers under
 * `apps/web/src/app/sandbox/v1/**` and `_ref/**` and demo dashboard pages
 * call into the same builders so the rendered surface and the HTTP API stay
 * lockstepped.
 *
 * Shape note: the `*Live` family mirrors live reference envelopes so a
 * caller can swap `https://reference/v1/...` for `https://.../sandbox/v1/...`
 * and use the same parsing. Live shapes intentionally omit the demo banner
 * fields (no `is_demo`, no `notice`); a sandbox marker is conveyed via the
 * `x-pdpp-demo` HTTP header. See `v1/_helpers.ts`.
 *
 * The non-`Live` builders pre-date the fidelity pass and now back the
 * sandbox dashboard data-source seam (`./data-source.ts`) and the demo
 * UI pages. They MUST NOT be used for new HTTP routes.
 */

import {
  DEMO_CAPABILITIES,
  DEMO_CLIENTS,
  DEMO_CONNECTORS,
  DEMO_GRANTS,
  DEMO_ISSUER,
  DEMO_RECORDS,
  DEMO_RUNS,
  DEMO_STREAMS,
  DEMO_TRACES,
} from "./dataset.ts";
import type {
  DemoCapabilityDef,
  DemoConnectorDef,
  DemoGrantDef,
  DemoRecord,
  DemoRunDef,
  DemoStreamDef,
  DemoTimelineEvent,
  DemoTraceDef,
} from "./types.ts";

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
const SEARCH_SNIPPET_PADDING = 32;
const SANDBOX_PATH_SUFFIX_RE = /\/sandbox$/;

const DEMO_NOTICE = {
  is_demo: true,
  notice: "Sandbox demo: deterministic fictional data. Not a live PDPP reference instance.",
} as const;

export interface ListEnvelope<T> {
  data: T[];
  has_more: boolean;
  is_demo: true;
  next_cursor: string | null;
  notice: typeof DEMO_NOTICE.notice;
  object: "list";
  total: number;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_PAGE_LIMIT);
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function encodeCursor(offset: number): string {
  return String(offset);
}

export function paginate<T>(rows: readonly T[], opts: { limit?: number; cursor?: string | null }): ListEnvelope<T> {
  const limit = clampLimit(opts.limit);
  const start = decodeCursor(opts.cursor);
  const slice = rows.slice(start, start + limit);
  const next = start + limit;
  const hasMore = next < rows.length;
  return {
    object: "list",
    data: slice as T[],
    has_more: hasMore,
    next_cursor: hasMore ? encodeCursor(next) : null,
    total: rows.length,
    is_demo: true,
    notice: DEMO_NOTICE.notice,
  };
}

// ─── Schema graph + streams (legacy demo-shaped builders) ───────────────────

export interface SchemaResponse {
  connectors: Array<{
    connector_id: string;
    display_name: string;
    streams: Array<{
      stream: string;
      label: string;
      fields: Array<{ name: string; type: string; semantic_class: string }>;
    }>;
  }>;
  is_demo: true;
  issuer: string;
  notice: typeof DEMO_NOTICE.notice;
  object: "schema_graph";
}

export function buildSchemaResponse(issuer = DEMO_ISSUER): SchemaResponse {
  return {
    object: "schema_graph",
    is_demo: true,
    notice: DEMO_NOTICE.notice,
    issuer,
    connectors: DEMO_CONNECTORS.map((connector) => ({
      connector_id: connector.connector_id,
      display_name: connector.display_name,
      streams: DEMO_STREAMS.filter((stream) => stream.connector_id === connector.connector_id).map((stream) => ({
        stream: stream.key,
        label: stream.label,
        fields: stream.fields.map((field) => ({
          name: field.name,
          type: field.type,
          semantic_class: field.semantic_class,
        })),
      })),
    })),
  };
}

export interface StreamSummary {
  connector_id: string;
  description: string;
  field_count: number;
  label: string;
  latest_record_time: string;
  object: "stream_summary";
  record_count: number;
  retention_label: string;
  stream: string;
}

function streamRecordCount(streamKey: string): number {
  return DEMO_RECORDS.filter((record) => record.stream === streamKey).length;
}

export function buildStreamsList(opts: {
  connector_id?: string;
  cursor?: string | null;
  limit?: number;
}): ListEnvelope<StreamSummary> {
  const filtered = opts.connector_id
    ? DEMO_STREAMS.filter((stream) => stream.connector_id === opts.connector_id)
    : DEMO_STREAMS;
  const summaries = filtered.map<StreamSummary>((stream) => ({
    object: "stream_summary",
    connector_id: stream.connector_id,
    description: stream.description,
    field_count: stream.fields.length,
    label: stream.label,
    latest_record_time: stream.latest_record_time,
    record_count: streamRecordCount(stream.key),
    retention_label: stream.retention_label,
    stream: stream.key,
  }));
  return paginate(summaries, opts);
}

export interface StreamDetail {
  connector_id: string;
  description: string;
  fields: Array<{ name: string; type: string; semantic_class: string; description: string }>;
  is_demo: true;
  label: string;
  latest_record_time: string;
  notice: typeof DEMO_NOTICE.notice;
  object: "stream";
  record_count: number;
  retention_label: string;
  stream: string;
}

export function buildStreamDetail(streamKey: string): StreamDetail | null {
  const stream = DEMO_STREAMS.find((s) => s.key === streamKey);
  if (!stream) {
    return null;
  }
  return {
    object: "stream",
    is_demo: true,
    notice: DEMO_NOTICE.notice,
    connector_id: stream.connector_id,
    description: stream.description,
    fields: stream.fields.map((field) => ({
      name: field.name,
      type: field.type,
      semantic_class: field.semantic_class,
      description: field.description,
    })),
    label: stream.label,
    latest_record_time: stream.latest_record_time,
    record_count: streamRecordCount(stream.key),
    retention_label: stream.retention_label,
    stream: stream.key,
  };
}

// ─── Records (legacy demo-shaped) ──────────────────────────────────────────

export interface RecordSummary {
  connector_id: string;
  ingested_at: string;
  object: "record";
  preview: string;
  record_id: string;
  record_time: string;
  stream: string;
}

function recordPreview(record: DemoRecord): string {
  const entries = Object.entries(record.fields).slice(0, 3);
  return entries
    .map(([k, v]) => {
      let s: string;
      if (typeof v === "string") {
        s = v;
      } else {
        s = JSON.stringify(v);
      }
      return `${k}=${s}`;
    })
    .join(" · ");
}

export function buildRecordsList(opts: {
  connector_id?: string;
  cursor?: string | null;
  limit?: number;
  stream: string;
}): ListEnvelope<RecordSummary> | null {
  if (!DEMO_STREAMS.some((s) => s.key === opts.stream)) {
    return null;
  }
  const matching = DEMO_RECORDS.filter((record) => {
    if (record.stream !== opts.stream) {
      return false;
    }
    if (opts.connector_id && record.connector_id !== opts.connector_id) {
      return false;
    }
    return true;
  });
  const sorted = sortRecordsNewestFirst(matching);
  const summaries = sorted.map<RecordSummary>((record) => ({
    object: "record",
    connector_id: record.connector_id,
    ingested_at: record.ingested_at,
    preview: recordPreview(record),
    record_id: record.record_id,
    record_time: record.record_time,
    stream: record.stream,
  }));
  return paginate(summaries, opts);
}

export interface RecordDetail {
  connector_id: string;
  fields: Readonly<Record<string, unknown>>;
  ingested_at: string;
  is_demo: true;
  notice: typeof DEMO_NOTICE.notice;
  object: "record_detail";
  record_id: string;
  record_time: string;
  stream: string;
}

export function buildRecordDetail(streamKey: string, recordId: string): RecordDetail | null {
  const record = DEMO_RECORDS.find((r) => r.stream === streamKey && r.record_id === recordId);
  if (!record) {
    return null;
  }
  return {
    object: "record_detail",
    is_demo: true,
    notice: DEMO_NOTICE.notice,
    connector_id: record.connector_id,
    fields: record.fields,
    ingested_at: record.ingested_at,
    record_id: record.record_id,
    record_time: record.record_time,
    stream: record.stream,
  };
}

// ─── Search (legacy demo-shaped) ───────────────────────────────────────────

export interface SearchHit {
  connector_id: string;
  emitted_at: string;
  matched_fields: string[];
  object: "search_result";
  record_key: string;
  record_time: string;
  record_url: string;
  score: {
    kind: "sandbox_lexical_rank";
    order: "higher_is_better";
    value: number;
    value_semantics: "demo_only";
  };
  snippet: { field: string; text: string };
  stream: string;
}

function snippetAround(haystack: string, needle: string): string {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) {
    return haystack.slice(0, SEARCH_SNIPPET_PADDING * 2);
  }
  const start = Math.max(0, idx - SEARCH_SNIPPET_PADDING);
  const end = Math.min(haystack.length, idx + needle.length + SEARCH_SNIPPET_PADDING);
  let snippet = haystack.slice(start, end);
  if (start > 0) {
    snippet = `…${snippet}`;
  }
  if (end < haystack.length) {
    snippet = `${snippet}…`;
  }
  return snippet;
}

export interface SearchResponse {
  data: SearchHit[];
  has_more: false;
  is_demo: true;
  next_cursor: null;
  notice: typeof DEMO_NOTICE.notice;
  object: "list";
  query: string;
  total: number;
  url: "/sandbox/v1/search";
}

export function buildSearchResponse(query: string): SearchResponse {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      object: "list",
      is_demo: true,
      notice: DEMO_NOTICE.notice,
      url: "/sandbox/v1/search",
      query: "",
      total: 0,
      has_more: false,
      next_cursor: null,
      data: [],
    };
  }
  const lower = trimmed.toLowerCase();
  const hits: SearchHit[] = [];
  for (const record of DEMO_RECORDS) {
    const hit = buildSearchHit(record, { lower, trimmed });
    if (hit) {
      hits.push(hit);
    }
  }
  hits.sort((a, b) => {
    if (b.score.value !== a.score.value) {
      return b.score.value - a.score.value;
    }
    if (a.record_time < b.record_time) {
      return 1;
    }
    if (a.record_time > b.record_time) {
      return -1;
    }
    return 0;
  });
  return {
    object: "list",
    is_demo: true,
    notice: DEMO_NOTICE.notice,
    url: "/sandbox/v1/search",
    query: trimmed,
    total: hits.length,
    has_more: false,
    next_cursor: null,
    data: hits,
  };
}

function buildSearchHit(record: DemoRecord, query: { lower: string; trimmed: string }): SearchHit | null {
  const matchedFields: string[] = [];
  let bestMatch: { field: string; score: number; snippet: string } | null = null;
  for (const [field, raw] of Object.entries(record.fields)) {
    const value = typeof raw === "string" ? raw : JSON.stringify(raw);
    const lowerValue = value.toLowerCase();
    if (!lowerValue.includes(query.lower)) {
      continue;
    }
    matchedFields.push(field);
    const score = (lowerValue.match(new RegExp(escapeRegex(query.lower), "g")) ?? []).length;
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { field, score, snippet: snippetAround(value, query.trimmed) };
    }
  }
  if (!bestMatch) {
    return null;
  }
  return {
    object: "search_result",
    connector_id: record.connector_id,
    emitted_at: record.ingested_at,
    matched_fields: matchedFields,
    record_key: record.record_id,
    record_time: record.record_time,
    record_url: `/sandbox/v1/streams/${encodeURIComponent(record.stream)}/records/${encodeURIComponent(record.record_id)}`,
    score: {
      kind: "sandbox_lexical_rank",
      value: matchedFields.length + bestMatch.score,
      order: "higher_is_better",
      value_semantics: "demo_only",
    },
    snippet: { field: bestMatch.field, text: bestMatch.snippet },
    stream: record.stream,
  };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Grants / runs / traces summaries + timelines (legacy demo-shaped) ─────

export interface GrantSummary {
  client_id: string | null;
  connector_id: string | null;
  event_count: number;
  failure_reason: string | null;
  first_at: string;
  grant_id: string;
  last_at: string;
  object: "grant_summary";
  status: string;
  stream: string;
  trace_id: string;
}

function grantToSummary(grant: DemoGrantDef): GrantSummary {
  let failure: string | null = null;
  if (grant.status === "denied") {
    failure = "owner_declined";
  } else if (grant.status === "revoked") {
    failure = "grant_revoked";
  }
  return {
    object: "grant_summary",
    grant_id: grant.grant_id,
    client_id: grant.client_id,
    connector_id: grant.connector_id,
    stream: grant.stream,
    status: grant.status,
    failure_reason: failure,
    first_at: grant.first_at,
    last_at: grant.last_at,
    event_count: grant.events.length,
    trace_id: grant.trace_id,
  };
}

export function buildGrantsList(opts: {
  client_id?: string;
  cursor?: string | null;
  limit?: number;
  status?: string;
}): ListEnvelope<GrantSummary> {
  const filtered = DEMO_GRANTS.filter((grant) => {
    if (opts.status && grant.status !== opts.status) {
      return false;
    }
    if (opts.client_id && grant.client_id !== opts.client_id) {
      return false;
    }
    return true;
  });
  return paginate(filtered.map(grantToSummary), opts);
}

export interface TimelineEnvelope {
  event_count: number;
  events: DemoTimelineEvent[];
  is_demo: true;
  notice: typeof DEMO_NOTICE.notice;
  object: "timeline";
  subject_id: string;
  subject_type: "grant" | "run" | "trace";
  trace_id: string | null;
}

export function buildGrantTimeline(grantId: string): TimelineEnvelope | null {
  const grant = DEMO_GRANTS.find((g) => g.grant_id === grantId);
  if (!grant) {
    return null;
  }
  return {
    object: "timeline",
    is_demo: true,
    notice: DEMO_NOTICE.notice,
    subject_type: "grant",
    subject_id: grant.grant_id,
    trace_id: grant.trace_id,
    event_count: grant.events.length,
    events: [...grant.events],
  };
}

export interface RunSummary {
  connector_id: string;
  event_count: number;
  failure_reason: string | null;
  finished_at: string | null;
  first_at: string;
  grant_id: string | null;
  last_at: string;
  needs_input: boolean;
  object: "run_summary";
  run_id: string;
  started_at: string;
  status: string;
}

function runToSummary(run: DemoRunDef): RunSummary {
  return {
    object: "run_summary",
    run_id: run.run_id,
    connector_id: run.connector_id,
    grant_id: run.grant_id,
    status: run.status,
    needs_input: run.needs_input,
    failure_reason: run.failure_reason,
    started_at: run.started_at,
    finished_at: run.finished_at,
    first_at: run.first_at,
    last_at: run.last_at,
    event_count: run.events.length,
  };
}

export function buildRunsList(opts: {
  connector_id?: string;
  cursor?: string | null;
  limit?: number;
  status?: string;
}): ListEnvelope<RunSummary> {
  const filtered = DEMO_RUNS.filter((run) => {
    if (opts.status && run.status !== opts.status) {
      return false;
    }
    if (opts.connector_id && run.connector_id !== opts.connector_id) {
      return false;
    }
    return true;
  });
  return paginate(filtered.map(runToSummary), opts);
}

export function buildRunTimeline(runId: string): TimelineEnvelope | null {
  const run = DEMO_RUNS.find((r) => r.run_id === runId);
  if (!run) {
    return null;
  }
  const traceId = run.events[0]?.trace_id ?? null;
  return {
    object: "timeline",
    is_demo: true,
    notice: DEMO_NOTICE.notice,
    subject_type: "run",
    subject_id: run.run_id,
    trace_id: traceId,
    event_count: run.events.length,
    events: [...run.events],
  };
}

export interface TraceSummary {
  client_id: string | null;
  event_count: number;
  failure_reason: string | null;
  first_at: string;
  grant_id: string | null;
  kinds: string[];
  last_at: string;
  object: "trace_summary";
  run_id: string | null;
  status: string;
  trace_id: string;
}

function traceToSummary(trace: DemoTraceDef): TraceSummary {
  return {
    object: "trace_summary",
    trace_id: trace.trace_id,
    client_id: trace.client_id,
    grant_id: trace.grant_id,
    run_id: trace.run_id,
    status: trace.status,
    failure_reason: trace.failure_reason,
    kinds: [...trace.kinds],
    first_at: trace.first_at,
    last_at: trace.last_at,
    event_count: trace.kinds.length,
  };
}

export function buildTracesList(opts: {
  cursor?: string | null;
  limit?: number;
  status?: string;
}): ListEnvelope<TraceSummary> {
  const filtered = DEMO_TRACES.filter((trace) => {
    if (opts.status && trace.status !== opts.status) {
      return false;
    }
    return true;
  });
  return paginate(filtered.map(traceToSummary), opts);
}

export function buildTraceTimeline(traceId: string): TimelineEnvelope | null {
  const events = collectTraceEvents(traceId);
  if (events.length === 0 && !DEMO_TRACES.some((t) => t.trace_id === traceId)) {
    return null;
  }
  return {
    object: "timeline",
    is_demo: true,
    notice: DEMO_NOTICE.notice,
    subject_type: "trace",
    subject_id: traceId,
    trace_id: traceId,
    event_count: events.length,
    events,
  };
}

function collectTraceEvents(traceId: string): DemoTimelineEvent[] {
  const events: DemoTimelineEvent[] = [];
  for (const grant of DEMO_GRANTS) {
    if (grant.trace_id === traceId) {
      events.push(...grant.events);
    }
  }
  for (const run of DEMO_RUNS) {
    for (const evt of run.events) {
      if (evt.trace_id === traceId) {
        events.push(evt);
      }
    }
  }
  events.sort((a, b) => {
    if (a.occurred_at < b.occurred_at) {
      return -1;
    }
    if (a.occurred_at > b.occurred_at) {
      return 1;
    }
    return 0;
  });
  return events;
}

// ─── Dataset summary (legacy demo-shaped) ──────────────────────────────────

export interface DatasetSummary {
  blob_bytes: number;
  connector_count: number;
  earliest_record_time: string | null;
  is_demo: true;
  latest_record_time: string | null;
  notice: typeof DEMO_NOTICE.notice;
  object: "dataset_summary";
  record_count: number;
  stream_count: number;
  top_connectors: Array<{ connector_id: string; record_count: number }>;
  total_retained_bytes: number;
}

export function buildDatasetSummary(): DatasetSummary {
  const counts = countConnectorRecords();
  const topConnectors = [...counts.entries()]
    .map(([connector_id, record_count]) => ({ connector_id, record_count }))
    .sort((a, b) => b.record_count - a.record_count);
  const blobBytes = approximateRetainedBytes();
  const recordTimes = recordTimesSorted();
  return {
    object: "dataset_summary",
    is_demo: true,
    notice: DEMO_NOTICE.notice,
    connector_count: DEMO_CONNECTORS.length,
    stream_count: DEMO_STREAMS.length,
    record_count: DEMO_RECORDS.length,
    earliest_record_time: recordTimes.earliest,
    latest_record_time: recordTimes.latest,
    blob_bytes: blobBytes,
    total_retained_bytes: blobBytes,
    top_connectors: topConnectors,
  };
}

// ─── Connectors / clients / capabilities ───────────────────────────────────

export function getDemoConnectors(): readonly DemoConnectorDef[] {
  return DEMO_CONNECTORS;
}

export function getDemoStreams(): readonly DemoStreamDef[] {
  return DEMO_STREAMS;
}

export function getDemoCapabilities(): readonly DemoCapabilityDef[] {
  return DEMO_CAPABILITIES;
}

export function getDemoClients() {
  return DEMO_CLIENTS;
}

export function getDemoGrants() {
  return DEMO_GRANTS;
}

export function getDemoRuns() {
  return DEMO_RUNS;
}

export function getDemoTraces() {
  return DEMO_TRACES;
}

// ─── Well-known metadata (legacy demo-shaped) ──────────────────────────────

export interface OAuthAuthServerMetadata {
  authorization_endpoint: string;
  grant_types_supported: string[];
  introspection_endpoint: string;
  is_demo: true;
  issuer: string;
  notice: typeof DEMO_NOTICE.notice;
  pdpp_demo: {
    note: string;
    schema_endpoint: string;
    search_endpoint: string;
    streams_endpoint: string;
  };
  pushed_authorization_request_endpoint: string;
  response_types_supported: string[];
  revocation_endpoint: string;
  scopes_supported: string[];
  token_endpoint: string;
}

export function buildAuthServerMetadata(issuer = DEMO_ISSUER): OAuthAuthServerMetadata {
  return {
    is_demo: true,
    notice: DEMO_NOTICE.notice,
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    pushed_authorization_request_endpoint: `${issuer}/par`,
    token_endpoint: `${issuer}/token`,
    introspection_endpoint: `${issuer}/introspect`,
    revocation_endpoint: `${issuer}/revoke`,
    grant_types_supported: ["authorization_code", "urn:pdpp:params:oauth:grant-type:scoped_grant"],
    response_types_supported: ["code"],
    scopes_supported: [
      "stream:pay_statements:read",
      "stream:tax_documents:read",
      "stream:clinical_visits:read",
      "stream:transactions:read",
    ],
    pdpp_demo: {
      note: "Sandbox demo metadata. The real reference advertises live AS endpoints under the deployment origin.",
      streams_endpoint: `${issuer}/v1/streams`,
      schema_endpoint: `${issuer}/v1/schema`,
      search_endpoint: `${issuer}/v1/search`,
    },
  };
}

export interface OAuthProtectedResourceMetadata {
  authorization_servers: string[];
  bearer_methods_supported: string[];
  is_demo: true;
  notice: typeof DEMO_NOTICE.notice;
  pdpp_demo: {
    note: string;
    record_endpoint_template: string;
    search_endpoint: string;
    streams_endpoint: string;
  };
  resource: string;
  resource_documentation: string;
  scopes_supported: string[];
}

export function buildProtectedResourceMetadata(issuer = DEMO_ISSUER): OAuthProtectedResourceMetadata {
  return {
    is_demo: true,
    notice: DEMO_NOTICE.notice,
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    resource_documentation: issuer.replace(SANDBOX_PATH_SUFFIX_RE, "/docs"),
    scopes_supported: [
      "stream:pay_statements:read",
      "stream:tax_documents:read",
      "stream:clinical_visits:read",
      "stream:transactions:read",
    ],
    pdpp_demo: {
      note: "Sandbox demo metadata. Advertises sandbox-prefixed endpoints; not a live RS.",
      streams_endpoint: `${issuer}/v1/streams`,
      record_endpoint_template: `${issuer}/v1/streams/{stream}/records/{recordId}`,
      search_endpoint: `${issuer}/v1/search`,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Live-shaped builders (the fidelity pass).
//
// These mirror the live PDPP reference envelopes documented in:
//   reference-implementation/server/index.js (records.js, search.js, metadata.ts)
//   reference-implementation/openapi/reference-full.openapi.json
// so an agent can call /sandbox/v1/... and reuse parsing written for the
// real AS/RS. Sandbox markers are conveyed via the x-pdpp-demo HTTP header
// rather than payload fields, keeping payload shapes identical.
// ───────────────────────────────────────────────────────────────────────────

function sortRecordsNewestFirst(records: readonly DemoRecord[]): DemoRecord[] {
  return [...records].sort((a, b) => {
    if (a.record_time < b.record_time) {
      return 1;
    }
    if (a.record_time > b.record_time) {
      return -1;
    }
    return 0;
  });
}

function recordTimesSorted(): { earliest: string | null; latest: string | null } {
  if (DEMO_RECORDS.length === 0) {
    return { earliest: null, latest: null };
  }
  const sorted = DEMO_RECORDS.map((r) => r.record_time).sort();
  return { earliest: sorted[0] ?? null, latest: sorted.at(-1) ?? null };
}

function countConnectorRecords(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of DEMO_RECORDS) {
    counts.set(record.connector_id, (counts.get(record.connector_id) ?? 0) + 1);
  }
  return counts;
}

function approximateRetainedBytes(): number {
  return DEMO_RECORDS.reduce((sum, r) => sum + JSON.stringify(r.fields).length, 0);
}

// Schema: live shape is `{ object: "schema", bearer, connectors: [{ object:
// "connector", source, stream_count, streams: [stream_metadata...] }] }`.
// See reference-implementation/server/index.js (`/v1/schema` route +
// `buildConnectorSchemaItem`).
//
// `buildLiveSchemaResponse` lived here until the rs.schema.get operation
// migration. It mirrored the live RS schema shape entirely inside this
// builder module, which made the sandbox `/sandbox/v1/schema` route a
// parallel AS/RS implementation. That route now mounts the canonical
// `rs.schema.get` operation with sandbox fixture dependencies; see
// `./operations-fixtures.ts` and the sandbox route. Do not reintroduce a
// public schema builder here. `buildLiveStreamMetadata` (singular) is
// intentionally still exported so the schema fixture, the stream-detail
// fixture, and any future stream-shape consumers share one envelope
// assembler.

export interface LiveStreamMetadata {
  cursor_field: string | null;
  expand_capabilities: unknown[];
  field_capabilities: { allowed_fields: string[]; restricted_fields: string[] };
  freshness: { last_updated: string | null };
  name: string;
  object: "stream_metadata";
  primary_key: string[];
  query: { range_filters: Record<string, unknown>; expand: unknown[] };
  relationships: unknown[];
  schema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
  selection: { all: true };
  semantics: string;
  views: unknown[];
}

export function buildLiveStreamMetadata(stream: DemoStreamDef): LiveStreamMetadata {
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const field of stream.fields) {
    properties[field.name] = {
      type: liveTypeFor(field.type),
      description: field.description,
    };
  }
  const allowed = stream.fields.map((f) => f.name);
  return {
    object: "stream_metadata",
    name: stream.key,
    semantics: stream.label,
    schema: {
      type: "object",
      properties,
      required: allowed,
    },
    primary_key: ["id"],
    cursor_field: cursorFieldFor(stream),
    selection: { all: true },
    views: [],
    relationships: [],
    query: { range_filters: {}, expand: [] },
    field_capabilities: { allowed_fields: allowed, restricted_fields: [] },
    expand_capabilities: [],
    freshness: { last_updated: latestRecordTimeForStream(stream.key) ?? stream.latest_record_time },
  };
}

function liveTypeFor(t: DemoStreamDef["fields"][number]["type"]): string {
  if (t === "timestamp") {
    return "string";
  }
  if (t === "currency_minor_units") {
    return "integer";
  }
  return t;
}

function cursorFieldFor(stream: DemoStreamDef): string | null {
  const candidates = ["period_end", "issued_at", "visit_at", "posted_at"];
  for (const c of candidates) {
    if (stream.fields.some((f) => f.name === c)) {
      return c;
    }
  }
  return null;
}

function latestRecordTimeForStream(streamKey: string): string | null {
  const matching = DEMO_RECORDS.filter((r) => r.stream === streamKey).map((r) => r.record_time);
  if (matching.length === 0) {
    return null;
  }
  matching.sort();
  return matching.at(-1) ?? null;
}

// Streams list: live shape is `{ object: "list", data: [{ object: "stream",
// name, record_count, last_updated, freshness }] }` where `freshness` is
// `buildFreshness(last_updated)` — the demo emits a parallel shape and the
// route handler does the lightweight pagination wrapper.

// `buildLiveStreamsList` lived here until the rs.streams.list operation
// migration. It mirrored the live RS shape entirely inside this builder
// module, which made the sandbox route a parallel AS/RS implementation.
// `/sandbox/v1/streams` now mounts the canonical `rs.streams.list` operation
// with sandbox fixture dependencies; see
// `./operations-fixtures.ts` and the sandbox route. Do not reintroduce a
// public stream-list builder here.

// `buildLiveStreamMetadataResponse` lived here until the rs.streams.detail
// operation migration. It mirrored the live RS stream-metadata shape entirely
// inside this builder module, which made the sandbox `/sandbox/v1/streams/:s`
// route a parallel AS/RS implementation. That route now mounts the canonical
// `rs.streams.detail` operation with sandbox fixture dependencies; see
// `./operations-fixtures.ts` and the sandbox route. Do not reintroduce a
// public stream-detail builder here. `buildLiveStreamMetadata` (singular)
// is intentionally still exported so the fixture dependencies share one
// envelope assembler with the schema and stream-detail fixtures.

// Records list / detail are mounted through the canonical operation
// capsules `rs.records.list` and `rs.records.get` (see
// `reference-implementation/operations/rs-records-list` /
// `rs-records-detail`). The previous website-local
// `buildLiveRecordsList` / `buildLiveRecordDetail` builders are deleted;
// fixture wiring lives in `./operations-fixtures.ts` and the public
// sandbox routes mount the operation directly.

// Search: live envelope is `{ object: "list", url: "/v1/search", has_more,
// [next_cursor], data: [{ object: "search_result", stream, record_key,
// connector_id, record_url, emitted_at, matched_fields, snippet?, score? }] }`.
// The sandbox emits the same shape; `score.kind: "bm25"` so a score-aware
// agent doesn't have to special-case the demo. Score values are computed
// from the simple substring counter, so they are demo-only and noted as
// such in `score.value_semantics`.

// Sandbox public lexical search is now mounted through the canonical
// `rs.search.lexical` operation capsule (see
// `reference-implementation/operations/rs-search-lexical/`). The previous
// website-local `buildLiveSearchResponse` builder is deleted; substring-
// matching fixture wiring lives in `./operations-fixtures.ts` and the
// public sandbox route mounts the operation directly.

// Dataset summary: the previous `buildLiveDatasetSummary` /
// `LiveDatasetSummary` exports lived here until the `ref.dataset.summary`
// operation migration. They mirrored the live `dataset_summary` envelope
// inside this builder module, which made `/sandbox/_ref/dataset/summary` a
// parallel operator-console envelope writer. That route now mounts the
// canonical `ref.dataset.summary` operation with sandbox fixture
// dependencies; see `./operations-fixtures.ts` and the sandbox route. Do not
// reintroduce a public dataset-summary builder here.

// Spine lists/timelines and well-known metadata are now mounted through
// canonical operation modules with sandbox fixture adapters in
// `./operations-fixtures.ts`. Do not reintroduce website-local `buildLive*`
// AS/RS envelope builders here.
