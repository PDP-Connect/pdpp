// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the resource-server mutation route family under `/v1`.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§4). Each `mount...`
// function registers one route at the same point in registration order where
// `server/index.js` previously registered it inline. Auth posture
// (`requireToken` + `requireOwner` or `requireClient`), request-id / trace-id
// wiring, mutation-context and state-context construction, spine event emission
// (`mutation.requested`, `mutation.completed`, `mutation.rejected`,
// `state.requested`, `state.served`/`state.updated`, `state.rejected`),
// response-envelope shape, status codes, and error→HTTP mapping are all
// unchanged.
//
// Route registration order mirrors `buildRsApp` in `server/index.js`:
//   1. POST /v1/blobs              — unconditional (always mounted)
//   2. /v1/event-subscriptions/*   — unconditional (always mounted, client-grant or trusted-owner-agent bearer)
//   3-7. Polyfill-mode mutations   — mounted only when !nativeMode:
//        DELETE /v1/streams/:stream/records
//        DELETE /v1/streams/:stream/records/:id
//        POST /v1/ingest/:stream
//        GET  /v1/state/:connectorId
//        PUT  /v1/state/:connectorId
//
// The canonical `rs.*` and `as-client-event-subscriptions` operations own the
// semantic logic. This adapter owns the HTTP wiring only. Every host capability
// the routes touch is injected via `MountRsMutationContext` so the adapter never
// reaches back into the `buildRsApp` closure or speaks SQL directly.

import {
  type BearerActor,
  executeCreateSubscription,
  executeDeleteSubscription,
  executeEnqueueTestEvent,
  executeGetSubscription,
  executeListSubscriptions,
  executeUpdateSubscription,
} from "../../operations/as-client-event-subscriptions/index.ts";
import {
  type BlobsUploadDependencies,
  type BlobsUploadInput,
  BlobsUploadInvalidRequestError,
  BlobsUploadStreamNotFoundError,
  executeBlobsUpload,
} from "../../operations/rs-blobs-upload/index.ts";
import type { SubscriptionScope, SubscriptionScopeStream } from "../../operations/rs-client-event-derive/index.ts";
import {
  executeRsConnectorStateGet,
  type RsConnectorStateGetDependencies,
  type RsConnectorStateGetGrantScope,
  type RsConnectorStateGetState,
} from "../../operations/rs-connector-state-get/index.ts";
import {
  executeRsConnectorStatePut,
  type RsConnectorStatePutDependencies,
  type RsConnectorStatePutGrantScope,
  type RsConnectorStatePutManifest,
  type RsConnectorStatePutState,
  RsConnectorStatePutValidationError,
} from "../../operations/rs-connector-state-put/index.ts";
import {
  executeRecordsDelete,
  type RecordsDeleteDependencies,
  RecordsDeleteInvalidRequestError,
  RecordsDeleteNotFoundError,
} from "../../operations/rs-records-delete/index.ts";
import {
  executeRecordsDeleteStream,
  type RecordsDeleteStreamDependencies,
  RecordsDeleteStreamInvalidRequestError,
  RecordsDeleteStreamNotFoundError,
} from "../../operations/rs-records-delete-stream/index.ts";
import {
  executeRecordsIngest,
  type InsertOrReplayRejectionInput,
  parseLines as parseIngestLines,
  type RecordsIngestDependencies,
  RecordsIngestInvalidRequestError,
  RecordsIngestNotFoundError,
  type RecordsIngestOutput,
  RecordsIngestResourceLimitError,
  RecordsIngestSystemicFailureError,
  type RejectionReceipt,
} from "../../operations/rs-records-ingest/index.ts";
import { canonicalConnectorKey } from "../connector-key.ts";
import { HOSTED_INGEST_MAX_LINE_BYTES } from "../hosted-ingest-limits.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types.

interface RouteRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  tokenInfo?: TokenInfo | null;
}

interface RouteResponse {
  end: () => unknown;
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  delete: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
  patch: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
  put: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

function subscriptionIdFromParams(params: Readonly<Record<string, string>>): string {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  return params.subscription_id ?? params.id ?? "";
}

function canonicalizeConnectorId(connectorId: string | null): string | null {
  return canonicalConnectorKey(connectorId) ?? connectorId;
}

function singleQueryValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string" && value[0].length > 0) {
    return value[0];
  }
  return null;
}

function ownerStateDraftAdmission(
  req: RouteRequest,
  grantId: string | null
): {
  allowStatuses?: readonly ["active", "draft"];
} {
  if (grantId) {
    return {};
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const explicitConnectorInstanceId = singleQueryValue(req.query?.connector_instance_id);
  return explicitConnectorInstanceId ? { allowStatuses: ["active", "draft"] } : {};
}

// First-ingest activation: a static-secret draft flips to active once it has
// accepted at least one record. A zero-record ingest leaves it draft and
// invisible — no phantom active connection. `activateDraftConnection` is a
// no-op on a non-draft row, so a re-run of an already-active connection is
// harmless. Extracted from the ingest handler to keep its cognitive complexity
// in bounds. See add-static-secret-owner-session-connect-path design Decision 5.
async function maybeActivateDraftAfterIngest(
  ctx: MountRsMutationContext,
  storageNamespace: ConnectorNamespaceLike | null,
  recordsAccepted: number
): Promise<void> {
  if (!ctx.activateDraftConnection || recordsAccepted <= 0) {
    return;
  }
  const resolvedStatus = storageNamespace?.status;
  const resolvedInstanceId = storageNamespace?.connectorInstanceId;
  if (resolvedStatus === "draft" && typeof resolvedInstanceId === "string") {
    await ctx.activateDraftConnection(resolvedInstanceId);
    // The connection just flipped draft -> active — the owner-facing
    // dashboard/Sources/Syncs summary feed must reflect this immediately
    // (setup_in_progress -> a real health resolver), not up to
    // LIST_CONNECTOR_SUMMARIES_CACHE_TTL_MS later. Same invalidation every
    // other connection-mutating route already performs.
    ctx.invalidateConnectorSummariesCache?.();
  }
}

async function maybeMarkAcquisitionBatchCommitted(
  ctx: MountRsMutationContext,
  storageNamespace: ConnectorNamespaceLike | null,
  counts: { recordsAccepted: number; recordsRejected: number }
): Promise<void> {
  if (!ctx.markAcquisitionBatchCommitted) {
    return;
  }
  const resolvedInstanceId = storageNamespace?.connectorInstanceId;
  if (typeof resolvedInstanceId !== "string") {
    return;
  }
  await ctx.markAcquisitionBatchCommitted(resolvedInstanceId, {
    acceptedCount: counts.recordsAccepted,
    failedCount: counts.recordsRejected,
  });
}

function recordKeyFromIngestRecord(record: unknown): string | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const value =
    (record as { key?: unknown; record_key?: unknown }).key ?? (record as { record_key?: unknown }).record_key;
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function maybeRecordAcquisitionProvenance(
  ctx: MountRsMutationContext,
  storageNamespace: ConnectorNamespaceLike,
  batch: AcquisitionBatchLike | null,
  stream: string,
  record: unknown
): Promise<void> {
  if (!(ctx.recordAcquisitionProvenance && batch?.batchId && storageNamespace.connectorInstanceId)) {
    return;
  }
  const recordKey = recordKeyFromIngestRecord(record);
  if (!recordKey) {
    return;
  }
  await ctx.recordAcquisitionProvenance({
    acquisitionMethod: batch.acquisitionMethod ?? "owner_artifact",
    batchId: batch.batchId,
    connectorInstanceId: storageNamespace.connectorInstanceId,
    recordKey,
    stream,
  });
}

// The single-record capability throws raw host errors. Classify via the
// injected capability, but only convert permanent per-record failures into the
// typed shape the operation needs for line-level rejection receipts. Systemic
// failures keep the original error object so the existing batch-level
// redaction path does not inherit host-private text.
async function ingestRecordClassified(
  ctx: MountRsMutationContext,
  namespace: ConnectorNamespaceLike,
  record: Record<string, unknown>,
  runId: string | null
): Promise<unknown> {
  try {
    return await ctx.ingestRecord(ctx.storageTargetForConnectorNamespace(namespace), record, {
      requireConnectionAdmission: Boolean(namespace.connectorInstanceId),
      runId,
    });
  } catch (err) {
    const classified = ctx.classifyIngestFailure(err);
    if (!classified.retryable) {
      const lineError = new Error(classified.message) as Error & { code: string; retryable: false };
      lineError.code = classified.code;
      lineError.retryable = false;
      throw lineError;
    }
    throw err;
  }
}

interface TokenInfo {
  readonly client_id?: string | null;
  readonly grant?: GrantLike | null;
  readonly grant_id?: string | null;
  readonly pdpp_token_kind?: string | null;
  readonly subject_id?: string | null;
  readonly [key: string]: unknown;
}

interface GrantStreamLike {
  readonly connection_id?: string | null;
  readonly name?: string | null;
  readonly resources?: readonly string[] | null;
  readonly time_range?: SubscriptionScopeStream["time_range"] | null;
  readonly [key: string]: unknown;
}

interface GrantLike {
  readonly source?: SubscriptionScope["source"] | null;
  readonly streams?: GrantStreamLike[] | null;
  readonly [key: string]: unknown;
}

interface ConnectorNamespaceLike {
  readonly connectorId: string | null;
  readonly connectorInstanceId: string | null;
  readonly [key: string]: unknown;
}

interface StorageTargetLike {
  readonly connector_id: string | null;
  readonly connector_instance_id: string | null;
}

interface AcquisitionBatchLike {
  readonly acquisitionMethod?: string | null;
  readonly batchId: string;
  readonly status?: string | null;
}

// Mutation-context shape — mirrors the object produced by `buildMutationContext`
// in `server/index.js`. Modeled as a mutable record because `rejectMutation`
// and `rejectState` overwrite `traceId`/`scenarioId` in-place, exactly as the
// inline handlers did.
interface MutationContext {
  actorId: string | null;
  actorType: string;
  connectorId: string | null | undefined;
  connectorInstanceId?: string | null;
  operation: string;
  requestedEmitted: boolean;
  requestedRecordId: string | null;
  requestId: string;
  scenarioId: string | undefined;
  sourceDescriptor: unknown;
  streamId: string | null;
  submittedRecordCount: number | null;
  traceId: string | null;
}

interface StateContext {
  actorId: string | null;
  actorType: string;
  connectorId: string | null;
  grantId: string | null;
  operation: string;
  requestedEmitted: boolean;
  requestedStreams: string[] | null;
  requestId: string;
  scenarioId: string | undefined;
  sourceDescriptor: unknown;
  traceId: string | null;
}

// Context injected by `buildRsApp` at the `mountRsMutation` call site. Every
// capability the mutation routes need that is not directly importable.
export interface MountRsMutationContext {
  // Capability: flip a static-secret draft connection to active on its first
  // successful ingest. Optional — hosts that do not support drafts omit it; the
  // ingest path then never activates. No-op when the row is not a draft. See
  // add-static-secret-owner-session-connect-path design Decision 5.
  readonly activateDraftConnection?: (connectorInstanceId: string) => Promise<unknown> | unknown;
  // Instrumentation context builders (closures in index.js)
  readonly buildMutationContext: (
    req: RouteRequest,
    res: RouteResponse,
    opts: {
      connectorId: string | null;
      connectorInstanceId?: string | null;
      operation: string;
      streamId: string | null;
      requestedRecordId?: string | null;
      submittedRecordCount?: number | null;
    }
  ) => MutationContext;
  readonly buildStateContext: (
    req: RouteRequest,
    res: RouteResponse,
    opts: {
      connectorId: string;
      grantId: string | null;
      operation: string;
      requestedStreams?: string[] | null;
    }
  ) => StateContext;
  // Capability: classify a thrown ingest-write error as PERMANENT (a
  // per-record data defect, `retryable: false`) or SYSTEMIC (storage/
  // coordination failure, or unknown, `retryable: true`) by its own typed
  // `.code` field only — see records.ts's `classifyIngestFailure`. Used to
  // convert permanent single-record failures into the operation layer's
  // typed line-error shape without importing records.ts here.
  readonly classifyIngestFailure: (err: unknown) => { code: string; message: string; retryable: boolean };
  readonly deleteAllRecords: (target: StorageTargetLike, streamName: string) => Promise<unknown>;
  readonly deleteRecord: (target: StorageTargetLike, streamName: string, recordId: string) => Promise<unknown>;
  readonly emitMutationEvent: (
    req: RouteRequest,
    ctx: MutationContext,
    eventType: string,
    status: string,
    data?: Record<string, unknown>
  ) => Promise<void>;
  readonly emitMutationRequested: (req: RouteRequest, ctx: MutationContext) => Promise<void>;
  readonly emitStateEvent: (
    req: RouteRequest,
    ctx: StateContext,
    eventType: string,
    status: string,
    data?: Record<string, unknown>
  ) => Promise<void>;
  readonly emitStateRequested: (req: RouteRequest, ctx: StateContext) => Promise<void>;

  // Event-subscription capabilities
  readonly getDefaultClientEventSubscriptionStore: () => unknown;
  readonly getDefaultDeliveryWorker: () => { tick: () => Promise<void> };
  readonly getLatestAcquisitionBatchForConnection?: (
    connectorInstanceId: string
  ) => Promise<AcquisitionBatchLike | null> | AcquisitionBatchLike | null;
  readonly getOwnerTokenSubjectId?: (req: RouteRequest) => string;
  readonly getSyncState: (target: StorageTargetLike, args: unknown) => Promise<unknown>;

  // Capability: error handler for untyped errors
  readonly handleError: (res: RouteResponse, err: unknown) => void;
  readonly ingestRecord: (
    target: StorageTargetLike,
    record: unknown,
    options?: { requireConnectionAdmission?: boolean; runId?: string | null }
  ) => Promise<unknown>;
  readonly insertOrReplayRecordRejection?: (input: {
    auditActorId: string;
    auditActorType: string;
    auditTraceId: string | null;
    code: string;
    connectorId: string;
    connectorInstanceId: string;
    inputIndex: number;
    ownerSubjectId: string;
    rawLine: Buffer;
    runId?: string | null;
    stream: string;
  }) => Promise<RejectionReceipt> | RejectionReceipt;
  // Every other owner-connection mutation route (revoke, reactivate,
  // schedule, run, rename, delete — see routes/owner-connection-*.ts,
  // ref-connectors.ts) invalidates the dashboard/Sources/Syncs summary cache
  // after mutating so the owner-facing feed reflects the change immediately
  // rather than racing its TTL (ref-control.ts). `activateDraftConnection`
  // above is the same kind of mutation (draft -> active) and must invalidate
  // too — see `maybeActivateDraftAfterIngest`.
  readonly invalidateConnectorSummariesCache?: () => void;
  readonly markAcceptedRecordRejectionsStale?: (input: {
    auditActorId: string;
    auditActorType: string;
    auditTraceId: string | null;
    connectorId: string;
    connectorInstanceId: string;
    ownerSubjectId: string;
    rawLine: Buffer;
    recordKey?: string | null;
    runId?: string | null;
    stream: string;
  }) => Promise<unknown> | unknown;
  readonly markAcquisitionBatchCommitted?: (
    connectorInstanceId: string,
    counts: { acceptedCount?: number; failedCount?: number; updatedAt?: string }
  ) => Promise<unknown> | unknown;
  readonly pdppError: PdppErrorFn;

  // Capability: store a content-addressed blob (blobs upload route)
  readonly persistContentAddressedBlob: (args: {
    connectorId: string | null;
    connectorInstanceId: string | null;
    stream: string;
    recordKey: string;
    mimeType: string;
    data: Buffer;
  }) => Promise<unknown>;
  readonly putSyncState: (target: StorageTargetLike, map: unknown, args: unknown) => Promise<unknown>;
  readonly recordAcquisitionProvenance?: (record: {
    acquisitionMethod: string;
    batchId: string;
    connectorInstanceId: string;
    recordKey: string;
    stream: string;
  }) => Promise<unknown> | unknown;
  readonly rejectMutation: (
    res: RouteResponse,
    req: RouteRequest,
    ctx: MutationContext,
    err: Error & { code?: string; trace_id?: string; scenario_id?: string }
  ) => Promise<unknown>;
  readonly rejectState: (
    res: RouteResponse,
    req: RouteRequest,
    ctx: StateContext,
    err: Error & { code?: string; trace_id?: string; scenario_id?: string }
  ) => Promise<unknown>;
  readonly requireClient: MiddlewareHandler;
  readonly requireOwner: MiddlewareHandler;
  // Auth middleware
  readonly requireToken: MiddlewareHandler;

  // Capability: resolve grant-scoped state access
  readonly resolveGrantScopedStateGrant: (connectorId: string, grantId: string) => Promise<unknown>;

  // Capability: resolve the owner's connector instance namespace for storage routing
  readonly resolveOwnerConnectorNamespace: (
    req: RouteRequest,
    connectorId: string,
    opts?: { allowStatuses?: readonly string[]; connectorInstanceId?: string | null }
  ) => Promise<ConnectorNamespaceLike>;

  // Capability: resolve a connector manifest by id
  readonly resolveRegisteredConnectorManifest: (
    connectorId: string
  ) => Promise<{ streams?: Array<{ name?: string | null }> | null }>;

  // Capability: resolve a single connector_id query value
  readonly resolveSingleConnectorIdQueryValue: (raw: unknown) => string | null;

  // Spine instrumentation helpers
  readonly setReferenceTraceId: (res: RouteResponse, traceId: string | null) => void;

  // Capability: storage primitives for polyfill-mode mutations
  readonly storageTargetForConnectorNamespace: (namespace: ConnectorNamespaceLike) => StorageTargetLike;

  // Capability: format the state response
  readonly toPublicConnectorStateProjection: (state: unknown) => unknown;
}

function insertHostedRejectionReceipt(
  ctx: MountRsMutationContext,
  req: RouteRequest,
  input: InsertOrReplayRejectionInput,
  namespace: ConnectorNamespaceLike,
  runId: string | null,
  traceId: string | null
): Promise<RejectionReceipt> | RejectionReceipt {
  if (!ctx.insertOrReplayRecordRejection) {
    throw new Error("hosted rejection receipt persistence is not configured");
  }
  const ownerSubjectId = ctx.getOwnerTokenSubjectId?.(req) ?? req.tokenInfo?.subject_id;
  if (!ownerSubjectId) {
    throw new Error("owner-token subject is not available for rejection receipt persistence");
  }
  if (!namespace.connectorInstanceId) {
    throw new Error("connector instance is required for rejection receipt persistence");
  }
  return ctx.insertOrReplayRecordRejection({
    auditActorId: ownerSubjectId,
    auditActorType: "subject",
    auditTraceId: traceId,
    code: input.code,
    connectorId: namespace.connectorId ?? input.connectorId,
    connectorInstanceId: namespace.connectorInstanceId,
    inputIndex: input.inputIndex,
    ownerSubjectId,
    rawLine: input.rawLine,
    runId,
    stream: input.stream,
  });
}

// POST /v1/blobs
//
// Blob-upload semantics live in the canonical `rs.blobs.upload` operation
// (operations/rs-blobs-upload). This route is a host adapter: it owns auth,
// request id, response writing, and concrete capability wiring. It MUST NOT
// recompute query/Content-Type validation, manifest visibility, or response
// envelope shaping locally. The host wires the existing
// `persistContentAddressedBlob` capability, which preserves blob+binding
// atomicity.
export function mountRsBlobsUpload(app: AppLike, ctx: MountRsMutationContext): void {
  app.post(
    "/v1/blobs",
    { contract: "uploadBlob" },
    ctx.requireToken,
    ctx.requireOwner,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_instance_id);
        const resolveStorageNamespace = (connectorId: string) =>
          connectorInstanceId
            ? ctx.resolveOwnerConnectorNamespace(req, connectorId, {
                allowStatuses: ["active", "draft"],
                connectorInstanceId,
              })
            : ctx.resolveOwnerConnectorNamespace(req, connectorId);
        let manifestCache: {
          streams?: Array<{ name?: string | null }> | null;
        } | null = null;
        let storageNamespace: ConnectorNamespaceLike | null = null;
        const dependencies: BlobsUploadDependencies = {
          hasManifestStream: async (connectorId: string, streamName: string) => {
            manifestCache = await ctx.resolveRegisteredConnectorManifest(connectorId);
            const visible = Boolean((manifestCache.streams || []).find((candidate) => candidate.name === streamName));
            if (visible) {
              storageNamespace = await resolveStorageNamespace(connectorId);
            }
            return visible;
          },
          persistBlob: async ({ connectorId, stream, recordKey, mimeType, data }) => {
            const namespace = storageNamespace ?? (await resolveStorageNamespace(connectorId));
            return ctx.persistContentAddressedBlob({
              connectorId: namespace.connectorId,
              connectorInstanceId: namespace.connectorInstanceId,
              // ctx.persistContentAddressedBlob is untyped (.js host); Buffer extends
              // Uint8Array so the operation's coerced Uint8Array is always passable here.
              data: data instanceof Buffer ? data : Buffer.from(data),
              mimeType,
              recordKey,
              stream,
            }) as ReturnType<BlobsUploadDependencies["persistBlob"]>;
          },
        };
        const operationInput: BlobsUploadInput = {
          body: req.body,
          contentType: (req.headers as Record<string, unknown>)["content-type"],
          requestParams: {
            connector_id: (req.query as Record<string, unknown>).connector_id,
            record_key: (req.query as Record<string, unknown>).record_key,
            stream: (req.query as Record<string, unknown>).stream,
          },
        };
        let output: { envelope: unknown };
        try {
          output = await executeBlobsUpload(operationInput, dependencies);
        } catch (opErr) {
          if (opErr instanceof BlobsUploadInvalidRequestError || opErr instanceof BlobsUploadStreamNotFoundError) {
            const mapped = new Error((opErr as Error).message) as Error & {
              code?: string;
            };
            const errCode0 = (opErr as { code?: string }).code;
            if (errCode0 !== undefined) {
              mapped.code = errCode0;
            }
            throw mapped;
          }
          throw opErr;
        }
        return res.json((output as { envelope: unknown }).envelope);
      } catch (err) {
        return ctx.handleError(res, err);
      }
    }
  );
}

// /v1/event-subscriptions cluster
//
// Outbound client/owner-agent event subscriptions (RI extension). Ordinary
// client subscriptions remain grant-scoped; trusted owner-agent subscriptions
// use owner REST authority and are isolated by `(client_id, subject_id)`.
// Advertised in
// `/.well-known/oauth-protected-resource` as a `client_event_subscriptions`
// capability — reference implementation extension, NOT Core PDPP.
//
// See: openspec/changes/add-client-event-subscriptions/

function buildGrantScope(grant: GrantLike): SubscriptionScope {
  return {
    ...(grant.source ? { source: grant.source } : {}),
    streams: Array.isArray(grant.streams)
      ? grant.streams.flatMap((s: GrantStreamLike): SubscriptionScopeStream[] => {
          if (!s.name) {
            return [];
          }
          return [
            {
              name: s.name,
              ...(s.connection_id ? { connection_id: s.connection_id } : {}),
              ...(Array.isArray(s.resources) ? { resources: s.resources } : {}),
              ...(s.time_range ? { time_range: s.time_range } : {}),
            },
          ];
        })
      : [],
  };
}

function buildBearerActorFromTokenInfo(req: RouteRequest): BearerActor | null {
  const ti = (req.tokenInfo || {}) as TokenInfo;
  const grant = (ti.grant || {}) as GrantLike;
  if (ti.pdpp_token_kind === "client") {
    if (!(ti.client_id && ti.grant_id)) {
      return null;
    }
    return {
      authorityKind: "client_grant",
      clientId: ti.client_id,
      grantId: ti.grant_id,
      grantScope: buildGrantScope(grant),
      subjectId: ti.subject_id ?? "",
    };
  }
  if (ti.pdpp_token_kind === "owner") {
    if (!(ti.client_id && ti.subject_id)) {
      return null;
    }
    return {
      authorityKind: "trusted_owner_agent",
      clientId: ti.client_id,
      grantId: null,
      grantScope: { streams: [{ name: "*" }] },
      subjectId: ti.subject_id,
    };
  }
  return null;
}

function rejectMissingClientGrant(ctx: MountRsMutationContext, res: RouteResponse): unknown {
  const message = "event subscription requires an active client grant or a registered trusted owner-agent bearer";
  return ctx.pdppError(res, 403, "grant_invalid", message);
}

function handleClientEventSubError(ctx: MountRsMutationContext, res: RouteResponse, err: unknown): unknown {
  const e = err as {
    name?: string;
    status?: number;
    code?: string;
    message?: string;
  };
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (e && e.name === "ClientEventSubscriptionError") {
    return ctx.pdppError(res, e.status || 400, e.code || "invalid_request", e.message);
  }
  return ctx.handleError(res, err);
}

export function mountRsEventSubscriptions(app: AppLike, ctx: MountRsMutationContext): void {
  const clientEventSubsDeps = () => ({
    nowIso: () => new Date().toISOString(),
    store: ctx.getDefaultClientEventSubscriptionStore(),
  });

  // POST /v1/event-subscriptions
  app.post(
    "/v1/event-subscriptions",
    { contract: "createEventSubscription" } as RouteArg<RouteHandler>,
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const actor = buildBearerActorFromTokenInfo(req);
        if (!actor) {
          return rejectMissingClientGrant(ctx, res);
        }
        const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
        const filters = body.filters && typeof body.filters === "object" ? body.filters : undefined;
        const out = await executeCreateSubscription(
          {
            actor,
            callbackUrl: typeof body.callback_url === "string" ? body.callback_url : "",
            filters,
          } as Parameters<typeof executeCreateSubscription>[0],
          clientEventSubsDeps() as Parameters<typeof executeCreateSubscription>[1]
        );
        try {
          await ctx.getDefaultDeliveryWorker().tick();
        } catch {
          /* ignored */
        }
        const o = out as {
          subscriptionId: string;
          secret: string;
          status: unknown;
          callbackUrl: string;
          createdAt: string;
        };
        return res.status(201).json({
          callback_url: o.callbackUrl,
          created_at: o.createdAt,
          secret: o.secret,
          status: o.status,
          subscription_id: o.subscriptionId,
        });
      } catch (err) {
        return handleClientEventSubError(ctx, res, err);
      }
    }
  );

  // GET /v1/event-subscriptions
  app.get(
    "/v1/event-subscriptions",
    { contract: "listEventSubscriptions" } as RouteArg<RouteHandler>,
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const actor = buildBearerActorFromTokenInfo(req);
        if (!actor) {
          return rejectMissingClientGrant(ctx, res);
        }
        const out = await executeListSubscriptions(
          actor,
          clientEventSubsDeps() as Parameters<typeof executeListSubscriptions>[1]
        );
        return res.json(out);
      } catch (err) {
        return handleClientEventSubError(ctx, res, err);
      }
    }
  );

  // GET /v1/event-subscriptions/:subscription_id
  app.get(
    "/v1/event-subscriptions/:subscription_id",
    { contract: "getEventSubscription" } as RouteArg<RouteHandler>,
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const actor = buildBearerActorFromTokenInfo(req);
        if (!actor) {
          return rejectMissingClientGrant(ctx, res);
        }
        const out = await executeGetSubscription(
          actor,
          subscriptionIdFromParams(req.params),
          clientEventSubsDeps() as Parameters<typeof executeGetSubscription>[2]
        );
        return res.json(out);
      } catch (err) {
        return handleClientEventSubError(ctx, res, err);
      }
    }
  );

  // PATCH /v1/event-subscriptions/:subscription_id
  app.patch(
    "/v1/event-subscriptions/:subscription_id",
    { contract: "updateEventSubscription" } as RouteArg<RouteHandler>,
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const actor = buildBearerActorFromTokenInfo(req);
        if (!actor) {
          return rejectMissingClientGrant(ctx, res);
        }
        const body = (req.body || {}) as Record<string, unknown>;
        const out = await executeUpdateSubscription(
          actor,
          subscriptionIdFromParams(req.params),
          {
            ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
            ...(body.rotate_secret === true ? { rotateSecret: true } : {}),
          } as Parameters<typeof executeUpdateSubscription>[2],
          clientEventSubsDeps() as Parameters<typeof executeUpdateSubscription>[3]
        );
        return res.json(out);
      } catch (err) {
        return handleClientEventSubError(ctx, res, err);
      }
    }
  );

  // DELETE /v1/event-subscriptions/:subscription_id
  app.delete(
    "/v1/event-subscriptions/:subscription_id",
    { contract: "deleteEventSubscription" } as RouteArg<RouteHandler>,
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const actor = buildBearerActorFromTokenInfo(req);
        if (!actor) {
          return rejectMissingClientGrant(ctx, res);
        }
        await executeDeleteSubscription(
          actor,
          subscriptionIdFromParams(req.params),
          clientEventSubsDeps() as Parameters<typeof executeDeleteSubscription>[2]
        );
        return res.status(204).end();
      } catch (err) {
        return handleClientEventSubError(ctx, res, err);
      }
    }
  );

  // POST /v1/event-subscriptions/:subscription_id/test-event
  app.post(
    "/v1/event-subscriptions/:subscription_id/test-event",
    { contract: "sendTestEvent" } as RouteArg<RouteHandler>,
    ctx.requireToken,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const actor = buildBearerActorFromTokenInfo(req);
        if (!actor) {
          return rejectMissingClientGrant(ctx, res);
        }
        const out = await executeEnqueueTestEvent(
          actor,
          subscriptionIdFromParams(req.params),
          clientEventSubsDeps() as Parameters<typeof executeEnqueueTestEvent>[2]
        );
        try {
          await ctx.getDefaultDeliveryWorker().tick();
        } catch {
          /* ignored */
        }
        return res.status(202).json({ event_id: (out as { eventId: string }).eventId });
      } catch (err) {
        return handleClientEventSubError(ctx, res, err);
      }
    }
  );
}

// DELETE /v1/streams/:stream/records (polyfill mode only)
//
// Bulk-delete semantics live in the canonical `rs.records.delete_stream`
// operation (operations/rs-records-delete-stream). This route is a host
// adapter: it owns auth, mutation-context wiring, trace id setup,
// instrumentation dispatch, and response writing. It MUST NOT recompute the
// connector_id presence rule, manifest visibility, or the
// `{ deleted_record_count }` event payload locally.
export function mountRsRecordsDeleteStream(app: AppLike, ctx: MountRsMutationContext): void {
  app.delete(
    "/v1/streams/:stream/records",
    ctx.requireToken,
    ctx.requireOwner,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorId = canonicalizeConnectorId(ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id));
      const connectorInstanceId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_instance_id);
      const mutationContext = ctx.buildMutationContext(req, res, {
        connectorId,
        connectorInstanceId,
        operation: "delete_stream_records",
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        streamId: req.params.stream ?? null,
      });
      try {
        let storageNamespace: ConnectorNamespaceLike | null = null;
        const dependencies: RecordsDeleteStreamDependencies = {
          deleteAllRecords: async (cid: string, streamName: string) => {
            const namespace =
              storageNamespace ??
              (await ctx.resolveOwnerConnectorNamespace(req, cid, {
                connectorInstanceId,
              }));
            // ctx.deleteAllRecords is untyped (.js host); it returns the deleted count.
            return ctx.deleteAllRecords(
              ctx.storageTargetForConnectorNamespace(namespace),
              streamName
            ) as Promise<number>;
          },
          hasManifestStream: async (cid: string, streamName: string) => {
            const manifest = await ctx.resolveRegisteredConnectorManifest(cid);
            const visible = Boolean((manifest.streams || []).find((stream) => stream.name === streamName));
            if (visible) {
              storageNamespace = await ctx.resolveOwnerConnectorNamespace(req, cid, {
                connectorInstanceId,
              });
            }
            return visible;
          },
        };
        let output: { deletedRecordCount: number };
        try {
          // Validate inputs before emitting `mutation.requested` to mirror
          // the previous native ordering: invalid_request short-circuits via
          // rejectMutation, which itself emits the requested event for parity.
          if (!connectorId) {
            throw new RecordsDeleteStreamInvalidRequestError("connector_id must be a single non-empty string");
          }
          ctx.setReferenceTraceId(res, mutationContext.traceId);
          await ctx.emitMutationRequested(req, mutationContext);
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          output = await executeRecordsDeleteStream({ connectorId, streamName: req.params.stream ?? "" }, dependencies);
        } catch (opErr) {
          if (
            opErr instanceof RecordsDeleteStreamInvalidRequestError ||
            opErr instanceof RecordsDeleteStreamNotFoundError
          ) {
            const mapped = new Error((opErr as Error).message) as Error & {
              code?: string;
            };
            const errCode1 = (opErr as { code?: string }).code;
            if (errCode1 !== undefined) {
              mapped.code = errCode1;
            }
            return await ctx.rejectMutation(res, req, mutationContext, mapped);
          }
          throw opErr;
        }
        await ctx.emitMutationEvent(req, mutationContext, "mutation.completed", "succeeded", {
          deleted_record_count: output.deletedRecordCount,
        });
        return res.status(204).end();
      } catch (err) {
        return await ctx.rejectMutation(
          res,
          req,
          mutationContext,
          err as Error & {
            code?: string;
            trace_id?: string;
            scenario_id?: string;
          }
        );
      }
    }
  );
}

// DELETE /v1/streams/:stream/records/:id (polyfill mode only, owner-authenticated)
//
// Single-delete semantics live in the canonical `rs.records.delete` operation
// (operations/rs-records-delete). The host adapter owns auth, mutation-context
// wiring, trace id setup, instrumentation dispatch, and response writing.
export function mountRsRecordsDelete(app: AppLike, ctx: MountRsMutationContext): void {
  app.delete(
    "/v1/streams/:stream/records/:id",
    ctx.requireToken,
    ctx.requireOwner,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorId = canonicalizeConnectorId(ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id));
      const connectorInstanceId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_instance_id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      const requestedRecordId = decodeURIComponent(req.params.id ?? "");
      const mutationContext = ctx.buildMutationContext(req, res, {
        connectorId,
        connectorInstanceId,
        operation: "delete_record",
        requestedRecordId,
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        streamId: req.params.stream ?? null,
      });
      try {
        let storageNamespace: ConnectorNamespaceLike | null = null;
        const dependencies: RecordsDeleteDependencies = {
          deleteRecord: async (cid: string, streamName: string, recordId: string) => {
            const namespace =
              storageNamespace ??
              (await ctx.resolveOwnerConnectorNamespace(req, cid, {
                connectorInstanceId,
              }));
            // ctx.deleteRecord is untyped (.js host); it returns the deleted count.
            return ctx.deleteRecord(
              ctx.storageTargetForConnectorNamespace(namespace),
              streamName,
              recordId
            ) as Promise<number>;
          },
          hasManifestStream: async (cid: string, streamName: string) => {
            const manifest = await ctx.resolveRegisteredConnectorManifest(cid);
            const visible = Boolean((manifest.streams || []).find((stream) => stream.name === streamName));
            if (visible) {
              storageNamespace = await ctx.resolveOwnerConnectorNamespace(req, cid, {
                connectorInstanceId,
              });
            }
            return visible;
          },
        };
        let output: { deletedRecordCount: number };
        try {
          if (!connectorId) {
            throw new RecordsDeleteInvalidRequestError("connector_id must be a single non-empty string");
          }
          ctx.setReferenceTraceId(res, mutationContext.traceId);
          await ctx.emitMutationRequested(req, mutationContext);
          output = await executeRecordsDelete(
            {
              connectorId,
              recordId: requestedRecordId,
              // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
              streamName: req.params.stream ?? "",
            },
            dependencies
          );
        } catch (opErr) {
          if (opErr instanceof RecordsDeleteInvalidRequestError || opErr instanceof RecordsDeleteNotFoundError) {
            const mapped = new Error((opErr as Error).message) as Error & {
              code?: string;
            };
            const errCode2 = (opErr as { code?: string }).code;
            if (errCode2 !== undefined) {
              mapped.code = errCode2;
            }
            return await ctx.rejectMutation(res, req, mutationContext, mapped);
          }
          throw opErr;
        }
        await ctx.emitMutationEvent(req, mutationContext, "mutation.completed", "succeeded", {
          deleted_record_count: output.deletedRecordCount,
        });
        return res.status(204).end();
      } catch (err) {
        return await ctx.rejectMutation(
          res,
          req,
          mutationContext,
          err as Error & {
            code?: string;
            trace_id?: string;
            scenario_id?: string;
          }
        );
      }
    }
  );
}

// POST /v1/ingest/:stream (Collection Profile, polyfill mode only, owner-authenticated)
//
// Ingest semantics live in the canonical `rs.records.ingest` operation
// (operations/rs-records-ingest). The host adapter owns auth,
// mutation-context wiring, trace id setup, instrumentation dispatch, and
// response writing. It MUST NOT recompute line splitting, connector_id
// presence, manifest visibility, JSON parse handling, the
// accepted/rejected counters, or the response envelope locally.
function requestBodyBytes(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  return Buffer.alloc(0);
}

export function mountRsRecordsIngest(app: AppLike, ctx: MountRsMutationContext): void {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this route adapter is the audited HTTP boundary for ingest admission, instrumentation, hosted rejection receipts, and response mapping; splitting it during the durable-rejection fix would obscure the unchanged route contract.
  app.post("/v1/ingest/:stream", ctx.requireToken, ctx.requireOwner, async (req: RouteRequest, res: RouteResponse) => {
    const connectorId = canonicalizeConnectorId(ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id));
    const connectorInstanceId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_instance_id);
    // Run-bound connector ingestion threads its run_id through so the storage
    // layer can fence a write already admitted before cancellation against
    // the run's own terminal state (see harden-ingest-run-admission-fence).
    // Absent for owner/API ingestion that has no run concept — the fence is
    // opt-in and those callers are unaffected.
    const runId = ctx.resolveSingleConnectorIdQueryValue(req.query.run_id);
    // parseLines is imported inside executeRecordsIngest; the line-count for
    // the mutation context must be computed here using the same parser.
    // Index.js imported `parseLines as parseIngestLines` from the operation
    // module and called it here. We replicate that call with the same body arg.
    const rawBody = requestBodyBytes(req.body);
    const lineCount = parseIngestLines(rawBody, { maxLineBytes: HOSTED_INGEST_MAX_LINE_BYTES }).length;
    const mutationContext = ctx.buildMutationContext(req, res, {
      connectorId,
      connectorInstanceId,
      operation: "ingest_records",
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      streamId: req.params.stream ?? null,
      submittedRecordCount: lineCount,
    });
    try {
      let storageNamespace: ConnectorNamespaceLike | null = null;
      let acquisitionBatchPromise: Promise<AcquisitionBatchLike | null> | null = null;
      // Explicit owner ingest addresses a concrete storage namespace. Paused
      // connections remain writable for owner-supplied backlog/manual ingest,
      // while connector-only fan-in stays active-only. `allowStatuses` is
      // omitted (not set to undefined) so it doesn't trip exactOptionalPropertyTypes.
      const explicitIngestAdmission = (cin: string | null) =>
        cin ? { allowStatuses: ["active", "draft", "paused"] as const } : {};
      const resolveAdmittedNamespace = async (
        cid: string,
        requestedConnectorInstanceId: string | null
      ): Promise<ConnectorNamespaceLike> => {
        storageNamespace ??= await ctx.resolveOwnerConnectorNamespace(req, cid, {
          ...explicitIngestAdmission(requestedConnectorInstanceId),
          connectorInstanceId: requestedConnectorInstanceId,
        });
        if (!storageNamespace.connectorInstanceId) {
          throw new Error("connector instance is required for hosted ingest");
        }
        return storageNamespace;
      };
      const dependencies: RecordsIngestDependencies = {
        hasManifestStream: async (cid: string, streamName: string) => {
          const manifest = await ctx.resolveRegisteredConnectorManifest(cid);
          return Boolean((manifest.streams || []).find((stream) => stream.name === streamName));
        },
        ingestRecord: async (cid: string, _cin: string | null, record: Record<string, unknown>) => {
          const namespace = storageNamespace ?? (await resolveAdmittedNamespace(cid, _cin));
          const result = await ingestRecordClassified(ctx, namespace, record, runId);
          if (ctx.getLatestAcquisitionBatchForConnection && namespace.connectorInstanceId) {
            acquisitionBatchPromise ??= Promise.resolve(
              ctx.getLatestAcquisitionBatchForConnection(namespace.connectorInstanceId)
            );
            await maybeRecordAcquisitionProvenance(
              ctx,
              namespace,
              await acquisitionBatchPromise,
              // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
              req.params.stream ?? "",
              record
            );
          }
          return result;
        },
        insertOrReplayRejection: async (input) => {
          const namespace =
            storageNamespace ?? (await resolveAdmittedNamespace(input.connectorId, input.connectorInstanceId ?? null));
          return insertHostedRejectionReceipt(ctx, req, input, namespace, runId, mutationContext.traceId);
        },
        markAcceptedRecordRejectionsStale: async (input) => {
          const ownerSubjectId = ctx.getOwnerTokenSubjectId?.(req) ?? req.tokenInfo?.subject_id;
          if (!(ctx.markAcceptedRecordRejectionsStale && ownerSubjectId)) {
            return;
          }
          await ctx.markAcceptedRecordRejectionsStale({
            auditActorId: ownerSubjectId,
            auditActorType: "subject",
            auditTraceId: mutationContext.traceId,
            connectorId: input.connectorId,
            connectorInstanceId: input.connectorInstanceId,
            ownerSubjectId,
            rawLine: input.rawLine,
            recordKey: input.recordKey ?? null,
            runId: input.runId ?? runId,
            stream: input.stream,
          });
        },
        resolveAdmittedConnectorInstance: async (cid: string, requestedConnectorInstanceId: string | null) => {
          const namespace = await resolveAdmittedNamespace(cid, requestedConnectorInstanceId);
          return namespace.connectorInstanceId;
        },
      };
      let output: RecordsIngestOutput;
      try {
        if (!connectorId) {
          throw new RecordsIngestInvalidRequestError("connector_id must be a single non-empty string");
        }
        ctx.setReferenceTraceId(res, mutationContext.traceId);
        await ctx.emitMutationRequested(req, mutationContext);
        output = await executeRecordsIngest(
          {
            body: rawBody,
            connectorId,
            connectorInstanceId,
            hostedRejectionReceipts: true,
            maxLineBytes: HOSTED_INGEST_MAX_LINE_BYTES,
            runId,
            // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
            streamName: req.params.stream ?? "",
          },
          dependencies
        );
      } catch (opErr) {
        if (
          opErr instanceof RecordsIngestInvalidRequestError ||
          opErr instanceof RecordsIngestNotFoundError ||
          opErr instanceof RecordsIngestResourceLimitError ||
          opErr instanceof RecordsIngestSystemicFailureError
        ) {
          const mappedMessage =
            opErr instanceof RecordsIngestSystemicFailureError
              ? "Ingest failed due to a transient storage error; retry later."
              : (opErr as Error).message;
          const mapped = new Error(mappedMessage) as Error & {
            code?: string;
          };
          const errCode3 = (opErr as { code?: string }).code;
          if (errCode3 !== undefined) {
            mapped.code = errCode3;
          }
          if (opErr instanceof RecordsIngestSystemicFailureError) {
            console.warn("rs.records.ingest systemic failure", {
              code: mapped.code,
              retryable_failure_count: opErr.retryableFailureCount,
            });
          }
          return await ctx.rejectMutation(res, req, mutationContext, mapped);
        }
        throw opErr;
      }
      await maybeActivateDraftAfterIngest(ctx, storageNamespace, output.envelope.records_accepted);
      await maybeMarkAcquisitionBatchCommitted(ctx, storageNamespace, {
        recordsAccepted: output.envelope.records_accepted,
        recordsRejected: output.envelope.records_rejected,
      });
      await ctx.emitMutationEvent(req, mutationContext, "mutation.completed", "succeeded", {
        error_count: output.envelope.records_rejected,
        records_accepted: output.envelope.records_accepted,
        records_rejected: output.envelope.records_rejected,
      });
      return res.json(output.envelope);
    } catch (err) {
      return await ctx.rejectMutation(
        res,
        req,
        mutationContext,
        err as Error & {
          code?: string;
          trace_id?: string;
          scenario_id?: string;
        }
      );
    }
  });
}

// GET /v1/state/:connectorId (Collection Profile, polyfill mode only, owner-authenticated)
//
// Validation order, the storage call shape, and the grant-scope-driven
// `allowedStreams` semantics live in the canonical `rs.connector-state.get`
// operation. The host adapter wires auth, request id / trace id,
// instrumentation events, the manifest resolver, the grant-scope resolver,
// and the response writing.
export function mountRsConnectorStateGet(app: AppLike, ctx: MountRsMutationContext): void {
  app.get(
    "/v1/state/:connectorId",
    ctx.requireToken,
    ctx.requireOwner,
    async (req: RouteRequest, res: RouteResponse) => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      const connectorId = canonicalizeConnectorId(decodeURIComponent(req.params.connectorId ?? "")) ?? "";
      const grantId = typeof req.query.grant_id === "string" ? req.query.grant_id : null;
      const stateContext = ctx.buildStateContext(req, res, {
        connectorId,
        grantId,
        operation: "read",
      });
      try {
        let storageNamespace: ConnectorNamespaceLike | null = null;
        const stateGetDeps: RsConnectorStateGetDependencies = {
          getSyncState: async (_id: string, args) => {
            const namespace =
              storageNamespace ??
              (await ctx.resolveOwnerConnectorNamespace(req, _id, ownerStateDraftAdmission(req, grantId)));
            // ctx.getSyncState is untyped (.js host); args shape matches the operation's contract.
            return ctx.getSyncState(
              ctx.storageTargetForConnectorNamespace(namespace),
              args
            ) as Promise<RsConnectorStateGetState>;
          },
          onGrantResolved: async (grantScope) => {
            if (grantScope?.traceId) {
              stateContext.traceId = grantScope.traceId;
              stateContext.scenarioId = grantScope.scenarioId;
            }
            ctx.setReferenceTraceId(res, stateContext.traceId);
            await ctx.emitStateRequested(req, stateContext);
          },
          // ctx.resolveGrantScopedStateGrant is untyped (.js host); it returns
          // the grant scope object matching RsConnectorStateGetGrantScope.
          resolveGrantScope: (id: string, gid: string) =>
            ctx.resolveGrantScopedStateGrant(id, gid) as Promise<RsConnectorStateGetGrantScope>,
          resolveRegisteredConnectorManifest: async (id: string) => {
            const manifest = await ctx.resolveRegisteredConnectorManifest(id);
            storageNamespace = await ctx.resolveOwnerConnectorNamespace(
              req,
              id,
              ownerStateDraftAdmission(req, grantId)
            );
            return manifest;
          },
        };
        const { state } = await executeRsConnectorStateGet({ connectorId, grantId }, stateGetDeps);
        await ctx.emitStateEvent(req, stateContext, "state.served", "succeeded", {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          updated_at: state?.updated_at || null,
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          visible_streams: Object.keys(state?.state || {}),
        });
        return res.json(ctx.toPublicConnectorStateProjection(state));
      } catch (err) {
        return await ctx.rejectState(
          res,
          req,
          stateContext,
          err as Error & {
            code?: string;
            trace_id?: string;
            scenario_id?: string;
          }
        );
      }
    }
  );
}

// PUT /v1/state/:connectorId (Collection Profile, polyfill mode only, owner-authenticated)
//
// Validation order (manifest stream membership, grant-scope membership),
// the storage call shape, and the typed validation errors live in the canonical
// `rs.connector-state.put` operation. The host adapter translates the typed
// validation error into the existing PDPP error envelope shape.
export function mountRsConnectorStatePut(app: AppLike, ctx: MountRsMutationContext): void {
  app.put(
    "/v1/state/:connectorId",
    ctx.requireToken,
    ctx.requireOwner,
    async (req: RouteRequest, res: RouteResponse) => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      const connectorId = canonicalizeConnectorId(decodeURIComponent(req.params.connectorId ?? "")) ?? "";
      const grantId = typeof req.query.grant_id === "string" ? req.query.grant_id : null;
      const body = req.body as Record<string, unknown> | null | undefined;
      const stateMap =
        body?.state && typeof body.state === "object" && !Array.isArray(body.state)
          ? (body.state as Record<string, unknown>)
          : {};
      const requestedStreams = Object.keys(stateMap);
      const stateContext = ctx.buildStateContext(req, res, {
        connectorId,
        grantId,
        operation: "write",
        requestedStreams,
      });
      try {
        let storageNamespace: ConnectorNamespaceLike | null = null;
        const statePutDeps: RsConnectorStatePutDependencies = {
          onGrantResolved: async (grantScope) => {
            if (grantScope?.traceId) {
              stateContext.traceId = grantScope.traceId;
              stateContext.scenarioId = grantScope.scenarioId;
            }
            ctx.setReferenceTraceId(res, stateContext.traceId);
            await ctx.emitStateRequested(req, stateContext);
          },
          putSyncState: async (_id: string, map, args) => {
            const namespace =
              storageNamespace ??
              (await ctx.resolveOwnerConnectorNamespace(req, _id, ownerStateDraftAdmission(req, grantId)));
            // ctx.putSyncState is untyped (.js host); map/args shapes match the operation's contract.
            return ctx.putSyncState(
              ctx.storageTargetForConnectorNamespace(namespace),
              map,
              args
            ) as Promise<RsConnectorStatePutState>;
          },
          // ctx.resolveGrantScopedStateGrant is untyped (.js host); it returns the grant
          // scope object matching RsConnectorStatePutGrantScope.
          resolveGrantScope: (id: string, gid: string) =>
            ctx.resolveGrantScopedStateGrant(id, gid) as Promise<RsConnectorStatePutGrantScope>,
          resolveRegisteredConnectorManifest: async (id: string) => {
            const manifest = await ctx.resolveRegisteredConnectorManifest(id);
            storageNamespace = await ctx.resolveOwnerConnectorNamespace(
              req,
              id,
              ownerStateDraftAdmission(req, grantId)
            );
            // ctx.resolveRegisteredConnectorManifest is untyped (.js host); streams[].name
            // may be null/undefined at runtime but the operation's stream-membership check
            // guards against that via a Set lookup (missing names simply won't match).
            return manifest as RsConnectorStatePutManifest;
          },
        };
        const { state } = await executeRsConnectorStatePut({ connectorId, grantId, stateMap }, statePutDeps);
        await ctx.emitStateEvent(req, stateContext, "state.updated", "succeeded", {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          persisted_streams: Object.keys(state?.state || {}),
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          updated_at: state?.updated_at || null,
        });
        return res.json(ctx.toPublicConnectorStateProjection(state));
      } catch (err) {
        if (err instanceof RsConnectorStatePutValidationError) {
          // Translate the operation-typed validation error into the plain
          // `Error` shape `rejectState` already understands so the public
          // error envelope and `state.rejected` event remain unchanged.
          const translated = new Error((err as Error).message) as Error & {
            code?: string;
          };
          const translatedCode = (err as { code?: string }).code;
          if (translatedCode !== undefined) {
            translated.code = translatedCode;
          }
          return await ctx.rejectState(res, req, stateContext, translated);
        }
        return await ctx.rejectState(
          res,
          req,
          stateContext,
          err as Error & {
            code?: string;
            trace_id?: string;
            scenario_id?: string;
          }
        );
      }
    }
  );
}

// Aggregator: mounts the polyfill-mode RS mutation routes (called when !nativeMode).
//
// Registration order in buildRsApp (server/index.js):
//   1. mountRsEventSubscriptions — unconditional, registered BEFORE mountRsReadQueries
//      (call site: after /mcp routes, before hosted-UI CSS)
//   2. mountRsBlobsUpload        — unconditional, registered AFTER mountRsReadQueries
//      (call site: after mountRsReadQueries, before mountRsBlobRead)
//   3-7. mountRsMutation         — polyfill-mode only, after mountRsBlobRead
//        DELETE /v1/streams/:stream/records
//        DELETE /v1/streams/:stream/records/:id
//        POST   /v1/ingest/:stream
//        GET    /v1/state/:connectorId
//        PUT    /v1/state/:connectorId
//
// `mountRsEventSubscriptions` and `mountRsBlobsUpload` are called separately
// from `buildRsApp` to preserve the original route registration order. This
// function mounts only the !nativeMode polyfill routes.
export function mountRsMutation(app: AppLike, ctx: MountRsMutationContext): void {
  mountRsRecordsDeleteStream(app, ctx);
  mountRsRecordsDelete(app, ctx);
  mountRsRecordsIngest(app, ctx);
  mountRsConnectorStateGet(app, ctx);
  mountRsConnectorStatePut(app, ctx);
}
