// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reference-only owner-session manual/upload DRAFT-connection creation.
//
// File-import connectors declare setup.modality="manual_or_upload" and an
// import_dir_env_var in their manifest. The owner uploads one exported artifact;
// this route stores it under a connection-scoped import directory and creates
// an invisible draft connection. The run orchestrator later injects that
// directory as the connector-declared env var. First successful ingest flips
// the draft to active through the existing ingest lifecycle.

import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { closeSync, createWriteStream, openSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import {
  type ManualUploadValidationResult,
  validateManualUploadArtifactByKind,
  validateManualUploadArtifactFromFileByKind,
} from "../../../packages/polyfill-connectors/src/manual-upload-validation.ts";
import {
  type ConnectorManifestLike,
  displayNameForConnector,
  manualUploadSetupFromManifest,
} from "../connection-setup-plan.ts";
import { manualUploadMaxBytes } from "../manual-upload-limits.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

const PATH_SEP_RE = /[\\/]/;
const UNSAFE_FILENAME_CHARS_RE = /[^\w .-]/g;
const CONNECTION_ID_RE = /^cin_[A-Za-z0-9_-]+$/;
const ARTIFACT_ID_RE = /^mua_[A-Za-z0-9_-]+$/;
const MANUAL_UPLOAD_STREAM_CONTENT_TYPE = "application/vnd.pdpp.manual-upload";

interface RouteRequest {
  readonly body?: unknown;
  is?: (type: string) => string | false;
  ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  getHeader: (name: string) => string | number | string[] | undefined;
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

interface ConnectorInstance {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly displayName?: string | null;
  readonly ownerSubjectId?: string | null;
  readonly sourceBinding?: Record<string, unknown> | null;
  readonly sourceBindingKey?: string | null;
  readonly sourceKind?: string | null;
  readonly status: string;
}

interface ConnectorInstanceStore {
  get: (connectorInstanceId: string) => Promise<ConnectorInstance | null> | ConnectorInstance | null;
  upsert: (record: {
    ownerSubjectId: string;
    connectorId: string;
    displayName: string;
    status: string;
    sourceKind: string;
    sourceBindingKey: string;
    sourceBinding: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }) => Promise<ConnectorInstance> | ConnectorInstance;
}

// Written by both createManualUploadDraftConnection and
// validateAndStageArtifact below; each sets a different subset of the
// optional fields.
export interface ManualUploadDraftSourceBinding {
  readonly acquisition_method: "owner_artifact";
  readonly import_dir: string;
  readonly import_dir_env_var: string;
  readonly import_validation?: unknown;
  readonly kind: "manual_upload_draft";
  readonly staged_upload?: boolean;
  readonly uploaded_file_name?: string;
}

// import_dir/import_dir_env_var are read on every run (connection-scoped-run-env.ts,
// buildControllerManualUploadRunEnvResolver), not just at setup — they must
// survive promotion.
export interface ManualUploadDurableSourceBinding {
  readonly acquisition_method: "owner_artifact";
  readonly import_dir: string;
  readonly import_dir_env_var: string;
  readonly import_validation?: unknown;
  readonly kind: "manual_upload";
  readonly promoted_at: string;
  readonly promoted_from: "manual_upload_draft";
  readonly uploaded_file_name?: string;
}

// Pure — no I/O. `staged_upload` does not carry over: it meant "no file
// staged yet," no longer true once records have ingested.
export function promoteManualUploadDraftBinding(
  draftBinding: ManualUploadDraftSourceBinding,
  now: string
): ManualUploadDurableSourceBinding {
  return {
    acquisition_method: draftBinding.acquisition_method,
    import_dir: draftBinding.import_dir,
    import_dir_env_var: draftBinding.import_dir_env_var,
    kind: "manual_upload",
    promoted_at: now,
    promoted_from: "manual_upload_draft",
    ...(draftBinding.import_validation === undefined ? {} : { import_validation: draftBinding.import_validation }),
    ...(draftBinding.uploaded_file_name === undefined ? {} : { uploaded_file_name: draftBinding.uploaded_file_name }),
  };
}

interface AcquisitionBatch {
  readonly acceptedCount?: number | null;
  readonly artifactSha256?: string | null;
  readonly batchId: string;
  readonly connectorInstanceId: string;
  readonly duplicateCount?: number | null;
  readonly eventTimeEnd?: string | null;
  readonly eventTimeStart?: string | null;
  readonly failedCount?: number | null;
  readonly mediaCoverage?: unknown;
  readonly parsedCount?: number | null;
  readonly skippedCount?: number | null;
  readonly sourceFormat?: string | null;
  readonly status: string;
  readonly uploadedFileName?: string | null;
  readonly warnings?: readonly string[] | null;
}

interface AcquisitionBatchStore {
  findByArtifactHash: (
    ownerSubjectId: string,
    connectorId: string,
    artifactSha256: string
  ) => Promise<AcquisitionBatch | null> | AcquisitionBatch | null;
  insertOwnerArtifactBatch: (record: {
    acquisitionMethod: "owner_artifact";
    artifactSha256: string;
    connectorId: string;
    connectorInstanceId: string;
    eventTimeEnd?: string | null;
    eventTimeStart?: string | null;
    mediaCoverage?: unknown;
    ownerSubjectId: string;
    parsedCount?: number | null;
    parserVersion?: string | null;
    receipt?: unknown;
    sourceFormat?: string | null;
    status?: string;
    uploadedFileName?: string | null;
    warnings?: readonly string[];
  }) => Promise<AcquisitionBatch> | AcquisitionBatch;
}

interface ManualUploadArtifact {
  readonly acquisitionBatchId?: string | null;
  readonly artifactId: string;
  readonly artifactSha256?: string | null;
  readonly connectorId: string;
  readonly connectorInstanceId?: string | null;
  readonly createdAt?: string | null;
  readonly error?: unknown;
  readonly fileName: string;
  readonly fileSizeBytes?: number | null;
  readonly finalPath?: string | null;
  readonly ownerSubjectId: string;
  readonly stagingPath: string;
  readonly status: "uploaded" | "validating" | "staged" | "duplicate" | "failed";
  readonly updatedAt?: string | null;
  readonly validation?: ManualUploadValidationResult | null;
}

interface ManualUploadArtifactStore {
  claimForSweep: (artifactId: string, cutoffIso: string, nowIso: string) => Promise<boolean> | boolean;
  get: (artifactId: string) => Promise<ManualUploadArtifact | null> | ManualUploadArtifact | null;
  insert: (record: {
    artifactId: string;
    artifactSha256: string;
    connectorId: string;
    connectorInstanceId?: string | null;
    fileName: string;
    fileSizeBytes: number;
    ownerSubjectId: string;
    stagingPath: string;
    status?: "uploaded" | "validating" | "staged" | "duplicate" | "failed";
  }) => Promise<ManualUploadArtifact> | ManualUploadArtifact;
  listByConnection: (
    connectorInstanceId: string,
    options?: { limit?: number }
  ) => Promise<ManualUploadArtifact[]> | ManualUploadArtifact[];
  listInFlightOlderThan: (cutoffIso: string) => Promise<ManualUploadArtifact[]> | ManualUploadArtifact[];
  update: (
    artifactId: string,
    patch: {
      acquisitionBatchId?: string | null;
      artifactSha256?: string | null;
      connectorInstanceId?: string | null;
      error?: unknown;
      fileSizeBytes?: number | null;
      finalPath?: string | null;
      status?: "uploaded" | "validating" | "staged" | "duplicate" | "failed";
      validation?: ManualUploadValidationResult | null;
    }
  ) => Promise<ManualUploadArtifact | null> | ManualUploadArtifact | null;
}

export interface MountRefManualUploadDraftConnectionContext {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  createRequestAcquisitionBatchStore: () => AcquisitionBatchStore;
  createRequestConnectorInstanceStore: () => ConnectorInstanceStore;
  createRequestManualUploadArtifactStore: () => ManualUploadArtifactStore;
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  ensureRequestId: (res: RouteResponse) => string;
  getOwnerSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  importBaseDir: string;
  now?: () => string;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  resolveRegisteredConnectorManifest: (connectorId: string) => Promise<ConnectorManifestLike>;
  setReferenceTraceId: (res: RouteResponse, traceId: string) => void;
}

function buildAuditTrace(ctx: MountRefManualUploadDraftConnectionContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return { request_id: requestId, scenario_id: trace.scenario_id, trace_id: trace.trace_id };
}

async function emitManualUploadAudit(
  ctx: MountRefManualUploadDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorId?: string | null;
    error?: unknown;
    operation: "create" | "validate";
    outcome: "failed" | "succeeded";
    ownerSubjectId?: string | null;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, res);
  const ownerSubjectId = args.ownerSubjectId ?? req.ownerSession?.sub ?? null;
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    actor_id: ownerSubjectId ?? "owner_session",
    actor_type: "owner_session",
    data: {
      connection_id: args.connectionId ?? null,
      connector_id: args.connectorId ?? null,
      operation: args.operation,
      outcome: args.outcome,
      ...(args.error ? { error: { code: typeof code === "string" ? code : "api_error" } } : {}),
    },
    event_type: `owner.connection.manual_upload_draft.${args.operation}`,
    object_id: args.connectionId ?? "unknown_connection",
    object_type: "connection",
    request_id: trace.request_id,
    scenario_id: trace.scenario_id,
    status: args.outcome,
    subject_id: ownerSubjectId,
    subject_type: "subject",
    trace_id: trace.trace_id,
  });
}

function errorWithCode(code: string): { code: string } {
  return { code };
}

function optionalConnectionId(req: RouteRequest): string | null {
  const raw = firstQueryValue(req.query?.connection_id);
  return raw && CONNECTION_ID_RE.test(raw) ? raw : null;
}

function suggestedDisplayNameFromValidation(validation: ManualUploadValidationResult | null): string | null {
  const sourceIdentity = validation && "source_identity" in validation ? validation.source_identity : null;
  const suggested =
    sourceIdentity && typeof sourceIdentity.suggested_display_name === "string"
      ? sourceIdentity.suggested_display_name.trim().replace(/\s+/g, " ")
      : "";
  return suggested.length > 0 && suggested.length <= 120 ? suggested : null;
}

function cleanRequestedDisplayName(raw: unknown): string | null {
  const clean = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return clean.length > 0 && clean.length <= 120 ? clean : null;
}

function displayNameFromRequestedOrSuggested(
  raw: unknown,
  validation: ManualUploadValidationResult | null,
  fallback: string
): string {
  return cleanRequestedDisplayName(raw) ?? suggestedDisplayNameFromValidation(validation) ?? fallback;
}

function requestedOrSuggestedDisplayName(
  req: RouteRequest,
  validation: ManualUploadValidationResult | null,
  fallback: string
): string {
  return displayNameFromRequestedOrSuggested(firstQueryValue(req.query?.display_name), validation, fallback);
}

async function rejectManualUploadRequest(
  ctx: MountRefManualUploadDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectorId: string;
    errorCode: string;
    httpStatus: number;
    message: string;
    operation?: "create" | "validate" | undefined;
    ownerSubjectId: string | null;
    param?: string;
  }
): Promise<null> {
  await emitManualUploadAudit(ctx, req, res, {
    connectorId: args.connectorId,
    error: errorWithCode(args.errorCode),
    operation: args.operation ?? "create",
    outcome: "failed",
    ownerSubjectId: args.ownerSubjectId,
  });
  ctx.pdppError(res, args.httpStatus, args.errorCode, args.message, args.param);
  return null;
}

async function requireManualUploadSetup(
  ctx: MountRefManualUploadDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectorId: string;
    manifest: ConnectorManifestLike;
    operation?: "create" | "validate" | undefined;
    ownerSubjectId: string | null;
  }
) {
  const setup = manualUploadSetupFromManifest(args.manifest);
  if (setup?.importDirEnvVar) {
    return setup;
  }
  return await rejectManualUploadRequest(ctx, req, res, {
    connectorId: args.connectorId,
    errorCode: "manual_upload_unsupported",
    httpStatus: 409,
    message: `Connector '${args.connectorId}' does not declare a supported manual/upload setup.`,
    operation: args.operation,
    ownerSubjectId: args.ownerSubjectId,
  });
}

/**
 * Shared streaming-upload primitive for every manual-upload route that
 * accepts a raw file body (staged-artifact, validation-preview, and the
 * legacy draft-connection create path): the request body is written to a
 * bounded TEMP staging path via `writeUploadBodyToPath` (streamed, hashed
 * incrementally, never buffered whole) and then validated via
 * `validateStagedArtifact`'s fd-backed dispatch — the same path
 * `/manual-upload-staged-artifact` already used exclusively. No caller of
 * this function reads the body as a buffer.
 *
 * The caller owns the returned `stagingPath`'s lifecycle: on a `valid`
 * result, either move/rename it into a permanent location (the create path)
 * or delete it once its metadata has been used (the preview path, which
 * never needs to keep the bytes). `removeStagingArtifact` is the existing
 * whole-directory cleanup helper for this.
 */
async function stageAcceptedUpload(
  ctx: MountRefManualUploadDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectorId: string;
    operation?: "create" | "validate" | undefined;
    ownerSubjectId: string | null;
    setup: NonNullable<ReturnType<typeof manualUploadSetupFromManifest>>;
  }
): Promise<{
  fileSizeBytes: number;
  fileName: string;
  sha256: string;
  stagingPath: string;
  validation: ManualUploadValidationResult | null;
} | null> {
  const fileName = normalizeFileName(firstQueryValue(req.query?.file_name));
  if (!fileName) {
    return await rejectManualUploadRequest(ctx, req, res, {
      connectorId: args.connectorId,
      errorCode: "import_file_name_rejected",
      httpStatus: 400,
      message: "A safe import file name is required.",
      operation: args.operation,
      ownerSubjectId: args.ownerSubjectId,
      param: "file_name",
    });
  }
  if (!fileNameIsAccepted(fileName, args.setup.acceptedFileNames, args.setup.acceptedFileExtensions)) {
    return await rejectManualUploadRequest(ctx, req, res, {
      connectorId: args.connectorId,
      errorCode: "import_file_name_rejected",
      httpStatus: 400,
      message: acceptedFileMessage(fileName, args.setup.acceptedFileNames, args.setup.acceptedFileExtensions),
      operation: args.operation,
      ownerSubjectId: args.ownerSubjectId,
      param: "file_name",
    });
  }

  const stagingId = `mua_preview_${randomBytes(18).toString("base64url")}`;
  const stagingDir = join(ctx.importBaseDir, "_staging", safePathSegment(args.connectorId), stagingId);
  const stagingPath = join(stagingDir, fileName);
  const maxFileBytes = args.setup.validation?.maxFileBytes ?? null;
  await mkdir(stagingDir, { recursive: true });
  let written: { fileSizeBytes: number; sha256: string };
  try {
    written = await writeUploadBodyToPath(req.body, stagingPath, maxFileBytes);
  } catch (err) {
    await rm(stagingDir, { force: true, recursive: true }).catch(() => undefined);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    if ((err as { code?: unknown })?.code === "manual_upload_too_large") {
      return await rejectManualUploadRequest(ctx, req, res, {
        connectorId: args.connectorId,
        errorCode: "import_file_too_large",
        httpStatus: 413,
        message: maxFileBytes
          ? `This connector accepts browser uploads up to ${maxFileBytes} bytes.`
          : "This import file is too large.",
        operation: args.operation,
        ownerSubjectId: args.ownerSubjectId,
        param: "import_file",
      });
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    if ((err as { code?: unknown })?.code === "import_file_required") {
      return await rejectManualUploadRequest(ctx, req, res, {
        connectorId: args.connectorId,
        errorCode: "import_file_required",
        httpStatus: 400,
        message: "A non-empty import file body must be provided.",
        operation: args.operation,
        ownerSubjectId: args.ownerSubjectId,
      });
    }
    throw err;
  }

  const validation = await validateStagedArtifact(
    { fileSha256: written.sha256, fileSizeBytes: written.fileSizeBytes, stagingPath },
    args.setup.validation?.kind ?? null,
    args.setup.validation?.fileBacked ?? false,
    fileName,
    maxFileBytes
  );
  if (validation && validation.status !== "valid") {
    await rm(stagingDir, { force: true, recursive: true }).catch(() => undefined);
    return await rejectManualUploadRequest(ctx, req, res, {
      connectorId: args.connectorId,
      errorCode: `import_file_${validation.status}`,
      httpStatus: validation.status === "too_large" ? 413 : 400,
      message: validation.remediation ?? "Choose a supported import file.",
      operation: args.operation,
      ownerSubjectId: args.ownerSubjectId,
      param: "import_file",
    });
  }
  return { fileName, fileSizeBytes: written.fileSizeBytes, sha256: written.sha256, stagingPath, validation };
}

function manualUploadTooLargeError(maxFileBytes: number): Error & { code?: string; maxFileBytes?: number } {
  const err = new Error(`Import file exceeds ${maxFileBytes} bytes.`) as Error & {
    code?: string;
    maxFileBytes?: number;
  };
  err.code = "manual_upload_too_large";
  err.maxFileBytes = maxFileBytes;
  return err;
}

function isAsyncIterableBody(value: unknown): value is AsyncIterable<Buffer | Uint8Array | string> {
  return Boolean(value && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function");
}

/**
 * Streams `body` to `path` (O_EXCL create, never overwrites), hashing and
 * byte-capping incrementally, and returns once the file is durably closed.
 *
 * The stream's own `'error'` event (ENOSPC, EIO, a permission revoked
 * mid-write, or the O_EXCL create itself failing with EEXIST) is caught via
 * `stream.finished()` from `node:stream/promises`, attached to `out`
 * IMMEDIATELY after creation -- before any `write()` call, and therefore
 * before any chance of a synchronous or near-synchronous error. This is not
 * a cosmetic detail: Node delivers a write-stream error to BOTH the
 * `end(callback)` completion callback AND as a standalone `'error'` event;
 * a stream with zero `'error'` listeners treats that event as an uncaught
 * exception regardless of whether some other code path also observed the
 * same failure via a callback. The prior version of this function only
 * awaited `end()`'s callback -- exactly the "handled by one path, still
 * uncaught via the other" shape -- verified directly against
 * `createWriteStream("/dev/full")`: the `end()` callback correctly received
 * ENOSPC AND a `process.on("uncaughtException", ...)` handler also fired
 * for the identical error, killing the process. `finished()` is Node's
 * documented single-settlement primitive for exactly this stream-lifecycle
 * class (it internally attaches the 'error'/'close'/'finish' listeners
 * itself and resolves/rejects exactly once), so it closes this class of bug
 * rather than working around one specific symptom.
 */
async function writeUploadBodyToPath(
  body: unknown,
  path: string,
  maxFileBytes: number | null
): Promise<{ fileSizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let fileSizeBytes = 0;
  const out = createWriteStream(path, { flags: "wx" });
  // Attached before any write -- see the doc comment above for why this
  // ordering is load-bearing, not stylistic.
  const settled = finished(out);
  let doneCleanly = false;
  try {
    const writeChunk = async (raw: Buffer | Uint8Array | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      fileSizeBytes += chunk.length;
      if (maxFileBytes !== null && fileSizeBytes > maxFileBytes) {
        throw manualUploadTooLargeError(maxFileBytes);
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        await once(out, "drain");
      }
    };

    if (isAsyncIterableBody(body)) {
      for await (const raw of body) {
        await writeChunk(raw);
      }
      // A genuinely empty stream (zero chunks, or chunks totaling zero
      // bytes) never trips writeChunk's own checks -- it just writes
      // nothing. Mirror the buffer path's explicit empty-body rejection so
      // both bodies of this shared primitive enforce the same contract;
      // without this, an empty streamed upload would silently "succeed"
      // with a zero-byte staged file instead of failing closed.
      if (fileSizeBytes === 0) {
        throw Object.assign(new Error("A non-empty import file body must be provided."), {
          code: "import_file_required",
        });
      }
    } else {
      const fileBytes = bodyAsBuffer(body);
      if (!(fileBytes && fileBytes.length > 0)) {
        throw Object.assign(new Error("A non-empty import file body must be provided."), {
          code: "import_file_required",
        });
      }
      await writeChunk(fileBytes);
    }

    out.end();
    await settled;
    doneCleanly = true;
    return { fileSizeBytes, sha256: hash.digest("hex") };
  } finally {
    if (!doneCleanly) {
      out.destroy();
      // `settled` has already rejected (a stream error) or will reject once
      // `destroy()`'s abort propagates; either way it must never be left
      // unawaited/unhandled here, or Node will report an unhandled
      // rejection for the SAME promise `finished()` already attached
      // listeners for.
      await settled.catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

function manualUploadArtifactNextStep(artifact: ManualUploadArtifact): Record<string, unknown> {
  const connectionId = artifact.connectorInstanceId ?? null;
  if (artifact.status === "staged" && connectionId) {
    return {
      kind: "run_connection",
      method: "POST",
      reason: "The import file is staged and ready to run.",
      url: `/_ref/connections/${encodeURIComponent(connectionId)}/run`,
    };
  }
  if (artifact.status === "duplicate" && connectionId) {
    return {
      kind: "show_status",
      method: "GET",
      reason: "This exact artifact is already known. Review the existing coverage receipt.",
      url: `/_ref/connections/${encodeURIComponent(connectionId)}/setup-status`,
    };
  }
  if (artifact.status === "failed") {
    return {
      kind: "choose_another_file",
      method: "GET",
      reason: "The import file failed validation.",
      url: `/_ref/connectors/${encodeURIComponent(artifact.connectorId)}/manual-upload-setup`,
    };
  }
  return {
    kind: "poll_artifact",
    method: "GET",
    reason: "The import file is uploaded and server-side validation is continuing.",
    url: `/_ref/manual-upload/artifacts/${encodeURIComponent(artifact.artifactId)}`,
  };
}

function publicArtifact(artifact: ManualUploadArtifact): Record<string, unknown> {
  const connectionId = artifact.connectorInstanceId ?? null;
  return {
    artifact_id: artifact.artifactId,
    batch_id: artifact.acquisitionBatchId ?? null,
    connection_id: connectionId,
    connector_id: artifact.connectorId,
    connector_instance_id: connectionId,
    error: artifact.error ?? null,
    file_name: artifact.fileName,
    next_step: manualUploadArtifactNextStep(artifact),
    object: "manual_upload_artifact",
    size_bytes: artifact.fileSizeBytes ?? null,
    status: artifact.status,
    validation: artifact.validation ?? null,
  };
}

async function createManualUploadDraftConnection(
  ctx: MountRefManualUploadDraftConnectionContext,
  args: {
    connectorId: string;
    displayName: string;
    ownerSubjectId: string;
    setup: NonNullable<ReturnType<typeof manualUploadSetupFromManifest>>;
  }
): Promise<{ connection: ConnectorInstance; importDir: string; sourceBindingKey: string }> {
  const store = ctx.createRequestConnectorInstanceStore();
  const sourceBindingKey = `manual_upload_draft_${randomBytes(24).toString("hex")}`;
  const importDir = join(ctx.importBaseDir, safePathSegment(args.connectorId), sourceBindingKey);

  const now = ctx.now ? ctx.now() : new Date().toISOString();
  await mkdir(importDir, { recursive: true });
  const connection = await store.upsert({
    connectorId: args.connectorId,
    createdAt: now,
    displayName: args.displayName,
    ownerSubjectId: args.ownerSubjectId,
    sourceBinding: {
      acquisition_method: "owner_artifact",
      import_dir: importDir,
      import_dir_env_var: args.setup.importDirEnvVar,
      kind: "manual_upload_draft",
      staged_upload: true,
    },
    sourceBindingKey,
    sourceKind: "manual",
    status: "draft",
    updatedAt: now,
  });
  return { connection, importDir, sourceBindingKey };
}

/**
 * Dispatches by the manifest's declared `validation.file_backed` capability,
 * never by `kind` itself: `fileBacked` routes through
 * validateManualUploadArtifactFromFileByKind (a caller-owned fd, never a
 * whole-file readFile); everything else stays on the buffer-based
 * validateManualUploadArtifactByKind path. This function has no knowledge of
 * which `kind` strings exist or which connector any of them names — both
 * dispatchers live in packages/polyfill-connectors/src/manual-upload-validation.ts,
 * the connector-owned registry that is the only place in the codebase
 * allowed to both know the `kind` space and import connector validation
 * modules directly.
 *
 * artifact.artifactSha256 was already computed while STREAMING the upload
 * to disk (writeUploadBodyToPath, hashed incrementally during the write) —
 * reused here rather than rehashing, so the file-backed path never reads
 * the whole artifact even to compute its own hash a second time.
 */
async function validateStagedArtifact(
  args: {
    fileSha256: string;
    fileSizeBytes: number | null;
    stagingPath: string;
  },
  kind: string | null,
  fileBacked: boolean,
  fileName: string,
  maxFileBytes: number | null
): Promise<ManualUploadValidationResult | null> {
  if (fileBacked) {
    const fileSize = args.fileSizeBytes ?? (await stat(args.stagingPath)).size;
    const fd = openSync(args.stagingPath, "r");
    try {
      return await validateManualUploadArtifactFromFileByKind(kind, fd, fileSize, {
        fileName,
        fileSha256: args.fileSha256,
        filePath: args.stagingPath,
        maxFileBytes,
      });
    } finally {
      closeSync(fd);
    }
  }
  const fileBytes = await readFile(args.stagingPath);
  return validateManualUploadArtifactByKind(kind, fileBytes, { fileName, maxFileBytes });
}

/**
 * Removes the whole per-artifact `_staging/<connectorId>/<artifactId>/`
 * directory, not just the uploaded file inside it -- `rm(stagingPath)`
 * alone leaves the now-empty directory behind forever (the same orphan bug
 * the successful rename() path already avoids by removing
 * `dirname(stagingPath)`; every terminal branch must do the same, not just
 * the success path). Best-effort: a cleanup failure must never fail the
 * artifact's own status transition.
 */
async function removeStagingArtifact(stagingPath: string): Promise<void> {
  await rm(dirname(stagingPath), { force: true, recursive: true }).catch(() => undefined);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: staging is the transaction boundary for validation, dedupe, target-source resolution, file movement, and artifact status updates.
async function validateAndStageArtifact(
  ctx: MountRefManualUploadDraftConnectionContext,
  args: {
    artifactId: string;
    connectorId: string;
    displayNameRaw?: string | null;
    fileName: string;
    manifest: ConnectorManifestLike;
    ownerSubjectId: string;
    setup: NonNullable<ReturnType<typeof manualUploadSetupFromManifest>>;
    targetConnectionId?: string | null;
  }
): Promise<void> {
  const artifactStore = ctx.createRequestManualUploadArtifactStore();
  const artifact = await artifactStore.get(args.artifactId);
  if (!artifact) {
    return;
  }
  await artifactStore.update(args.artifactId, { error: null, status: "validating" });
  try {
    const validation = await validateStagedArtifact(
      {
        fileSha256: artifact.artifactSha256 ?? "",
        fileSizeBytes: artifact.fileSizeBytes ?? null,
        stagingPath: artifact.stagingPath,
      },
      args.setup.validation?.kind ?? null,
      args.setup.validation?.fileBacked ?? false,
      args.fileName,
      args.setup.validation?.maxFileBytes ?? null
    );
    if (validation && validation.status !== "valid") {
      await artifactStore.update(args.artifactId, {
        error: {
          code: `import_file_${validation.status}`,
          message: validation.remediation ?? "Choose a supported import file.",
        },
        status: "failed",
        validation,
      });
      await removeStagingArtifact(artifact.stagingPath);
      return;
    }

    const acquisitionStore = ctx.createRequestAcquisitionBatchStore();
    if (validation?.file_sha256) {
      const existingBatch = await acquisitionStore.findByArtifactHash(
        args.ownerSubjectId,
        args.connectorId,
        validation.file_sha256
      );
      if (existingBatch) {
        await artifactStore.update(args.artifactId, {
          acquisitionBatchId: existingBatch.batchId,
          connectorInstanceId: existingBatch.connectorInstanceId,
          status: "duplicate",
          validation: {
            ...validation,
            remediation:
              validation.remediation ??
              "This file was already imported. Review the existing coverage receipt instead of running another import.",
            status: "duplicate",
          } as ManualUploadValidationResult,
        });
        await removeStagingArtifact(artifact.stagingPath);
        return;
      }
    }

    const targetConnection = args.targetConnectionId
      ? await loadManualUploadTargetConnection(ctx, {
          connectorId: args.connectorId,
          ownerSubjectId: args.ownerSubjectId,
          targetConnectionId: args.targetConnectionId,
        })
      : null;
    const connection =
      targetConnection === null
        ? {
            ...(await createManualUploadDraftConnection(ctx, {
              connectorId: args.connectorId,
              displayName: displayNameFromRequestedOrSuggested(
                args.displayNameRaw,
                validation,
                displayNameForConnector(args.connectorId, args.manifest)
              ),
              ownerSubjectId: args.ownerSubjectId,
              setup: args.setup,
            })),
            targetConnection: null,
          }
        : {
            connection: targetConnection,
            importDir: readImportDirFromConnection(targetConnection),
            targetConnection,
          };
    if (!connection.importDir) {
      throw Object.assign(
        new Error(`Connection '${args.targetConnectionId}' is missing a manual-upload import directory.`),
        {
          code: "manual_upload_connection_required",
        }
      );
    }
    const finalDir = join(connection.importDir, args.artifactId);
    await mkdir(finalDir, { recursive: true });
    const finalPath = join(finalDir, args.fileName);
    await rename(artifact.stagingPath, finalPath);
    // rename() moves the file out but leaves the now-empty per-artifact
    // _staging/<connectorId>/<artifactId>/ directory behind -- nothing else
    // ever removes it.
    await removeStagingArtifact(artifact.stagingPath);
    const batch = validation?.file_sha256
      ? await acquisitionStore.insertOwnerArtifactBatch({
          acquisitionMethod: "owner_artifact",
          artifactSha256: validation.file_sha256,
          connectorId: args.connectorId,
          connectorInstanceId: connection.connection.connectorInstanceId,
          eventTimeEnd: validation.date_range.end,
          eventTimeStart: validation.date_range.start,
          mediaCoverage: "media_coverage" in validation ? validation.media_coverage : null,
          ownerSubjectId: args.ownerSubjectId,
          parsedCount: parsedCountFromValidation(validation),
          parserVersion: args.manifest.version ?? null,
          receipt: receiptFromValidation(validation, args.fileName),
          sourceFormat: validation.detected_format,
          status: "validated",
          uploadedFileName: args.fileName,
          warnings: "warnings" in validation ? validation.warnings : [],
        })
      : null;

    await artifactStore.update(args.artifactId, {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      acquisitionBatchId: batch?.batchId ?? null,
      connectorInstanceId: connection.connection.connectorInstanceId,
      finalPath,
      status: "staged",
      validation,
    });
  } catch (err) {
    await artifactStore.update(args.artifactId, {
      error: {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        code: (err as { code?: unknown })?.code === "manual_upload_too_large" ? "import_file_too_large" : "api_error",
        message: err instanceof Error ? err.message : "Manual upload validation failed.",
      },
      status: "failed",
    });
    // A real error partway through this function (e.g. the target-
    // connection-required throw) previously left the staged file AND its
    // per-artifact directory behind with no cleanup at all -- unlike the
    // three success/failed/duplicate branches above. force:true makes this
    // a safe no-op if rename() already moved the file out before the error.
    await removeStagingArtifact(artifact.stagingPath);
  }
}

async function sendValidationPreviewResponse(
  ctx: MountRefManualUploadDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    acquisitionStore: AcquisitionBatchStore;
    connectorId: string;
    displayName: string;
    fileName: string;
    ownerSubjectId: string;
    validation: ManualUploadValidationResult | null;
  }
): Promise<void> {
  let duplicateBatch: AcquisitionBatch | null = null;
  if (args.validation?.file_sha256 && args.validation.status === "valid") {
    duplicateBatch = await args.acquisitionStore.findByArtifactHash(
      args.ownerSubjectId,
      args.connectorId,
      args.validation.file_sha256
    );
  }
  await emitManualUploadAudit(ctx, req, res, {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    connectionId: duplicateBatch?.connectorInstanceId ?? null,
    connectorId: args.connectorId,
    operation: "validate",
    outcome: "succeeded",
    ownerSubjectId: args.ownerSubjectId,
  });
  res.status(200).json({
    connector_id: args.connectorId,
    display_name: args.displayName,
    duplicate: duplicateBatch
      ? {
          batch_id: duplicateBatch.batchId,
          connection_id: duplicateBatch.connectorInstanceId,
          receipt: publicBatchReceipt(duplicateBatch),
          status: duplicateBatch.status,
        }
      : null,
    next_step: duplicateBatch
      ? {
          kind: "show_status",
          method: "GET",
          reason: "This exact artifact is already known. Review the existing coverage receipt.",
          url: `/_ref/connections/${encodeURIComponent(duplicateBatch.connectorInstanceId)}/setup-status`,
        }
      : {
          kind: "confirm_import",
          method: "POST",
          reason: "Review the preview, then import this file if it matches the source you expected.",
          url: `/_ref/connectors/${encodeURIComponent(args.connectorId)}/manual-upload-draft-connection`,
        },
    object: "manual_upload_validation_preview",
    uploaded_file_name: args.fileName,
    validation:
      duplicateBatch && args.validation
        ? {
            ...args.validation,
            remediation:
              args.validation.remediation ??
              "This exact file was already imported. Review the existing coverage receipt instead of importing it again.",
            status: "duplicate",
          }
        : args.validation,
  });
}

async function maybeSendKnownArtifactResponse(
  ctx: MountRefManualUploadDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    acquisitionStore: AcquisitionBatchStore;
    connectorId: string;
    displayName: string;
    fileName: string;
    ownerSubjectId: string;
    validation: ManualUploadValidationResult | null;
  }
): Promise<boolean> {
  if (!(args.validation?.file_sha256 && args.validation.status === "valid")) {
    return false;
  }
  const existingBatch = await args.acquisitionStore.findByArtifactHash(
    args.ownerSubjectId,
    args.connectorId,
    args.validation.file_sha256
  );
  if (!existingBatch) {
    return false;
  }
  await emitManualUploadAudit(ctx, req, res, {
    connectionId: existingBatch.connectorInstanceId,
    connectorId: args.connectorId,
    operation: "create",
    outcome: "succeeded",
    ownerSubjectId: args.ownerSubjectId,
  });
  res.status(200).json({
    batch_id: existingBatch.batchId,
    connection_id: existingBatch.connectorInstanceId,
    connector_id: args.connectorId,
    connector_instance_id: existingBatch.connectorInstanceId,
    display_name: args.displayName,
    next_step: {
      kind: "show_status",
      method: "GET",
      reason: "This exact artifact is already known. Review the existing coverage receipt.",
      url: `/_ref/connections/${encodeURIComponent(existingBatch.connectorInstanceId)}/setup-status`,
    },
    object: "manual_upload_known_artifact",
    receipt: publicBatchReceipt(existingBatch),
    status: existingBatch.status,
    uploaded_file_name: args.fileName,
    validation: {
      ...args.validation,
      remediation:
        args.validation.remediation ??
        "This file was already imported. Review the existing coverage receipt instead of running another import.",
      status: "duplicate",
    },
  });
  return true;
}

async function createAndSendDraftResponse(
  ctx: MountRefManualUploadDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    acquisitionStore: AcquisitionBatchStore;
    connectorId: string;
    displayName: string;
    fileName: string;
    manifest: ConnectorManifestLike;
    ownerSubjectId: string;
    setup: NonNullable<ReturnType<typeof manualUploadSetupFromManifest>>;
    stagingPath: string;
    targetConnectionId?: string | null;
    validation: ManualUploadValidationResult | null;
  }
): Promise<void> {
  const store = ctx.createRequestConnectorInstanceStore();
  const targetConnection = args.targetConnectionId
    ? await resolveManualUploadTargetConnection(ctx, req, res, {
        connectorId: args.connectorId,
        operation: "create",
        ownerSubjectId: args.ownerSubjectId,
        store,
        targetConnectionId: args.targetConnectionId,
      })
    : null;
  if (args.targetConnectionId && !targetConnection) {
    await removeStagingArtifact(args.stagingPath);
    return;
  }
  const sourceBindingKey =
    targetConnection?.sourceBindingKey ?? `manual_upload_draft_${randomBytes(24).toString("hex")}`;
  const importDir =
    readImportDirFromConnection(targetConnection) ??
    join(ctx.importBaseDir, safePathSegment(args.connectorId), sourceBindingKey);
  const now = ctx.now ? ctx.now() : new Date().toISOString();
  await mkdir(importDir, { recursive: true });
  // rename() is a same-filesystem metadata move (both stagingPath and
  // importDir live under ctx.importBaseDir), not a copy -- the staged bytes
  // are never re-read or re-written here, matching the staged-artifact
  // route's own rename()-out-of-staging pattern.
  await rename(args.stagingPath, join(importDir, args.fileName));
  await removeStagingArtifact(args.stagingPath);

  let instance: ConnectorInstance;
  if (targetConnection) {
    instance = targetConnection;
  } else {
    try {
      instance = await store.upsert({
        connectorId: args.connectorId,
        createdAt: now,
        displayName: args.displayName,
        ownerSubjectId: args.ownerSubjectId,
        sourceBinding: {
          acquisition_method: "owner_artifact",
          import_dir: importDir,
          import_dir_env_var: args.setup.importDirEnvVar,
          import_validation: args.validation,
          kind: "manual_upload_draft",
          uploaded_file_name: args.fileName,
        },
        sourceBindingKey,
        sourceKind: "manual",
        status: "draft",
        updatedAt: now,
      });
    } catch (err) {
      await rm(importDir, { force: true, recursive: true }).catch(() => undefined);
      throw err;
    }
  }

  const connectionId = instance.connectorInstanceId;
  const responseDisplayName = targetConnection?.displayName ?? args.displayName;
  const acquisitionBatch = args.validation?.file_sha256
    ? await args.acquisitionStore.insertOwnerArtifactBatch({
        acquisitionMethod: "owner_artifact",
        artifactSha256: args.validation.file_sha256,
        connectorId: args.connectorId,
        connectorInstanceId: connectionId,
        eventTimeEnd: args.validation.date_range.end,
        eventTimeStart: args.validation.date_range.start,
        mediaCoverage: "media_coverage" in args.validation ? args.validation.media_coverage : null,
        ownerSubjectId: args.ownerSubjectId,
        parsedCount: parsedCountFromValidation(args.validation),
        parserVersion: args.manifest.version ?? null,
        receipt: receiptFromValidation(args.validation, args.fileName),
        sourceFormat: args.validation.detected_format,
        status: "validated",
        uploadedFileName: args.fileName,
        warnings: "warnings" in args.validation ? args.validation.warnings : [],
      })
    : null;

  await emitManualUploadAudit(ctx, req, res, {
    connectionId,
    connectorId: args.connectorId,
    operation: "create",
    outcome: "succeeded",
    ownerSubjectId: args.ownerSubjectId,
  });
  res.status(201).json({
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    batch_id: acquisitionBatch?.batchId ?? null,
    connection_id: connectionId,
    connector_id: args.connectorId,
    connector_instance_id: connectionId,
    display_name: responseDisplayName,
    next_step: {
      kind: "run_connection",
      method: "POST",
      reason: targetConnection
        ? "Run this import for the existing manual-upload connection."
        : "Start the first sync for this manual-upload connection. The connection stays invisible until its first successful ingest.",
      url: `/_ref/connections/${encodeURIComponent(connectionId)}/run`,
    },
    object: "manual_upload_draft_connection",
    status: instance.status,
    uploaded_file_name: args.fileName,
    validation: args.validation,
  });
}

function readImportDirFromConnection(instance: ConnectorInstance | null): string | null {
  const binding = instance?.sourceBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return null;
  }
  return typeof binding.import_dir === "string" && binding.import_dir.length > 0 ? binding.import_dir : null;
}

async function resolveManualUploadTargetConnection(
  ctx: MountRefManualUploadDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectorId: string;
    ownerSubjectId: string;
    operation?: "create" | "validate" | undefined;
    store: ConnectorInstanceStore;
    targetConnectionId: string;
  }
): Promise<ConnectorInstance | null> {
  const instance = await args.store.get(args.targetConnectionId);
  if (!instance || instance.ownerSubjectId !== args.ownerSubjectId) {
    return await rejectManualUploadRequest(ctx, req, res, {
      connectorId: args.connectorId,
      errorCode: "connector_instance_not_found",
      httpStatus: 404,
      message: `Connection '${args.targetConnectionId}' does not exist for this owner.`,
      operation: args.operation,
      ownerSubjectId: args.ownerSubjectId,
      param: "connection_id",
    });
  }
  if (instance.connectorId !== args.connectorId) {
    return await rejectManualUploadRequest(ctx, req, res, {
      connectorId: args.connectorId,
      errorCode: "connector_instance_connector_mismatch",
      httpStatus: 409,
      message: `Connection '${args.targetConnectionId}' belongs to '${instance.connectorId}', not '${args.connectorId}'.`,
      operation: args.operation,
      ownerSubjectId: args.ownerSubjectId,
      param: "connection_id",
    });
  }
  if (!new Set(["active", "draft"]).has(instance.status)) {
    return await rejectManualUploadRequest(ctx, req, res, {
      connectorId: args.connectorId,
      errorCode: "connector_instance_inactive",
      httpStatus: 409,
      message: `Connection '${args.targetConnectionId}' is '${instance.status}', not active.`,
      operation: args.operation,
      ownerSubjectId: args.ownerSubjectId,
      param: "connection_id",
    });
  }
  if (instance.sourceKind !== "manual" || !readImportDirFromConnection(instance)) {
    return await rejectManualUploadRequest(ctx, req, res, {
      connectorId: args.connectorId,
      errorCode: "manual_upload_connection_required",
      httpStatus: 409,
      message: `Connection '${args.targetConnectionId}' is not a manual-upload connection.`,
      operation: args.operation,
      ownerSubjectId: args.ownerSubjectId,
      param: "connection_id",
    });
  }
  return instance;
}

async function loadManualUploadTargetConnection(
  ctx: MountRefManualUploadDraftConnectionContext,
  args: {
    connectorId: string;
    ownerSubjectId: string;
    targetConnectionId: string;
  }
): Promise<ConnectorInstance> {
  const instance = await ctx.createRequestConnectorInstanceStore().get(args.targetConnectionId);
  if (!instance || instance.ownerSubjectId !== args.ownerSubjectId) {
    throw Object.assign(new Error(`Connection '${args.targetConnectionId}' does not exist for this owner.`), {
      code: "connector_instance_not_found",
    });
  }
  if (instance.connectorId !== args.connectorId) {
    throw Object.assign(
      new Error(
        `Connection '${args.targetConnectionId}' belongs to '${instance.connectorId}', not '${args.connectorId}'.`
      ),
      { code: "connector_instance_connector_mismatch" }
    );
  }
  if (!new Set(["active", "draft"]).has(instance.status)) {
    throw Object.assign(new Error(`Connection '${args.targetConnectionId}' is '${instance.status}', not active.`), {
      code: "connector_instance_inactive",
    });
  }
  if (instance.sourceKind !== "manual" || !readImportDirFromConnection(instance)) {
    throw Object.assign(new Error(`Connection '${args.targetConnectionId}' is not a manual-upload connection.`), {
      code: "manual_upload_connection_required",
    });
  }
  return instance;
}

function mountGetSetup(app: AppLike, ctx: MountRefManualUploadDraftConnectionContext): void {
  app.get(
    "/_ref/connectors/:connectorId/manual-upload-setup",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      try {
        const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
        const setup = manualUploadSetupFromManifest(manifest);
        if (!setup?.importDirEnvVar) {
          ctx.pdppError(
            res,
            409,
            "manual_upload_unsupported",
            `Connector '${connectorId}' does not declare a supported manual/upload setup.`
          );
          return;
        }
        res.status(200).json({
          accepted_file_extensions: setup.acceptedFileExtensions,
          accepted_file_names: setup.acceptedFileNames,
          acquisition_methods: setup.acquisitionMethods.map((method) => ({
            detail: method.detail,
            help_url: method.helpUrl,
            label: method.label,
            platform: method.platform,
            posture: method.posture,
          })),
          connector_id: connectorId,
          description: setup.description,
          display_name: displayNameForConnector(connectorId, manifest),
          help_text: setup.helpText,
          help_url: setup.helpUrl,
          label: setup.label,
          large_file_fallback: setup.largeFileFallback,
          max_file_bytes: setup.validation?.maxFileBytes ?? null,
          object: "manual_upload_setup",
          validation_expectations: setup.validationExpectations,
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

function mountPostValidationPreview(app: AppLike, ctx: MountRefManualUploadDraftConnectionContext): void {
  app.post(
    "/_ref/connectors/:connectorId/manual-upload-validation-preview",
    { bodyLimit: manualUploadMaxBytes() },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      let ownerSubjectId: string | null = null;
      let stagingPath: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
        const setup = await requireManualUploadSetup(ctx, req, res, {
          connectorId,
          manifest,
          operation: "validate",
          ownerSubjectId,
        });
        if (!setup) {
          return;
        }
        if (req.is?.(MANUAL_UPLOAD_STREAM_CONTENT_TYPE) === false) {
          await rejectManualUploadRequest(ctx, req, res, {
            connectorId,
            errorCode: "manual_upload_stream_required",
            httpStatus: 415,
            message: `Use Content-Type: ${MANUAL_UPLOAD_STREAM_CONTENT_TYPE} for manual-upload previews.`,
            operation: "validate",
            ownerSubjectId,
            param: "content-type",
          });
          return;
        }
        const upload = await stageAcceptedUpload(ctx, req, res, {
          connectorId,
          operation: "validate",
          ownerSubjectId,
          setup,
        });
        if (!upload) {
          return;
        }
        stagingPath = upload.stagingPath;
        const targetConnectionId = optionalConnectionId(req);
        let targetConnection: ConnectorInstance | null = null;
        if (targetConnectionId) {
          targetConnection = await resolveManualUploadTargetConnection(ctx, req, res, {
            connectorId,
            operation: "validate",
            ownerSubjectId,
            store: ctx.createRequestConnectorInstanceStore(),
            targetConnectionId,
          });
          if (!targetConnection) {
            return;
          }
        }
        // A preview never keeps the staged bytes -- the response is built
        // entirely from `validation` (aggregates/metadata), never the file
        // content itself (see sendValidationPreviewResponse's own body: it
        // has no `fileBytes` field at all). Clean up staging unconditionally
        // once validation has produced its result, success or not.
        await sendValidationPreviewResponse(ctx, req, res, {
          acquisitionStore: ctx.createRequestAcquisitionBatchStore(),
          connectorId,
          displayName:
            targetConnection?.displayName ??
            requestedOrSuggestedDisplayName(req, upload.validation, displayNameForConnector(connectorId, manifest)),
          fileName: upload.fileName,
          ownerSubjectId,
          validation: upload.validation,
        });
      } catch (err) {
        ctx.handleError(res, err);
      } finally {
        if (stagingPath) {
          await removeStagingArtifact(stagingPath);
        }
      }
    }
  );
}

function mountGetStagedArtifact(app: AppLike, ctx: MountRefManualUploadDraftConnectionContext): void {
  app.get(
    "/_ref/manual-upload/artifacts/:artifactId",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const artifactId = decodeURIComponent(req.params.artifactId as string);
      let ownerSubjectId: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        if (!ARTIFACT_ID_RE.test(artifactId)) {
          ctx.pdppError(res, 404, "manual_upload_artifact_not_found", `Upload artifact '${artifactId}' was not found.`);
          return;
        }
        const artifact = await ctx.createRequestManualUploadArtifactStore().get(artifactId);
        if (!artifact || artifact.ownerSubjectId !== ownerSubjectId) {
          ctx.pdppError(res, 404, "manual_upload_artifact_not_found", `Upload artifact '${artifactId}' was not found.`);
          return;
        }
        res.status(200).json(publicArtifact(artifact));
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

function mountPostStagedArtifact(app: AppLike, ctx: MountRefManualUploadDraftConnectionContext): void {
  app.post(
    "/_ref/connectors/:connectorId/manual-upload-staged-artifact",
    { bodyLimit: manualUploadMaxBytes() },
    ctx.requireOwnerSession,
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this route coordinates streaming upload, owner target validation, staging, and async validation handoff in one request boundary.
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      let ownerSubjectId: string | null = null;
      let stagingPath: string | null = null;
      let maxFileBytesForError: number | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
        const setup = await requireManualUploadSetup(ctx, req, res, {
          connectorId,
          manifest,
          ownerSubjectId,
        });
        if (!setup) {
          return;
        }
        maxFileBytesForError = setup.validation?.maxFileBytes ?? null;
        if (req.is?.(MANUAL_UPLOAD_STREAM_CONTENT_TYPE) === false) {
          await rejectManualUploadRequest(ctx, req, res, {
            connectorId,
            errorCode: "manual_upload_stream_required",
            httpStatus: 415,
            message: `Use Content-Type: ${MANUAL_UPLOAD_STREAM_CONTENT_TYPE} for staged manual uploads.`,
            ownerSubjectId,
            param: "content-type",
          });
          return;
        }

        const fileName = normalizeFileName(firstQueryValue(req.query?.file_name));
        if (!fileName) {
          await rejectManualUploadRequest(ctx, req, res, {
            connectorId,
            errorCode: "import_file_name_rejected",
            httpStatus: 400,
            message: "A safe import file name is required.",
            ownerSubjectId,
            param: "file_name",
          });
          return;
        }
        if (!fileNameIsAccepted(fileName, setup.acceptedFileNames, setup.acceptedFileExtensions)) {
          await rejectManualUploadRequest(ctx, req, res, {
            connectorId,
            errorCode: "import_file_name_rejected",
            httpStatus: 400,
            message: acceptedFileMessage(fileName, setup.acceptedFileNames, setup.acceptedFileExtensions),
            ownerSubjectId,
            param: "file_name",
          });
          return;
        }

        const artifactId = `mua_${randomBytes(18).toString("base64url")}`;
        const stagingDir = join(ctx.importBaseDir, "_staging", safePathSegment(connectorId), artifactId);
        stagingPath = join(stagingDir, fileName);
        await mkdir(stagingDir, { recursive: true });
        const written = await writeUploadBodyToPath(req.body, stagingPath, setup.validation?.maxFileBytes ?? null);

        const rawDisplayName = firstQueryValue(req.query?.display_name);
        const targetConnectionId = optionalConnectionId(req);
        let targetConnection: ConnectorInstance | null = null;
        if (targetConnectionId) {
          targetConnection = await resolveManualUploadTargetConnection(ctx, req, res, {
            connectorId,
            operation: "create",
            ownerSubjectId,
            store: ctx.createRequestConnectorInstanceStore(),
            targetConnectionId,
          });
        }
        if (targetConnectionId && !targetConnection) {
          await rm(stagingDir, { force: true, recursive: true }).catch(() => undefined);
          return;
        }

        const artifact = await ctx.createRequestManualUploadArtifactStore().insert({
          artifactId,
          artifactSha256: written.sha256,
          connectorId,
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          connectorInstanceId: targetConnection?.connectorInstanceId ?? null,
          fileName,
          fileSizeBytes: written.fileSizeBytes,
          ownerSubjectId,
          stagingPath,
          status: "uploaded",
        });

        setImmediate(() => {
          validateAndStageArtifact(ctx, {
            artifactId,
            connectorId,
            displayNameRaw: rawDisplayName,
            fileName,
            manifest,
            ownerSubjectId: ownerSubjectId as string,
            setup,
            targetConnectionId,
          }).catch(() => undefined);
        });

        await emitManualUploadAudit(ctx, req, res, {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          connectionId: targetConnection?.connectorInstanceId ?? null,
          connectorId,
          operation: "create",
          outcome: "succeeded",
          ownerSubjectId,
        });
        res.status(202).json(publicArtifact(artifact));
      } catch (err) {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        if ((err as { code?: unknown })?.code === "manual_upload_too_large" && ownerSubjectId) {
          await rejectManualUploadRequest(ctx, req, res, {
            connectorId,
            errorCode: "import_file_too_large",
            httpStatus: 413,
            message: maxFileBytesForError
              ? `This connector accepts browser uploads up to ${maxFileBytesForError} bytes.`
              : "This import file is too large.",
            ownerSubjectId,
            param: "import_file",
          });
          return;
        }
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        if ((err as { code?: unknown })?.code === "import_file_required" && ownerSubjectId) {
          await rejectManualUploadRequest(ctx, req, res, {
            connectorId,
            errorCode: "import_file_required",
            httpStatus: 400,
            message: "A non-empty import file body must be provided.",
            ownerSubjectId,
            param: "import_file",
          });
          return;
        }
        if (stagingPath) {
          await rm(stagingPath, { force: true }).catch(() => undefined);
        }
        ctx.handleError(res, err);
      }
    }
  );
}

function mountPostDraftConnection(app: AppLike, ctx: MountRefManualUploadDraftConnectionContext): void {
  app.post(
    "/_ref/connectors/:connectorId/manual-upload-draft-connection",
    { bodyLimit: manualUploadMaxBytes() },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      let ownerSubjectId: string | null = null;
      let stagingPath: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
        const setup = await requireManualUploadSetup(ctx, req, res, {
          connectorId,
          manifest,
          ownerSubjectId,
        });
        if (!setup) {
          return;
        }
        if (req.is?.(MANUAL_UPLOAD_STREAM_CONTENT_TYPE) === false) {
          await rejectManualUploadRequest(ctx, req, res, {
            connectorId,
            errorCode: "manual_upload_stream_required",
            httpStatus: 415,
            message: `Use Content-Type: ${MANUAL_UPLOAD_STREAM_CONTENT_TYPE} for manual uploads.`,
            ownerSubjectId,
            param: "content-type",
          });
          return;
        }
        const upload = await stageAcceptedUpload(ctx, req, res, { connectorId, ownerSubjectId, setup });
        if (!upload) {
          return;
        }
        stagingPath = upload.stagingPath;

        const displayName = requestedOrSuggestedDisplayName(
          req,
          upload.validation,
          displayNameForConnector(connectorId, manifest)
        );
        const acquisitionStore = ctx.createRequestAcquisitionBatchStore();
        const known = await maybeSendKnownArtifactResponse(ctx, req, res, {
          acquisitionStore,
          connectorId,
          displayName,
          fileName: upload.fileName,
          ownerSubjectId,
          validation: upload.validation,
        });
        if (known) {
          // Already imported under this hash -- the newly-staged copy is
          // redundant, not a source of truth for anything. Cleaned up in
          // `finally` below like every other exit path.
          return;
        }
        // createAndSendDraftResponse takes ownership of stagingPath from
        // here: it rename()s it into the connection's real import
        // directory (or cleans it up itself if the target-connection
        // resolution fails) -- clear the local reference so this
        // function's `finally` does not ALSO try to remove a path that
        // either no longer exists (moved) or was already removed.
        stagingPath = null;
        await createAndSendDraftResponse(ctx, req, res, {
          acquisitionStore,
          connectorId,
          displayName,
          fileName: upload.fileName,
          manifest,
          ownerSubjectId,
          setup,
          stagingPath: upload.stagingPath,
          targetConnectionId: optionalConnectionId(req),
          validation: upload.validation,
        });
      } catch (err) {
        ctx.handleError(res, err);
      } finally {
        if (stagingPath) {
          await removeStagingArtifact(stagingPath);
        }
      }
    }
  );
}

function fileNameIsAccepted(
  fileName: string,
  acceptedNames: readonly string[],
  acceptedExtensions: readonly string[]
): boolean {
  const lower = fileName.toLowerCase();
  if (acceptedNames.length > 0 && new Set(acceptedNames.map((value) => value.toLowerCase())).has(lower)) {
    return true;
  }
  if (acceptedExtensions.length > 0 && acceptedExtensions.some((ext) => lower.endsWith(ext.toLowerCase()))) {
    return true;
  }
  return acceptedNames.length === 0 && acceptedExtensions.length === 0;
}

function acceptedFileMessage(
  fileName: string,
  acceptedNames: readonly string[],
  acceptedExtensions: readonly string[]
): string {
  const accepted = [
    ...acceptedNames,
    ...acceptedExtensions.map((extension) => `*${extension.startsWith(".") ? extension : `.${extension}`}`),
  ];
  return accepted.length > 0
    ? `File name '${fileName}' is not accepted. Expected: ${accepted.join(", ")}.`
    : `File name '${fileName}' is not accepted.`;
}

function parsedCountFromValidation(validation: ManualUploadValidationResult): number | null {
  if ("estimated_records" in validation && typeof validation.estimated_records === "number") {
    return validation.estimated_records;
  }
  if ("estimated_points" in validation && "estimated_segments" in validation) {
    return validation.estimated_points + validation.estimated_segments;
  }
  return null;
}

function receiptFromValidation(
  validation: ManualUploadValidationResult,
  uploadedFileName: string
): Record<string, unknown> {
  return {
    date_range: validation.date_range,
    detected_format: validation.detected_format,
    parsed_count: parsedCountFromValidation(validation),
    status: validation.status,
    uploaded_file_name: uploadedFileName,
    ...("estimated_points" in validation
      ? {
          estimated_points: validation.estimated_points,
          estimated_segments: validation.estimated_segments,
        }
      : {}),
    ...("estimated_messages" in validation
      ? {
          estimated_attachments: validation.estimated_attachments,
          estimated_chats: validation.estimated_chats,
          estimated_messages: validation.estimated_messages,
          estimated_participants: validation.estimated_participants,
        }
      : {}),
    ...("source_identity" in validation ? { source_identity: validation.source_identity } : {}),
  };
}

function publicBatchReceipt(batch: AcquisitionBatch): Record<string, unknown> {
  return {
    accepted_count: batch.acceptedCount ?? null,
    acquisition_method: "owner_artifact",
    batch_id: batch.batchId,
    date_range: {
      end: batch.eventTimeEnd ?? null,
      start: batch.eventTimeStart ?? null,
    },
    detected_format: batch.sourceFormat ?? null,
    duplicate_count: batch.duplicateCount ?? null,
    failed_count: batch.failedCount ?? null,
    media_coverage: batch.mediaCoverage ?? null,
    parsed_count: batch.parsedCount ?? null,
    skipped_count: batch.skippedCount ?? null,
    status: batch.status,
    uploaded_file_name: batch.uploadedFileName ?? null,
    warnings: batch.warnings ?? [],
  };
}

function firstQueryValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

function bodyAsBuffer(body: unknown): Buffer | null {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string" && body.length > 0) {
    return Buffer.from(body, "binary");
  }
  return null;
}

function normalizeFileName(raw: string | null | undefined): string | null {
  if (!raw || PATH_SEP_RE.test(raw)) {
    return null;
  }
  const clean = raw.replace(UNSAFE_FILENAME_CHARS_RE, "_").trim();
  return clean.length > 0 && clean !== "." && clean !== ".." ? clean : null;
}

function safePathSegment(raw: string): string {
  const segment = raw.replace(UNSAFE_FILENAME_CHARS_RE, "_").replace(PATH_SEP_RE, "_").trim();
  return segment.length > 0 ? segment : "connector";
}

/** Below this age, an in-flight artifact is assumed to still be owned by a
 *  live request/setImmediate callback on the CURRENT process -- sweeping it
 *  too eagerly would race a legitimately-still-running validation and fail
 *  it out from under itself. 10 minutes is generous relative to real
 *  upload/validation durations (even a multi-GB streamed upload plus
 *  validation completes in low minutes; see this task's report) while
 *  being short enough that a genuinely abandoned upload from a crashed
 *  process doesn't sit invisible for long. */
export const MANUAL_UPLOAD_IN_FLIGHT_STALE_MS = 10 * 60 * 1000;

/**
 * Crash/restart recovery (H5): terminalizes manual-upload artifacts left
 * stuck at `uploaded` or `validating` by a process that died mid-upload or
 * mid-validation (crash, OOM, `kill -9`, an unclean deploy restart) --
 * without this sweep, such a row sits in a non-terminal status FOREVER
 * (nothing else ever revisits it), and its staged file sits on disk
 * forever too, since only a completing validateAndStageArtifact call ever
 * cleans up staging.
 *
 * Mirrors reconcileOrphanedRunsAtBoot's shape (terminalize orphaned
 * in-flight state from a prior process incarnation, once, at startup,
 * before routes accept traffic) but is deliberately simpler: manual-upload
 * artifacts have no distributed run-tracking/spine-event coordination to
 * replay, just a DB row plus a staged file, so a single query + a bounded
 * per-row cleanup loop is the whole mechanism.
 *
 * Multi-process safety: `listInFlightOlderThan` alone is a read, not a
 * lease -- two server processes booting concurrently against the same DB
 * (or one process re-running this sweep) would both list the SAME stale
 * row and both blindly `update(...)` it, an unconditional write race with
 * no winner/loser distinction (whichever update lands last wins, but both
 * think they own the cleanup, and both would attempt
 * `removeStagingArtifact` on the same path -- harmless since it's
 * idempotent, but the DOUBLE-CLAIM itself is the actual defect: nothing
 * before this fix prevented it). `claimForSweep` closes this with an
 * atomic compare-and-swap UPDATE (`WHERE artifact_id = ? AND status IN
 * (in-flight) AND updated_at < cutoff`, executed by the SAME primitive
 * every other conditional row transition in this codebase already uses --
 * a WHERE-guarded UPDATE, checked by affected-row-count) that also bumps
 * `updated_at` to now on a win. Only the process whose UPDATE actually
 * matched (returns true) proceeds to terminalize + clean up that row; a
 * process that loses the race (0 rows affected, because a sibling already
 * claimed it and moved updated_at forward) skips it entirely rather than
 * re-terminalizing or re-deleting. Age (`staleMs`) alone never decides
 * ownership -- it only decides which rows are ELIGIBLE to be claimed; the
 * claim itself is what decides who owns the cleanup.
 *
 * Does NOT sweep orphaned `_staging/` entries that have no DB row at all
 * (a narrower crash window between the file write completing and the DB
 * insert committing) -- a disclosed residual, not silently unhandled: see
 * this task's report.
 */
export async function reconcileAbandonedManualUploadArtifactsAtBoot(
  ctx: Pick<MountRefManualUploadDraftConnectionContext, "createRequestManualUploadArtifactStore" | "now">,
  options: { staleMs?: number } = {}
): Promise<{ swept: number }> {
  const staleMs = options.staleMs ?? MANUAL_UPLOAD_IN_FLIGHT_STALE_MS;
  const nowIso = ctx.now ? ctx.now() : new Date().toISOString();
  const cutoffIso = new Date(new Date(nowIso).getTime() - staleMs).toISOString();
  const artifactStore = ctx.createRequestManualUploadArtifactStore();
  const stuck = await artifactStore.listInFlightOlderThan(cutoffIso);
  let swept = 0;
  for (const artifact of stuck) {
    // biome-ignore lint/performance/noAwaitInLoops: bounded, infrequent (startup-only) sweep; sequential updates keep each artifact's DB+disk cleanup atomic relative to the next.
    const claimed = await artifactStore.claimForSweep(artifact.artifactId, cutoffIso, nowIso);
    if (!claimed) {
      // Lost the race to a concurrent sweeper (another process, or a
      // second boot-time call): that owner is responsible for this row's
      // terminalization and staging cleanup now.
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: see above.
    await artifactStore.update(artifact.artifactId, {
      error: {
        code: "manual_upload_interrupted",
        message: "This import was interrupted by a server restart. Upload the file again to retry.",
      },
      status: "failed",
    });
    // biome-ignore lint/performance/noAwaitInLoops: see above.
    await removeStagingArtifact(artifact.stagingPath);
    swept += 1;
  }
  return { swept };
}

export function mountRefManualUploadDraftConnection(
  app: AppLike,
  ctx: MountRefManualUploadDraftConnectionContext
): void {
  mountGetSetup(app, ctx);
  mountGetStagedArtifact(app, ctx);
  mountPostStagedArtifact(app, ctx);
  mountPostValidationPreview(app, ctx);
  mountPostDraftConnection(app, ctx);
}
