/**
 * Typed data-source seam for the dashboard read surfaces.
 *
 * Two implementations bind to this interface:
 *   - `liveDashboardDataSource` (this file) wraps the existing owner-token
 *     authenticated AS/RS clients. No behavior change vs. the previous
 *     direct calls — `/dashboard/**` still talks to the configured
 *     reference server through the same code paths.
 *   - `sandboxDashboardDataSource` (under `/sandbox/_demo/`) adapts the
 *     deterministic mock dataset to the same shapes so the same dashboard
 *     feature views can render against fictional data without any owner
 *     auth.
 *
 * The seam is intentionally read-only. Mutation surfaces (sync now,
 * device-flow approval, run interaction responses) stay live-only and
 * are wired directly in the live page wrappers — sandbox pages do not
 * import the live action modules.
 *
 * Server-only: do not import from client components.
 */

import {
  type DatasetSummary,
  type DeploymentDiagnostics,
  type ExploreTimelinePage,
  type GrantSummary,
  getDatasetSummary,
  getDeploymentDiagnostics,
  getGrantTimeline,
  getRunTimeline,
  getTraceTimeline,
  type ListQuery,
  type ListResponse,
  listConnectorSummaries,
  listExploreTimeline,
  listGrants,
  listPendingApprovals,
  listRuns,
  listTraces,
  type PendingApproval,
  type RefConnectorSummariesResponse,
  type RunSummary,
  refSearch,
  type TimelineEnvelope,
  type TraceSummary,
} from "./ref-client.ts";
import {
  aggregateRecordsByTime,
  type ConnectorManifest,
  type ConnectorOverview,
  getConnectorOverview,
  getRecord,
  getStreamMetadata,
  isHybridRetrievalAdvertised,
  isSemanticRetrievalAdvertised,
  listConnectorManifests,
  listStreams,
  queryRecords,
  type RecordsPage,
  type SearchResultPage,
  type StreamMetadata,
  type StreamRecord,
  type StreamSummary,
  searchRecordsHybrid,
  searchRecordsLexical,
  searchRecordsSemantic,
  type TimeBucketAggregate,
  type TimeBucketGranularity,
} from "./rs-client.ts";

export interface DashboardDataSource {
  /**
   * Time-bucket COUNT aggregate over one stream — the honest data source for the
   * over-time chart's bars. True per-bucket totals over the filtered, grant-scoped
   * corpus (NOT loaded entries).
   */
  aggregateRecordsByTime(
    connectorId: string,
    stream: string,
    opts: {
      connectionId?: string | null;
      connectorInstanceId?: string | null;
      granularity: TimeBucketGranularity;
      groupByTime: string;
      timeZone?: string;
    }
  ): Promise<TimeBucketAggregate>;
  getConnectorOverview(connector: ConnectorManifest): Promise<ConnectorOverview>;
  // ── Overview / deployment / approvals ──────────────────────────────────
  getDatasetSummary(): Promise<DatasetSummary>;
  getDeploymentDiagnostics(): Promise<DeploymentDiagnostics>;
  getGrantTimeline(grantId: string): Promise<TimelineEnvelope | null>;
  getRecord(
    connectorId: string,
    stream: string,
    recordId: string,
    opts?: { connectorInstanceId?: string | null }
  ): Promise<StreamRecord>;
  getRunTimeline(runId: string): Promise<TimelineEnvelope | null>;
  getStreamMetadata(
    connectorId: string,
    stream: string,
    opts?: { connectorInstanceId?: string | null }
  ): Promise<StreamMetadata>;
  getTraceTimeline(traceId: string): Promise<TimelineEnvelope | null>;
  isHybridRetrievalAdvertised(): Promise<boolean>;
  isSemanticRetrievalAdvertised(): Promise<boolean>;
  readonly kind: "live" | "sandbox";
  listConnectorManifests(): Promise<ConnectorManifest[]>;
  // ── Records ────────────────────────────────────────────────────────────
  listConnectorSummaries(): Promise<RefConnectorSummariesResponse>;
  // ── Explore merged timeline (Phase 3) ─────────────────────────────────
  listExploreTimeline(opts?: {
    connectionIds?: readonly string[];
    cursor?: string | null;
    limit?: number;
    /**
     * REWIND: re-render page 1 pinned to `cursor`'s ORIGINAL snapshot so an
     * after-snapshot backfill can never displace an original page-1 row. Only
     * meaningful with `cursor` set. Used by the "Load more" accumulator for page 1.
     */
    rewindToFirstPage?: boolean;
    streams?: readonly string[];
  }): Promise<ExploreTimelinePage>;
  // ── Grants / runs / traces / timelines ─────────────────────────────────
  listGrants(opts?: ListQuery): Promise<ListResponse<GrantSummary>>;
  listPendingApprovals(): Promise<ListResponse<PendingApproval>>;
  listRuns(opts?: ListQuery): Promise<ListResponse<RunSummary>>;
  listStreams(connectorId: string): Promise<StreamSummary[]>;
  listTraces(opts?: ListQuery): Promise<ListResponse<TraceSummary>>;
  queryRecords(
    connectorId: string,
    stream: string,
    opts?: {
      connectorInstanceId?: string | null;
      cursor?: string;
      count?: "estimated" | "exact" | "none";
      limit?: number;
      order?: "asc" | "desc";
      window?: "exact" | "none";
    }
  ): Promise<RecordsPage>;
  // ── Search ─────────────────────────────────────────────────────────────
  refSearch(query: string): Promise<{
    object: "search_result";
    traces: TraceSummary[];
    grants: GrantSummary[];
    runs: RunSummary[];
    exact: { kind: "trace" | "grant" | "run"; id: string } | null;
  }>;
  searchRecordsHybrid(query: string, opts?: { streams?: string[]; limit?: number }): Promise<SearchResultPage>;
  searchRecordsLexical(
    query: string,
    opts?: { streams?: string[]; limit?: number; cursor?: string; order?: "relevance" | "recent" }
  ): Promise<SearchResultPage>;
  searchRecordsSemantic(
    query: string,
    opts?: { streams?: string[]; limit?: number; cursor?: string }
  ): Promise<SearchResultPage>;
}

/**
 * Live data source. Plain pass-throughs to the existing owner-token
 * authenticated clients. There is intentionally no demo-mode flag here:
 * weakening this binding would weaken `/dashboard/**` owner gating.
 */
export const liveDashboardDataSource: DashboardDataSource = {
  kind: "live",
  listConnectorSummaries,
  listConnectorManifests,
  listStreams,
  getStreamMetadata,
  getConnectorOverview,
  aggregateRecordsByTime,
  queryRecords,
  getRecord,
  refSearch,
  searchRecordsLexical,
  searchRecordsSemantic,
  searchRecordsHybrid,
  isSemanticRetrievalAdvertised,
  isHybridRetrievalAdvertised,
  listExploreTimeline,
  listGrants,
  listRuns,
  listTraces,
  getGrantTimeline,
  getRunTimeline,
  getTraceTimeline,
  getDatasetSummary,
  listPendingApprovals,
  getDeploymentDiagnostics,
};
