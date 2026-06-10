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
} from "./rs-client.ts";

export interface DashboardDataSource {
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
    opts?: { streams?: string[]; limit?: number; cursor?: string }
  ): Promise<SearchResultPage>;
  searchRecordsSemantic(
    query: string,
    opts?: { streams?: string[]; limit?: number; cursor?: string }
  ): Promise<SearchResultPage>;
}
