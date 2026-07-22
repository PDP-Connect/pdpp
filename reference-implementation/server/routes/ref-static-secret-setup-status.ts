// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reference-only owner-session connection SETUP-STATUS read.
//
// A static-secret connection is born as an invisible `draft` connector instance
// that every connection read surface hides until first ingest flips it to
// `active` (add-static-secret-owner-session-connect-path Decision 1/2). That
// invisibility is correct for the connection surfaces, but it left the owner
// with no durable view of an in-flight setup after submit — the "invisible draft
// black hole" the owner-journey realignment plan Phase 2 / design Decision 12
// calls out.
//
// This route is the durable, owner-session-only read that makes pending setup
// visible. It resolves the draft (or freshly-active) connection by
// connector_instance_id, reads the non-secret setup evidence and the
// current/last run, and projects them through the pure
// `projectConnectionSetupStatus` module. It introduces NO new durable storage
// and NO parallel onboarding enum: the owner-facing `setup_state` projects onto
// the canonical `ConnectionHealthState` taxonomy.
//
// It is NOT an owner-agent bearer route: `requireOwnerSession` (cookie) gates it.
// It never accepts or returns a provider secret, owner/browser cookie, or
// grant-scoped bearer.

import {
  type ConnectionSetupKind,
  projectConnectionSetupStatus,
  type SetupStatusImportReceipt,
  type SetupStatusMaterialMetadata,
  type SetupStatusRun,
} from "../../runtime/static-secret-setup-status.ts";
import { type ConnectorManifestLike, staticSecretCredentialCaptureFromManifest } from "../connection-setup-plan.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt?: string | null;
  readonly displayName?: string | null;
  readonly sourceBinding?: unknown;
  readonly status: string;
  readonly updatedAt?: string | null;
}

interface ConnectorInstanceStore {
  get(connectorInstanceId: string): Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
  getActiveRun(
    connectorInstanceId: string
  ):
    | Promise<{ runId: string; connectorId: string; startedAt: string } | null>
    | { runId: string; connectorId: string; startedAt: string }
    | null;
}

interface CredentialMetadata {
  readonly capturedAt?: string | null;
  readonly credentialKind?: string | null;
  readonly present?: boolean;
  readonly rotatedAt?: string | null;
}

interface ConnectorInstanceCredentialStore {
  getMetadata(connectorInstanceId: string): Promise<CredentialMetadata | null> | CredentialMetadata | null;
}

interface AcquisitionBatch {
  readonly acceptedCount?: number | null;
  readonly batchId: string;
  readonly duplicateCount?: number | null;
  readonly eventTimeEnd?: string | null;
  readonly eventTimeStart?: string | null;
  readonly failedCount?: number | null;
  readonly mediaCoverage?: unknown;
  readonly parsedCount?: number | null;
  readonly receipt?: unknown;
  readonly skippedCount?: number | null;
  readonly sourceFormat?: string | null;
  readonly status: string;
  readonly uploadedFileName?: string | null;
  readonly warnings?: readonly string[] | null;
}

interface AcquisitionBatchStore {
  listByConnection(
    connectorInstanceId: string,
    options?: { readonly limit?: number }
  ): Promise<readonly AcquisitionBatch[]> | readonly AcquisitionBatch[];
}

interface ConnectorNamespace {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
}

export interface MountRefStaticSecretSetupStatusContext {
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createRequestAcquisitionBatchStore(): AcquisitionBatchStore;
  createRequestConnectorInstanceCredentialStore(): ConnectorInstanceCredentialStore;
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  getOwnerSubjectId(req: unknown): string;
  // Bounded lookup of the run.start event timestamp, used to prove whether a
  // terminal verification run belongs to the current credential rotation.
  getRunStartedAt(runId: string): Promise<string | null>;
  // Window-independent terminal status for a run by run_id: "failed" |
  // "completed" | "cancelled" | "abandoned" | null (still running / unknown).
  getRunTerminalStatus(runId: string): Promise<string | null>;
  handleError(res: unknown, err: unknown): void;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  resolveOwnerConnectorNamespace(
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly allowStatuses?: readonly string[];
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ): Promise<ConnectorNamespace>;
  resolveRegisteredConnectorManifest(connectorId: string): Promise<ConnectorManifestLike>;
}

// The non-secret manifest setup field flagged `identity: true` names the account
// label (e.g. mailbox) the owner typed at draft creation. Used only to read the
// stored non-secret identity value; it never touches the secret field.
function identityFieldName(manifest: ConnectorManifestLike): string | null {
  const capture = staticSecretCredentialCaptureFromManifest(manifest);
  if (!capture) {
    return null;
  }
  const field = capture.fields.find((candidate) => candidate.identity && !candidate.secret);
  return field?.name ?? null;
}

// Pull the non-secret setup fields out of the draft's source binding. The draft
// binding is `{ kind: "static_secret_draft", setup_fields: {...} }`; only the
// non-secret fields are ever stored there (the secret goes to the credential
// store), so this is safe to surface.
function setupFieldsFromBinding(sourceBinding: unknown): Record<string, unknown> | null {
  if (!sourceBinding || typeof sourceBinding !== "object" || Array.isArray(sourceBinding)) {
    return null;
  }
  const fields = (sourceBinding as { setup_fields?: unknown }).setup_fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return null;
  }
  return fields as Record<string, unknown>;
}

function bindingKind(sourceBinding: unknown): string | null {
  if (!sourceBinding || typeof sourceBinding !== "object" || Array.isArray(sourceBinding)) {
    return null;
  }
  const { kind } = (sourceBinding as { kind?: unknown });
  return typeof kind === "string" ? kind : null;
}

function setupKindForConnection(sourceBinding: unknown, manifest: ConnectorManifestLike): ConnectionSetupKind {
  const kind = bindingKind(sourceBinding);
  if (kind === "manual_upload" || kind === "manual_upload_draft") {
    return "manual_upload";
  }
  if (kind === "static_secret_draft") {
    return "static_secret";
  }
  // Active legacy sources created before the draft-binding setup path do not
  // carry `static_secret_draft`, but their connector manifest still owns the
  // credential-capture contract. Classify them from the manifest so repair
  // status can show stored credential evidence instead of falling back to
  // unknown setup material.
  if (staticSecretCredentialCaptureFromManifest(manifest)) {
    return "static_secret";
  }
  return "unknown";
}

function setupMaterialFromBinding(
  setupKind: ConnectionSetupKind,
  sourceBinding: unknown,
  credentialMeta: CredentialMetadata | null
): SetupStatusMaterialMetadata {
  if (setupKind === "manual_upload") {
    const uploaded =
      sourceBinding && typeof sourceBinding === "object"
        ? (sourceBinding as { uploaded_file_name?: unknown }).uploaded_file_name
        : null;
    return {
      kind: "manual_upload",
      label: typeof uploaded === "string" && uploaded.length > 0 ? `Import file (${uploaded})` : "Import file",
      present: true,
      capturedAt: null,
    };
  }
  if (setupKind === "static_secret") {
    return {
      kind: "static_secret",
      label: "Provider credential",
      present: credentialMeta?.present === true,
      capturedAt: credentialMeta?.rotatedAt ?? credentialMeta?.capturedAt ?? null,
    };
  }
  return { kind: "unknown", label: "Setup material", present: false, capturedAt: null };
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function importDateRange(value: unknown): { end: string | null; start: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const range = value as { end?: unknown; start?: unknown };
  const start = asStringOrNull(range.start);
  const end = asStringOrNull(range.end);
  return start === null && end === null ? null : { end, start };
}

// Build the owner-safe validation receipt from the manual-upload binding.
// The route deliberately copies only non-secret parser evidence plus the
// uploaded file name/acquisition method. It never returns import_dir,
// import_dir_env_var, file hashes, local paths, or uploaded contents.
function importReceiptFromBinding(
  setupKind: ConnectionSetupKind,
  sourceBinding: unknown
): SetupStatusImportReceipt | null {
  if (setupKind !== "manual_upload" || !sourceBinding || typeof sourceBinding !== "object") {
    return null;
  }
  const binding = sourceBinding as {
    acquisition_method?: unknown;
    import_validation?: unknown;
    uploaded_file_name?: unknown;
  };
  const validation =
    binding.import_validation &&
    typeof binding.import_validation === "object" &&
    !Array.isArray(binding.import_validation)
      ? (binding.import_validation as Record<string, unknown>)
      : null;
  if (!validation) {
    return null;
  }
  return {
    acquisitionMethod: asStringOrNull(binding.acquisition_method),
    dateRange: importDateRange(validation.date_range),
    detectedFormat: asStringOrNull(validation.detected_format),
    estimatedAttachments: asFiniteNumberOrNull(validation.estimated_attachments),
    estimatedChats: asFiniteNumberOrNull(validation.estimated_chats),
    estimatedMessages: asFiniteNumberOrNull(validation.estimated_messages),
    estimatedParticipants: asFiniteNumberOrNull(validation.estimated_participants),
    estimatedPoints: asFiniteNumberOrNull(validation.estimated_points),
    estimatedSegments: asFiniteNumberOrNull(validation.estimated_segments),
    mediaCoverage: validation.media_coverage ?? null,
    parsedCount: asFiniteNumberOrNull(validation.estimated_records),
    remediation: asStringOrNull(validation.remediation),
    status: asStringOrNull(validation.status),
    uploadedFileName: asStringOrNull(binding.uploaded_file_name),
    warnings: asStringArray(validation.warnings),
  };
}

function receiptObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function importReceiptFromBatch(batch: AcquisitionBatch | null): SetupStatusImportReceipt | null {
  if (!batch) {
    return null;
  }
  const receipt = receiptObject(batch.receipt);
  return {
    acquisitionMethod: "owner_artifact",
    acceptedCount: asFiniteNumberOrNull(batch.acceptedCount),
    batchId: batch.batchId,
    dateRange: {
      start: asStringOrNull(batch.eventTimeStart),
      end: asStringOrNull(batch.eventTimeEnd),
    },
    detectedFormat: asStringOrNull(batch.sourceFormat) ?? asStringOrNull(receipt.detected_format),
    duplicateCount: asFiniteNumberOrNull(batch.duplicateCount),
    estimatedAttachments: asFiniteNumberOrNull(receipt.estimated_attachments),
    estimatedChats: asFiniteNumberOrNull(receipt.estimated_chats),
    estimatedMessages: asFiniteNumberOrNull(receipt.estimated_messages),
    estimatedParticipants: asFiniteNumberOrNull(receipt.estimated_participants),
    estimatedPoints: asFiniteNumberOrNull(receipt.estimated_points),
    estimatedSegments: asFiniteNumberOrNull(receipt.estimated_segments),
    failedCount: asFiniteNumberOrNull(batch.failedCount),
    mediaCoverage: batch.mediaCoverage ?? null,
    parsedCount: asFiniteNumberOrNull(batch.parsedCount) ?? asFiniteNumberOrNull(receipt.parsed_count),
    skippedCount: asFiniteNumberOrNull(batch.skippedCount),
    status: asStringOrNull(batch.status),
    uploadedFileName: asStringOrNull(batch.uploadedFileName),
    warnings: asStringArray(batch.warnings),
  };
}

const TERMINAL_FAILURE = new Set(["failed", "cancelled", "abandoned"]);

// Resolve the run evidence for the setup-status projection.
//   - an in-flight run is the active-run row keyed on connector_instance_id;
//   - otherwise, if a run id is known (in-flight earlier, or supplied by the
//     owner surface that started the run), its terminal status answers whether
//     the first sync failed.
async function resolveRunEvidence(
  ctx: MountRefStaticSecretSetupStatusContext,
  store: ConnectorInstanceStore,
  connectorInstanceId: string,
  requestedRunId: string | null
): Promise<{ activeRun: SetupStatusRun | null; lastRun: SetupStatusRun | null }> {
  const active = await store.getActiveRun(connectorInstanceId);
  if (active) {
    return {
      activeRun: { runId: active.runId, status: "in_progress", startedAt: active.startedAt },
      lastRun: null,
    };
  }
  if (!requestedRunId) {
    return { activeRun: null, lastRun: null };
  }
  const terminal = await ctx.getRunTerminalStatus(requestedRunId);
  if (!terminal) {
    return { activeRun: null, lastRun: null };
  }
  const failed = TERMINAL_FAILURE.has(terminal);
  const startedAt = await ctx.getRunStartedAt(requestedRunId);
  return {
    activeRun: null,
    lastRun: {
      runId: requestedRunId,
      status: failed ? "failed" : terminal,
      failureReason: failed ? terminal : null,
      startedAt,
    },
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

interface ResolvedSetupStatusInstance {
  readonly instance: ConnectorInstanceRow;
  readonly namespace: ConnectorNamespace;
  readonly store: ConnectorInstanceStore;
}

async function resolveSetupStatusInstance(
  ctx: MountRefStaticSecretSetupStatusContext,
  req: RouteRequest,
  res: RouteResponse,
  connectorInstanceId: string
): Promise<ResolvedSetupStatusInstance | null> {
  const ownerSubjectId = ctx.getOwnerSubjectId(req);
  // Resolve the connection allowing `draft` so a not-yet-ingested setup is
  // visible to the owner; ownership is verified by the resolver. A foreign
  // or unknown id surfaces as connector_instance_not_found (404).
  const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
    ownerSubjectId,
    allowDefaultAccount: false,
    allowStatuses: ["active", "draft", "paused", "revoked"],
    connectorInstanceId,
  });
  const store = ctx.createRequestConnectorInstanceStore();
  const instance = await store.get(namespace.connectorInstanceId);
  if (!instance) {
    ctx.pdppError(res, 404, "connector_instance_not_found", `Connection '${connectorInstanceId}' does not exist.`);
    return null;
  }
  return { instance, namespace, store };
}

async function readCredentialMetadata(
  setupKind: ConnectionSetupKind,
  credentialStore: ConnectorInstanceCredentialStore,
  connectorInstanceId: string
): Promise<CredentialMetadata | null> {
  if (setupKind !== "static_secret") {
    return null;
  }
  return credentialStore.getMetadata(connectorInstanceId);
}

async function readLatestAcquisitionBatch(
  setupKind: ConnectionSetupKind,
  acquisitionStore: AcquisitionBatchStore,
  connectorInstanceId: string
): Promise<AcquisitionBatch | null> {
  if (setupKind !== "manual_upload") {
    return null;
  }
  const acquisitionBatches = await acquisitionStore.listByConnection(connectorInstanceId, { limit: 1 });
  return acquisitionBatches[0] ?? null;
}

function projectSetupStatus(
  ctx: MountRefStaticSecretSetupStatusContext,
  instance: ConnectorInstanceRow,
  manifest: ConnectorManifestLike,
  credentialMeta: CredentialMetadata | null,
  activeRun: SetupStatusRun | null,
  lastRun: SetupStatusRun | null,
  latestBatch: AcquisitionBatch | null,
  setupKind: ConnectionSetupKind
) {
  return projectConnectionSetupStatus({
    instance: {
      connectorInstanceId: instance.connectorInstanceId,
      connectorId: ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId,
      displayName: instance.displayName ?? null,
      status: instance.status,
      createdAt: instance.createdAt ?? null,
      updatedAt: instance.updatedAt ?? null,
      setupFields: setupFieldsFromBinding(instance.sourceBinding),
    },
    credential: credentialMeta
      ? {
          present: credentialMeta.present === true,
          credentialKind: credentialMeta.credentialKind ?? null,
          capturedAt: credentialMeta.capturedAt ?? null,
          rotatedAt: credentialMeta.rotatedAt ?? null,
        }
      : null,
    activeRun,
    lastRun,
    importReceipt: importReceiptFromBatch(latestBatch) ?? importReceiptFromBinding(setupKind, instance.sourceBinding),
    identityFieldName: identityFieldName(manifest),
    setupKind,
    setupMaterial: setupMaterialFromBinding(setupKind, instance.sourceBinding, credentialMeta),
  });
}

async function handleRefStaticSecretSetupStatus(
  req: RouteRequest,
  res: RouteResponse,
  ctx: MountRefStaticSecretSetupStatusContext
): Promise<void> {
  const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
  try {
    const resolved = await resolveSetupStatusInstance(ctx, req, res, connectorInstanceId);
    if (!resolved) {
      return;
    }
    const { instance, namespace, store } = resolved;
    const manifest = await ctx.resolveRegisteredConnectorManifest(instance.connectorId);
    const credentialStore = ctx.createRequestConnectorInstanceCredentialStore();
    const setupKind = setupKindForConnection(instance.sourceBinding, manifest);
    const credentialMeta = await readCredentialMetadata(setupKind, credentialStore, namespace.connectorInstanceId);
    const requestedRunId = firstQueryValue(req.query?.run_id);
    const { activeRun, lastRun } = await resolveRunEvidence(ctx, store, namespace.connectorInstanceId, requestedRunId);
    const acquisitionStore = ctx.createRequestAcquisitionBatchStore();
    const latestBatch = await readLatestAcquisitionBatch(setupKind, acquisitionStore, namespace.connectorInstanceId);

    const status = projectSetupStatus(
      ctx,
      instance,
      manifest,
      credentialMeta,
      activeRun,
      lastRun,
      latestBatch,
      setupKind
    );

    res.status(200).json(status);
  } catch (err) {
    ctx.handleError(res, err);
  }
}

// GET /_ref/connections/:connectorInstanceId/setup-status
//
// Owner-session-only. Projects the visible setup lifecycle for one connection
// (draft or active). No secret, uploaded file content, or internal path is
// accepted or returned.
export function mountRefStaticSecretSetupStatus(app: AppLike, ctx: MountRefStaticSecretSetupStatusContext): void {
  app.get(
    "/_ref/connections/:connectorInstanceId/setup-status",
    ctx.requireOwnerSession,
    (req: RouteRequest, res: RouteResponse) => handleRefStaticSecretSetupStatus(req, res, ctx)
  );
}
