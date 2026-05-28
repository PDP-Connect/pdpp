/**
 * Canonical `rs.streams.aggregate` operation.
 *
 * Owns the AS/RS stream-aggregate request shaping, owner-branch manifest
 * visibility, and disclosure totals for `GET /v1/streams/:stream/aggregate`,
 * independent of HTTP framework, sandbox UI, concrete database driver, and
 * `process.env`. The native Fastify host adapter wires manifest, grant, and
 * storage-binding resolution; the operation owns the `query.received`
 * `stream_aggregate` data block, the owner-branch `not_found` mapping, and
 * the verbatim aggregate-result passthrough.
 *
 * Boundary rules (see openspec/changes/mount-rs-public-read-operations):
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the Fastify host module
 *   (`server/index.js`), the records module (`server/records.js`), or
 *   `process` / `process.env`.
 * - Validator and aggregate-execution capabilities flow in through
 *   dependencies. The host wires the concrete reads (e.g.
 *   `validateRequestedQueryFieldParams` and `aggregateRecords` from
 *   `server/records.js`).
 */

export interface StreamsAggregateSourceDescriptor {
  kind: "connector" | "provider_native";
  id: string;
  [extra: string]: unknown;
}

export type StreamsAggregateActor =
  | { kind: "owner"; subject_id: string | null }
  | {
      kind: "client";
      subject_id: string | null;
      client_id: string | null;
      grant_id: string | null;
    };

/**
 * Aggregate result shape, mirroring `aggregateRecords`'s output. The
 * operation does not constrain extra fields so host evolution of the result
 * shape stays additive without churning this module.
 */
export interface StreamsAggregateResult {
  readonly metric?: string | null;
  readonly field?: string | null;
  readonly group_by?: string | null;
  readonly filtered_record_count?: number | null;
  readonly groups?: readonly unknown[];
  readonly [extra: string]: unknown;
}

/**
 * Raw query parameters as received by the host. The operation forwards them
 * to the validator and aggregate dependencies unchanged.
 */
export type StreamsAggregateRequestParams = Record<string, unknown>;

export interface StreamsAggregateDependencies {
  /**
   * Source descriptor for instrumentation events. Hosts compute this once.
   */
  getSourceDescriptor(): StreamsAggregateSourceDescriptor | null;
  /**
   * Owner-branch manifest visibility. Returns true when the stream is
   * declared in the actor's manifest scope. Only consulted for owner actors;
   * client actors rely on the underlying `aggregate` capability to throw the
   * existing `not_found` / `grant_stream_not_allowed` errors.
   */
  hasManifestStream(streamName: string): boolean | Promise<boolean>;
  /**
   * Validate request params against the manifest stream. Hosts wire the
   * existing `validateRequestedQueryFieldParams` here. Throws on invalid
   * params; the operation does not re-derive the rule.
   */
  validateRequest(requestParams: StreamsAggregateRequestParams): void | Promise<void>;
  /**
   * Execute the aggregate against the resolved storage binding. Hosts wire
   * the existing `aggregateRecords` here with `(storageBinding, stream,
   * grant, requestParams, manifest)` already bound, exposing only
   * `(requestParams)` to the operation.
   */
  aggregate(requestParams: StreamsAggregateRequestParams): Promise<StreamsAggregateResult>;
}

export interface StreamsAggregateInput {
  actor: StreamsAggregateActor;
  /** Stream name from the request path. */
  streamName: string;
  /** Raw request query params. */
  requestParams: StreamsAggregateRequestParams;
}

export interface StreamsAggregateOutput {
  /** Aggregate result returned verbatim from the dependency. */
  result: StreamsAggregateResult;
  /** Echoed for instrumentation parity with the native route. */
  sourceDescriptor: StreamsAggregateSourceDescriptor | null;
  /**
   * `query.received`-shaped data block, populated from the request params
   * the same way the previous native route did.
   */
  queryData: {
    query_shape: "stream_aggregate";
    metric: string | null;
    field: string | null;
    group_by: string | null;
    group_by_time: string | null;
    granularity: string | null;
    limit: number | null;
  };
  /**
   * `disclosure.served`-shaped totals derived from the aggregate result.
   * Hosts merge these into the disclosure data block alongside the source
   * descriptor.
   */
  disclosureTotals: {
    metric: string | null;
    field: string | null;
    group_by: string | null;
    filtered_record_count: number | null;
    group_count: number | null;
  };
}

/**
 * Error thrown when the owner-branch manifest visibility check fails. The
 * `code` matches the existing native error code so the host adapter can emit
 * a route-compatible response without translation.
 */
export class StreamsAggregateVisibilityError extends Error {
  readonly code: "not_found";

  constructor(message: string) {
    super(message);
    this.name = "StreamsAggregateVisibilityError";
    this.code = "not_found";
  }
}

function readStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readLimitOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Execute the canonical `rs.streams.aggregate` operation.
 *
 * Visibility ordering matches the previous native route:
 *   1. owner actor with stream missing from manifest -> `not_found`
 *      (client actor branch defers to the `aggregate` dependency, which
 *      already throws `not_found` / `grant_stream_not_allowed`).
 *   2. validator runs against the resolved manifest stream.
 *   3. aggregate executes; result returned verbatim.
 */
export async function executeStreamsAggregate(
  input: StreamsAggregateInput,
  dependencies: StreamsAggregateDependencies,
): Promise<StreamsAggregateOutput> {
  const sourceDescriptor = dependencies.getSourceDescriptor();

  const queryData: StreamsAggregateOutput["queryData"] = {
    query_shape: "stream_aggregate",
    metric: readStringOrNull(input.requestParams.metric),
    field: readStringOrNull(input.requestParams.field),
    group_by: readStringOrNull(input.requestParams.group_by),
    group_by_time: readStringOrNull(input.requestParams.group_by_time),
    granularity: readStringOrNull(input.requestParams.granularity),
    limit: readLimitOrNull(input.requestParams.limit),
  };

  if (input.actor.kind === "owner") {
    const visible = await dependencies.hasManifestStream(input.streamName);
    if (!visible) {
      throw new StreamsAggregateVisibilityError(
        `Stream '${input.streamName}' not found`,
      );
    }
  }

  await dependencies.validateRequest(input.requestParams);

  const result = await dependencies.aggregate(input.requestParams);

  const disclosureTotals: StreamsAggregateOutput["disclosureTotals"] = {
    metric: typeof result.metric === "string" ? result.metric : (result.metric ?? null) as string | null,
    field: typeof result.field === "string" ? result.field : (result.field ?? null) as string | null,
    group_by: typeof result.group_by === "string" ? result.group_by : (result.group_by ?? null) as string | null,
    filtered_record_count:
      typeof result.filtered_record_count === "number"
        ? result.filtered_record_count
        : (result.filtered_record_count ?? null) as number | null,
    group_count: Array.isArray(result.groups) ? result.groups.length : null,
  };

  return {
    result,
    sourceDescriptor,
    queryData,
    disclosureTotals,
  };
}
