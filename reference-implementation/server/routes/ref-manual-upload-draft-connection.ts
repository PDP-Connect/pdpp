// Reference-only owner-session manual/upload DRAFT-connection creation.
//
// File-import connectors declare setup.modality="manual_or_upload" and an
// import_dir_env_var in their manifest. The owner uploads one exported artifact;
// this route stores it under a connection-scoped import directory and creates
// an invisible draft connection. The run orchestrator later injects that
// directory as the connector-declared env var. First successful ingest flips
// the draft to active through the existing ingest lifecycle.

import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateGoogleMapsTimelineArtifact } from "../../../packages/polyfill-connectors/connectors/google_maps/validation.ts";
import { validateWhatsAppChatExportArtifact } from "../../../packages/polyfill-connectors/connectors/whatsapp/validation.ts";
import {
  type ConnectorManifestLike,
  displayNameForConnector,
  manualUploadSetupFromManifest,
} from "../connection-setup-plan.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

const PATH_SEP_RE = /[\\/]/;
const UNSAFE_FILENAME_CHARS_RE = /[^\w.-]/g;
const CONNECTION_ID_RE = /^cin_[A-Za-z0-9_-]+$/;

interface RouteRequest {
  readonly body?: unknown;
  ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  getHeader(name: string): string | number | string[] | undefined;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): void;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
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
  get(connectorInstanceId: string): Promise<ConnectorInstance | null> | ConnectorInstance | null;
  upsert(record: {
    ownerSubjectId: string;
    connectorId: string;
    displayName: string;
    status: string;
    sourceKind: string;
    sourceBindingKey: string;
    sourceBinding: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }): Promise<ConnectorInstance> | ConnectorInstance;
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
  findByArtifactHash(
    ownerSubjectId: string,
    connectorId: string,
    artifactSha256: string
  ): Promise<AcquisitionBatch | null> | AcquisitionBatch | null;
  insertOwnerArtifactBatch(record: {
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
  }): Promise<AcquisitionBatch> | AcquisitionBatch;
}

type GoogleMapsValidationResult = ReturnType<typeof validateGoogleMapsTimelineArtifact>;
type WhatsAppValidationResult = ReturnType<typeof validateWhatsAppChatExportArtifact>;
type ManualUploadValidationResult = GoogleMapsValidationResult | WhatsAppValidationResult;

export interface MountRefManualUploadDraftConnectionContext {
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createRequestAcquisitionBatchStore(): AcquisitionBatchStore;
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  getOwnerSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  importBaseDir: string;
  now?(): string;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  resolveRegisteredConnectorManifest(connectorId: string): Promise<ConnectorManifestLike>;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
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
    event_type: `owner.connection.manual_upload_draft.${args.operation}`,
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    request_id: trace.request_id,
    actor_type: "owner_session",
    actor_id: ownerSubjectId ?? "owner_session",
    subject_type: "subject",
    subject_id: ownerSubjectId,
    object_type: "connection",
    object_id: args.connectionId ?? "unknown_connection",
    status: args.outcome,
    data: {
      connection_id: args.connectionId ?? null,
      connector_id: args.connectorId ?? null,
      operation: args.operation,
      outcome: args.outcome,
      ...(args.error ? { error: { code: typeof code === "string" ? code : "api_error" } } : {}),
    },
  });
}

function errorWithCode(code: string): { code: string } {
  return { code };
}

function optionalConnectionId(req: RouteRequest): string | null {
  const raw = firstQueryValue(req.query?.connection_id);
  return raw && CONNECTION_ID_RE.test(raw) ? raw : null;
}

function requestedDisplayName(req: RouteRequest, fallback: string): string {
  const raw = firstQueryValue(req.query?.display_name);
  const clean = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return clean.length > 0 && clean.length <= 120 ? clean : fallback;
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

async function resolveAcceptedUpload(
  ctx: MountRefManualUploadDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectorId: string;
    operation?: "create" | "validate" | undefined;
    ownerSubjectId: string | null;
    setup: NonNullable<ReturnType<typeof manualUploadSetupFromManifest>>;
  }
): Promise<{ fileBytes: Buffer; fileName: string; validation: ManualUploadValidationResult | null } | null> {
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
  const fileBytes = bodyAsBuffer(req.body);
  if (!(fileBytes && fileBytes.length > 0)) {
    return await rejectManualUploadRequest(ctx, req, res, {
      connectorId: args.connectorId,
      errorCode: "import_file_required",
      httpStatus: 400,
      message: "A non-empty import file body must be provided.",
      operation: args.operation,
      ownerSubjectId: args.ownerSubjectId,
    });
  }
  const validation = validateManualUploadArtifact(args.setup.validation?.kind ?? null, fileBytes, {
    fileName,
    maxFileBytes: args.setup.validation?.maxFileBytes ?? null,
  });
  if (validation && validation.status !== "valid") {
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
  return { fileBytes, fileName, validation };
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
    connectionId: duplicateBatch?.connectorInstanceId ?? null,
    connectorId: args.connectorId,
    operation: "validate",
    outcome: "succeeded",
    ownerSubjectId: args.ownerSubjectId,
  });
  res.status(200).json({
    object: "manual_upload_validation_preview",
    connector_id: args.connectorId,
    display_name: args.displayName,
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
          url: `/_ref/connections/${encodeURIComponent(duplicateBatch.connectorInstanceId)}/setup-status`,
          reason: "This exact artifact is already known. Review the existing coverage receipt.",
        }
      : {
          kind: "confirm_import",
          method: "POST",
          url: `/_ref/connectors/${encodeURIComponent(args.connectorId)}/manual-upload-draft-connection`,
          reason: "Review the preview, then import this file if it matches the source you expected.",
        },
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
    object: "manual_upload_known_artifact",
    batch_id: existingBatch.batchId,
    connection_id: existingBatch.connectorInstanceId,
    connector_instance_id: existingBatch.connectorInstanceId,
    connector_id: args.connectorId,
    display_name: args.displayName,
    status: existingBatch.status,
    validation: {
      ...args.validation,
      remediation:
        args.validation.remediation ??
        "This file was already imported. Review the existing coverage receipt instead of running another import.",
      status: "duplicate",
    },
    uploaded_file_name: args.fileName,
    receipt: publicBatchReceipt(existingBatch),
    next_step: {
      kind: "show_status",
      method: "GET",
      url: `/_ref/connections/${encodeURIComponent(existingBatch.connectorInstanceId)}/setup-status`,
      reason: "This exact artifact is already known. Review the existing coverage receipt.",
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
    fileBytes: Buffer;
    fileName: string;
    manifest: ConnectorManifestLike;
    ownerSubjectId: string;
    setup: NonNullable<ReturnType<typeof manualUploadSetupFromManifest>>;
    targetConnectionId?: string | null;
    validation: ManualUploadValidationResult | null;
  }
): Promise<void> {
  const store = ctx.createRequestConnectorInstanceStore();
  const targetConnection = args.targetConnectionId
    ? await resolveManualUploadTargetConnection(ctx, req, res, {
        connectorId: args.connectorId,
        ownerSubjectId: args.ownerSubjectId,
        operation: "create",
        store,
        targetConnectionId: args.targetConnectionId,
      })
    : null;
  if (args.targetConnectionId && !targetConnection) {
    return;
  }
  const sourceBindingKey =
    targetConnection?.sourceBindingKey ?? `manual_upload_draft_${randomBytes(24).toString("hex")}`;
  const importDir =
    readImportDirFromConnection(targetConnection) ??
    join(ctx.importBaseDir, safePathSegment(args.connectorId), sourceBindingKey);
  const now = ctx.now ? ctx.now() : new Date().toISOString();
  await mkdir(importDir, { recursive: true });
  await writeFile(join(importDir, args.fileName), args.fileBytes);

  let instance: ConnectorInstance;
  if (targetConnection) {
    instance = targetConnection;
  } else {
    try {
      instance = await store.upsert({
        ownerSubjectId: args.ownerSubjectId,
        connectorId: args.connectorId,
        displayName: args.displayName,
        status: "draft",
        sourceKind: "manual",
        sourceBindingKey,
        sourceBinding: {
          kind: "manual_upload_draft",
          import_dir: importDir,
          import_dir_env_var: args.setup.importDirEnvVar,
          import_validation: args.validation,
          acquisition_method: "owner_artifact",
          uploaded_file_name: args.fileName,
        },
        createdAt: now,
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
    object: "manual_upload_draft_connection",
    connection_id: connectionId,
    connector_instance_id: connectionId,
    connector_id: args.connectorId,
    display_name: responseDisplayName,
    status: instance.status,
    batch_id: acquisitionBatch?.batchId ?? null,
    validation: args.validation,
    uploaded_file_name: args.fileName,
    next_step: {
      kind: "run_connection",
      method: "POST",
      url: `/_ref/connections/${encodeURIComponent(connectionId)}/run`,
      reason: targetConnection
        ? "Run this import for the existing manual-upload connection."
        : "Start the first sync for this manual-upload connection. The connection stays invisible until its first successful ingest.",
    },
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
          object: "manual_upload_setup",
          connector_id: connectorId,
          display_name: displayNameForConnector(connectorId, manifest),
          acquisition_methods: setup.acquisitionMethods.map((method) => ({
            detail: method.detail,
            help_url: method.helpUrl,
            label: method.label,
            platform: method.platform,
            posture: method.posture,
          })),
          accepted_file_extensions: setup.acceptedFileExtensions,
          accepted_file_names: setup.acceptedFileNames,
          label: setup.label,
          description: setup.description,
          help_url: setup.helpUrl,
          help_text: setup.helpText,
          large_file_fallback: setup.largeFileFallback,
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
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      let ownerSubjectId: string | null = null;
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
        const upload = await resolveAcceptedUpload(ctx, req, res, {
          connectorId,
          operation: "validate",
          ownerSubjectId,
          setup,
        });
        if (!upload) {
          return;
        }
        const targetConnectionId = optionalConnectionId(req);
        if (targetConnectionId) {
          const targetConnection = await resolveManualUploadTargetConnection(ctx, req, res, {
            connectorId,
            ownerSubjectId,
            operation: "validate",
            store: ctx.createRequestConnectorInstanceStore(),
            targetConnectionId,
          });
          if (!targetConnection) {
            return;
          }
        }
        await sendValidationPreviewResponse(ctx, req, res, {
          acquisitionStore: ctx.createRequestAcquisitionBatchStore(),
          connectorId,
          displayName: requestedDisplayName(req, displayNameForConnector(connectorId, manifest)),
          fileName: upload.fileName,
          ownerSubjectId,
          validation: upload.validation,
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

function mountPostDraftConnection(app: AppLike, ctx: MountRefManualUploadDraftConnectionContext): void {
  app.post(
    "/_ref/connectors/:connectorId/manual-upload-draft-connection",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      let ownerSubjectId: string | null = null;
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
        const upload = await resolveAcceptedUpload(ctx, req, res, { connectorId, ownerSubjectId, setup });
        if (!upload) {
          return;
        }

        const displayName = requestedDisplayName(req, displayNameForConnector(connectorId, manifest));
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
          return;
        }
        await createAndSendDraftResponse(ctx, req, res, {
          acquisitionStore,
          connectorId,
          displayName,
          fileBytes: upload.fileBytes,
          fileName: upload.fileName,
          manifest,
          ownerSubjectId,
          setup,
          targetConnectionId: optionalConnectionId(req),
          validation: upload.validation,
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

function validateManualUploadArtifact(
  kind: string | null,
  fileBytes: Buffer,
  options: { fileName?: string | null; maxFileBytes: number | null }
): ManualUploadValidationResult | null {
  // The validator is selected by connector-authored manifest metadata so Console
  // stays connector-generic while Timeline gets pre-ingest evidence.
  if (kind === "google_maps_timeline") {
    return validateGoogleMapsTimelineArtifact(fileBytes, { maxFileBytes: options.maxFileBytes });
  }
  if (kind === "whatsapp_chat_export") {
    return validateWhatsAppChatExportArtifact(fileBytes, {
      fileName: options.fileName ?? null,
      maxFileBytes: options.maxFileBytes,
    });
  }
  return null;
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
  };
}

function publicBatchReceipt(batch: AcquisitionBatch): Record<string, unknown> {
  return {
    batch_id: batch.batchId,
    acquisition_method: "owner_artifact",
    date_range: {
      start: batch.eventTimeStart ?? null,
      end: batch.eventTimeEnd ?? null,
    },
    detected_format: batch.sourceFormat ?? null,
    parsed_count: batch.parsedCount ?? null,
    accepted_count: batch.acceptedCount ?? null,
    duplicate_count: batch.duplicateCount ?? null,
    skipped_count: batch.skippedCount ?? null,
    failed_count: batch.failedCount ?? null,
    media_coverage: batch.mediaCoverage ?? null,
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

export function mountRefManualUploadDraftConnection(
  app: AppLike,
  ctx: MountRefManualUploadDraftConnectionContext
): void {
  mountGetSetup(app, ctx);
  mountPostValidationPreview(app, ctx);
  mountPostDraftConnection(app, ctx);
}
