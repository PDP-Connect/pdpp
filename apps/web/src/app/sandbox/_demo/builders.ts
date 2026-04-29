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

interface LiveListEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor?: string;
  object: "list";
  url?: string;
}

function paginateLive<T>(
  rows: readonly T[],
  opts: { limit?: number; cursor?: string | null; url?: string }
): LiveListEnvelope<T> {
  const limit = clampLimit(opts.limit);
  const start = decodeCursor(opts.cursor);
  const slice = rows.slice(start, start + limit);
  const next = start + limit;
  const hasMore = next < rows.length;
  const envelope: LiveListEnvelope<T> = {
    object: "list",
    has_more: hasMore,
    data: slice as T[],
  };
  if (hasMore) {
    envelope.next_cursor = encodeCursor(next);
  }
  if (opts.url) {
    envelope.url = opts.url;
  }
  return envelope;
}

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

function ingestedTimesSorted(): { earliest: string | null; latest: string | null } {
  if (DEMO_RECORDS.length === 0) {
    return { earliest: null, latest: null };
  }
  const sorted = DEMO_RECORDS.map((r) => r.ingested_at).sort();
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

export interface LiveSchemaResponse {
  bearer: { token_kind: string; scope: string };
  connectors: LiveConnectorSchemaItem[];
  object: "schema";
}

interface LiveConnectorSchemaItem {
  connector_id: string;
  object: "connector";
  source: { binding_kind: "connector"; connector_id: string };
  stream_count: number;
  streams: LiveStreamMetadata[];
}

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

export function buildLiveSchemaResponse(): LiveSchemaResponse {
  const connectors: LiveConnectorSchemaItem[] = DEMO_CONNECTORS.map((connector) => {
    const streams = DEMO_STREAMS.filter((s) => s.connector_id === connector.connector_id);
    return {
      object: "connector",
      source: { binding_kind: "connector", connector_id: connector.connector_id },
      connector_id: connector.connector_id,
      stream_count: streams.length,
      streams: streams.map((s) => buildLiveStreamMetadata(s)),
    };
  });
  return {
    object: "schema",
    bearer: { token_kind: "owner", scope: "owner" },
    connectors,
  };
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
// is intentionally still exported so the fixture dependencies and the
// `/sandbox/v1/schema` builder share one envelope assembler.

// Records list / detail: live record shape is `{ object: "record", id,
// stream, data, emitted_at }`. The list envelope adds `url`.

export interface LiveStreamRecord {
  data: Readonly<Record<string, unknown>>;
  emitted_at: string;
  id: string;
  object: "record";
  stream: string;
}

function recordToLiveRecord(record: DemoRecord): LiveStreamRecord {
  return {
    object: "record",
    id: record.record_id,
    stream: record.stream,
    data: { ...record.fields },
    emitted_at: record.ingested_at,
  };
}

export function buildLiveRecordsList(opts: {
  connector_id?: string;
  cursor?: string | null;
  limit?: number;
  stream: string;
}): LiveListEnvelope<LiveStreamRecord> | null {
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
  return paginateLive(sorted.map(recordToLiveRecord), {
    ...opts,
    url: `/sandbox/v1/streams/${encodeURIComponent(opts.stream)}/records`,
  });
}

export function buildLiveRecordDetail(streamKey: string, recordId: string): LiveStreamRecord | null {
  const record = DEMO_RECORDS.find((r) => r.stream === streamKey && r.record_id === recordId);
  if (!record) {
    return null;
  }
  return recordToLiveRecord(record);
}

// Search: live envelope is `{ object: "list", url: "/v1/search", has_more,
// [next_cursor], data: [{ object: "search_result", stream, record_key,
// connector_id, record_url, emitted_at, matched_fields, snippet?, score? }] }`.
// The sandbox emits the same shape; `score.kind: "bm25"` so a score-aware
// agent doesn't have to special-case the demo. Score values are computed
// from the simple substring counter, so they are demo-only and noted as
// such in `score.value_semantics`.

export interface LiveSearchHit {
  connector_id: string;
  emitted_at: string;
  matched_fields: string[];
  object: "search_result";
  record_key: string;
  record_url: string;
  score?: { kind: "bm25"; order: "lower_is_better"; value: number };
  snippet?: { field: string; text: string };
  stream: string;
}

export interface LiveSearchResponse extends LiveListEnvelope<LiveSearchHit> {
  url: "/sandbox/v1/search";
}

export function buildLiveSearchResponse(
  query: string,
  opts: { limit?: number; cursor?: string | null } = {}
): LiveSearchResponse {
  const trimmed = query.trim();
  const allHits: LiveSearchHit[] = [];
  if (trimmed.length > 0) {
    const lower = trimmed.toLowerCase();
    for (const record of DEMO_RECORDS) {
      const hit = buildLiveSearchHit(record, { lower, trimmed });
      if (hit) {
        allHits.push(hit);
      }
    }
    // Live BM25 ordering is `lower_is_better`. The sandbox uses an inverse
    // substring counter, so we emit `1 / (1 + matchCount)` to keep the same
    // ordering semantic without claiming real BM25 numbers.
    allHits.sort((a, b) => {
      const av = a.score?.value ?? Number.POSITIVE_INFINITY;
      const bv = b.score?.value ?? Number.POSITIVE_INFINITY;
      if (av !== bv) {
        return av - bv;
      }
      return a.record_key.localeCompare(b.record_key);
    });
  }
  const paged = paginateLive(allHits, { ...opts, url: "/sandbox/v1/search" });
  return { ...paged, url: "/sandbox/v1/search" };
}

function buildLiveSearchHit(record: DemoRecord, query: { lower: string; trimmed: string }): LiveSearchHit | null {
  const matchedFields: string[] = [];
  let bestMatch: { field: string; matches: number; snippet: string } | null = null;
  for (const [field, raw] of Object.entries(record.fields)) {
    const value = typeof raw === "string" ? raw : JSON.stringify(raw);
    const lowerValue = value.toLowerCase();
    if (!lowerValue.includes(query.lower)) {
      continue;
    }
    matchedFields.push(field);
    const matches = (lowerValue.match(new RegExp(escapeRegex(query.lower), "g")) ?? []).length;
    if (!bestMatch || matches > bestMatch.matches) {
      bestMatch = { field, matches, snippet: snippetAround(value, query.trimmed) };
    }
  }
  if (!bestMatch) {
    return null;
  }
  // Inverse-of-matches gives `lower_is_better` ordering aligned with live
  // BM25. The exact value is not comparable across implementations; live
  // BM25 also documents `value_semantics: "implementation_relative"`.
  const value = 1 / (1 + matchedFields.length + bestMatch.matches);
  return {
    object: "search_result",
    stream: record.stream,
    record_key: record.record_id,
    connector_id: record.connector_id,
    record_url: `/sandbox/v1/streams/${encodeURIComponent(record.stream)}/records/${encodeURIComponent(record.record_id)}`,
    emitted_at: record.ingested_at,
    matched_fields: matchedFields,
    score: { kind: "bm25", order: "lower_is_better", value },
    snippet: { field: bestMatch.field, text: bestMatch.snippet },
  };
}

// _ref summaries: live shapes from reference-implementation/server/index.js
// `summaryToTrace`, `summaryToGrant`, `summaryToRun`. The sandbox emits the
// same field names. `failure` is an object `{ event_type, reason }` (live);
// `failure_reason` on run_summary is a string (live).

export interface LiveTraceSummary {
  actor_id: string | null;
  actor_type: string | null;
  client_id: string | null;
  event_count: number;
  failure: { event_type: string; reason: string | null } | null;
  first_at: string;
  grant_id: string | null;
  kinds: string[];
  last_at: string;
  object: "trace_summary";
  provider_id: string | null;
  request_id: string | null;
  run_id: string | null;
  status: string;
  trace_id: string;
}

export interface LiveGrantSummary {
  client_id: string | null;
  connector_id: string | null;
  event_count: number;
  failure: { event_type: string; reason: string | null } | null;
  first_at: string;
  grant_id: string;
  kinds: string[];
  last_at: string;
  object: "grant_summary";
  provider_id: string | null;
  status: string;
}

export interface LiveRunSummary {
  connector_id: string | null;
  event_count: number;
  failure_reason: string | null;
  first_at: string;
  grant_id: string | null;
  kinds: string[];
  last_at: string;
  needs_input: boolean;
  object: "run_summary";
  provider_id: string | null;
  run_id: string;
  status: string;
}

function grantToLiveSummary(g: DemoGrantDef): LiveGrantSummary {
  let failure: LiveGrantSummary["failure"] = null;
  if (g.status === "denied") {
    failure = { event_type: "consent.declined", reason: "owner_declined" };
  } else if (g.status === "revoked") {
    failure = { event_type: "grant.revoked", reason: "grant_revoked" };
  }
  return {
    object: "grant_summary",
    grant_id: g.grant_id,
    first_at: g.first_at,
    last_at: g.last_at,
    event_count: g.events.length,
    status: g.status,
    kinds: g.events.map((e) => e.event_type),
    client_id: g.client_id,
    provider_id: null,
    connector_id: g.connector_id,
    failure,
  };
}

function runToLiveSummary(r: DemoRunDef): LiveRunSummary {
  return {
    object: "run_summary",
    run_id: r.run_id,
    first_at: r.first_at,
    last_at: r.last_at,
    event_count: r.events.length,
    status: r.status,
    kinds: r.events.map((e) => e.event_type),
    needs_input: r.needs_input,
    connector_id: r.connector_id,
    provider_id: null,
    grant_id: r.grant_id,
    failure_reason: r.failure_reason,
  };
}

function traceActorType(t: DemoTraceDef): string | null {
  if (t.client_id) {
    return "client";
  }
  if (t.run_id) {
    return "runtime";
  }
  return null;
}

function traceFailure(t: DemoTraceDef): { event_type: string; reason: string | null } | null {
  if (!t.failure_reason) {
    return null;
  }
  return { event_type: t.run_id ? "run.failed" : "trace", reason: t.failure_reason };
}

function traceToLiveSummary(t: DemoTraceDef): LiveTraceSummary {
  return {
    object: "trace_summary",
    trace_id: t.trace_id,
    first_at: t.first_at,
    last_at: t.last_at,
    event_count: t.kinds.length,
    status: t.status,
    kinds: [...t.kinds],
    request_id: null,
    grant_id: t.grant_id,
    run_id: t.run_id,
    client_id: t.client_id,
    provider_id: null,
    actor_type: traceActorType(t),
    actor_id: t.client_id ?? null,
    failure: traceFailure(t),
  };
}

export function buildLiveGrantsList(opts: {
  client_id?: string;
  cursor?: string | null;
  limit?: number;
  status?: string;
}): LiveListEnvelope<LiveGrantSummary> {
  const filtered = DEMO_GRANTS.filter((g) => {
    if (opts.status && g.status !== opts.status) {
      return false;
    }
    if (opts.client_id && g.client_id !== opts.client_id) {
      return false;
    }
    return true;
  });
  return paginateLive(filtered.map(grantToLiveSummary), opts);
}

export function buildLiveRunsList(opts: {
  connector_id?: string;
  cursor?: string | null;
  limit?: number;
  status?: string;
}): LiveListEnvelope<LiveRunSummary> {
  const filtered = DEMO_RUNS.filter((r) => {
    if (opts.status && r.status !== opts.status) {
      return false;
    }
    if (opts.connector_id && r.connector_id !== opts.connector_id) {
      return false;
    }
    return true;
  });
  return paginateLive(filtered.map(runToLiveSummary), opts);
}

export function buildLiveTracesList(opts: {
  cursor?: string | null;
  limit?: number;
  status?: string;
}): LiveListEnvelope<LiveTraceSummary> {
  const filtered = DEMO_TRACES.filter((t) => (opts.status ? t.status === opts.status : true));
  return paginateLive(filtered.map(traceToLiveSummary), opts);
}

// _ref timelines: live builders return
//   `{ object, [<idKey>]: <id>, trace_id, event_count, data: [events] }`
// where `object` is one of `trace`, `grant_timeline`, `run_timeline`.
// See reference-implementation/server/index.js `buildTimelineEnvelope`.

export interface LiveTimelineEnvelope {
  data: DemoTimelineEvent[];
  event_count: number;
  object: "trace" | "grant_timeline" | "run_timeline";
  trace_id: string | null;
  // Discriminator key (`trace_id`, `grant_id`, or `run_id`) is always
  // present; the field is set by the route via spread.
  [k: string]: unknown;
}

export function buildLiveGrantTimeline(grantId: string): LiveTimelineEnvelope | null {
  const grant = DEMO_GRANTS.find((g) => g.grant_id === grantId);
  if (!grant) {
    return null;
  }
  const events = [...grant.events];
  return {
    object: "grant_timeline",
    grant_id: grant.grant_id,
    trace_id: events.find((e) => e.trace_id)?.trace_id ?? grant.trace_id ?? null,
    event_count: events.length,
    data: events,
  };
}

export function buildLiveRunTimeline(runId: string): LiveTimelineEnvelope | null {
  const run = DEMO_RUNS.find((r) => r.run_id === runId);
  if (!run) {
    return null;
  }
  const events = [...run.events];
  return {
    object: "run_timeline",
    run_id: run.run_id,
    trace_id: events.find((e) => e.trace_id)?.trace_id ?? null,
    event_count: events.length,
    data: events,
  };
}

export function buildLiveTraceTimeline(traceId: string): LiveTimelineEnvelope | null {
  const events = collectTraceEvents(traceId);
  if (events.length === 0 && !DEMO_TRACES.some((t) => t.trace_id === traceId)) {
    return null;
  }
  return {
    object: "trace",
    trace_id: traceId,
    event_count: events.length,
    data: events,
  };
}

// Dataset summary: live shape from reference-implementation/server/records.js
// `getDatasetSummary` plus `getTopConnectorsByRecordCount`.

export interface LiveDatasetSummary {
  blob_bytes: number;
  connector_count: number;
  earliest_ingested_at: string | null;
  earliest_record_time: string | null;
  latest_ingested_at: string | null;
  latest_record_time: string | null;
  object: "dataset_summary";
  record_changes_json_bytes: number;
  record_count: number;
  record_json_bytes: number;
  stream_count: number;
  top_connectors: Array<{ connector_id: string; object: "dataset_connector_summary"; record_count: number }>;
  total_retained_bytes: number;
}

export function buildLiveDatasetSummary(): LiveDatasetSummary {
  const counts = countConnectorRecords();
  const topConnectors = [...counts.entries()]
    .map(([connector_id, record_count]) => ({
      object: "dataset_connector_summary" as const,
      connector_id,
      record_count,
    }))
    .sort((a, b) => b.record_count - a.record_count || a.connector_id.localeCompare(b.connector_id))
    .slice(0, 3);
  const recordJsonBytes = approximateRetainedBytes();
  const recordTimes = recordTimesSorted();
  const ingestedTimes = ingestedTimesSorted();
  return {
    object: "dataset_summary",
    connector_count: DEMO_CONNECTORS.length,
    stream_count: DEMO_STREAMS.length,
    record_count: DEMO_RECORDS.length,
    record_json_bytes: recordJsonBytes,
    record_changes_json_bytes: 0,
    blob_bytes: 0,
    total_retained_bytes: recordJsonBytes,
    earliest_record_time: recordTimes.earliest,
    latest_record_time: recordTimes.latest,
    earliest_ingested_at: ingestedTimes.earliest,
    latest_ingested_at: ingestedTimes.latest,
    top_connectors: topConnectors,
  };
}

// Well-known: live builders from
//   reference-implementation/server/metadata.ts
//     buildAuthorizationServerMetadata, buildProtectedResourceMetadata
// The sandbox emits the same fields. PDPP discovery hints (lexical
// retrieval extension, query base, blob indirection) are advertised so the
// sandbox metadata is a working contract for an agent — they describe the
// sandbox endpoints that are actually implemented.

export interface LiveAuthorizationServerMetadata {
  device_authorization_endpoint?: string;
  grant_types_supported?: string[];
  introspection_endpoint: string;
  issuer: string;
  pdpp_authorization_details_types_supported?: string[];
  pdpp_provider_connect_capabilities: Record<string, unknown>;
  pdpp_registration_modes_supported?: string[];
  pushed_authorization_request_endpoint?: string;
  registration_endpoint?: string;
  token_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

export function buildLiveAuthServerMetadata(issuer: string): LiveAuthorizationServerMetadata {
  return {
    issuer,
    introspection_endpoint: `${issuer}/oauth/introspect`,
    pdpp_provider_connect_capabilities: {
      owner_self_export: true,
      cli_device_connect: false,
      third_party_client_connect: true,
    },
    pushed_authorization_request_endpoint: `${issuer}/oauth/par`,
    token_endpoint: `${issuer}/oauth/token`,
    token_endpoint_auth_methods_supported: ["none"],
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
    device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
    pdpp_authorization_details_types_supported: ["https://pdpp.org/data-access"],
    pdpp_registration_modes_supported: ["pre_registered_public"],
  };
}

export interface LiveProtectedResourceMetadata {
  authorization_servers: string[];
  bearer_methods_supported: string[];
  capabilities?: Record<string, unknown>;
  pdpp_agent_discovery?: {
    advisory: true;
    llms_full_txt: string;
    llms_txt: string;
    recommended_flow: "pdpp agent";
    skill: string;
    skill_catalog: string;
    skill_name: "pdpp-data-access";
  };
  pdpp_core_query_base: string;
  pdpp_discovery_hints?: {
    aggregate: { endpoint_template: string };
    blob_indirection: "data.blob_ref.fetch_url";
    changes_since_bootstrap: "beginning";
    query_base: string;
    schema_endpoint: string;
    search?: {
      endpoint: string;
      filter_requires_single_stream: boolean;
      scope_param: "streams[]";
    };
  };
  pdpp_provider_connect_version: string;
  pdpp_self_export_supported: boolean;
  pdpp_token_kinds_supported: string[];
  resource: string;
  resource_name: string;
}

function buildLiveAgentDiscovery(issuer: string): NonNullable<LiveProtectedResourceMetadata["pdpp_agent_discovery"]> {
  const siteOrigin = new URL(issuer).origin;
  return {
    advisory: true,
    skill_name: "pdpp-data-access",
    recommended_flow: "pdpp agent",
    skill_catalog: `${siteOrigin}/.well-known/skills/index.json`,
    skill: `${siteOrigin}/.well-known/skills/pdpp-data-access/SKILL.md`,
    llms_txt: `${siteOrigin}/llms.txt`,
    llms_full_txt: `${siteOrigin}/llms-full.txt`,
  };
}

export function buildLiveProtectedResourceMetadata(issuer: string): LiveProtectedResourceMetadata {
  // The sandbox advertises lexical retrieval because the route
  // /sandbox/v1/search is implemented. Semantic and hybrid retrieval are
  // not advertised because the sandbox does not implement them — see
  // DEMO_CAPABILITIES["semantic_search"] which is `demonstrated_in_demo: false`.
  const queryBase = `${issuer}/v1`;
  return {
    resource: issuer,
    resource_name: "Sandbox demo Resource Server",
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    pdpp_provider_connect_version: "1.0.0",
    pdpp_self_export_supported: true,
    pdpp_token_kinds_supported: ["owner", "client"],
    pdpp_core_query_base: queryBase,
    pdpp_agent_discovery: buildLiveAgentDiscovery(issuer),
    capabilities: {
      lexical_retrieval: {
        supported: true,
        endpoint: `${issuer}/v1/search`,
        cross_stream: true,
        snippets: true,
        default_limit: DEFAULT_PAGE_LIMIT,
        max_limit: MAX_PAGE_LIMIT,
        score: {
          supported: true,
          kind: "bm25",
          order: "lower_is_better",
          value_semantics: "implementation_relative",
        },
      },
    },
    pdpp_discovery_hints: {
      schema_endpoint: `${issuer}/v1/schema`,
      query_base: queryBase,
      aggregate: { endpoint_template: `${issuer}/v1/streams/{stream}/aggregate` },
      changes_since_bootstrap: "beginning",
      blob_indirection: "data.blob_ref.fetch_url",
      search: {
        endpoint: `${issuer}/v1/search`,
        scope_param: "streams[]",
        filter_requires_single_stream: true,
      },
    },
  };
}
