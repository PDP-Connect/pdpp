// HTTP adapter for the resource-server read/query route family under `/v1`.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§3). Each `mount...`
// function registers one route at the same point in registration order where
// `server/index.js` previously registered it inline. Auth posture
// (`requireToken`), request-id / trace-id wiring, source-descriptor / manifest
// / grant resolution, `query.received` and `disclosure.served` spine emission,
// content negotiation, response-envelope shape, status codes, and error->HTTP
// mapping are all unchanged.
//
// The canonical `rs.*` operations (see `operations/rs-connectors-list`,
// `rs-schema-get`, `rs-streams-list`, `rs-streams-detail`,
// `rs-streams-aggregate`, `rs-records-list`, `rs-records-detail`,
// `rs-blobs-read`) own the read semantics and envelope shapes. This adapter
// owns the HTTP wiring only: it MUST NOT recompute visibility rules, disclosure
// totals, or envelope shapes locally. Every host capability the routes touch is
// injected via `MountRsReadContext` so the adapter never reaches back into the
// `buildRsApp` closure or speaks SQL directly.
//
// The three search routes (`/v1/search`, `/v1/search/semantic`,
// `/v1/search/hybrid`) keep their registration-time gating exactly: lexical is
// always mounted; semantic/hybrid are only mounted when their backends are
// configured, evaluated against `ctx.getSemanticBackend()` and the `opts`
// feature flags at mount time, identical to the inline behaviour.

import {
  type BlobsReadDependencies,
  type BlobsReadInput,
  BlobsReadNotFoundError,
  executeBlobsRead,
} from "../../operations/rs-blobs-read/index.ts";
import {
  type ConnectorsListDependencies,
  type ConnectorsListInput,
  executeConnectorsList,
} from "../../operations/rs-connectors-list/index.ts";
import {
  executeRecordDetail,
  type RecordDetailDependencies,
  type RecordDetailInput,
  RecordDetailVisibilityError,
} from "../../operations/rs-records-detail/index.ts";
import {
  executeRecordsList,
  type RecordsListDependencies,
  type RecordsListInput,
  RecordsListVisibilityError,
} from "../../operations/rs-records-list/index.ts";
import {
  projectSchemaCompactView,
  projectSchemaStreamScope,
  schemaSourceOptions,
} from "../../operations/rs-schema-get/compact-view.ts";
import {
  executeSchemaGet,
  type SchemaGetDependencies,
  type SchemaGetInput,
} from "../../operations/rs-schema-get/index.ts";
import {
  executeStreamsAggregate,
  type StreamsAggregateDependencies,
  type StreamsAggregateInput,
  StreamsAggregateVisibilityError,
} from "../../operations/rs-streams-aggregate/index.ts";
import {
  executeStreamDetail,
  type StreamDetailDependencies,
  type StreamDetailInput,
  StreamDetailVisibilityError,
} from "../../operations/rs-streams-detail/index.ts";
import {
  executeStreamsList,
  type StreamsListDependencies,
  type StreamsListInput,
} from "../../operations/rs-streams-list/index.ts";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/ref-dataset.ts` / `ref-connectors.ts`.

interface RouteRequest {
  _pdpp_resolver_warnings?: ResolverWarning[] | undefined;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, string>>;
  readonly path: string;
  readonly query: Readonly<Record<string, unknown>>;
  // The host attaches `tokenInfo` during `requireToken`. Routes also stash
  // `_pdpp_resolver_warnings` on the request scope between resolution and
  // envelope assembly, mirroring the inline handlers.
  tokenInfo: TokenInfo;
}

interface RouteResponse {
  json(body: unknown): unknown;
  send(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

// Structural token shape. The host's `requireToken` middleware narrows the
// real object; these are the fields the read routes read.
interface TokenInfo {
  readonly client_id?: string | null;
  readonly grant?: GrantLike | null;
  readonly grant_id?: string | null;
  readonly pdpp_token_kind?: string | null;
  readonly subject_id?: string | null;
  readonly [key: string]: unknown;
}

interface GrantStreamLike {
  readonly name?: string | null;
  readonly [key: string]: unknown;
}

interface GrantLike {
  readonly streams?: GrantStreamLike[] | null;
  readonly [key: string]: unknown;
}

interface ManifestStreamLike {
  readonly name?: string | null;
  readonly [key: string]: unknown;
}

interface ManifestLike {
  readonly streams?: ManifestStreamLike[] | null;
  readonly [key: string]: unknown;
}

interface SourceDescriptorLike {
  readonly id?: string | null;
  readonly kind?: string | null;
  readonly [key: string]: unknown;
}

interface StorageBindingLike {
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  readonly [key: string]: unknown;
}

interface OwnerScopeLike {
  readonly source?: SourceDescriptorLike | null;
  readonly [key: string]: unknown;
}

interface ResolvedManifest {
  readonly manifest: ManifestLike;
  readonly source: SourceDescriptorLike;
  readonly storageBinding: StorageBindingLike;
  readonly [key: string]: unknown;
}

interface QueryActorContext {
  readonly actorId: string | null;
  readonly actorType: string;
  readonly scenarioId: string | null;
  readonly traceId: string | null;
}

interface ResolverWarning {
  readonly code?: string;
  readonly [key: string]: unknown;
}

interface ReadRequestBinding {
  readonly connectorId?: string | null;
  readonly connectorInstanceId?: string | null;
  readonly displayName?: string | null;
  readonly [key: string]: unknown;
}

interface ReadRequestBindingsResult {
  readonly bindings: ReadRequestBinding[];
  readonly requestConnectionId?: string | null;
  readonly warnings?: ResolverWarning[];
  readonly [key: string]: unknown;
}

interface NativeManifest {
  readonly provider_id?: string | null;
  readonly storage_binding?: { connector_id?: string | null } | null;
  readonly [key: string]: unknown;
}

interface BlobBindingRow {
  readonly connector_id: string | null;
  readonly connector_instance_id: string | null;
  readonly record_key: string;
  readonly stream: string;
  readonly [key: string]: unknown;
}

interface BlobRow {
  readonly [key: string]: unknown;
}

interface BlobStoreLike {
  listBlobBindings(blobId: string): Promise<BlobBindingRow[]>;
  loadContentAddressedBlob(blobId: string): Promise<BlobRow | null>;
}

interface AmbiguousConnectionErrorCtor {
  new (message: string, candidates: unknown[]): Error;
}

// The query-context object threaded through `emitQueryReceived` / `rejectQuery`.
// It is built and mutated by the handlers exactly as the inline code did;
// modeled as a permissive record so the adapter does not re-document the
// instrumentation contract.
type QueryContext = Record<string, unknown> & {
  sourceDescriptor: SourceDescriptorLike | null;
  queryData: Record<string, unknown>;
};

// Every host capability the read routes touch. These are all defined or
// imported in `server/index.js` (and are not exported there), so they are
// injected rather than imported. Signatures mirror the inline call sites; the
// permissive `unknown` returns keep the adapter from re-stating each helper's
// internal shape while still type-checking the wiring.
export interface MountRsReadContext {
  AmbiguousConnectionError: AmbiguousConnectionErrorCtor;
  aggregateRecordsAcrossBindings(
    bindings: ReadRequestBinding[],
    stream: string,
    grant: GrantLike | null,
    params: Record<string, unknown>,
    manifest: ManifestLike,
    options: { extraWarnings: ResolverWarning[] }
  ): Promise<unknown>;
  buildClientSourceDescriptor(tokenInfo: TokenInfo): SourceDescriptorLike | null;
  buildConnectorAwareFreshness(evidence: unknown, recordLastUpdatedAt?: string | null): unknown;

  // discovery / metadata / freshness builders
  buildConnectorDiscoveryItem(args: {
    source: SourceDescriptorLike | null;
    storageBinding: StorageBindingLike;
    manifest: ManifestLike;
    grant?: GrantLike | null | undefined;
  }): Promise<unknown>;
  buildConnectorSchemaItem(args: {
    source: SourceDescriptorLike | null;
    storageBinding: StorageBindingLike;
    manifest: ManifestLike;
    grant?: GrantLike | null | undefined;
    ownerSubjectId?: string | null | undefined;
  }): Promise<unknown>;
  buildOwnerQuerySourceDescriptor(req: unknown, opts: unknown): SourceDescriptorLike | null;
  buildOwnerReadGrant(streamName: string): GrantLike;
  buildQueryActorContext(tokenInfo: TokenInfo): QueryActorContext;
  buildSourceDescriptor(sourceBinding: unknown): SourceDescriptorLike;
  buildStreamMetadataEntry(args: {
    manifestStream: ManifestStreamLike | undefined;
    streamGrant: GrantStreamLike | null | undefined;
    grantStreams: GrantStreamLike[];
    freshness: unknown;
    manifestStreamNames?: Set<string> | null;
  }): unknown;
  canonicalConnectorKey(connectorId: string): string | null;

  // blob read
  createBlobStore(): BlobStoreLike;
  decorateRecordBlobRefs(record: unknown): unknown;
  emitQueryReceived(context: QueryContext, req: unknown): Promise<void>;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;

  // request/response + instrumentation helpers
  ensureRequestId(res: unknown): string;
  finalizeCanonicalEnvelope(payload: unknown, req: unknown): unknown;
  getConnectorFreshnessEvidence(args: {
    source: SourceDescriptorLike | null;
    manifest: ManifestLike;
  }): Promise<unknown>;
  getOwnerTokenSubjectId(req: unknown): string | null;
  getRecord(
    storageTarget: StorageBindingLike,
    stream: string,
    recordKey: string,
    grant: GrantLike | null,
    manifest: ManifestLike
  ): Promise<{ data?: { blob_ref?: { blob_id?: string } } } | null>;
  getRecordAcrossBindings(
    bindings: ReadRequestBinding[],
    stream: string,
    recordId: string,
    grant: GrantLike | null,
    manifest: ManifestLike,
    params: Record<string, unknown>,
    options: { extraWarnings: ResolverWarning[] }
  ): Promise<unknown>;
  getSemanticBackend(): { available(): boolean } | null;
  getVisibleStreamFreshness(args: {
    tokenInfo: TokenInfo;
    source: SourceDescriptorLike | null;
    storageBinding: StorageBindingLike;
    stream: string;
    manifest: ManifestLike;
  }): Promise<unknown>;
  handleError(res: unknown, err: unknown): void;

  // records.js substrate reads
  listAllStreams(storageBinding: StorageBindingLike): Promise<unknown[]>;
  listRegisteredConnectorIds(): Promise<string[]>;
  listStreamsAcrossBindings(
    bindings: ReadRequestBinding[],
    grant: GrantLike | null,
    manifest: ManifestLike,
    options: { resolveBindingsForStream: (streamGrant: GrantStreamLike) => Promise<ReadRequestBinding[]> }
  ): Promise<Record<string, unknown>[]>;
  readonly opts: Readonly<Record<string, unknown>>;
  ownerSubjectIdForBindings(tokenInfo: TokenInfo): string | null;
  projectBindingForWire(args: {
    connectorInstanceId: string | null;
    connectorId: string | null;
    displayName: string | null;
  }): unknown;
  queryRecordsAcrossBindings(
    bindings: ReadRequestBinding[],
    stream: string,
    grant: GrantLike | null,
    params: Record<string, unknown>,
    manifest: ManifestLike,
    options: { extraWarnings: ResolverWarning[] }
  ): Promise<unknown>;
  rejectQuery(res: unknown, req: unknown, context: QueryContext, err: unknown, param?: string | null): Promise<unknown>;
  readonly requireToken: MiddlewareHandler;
  resolveGrantManifest(tokenInfo: TokenInfo, opts: unknown): Promise<ResolvedManifest>;

  // manifest / grant / scope resolution
  resolveNativeManifest(opts: unknown): NativeManifest | null;
  resolveNativeStorageBinding(opts: unknown): StorageBindingLike | null;
  resolveOwnerManifest(req: unknown, opts: unknown): Promise<ResolvedManifest>;
  resolveOwnerManifestFromScope(ownerScope: unknown, opts: unknown): Promise<ResolvedManifest>;
  resolveOwnerReadScope(req: unknown, opts: unknown): Promise<OwnerScopeLike>;
  resolveReadRequestBindings(args: {
    ownerSubjectId: string | null;
    storageBinding: StorageBindingLike;
    grant: GrantLike | null;
    requestParams: Record<string, unknown>;
    streamName: string | null;
    nativeProviderStorage: boolean;
  }): Promise<ReadRequestBindingsResult>;
  resolveRegisteredConnectorManifest(connectorId: string): Promise<ManifestLike>;
  runHybridSearch(args: Record<string, unknown>): Promise<{ envelope: unknown; disclosureData: unknown }>;

  // search surfaces
  runLexicalSearch(args: Record<string, unknown>): Promise<{ envelope: unknown; disclosureData: unknown }>;
  runSemanticSearch(args: Record<string, unknown>): Promise<{ envelope: unknown; disclosureData: unknown }>;
  setReferenceTraceId(res: unknown, traceId: string | null): void;
  validateRequestedQueryFieldParams(
    requestParams: Record<string, unknown>,
    manifestStream: ManifestStreamLike | undefined
  ): void;
}

function authorizationTokenId(req: RouteRequest): string | null {
  const auth = req.headers.authorization;
  return typeof auth === "string" ? auth.slice(7) : null;
}

// Resolve the request-time `connection_id`, honoring the deprecated
// `connector_instance_id` alias. Mirrors the inline precedence the
// `/v1/streams` handler used: explicit `connection_id` wins, then the
// alias, then null.
function resolveRequestConnectionId(query: Readonly<Record<string, unknown>>): string | null {
  if (typeof query?.connection_id === "string" && query.connection_id) {
    return query.connection_id;
  }
  if (typeof query?.connector_instance_id === "string" && query.connector_instance_id) {
    return query.connector_instance_id;
  }
  return null;
}

function sourceIdentityValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function withRecordSourceIdentity(
  record: unknown,
  refs: {
    sourceDescriptor: SourceDescriptorLike | null;
    storageBinding: StorageBindingLike | null;
    requestConnectionId: string | null;
  }
): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const connectorKey = sourceIdentityValue(refs.sourceDescriptor?.id, refs.storageBinding?.connector_id);
  const connectionId = sourceIdentityValue(refs.requestConnectionId, refs.storageBinding?.connector_instance_id);
  return {
    ...(connectorKey ? { connector_key: connectorKey } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
    ...(record as Record<string, unknown>),
  };
}

interface ReadScope {
  manifest: ManifestLike;
  sourceDescriptor: SourceDescriptorLike | null;
  storageBinding: StorageBindingLike;
}

// Map an operation's `*VisibilityError` to a `rejectQuery` response. The
// operation runs; if it throws a visibility error matching `errorType`, the
// route emits the canonical rejected-query response and the returned `rejected`
// flag tells the handler to stop. Any other error rethrows. Mirrors the inline
// `try { ... } catch (e) { if (e instanceof XVisibilityError) return rejectQuery(...) ; throw e }`.
async function runWithVisibilityRejection<T>(
  run: () => Promise<T>,
  errorType: new (...errArgs: never[]) => Error,
  reject: (err: Error & { code?: string }) => Promise<unknown>
): Promise<{ rejected: true } | { rejected: false; result: T }> {
  try {
    return { rejected: false, result: await run() };
  } catch (err) {
    if (err instanceof errorType) {
      const mapped = new Error((err as Error).message) as Error & { code?: string };
      const code = (err as Error & { code?: string }).code;
      if (code !== undefined) {
        mapped.code = code;
      }
      await reject(mapped);
      return { rejected: true };
    }
    throw err;
  }
}

// Build the `stream_aggregate` `query.received` data block from the raw query
// params. Behaviour-identical to the inline literal.
function buildAggregateQueryEventData(requestParams: Record<string, unknown>): Record<string, unknown> {
  const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    query_shape: "stream_aggregate",
    metric: stringOrNull(requestParams.metric),
    field: stringOrNull(requestParams.field),
    group_by: stringOrNull(requestParams.group_by),
    group_by_time: stringOrNull(requestParams.group_by_time),
    granularity: stringOrNull(requestParams.granularity),
    limit: requestParams.limit ? Number(requestParams.limit) : null,
  };
}

// Owner/client source + manifest + storage-binding resolution shared by the
// stream-detail, aggregate, records-list, record-detail, and blob-read routes.
// Sets `queryContext.sourceDescriptor` as a side effect (matching the inline
// handlers, which set it before any manifest work so malformed-connector
// failures stay attributable in `query.received` / `query.rejected`) and
// returns the resolved trio. Behaviour-identical to the previous inline
// branches.
async function resolveReadScope(
  ctx: MountRsReadContext,
  req: RouteRequest,
  tokenInfo: TokenInfo,
  queryContext: QueryContext
): Promise<ReadScope> {
  if (tokenInfo.pdpp_token_kind === "owner") {
    const ownerScope = await ctx.resolveOwnerReadScope(req, ctx.opts);
    const sourceDescriptor = ctx.buildSourceDescriptor(ownerScope.source);
    queryContext.sourceDescriptor = sourceDescriptor;
    const ownerResolved = await ctx.resolveOwnerManifestFromScope(ownerScope, ctx.opts);
    return { sourceDescriptor, storageBinding: ownerResolved.storageBinding, manifest: ownerResolved.manifest };
  }
  const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
  queryContext.sourceDescriptor = grantResolved.source;
  return {
    sourceDescriptor: grantResolved.source,
    storageBinding: grantResolved.storageBinding,
    manifest: grantResolved.manifest,
  };
}

// Shared `disclosure.served` spine emission. Owns the common event scaffold
// (actor / subject / object / token coordinates) so each route handler only
// supplies the per-query fields. Behaviour-identical to the inline
// `ctx.emitSpineEvent({ event_type: "disclosure.served", ... })` calls.
function emitDisclosureServed(
  ctx: MountRsReadContext,
  args: {
    req: RouteRequest;
    tokenInfo: TokenInfo;
    actorType: string;
    actorId: string | null;
    traceId: string | null;
    scenarioId: string | null;
    queryId: string;
    streamId?: string | null;
    data: Record<string, unknown>;
  }
): Promise<unknown> {
  const { tokenInfo } = args;
  const event: Record<string, unknown> = {
    event_type: "disclosure.served",
    trace_id: args.traceId,
    scenario_id: args.scenarioId,
    actor_type: args.actorType,
    actor_id: args.actorId,
    subject_type: "subject",
    subject_id: tokenInfo.subject_id || null,
    object_type: "query",
    object_id: args.queryId,
    status: "succeeded",
    grant_id: tokenInfo.grant_id || null,
    client_id: tokenInfo.client_id || null,
    token_id: authorizationTokenId(args.req),
    data: args.data,
  };
  if (args.streamId !== undefined) {
    event.stream_id = args.streamId;
  }
  return ctx.emitSpineEvent(event);
}

// Fold resolver-level warnings into a list body's `meta.warnings[]`, preserving
// any pre-existing meta/warnings. Behaviour-identical to the inline merge the
// `/v1/streams` handler used.
function mergeResolverWarningsIntoBody(body: Record<string, unknown>, resolverWarnings: unknown): void {
  if (!(Array.isArray(resolverWarnings) && resolverWarnings.length)) {
    return;
  }
  const existingMeta =
    body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
      ? (body.meta as Record<string, unknown>)
      : null;
  const existingWarnings = existingMeta && Array.isArray(existingMeta.warnings) ? existingMeta.warnings : [];
  body.meta = {
    ...(existingMeta || {}),
    warnings: [...existingWarnings, ...resolverWarnings],
  };
}

// The owner/client actor block shared by the record-reading routes.
function buildReadActor(tokenInfo: TokenInfo): Record<string, unknown> {
  return tokenInfo.pdpp_token_kind === "owner"
    ? { kind: "owner", subject_id: tokenInfo.subject_id || null }
    : {
        kind: "client",
        subject_id: tokenInfo.subject_id || null,
        client_id: tokenInfo.client_id || null,
        grant_id: tokenInfo.grant_id || null,
      };
}

// GET /v1/connectors — bearer-scoped connector/source discovery
export function mountRsConnectors(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/connectors",
    { contract: "listConnectors" },
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor:
            tokenInfo.pdpp_token_kind === "owner"
              ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
              : ctx.buildClientSourceDescriptor(tokenInfo),
          queryData: { query_shape: "connector_list" },
        };

        let operationInput: Record<string, unknown>;
        let dependencies: Record<string, unknown>;
        if (tokenInfo.pdpp_token_kind === "owner") {
          operationInput = {
            actor: { kind: "owner", subject_id: tokenInfo.subject_id || null },
          };
          const nativeManifest = ctx.resolveNativeManifest(ctx.opts);
          const nativeStorageBinding = ctx.resolveNativeStorageBinding(ctx.opts);
          if (nativeManifest && nativeStorageBinding) {
            const source = ctx.buildSourceDescriptor({
              kind: "provider_native",
              id: nativeManifest.provider_id,
            });
            queryContext.sourceDescriptor = source;
            dependencies = {
              getSourceDescriptor: () => source,
              listConnectorItems: async () => {
                const item = await ctx.buildConnectorDiscoveryItem({
                  source,
                  storageBinding: nativeStorageBinding,
                  manifest: nativeManifest,
                });
                return [item];
              },
            };
          } else {
            // Multiple registered connectors: no single source descriptor; the
            // disclosure event has historically emitted `source: null` for this
            // branch. The operation propagates `null` through verbatim.
            dependencies = {
              getSourceDescriptor: () => null,
              listConnectorItems: async () => {
                const connectorIds = await ctx.listRegisteredConnectorIds();
                return Promise.all(
                  connectorIds.map(async (connectorId) => {
                    const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
                    return ctx.buildConnectorDiscoveryItem({
                      source: ctx.buildSourceDescriptor({ kind: "connector", id: connectorId }),
                      storageBinding: { connector_id: connectorId },
                      manifest,
                    });
                  })
                );
              },
            };
          }
        } else {
          operationInput = {
            actor: {
              kind: "client",
              subject_id: tokenInfo.subject_id || null,
              client_id: tokenInfo.client_id || null,
              grant_id: tokenInfo.grant_id || null,
            },
          };
          // Eagerly resolve the grant so the rejected-query path has the
          // correct source descriptor even if connector-item assembly throws.
          const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
          const source = grantResolved.source;
          queryContext.sourceDescriptor = source;
          dependencies = {
            getSourceDescriptor: () => source,
            listConnectorItems: async () => {
              const item = await ctx.buildConnectorDiscoveryItem({
                source,
                storageBinding: grantResolved.storageBinding,
                manifest: grantResolved.manifest,
                grant: tokenInfo.grant,
              });
              return [item];
            },
          };
        }

        const result = await executeConnectorsList(
          operationInput as unknown as ConnectorsListInput,
          dependencies as unknown as ConnectorsListDependencies
        );

        await ctx.emitQueryReceived(queryContext, req);

        await ctx.emitSpineEvent({
          event_type: "disclosure.served",
          trace_id: traceId,
          scenario_id: scenarioId,
          actor_type: actorType,
          actor_id: actorId,
          subject_type: "subject",
          subject_id: tokenInfo.subject_id || null,
          object_type: "query",
          object_id: queryId,
          status: "succeeded",
          grant_id: tokenInfo.grant_id || null,
          client_id: tokenInfo.client_id || null,
          token_id: authorizationTokenId(req),
          data: {
            source: result.sourceDescriptor,
            query_shape: "connector_list",
            connector_count: result.disclosureTotals.connector_count,
            stream_count: result.disclosureTotals.stream_count,
          },
        });

        return res.json(result.envelope);
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// Read the `view` selector off the schema query. `qs.parse` may produce a
// string, an array (repeated params), or an object (bracketed params); only a
// plain string is meaningful here, and it is compared case-insensitively after
// trimming. Anything else is treated as "no view" so the full body is served.
function readSchemaView(query: Readonly<Record<string, unknown>>): string | null {
  const raw = query?.view;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Explicit detail selector for agent-facing schema discovery. The legacy REST
// default remains full/current-compatible when this selector is omitted.
function readSchemaDetail(query: Readonly<Record<string, unknown>>): string | null {
  const raw = query?.detail;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Read the optional `stream` scope off the schema query. Only a non-empty
// plain string narrows the document; any other shape leaves the document
// unscoped.
function readSchemaStreamScope(query: Readonly<Record<string, unknown>>): string | null {
  const raw = query?.stream;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Read the optional canonical source scope off the schema query. This mirrors
// the public read selector used by records/search without accepting the
// deprecated alias on this discovery path.
function readSchemaConnectionScope(query: Readonly<Record<string, unknown>>): string | null {
  const raw = query?.connection_id;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface SchemaGetPlan {
  dependencies: Record<string, unknown>;
  operationInput: Record<string, unknown>;
}

// Owner branch: native single-connector binding when present, else fan out over
// every registered connector with a null source descriptor (the historical
// shape). Mutates `queryContext.sourceDescriptor` for the native case.
function buildOwnerSchemaGetPlan(
  ctx: MountRsReadContext,
  tokenInfo: TokenInfo,
  queryContext: QueryContext
): SchemaGetPlan {
  const operationInput = {
    actor: { kind: "owner", subject_id: tokenInfo.subject_id || null },
  };
  const ownerSubjectId = ctx.ownerSubjectIdForBindings(tokenInfo);
  const nativeManifest = ctx.resolveNativeManifest(ctx.opts);
  const nativeStorageBinding = ctx.resolveNativeStorageBinding(ctx.opts);
  if (nativeManifest && nativeStorageBinding) {
    const source = ctx.buildSourceDescriptor({
      kind: "provider_native",
      id: nativeManifest.provider_id,
    });
    queryContext.sourceDescriptor = source;
    return {
      operationInput,
      dependencies: {
        getSourceDescriptor: () => source,
        listConnectorItems: async () => [
          await ctx.buildConnectorSchemaItem({
            source,
            storageBinding: nativeStorageBinding,
            manifest: nativeManifest,
            ownerSubjectId,
          }),
        ],
      },
    };
  }
  // Multiple registered connectors: no single source descriptor, the disclosure
  // event has historically emitted `source: null` for this branch. Operation
  // propagates `null` through verbatim.
  return {
    operationInput,
    dependencies: {
      getSourceDescriptor: () => null,
      listConnectorItems: async () => {
        const connectorIds = await ctx.listRegisteredConnectorIds();
        return Promise.all(
          connectorIds.map(async (connectorId) => {
            const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
            return ctx.buildConnectorSchemaItem({
              source: ctx.buildSourceDescriptor({ kind: "connector", id: connectorId }),
              storageBinding: { connector_id: connectorId },
              manifest,
              ownerSubjectId,
            });
          })
        );
      },
    },
  };
}

// Client branch: resolve the grant eagerly so the rejected-query path has the
// correct source descriptor even if connector-item assembly throws. Mutates
// `queryContext.sourceDescriptor`.
async function buildClientSchemaGetPlan(
  ctx: MountRsReadContext,
  tokenInfo: TokenInfo,
  queryContext: QueryContext
): Promise<SchemaGetPlan> {
  const operationInput = {
    actor: {
      kind: "client",
      subject_id: tokenInfo.subject_id || null,
      client_id: tokenInfo.client_id || null,
      grant_id: tokenInfo.grant_id || null,
    },
  };
  const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
  const source = grantResolved.source;
  queryContext.sourceDescriptor = source;
  const ownerSubjectId = ctx.ownerSubjectIdForBindings(tokenInfo);
  return {
    operationInput,
    dependencies: {
      getSourceDescriptor: () => source,
      listConnectorItems: async () => [
        await ctx.buildConnectorSchemaItem({
          source,
          storageBinding: grantResolved.storageBinding,
          manifest: grantResolved.manifest,
          grant: tokenInfo.grant,
          ownerSubjectId,
        }),
      ],
    },
  };
}

function buildSchemaGetPlan(
  ctx: MountRsReadContext,
  tokenInfo: TokenInfo,
  queryContext: QueryContext
): Promise<SchemaGetPlan> {
  return tokenInfo.pdpp_token_kind === "owner"
    ? Promise.resolve(buildOwnerSchemaGetPlan(ctx, tokenInfo, queryContext))
    : buildClientSchemaGetPlan(ctx, tokenInfo, queryContext);
}

// Derive the connector/stream counts that match the body actually served. When
// the compact view scopes to a stream (or omits connectors), the served counts
// differ from the operation's full-body counts; this recomputes them from the
// served body and falls back to the operation counts for a non-list shape.
function deriveServedSchemaCounts(
  responseBody: { connectors?: unknown },
  fallback: { connector_count: number; stream_count: number }
): { connector_count: number; stream_count: number } {
  const connectors = responseBody?.connectors;
  if (!Array.isArray(connectors)) {
    return fallback;
  }
  const stream_count = connectors.reduce((sum: number, connector) => {
    const streams = (connector as { streams?: unknown })?.streams;
    return sum + (Array.isArray(streams) ? streams.length : 0);
  }, 0);
  return { connector_count: connectors.length, stream_count };
}

// GET /v1/schema — one-shot capability/schema discovery for the bearer
export function mountRsSchema(app: AppLike, ctx: MountRsReadContext): void {
  app.get("/v1/schema", { contract: "getSchema" }, ctx.requireToken, async (req: RouteRequest, res: RouteResponse) => {
    let queryContext: QueryContext | null = null;
    try {
      const { tokenInfo } = req;
      const queryId = ctx.ensureRequestId(res);
      const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
      ctx.setReferenceTraceId(res, traceId);

      // `view=compact` selects the additive, token-efficient schema projection;
      // any other (or omitted) `view` preserves the current full body. `stream`
      // narrows the document to one stream for the cheap `schema(stream)`
      // discovery middle step. `connection_id` narrows common stream names to
      // one configured source. These are read-only request shaping selectors:
      // they never change visibility, only the rendered detail level / scope.
      const compactView = readSchemaView(req.query) === "compact";
      const explicitFullDetail = !compactView && readSchemaDetail(req.query) === "full";
      const streamScope = readSchemaStreamScope(req.query);
      const connectionScope = readSchemaConnectionScope(req.query);

      queryContext = {
        tokenInfo,
        queryId,
        actorType,
        actorId,
        traceId,
        scenarioId,
        sourceDescriptor:
          tokenInfo.pdpp_token_kind === "owner"
            ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
            : ctx.buildClientSourceDescriptor(tokenInfo),
        queryData: {
          query_shape: "schema",
          ...(compactView ? { requested_view: "compact" } : {}),
          ...(explicitFullDetail ? { requested_detail: "full" } : {}),
          ...(streamScope ? { requested_stream: streamScope } : {}),
          ...(connectionScope ? { requested_connection_id: connectionScope } : {}),
        },
      };

      // Build the actor input + connector-item dependencies for this bearer.
      // Mutates `queryContext.sourceDescriptor` to the resolved source (mirrors
      // the inline behavior the route previously had and the `resolveReadScope`
      // convention used by the records routes).
      const { operationInput, dependencies } = await buildSchemaGetPlan(ctx, tokenInfo, queryContext);

      const result = await executeSchemaGet(
        operationInput as unknown as SchemaGetInput,
        dependencies as unknown as SchemaGetDependencies
      );

      if (explicitFullDetail && !streamScope) {
        const err = new Error(
          "schema detail \"full\" requires `stream`; call /v1/schema?view=compact for global discovery, then /v1/schema?stream=<name>&connection_id=<cin>&detail=full for exhaustive detail."
        ) as Error & { code?: string; param?: string };
        err.code = "invalid_request";
        err.param = "detail";
        await ctx.emitQueryReceived(queryContext, req);
        return await ctx.rejectQuery(res, req, queryContext, err);
      }

      if (explicitFullDetail && streamScope && !connectionScope) {
        const sources = schemaSourceOptions(result.response, { stream: streamScope });
        if (sources.length > 1) {
          const err = new Error(
            `schema detail "full" for stream "${streamScope}" matches ${sources.length} sources; retry with connection_id to fetch one source's exhaustive schema.`
          ) as Error & {
            code?: string;
            param?: string;
            retry_with?: string;
            available_connections?: unknown[];
          };
          err.code = "ambiguous_schema_detail";
          err.param = "connection_id";
          err.retry_with = "connection_id";
          err.available_connections = sources;
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
      }

      // Apply the compact projection (and optional stream scope) as a pure,
      // post-operation transform. The operation owns visibility/grant scope and
      // emits the full body; the route only down-projects the rendered detail.
      const responseBody = compactView
        ? projectSchemaCompactView(result.response, { stream: streamScope, connectionId: connectionScope })
        : projectSchemaStreamScope(result.response, { stream: streamScope, connectionId: connectionScope });
      const servedCounts = deriveServedSchemaCounts(responseBody, result.counts);

      await ctx.emitQueryReceived(queryContext, req);

      await ctx.emitSpineEvent({
        event_type: "disclosure.served",
        trace_id: traceId,
        scenario_id: scenarioId,
        actor_type: actorType,
        actor_id: actorId,
        subject_type: "subject",
        subject_id: tokenInfo.subject_id || null,
        object_type: "query",
        object_id: queryId,
        status: "succeeded",
        grant_id: tokenInfo.grant_id || null,
        client_id: tokenInfo.client_id || null,
        token_id: authorizationTokenId(req),
        data: {
          source: result.sourceDescriptor,
          query_shape: "schema",
          connector_count: servedCounts.connector_count,
          stream_count: servedCounts.stream_count,
          ...(compactView ? { requested_view: "compact" } : {}),
          ...(streamScope ? { requested_stream: streamScope } : {}),
          ...(connectionScope ? { requested_connection_id: connectionScope } : {}),
        },
      });

      return res.json(ctx.finalizeCanonicalEnvelope(responseBody, req));
    } catch (err) {
      if (queryContext) {
        await ctx.emitQueryReceived(queryContext, req);
        return await ctx.rejectQuery(res, req, queryContext, err);
      }
      return ctx.handleError(res, err);
    }
  });
}

// The owner/client branch of `/v1/streams` builds the operation input and
// dependencies; extracted to module-level helpers so the route handler stays
// under the cognitive-complexity bar.
interface StreamsListPlan {
  dependencies: Record<string, unknown>;
  operationInput: Record<string, unknown>;
  streamListFreshnessEvidence: unknown;
}

function hasExplicitOwnerConnectorScope(query: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(query || {}, "connector_id");
}

function buildOwnerReadGrantForManifest(manifest: ManifestLike): GrantLike {
  return {
    streams: (manifest?.streams || [])
      .map((stream) => (typeof stream?.name === "string" && stream.name ? { name: stream.name } : null))
      .filter(Boolean) as GrantStreamLike[],
  };
}

function buildPolyfillOwnerScope(ctx: MountRsReadContext, req: RouteRequest, connectorId: string): OwnerScopeLike {
  const connectorKey = ctx.canonicalConnectorKey(connectorId) ?? connectorId;
  return {
    public_scope: "polyfill",
    owner_subject_id: ctx.getOwnerTokenSubjectId(req),
    source: { kind: "connector", id: connectorKey },
    storage_binding: { connector_id: connectorKey },
  };
}

async function listOwnerStreamsForConnector(
  ctx: MountRsReadContext,
  req: RouteRequest,
  connectorId: string
): Promise<Record<string, unknown>[]> {
  const requestParams = (req.query as Record<string, unknown>) || {};
  const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
  const ownerScope = buildPolyfillOwnerScope(ctx, req, connectorId);
  const ownerResolved = await ctx.resolveOwnerManifestFromScope(ownerScope, ctx.opts);
  const source = ctx.buildSourceDescriptor(ownerScope.source);
  const grant = buildOwnerReadGrantForManifest(ownerResolved.manifest);
  const firstStream = Array.isArray(grant.streams) ? grant.streams[0]?.name : null;
  const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
    ownerSubjectId,
    storageBinding: ownerResolved.storageBinding,
    grant,
    requestParams,
    streamName: firstStream ?? null,
    nativeProviderStorage: false,
  });
  req._pdpp_resolver_warnings = [...(req._pdpp_resolver_warnings || []), ...(resolverWarnings || [])];
  const summaries = await ctx.listStreamsAcrossBindings(bindings, grant, ownerResolved.manifest, {
    resolveBindingsForStream: async (streamGrant: GrantStreamLike) => {
      const { bindings: streamBindings } = await ctx.resolveReadRequestBindings({
        ownerSubjectId,
        storageBinding: ownerResolved.storageBinding,
        grant,
        requestParams,
        streamName: streamGrant?.name || null,
        nativeProviderStorage: false,
      });
      return streamBindings;
    },
  });
  return summaries.map((summary) => ({
    ...summary,
    connector_id: connectorId,
    source,
  }));
}

async function listExplicitPolyfillOwnerStreams(
  ctx: MountRsReadContext,
  req: RouteRequest,
  ownerResolved: ResolvedManifest,
): Promise<Record<string, unknown>[]> {
  const requestParams = (req.query as Record<string, unknown>) || {};
  const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
  const grant = buildOwnerReadGrantForManifest(ownerResolved.manifest);
  const firstStream = Array.isArray(grant.streams) ? grant.streams[0]?.name : null;
  const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
    ownerSubjectId,
    storageBinding: ownerResolved.storageBinding,
    grant,
    requestParams,
    streamName: firstStream ?? null,
    nativeProviderStorage: false,
  });
  req._pdpp_resolver_warnings = [...(req._pdpp_resolver_warnings || []), ...(resolverWarnings || [])];
  return await ctx.listStreamsAcrossBindings(bindings, grant, ownerResolved.manifest, {
    resolveBindingsForStream: async (streamGrant: GrantStreamLike) => {
      const { bindings: streamBindings } = await ctx.resolveReadRequestBindings({
        ownerSubjectId,
        storageBinding: ownerResolved.storageBinding,
        grant,
        requestParams,
        streamName: streamGrant?.name || null,
        nativeProviderStorage: false,
      });
      return streamBindings;
    },
  });
}

async function listOwnerStreamsAcrossRegisteredConnectors(
  ctx: MountRsReadContext,
  req: RouteRequest
): Promise<Record<string, unknown>[]> {
  const connectorIds = await ctx.listRegisteredConnectorIds();
  const requestedConnectionId = resolveRequestConnectionId(req.query);
  const skippedConnectionErrors: Error[] = [];
  const streamsByConnector = await Promise.all(
    connectorIds.map(async (connectorId) => {
      try {
        return await listOwnerStreamsForConnector(ctx, req, connectorId);
      } catch (err) {
        if (
          requestedConnectionId &&
          err instanceof Error &&
          (err as Error & { code?: string }).code === "connection_not_found"
        ) {
          skippedConnectionErrors.push(err);
          return [];
        }
        throw err;
      }
    })
  );
  if (
    requestedConnectionId &&
    skippedConnectionErrors.length > 0 &&
    skippedConnectionErrors.length === connectorIds.length
  ) {
    throw skippedConnectionErrors[0];
  }
  return streamsByConnector.flat();
}

async function buildStreamsListOwnerPlan(
  ctx: MountRsReadContext,
  req: RouteRequest,
  queryContext: QueryContext,
  tokenInfo: TokenInfo
): Promise<StreamsListPlan> {
  const nativeManifest = ctx.resolveNativeManifest(ctx.opts);
  const nativeStorageBinding = ctx.resolveNativeStorageBinding(ctx.opts);
  if (!((nativeManifest && nativeStorageBinding) || hasExplicitOwnerConnectorScope(req.query))) {
    queryContext.sourceDescriptor = null;
    return {
      operationInput: {
        actor: { kind: "owner", subject_id: tokenInfo.subject_id || null },
        connection_id: resolveRequestConnectionId(req.query),
      },
      dependencies: {
        getSourceDescriptor: () => null,
        listSummaries: async () => listOwnerStreamsAcrossRegisteredConnectors(ctx, req),
      },
      streamListFreshnessEvidence: null,
    };
  }

  const ownerScope = await ctx.resolveOwnerReadScope(req, ctx.opts);
  // Set source before manifest resolution so malformed connector failures
  // remain attributable in query.received/query.rejected.
  queryContext.sourceDescriptor = ctx.buildSourceDescriptor(ownerScope.source);
  const ownerResolved = await ctx.resolveOwnerManifest(req, ctx.opts);
  const streamListFreshnessEvidence = await ctx.getConnectorFreshnessEvidence({
    source: ownerScope.source ?? null,
    manifest: ownerResolved.manifest,
  });
  return {
    operationInput: {
      actor: { kind: "owner", subject_id: tokenInfo.subject_id || null },
      connection_id: resolveRequestConnectionId(req.query),
    },
    dependencies: {
      getSourceDescriptor: () => queryContext.sourceDescriptor,
      listSummaries: async () => {
        if (ownerScope.public_scope === "polyfill" || ownerScope.source?.kind === "connector") {
          return listExplicitPolyfillOwnerStreams(ctx, req, ownerResolved);
        }
        return ctx.listAllStreams(ownerResolved.storageBinding);
      },
    },
    streamListFreshnessEvidence,
  };
}

async function buildStreamsListClientPlan(
  ctx: MountRsReadContext,
  req: RouteRequest,
  queryContext: QueryContext,
  tokenInfo: TokenInfo
): Promise<StreamsListPlan> {
  const grant = tokenInfo.grant;
  const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
  const streamListFreshnessEvidence = await ctx.getConnectorFreshnessEvidence({
    source: grantResolved.source,
    manifest: grantResolved.manifest,
  });
  const streamCountLimit = Array.isArray(grant?.streams) ? grant.streams.length : null;
  queryContext.sourceDescriptor = grantResolved.source;
  queryContext.queryData.stream_count_limit = streamCountLimit;
  const ownerSubjectId = ctx.ownerSubjectIdForBindings(tokenInfo);
  const nativeProviderStorage = grantResolved.source?.kind === "provider_native";
  const requestParams = (req.query as Record<string, unknown>) || {};
  return {
    operationInput: {
      actor: {
        kind: "client",
        subject_id: tokenInfo.subject_id || null,
        client_id: tokenInfo.client_id || null,
        grant_id: tokenInfo.grant_id || null,
        stream_count_limit: streamCountLimit,
      },
      connection_id: resolveRequestConnectionId(req.query),
    },
    dependencies: {
      getSourceDescriptor: () => queryContext.sourceDescriptor,
      listSummaries: async () => {
        // Honor request-time `connection_id` filter and grant-scope
        // `connection_id` constraint. When neither is set, fan in across
        // every active connection under the grant's connector.
        //
        // Each grant stream may pin a different `connection_id`; the resolver
        // runs per-stream so per-stream record counts honor the right binding
        // constraint instead of borrowing the first stream's resolution.
        const firstStream = Array.isArray(grant?.streams) ? grant?.streams[0]?.name : null;
        const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
          ownerSubjectId,
          storageBinding: grantResolved.storageBinding,
          grant: grant ?? null,
          requestParams,
          streamName: firstStream ?? null,
          nativeProviderStorage,
        });
        // Stash resolver warnings on the request scope so the route body can
        // thread them into `meta.warnings` (P3 fix).
        req._pdpp_resolver_warnings = resolverWarnings;
        return await ctx.listStreamsAcrossBindings(bindings, grant ?? null, grantResolved.manifest, {
          resolveBindingsForStream: async (streamGrant: GrantStreamLike) => {
            const { bindings: streamBindings } = await ctx.resolveReadRequestBindings({
              ownerSubjectId,
              storageBinding: grantResolved.storageBinding,
              grant: grant ?? null,
              requestParams,
              streamName: streamGrant?.name || null,
              nativeProviderStorage,
            });
            return streamBindings;
          },
        });
      },
    },
    streamListFreshnessEvidence,
  };
}

// GET /v1/streams — list streams (client or owner)
export function mountRsStreamsList(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/streams",
    { contract: "listStreams" },
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor:
            tokenInfo.pdpp_token_kind === "owner"
              ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
              : ctx.buildClientSourceDescriptor(tokenInfo),
          queryData: { query_shape: "stream_list" },
        };

        const plan =
          tokenInfo.pdpp_token_kind === "owner"
            ? await buildStreamsListOwnerPlan(ctx, req, queryContext, tokenInfo)
            : await buildStreamsListClientPlan(ctx, req, queryContext, tokenInfo);
        const { operationInput, dependencies, streamListFreshnessEvidence } = plan;

        const result = await executeStreamsList(
          operationInput as unknown as StreamsListInput,
          dependencies as unknown as StreamsListDependencies
        );

        await ctx.emitQueryReceived(queryContext, req);

        await emitDisclosureServed(ctx, {
          req,
          tokenInfo,
          actorType,
          actorId,
          traceId,
          scenarioId,
          queryId,
          data: {
            source: result.sourceDescriptor,
            query_shape: "stream_list",
            stream_count: result.streams.length,
          },
        });

        const streamsListBody: Record<string, unknown> = {
          object: "list",
          has_more: false,
          data: result.streams.map((summary) => ({
            ...summary,
            freshness: ctx.buildConnectorAwareFreshness(
              streamListFreshnessEvidence,
              ((summary as unknown as Record<string, unknown>).last_updated as string | null) || null
            ),
          })),
        };
        mergeResolverWarningsIntoBody(streamsListBody, req._pdpp_resolver_warnings);
        return res.json(ctx.finalizeCanonicalEnvelope(streamsListBody, req));
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// GET /v1/streams/:stream — stream metadata
export function mountRsStreamDetail(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/streams/:stream",
    { contract: "getStreamMetadata" },
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        let manifest: ManifestLike;
        let storageBinding: StorageBindingLike;
        let sourceDescriptor: SourceDescriptorLike | null =
          tokenInfo.pdpp_token_kind === "owner"
            ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
            : ctx.buildClientSourceDescriptor(tokenInfo);

        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor,
          streamId: req.params.stream,
          queryData: { query_shape: "stream_metadata" },
        };

        if (tokenInfo.pdpp_token_kind === "owner") {
          const ownerScope = await ctx.resolveOwnerReadScope(req, ctx.opts);
          sourceDescriptor = ctx.buildSourceDescriptor(ownerScope.source);
          queryContext.sourceDescriptor = sourceDescriptor;
          const ownerResolved = await ctx.resolveOwnerManifestFromScope(ownerScope, ctx.opts);
          manifest = ownerResolved.manifest;
          storageBinding = ownerResolved.storageBinding;
        } else {
          const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
          manifest = grantResolved.manifest;
          sourceDescriptor = grantResolved.source;
          queryContext.sourceDescriptor = sourceDescriptor;
          storageBinding = grantResolved.storageBinding;
        }

        await ctx.emitQueryReceived(queryContext, req);

        const operationInput =
          tokenInfo.pdpp_token_kind === "owner"
            ? {
                actor: { kind: "owner", subject_id: tokenInfo.subject_id || null },
                streamName: req.params.stream,
              }
            : {
                actor: {
                  kind: "client",
                  subject_id: tokenInfo.subject_id || null,
                  client_id: tokenInfo.client_id || null,
                  grant_id: tokenInfo.grant_id || null,
                },
                streamName: req.params.stream,
              };

        const dependencies = {
          getSourceDescriptor: () => sourceDescriptor,
          hasManifestStream: async (name: string) =>
            Array.isArray(manifest?.streams) && manifest.streams.some((s) => s.name === name),
          isStreamInGrant: (name: string) =>
            Array.isArray(tokenInfo.grant?.streams) && tokenInfo.grant.streams.some((s) => s.name === name),
          buildStreamMetadata: async (name: string) => {
            const manifestStream = manifest.streams?.find((s) => s.name === name);
            const streamGrant =
              tokenInfo.pdpp_token_kind === "client" ? tokenInfo.grant?.streams?.find((s) => s.name === name) : null;
            const freshness = await ctx.getVisibleStreamFreshness({
              tokenInfo,
              source: sourceDescriptor,
              storageBinding,
              stream: name,
              manifest,
            });
            return ctx.buildStreamMetadataEntry({
              manifestStream,
              streamGrant,
              grantStreams: tokenInfo.grant?.streams || [],
              freshness,
              manifestStreamNames: new Set(
                (manifest.streams || [])
                  .map((s: ManifestStreamLike) => s.name)
                  .filter((name): name is string => typeof name === "string")
              ),
            });
          },
        };

        let result: Awaited<ReturnType<typeof executeStreamDetail>>;
        try {
          result = await executeStreamDetail(
            operationInput as unknown as StreamDetailInput,
            dependencies as unknown as StreamDetailDependencies
          );
        } catch (err) {
          if (err instanceof StreamDetailVisibilityError) {
            const visibilityErr = new Error(err.message) as Error & { code?: string };
            visibilityErr.code = err.code;
            return await ctx.rejectQuery(res, req, queryContext, visibilityErr);
          }
          throw err;
        }

        const metadataBody = result.metadata as unknown as {
          views: unknown[];
          relationships: unknown[];
        } & Record<string, unknown>;

        await ctx.emitSpineEvent({
          event_type: "disclosure.served",
          trace_id: traceId,
          scenario_id: scenarioId,
          actor_type: actorType,
          actor_id: actorId,
          subject_type: "subject",
          subject_id: tokenInfo.subject_id || null,
          object_type: "query",
          object_id: queryId,
          status: "succeeded",
          grant_id: tokenInfo.grant_id || null,
          client_id: tokenInfo.client_id || null,
          stream_id: req.params.stream,
          token_id: authorizationTokenId(req),
          data: {
            source: result.sourceDescriptor,
            query_shape: "stream_metadata",
            view_count: metadataBody.views.length,
            relationship_count: metadataBody.relationships.length,
          },
        });

        return res.json(ctx.finalizeCanonicalEnvelope(metadataBody, req));
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// GET /v1/streams/:stream/aggregate
// Aggregate dependency object, extracted so the route handler stays under the
// cognitive-complexity bar. Accessors are passed as thunks because the route
// resolves `manifest` / `storageBinding` / `sourceDescriptor` / `grant` across
// the owner/client branch after this object would otherwise be built.
function buildStreamAggregateDeps(
  ctx: MountRsReadContext,
  tokenInfo: TokenInfo,
  refs: {
    streamName: string;
    manifest: ManifestLike;
    storageBinding: StorageBindingLike;
    sourceDescriptor: SourceDescriptorLike | null;
    grant: GrantLike | null;
  }
): Record<string, unknown> {
  const { streamName, manifest, storageBinding, sourceDescriptor, grant } = refs;
  return {
    getSourceDescriptor: () => sourceDescriptor,
    hasManifestStream: (candidate: string) => Boolean(manifest?.streams?.find((stream) => stream.name === candidate)),
    validateRequest: (params: Record<string, unknown>) => {
      const mStream = manifest?.streams?.find((stream) => stream.name === streamName);
      ctx.validateRequestedQueryFieldParams(params, mStream);
    },
    aggregate: async (params: Record<string, unknown>) => {
      const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
        ownerSubjectId: ctx.ownerSubjectIdForBindings(tokenInfo),
        storageBinding,
        grant,
        requestParams: params,
        streamName,
        nativeProviderStorage: sourceDescriptor?.kind === "provider_native",
      });
      // P3: thread resolver-level warnings (deprecated alias) into the
      // multi-binding aggregate envelope. The helper folds them into
      // `meta.warnings[]` whether the dispatch hits the single-binding fast
      // path or the multi-binding fan-in path.
      return await ctx.aggregateRecordsAcrossBindings(bindings, streamName, grant, params, manifest, {
        extraWarnings: resolverWarnings || [],
      });
    },
  };
}

export function mountRsStreamAggregate(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/streams/:stream/aggregate",
    { contract: "aggregateStream" },
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        const isOwner = tokenInfo.pdpp_token_kind === "owner";
        // The `:stream` segment is always present for this route; capture it as
        // a non-optional string so the downstream operation/binding calls keep
        // their `string` contracts under `noUncheckedIndexedAccess`.
        const streamName = req.params.stream as string;
        const requestParams = { ...req.query } as Record<string, unknown>;
        // Pre-emit query data block matches the operation's shape so the
        // rejected-query path emits the same fields whether the failure happens
        // before or after the operation runs.
        const queryEventData = buildAggregateQueryEventData(requestParams);
        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor: isOwner
            ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
            : ctx.buildClientSourceDescriptor(tokenInfo),
          streamId: streamName,
          queryData: { ...queryEventData },
        };

        const scope = await resolveReadScope(ctx, req, tokenInfo, queryContext);
        const { storageBinding, manifest } = scope;
        const sourceDescriptor = scope.sourceDescriptor;
        // Owner aggregate runs against a synthetic single-stream read grant;
        // client aggregate uses the bearer's grant.
        const grant: GrantLike | null = isOwner ? ctx.buildOwnerReadGrant(streamName) : (tokenInfo.grant ?? null);

        const operationInput = {
          actor: buildReadActor(tokenInfo),
          streamName,
          requestParams,
        };

        await ctx.emitQueryReceived(queryContext, req);

        const dependencies = buildStreamAggregateDeps(ctx, tokenInfo, {
          streamName,
          manifest,
          storageBinding,
          sourceDescriptor,
          grant,
        });

        const outcome = await runWithVisibilityRejection(
          () =>
            executeStreamsAggregate(
              operationInput as unknown as StreamsAggregateInput,
              dependencies as unknown as StreamsAggregateDependencies
            ),
          StreamsAggregateVisibilityError,
          (mapped) => ctx.rejectQuery(res, req, queryContext as QueryContext, mapped)
        );
        if (outcome.rejected) {
          return;
        }
        const result = outcome.result;

        await emitDisclosureServed(ctx, {
          req,
          tokenInfo,
          actorType,
          actorId,
          traceId,
          scenarioId,
          queryId,
          streamId: streamName,
          data: {
            source: result.sourceDescriptor,
            query_shape: "stream_aggregate",
            metric: result.disclosureTotals.metric,
            field: result.disclosureTotals.field,
            group_by: result.disclosureTotals.group_by,
            filtered_record_count: result.disclosureTotals.filtered_record_count,
            group_count: result.disclosureTotals.group_count,
          },
        });

        return res.json(ctx.finalizeCanonicalEnvelope(result.result, req));
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// GET /v1/streams/:stream/records
// Records-list dependency object, extracted so the route handler stays under
// the cognitive-complexity bar. Behaviour-identical to the previous inline
// object; manifest / storage-binding / source-descriptor are read through
// thunks because the route resolves them across the owner/client branch.
function buildRecordsListDeps(
  ctx: MountRsReadContext,
  tokenInfo: TokenInfo,
  refs: {
    manifest: ManifestLike;
    storageBinding: StorageBindingLike;
    sourceDescriptor: SourceDescriptorLike | null;
  }
): Record<string, unknown> {
  const { manifest, storageBinding, sourceDescriptor } = refs;
  return {
    getSourceDescriptor: () => sourceDescriptor,
    getManifest: () => manifest,
    getGrant: () => tokenInfo.grant || { streams: [] },
    queryRecords: async (stream: string, grant: GrantLike | null, params: Record<string, unknown>, m: ManifestLike) => {
      const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
        ownerSubjectId: ctx.ownerSubjectIdForBindings(tokenInfo),
        storageBinding,
        grant,
        requestParams: params,
        streamName: stream,
        nativeProviderStorage: sourceDescriptor?.kind === "provider_native",
      });
      return await ctx.queryRecordsAcrossBindings(bindings, stream, grant, params, m, {
        extraWarnings: resolverWarnings || [],
      });
    },
    decorateRecord: (record: unknown) => ctx.decorateRecordBlobRefs(record),
    validateRequestFields: (params: Record<string, unknown>, manifestStream: ManifestStreamLike | undefined) =>
      ctx.validateRequestedQueryFieldParams(params, manifestStream),
  };
}

export function mountRsRecordsList(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/streams/:stream/records",
    { contract: "listRecords" },
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        const requestParams = { ...req.query } as Record<string, unknown>;
        const rawView = req.query.view;
        const queryEventData = {
          query_shape: "record_list",
          has_changes_since: !!requestParams.changes_since,
          limit: requestParams.limit ? Number(requestParams.limit) : null,
          ...(typeof rawView === "string" && rawView.trim() ? { requested_view: rawView.trim() } : {}),
        };
        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor:
            tokenInfo.pdpp_token_kind === "owner"
              ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
              : ctx.buildClientSourceDescriptor(tokenInfo),
          streamId: req.params.stream,
          queryData: { ...queryEventData },
        };

        // Self-export: owner can query without a client grant. `resolveReadScope`
        // sets `queryContext.sourceDescriptor` and returns the resolved trio.
        const { storageBinding, manifest, sourceDescriptor } = await resolveReadScope(
          ctx,
          req,
          tokenInfo,
          queryContext
        );

        await ctx.emitQueryReceived(queryContext, req);

        const operationInput = {
          actor: buildReadActor(tokenInfo),
          streamName: req.params.stream,
          requestParams,
          // Forward the raw `view` / `fields` values without coercion so the
          // operation can apply the previous native truthiness test
          // (`if (req.query.view && req.query.fields)`). `qs.parse` may
          // produce strings, arrays (repeated params), or objects (bracketed
          // params); the operation handles each shape per its boundary
          // contract.
          rawQueryView: req.query.view,
          rawQueryFields: req.query.fields,
        };

        const dependencies = buildRecordsListDeps(ctx, tokenInfo, {
          manifest,
          storageBinding,
          sourceDescriptor,
        });

        let result: Awaited<ReturnType<typeof executeRecordsList>>;
        try {
          result = await executeRecordsList(
            operationInput as unknown as RecordsListInput,
            dependencies as unknown as RecordsListDependencies
          );
        } catch (err) {
          if (err instanceof RecordsListVisibilityError) {
            const mappedErr = new Error(err.message) as Error & { code?: string };
            mappedErr.code = err.code;
            return await ctx.rejectQuery(res, req, queryContext, mappedErr);
          }
          throw err;
        }

        await ctx.emitSpineEvent({
          event_type: "disclosure.served",
          trace_id: traceId,
          scenario_id: scenarioId,
          actor_type: actorType,
          actor_id: actorId,
          subject_type: "subject",
          subject_id: tokenInfo.subject_id || null,
          object_type: "query",
          object_id: queryId,
          status: "succeeded",
          grant_id: tokenInfo.grant_id || null,
          client_id: tokenInfo.client_id || null,
          stream_id: req.params.stream,
          token_id: authorizationTokenId(req),
          data: { source: result.sourceDescriptor, ...result.disclosureData },
        });

        return res.json(
          ctx.finalizeCanonicalEnvelope(
            {
              ...result.result,
              url: req.path,
            },
            req
          )
        );
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// GET /v1/streams/:stream/records/:id
export function mountRsRecordDetail(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/streams/:stream/records/:id",
    { contract: "getRecord" },
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);
        let storageBinding: StorageBindingLike | null = null;
        let sourceDescriptor: SourceDescriptorLike | null =
          tokenInfo.pdpp_token_kind === "owner"
            ? ctx.buildOwnerQuerySourceDescriptor(req, ctx.opts)
            : ctx.buildClientSourceDescriptor(tokenInfo);
        let manifest: ManifestLike;
        const requestedRecordId = decodeURIComponent(req.params.id as string);
        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor,
          streamId: req.params.stream,
          queryData: {
            query_shape: "record_detail",
            requested_record_id: requestedRecordId,
            has_changes_since: false,
            limit: null,
          },
        };

        if (tokenInfo.pdpp_token_kind === "owner") {
          const ownerScope = await ctx.resolveOwnerReadScope(req, ctx.opts);
          queryContext.sourceDescriptor = ctx.buildSourceDescriptor(ownerScope.source);
          const ownerResolved = await ctx.resolveOwnerManifestFromScope(ownerScope, ctx.opts);
          storageBinding = ownerResolved.storageBinding;
          manifest = ownerResolved.manifest;
          sourceDescriptor = ctx.buildSourceDescriptor(ownerScope.source);
          queryContext.sourceDescriptor = sourceDescriptor;
        } else {
          const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
          storageBinding = grantResolved.storageBinding;
          manifest = grantResolved.manifest;
          sourceDescriptor = grantResolved.source;
          queryContext.sourceDescriptor = sourceDescriptor;
        }
        await ctx.emitQueryReceived(queryContext, req);

        const operationInput = {
          actor:
            tokenInfo.pdpp_token_kind === "owner"
              ? { kind: "owner", subject_id: tokenInfo.subject_id || null }
              : {
                  kind: "client",
                  subject_id: tokenInfo.subject_id || null,
                  client_id: tokenInfo.client_id || null,
                  grant_id: tokenInfo.grant_id || null,
                },
          streamName: req.params.stream,
          recordId: requestedRecordId,
          expandOptions: {
            expand: req.query.expand,
            expand_limit: req.query.expand_limit,
            fields: req.query.fields,
          },
        };

        const dependencies = {
          getSourceDescriptor: () => sourceDescriptor,
          getManifest: () => manifest,
          getGrant: () => tokenInfo.grant || { streams: [] },
          getRecord: async (
            stream: string,
            recordId: string,
            grant: GrantLike | null,
            m: ManifestLike,
            options: Record<string, unknown>
          ) => {
            const mergedParams = { ...((req.query as Record<string, unknown>) || {}), ...(options || {}) };
            const { bindings, warnings: resolverWarnings } = await ctx.resolveReadRequestBindings({
              ownerSubjectId: ctx.ownerSubjectIdForBindings(tokenInfo),
              storageBinding: storageBinding as StorageBindingLike,
              grant,
              requestParams: mergedParams,
              streamName: stream,
              nativeProviderStorage: sourceDescriptor?.kind === "provider_native",
            });
            return await ctx.getRecordAcrossBindings(bindings, stream, recordId, grant, m, mergedParams, {
              extraWarnings: resolverWarnings || [],
            });
          },
          decorateRecord: (record: unknown) => ctx.decorateRecordBlobRefs(record),
          validateRequestFields: (requestParams: Record<string, unknown>, manifestStream: ManifestStreamLike | null) =>
            ctx.validateRequestedQueryFieldParams(requestParams, manifestStream ?? undefined),
        };

        // The native `getRecord` capability throws an `Error` carrying
        // `code: 'not_found'` for missing or grant-filtered records, so the
        // operation's null-record check is unreachable here — that branch
        // only fires for hosts whose `getRecord` returns null on miss
        // (e.g., the sandbox fixture). Native `not_found` errors flow
        // through the existing outer catch into `rejectQuery`.
        let result: Awaited<ReturnType<typeof executeRecordDetail>>;
        try {
          result = await executeRecordDetail(
            operationInput as unknown as RecordDetailInput,
            dependencies as unknown as RecordDetailDependencies
          );
        } catch (err) {
          if (err instanceof RecordDetailVisibilityError) {
            const mappedErr = new Error(err.message) as Error & { code?: string };
            mappedErr.code = err.code;
            return await ctx.rejectQuery(res, req, queryContext, mappedErr);
          }
          throw err;
        }

        await ctx.emitSpineEvent({
          event_type: "disclosure.served",
          trace_id: traceId,
          scenario_id: scenarioId,
          actor_type: actorType,
          actor_id: actorId,
          subject_type: "subject",
          subject_id: tokenInfo.subject_id || null,
          object_type: "query",
          object_id: queryId,
          status: "succeeded",
          grant_id: tokenInfo.grant_id || null,
          client_id: tokenInfo.client_id || null,
          stream_id: req.params.stream,
          token_id: authorizationTokenId(req),
          data: { source: result.sourceDescriptor, ...result.disclosureData },
        });
        return res.json(
          ctx.finalizeCanonicalEnvelope(
            withRecordSourceIdentity(result.record, {
              sourceDescriptor,
              storageBinding,
              requestConnectionId: resolveRequestConnectionId(req.query),
            }),
            req
          )
        );
      } catch (err) {
        if (queryContext) {
          await ctx.emitQueryReceived(queryContext, req);
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// Shared owner-mode search wiring. The three search routes pass an identical
// set of owner/client resolver closures into their respective `run*Search`
// helper; this keeps the duplication to one place exactly as the inline
// handlers expressed it (per-route literal objects).
function buildSearchHelpers(req: RouteRequest, ctx: MountRsReadContext): Record<string, unknown> {
  return {
    getOwnerSubjectId: () => ctx.getOwnerTokenSubjectId(req),
    resolveOwnerVisibleConnectorIds: async () => {
      const native = ctx.resolveNativeManifest(ctx.opts);
      if (native?.storage_binding?.connector_id) {
        // Native mode: a single owner-visible connector identity.
        return [native.storage_binding.connector_id];
      }
      // Polyfill mode: every registered connector is owner-visible.
      return await ctx.listRegisteredConnectorIds();
    },
    resolveOwnerScopeForConnector: (connectorId: string) => ({
      public_scope: "polyfill",
      owner_subject_id: ctx.getOwnerTokenSubjectId(req),
      source: { kind: "connector", id: connectorId },
      storage_binding: { connector_id: connectorId },
    }),
    resolveOwnerManifestFromScope: (ownerScope: unknown) => ctx.resolveOwnerManifestFromScope(ownerScope, ctx.opts),
    // Synthetic owner read grant covering every stream of the manifest;
    // fields = undefined ⇒ "all fields authorized" per
    // buildSearchPlanForGrant semantics.
    buildOwnerReadGrantForManifest: (manifest: ManifestLike) => ({
      streams: (manifest?.streams || []).map((s) => ({ name: s.name })),
    }),
    // Client-mode resolver
    resolveGrantManifest: (info: TokenInfo) => ctx.resolveGrantManifest(info, ctx.opts),
  };
}

// GET /v1/search — public lexical retrieval extension.
export function mountRsSearchLexical(app: AppLike, ctx: MountRsReadContext): void {
  app.get(
    "/v1/search",
    { contract: "searchRecordsLexical" },
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        const isOwner = tokenInfo.pdpp_token_kind === "owner";
        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor: isOwner ? null : ctx.buildClientSourceDescriptor(tokenInfo),
          streamId: null,
          queryData: { query_shape: "search" },
        };
        await ctx.emitQueryReceived(queryContext, req);

        const { envelope, disclosureData } = await ctx.runLexicalSearch({
          req,
          opts: ctx.opts,
          tokenInfo,
          ...buildSearchHelpers(req, ctx),
        });

        await ctx.emitSpineEvent({
          event_type: "disclosure.served",
          trace_id: traceId,
          scenario_id: scenarioId,
          actor_type: actorType,
          actor_id: actorId,
          subject_type: "subject",
          subject_id: tokenInfo.subject_id || null,
          object_type: "query",
          object_id: queryId,
          status: "succeeded",
          grant_id: tokenInfo.grant_id || null,
          client_id: tokenInfo.client_id || null,
          stream_id: null,
          token_id: authorizationTokenId(req),
          data: disclosureData,
        });

        return res.json(ctx.finalizeCanonicalEnvelope(envelope, req));
      } catch (err) {
        if (queryContext) {
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// GET /v1/search/semantic — experimental public semantic retrieval. Unstable.
//
// Only registered when a real embedding backend is configured. When no
// backend is configured, the advertisement is also omitted (see the RS
// metadata route handler) and requests fall through to the default 404 —
// which is what the spec scenario "A client encounters a server that does
// not advertise the extension" expects. The gate is evaluated here at mount
// time, identical to the inline `if (...) { app.get(...) }` guard.
export function mountRsSearchSemantic(app: AppLike, ctx: MountRsReadContext): void {
  const semanticBackendAtRegistration = ctx.getSemanticBackend();
  if (!(semanticBackendAtRegistration?.available() && ctx.opts.semanticRetrievalSupported !== false)) {
    return;
  }
  app.get(
    "/v1/search/semantic",
    { contract: "searchRecordsSemantic" },
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        const isOwner = tokenInfo.pdpp_token_kind === "owner";
        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor: isOwner ? null : ctx.buildClientSourceDescriptor(tokenInfo),
          streamId: null,
          queryData: { query_shape: "search_semantic" },
        };
        await ctx.emitQueryReceived(queryContext, req);

        const { envelope, disclosureData } = await ctx.runSemanticSearch({
          req,
          opts: ctx.opts,
          tokenInfo,
          ...buildSearchHelpers(req, ctx),
        });

        await ctx.emitSpineEvent({
          event_type: "disclosure.served",
          trace_id: traceId,
          scenario_id: scenarioId,
          actor_type: actorType,
          actor_id: actorId,
          subject_type: "subject",
          subject_id: tokenInfo.subject_id || null,
          object_type: "query",
          object_id: queryId,
          status: "succeeded",
          grant_id: tokenInfo.grant_id || null,
          client_id: tokenInfo.client_id || null,
          stream_id: null,
          token_id: authorizationTokenId(req),
          data: disclosureData,
        });

        return res.json(ctx.finalizeCanonicalEnvelope(envelope, req));
      } catch (err) {
        if (queryContext) {
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

// GET /v1/search/hybrid — experimental public hybrid retrieval. Composes
// lexical + semantic under the same grant; deduplicates by
// (connector_id, stream, record_key); emits per-source provenance and score
// objects. Registered only when BOTH underlying surfaces are active on this
// server. The gate is evaluated here at mount time, identical to the inline
// guard.
export function mountRsSearchHybrid(app: AppLike, ctx: MountRsReadContext): void {
  const hybridBackendAtRegistration = ctx.getSemanticBackend();
  const hybridSemanticAvailable = !!(
    hybridBackendAtRegistration?.available() && ctx.opts.semanticRetrievalSupported !== false
  );
  const hybridLexicalAvailable = ctx.opts.lexicalRetrievalSupported !== false;
  if (!(ctx.opts.hybridRetrievalSupported !== false && hybridLexicalAvailable && hybridSemanticAvailable)) {
    return;
  }
  app.get(
    "/v1/search/hybrid",
    { contract: "searchRecordsHybrid" },
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      let queryContext: QueryContext | null = null;
      try {
        const { tokenInfo } = req;
        const queryId = ctx.ensureRequestId(res);
        const { actorType, actorId, traceId, scenarioId } = ctx.buildQueryActorContext(tokenInfo);
        ctx.setReferenceTraceId(res, traceId);

        const isOwner = tokenInfo.pdpp_token_kind === "owner";
        queryContext = {
          tokenInfo,
          queryId,
          actorType,
          actorId,
          traceId,
          scenarioId,
          sourceDescriptor: isOwner ? null : ctx.buildClientSourceDescriptor(tokenInfo),
          streamId: null,
          queryData: { query_shape: "search_hybrid" },
        };
        await ctx.emitQueryReceived(queryContext, req);

        const { envelope, disclosureData } = await ctx.runHybridSearch({
          req,
          opts: ctx.opts,
          tokenInfo,
          ...buildSearchHelpers(req, ctx),
        });

        await ctx.emitSpineEvent({
          event_type: "disclosure.served",
          trace_id: traceId,
          scenario_id: scenarioId,
          actor_type: actorType,
          actor_id: actorId,
          subject_type: "subject",
          subject_id: tokenInfo.subject_id || null,
          object_type: "query",
          object_id: queryId,
          status: "succeeded",
          grant_id: tokenInfo.grant_id || null,
          client_id: tokenInfo.client_id || null,
          stream_id: null,
          token_id: authorizationTokenId(req),
          data: disclosureData,
        });

        return res.json(ctx.finalizeCanonicalEnvelope(envelope, req));
      } catch (err) {
        if (queryContext) {
          return await ctx.rejectQuery(res, req, queryContext, err);
        }
        return ctx.handleError(res, err);
      }
    }
  );
}

interface BlobActorScope {
  manifest: ManifestLike;
  nativeProviderStorage: boolean;
  storageBinding: StorageBindingLike;
}

// Owner/client scope resolution for the blob route. Unlike `resolveReadScope`,
// the blob route does not thread `queryContext` (it has no `query.received`
// instrumentation) and needs the `nativeProviderStorage` flag for the binding
// resolver. Behaviour-identical to the previous inline branch.
async function resolveBlobActorScope(
  ctx: MountRsReadContext,
  req: RouteRequest,
  tokenInfo: TokenInfo
): Promise<BlobActorScope> {
  if (tokenInfo.pdpp_token_kind === "owner") {
    const ownerScope = await ctx.resolveOwnerReadScope(req, ctx.opts);
    const ownerResolved = await ctx.resolveOwnerManifestFromScope(ownerScope, ctx.opts);
    return {
      storageBinding: ownerResolved.storageBinding,
      manifest: ownerResolved.manifest,
      nativeProviderStorage: ownerScope.source?.kind === "provider_native",
    };
  }
  const grantResolved = await ctx.resolveGrantManifest(tokenInfo, ctx.opts);
  return {
    storageBinding: grantResolved.storageBinding,
    manifest: grantResolved.manifest,
    nativeProviderStorage: grantResolved.source?.kind === "provider_native",
  };
}

// Walk every blob binding and collect the unique connector instances that
// expose a visible record referencing this blob. Owns the per-stream
// addressable-id resolution (with its grant-scope `connection_id` re-check and
// connection_not_found / invalid_argument tolerance) and the visibility scan.
// Behaviour-identical to the previous inline loop + `resolveAddressableForStream`
// closure.
async function scanBlobBindingMatches(
  ctx: MountRsReadContext,
  args: {
    req: RouteRequest;
    tokenInfo: TokenInfo;
    blobId: string;
    blobBindings: BlobBindingRow[];
    storageBinding: StorageBindingLike;
    manifest: ManifestLike;
    nativeProviderStorage: boolean;
    actorConnectorId: string | null;
    defaultAddressableInstanceIds: Set<string>;
  }
): Promise<Map<string, { binding: BlobBindingRow; record: unknown }>> {
  const {
    req,
    tokenInfo,
    blobId,
    blobBindings,
    storageBinding,
    manifest,
    nativeProviderStorage,
    actorConnectorId,
    defaultAddressableInstanceIds,
  } = args;
  const grantStreams = Array.isArray(tokenInfo.grant?.streams) ? tokenInfo.grant.streams : [];
  const ownerMode = tokenInfo.pdpp_token_kind === "owner";
  const requestParams = (req.query as Record<string, unknown>) || {};

  // Owner-mode addressable cache: owner can read any active connection and
  // there is no grant-scope connection_id constraint. Client mode resolves
  // `(stream → bindings)` lazily and honors per-stream
  // `grant.streams[].connection_id`.
  const streamBindingCache = new Map<string, Set<string>>();
  async function resolveAddressableForStream(streamName: string): Promise<Set<string>> {
    if (ownerMode) {
      // Owner mode: no grant scoping; the default fan-in set already captures
      // every active connection under the actor's connector, narrowed only by
      // request-time `connection_id` (or alias).
      return defaultAddressableInstanceIds;
    }
    if (streamBindingCache.has(streamName)) {
      return streamBindingCache.get(streamName) as Set<string>;
    }
    try {
      const { bindings: streamBindings } = await ctx.resolveReadRequestBindings({
        ownerSubjectId: ctx.ownerSubjectIdForBindings(tokenInfo),
        storageBinding,
        grant: tokenInfo.grant || { streams: [] },
        requestParams,
        streamName,
        nativeProviderStorage,
      });
      const ids = new Set(streamBindings.map((b) => b.connectorInstanceId).filter(Boolean) as string[]);
      streamBindingCache.set(streamName, ids);
      return ids;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "connection_not_found" || code === "invalid_argument") {
        // Grant-scope pins a connection that is not currently active, or the
        // request supplied an addressable id outside the grant for this stream.
        // Treat the stream as inaccessible for the blob-visibility check.
        const empty = new Set<string>();
        streamBindingCache.set(streamName, empty);
        return empty;
      }
      throw err;
    }
  }

  // Is this binding addressable by the caller for its stream? Owner mode and
  // the no-grant-scope fan-in case use the default set; grant-scoped clients
  // resolve per-stream.
  async function bindingIsAddressable(binding: BlobBindingRow): Promise<boolean> {
    const addressable =
      grantStreams.length || ownerMode
        ? await resolveAddressableForStream(binding.stream)
        : defaultAddressableInstanceIds;
    return !(addressable.size > 0 && binding.connector_instance_id && !addressable.has(binding.connector_instance_id));
  }

  // Load the record this binding points at (under the binding's own connection
  // when set), returning it only if it actually references the blob. `null`
  // means "not a match" (missing record, grant-filtered, or different blob).
  async function loadMatchingRecord(
    binding: BlobBindingRow
  ): Promise<{ data?: { blob_ref?: { blob_id?: string } } } | null> {
    const grant = ownerMode ? ctx.buildOwnerReadGrant(binding.stream) : tokenInfo.grant;
    const bindingStorageTarget = binding.connector_instance_id
      ? { connector_id: binding.connector_id, connector_instance_id: binding.connector_instance_id }
      : storageBinding;
    let record: { data?: { blob_ref?: { blob_id?: string } } } | null;
    try {
      record = await ctx.getRecord(bindingStorageTarget, binding.stream, binding.record_key, grant ?? null, manifest);
    } catch (err) {
      if ((err as { code?: string })?.code === "not_found") {
        return null;
      }
      throw err;
    }
    return record?.data?.blob_ref?.blob_id === blobId ? record : null;
  }

  const matchedByInstance = new Map<string, { binding: BlobBindingRow; record: unknown }>();
  for (const binding of blobBindings) {
    if (!actorConnectorId || binding.connector_id !== actorConnectorId) {
      continue;
    }
    if (!(await bindingIsAddressable(binding))) {
      continue;
    }
    const record = await loadMatchingRecord(binding);
    if (!record) {
      continue;
    }
    // Dedup by connection: the first visible record per instance wins, and
    // bindings without an instance id are not addressable connections.
    const instanceId = binding.connector_instance_id || null;
    if (!instanceId || matchedByInstance.has(instanceId)) {
      continue;
    }
    matchedByInstance.set(instanceId, { binding, record });
  }
  return matchedByInstance;
}

// Build the `ambiguous_connection` error carrying every connection that exposed
// the blob, so the caller can retry with `connection_id`. Behaviour-identical
// to the previous inline candidate assembly.
function buildAmbiguousConnectionError(
  ctx: MountRsReadContext,
  blobId: string,
  matchedByInstance: Map<string, { binding: BlobBindingRow; record: unknown }>,
  defaultBindings: ReadRequestBinding[]
): Error {
  const candidates: unknown[] = [];
  for (const [instanceId, m] of matchedByInstance) {
    const found = defaultBindings.find((b) => b.connectorInstanceId === instanceId);
    const wire = ctx.projectBindingForWire({
      connectorInstanceId: instanceId,
      connectorId: m.binding.connector_id,
      displayName: found?.displayName ?? null,
    });
    if (wire) {
      candidates.push(wire);
    }
  }
  return new ctx.AmbiguousConnectionError(
    `Blob '${blobId}' is exposed by records under more than one connection. Retry with \`connection_id\`.`,
    candidates
  );
}

// Pipe the resolved (single) binding through the canonical `executeBlobsRead`
// operation and write the response: content headers, the deprecated-alias
// warning header (P3 — the raw-bytes response has no JSON envelope to carry
// `meta.warnings[]`), and the bytes. Behaviour-identical to the previous inline
// tail.
async function serveResolvedBlob(
  res: RouteResponse,
  args: {
    blobId: string;
    blobRow: BlobRow;
    actorConnectorId: string | null;
    resolvedMatch: { binding: BlobBindingRow; record: unknown };
    resolverWarnings: ResolverWarning[] | undefined;
  }
): Promise<void> {
  const { blobId, blobRow, actorConnectorId, resolvedMatch, resolverWarnings } = args;
  const dependencies = {
    loadBlob: () => blobRow,
    loadBindings: () => [resolvedMatch.binding],
    getActorConnectorId: () => actorConnectorId,
    getVisibleRecord: () => resolvedMatch.record,
  };
  let output: Awaited<ReturnType<typeof executeBlobsRead>>;
  try {
    output = await executeBlobsRead(
      { blobId } as unknown as BlobsReadInput,
      dependencies as unknown as BlobsReadDependencies
    );
  } catch (opErr) {
    if (opErr instanceof BlobsReadNotFoundError) {
      const mapped = new Error(opErr.message) as Error & { code?: string };
      mapped.code = opErr.code;
      throw mapped;
    }
    throw opErr;
  }
  const blob = output.blob;
  res.setHeader("Content-Type", blob.mime_type);
  res.setHeader("Content-Length", String(blob.size_bytes));
  res.setHeader("Cache-Control", "private, no-store");
  // P3: when the resolver observed deprecated alias use, surface it as a
  // structured response header so callers see migration signal.
  if (Array.isArray(resolverWarnings) && resolverWarnings.some((w) => w?.code === "deprecated_alias_used")) {
    res.setHeader("PDPP-Warning", "deprecated_alias_used: connector_instance_id");
  }
  res.send(Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data || ""));
}

// GET /v1/blobs/:blob_id — per-binding blob-visibility read. Storage reads
// flow through the `BlobStore` capability (server/stores/blob-store.js),
// constructed once via `ctx.createBlobStore()` at mount time exactly as the
// inline `const blobStore = createBlobStore()` did. The route owns the
// binding scan and the per-stream grant-scope `connection_id` re-check (P1/P2
// fixes); `executeBlobsRead` owns the 404 / 200 shape and error mapping.
export function mountRsBlobRead(app: AppLike, ctx: MountRsReadContext): void {
  const blobStore = ctx.createBlobStore();
  app.get(
    "/v1/blobs/:blob_id",
    { contract: "getBlob" },
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const blobId = decodeURIComponent(req.params.blob_id as string);
        const { tokenInfo } = req;
        const { storageBinding, manifest, nativeProviderStorage } = await resolveBlobActorScope(ctx, req, tokenInfo);

        // Resolve the default set of bindings this caller can address. When
        // the request supplies `connection_id` (or the deprecated alias) the
        // resolver narrows; otherwise the resolver fans in. The blob route
        // does not know the stream yet — that comes from per-binding records
        // — so we resolve without a stream constraint here and re-check the
        // per-stream grant-scope `connection_id` constraint per binding below.
        const {
          bindings: defaultBindings,
          requestConnectionId,
          warnings: resolverWarnings,
        } = await ctx.resolveReadRequestBindings({
          ownerSubjectId: ctx.ownerSubjectIdForBindings(tokenInfo),
          storageBinding,
          grant: tokenInfo.grant || { streams: [] },
          requestParams: (req.query as Record<string, unknown>) || {},
          streamName: null,
          nativeProviderStorage,
        });
        const defaultAddressableInstanceIds = new Set(
          defaultBindings.map((b) => b.connectorInstanceId).filter(Boolean) as string[]
        );

        // Pre-load the blob and its bindings ourselves so we can perform a
        // route-level scan for ambiguity (P1 fix: the canonical operation
        // short-circuits on the first visible match and cannot observe
        // multiplicity) and so we can apply the per-stream grant-scope
        // `connection_id` constraint per blob binding (P2 fix: blobs cannot
        // borrow the connector-wide addressable set when the grant pins a
        // specific connection on the binding's stream).
        const blobRow = await blobStore.loadContentAddressedBlob(blobId);
        if (!blobRow) {
          const notFound = new Error("Blob not found") as Error & { code?: string };
          notFound.code = "blob_not_found";
          throw notFound;
        }
        const blobBindings = await blobStore.listBlobBindings(blobId);
        // Blob bindings are stored under the canonical connector key at ingest.
        // The grant/owner storage binding may still carry a legacy URL-shaped
        // connector id, so canonicalize before matching binding.connector_id or
        // the visibility scan never matches and the read fails blob_not_found.
        // See canonicalize-connector-keys Decision 1.
        const rawActorConnectorId = storageBinding?.connector_id ?? null;
        const actorConnectorId = rawActorConnectorId
          ? (ctx.canonicalConnectorKey(rawActorConnectorId) ?? rawActorConnectorId)
          : null;

        // Iterate every blob binding and collect the unique connector instances
        // that expose a visible record referencing this blob.
        const matchedByInstance = await scanBlobBindingMatches(ctx, {
          req,
          tokenInfo,
          blobId,
          blobBindings,
          storageBinding,
          manifest,
          nativeProviderStorage,
          actorConnectorId,
          defaultAddressableInstanceIds,
        });

        if (matchedByInstance.size === 0) {
          const notFound = new Error("Blob not found") as Error & { code?: string };
          notFound.code = "blob_not_found";
          throw notFound;
        }

        // Ambiguity: more than one connection exposed the blob and the caller
        // did not narrow with `connection_id`. Emit the typed
        // `ambiguous_connection` envelope with `available_connections` so the
        // caller can recover.
        if (matchedByInstance.size > 1 && !requestConnectionId) {
          throw buildAmbiguousConnectionError(ctx, blobId, matchedByInstance, defaultBindings);
        }

        // Single visible binding: serve the blob bytes. The selected match is
        // piped through the canonical `executeBlobsRead` operation and written
        // out by `serveResolvedBlob` (headers, deprecated-alias warning header,
        // and the raw bytes). `matchedByInstance.size === 0` was handled above,
        // so the iterator yields at least one entry here.
        const [selectedMatch] = matchedByInstance.values() as IterableIterator<{
          binding: BlobBindingRow;
          record: unknown;
        }>;
        const resolvedMatch = selectedMatch as { binding: BlobBindingRow; record: unknown };
        await serveResolvedBlob(res, {
          blobId,
          blobRow,
          actorConnectorId,
          resolvedMatch,
          resolverWarnings,
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// Mount the entire RS read family in the same registration order the inline
// handlers used in `buildRsApp`: connectors, schema, streams list, stream
// detail, aggregate, records list, record detail, lexical search,
// semantic search (gated), hybrid search (gated). The blob-read route mounts
// last because in `server/index.js` it is registered immediately after the
// `POST /v1/blobs` mutation route (§4); the host call site mounts it at that
// same point.
export function mountRsReadQueries(app: AppLike, ctx: MountRsReadContext): void {
  mountRsConnectors(app, ctx);
  mountRsSchema(app, ctx);
  mountRsStreamsList(app, ctx);
  mountRsStreamDetail(app, ctx);
  mountRsStreamAggregate(app, ctx);
  mountRsRecordsList(app, ctx);
  mountRsRecordDetail(app, ctx);
  mountRsSearchLexical(app, ctx);
  mountRsSearchSemantic(app, ctx);
  mountRsSearchHybrid(app, ctx);
}
