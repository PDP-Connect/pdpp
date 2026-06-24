/**
 * Typed data-source seam for the dashboard read surfaces.
 *
 * On the public site (`apps/site`) the only implementation that binds to
 * this interface is `sandboxDashboardDataSource` (under `/sandbox/_demo/`),
 * which adapts the deterministic mock dataset to the same shapes so the
 * shared dashboard feature views can render against fictional data without
 * any owner auth or live AS/RS reachability.
 *
 * The live, owner-token-authenticated implementation
 * (`liveDashboardDataSource`) lives with the operator console (`apps/console`)
 * along with the `/dashboard/**` route tree and the AS/RS clients it wraps.
 * It is intentionally absent here so the public bundle carries no owner-token
 * value-import and no live reference-server code path. This module therefore
 * contributes only the `DashboardDataSource` type to `apps/site`.
 *
 * The seam is read-only by design; mutation surfaces stay live-only.
 */

import type {
  DatasetSummary,
  DeploymentDiagnostics,
  ExploreTimelinePage,
  GrantSummary,
  ListQuery,
  ListResponse,
  PendingApproval,
  RefConnectorSummary,
  RunSummary,
  TimelineEnvelope,
  TraceSummary,
} from "./ref-client.ts";
import type {
  ConnectorManifest,
  ConnectorOverview,
  RecordsPage,
  SearchResultPage,
  StreamMetadata,
  StreamRecord,
  StreamSummary,
  TimeBucketAggregate,
  TimeBucketGranularity,
} from "./rs-client.ts";

export interface DashboardDataSource {
  /**
   * Time-bucket COUNT aggregate over one stream — the honest data source for
   * the over-time chart's bars (design over-time-chart §2). Returns TRUE
   * per-bucket totals over the filtered, grant-scoped corpus (NOT loaded
   * entries) via `GET /v1/streams/{stream}/aggregate`
   * (`metric=count`+`group_by_time`+`granularity`+`time_zone`). A stream whose
   * manifest does not declare a `group_by_time` time aggregate (or whose field
   * isn't granted) throws; the chart fan-in treats that as a partial source and
   * never fabricates a total.
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
  listConnectorSummaries(): Promise<ListResponse<RefConnectorSummary>>;
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
    /**
     * EXCLUDE scope ("is not" facet / `-con:`/`-stream:`). Applied SERVER-SIDE at
     * partition enumeration so excluded partitions are absent from the feed, the
     * Upcoming projection, the counts, and the cursor — counts stay exact (no
     * client-side shrinking). Re-passed on every page like the include scope.
     */
    excludeConnectionIds?: readonly string[];
    excludeStreams?: readonly string[];
    /**
     * Page the Upcoming (future) projection to exhaustion. When set, the request
     * returns ONLY the next page of future records (empty feed `data`) plus a
     * further `upcoming_next_cursor`. Carries the pinned snapshot + per-partition
     * positions, so it ignores `cursor`/`rewindToFirstPage`/scope (all implicit in
     * the upcoming cursor). count==reachability for "188 upcoming, all reachable".
     */
    upcomingCursor?: string | null;
    /**
     * Page-1 head size for the bounded Upcoming (future) set, independent of the
     * feed `limit` so the common-case future set is revealed on first expand.
     */
    upcomingLimit?: number;
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
