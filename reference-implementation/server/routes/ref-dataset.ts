// HTTP adapter for the reference-only `/_ref/dataset/*` and
// `/_ref/records/version-stats` routes.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§2.3). Each `mount...`
// function registers one route at the same point in registration order
// where `server/index.js` previously registered it inline. Owner-session
// posture, query-string parsing, response envelopes, error handling,
// request-abort wiring, and the Postgres/SQLite backend bifurcation are
// unchanged.
//
// `buildDatasetSummaryDeps` and `buildRetainedSizeProjection` are moved
// here from the `buildAsApp` closure in `server/index.js` because all
// call sites are within this route family. All substrate reads they
// depend on flow in through `MountRefDatasetContext`.

import {
  executeRefDatasetSummary,
  type RefDatasetSummaryDependencies,
  type RefDatasetSummaryProjection,
  type RefDatasetSummaryProjectionMetadata,
  type RefDatasetSummaryProjectionState,
  type RefDatasetSummaryRebuildStatus,
} from "../../operations/ref-dataset-summary/index.ts";
import {
  executeRefDatasetSummaryStreams,
  type RefDatasetSummaryStreamRow,
} from "../../operations/ref-dataset-summary-streams/index.ts";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/ref-spine-timelines.ts`.

interface RouteRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

// Minimal substrate row shapes. Full Postgres/SQLite column sets have
// additional fields; these capture only what the route handlers reference.

interface RetainedSizeGlobalRow {
  readonly blob_bytes: number | string | null;
  readonly computed_at: string | null;
  readonly current_record_json_bytes: number | string | null;
  readonly dirty: boolean | number | null;
  readonly metadata?: {
    readonly state?: string | null;
    readonly stale_since?: string | null;
    readonly rebuild_status?: string | null;
    readonly last_error?: string | null;
    readonly source_high_watermark?: string | null;
  } | null;
  readonly record_count: number | string | null;
  readonly record_history_json_bytes: number | string | null;
}

interface RetainedSizeConnectionRow {
  readonly connector_id: string | null;
  readonly connector_instance_id: string | null;
  readonly record_count: number | string | null;
}

interface RetainedSizeStreamRow {
  readonly computed_at: string | null;
  readonly connector_id: string | null;
  readonly current_record_json_bytes: number | string | null;
  readonly dirty: boolean | number | null;
  readonly record_count: number | string | null;
  readonly stream: string | null;
}

interface RetainedSizeTopRow {
  readonly dirty?: boolean | number | null;
  readonly metadata?: unknown;
}

interface DatasetRecordsAggregate {
  readonly connector_count: number;
  readonly earliest_ingested_at: string | null;
  readonly latest_ingested_at: string | null;
  readonly record_count: number;
  readonly record_json_bytes: number;
  readonly stream_count: number;
}

const RETAINED_SIZE_AUTO_RECONCILE_FAILURE_COOLDOWN_MS = 30_000;

let retainedSizeAutoReconcileRetryAfterMs = 0;
let retainedSizeAutoReconcileNow = () => Date.now();

export function __resetRetainedSizeAutoReconcileThrottleForTest(): void {
  retainedSizeAutoReconcileRetryAfterMs = 0;
  retainedSizeAutoReconcileNow = () => Date.now();
}

export function __setRetainedSizeAutoReconcileNowForTest(now: () => number): void {
  retainedSizeAutoReconcileNow = now;
}

export interface MountRefDatasetContext {
  // record-version-stats.js
  buildRecordVersionStatsEnvelope(
    params: {
      connectorInstanceId: string | null;
      stream: string | null;
      risk: string | null;
      limit: unknown;
    },
    deps: { connectorInstanceStore: unknown }
  ): Promise<unknown>;
  createRequestAbortSignal(req: unknown, message: string): { signal: AbortSignal; cleanup(): void };
  createRequestConnectorInstanceStore(): unknown;
  getDatasetBlobBytes(): Promise<number>;
  getDatasetRecordChangesBytes(): Promise<number>;

  // records.js substrate reads
  getDatasetRecordsAggregate(): Promise<DatasetRecordsAggregate>;
  getDatasetRecordTimeBounds(): Promise<{ earliest: string | null; latest: string | null }>;

  // dataset-summary-read-model.js
  getDatasetSummaryProjection(): RefDatasetSummaryProjection;
  getDatasetSummaryStreamRecordTimeBounds(
    connectorId: string,
    stream: string,
    consentTimeField: unknown
  ): Promise<{ earliest: string | null; latest: string | null }>;

  // retained-size-read-model.js
  getRetainedSizeGlobal(): Promise<RetainedSizeGlobalRow>;
  handleError(res: unknown, err: unknown): void;

  isPostgresStorageBackend(): boolean;
  listDatasetSummaryStreamProjectionSeeds(): Promise<unknown>;
  listDatasetTopConnectorCandidates(): Promise<Array<{ connector_id: string; record_count: number }>>;
  listRetainedSizeConnections(options: { connectorInstanceId?: string }): Promise<RetainedSizeConnectionRow[]>;
  listRetainedSizeStreams(options: {
    connectorId?: string;
    connectorInstanceId?: string;
    stream?: string;
  }): Promise<RetainedSizeStreamRow[]>;
  listRetainedSizeTop(options: { scope: string; measure: string; limit?: unknown }): Promise<RetainedSizeTopRow[]>;
  listStreamProjections(options: { connectorId?: string | null }): Promise<RefDatasetSummaryStreamRow[]>;
  rebuildDatasetSummaryProjection(deps: unknown, options: { signal: AbortSignal }): Promise<unknown>;
  rebuildRetainedSize(): Promise<unknown>;
  reconcileDirtyDatasetSummaryRecordTimeBounds(
    deps: {
      getStreamRecordTimeBounds(
        connectorId: string,
        stream: string,
        consentTimeField: unknown
      ): Promise<{ earliest: string | null; latest: string | null }>;
    },
    options: { signal: AbortSignal }
  ): Promise<{ reconciled: number; deferred: number; residual: number }>;
  reconcileDirtyRetainedSize(): Promise<{ streams?: number } & Record<string, unknown>>;
  requireOwnerSession: MiddlewareHandler;
}

// Moved from the `buildAsApp` closure in `server/index.js`. Assembles the
// deps bag for `executeRefDatasetSummary`; all substrate reads flow through
// `ctx`. The `streamSeeds` flag forwards the optional
// `listStreamProjectionSeeds` dep used by the SQLite rebuild path.
function buildDatasetSummaryDeps(
  ctx: MountRefDatasetContext,
  aggregate: () => Promise<DatasetRecordsAggregate>,
  options: {
    projection?: (() => Promise<RefDatasetSummaryProjection | null>) | (() => RefDatasetSummaryProjection | null);
    streamSeeds?: boolean;
  } = {}
): RefDatasetSummaryDependencies & { listStreamProjectionSeeds?(): unknown } {
  // `exactOptionalPropertyTypes` forbids `getProjection: undefined` even in
  // an object literal — the optional property must be absent, not set to
  // `undefined`. Conditionally spread it only when provided.
  const baseDeps = {
    getCounts: async () => {
      const agg = await aggregate();
      return {
        connector_count: agg.connector_count,
        stream_count: agg.stream_count,
        record_count: agg.record_count,
      };
    },
    getRetainedBytes: async () => {
      const [agg, recordChangesJsonBytes, blobBytes] = await Promise.all([
        aggregate(),
        ctx.getDatasetRecordChangesBytes(),
        ctx.getDatasetBlobBytes(),
      ]);
      return {
        record_json_bytes: agg.record_json_bytes,
        record_changes_json_bytes: recordChangesJsonBytes,
        blob_bytes: blobBytes,
      };
    },
    getRecordTimeBounds: () => ctx.getDatasetRecordTimeBounds(),
    getIngestedTimeBounds: async () => {
      const agg = await aggregate();
      return {
        earliest: agg.earliest_ingested_at,
        latest: agg.latest_ingested_at,
      };
    },
    listTopConnectorCandidates: () => ctx.listDatasetTopConnectorCandidates(),
  };
  const deps: RefDatasetSummaryDependencies & { listStreamProjectionSeeds?(): unknown } =
    options.projection === undefined ? baseDeps : { ...baseDeps, getProjection: options.projection };
  if (options.streamSeeds === true) {
    deps.listStreamProjectionSeeds = () => ctx.listDatasetSummaryStreamProjectionSeeds();
  }
  return deps;
}

// Moved from the `buildAsApp` closure in `server/index.js`. Builds the
// Postgres-backed retained-size projection that `executeRefDatasetSummary`
// consumes when `isPostgresStorageBackend()` is true. All substrate reads
// flow through `ctx`.
async function buildRetainedSizeProjection(ctx: MountRefDatasetContext): Promise<RefDatasetSummaryProjection> {
  const [global, connections, streams] = await Promise.all([
    ctx.getRetainedSizeGlobal(),
    ctx.listRetainedSizeConnections({}),
    ctx.listRetainedSizeStreams({}),
  ]);
  const metadata: RefDatasetSummaryProjectionMetadata = {
    computed_at: global.computed_at,
    state: (global.metadata?.state || (global.dirty ? "stale" : "fresh")) as RefDatasetSummaryProjectionState,
    stale_since: global.metadata?.stale_since ?? null,
    rebuild_status: (global.metadata?.rebuild_status ?? "idle") as RefDatasetSummaryRebuildStatus,
    last_error: global.metadata?.last_error ?? null,
    source_high_watermark: global.metadata?.source_high_watermark ?? null,
  };
  return {
    counts: {
      connector_count: connections.length,
      stream_count: streams.length,
      record_count: Number(global.record_count ?? 0),
    },
    retained_bytes: {
      record_json_bytes: Number(global.current_record_json_bytes ?? 0),
      record_changes_json_bytes: Number(global.record_history_json_bytes ?? 0),
      blob_bytes: Number(global.blob_bytes ?? 0),
    },
    record_time_bounds: { earliest: null, latest: null },
    ingested_time_bounds: { earliest: null, latest: null },
    top_connector_candidates: [...connections]
      .sort((a, b) => {
        const byCount = Number(b.record_count ?? 0) - Number(a.record_count ?? 0);
        if (byCount !== 0) {
          return byCount;
        }
        return String(a.connector_instance_id ?? "").localeCompare(String(b.connector_instance_id ?? ""));
      })
      .slice(0, 8)
      .map((row) => ({
        connector_id: row.connector_id ?? "",
        record_count: Number(row.record_count ?? 0),
      })),
    metadata,
  };
}

function retainedProjectionNeedsReconcile(projection: RefDatasetSummaryProjection): boolean {
  const state = projection.metadata.state;
  return state === "stale" || state === "failed";
}

function retainedAutoReconcileInCooldown(): boolean {
  return retainedSizeAutoReconcileNow() < retainedSizeAutoReconcileRetryAfterMs;
}

function noteRetainedAutoReconcileFailure(): void {
  retainedSizeAutoReconcileRetryAfterMs =
    retainedSizeAutoReconcileNow() + RETAINED_SIZE_AUTO_RECONCILE_FAILURE_COOLDOWN_MS;
}

function noteRetainedAutoReconcileSuccess(): void {
  retainedSizeAutoReconcileRetryAfterMs = 0;
}

async function buildAutoReconciledRetainedSizeProjection(
  ctx: MountRefDatasetContext
): Promise<RefDatasetSummaryProjection> {
  const before = await buildRetainedSizeProjection(ctx);
  if (!retainedProjectionNeedsReconcile(before) || retainedAutoReconcileInCooldown()) {
    return before;
  }

  try {
    await ctx.reconcileDirtyRetainedSize();
    noteRetainedAutoReconcileSuccess();
    return await buildRetainedSizeProjection(ctx);
  } catch {
    noteRetainedAutoReconcileFailure();
    return before;
  }
}

export function mountRefDatasetSummary(app: AppLike, ctx: MountRefDatasetContext): void {
  app.get(
    "/_ref/dataset/summary",
    { contract: "refDatasetSummary" },
    ctx.requireOwnerSession,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        // Cache the records aggregate so `record_count` and `*_ingested_at`
        // come from the same SQL snapshot — the operation calls `getCounts`
        // and `getIngestedTimeBounds` independently, but the previous native
        // helper used one aggregate row for both.
        let cachedAggregate: DatasetRecordsAggregate | null = null;
        const aggregate = async () => {
          if (cachedAggregate === null) {
            cachedAggregate = await ctx.getDatasetRecordsAggregate();
          }
          return cachedAggregate;
        };
        const summary = await executeRefDatasetSummary(
          buildDatasetSummaryDeps(ctx, aggregate, {
            projection: ctx.isPostgresStorageBackend()
              ? () => buildAutoReconciledRetainedSizeProjection(ctx)
              : () => ctx.getDatasetSummaryProjection(),
          })
        );
        res.json(summary);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefDatasetSummaryStreams(app: AppLike, ctx: MountRefDatasetContext): void {
  app.get(
    "/_ref/dataset/summary/streams",
    { contract: "refDatasetSummaryStreams" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorIdFilter =
          typeof req.query?.connector_id === "string" && req.query.connector_id.trim()
            ? req.query.connector_id.trim()
            : null;
        const envelope = await executeRefDatasetSummaryStreams(
          { connector_id: connectorIdFilter },
          {
            listStreams: async ({ connectorId }) => {
              if (ctx.isPostgresStorageBackend()) {
                // `connector_id` is the public route filter — it MUST be
                // forwarded as `connectorId`, NOT `connectorInstanceId`.
                // The retained_size_stream Postgres table carries both
                // columns; we filter on `connector_id` to match the SQLite
                // `dataset_summary_stream_projection` filter semantics.
                const rows = await ctx.listRetainedSizeStreams(connectorId === null ? {} : { connectorId });
                return rows.map((row) => ({
                  connector_id: String(row.connector_id ?? ""),
                  stream: String(row.stream ?? ""),
                  record_count: Number(row.record_count ?? 0),
                  record_json_bytes: Number(row.current_record_json_bytes ?? 0),
                  earliest_ingested_at: null,
                  latest_ingested_at: null,
                  earliest_record_time: null,
                  latest_record_time: null,
                  consent_time_field: null,
                  dirty_record_time_bounds: Boolean(row.dirty),
                  computed_at: row.computed_at ?? null,
                }));
              }
              return ctx.listStreamProjections({ connectorId });
            },
            getProjectionMetadata: async () => {
              if (ctx.isPostgresStorageBackend()) {
                const global = await ctx.getRetainedSizeGlobal();
                return {
                  computed_at: global.computed_at ?? null,
                  state: (global.metadata?.state ||
                    (global.dirty ? "stale" : "fresh")) as RefDatasetSummaryProjectionState,
                  stale_since: global.metadata?.stale_since ?? null,
                  rebuild_status: (global.metadata?.rebuild_status ?? "idle") as RefDatasetSummaryRebuildStatus,
                  last_error: global.metadata?.last_error ?? null,
                  source_high_watermark: global.metadata?.source_high_watermark ?? null,
                };
              }
              return ctx.getDatasetSummaryProjection().metadata;
            },
          }
        );
        res.json(envelope);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefDatasetSummaryRebuild(app: AppLike, ctx: MountRefDatasetContext): void {
  app.post(
    "/_ref/dataset/summary/rebuild",
    { contract: "refDatasetSummaryRebuild" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const requestAbort = ctx.createRequestAbortSignal(req, "dataset summary rebuild request closed");
      try {
        let cachedAggregate: DatasetRecordsAggregate | null = null;
        const aggregate = async () => {
          if (cachedAggregate === null) {
            cachedAggregate = await ctx.getDatasetRecordsAggregate();
          }
          return cachedAggregate;
        };
        if (ctx.isPostgresStorageBackend()) {
          await ctx.rebuildRetainedSize();
          const summary = await executeRefDatasetSummary(
            buildDatasetSummaryDeps(ctx, aggregate, {
              projection: () => buildRetainedSizeProjection(ctx),
            })
          );
          res.json(summary);
          return;
        }
        const projection = await ctx.rebuildDatasetSummaryProjection(
          { ...buildDatasetSummaryDeps(ctx, aggregate, { streamSeeds: true }) },
          { signal: requestAbort.signal }
        );
        const summary = await executeRefDatasetSummary({
          getProjection: () => projection as RefDatasetSummaryProjection,
          getCounts: () => {
            throw new Error("dataset summary rebuild response must use projection");
          },
          getRetainedBytes: () => {
            throw new Error("dataset summary rebuild response must use projection");
          },
          getRecordTimeBounds: () => {
            throw new Error("dataset summary rebuild response must use projection");
          },
          getIngestedTimeBounds: () => {
            throw new Error("dataset summary rebuild response must use projection");
          },
          listTopConnectorCandidates: () => {
            throw new Error("dataset summary rebuild response must use projection");
          },
        });
        res.json(summary);
      } catch (err) {
        ctx.handleError(res, err);
      } finally {
        requestAbort.cleanup();
      }
    }
  );
}

export function mountRefDatasetSummaryReconcile(app: AppLike, ctx: MountRefDatasetContext): void {
  app.post(
    "/_ref/dataset/summary/reconcile",
    { contract: "refDatasetSummaryReconcile" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const requestAbort = ctx.createRequestAbortSignal(req, "dataset summary reconcile request closed");
      try {
        if (ctx.isPostgresStorageBackend()) {
          const result = await ctx.reconcileDirtyRetainedSize();
          const summary = await executeRefDatasetSummary(
            buildDatasetSummaryDeps(
              ctx,
              () => {
                throw new Error("dataset summary reconcile response must use retained-size projection");
              },
              { projection: () => buildRetainedSizeProjection(ctx) }
            )
          );
          res.json({
            object: "dataset_summary_reconcile",
            reconciled: result.streams ?? 0,
            deferred: 0,
            residual: 0,
            summary,
          });
          return;
        }
        const result = await ctx.reconcileDirtyDatasetSummaryRecordTimeBounds(
          {
            getStreamRecordTimeBounds: (connectorId, stream, consentTimeField) =>
              ctx.getDatasetSummaryStreamRecordTimeBounds(connectorId, stream, consentTimeField),
          },
          { signal: requestAbort.signal }
        );
        const summary = await executeRefDatasetSummary({
          getProjection: () => ctx.getDatasetSummaryProjection(),
          getCounts: () => {
            throw new Error("dataset summary reconcile response must use projection");
          },
          getRetainedBytes: () => {
            throw new Error("dataset summary reconcile response must use projection");
          },
          getRecordTimeBounds: () => {
            throw new Error("dataset summary reconcile response must use projection");
          },
          getIngestedTimeBounds: () => {
            throw new Error("dataset summary reconcile response must use projection");
          },
          listTopConnectorCandidates: () => {
            throw new Error("dataset summary reconcile response must use projection");
          },
        });
        res.json({
          object: "dataset_summary_reconcile",
          reconciled: result.reconciled,
          deferred: result.deferred,
          residual: result.residual,
          summary,
        });
      } catch (err) {
        ctx.handleError(res, err);
      } finally {
        requestAbort.cleanup();
      }
    }
  );
}

export function mountRefDatasetSize(app: AppLike, ctx: MountRefDatasetContext): void {
  app.get(
    "/_ref/dataset/size",
    { contract: "refDatasetSize" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const grain = typeof req.query.grain === "string" && req.query.grain ? req.query.grain : "global";
        if (!["global", "connection", "stream"].includes(grain)) {
          throw Object.assign(new Error(`unsupported retained-size grain '${grain}'`), {
            code: "invalid_request",
          });
        }
        const connectorInstanceId =
          typeof req.query.connector_instance_id === "string" ? req.query.connector_instance_id : undefined;
        const stream = typeof req.query.stream === "string" ? req.query.stream : undefined;
        let rows: unknown[];
        if (grain === "global") {
          rows = [await ctx.getRetainedSizeGlobal()];
        } else if (grain === "connection") {
          // exactOptionalPropertyTypes: only pass connectorInstanceId when defined
          rows = await ctx.listRetainedSizeConnections(
            connectorInstanceId === undefined ? {} : { connectorInstanceId }
          );
        } else {
          rows = await ctx.listRetainedSizeStreams({
            ...(connectorInstanceId !== undefined && { connectorInstanceId }),
            ...(stream !== undefined && { stream }),
          });
        }
        const global = await ctx.getRetainedSizeGlobal();
        res.json({
          object: "ref_dataset_size",
          grain,
          rows,
          projection: {
            computed_at: global.computed_at,
            dirty: global.dirty,
            metadata: global.metadata,
          },
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefDatasetTop(app: AppLike, ctx: MountRefDatasetContext): void {
  app.get(
    "/_ref/dataset/top",
    { contract: "refDatasetTop" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const scope = typeof req.query.scope === "string" && req.query.scope ? req.query.scope : "connection";
        const measure =
          typeof req.query.measure === "string" && req.query.measure ? req.query.measure : "total_retained_bytes";
        const rows = await ctx.listRetainedSizeTop({
          scope,
          measure,
          limit: req.query.limit,
        });
        const global = await ctx.getRetainedSizeGlobal();
        res.json({
          object: "ref_dataset_top",
          scope,
          measure,
          rows,
          projection: {
            computed_at: global.computed_at,
            dirty: Boolean(global.dirty ?? rows.some((row) => row.dirty)),
            metadata: rows[0]?.metadata ?? global.metadata,
          },
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefRecordsVersionStats(app: AppLike, ctx: MountRefDatasetContext): void {
  app.get(
    "/_ref/records/version-stats",
    { contract: "refRecordsVersionStats" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId =
          typeof req.query.connector_instance_id === "string" && req.query.connector_instance_id.trim()
            ? req.query.connector_instance_id.trim()
            : null;
        const stream = typeof req.query.stream === "string" && req.query.stream.trim() ? req.query.stream.trim() : null;
        const risk = typeof req.query.risk === "string" && req.query.risk.trim() ? req.query.risk.trim() : null;
        const envelope = await ctx.buildRecordVersionStatsEnvelope(
          { connectorInstanceId, stream, risk, limit: req.query.limit },
          { connectorInstanceStore: ctx.createRequestConnectorInstanceStore() }
        );
        res.json(envelope);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefDatasetSizeRebuild(app: AppLike, ctx: MountRefDatasetContext): void {
  app.post(
    "/_ref/dataset/size/rebuild",
    { contract: "refDatasetSizeRebuild" },
    ctx.requireOwnerSession,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        const projection = await ctx.rebuildRetainedSize();
        res.json({ object: "ref_dataset_size_rebuild", projection });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefDatasetSizeReconcile(app: AppLike, ctx: MountRefDatasetContext): void {
  app.post(
    "/_ref/dataset/size/reconcile",
    { contract: "refDatasetSizeReconcile" },
    ctx.requireOwnerSession,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        const result = await ctx.reconcileDirtyRetainedSize();
        const projection = await ctx.getRetainedSizeGlobal();
        res.json({
          object: "ref_dataset_size_reconcile",
          ...result,
          projection,
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}
