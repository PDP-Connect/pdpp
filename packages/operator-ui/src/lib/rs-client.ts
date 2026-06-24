/**
 * Type declarations for the Resource Server endpoints used by the dashboard.
 *
 * On the public site (`apps/site`) this module is a **types-only** declaration
 * surface: the shared dashboard feature components and the mock sandbox import
 * these shapes with `import type`, but the runtime client (the owner-token
 * authenticated `/v1/streams` fetchers and the stream-health aggregation) lives
 * with the operator console (`apps/console`), not here. Keeping this file
 * type-only guarantees the public bundle never value-imports
 * `owner-token`/`verify-session` and never reaches a live RS.
 */

import type { RefConnectionHealthSnapshot, RefLocalDeviceProgress, RefRetainedBytesBreakdown } from "./ref-client.ts";

export interface StreamSummary {
  last_updated: string | null;
  name: string;
  object: "stream";
  record_count: number;
}

export interface StreamRecord {
  data: Record<string, unknown>;
  emitted_at: string;
  id: string;
  object: "record";
  stream: string;
}

export interface RecordsWindowMeta {
  earliest_at: string | null;
  latest_at: string | null;
  total: number;
}

export interface RecordsCountMeta {
  kind: "estimated" | "exact" | "none";
  value?: number;
}

/**
 * One time bucket from the `group_by_time` aggregate. `key` is the ISO
 * bucket-start (`YYYY-MM-DD` for day/week/month, `…THH:MM` for hour) or null.
 * `count` is the TRUE total over the filtered, grant-scoped corpus.
 */
export interface AggregateTimeBucket {
  count: number;
  key: string | null;
}

/** Granularities the server's `group_by_time` aggregate accepts. */
export type TimeBucketGranularity = "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year";

/**
 * Response of the `group_by_time` count aggregate — the honest data source for
 * the over-time chart's bars (true per-bucket totals over the filtered corpus,
 * NOT loaded entries).
 */
export interface TimeBucketAggregate {
  approximate: boolean;
  filtered_record_count: number;
  granularity: string;
  group_by_time: string;
  groups: AggregateTimeBucket[];
  metric: "count";
  object: "aggregation";
  other_count?: number;
  stream: string;
  time_zone: string;
}

/**
 * One dense calendar bucket from `GET /_ref/explore/records/buckets`. Buckets are
 * zero-filled and contiguous across the data extent; `start`/`end` are ISO (UTC)
 * instants, `count` is the TRUE per-bucket total over the index-scoped set.
 */
export interface ExploreRecordBucket {
  count: number;
  end: string;
  start: string;
}

/**
 * Response of `GET /_ref/explore/records/buckets` — the single-call, index-backed
 * over-time bucket aggregate for the Explore chart (replaces the per-stream
 * `aggregateRecordsByTime` fan-out). `extent.count` is the EXACT reachable total
 * (count == reachability).
 */
export interface ExploreRecordBucketsResponse {
  buckets: ExploreRecordBucket[];
  extent: {
    count: number;
    end: string | null;
    start: string | null;
  };
  granularity: TimeBucketGranularity;
  object: "explore_record_buckets";
  time_zone: string;
}

export interface RecordsPage {
  data: StreamRecord[];
  has_more: boolean;
  meta?: {
    count?: RecordsCountMeta;
    window?: RecordsWindowMeta;
    [k: string]: unknown;
  };
  next_cursor?: string;
  object: "list";
}

export interface FieldCapability {
  granted?: boolean;
  schema?: Record<string, unknown>;
  type?: string;
  usable?: boolean;
  [k: string]: unknown;
}

export interface StreamMetadata {
  field_capabilities?: Record<string, FieldCapability>;
  name: string;
  object?: "stream_metadata" | string;
  [k: string]: unknown;
}

export interface ConnectorManifest {
  connector_id: string;
  // Canonical short key (e.g. "usaa", "claude-code"). Bundled manifests set
  // `connector_id` to the registry URI (https://registry.pdpp.org/connectors/usaa)
  // but `connector_key` to the plain key — and stored records carry the plain key.
  // Anything keying per-connector metadata against record rows must use this.
  connector_key?: string;
  display_name?: string;
  name?: string;
  provider_id?: string;
  streams?: Array<{ name: string; [k: string]: unknown }>;
}

/**
 * One result from the lexical retrieval extension's GET /v1/search.
 * Mirrors the public contract at:
 *   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
 *
 * `connector_id` is required on every result so owner-mode hydration knows
 * which per-connector scope to read under. `record_url` and `snippet` are
 * optional; the page must render correctly when they are absent.
 */
export interface SearchResultHit {
  // Optional connection identity on search hits. The current deployed RS
  // does not return these on `/v1/search*` responses, but the public
  // contract (and the `expose-connection-identity-on-public-read`
  // proposal) defines them as additive optional response fields, and the
  // response schema is `additionalProperties: true` — so a forward-
  // compatible client reads them when present rather than ignoring them.
  connection_id?: string;
  connector_id: string;
  connector_instance_id?: string;
  display_name?: string;
  emitted_at: string;
  matched_fields: string[];
  object: "search_result";
  record_key: string;
  record_url?: string;
  // Present on semantic and hybrid hits; absent on lexical hits.
  retrieval_mode?: "semantic" | "hybrid";
  // Present only on hybrid hits: which source(s) contributed this record.
  retrieval_sources?: ("lexical" | "semantic")[];
  snippet?: { field: string; text: string };
  stream: string;
}

/**
 * Recall accuracy of a lexical count, per the `disclose-lexical-recall-windows`
 * OpenSpec. `exact`: `count` is the true total. `lower_bound`: more matches may
 * exist beyond the ranked candidate window. `not_counted`: no count computed.
 */
export type SearchCountAccuracy = "exact" | "lower_bound" | "not_counted";

/**
 * Where the ranker drew its candidates from. `all_matches` ranked every match
 * (exhaustive recall); `candidate_window` ranked a bounded slice (recall is NOT
 * exhaustive — the result set is a bounded sample, never "all matching
 * records"). These are the exact values the reference server emits
 * (reference-implementation/server/search.js); do not rename without changing
 * the server, or the exhaustive gate silently never matches.
 */
export type SearchRankingScope = "all_matches" | "candidate_window" | "unknown";

/**
 * Response-level recall disclosure (see `disclose-lexical-recall-windows`). A
 * forward-compatible client reads it to decide whether a result set may honestly
 * claim exhaustive recall. Absent on older RS builds; treat absence as "recall
 * unknown" — never assume complete.
 */
export interface SearchRecallMeta {
  /** Bounded-window cap the ranker applied, when reported. */
  candidate_window_limit?: number;
  /** True ONLY when every match was ranked (all_matches). False = bounded window. */
  complete: boolean;
  /** How many candidates the ranker actually scored, when reported. */
  ranked_candidate_count?: number;
  ranking_scope: SearchRankingScope;
}

export interface SearchResultPage {
  /** Caller-visible match count; interpret via `count_accuracy`, never alone. */
  count?: number | null;
  /** Accuracy of `count` (exact / lower_bound / not_counted). */
  count_accuracy?: SearchCountAccuracy;
  data: SearchResultHit[];
  has_more: boolean;
  /** Response-level recall disclosure, nested under `meta` by some adapters. */
  meta?: { recall?: SearchRecallMeta };
  next_cursor?: string;
  object: "list";
  /** Response-level recall disclosure surfaced at the top level by some adapters. */
  recall?: SearchRecallMeta;
  url?: string;
}

export interface ConnectorOverview {
  connectionHealth?: RefConnectionHealthSnapshot;
  connectionId?: string;
  connector: ConnectorManifest;
  connectorDisplayName?: string;
  connectorInstanceId?: string;
  error?: string;
  /** Shortcut: true iff lastRun.status ∈ {started, in_progress}. */
  isRunning: boolean;
  /** Most recent run (any status). Drives the status chip + elapsed time. */
  lastRun: ConnectorRunRef | null;
  /** Most recent SUCCEEDED run. Drives the "last synced" timestamp + delta. */
  lastSuccessfulRun: ConnectorRunRef | null;
  /**
   * Push-mode (local-device exporter) durable progress for this connection.
   * Populated only when the reference server has a trusted device-side
   * heartbeat row scoped to this `connectorInstanceId`. The records page
   * uses this to render "last ingest" / "last checked" instead of
   * "no scheduler run yet".
   */
  localDeviceProgress?: RefLocalDeviceProgress | null;
  retainedBytes?: RefRetainedBytesBreakdown | null;
  streamCount?: number;
  streams: StreamSummary[];
  totalRecords: number;
  totalRetainedBytes?: number | null;
}

/** Thin projection of RunSummary fields the dashboard index needs.
 *  Keeps this module decoupled from ref-client (which is AS-scoped). */
export interface ConnectorRunRef {
  event_count: number;
  failure_reason: string | null;
  first_at: string;
  known_gaps?: unknown[];
  last_at: string;
  run_id: string;
  status: string;
}

export interface StreamManifest {
  name: string;
  preview_fields?: string[];
  [k: string]: unknown;
}

export interface FieldHealth {
  declared: boolean;
  distinctCapped: boolean;
  distinctValues: number; // capped; see DISTINCT_CAP
  name: string;
  nonNullCount: number;
  nullCount: number; // null / undefined / empty-string / []
  present: boolean; // appeared in at least one sampled record (non-missing key)
  sampleValue: string | null; // a short example non-null value, for context
}

export interface StreamHealth {
  connectorId: string;
  cursorField: string | null;
  cursorRange: { min: string | null; max: string | null } | null;
  emittedAt: { min: string | null; max: string | null };
  fields: FieldHealth[];
  limited: boolean; // totalRecords > sampled
  sampled: number;
  sampleLimit: number;
  streamName: string;
  summary: {
    declared: number;
    present: number;
    entirelyNull: number; // fields with nonNullCount === 0 (across sample)
    constValued: number; // fields with distinctValues === 1 and not all null
    declaredButAbsent: number; // manifest has it, data never emits it
    undeclaredPresent: number; // data has it, manifest doesn't declare it
  };
  totalRecords: number; // from RS metadata (not the sample)
}
