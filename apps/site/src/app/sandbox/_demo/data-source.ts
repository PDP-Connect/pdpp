// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** biome-ignore-all lint/suspicious/useAwait: DashboardDataSource methods return Promise<...>; sandbox is sync but the seam stays async-shaped. */
/**
 * Sandbox-bound implementation of the dashboard `DashboardDataSource` seam.
 *
 * Adapts the deterministic demo dataset (DEMO_*) and pure response builders
 * (`./builders.ts`) to the live-shaped types declared by `ref-client.ts` and
 * `rs-client.ts`. The adapter is read-only and credential-free: the same
 * dashboard feature components that bind to the live owner-authenticated
 * source can render against this one without any network or auth.
 *
 * Design notes:
 *   - Shapes here MUST match the live wire types exactly so the same view
 *     components render unchanged. When a sandbox concept has no live
 *     analogue (e.g. emitted_at on records), we synthesize a value from
 *     the seeded ingested_at so the view never branches on `kind`.
 *   - Mutation paths are intentionally absent: anything that would require
 *     calling the live AS/RS (sync now, device-flow approval, run
 *     interactions) is not part of this data source. The sandbox pages
 *     that consume it must not import the live action modules.
 *   - This file lives under `_demo/` so the live owner-console tree
 *     never resolves it through path-based discovery.
 */

import type { DashboardDataSource } from "@pdpp/operator-ui/lib/data-source";
import type {
  DeploymentDiagnostics,
  ExploreTimelinePage,
  ExploreTimelineRecord,
  ListQuery,
  ListResponse,
  DatasetSummary as LiveDatasetSummary,
  GrantSummary as LiveGrantSummary,
  RunSummary as LiveRunSummary,
  TraceSummary as LiveTraceSummary,
  PendingApproval,
  RefConnectorRunSummary,
  RefConnectorSummary,
  RefSchedule,
  SpineEvent,
  TimelineEnvelope,
} from "@pdpp/operator-ui/lib/ref-client";
import type {
  AggregateTimeBucket,
  ConnectorManifest,
  ConnectorOverview,
  ConnectorRunRef,
  ExploreRecordBucket,
  ExploreRecordBucketsResponse,
  RecordsPage,
  SearchResultHit,
  SearchResultPage,
  StreamMetadata,
  StreamRecord,
  StreamSummary,
  TimeBucketAggregate,
  TimeBucketGranularity,
} from "@pdpp/operator-ui/lib/rs-client";
import { executeRefDatasetSummary } from "pdpp-reference-implementation/operations/ref-dataset-summary";
import {
  buildGrantTimeline,
  buildRecordsList,
  buildRunTimeline,
  buildSearchResponse,
  buildTraceTimeline,
  getDemoConnectors,
  getDemoGrants,
  getDemoRuns,
  getDemoStreams,
  getDemoTraces,
} from "./builders.ts";
import { DEMO_CAPABILITIES, DEMO_RECORDS } from "./dataset.ts";
import { createSandboxRefDatasetSummaryDependencies } from "./operations-fixtures.ts";
import type { DemoRecord, DemoStreamDef, DemoTimelineEvent } from "./types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function streamRecords(streamKey: string): readonly DemoRecord[] {
  return DEMO_RECORDS.filter((r) => r.stream === streamKey);
}

function streamRecordCount(streamKey: string): number {
  return streamRecords(streamKey).length;
}

function latestRecordTimeForStream(streamKey: string): string | null {
  const sorted = [...streamRecords(streamKey)]
    .map((r) => r.record_time)
    .sort()
    .reverse();
  return sorted[0] ?? null;
}

function totalRecordsForConnector(connectorId: string): number {
  return DEMO_RECORDS.filter((r) => r.connector_id === connectorId).length;
}

function streamsForConnector(connectorId: string): DemoStreamDef[] {
  return getDemoStreams().filter((s) => s.connector_id === connectorId);
}

function connectorRecentRunIds(connectorId: string): string[] {
  return getDemoRuns()
    .filter((r) => r.connector_id === connectorId)
    .sort((a, b) => (a.first_at < b.first_at ? 1 : -1))
    .map((r) => r.run_id);
}

// ─── Connector summaries (records list) ───────────────────────────────────

function connectorRunRef(runId: string | undefined): ConnectorRunRef | null {
  if (!runId) {
    return null;
  }
  const run = getDemoRuns().find((r) => r.run_id === runId);
  if (!run) {
    return null;
  }
  return {
    event_count: run.events.length,
    failure_reason: run.failure_reason,
    first_at: run.first_at,
    known_gaps: [],
    last_at: run.last_at,
    run_id: run.run_id,
    status: run.status,
  };
}

function refConnectorRunSummary(runId: string | undefined): RefConnectorRunSummary | null {
  if (!runId) {
    return null;
  }
  const run = getDemoRuns().find((r) => r.run_id === runId);
  if (!run) {
    return null;
  }
  return {
    event_count: run.events.length,
    failure_reason: run.failure_reason,
    finished_at: run.finished_at,
    first_at: run.first_at,
    known_gaps: [],
    last_at: run.last_at,
    run_id: run.run_id,
    started_at: run.started_at,
    status: run.status,
  };
}

const SCHEDULE_INTERVAL: Record<string, number> = {
  daily: 86_400,
  manual: 86_400,
  weekly: 604_800,
};

function buildDemoSchedule(connectorId: string, kind: string): RefSchedule {
  const interval = SCHEDULE_INTERVAL[kind] ?? 86_400;
  const now = new Date().toISOString();
  return {
    active_run_id: null,
    automation_mode: kind === "manual" ? "manual_only" : "unattended",
    automation_summary:
      kind === "manual"
        ? "Starts only from an owner gesture."
        : "Can refresh in the background without expected owner action.",
    connector_id: connectorId,
    created_at: now,
    effective_mode: kind === "manual" ? "manual" : "automatic",
    enabled: kind !== "manual",
    human_attention_needed: false,
    ineligibility_reason: null,
    interval_seconds: interval,
    jitter_seconds: 0,
    last_error_code: null,
    last_finished_at: null,
    last_started_at: null,
    last_successful_at: null,
    minimum_interval_warning: null,
    next_due_at: null,
    notification_posture: "none",
    object: "schedule",
    recommended_policy: null,
    scheduler_backoff: null,
    trigger_kind: "scheduled",
    updated_at: now,
  };
}

function buildRefConnectorSummary(connectorId: string): RefConnectorSummary {
  const connector = getDemoConnectors().find((c) => c.connector_id === connectorId);
  const streams = streamsForConnector(connectorId);
  const runIds = connectorRecentRunIds(connectorId);
  const [lastRunId] = runIds;
  const lastSuccessId = getDemoRuns().find((r) => r.connector_id === connectorId && r.status === "succeeded")?.run_id;
  const lastRun = refConnectorRunSummary(lastRunId);
  const lastSuccessfulRun = refConnectorRunSummary(lastSuccessId);
  return {
    connection_health: {
      axes: {
        attention: "none",
        coverage: lastRun ? "complete" : "unknown",
        freshness: lastSuccessfulRun ? "fresh" : "unknown",
        outbox: "idle",
      },
      badges: { stale: false, syncing: false },
      last_success_at: lastSuccessfulRun?.last_at ?? null,
      next_action: null,
      next_attempt_at: null,
      reason_code: null,
      state: lastSuccessfulRun ? "healthy" : "idle",
      unknown_reasons: [],
    },
    connection_id: connectorId,
    connector_id: connectorId,
    display_name: connector?.display_name ?? connectorId,
    freshness: {},
    last_run: lastRun,
    last_successful_run: lastSuccessfulRun,
    manifest_version: "1.0.0-demo",
    next_action: null,
    schedule: connector?.schedule ? buildDemoSchedule(connectorId, connector.schedule) : null,
    streams: streams.map((s) => s.key),
    total_records: totalRecordsForConnector(connectorId),
  };
}

function buildConnectorManifest(connectorId: string): ConnectorManifest {
  const connector = getDemoConnectors().find((c) => c.connector_id === connectorId);
  const streams = streamsForConnector(connectorId);
  return {
    connector_id: connectorId,
    display_name: connector?.display_name ?? connectorId,
    name: connector?.display_name ?? connectorId,
    provider_id: connector?.provider_id,
    streams: streams.map((s) => ({
      consent_time_field: s.consent_time_field,
      name: s.key,
      preview_fields: s.fields.slice(0, 4).map((f) => f.name),
      // The demo fields carry a declared presentation type (timestamp,
      // currency_minor_units, …). Surface it on the JSON Schema extension
      // (`x_pdpp_type`) so the Explorer dispatches typed cards from a declared
      // type — the same `field_capabilities[].type` the live read contract
      // exposes — closing the live/sandbox asymmetry. The JSON Schema `type`
      // stays a string so field-name fallback readers are unaffected.
      schema: {
        properties: Object.fromEntries(
          s.fields.map((f) => [f.name, { type: f.type === "blob" ? "object" : "string", x_pdpp_type: f.type }])
        ),
      },
    })),
  };
}

// ─── Records / streams ────────────────────────────────────────────────────

function buildStreamSummary(streamKey: string): StreamSummary {
  const stream = getDemoStreams().find((s) => s.key === streamKey);
  return {
    last_updated: latestRecordTimeForStream(streamKey) ?? stream?.latest_record_time ?? null,
    name: streamKey,
    object: "stream",
    record_count: streamRecordCount(streamKey),
  };
}

function recordToStreamRecord(record: DemoRecord): StreamRecord {
  return {
    data: { ...record.fields },
    emitted_at: record.ingested_at,
    id: record.record_id,
    object: "record",
    stream: record.stream,
  };
}

function buildSandboxStreamMetadata(connectorId: string, streamKey: string): StreamMetadata {
  const stream = streamsForConnector(connectorId).find((s) => s.key === streamKey);
  if (!stream) {
    return { field_capabilities: {}, name: streamKey, object: "stream_metadata" };
  }
  return {
    field_capabilities: Object.fromEntries(
      stream.fields.map((field) => {
        // Deterministic projection fixture for Explorer honesty tests: the
        // sandbox still carries seeded owner data, but active metadata says the
        // visit summary is outside the active projection, so the Explorer must
        // render the field as withheld instead of showing the value.
        const granted = !(stream.key === "clinical_visits" && field.name === "summary");
        return [
          field.name,
          {
            granted,
            schema: { type: field.type === "blob" ? "object" : "string" },
            type: field.type,
            usable: granted,
          },
        ];
      })
    ),
    name: stream.key,
    object: "stream_metadata",
  };
}

function parseRecordWindowTime(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function sandboxWindowMeta(connectorId: string, streamKey: string): RecordsPage["meta"] {
  const stream = streamsForConnector(connectorId).find((s) => s.key === streamKey);
  if (!stream) {
    return;
  }
  const times = streamRecords(streamKey)
    .filter((record) => record.connector_id === connectorId)
    .map((record) => parseRecordWindowTime(record.fields[stream.consent_time_field]))
    .filter((value): value is string => value !== null)
    .sort();
  return {
    window: {
      earliest_at: times[0] ?? null,
      latest_at: times.at(-1) ?? null,
      total: streamRecords(streamKey).filter((record) => record.connector_id === connectorId).length,
    },
  };
}

// ─── Timeline / spine event mapping ───────────────────────────────────────

function actorFor(event: DemoTimelineEvent): { actor_type: string | null; actor_id: string | null } {
  if (event.run_id) {
    return { actor_id: deriveRunConnector(event.run_id) ?? "demo", actor_type: "runtime" };
  }
  if (event.client_id) {
    return { actor_id: event.client_id, actor_type: "client" };
  }
  return { actor_id: "demo-owner", actor_type: "owner" };
}

function deriveRunConnector(runId: string): string | null {
  return getDemoRuns().find((r) => r.run_id === runId)?.connector_id ?? null;
}

function streamForEvent(event: DemoTimelineEvent): string | null {
  const data = event.data ?? {};
  if (typeof (data as { stream?: unknown }).stream === "string") {
    return (data as { stream: string }).stream;
  }
  return null;
}

function eventToSpineEvent(event: DemoTimelineEvent): SpineEvent {
  const { actor_type, actor_id } = actorFor(event);
  return {
    actor_id,
    actor_type,
    client_id: event.client_id,
    data: { ...event.data },
    event_id: event.event_id,
    event_type: event.event_type,
    grant_id: event.grant_id,
    interaction_id: null,
    object_id: null,
    object_type: event.object_type,
    occurred_at: event.occurred_at,
    provider_id: null,
    recorded_at: event.occurred_at,
    request_id: null,
    run_id: event.run_id,
    scenario_id: null,
    status: event.status,
    stream_id: streamForEvent(event),
    subject_id: "demo-subject",
    subject_type: "owner",
    token_id: null,
    trace_id: event.trace_id,
    version: "1",
  };
}

function adaptTimeline(envelope: ReturnType<typeof buildGrantTimeline>): TimelineEnvelope | null {
  if (!envelope) {
    return null;
  }
  const events = envelope.events.map(eventToSpineEvent);
  return {
    event_count: events.length,
    events,
    object: envelope.object,
    trace_id: envelope.trace_id,
  };
}

// ─── Grants / runs / traces summaries ─────────────────────────────────────

function statusFilterMatches(target: string | undefined, value: string): boolean {
  return !target || target === value;
}

function paginate<T>(rows: readonly T[], opts: { limit?: number; cursor?: string } = {}): ListResponse<T> {
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? Math.min(opts.limit, 100) : 25;
  const start = opts.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0;
  const slice = rows.slice(start, start + limit);
  const next = start + limit;
  const hasMore = next < rows.length;
  return {
    data: slice as T[],
    has_more: hasMore,
    object: "list",
    ...(hasMore ? { next_cursor: String(next) } : {}),
  };
}

function adaptGrantSummary(g: ReturnType<typeof getDemoGrants>[number]): LiveGrantSummary {
  let failure: { event_type: string; reason: string | null } | null = null;
  if (g.status === "denied") {
    failure = { event_type: "consent.declined", reason: "owner_declined" };
  } else if (g.status === "revoked") {
    failure = { event_type: "grant.revoked", reason: "grant_revoked" };
  }
  return {
    client_id: g.client_id,
    connector_id: g.connector_id,
    event_count: g.events.length,
    failure,
    first_at: g.first_at,
    grant_id: g.grant_id,
    kinds: g.events.map((e) => e.event_type),
    last_at: g.last_at,
    object: "grant_summary",
    provider_id: null,
    status: g.status,
  };
}

function adaptRunSummary(r: ReturnType<typeof getDemoRuns>[number]): LiveRunSummary {
  return {
    connector_id: r.connector_id,
    event_count: r.events.length,
    failure_reason: r.failure_reason,
    first_at: r.first_at,
    grant_id: r.grant_id,
    kinds: r.events.map((e) => e.event_type),
    last_at: r.last_at,
    needs_input: r.needs_input,
    object: "run_summary",
    provider_id: null,
    run_id: r.run_id,
    status: r.status,
  };
}

function adaptTraceSummary(t: ReturnType<typeof getDemoTraces>[number]): LiveTraceSummary {
  return {
    actor_id: t.client_id ?? null,
    actor_type: t.client_id ? "client" : "runtime",
    client_id: t.client_id,
    event_count: t.kinds.length,
    failure: t.failure_reason ? { event_type: "trace", reason: t.failure_reason } : null,
    first_at: t.first_at,
    grant_id: t.grant_id,
    kinds: [...t.kinds],
    last_at: t.last_at,
    object: "trace_summary",
    provider_id: null,
    request_id: null,
    run_id: t.run_id,
    status: t.status,
    trace_id: t.trace_id,
  };
}

// ─── Search adaptation ────────────────────────────────────────────────────

function searchHitToLiveHit(hit: ReturnType<typeof buildSearchResponse>["data"][number]): SearchResultHit {
  return {
    connector_id: hit.connector_id,
    emitted_at: hit.emitted_at,
    matched_fields: hit.matched_fields,
    object: "search_result",
    record_key: hit.record_key,
    record_url: hit.record_url,
    snippet: hit.snippet,
    stream: hit.stream,
  };
}

// ─── Deployment diagnostics adaptation ────────────────────────────────────

function buildSandboxDeploymentDiagnostics(): DeploymentDiagnostics {
  const connectors = getDemoConnectors();
  const lexicalCapability = DEMO_CAPABILITIES.find((c) => c.capability === "lexical_search");
  const semanticCapability = DEMO_CAPABILITIES.find((c) => c.capability === "semantic_search");
  return {
    database: { path: "(sandbox: in-memory deterministic dataset)" },
    environment: [
      { name: "PDPP_REFERENCE_MODE", provenance: "present", secret: false, value: "sandbox" },
      { name: "PDPP_DB_PATH", provenance: "absent", secret: false, value: null },
      { name: "PDPP_ALLOW_MODEL_DOWNLOAD", provenance: "absent", secret: false, value: null },
    ],
    lexical: {
      index: {
        backfill_progress: null,
        state: "built",
      },
    },
    manifests: connectors.map((c) => ({
      connector_id: c.connector_id,
      display_name: c.display_name,
      provenance: c.provenance,
      semantic_stream_count: 0,
    })),
    runtime_capabilities: {
      accepted_collector_protocol_versions: ["1"],
      bindings: { browser: false, filesystem: false, local_device: false, network: true },
      collector_paired: false,
      collector_pairing: null,
      in_container: false,
    },
    semantic: {
      backend: {
        available: Boolean(semanticCapability?.implemented),
        configured: false,
        dimensions: null,
        distance_metric: null,
        download_allowed: null,
        dtype: null,
        language_bias: null,
        model: null,
        model_cache_path: null,
        model_cache_present: null,
        profile_id: null,
      },
      index: {
        backfill_progress: null,
        kind: null,
        state: null,
      },
      participation: {
        connector_count: 0,
        field_count: 0,
        stream_count: 0,
        tuples: [],
      },
    },
    warnings: [
      {
        code: "zero_participation",
        message: lexicalCapability
          ? "Sandbox deployment uses lexical search only; no semantic backend is configured."
          : "Sandbox deployment is read-only and uses deterministic mock data.",
      },
      {
        code: "backend_unavailable",
        message:
          "This is a mock reference deployment. Run the live reference server to demonstrate semantic retrieval, model caches, and real participation tuples.",
      },
    ],
  };
}

/**
 * UTC bucket key for a demo record's time, matching the over-time chart's
 * bucketing (UTC, the same zone the feed groups by). Day/week/month keyed by
 * `YYYY-MM-DD`; hour by `…THH:00`; null/unparseable → `__null__`.
 */
function sandboxBucketKey(recordTime: string, granularity: TimeBucketGranularity): string {
  const ms = Date.parse(recordTime);
  if (Number.isNaN(ms)) {
    return "__null__";
  }
  const d = new Date(ms);
  const iso = d.toISOString();
  switch (granularity) {
    case "minute":
      return iso.slice(0, 16);
    case "hour":
      return `${iso.slice(0, 13)}:00`;
    case "day":
      return iso.slice(0, 10);
    case "week": {
      const dow = d.getUTCDay();
      const offset = dow === 0 ? 6 : dow - 1;
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset));
      return monday.toISOString().slice(0, 10);
    }
    case "month":
      return `${iso.slice(0, 7)}-01`;
    case "quarter": {
      const month = d.getUTCMonth();
      const qStart = month - (month % 3);
      return `${d.getUTCFullYear()}-${String(qStart + 1).padStart(2, "0")}-01`;
    }
    case "year":
      return `${d.getUTCFullYear()}-01-01`;
    default:
      return iso.slice(0, 10);
  }
}

// ─── DashboardDataSource implementation ───────────────────────────────────

export const sandboxDashboardDataSource: DashboardDataSource = {
  async aggregateRecordsByTime(
    connectorId: string,
    stream: string,
    opts: {
      connectionId?: string | null;
      connectorInstanceId?: string | null;
      granularity: TimeBucketGranularity;
      groupByTime: string;
      timeZone?: string;
    }
  ): Promise<TimeBucketAggregate> {
    // Deterministic time-bucket COUNT over the demo corpus. Buckets the SAME
    // `record_time` the merged timeline orders by, in UTC (the chart's bucketing
    // zone), so the sandbox chart and feed agree. This is a true total over the
    // (fixed) demo set — the sandbox analogue of the live `window=exact` floor.
    const counts = new Map<string, number>();
    let filtered = 0;
    for (const r of DEMO_RECORDS) {
      if (r.connector_id !== connectorId || r.stream !== stream) {
        continue;
      }
      filtered += 1;
      const key = sandboxBucketKey(r.record_time, opts.granularity);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const groups: AggregateTimeBucket[] = [...counts.entries()]
      .map(([key, count]) => ({ count, key: key === "__null__" ? null : key }))
      .sort((a, b) => {
        if (a.key === null) {
          return b.key === null ? 0 : 1;
        }
        if (b.key === null) {
          return -1;
        }
        return a.key.localeCompare(b.key);
      });
    return {
      approximate: false,
      filtered_record_count: filtered,
      granularity: opts.granularity,
      group_by_time: opts.groupByTime,
      groups,
      metric: "count",
      object: "aggregation",
      stream,
      time_zone: opts.timeZone ?? "UTC",
    };
  },

  async getConnectorOverview(connector: ConnectorManifest): Promise<ConnectorOverview> {
    const streams = await this.listStreams(connector.connector_id);
    const lastRun = connectorRunRef(connectorRecentRunIds(connector.connector_id)[0]);
    const lastSuccessfulRunId = getDemoRuns().find(
      (r) => r.connector_id === connector.connector_id && r.status === "succeeded"
    )?.run_id;
    const lastSuccessfulRun = connectorRunRef(lastSuccessfulRunId);
    return {
      connector,
      isRunning: lastRun !== null && new Set(["started", "in_progress"]).has(lastRun.status),
      lastRun,
      lastSuccessfulRun,
      streams,
      totalRecords: streams.reduce((sum, s) => sum + (s.record_count ?? 0), 0),
    };
  },

  async getDatasetSummary(): Promise<LiveDatasetSummary> {
    // Mount the canonical `ref.dataset.summary` operation with sandbox
    // fixture dependencies so the dashboard data source returns the same
    // envelope the public `/sandbox/_ref/dataset/summary` route returns.
    // The operation owns envelope assembly (object, total_retained_bytes,
    // top-connector sort/limit/wrap, empty-corpus collapse, ingest-vs-
    // record-time distinction) — the previous local mapping silently drifted
    // (`record_json_bytes` was mapped from the demo `blob_bytes`, and the
    // `*_ingested_at` bounds were sourced from record-time fields rather
    // than the substrate's ingest-time bounds). Routing through the
    // operation removes that drift class for the dashboard surface.
    return await executeRefDatasetSummary(createSandboxRefDatasetSummaryDependencies());
  },

  async getDeploymentDiagnostics(): Promise<DeploymentDiagnostics> {
    return buildSandboxDeploymentDiagnostics();
  },

  async getGrantTimeline(grantId: string): Promise<TimelineEnvelope | null> {
    return adaptTimeline(buildGrantTimeline(grantId));
  },

  async getRecord(
    _connectorId: string,
    stream: string,
    recordId: string,
    _opts?: { connectorInstanceId?: string | null }
  ): Promise<StreamRecord> {
    const record = DEMO_RECORDS.find((r) => r.stream === stream && r.record_id === recordId);
    if (!record) {
      // Match the live RS error shape so the existing 404 detection works.
      throw new Error(`RS /v1/streams/${stream}/records/${recordId} failed (404): not found`);
    }
    return recordToStreamRecord(record);
  },

  async getRunTimeline(runId: string): Promise<TimelineEnvelope | null> {
    return adaptTimeline(buildRunTimeline(runId));
  },

  async getStreamMetadata(connectorId: string, stream: string): Promise<StreamMetadata> {
    return buildSandboxStreamMetadata(connectorId, stream);
  },

  async getTraceTimeline(traceId: string): Promise<TimelineEnvelope | null> {
    return adaptTimeline(buildTraceTimeline(traceId));
  },

  async isHybridRetrievalAdvertised(): Promise<boolean> {
    return false;
  },

  async isSemanticRetrievalAdvertised(): Promise<boolean> {
    return false;
  },
  kind: "sandbox",

  async listConnectorManifests(): Promise<ConnectorManifest[]> {
    return getDemoConnectors().map((c) => buildConnectorManifest(c.connector_id));
  },

  async listConnectorSummaries(): Promise<ListResponse<RefConnectorSummary>> {
    const connectors = getDemoConnectors();
    return {
      data: connectors.map((c) => buildRefConnectorSummary(c.connector_id)),
      has_more: false,
      object: "list",
    };
  },

  async listExploreRecordBuckets(opts: {
    connections?: readonly string[];
    streams?: readonly string[];
    excludeConnections?: readonly string[];
    excludeStreams?: readonly string[];
    since?: string | null;
    until?: string | null;
    granularity?: TimeBucketGranularity | "auto";
    timeZone?: string;
  }): Promise<ExploreRecordBucketsResponse> {
    // Deterministic single-call analogue of the live index-backed bucket
    // endpoint: dense UTC DAY buckets over the (fixed) demo corpus, scoped to the
    // SAME (connection, stream) structure the feed shows, with an EXACT
    // `extent.count` over the in-scope set. The sandbox has no future drift, so
    // this is a true total — the demo analogue of count == reachability.
    const connections = new Set(opts.connections ?? []);
    const streams = new Set(opts.streams ?? []);
    const excludeConnections = new Set(opts.excludeConnections ?? []);
    const excludeStreams = new Set(opts.excludeStreams ?? []);
    const inScope = DEMO_RECORDS.filter(
      (r) =>
        (connections.size === 0 || connections.has(r.connector_id)) &&
        (streams.size === 0 || streams.has(r.stream)) &&
        !excludeConnections.has(r.connector_id) &&
        !excludeStreams.has(r.stream)
    );

    // Per-day counts (UTC day-prefix), the chart's resting-view granularity.
    const dayCounts = new Map<string, number>();
    let minMs = Number.POSITIVE_INFINITY;
    let maxMs = Number.NEGATIVE_INFINITY;
    for (const r of inScope) {
      const ms = Date.parse(r.record_time);
      if (Number.isNaN(ms)) {
        continue;
      }
      minMs = Math.min(minMs, ms);
      maxMs = Math.max(maxMs, ms);
      const dayKey = new Date(ms).toISOString().slice(0, 10);
      dayCounts.set(dayKey, (dayCounts.get(dayKey) ?? 0) + 1);
    }

    // `minMs`/`maxMs` move together (set in the same loop step), so an unbounded
    // `minMs` means no in-scope record had a parseable time → an empty series.
    if (!Number.isFinite(minMs)) {
      return {
        buckets: [],
        extent: { count: 0, end: null, start: null },
        granularity: "day",
        object: "explore_record_buckets",
        time_zone: opts.timeZone ?? "UTC",
      };
    }

    // DENSE zero-filled day buckets across [floor(min day), floor(max day)].
    const MS_PER_DAY = 86_400_000;
    const floorDay = (ms: number): number => Date.parse(`${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`);
    const buckets: ExploreRecordBucket[] = [];
    for (let cursor = floorDay(minMs); cursor <= floorDay(maxMs); cursor += MS_PER_DAY) {
      const start = new Date(cursor).toISOString();
      const dayKey = start.slice(0, 10);
      buckets.push({
        count: dayCounts.get(dayKey) ?? 0,
        end: new Date(cursor + MS_PER_DAY).toISOString(),
        start,
      });
    }

    return {
      buckets,
      extent: {
        count: inScope.length,
        end: new Date(maxMs).toISOString(),
        start: new Date(minMs).toISOString(),
      },
      granularity: "day",
      object: "explore_record_buckets",
      time_zone: opts.timeZone ?? "UTC",
    };
  },

  async listExploreTimeline(
    opts: {
      connectionIds?: readonly string[];
      cursor?: string | null;
      limit?: number;
      rewindToFirstPage?: boolean;
      streams?: readonly string[];
      direction?: "asc" | "desc";
    } = {}
  ): Promise<ExploreTimelinePage> {
    // Merged cross-source timeline: every demo record, newest first (or oldest
    // first when direction="asc" — the order=oldest re-page), paged by a simple
    // offset cursor. The sandbox is a fixed snapshot so new_since_snapshot is
    // always 0 (no live ingestion behind the demo).
    const connectionIds = new Set(opts.connectionIds ?? []);
    const streams = new Set(opts.streams ?? []);
    const ascending = opts.direction === "asc";
    const merged: ExploreTimelineRecord[] = [...DEMO_RECORDS]
      .filter((r) => connectionIds.size === 0 || connectionIds.has(r.connector_id))
      .filter((r) => streams.size === 0 || streams.has(r.stream))
      .sort((a, b) =>
        ascending ? a.record_time.localeCompare(b.record_time) : b.record_time.localeCompare(a.record_time)
      )
      .map((r) => ({
        connector_id: r.connector_id,
        connector_instance_id: r.connector_id,
        data: r.fields,
        emitted_at: r.record_time,
        object: "timeline_record" as const,
        record_key: r.record_id,
        stream: r.stream,
      }));
    // REWIND: the demo has no snapshot drift (fixed corpus), so re-rendering page 1
    // means paginating from the start. Honor it by ignoring the cursor offset.
    const cursorForPage = opts.rewindToFirstPage ? undefined : (opts.cursor ?? undefined);
    const page = paginate(merged, { cursor: cursorForPage, limit: opts.limit });
    return {
      data: page.data,
      has_more: page.has_more,
      new_since_snapshot: 0,
      next_cursor: page.next_cursor ?? null,
      object: "list",
      snapshot_at: merged[0]?.emitted_at ?? new Date(0).toISOString(),
    };
  },

  async listGrants(opts: ListQuery = {}): Promise<ListResponse<LiveGrantSummary>> {
    const all = getDemoGrants()
      .filter((g) => statusFilterMatches(opts.status, g.status))
      .filter((g) => !opts.client_id || g.client_id === opts.client_id)
      .filter((g) => !opts.q || g.grant_id.toLowerCase().includes(opts.q.toLowerCase()))
      .map(adaptGrantSummary);
    return paginate(all, opts);
  },

  async listPendingApprovals(): Promise<ListResponse<PendingApproval>> {
    // The sandbox is read-only; there are never live device-flow or
    // consent approvals waiting for an owner. Always empty.
    return { data: [], has_more: false, object: "list" };
  },

  async listRuns(opts: ListQuery = {}): Promise<ListResponse<LiveRunSummary>> {
    const all = getDemoRuns()
      .filter((r) => statusFilterMatches(opts.status, r.status))
      .filter((r) => !opts.connector_id || r.connector_id === opts.connector_id)
      .filter((r) => !opts.q || r.run_id.toLowerCase().includes(opts.q.toLowerCase()))
      .map(adaptRunSummary);
    return paginate(all, opts);
  },

  async listStreams(connectorId: string): Promise<StreamSummary[]> {
    return streamsForConnector(connectorId).map((s) => buildStreamSummary(s.key));
  },

  async listTraces(opts: ListQuery = {}): Promise<ListResponse<LiveTraceSummary>> {
    const all = getDemoTraces()
      .filter((t) => statusFilterMatches(opts.status, t.status))
      .filter((t) => !opts.client_id || t.client_id === opts.client_id)
      .filter((t) => !opts.q || t.trace_id.toLowerCase().includes(opts.q.toLowerCase()))
      .map(adaptTraceSummary);
    return paginate(all, opts);
  },

  async queryRecords(
    connectorId: string,
    stream: string,
    opts: {
      connectorInstanceId?: string | null;
      cursor?: string;
      limit?: number;
      order?: "asc" | "desc";
      window?: "exact" | "none";
    } = {}
  ): Promise<RecordsPage> {
    const built = buildRecordsList({
      connector_id: connectorId,
      cursor: opts.cursor ?? null,
      limit: opts.limit ?? 50,
      stream,
    });
    if (!built) {
      return { data: [], has_more: false, object: "list" };
    }
    const records = built.data
      .map((summary) => DEMO_RECORDS.find((r) => r.record_id === summary.record_id))
      .filter((r): r is DemoRecord => Boolean(r))
      .map(recordToStreamRecord);
    return {
      data: records,
      has_more: built.has_more,
      object: "list",
      ...(opts.window === "exact" ? { meta: sandboxWindowMeta(connectorId, stream) } : {}),
      ...(built.next_cursor ? { next_cursor: built.next_cursor } : {}),
    };
  },

  async refSearch(query: string) {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return { exact: null, grants: [], object: "search_result", runs: [], traces: [] };
    }
    const grants = getDemoGrants()
      .filter((g) => g.grant_id.toLowerCase().includes(trimmed) || g.client_id.toLowerCase().includes(trimmed))
      .map(adaptGrantSummary);
    const runs = getDemoRuns()
      .filter((r) => r.run_id.toLowerCase().includes(trimmed) || r.connector_id.toLowerCase().includes(trimmed))
      .map(adaptRunSummary);
    const traces = getDemoTraces()
      .filter((t) => t.trace_id.toLowerCase().includes(trimmed))
      .map(adaptTraceSummary);
    let exact: { kind: "trace" | "grant" | "run"; id: string } | null = null;
    const exactGrant = getDemoGrants().find((g) => g.grant_id === query);
    if (exactGrant) {
      exact = { id: exactGrant.grant_id, kind: "grant" };
    }
    const exactRun = getDemoRuns().find((r) => r.run_id === query);
    if (exactRun) {
      exact = { id: exactRun.run_id, kind: "run" };
    }
    const exactTrace = getDemoTraces().find((t) => t.trace_id === query);
    if (exactTrace) {
      exact = { id: exactTrace.trace_id, kind: "trace" };
    }
    return { exact, grants, object: "search_result", runs, traces };
  },

  async searchRecordsHybrid(): Promise<SearchResultPage> {
    // Sandbox does not advertise hybrid retrieval. This method should never
    // be reached because isHybridRetrievalAdvertised() returns false.
    return { data: [], has_more: false, object: "list" };
  },

  async searchRecordsLexical(query: string, opts: { limit?: number; cursor?: string } = {}): Promise<SearchResultPage> {
    const built = buildSearchResponse(query);
    const start = opts.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0;
    const limit = typeof opts.limit === "number" && opts.limit > 0 ? Math.min(opts.limit, 100) : 25;
    const slice = built.data.slice(start, start + limit).map(searchHitToLiveHit);
    const next = start + limit;
    const hasMore = next < built.data.length;
    return {
      data: slice,
      has_more: hasMore,
      object: "list",
      ...(hasMore ? { next_cursor: String(next) } : {}),
    };
  },

  async searchRecordsSemantic(): Promise<SearchResultPage> {
    // The sandbox advertises lexical search only — semantic retrieval is
    // listed in capabilities as "implemented but not demonstrated in demo".
    // Returning an empty page keeps the dashboard search view's "blend"
    // logic intact without claiming semantic results.
    return { data: [], has_more: false, object: "list" };
  },
  supportsExploreTimelineDirection: async () => true,
};
