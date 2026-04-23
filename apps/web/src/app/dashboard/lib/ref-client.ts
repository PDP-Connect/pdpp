/**
 * Server-only helper for the reference-designated `_ref` read surfaces on
 * the PDPP authorization server. These are inspection endpoints, not part
 * of the public PDPP contract, and the dashboard is one of two consumers
 * (CLI is the other).
 *
 * Server-only: do not import from client components.
 */
import {
  ReferenceServerUnreachableError,
  getAsUrl,
} from './owner-token';

export type SpineEvent = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  recorded_at: string;
  scenario_id: string | null;
  trace_id: string;
  actor_type: string | null;
  actor_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  object_type: string | null;
  object_id: string | null;
  status: string | null;
  request_id: string | null;
  grant_id: string | null;
  run_id: string | null;
  provider_id: string | null;
  client_id: string | null;
  stream_id: string | null;
  token_id: string | null;
  interaction_id: string | null;
  data: Record<string, unknown>;
  version: string;
};

export type TimelineEnvelope = {
  object: string;
  trace_id: string | null;
  event_count: number;
  events: SpineEvent[];
};

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
  const events = Array.isArray(r.events) ? r.events : Array.isArray(r.data) ? r.data : [];
  return {
    object: r.object ?? 'timeline',
    trace_id: r.trace_id ?? null,
    event_count: typeof r.event_count === 'number' ? r.event_count : events.length,
    events,
  };
}

export type ListResponse<T> = {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor?: string;
};

export type FailureInfo = {
  event_type: string;
  reason: string | null;
};

export type TraceSummary = {
  object: 'trace_summary';
  trace_id: string;
  first_at: string;
  last_at: string;
  event_count: number;
  status: string;
  kinds: string[];
  request_id: string | null;
  grant_id: string | null;
  run_id: string | null;
  client_id: string | null;
  provider_id: string | null;
  actor_type: string | null;
  actor_id: string | null;
  failure: FailureInfo | null;
};

export type GrantSummary = {
  object: 'grant_summary';
  grant_id: string;
  first_at: string;
  last_at: string;
  event_count: number;
  status: string;
  client_id: string | null;
  provider_id: string | null;
  connector_id: string | null;
  kinds: string[];
  failure: FailureInfo | null;
};

export type RunSummary = {
  object: 'run_summary';
  run_id: string;
  first_at: string;
  last_at: string;
  event_count: number;
  status: string;
  connector_id: string | null;
  provider_id: string | null;
  grant_id: string | null;
  failure_reason: string | null;
  kinds: string[];
};

class RefNotFoundError extends Error {
  readonly status = 404;
}

async function refFetch(path: string, params?: Record<string, string | number | undefined>) {
  const url = new URL(`${getAsUrl()}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), { cache: 'no-store' });
  } catch (err) {
    throw new ReferenceServerUnreachableError(
      `Cannot reach authorization server at ${getAsUrl()}`,
      err,
    );
  }
  if (res.status === 404) throw new RefNotFoundError(`not found: ${path}`);
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
    if (err instanceof RefNotFoundError) return null;
    throw err;
  }
}

export async function getGrantTimeline(grantId: string): Promise<TimelineEnvelope | null> {
  try {
    return normalizeTimeline(
      await refFetch(`/_ref/grants/${encodeURIComponent(grantId)}/timeline`),
    );
  } catch (err) {
    if (err instanceof RefNotFoundError) return null;
    throw err;
  }
}

export async function getRunTimeline(runId: string): Promise<TimelineEnvelope | null> {
  try {
    return normalizeTimeline(
      await refFetch(`/_ref/runs/${encodeURIComponent(runId)}/timeline`),
    );
  } catch (err) {
    if (err instanceof RefNotFoundError) return null;
    throw err;
  }
}

export type ListQuery = {
  limit?: number;
  cursor?: string;
  since?: string;
  until?: string;
  status?: string;
  client_id?: string;
  provider_id?: string;
  connector_id?: string;
  grant_id?: string;
  q?: string;
};

export async function listTraces(opts: ListQuery = {}): Promise<ListResponse<TraceSummary>> {
  return (await refFetch('/_ref/traces', opts as Record<string, string | number | undefined>)) as ListResponse<TraceSummary>;
}

export async function listGrants(opts: ListQuery = {}): Promise<ListResponse<GrantSummary>> {
  return (await refFetch('/_ref/grants', opts as Record<string, string | number | undefined>)) as ListResponse<GrantSummary>;
}

export async function listRuns(opts: ListQuery = {}): Promise<ListResponse<RunSummary>> {
  return (await refFetch('/_ref/runs', opts as Record<string, string | number | undefined>)) as ListResponse<RunSummary>;
}

export type DatasetConnectorSummary = {
  object: 'dataset_connector_summary';
  connector_id: string;
  record_count: number;
};

export type DatasetSummary = {
  object: 'dataset_summary';
  connector_count: number;
  stream_count: number;
  record_count: number;
  record_json_bytes: number;
  record_changes_json_bytes: number;
  blob_bytes: number;
  total_retained_bytes: number;
  /** Real-world earliest timestamp pulled from record data via each stream's manifest-declared `consent_time_field`. */
  earliest_record_time: string | null;
  /** Real-world latest timestamp pulled the same way. */
  latest_record_time: string | null;
  /** Substrate ingestion bounds (when the runtime wrote the row). Not the real age of the data. */
  earliest_ingested_at: string | null;
  latest_ingested_at: string | null;
  top_connectors: DatasetConnectorSummary[];
};

export async function getDatasetSummary(): Promise<DatasetSummary> {
  return (await refFetch('/_ref/dataset/summary')) as DatasetSummary;
}

export async function refSearch(query: string): Promise<{
  object: 'search_result';
  traces: TraceSummary[];
  grants: GrantSummary[];
  runs: RunSummary[];
  exact: { kind: 'trace' | 'grant' | 'run'; id: string } | null;
}> {
  return (await refFetch('/_ref/search', { q: query })) as {
    object: 'search_result';
    traces: TraceSummary[];
    grants: GrantSummary[];
    runs: RunSummary[];
    exact: { kind: 'trace' | 'grant' | 'run'; id: string } | null;
  };
}
