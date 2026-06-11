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

import {
  type ConnectorManifestLike,
  displayNameForConnector,
  manualUploadSetupFromManifest,
} from "../connection-setup-plan.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

const PATH_SEP_RE = /[\\/]/;
const UNSAFE_FILENAME_CHARS_RE = /[^\w.-]/g;

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
  readonly status: string;
}

interface ConnectorInstanceStore {
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

export interface MountRefManualUploadDraftConnectionContext {
  canonicalConnectorKey(value: string | null | undefined): string | null;
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
    operation: "create";
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
          accepted_file_names: setup.acceptedFileNames,
          label: setup.label,
          description: setup.description,
          help_url: setup.helpUrl,
          help_text: setup.helpText,
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
        const setup = manualUploadSetupFromManifest(manifest);
        if (!setup?.importDirEnvVar) {
          await emitManualUploadAudit(ctx, req, res, {
            connectorId,
            error: errorWithCode("manual_upload_unsupported"),
            operation: "create",
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            409,
            "manual_upload_unsupported",
            `Connector '${connectorId}' does not declare a supported manual/upload setup.`
          );
          return;
        }

        const fileName = normalizeFileName(firstQueryValue(req.query?.file_name));
        if (!fileName) {
          await emitManualUploadAudit(ctx, req, res, {
            connectorId,
            error: errorWithCode("import_file_name_rejected"),
            operation: "create",
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(res, 400, "import_file_name_rejected", "A safe import file name is required.", "file_name");
          return;
        }

        const acceptedNames =
          setup.acceptedFileNames.length > 0
            ? new Set(setup.acceptedFileNames.map((value) => value.toLowerCase()))
            : null;
        if (acceptedNames && !acceptedNames.has(fileName.toLowerCase())) {
          await emitManualUploadAudit(ctx, req, res, {
            connectorId,
            error: errorWithCode("import_file_name_rejected"),
            operation: "create",
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            400,
            "import_file_name_rejected",
            `File name '${fileName}' is not accepted. Expected one of: ${setup.acceptedFileNames.join(", ")}.`,
            "file_name"
          );
          return;
        }

        const fileBytes = bodyAsBuffer(req.body);
        if (!fileBytes || fileBytes.length === 0) {
          await emitManualUploadAudit(ctx, req, res, {
            connectorId,
            error: errorWithCode("import_file_required"),
            operation: "create",
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(res, 400, "import_file_required", "A non-empty import file body must be provided.");
          return;
        }

        const sourceBindingKey = `manual_upload_draft_${randomBytes(24).toString("hex")}`;
        const displayName = displayNameForConnector(connectorId, manifest);
        const importDir = join(ctx.importBaseDir, safePathSegment(connectorId), sourceBindingKey);
        const now = ctx.now ? ctx.now() : new Date().toISOString();
        await mkdir(importDir, { recursive: true });
        await writeFile(join(importDir, fileName), fileBytes);

        let instance: ConnectorInstance;
        try {
          instance = await ctx.createRequestConnectorInstanceStore().upsert({
            ownerSubjectId,
            connectorId,
            displayName,
            status: "draft",
            sourceKind: "manual",
            sourceBindingKey,
            sourceBinding: {
              kind: "manual_upload_draft",
              import_dir: importDir,
              import_dir_env_var: setup.importDirEnvVar,
              uploaded_file_name: fileName,
            },
            createdAt: now,
            updatedAt: now,
          });
        } catch (err) {
          await rm(importDir, { force: true, recursive: true }).catch(() => undefined);
          throw err;
        }

        const connectionId = instance.connectorInstanceId;
        await emitManualUploadAudit(ctx, req, res, {
          connectionId,
          connectorId,
          operation: "create",
          outcome: "succeeded",
          ownerSubjectId,
        });
        res.status(201).json({
          object: "manual_upload_draft_connection",
          connection_id: connectionId,
          connector_instance_id: connectionId,
          connector_id: connectorId,
          display_name: displayName,
          status: "draft",
          uploaded_file_name: fileName,
          next_step: {
            kind: "run_connection",
            method: "POST",
            url: `/_ref/connections/${encodeURIComponent(connectionId)}/run`,
            reason:
              "Start the first sync for this manual-upload connection. The connection stays invisible until its first successful ingest.",
          },
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
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
  mountPostDraftConnection(app, ctx);
}
