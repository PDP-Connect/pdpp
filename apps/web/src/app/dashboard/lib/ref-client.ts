/**
 * Server-only helper for the reference-designated `_ref` read surfaces on
 * the PDPP authorization server. These are inspection endpoints, not part
 * of the public PDPP contract, and the dashboard is one of two consumers
 * (CLI is the other).
 *
 * Server-only: do not import from client components.
 */
import { getAsInternalUrl, ReferenceServerUnreachableError, withOwnerSessionCookie } from "./owner-token.ts";

export interface SpineEvent {
  actor_id: string | null;
  actor_type: string | null;
  client_id: string | null;
  data: Record<string, unknown>;
  event_id: string;
  event_type: string;
  grant_id: string | null;
  interaction_id: string | null;
  object_id: string | null;
  object_type: string | null;
  occurred_at: string;
  provider_id: string | null;
  recorded_at: string;
  request_id: string | null;
  run_id: string | null;
  scenario_id: string | null;
  status: string | null;
  stream_id: string | null;
  subject_id: string | null;
  subject_type: string | null;
  token_id: string | null;
  trace_id: string;
  version: string;
}

export interface TimelineEnvelope {
  event_count: number;
  events: SpineEvent[];
  object: string;
  trace_id: string | null;
}

/**
 * The reference server returns timeline envelopes as
 * `{ object, <id_key>: <id_value>, trace_id, event_count, data: [...] }`
 * where `data` carries the events. The dashboard and CLI both predate a
 * unified name, so we normalize here for the web UI without changing the
 * server contract.
 */
function normalizeTimeline(raw: unknown): TimelineEnvelope {
  const r = (raw || {}) as {
    object?: string;
    trace_id?: string | null;
    event_count?: number;
    data?: SpineEvent[];
    events?: SpineEvent[];
  };
  let events: SpineEvent[] = [];
  if (Array.isArray(r.events)) {
    events = r.events;
  } else if (Array.isArray(r.data)) {
    events = r.data;
  }
  return {
    object: r.object ?? "timeline",
    trace_id: r.trace_id ?? null,
    event_count: typeof r.event_count === "number" ? r.event_count : events.length,
    events,
  };
}

export interface ListResponse<T> {
  data: T[];
  has_more: boolean;
  next_cursor?: string;
  object: "list";
}

export interface FailureInfo {
  event_type: string;
  reason: string | null;
}

export interface TraceSummary {
  actor_id: string | null;
  actor_type: string | null;
  client_id: string | null;
  event_count: number;
  failure: FailureInfo | null;
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

export interface GrantSummary {
  client_id: string | null;
  connector_id: string | null;
  event_count: number;
  failure: FailureInfo | null;
  first_at: string;
  grant_id: string;
  kinds: string[];
  last_at: string;
  object: "grant_summary";
  provider_id: string | null;
  status: string;
}

export interface RunSummary {
  connector_id: string | null;
  event_count: number;
  failure_reason: string | null;
  first_at: string;
  grant_id: string | null;
  kinds: string[];
  last_at: string;
  object: "run_summary";
  provider_id: string | null;
  run_id: string;
  status: string;
}

export interface RefConnectorRunSummary {
  event_count: number;
  failure_reason: string | null;
  finished_at: string | null;
  first_at: string;
  last_at: string;
  run_id: string;
  started_at: string;
  status: string;
}

export interface RefConnectorSummary {
  connector_id: string;
  display_name: string;
  freshness: Record<string, unknown>;
  last_run: RefConnectorRunSummary | null;
  last_successful_run: RefConnectorRunSummary | null;
  manifest_version: string | null;
  schedule: Record<string, unknown> | null;
  streams: string[];
  total_records: number;
}

class RefNotFoundError extends Error {
  readonly status = 404;
}

async function refFetch(path: string, params?: Record<string, string | number | undefined>) {
  const url = new URL(`${getAsInternalUrl()}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), await withOwnerSessionCookie({ cache: "no-store" }));
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${getAsInternalUrl()}`, err);
  }
  if (res.status === 404) {
    throw new RefNotFoundError(`not found: ${path}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`_ref ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

export { RefNotFoundError };

export async function getTraceTimeline(traceId: string): Promise<TimelineEnvelope | null> {
  try {
    return normalizeTimeline(await refFetch(`/_ref/traces/${encodeURIComponent(traceId)}`));
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  }
}

export async function getGrantTimeline(grantId: string): Promise<TimelineEnvelope | null> {
  try {
    return normalizeTimeline(await refFetch(`/_ref/grants/${encodeURIComponent(grantId)}/timeline`));
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  }
}

export async function getRunTimeline(runId: string): Promise<TimelineEnvelope | null> {
  try {
    return normalizeTimeline(await refFetch(`/_ref/runs/${encodeURIComponent(runId)}/timeline`));
  } catch (err) {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  }
}

export interface ListQuery {
  client_id?: string;
  connector_id?: string;
  cursor?: string;
  grant_id?: string;
  limit?: number;
  provider_id?: string;
  q?: string;
  since?: string;
  status?: string;
  until?: string;
}

export async function listTraces(opts: ListQuery = {}): Promise<ListResponse<TraceSummary>> {
  return (await refFetch(
    "/_ref/traces",
    opts as Record<string, string | number | undefined>
  )) as ListResponse<TraceSummary>;
}

export async function listGrants(opts: ListQuery = {}): Promise<ListResponse<GrantSummary>> {
  return (await refFetch(
    "/_ref/grants",
    opts as Record<string, string | number | undefined>
  )) as ListResponse<GrantSummary>;
}

export async function listRuns(opts: ListQuery = {}): Promise<ListResponse<RunSummary>> {
  return (await refFetch(
    "/_ref/runs",
    opts as Record<string, string | number | undefined>
  )) as ListResponse<RunSummary>;
}

export async function listConnectorSummaries(): Promise<ListResponse<RefConnectorSummary>> {
  return (await refFetch("/_ref/connectors")) as ListResponse<RefConnectorSummary>;
}

export interface DatasetConnectorSummary {
  connector_id: string;
  object: "dataset_connector_summary";
  record_count: number;
}

export interface DatasetSummary {
  blob_bytes: number;
  connector_count: number;
  /** Substrate ingestion bounds (when the runtime wrote the row). Not the real age of the data. */
  earliest_ingested_at: string | null;
  /** Real-world earliest timestamp pulled from record data via each stream's manifest-declared `consent_time_field`. */
  earliest_record_time: string | null;
  latest_ingested_at: string | null;
  /** Real-world latest timestamp pulled the same way. */
  latest_record_time: string | null;
  object: "dataset_summary";
  record_changes_json_bytes: number;
  record_count: number;
  record_json_bytes: number;
  stream_count: number;
  top_connectors: DatasetConnectorSummary[];
  total_retained_bytes: number;
}

export async function getDatasetSummary(): Promise<DatasetSummary> {
  return (await refFetch("/_ref/dataset/summary")) as DatasetSummary;
}

// The reference deployment diagnostics surface. Consumed by the operator-
// facing /dashboard/deployment page. Shape matches the report returned by
// server/deployment-diagnostics.ts; the RS redacts secrets before sending,
// and the dashboard must not re-assemble them.
export interface DeploymentDiagnostics {
  database: { path: string };
  environment: ReadonlyArray<{
    name: string;
    value: string | null;
    provenance: "absent" | "present" | "redacted";
    secret: boolean;
  }>;
  manifests: ReadonlyArray<{
    connector_id: string;
    display_name: string | null;
    provenance: "native" | "polyfill-registered";
    semantic_stream_count: number;
  }>;
  semantic: {
    backend: {
      configured: boolean;
      available: boolean;
      profile_id: string | null;
      model: string | null;
      dtype: string | null;
      dimensions: number | null;
      distance_metric: string | null;
      language_bias: { primary: string; note?: string } | null;
      model_cache_path: string | null;
      model_cache_present: boolean | null;
      download_allowed: boolean | null;
    };
    index: {
      kind: "sqlite-vec" | "blob-flat" | null;
      state: "built" | "building" | "stale" | null;
    };
    participation: {
      connector_count: number;
      stream_count: number;
      field_count: number;
      tuples: ReadonlyArray<{
        connector_id: string;
        stream: string;
        field: string;
        provenance: "native" | "polyfill-registered";
      }>;
    };
  };
  warnings: ReadonlyArray<{
    code:
      | "zero_participation"
      | "building_index"
      | "stale_index"
      | "backend_unavailable"
      | "missing_model_cache"
      | "download_disabled"
      | "vector_index_fallback";
    message: string;
  }>;
}

export async function getDeploymentDiagnostics(): Promise<DeploymentDiagnostics> {
  return (await refFetch("/_ref/deployment")) as DeploymentDiagnostics;
}

export async function refSearch(query: string): Promise<{
  object: "search_result";
  traces: TraceSummary[];
  grants: GrantSummary[];
  runs: RunSummary[];
  exact: { kind: "trace" | "grant" | "run"; id: string } | null;
}> {
  return (await refFetch("/_ref/search", { q: query })) as {
    object: "search_result";
    traces: TraceSummary[];
    grants: GrantSummary[];
    runs: RunSummary[];
    exact: { kind: "trace" | "grant" | "run"; id: string } | null;
  };
}

export interface PendingApproval {
  approval_id: string;
  client_id?: string | null;
  created_at: string;
  grant_preview?: {
    connector_id?: string | null;
    provider_id?: string | null;
    streams?: Array<{ name?: string } | string>;
  } | null;
  kind: "consent" | "owner_device";
  object: "approval";
  user_code?: string | null;
}

export async function listPendingApprovals(): Promise<ListResponse<PendingApproval>> {
  return (await refFetch("/_ref/approvals")) as ListResponse<PendingApproval>;
}
