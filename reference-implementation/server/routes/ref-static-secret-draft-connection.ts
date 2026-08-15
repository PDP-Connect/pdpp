// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reference-only owner-session static-secret DRAFT-connection creation.
//
// This is the owner-trusted surface that creates the FIRST connection for a
// static-secret connector without writing a phantom active zero-record row. It
// creates a `draft` connector instance — a real row that is
// invisible to every connection read surface — and points the owner at the
// existing capture route to seal the credential. The draft flips to `active`
// only on its first successful ingest (handled at the RS ingest boundary).
//
// It is NOT an owner-agent bearer route: `requireOwnerSession` (cookie) gates
// it, and it never accepts or returns a provider secret. Non-static-secret
// connectors are refused. Manifest-declared identities get a deterministic
// draft binding key so retries converge; connectors without a safe identity
// retain a random key so distinct accounts cannot be collapsed.

import { randomBytes } from "node:crypto";

import { credentialValidationMode } from "../../../packages/polyfill-connectors/src/credential-probe.ts";
import {
  type ConnectorManifestLike,
  displayNameForConnector,
  expectedStaticSecretCredentialKind,
  type StaticSecretSetupField,
  staticSecretCredentialCaptureFromManifest,
} from "../connection-setup-plan.ts";
import {
  findExistingStaticSecretIdentity,
  parseStaticSecretDraftSetupFields,
  staticSecretDraftIdentityBindingKey,
  staticSecretSetupIdentity,
} from "../static-secret-identity.ts";
import {
  CREDENTIAL_ENCRYPTION_KEY_ENV,
  CREDENTIAL_ENCRYPTION_KEY_FILE_ENV,
  isCredentialEncryptionConfigured,
} from "../stores/credential-encryption.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  readonly body?: unknown;
  ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
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
  readonly ownerSubjectId: string;
  readonly sourceBinding?: unknown;
  readonly sourceBindingKey?: string;
  readonly status: string;
}

interface ConnectorInstanceStore {
  getByBinding: (input: {
    ownerSubjectId: string;
    connectorId: string;
    sourceKind: string;
    sourceBindingKey: string;
  }) => Promise<ConnectorInstance | null> | ConnectorInstance | null;
  listActiveByConnector: (
    ownerSubjectId: string,
    connectorId: string,
    options?: { limit?: number }
  ) => Promise<ConnectorInstance[]> | ConnectorInstance[];
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

// The binding `createDraftConnection` below writes at draft-creation time.
export interface StaticSecretDraftSourceBinding {
  readonly kind: "static_secret_draft";
  readonly setup_fields: Record<string, string>;
  readonly verified_identity?: string;
}

// The credential itself lives in connector-instance-credential-store, never
// in this binding; setup_fields (non-secret manifest fields) is read on
// every credential probe and run, so it must survive promotion.
export interface StaticSecretDurableSourceBinding {
  readonly kind: "static_secret";
  readonly promoted_at: string;
  readonly promoted_from: "static_secret_draft";
  readonly setup_fields: Record<string, string>;
  readonly verified_identity?: string;
}

// Pure — no I/O.
export function promoteStaticSecretDraftBinding(
  draftBinding: StaticSecretDraftSourceBinding,
  now: string
): StaticSecretDurableSourceBinding {
  return {
    kind: "static_secret",
    promoted_at: now,
    promoted_from: "static_secret_draft",
    setup_fields: draftBinding.setup_fields,
    ...(draftBinding.verified_identity ? { verified_identity: draftBinding.verified_identity } : {}),
  };
}

interface ParsedDisplayName {
  readonly displayName: string | null;
  readonly ok: true;
}

interface InvalidDisplayName {
  readonly error: {
    readonly message: string;
    readonly param: "display_name";
  };
  readonly ok: false;
}

export interface MountRefStaticSecretDraftConnectionContext {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  createRequestConnectorInstanceStore: () => ConnectorInstanceStore;
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  ensureRequestId: (res: RouteResponse) => string;
  getOwnerSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  now?: () => string;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  // Resolves a registered connector manifest, throwing a typed not_found when
  // the connector is unknown. Used only to reject an unknown connector id with
  // 404 before creating a draft.
  resolveRegisteredConnectorManifest: (connectorId: string) => Promise<ConnectorManifestLike>;
  setReferenceTraceId: (res: RouteResponse, traceId: string) => void;
}

function errWithCode(code: string): { code: string } {
  return { code };
}

function buildAuditTrace(ctx: MountRefStaticSecretDraftConnectionContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return {
    request_id: requestId,
    scenario_id: trace.scenario_id,
    trace_id: trace.trace_id,
  };
}

function staticSecretDeploymentReadiness(): Record<string, unknown> {
  if (isCredentialEncryptionConfigured()) {
    return {
      blockers: [],
      guidance: null,
      state: "ready",
    };
  }
  return {
    blockers: [
      {
        key: CREDENTIAL_ENCRYPTION_KEY_ENV,
        label: "Credential encryption key",
        secret: true,
      },
      {
        key: CREDENTIAL_ENCRYPTION_KEY_FILE_ENV,
        label: "Credential encryption key file",
        secret: true,
      },
    ],
    guidance:
      "Configure the instance-level credential key provider before entering a provider credential. Railway templates should generate PDPP_CREDENTIAL_ENCRYPTION_KEY automatically; Docker operators can mount a secret file and set PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE.",
    state: "needs_config",
  };
}

function staticSecretSetupErrorMessage(): string {
  return (
    `Credential encryption is required but neither ${CREDENTIAL_ENCRYPTION_KEY_ENV} nor ` +
    `${CREDENTIAL_ENCRYPTION_KEY_FILE_ENV} is configured. Configure the instance-level key provider before capturing static-secret credentials. No draft connection or plaintext credential was stored.`
  );
}

function projectField(field: StaticSecretSetupField): Record<string, unknown> {
  return {
    autocomplete: field.autocomplete,
    description: field.description,
    help_text: field.helpText,
    help_url: field.helpUrl,
    identity: field.identity,
    label: field.label,
    name: field.name,
    placeholder: field.placeholder,
    required: field.required,
    secret: field.secret,
    type: field.type,
  };
}

function projectSetup(connectorId: string, manifest: ConnectorManifestLike): Record<string, unknown> | null {
  const capture = staticSecretCredentialCaptureFromManifest(manifest);
  const credentialKind = expectedStaticSecretCredentialKind(connectorId, manifest);
  if (!(capture && credentialKind)) {
    return null;
  }
  const displayName = displayNameForConnector(connectorId, manifest);
  return {
    connector_id: connectorId,
    credential_capture: {
      description: capture.description,
      fields: capture.fields.map(projectField),
      kind: capture.kind,
      label: capture.label,
      required: capture.required,
      submit_label: capture.submitLabel,
    },
    credential_kind: credentialKind,
    deployment_readiness: staticSecretDeploymentReadiness(),
    display_name: displayName,
    object: "static_secret_setup",
    // Whether the credential is validated synchronously at capture (a registry
    // connector with a `probeCredential` hook echoes the account identity in
    // ≤10s) or only at first sync. Owner-generic; drives the Console form's
    // validate-then-activate flow with no connector-specific branch.
    validation: credentialValidationMode(connectorId),
  };
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function parseDisplayNameText(raw: string): ParsedDisplayName | InvalidDisplayName {
  const displayName = raw.trim();
  if (!displayName) {
    return {
      displayName: null,
      ok: true,
    };
  }
  if (displayName.length > 200) {
    return {
      error: { message: "display_name must be 200 characters or fewer", param: "display_name" },
      ok: false,
    };
  }
  return { displayName, ok: true };
}

function parseDisplayNameValue(raw: unknown): ParsedDisplayName | InvalidDisplayName {
  if (raw === null || raw === undefined) {
    return { displayName: null, ok: true };
  }
  if (typeof raw !== "string") {
    return {
      error: { message: "display_name must be a string when provided", param: "display_name" },
      ok: false,
    };
  }
  return parseDisplayNameText(raw);
}

function parseOptionalDisplayName(body: unknown): ParsedDisplayName | InvalidDisplayName {
  const objectBody = bodyRecord(body);
  if (!Object.hasOwn(objectBody, "display_name")) {
    return { displayName: null, ok: true };
  }
  return parseDisplayNameValue(objectBody.display_name);
}

interface ParsedDraftSetup {
  readonly displayName: string | null;
  readonly setupFields: Record<string, string>;
}

function parseDraftSetup(
  ctx: MountRefStaticSecretDraftConnectionContext,
  res: RouteResponse,
  body: unknown,
  fields: readonly StaticSecretSetupField[]
): ParsedDraftSetup | null {
  const objectBody = bodyRecord(body);
  const setupFields = parseStaticSecretDraftSetupFields(objectBody.setup_fields, fields, (code, message, param) =>
    ctx.pdppError(res, 400, code, message, param)
  );
  if (setupFields === null) {
    return null;
  }

  const parsedDisplayName = parseOptionalDisplayName(body);
  if (!parsedDisplayName.ok) {
    ctx.pdppError(res, 400, "invalid_request", parsedDisplayName.error.message, parsedDisplayName.error.param);
    return null;
  }
  return { displayName: parsedDisplayName.displayName, setupFields };
}

async function emitDraftAudit(
  ctx: MountRefStaticSecretDraftConnectionContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorId?: string | null;
    credentialKind?: string | null;
    error?: unknown;
    outcome: "succeeded" | "failed";
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
      credential_kind: args.credentialKind ?? null,
      operation: "create_static_secret_draft_connection",
      outcome: args.outcome,
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
            },
          }
        : {}),
    },
    event_type: "owner.connection.static_secret_draft.create",
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

function createDraftConnection(
  ctx: MountRefStaticSecretDraftConnectionContext,
  input: {
    connectorId: string;
    manifest: ConnectorManifestLike;
    captureSetup: NonNullable<ReturnType<typeof staticSecretCredentialCaptureFromManifest>>;
    displayName: string | null;
    setupFields: Record<string, string>;
    ownerSubjectId: string;
  }
): { displayName: string; instance: ReturnType<ConnectorInstanceStore["upsert"]> } {
  const now = ctx.now ? ctx.now() : new Date().toISOString();
  const store = ctx.createRequestConnectorInstanceStore();
  const idValue = staticSecretSetupIdentity(input.captureSetup.fields, input.setupFields);
  const sourceBindingKey =
    staticSecretDraftIdentityBindingKey(input.ownerSubjectId, input.connectorId, idValue ?? "") ||
    `draft_${randomBytes(24).toString("hex")}`;
  const fallbackDisplayName = idValue
    ? `${displayNameForConnector(input.connectorId, input.manifest)} - ${idValue}`
    : displayNameForConnector(input.connectorId, input.manifest);
  const displayName = input.displayName ?? fallbackDisplayName;
  const instance = store.upsert({
    connectorId: input.connectorId,
    createdAt: now,
    displayName,
    ownerSubjectId: input.ownerSubjectId,
    sourceBinding: { kind: "static_secret_draft", setup_fields: input.setupFields },
    sourceBindingKey,
    sourceKind: "account",
    status: "draft",
    updatedAt: now,
  });
  return { displayName, instance };
}

// POST /_ref/connectors/:connectorId/draft-connection
//
// Owner-session-only. Creates one invisible `draft` connection for a
// static-secret connector and returns its `connection_id` plus a typed next
// step pointing at the capture route. No secret is accepted or returned.
export function mountRefStaticSecretDraftConnection(
  app: AppLike,
  ctx: MountRefStaticSecretDraftConnectionContext
): void {
  app.get(
    "/_ref/connectors/:connectorId/static-secret-setup",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      try {
        const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
        const setup = projectSetup(connectorId, manifest);
        if (!setup) {
          ctx.pdppError(
            res,
            409,
            "static_secret_credential_unsupported",
            `Connector '${connectorId}' is not a static-secret connector.`
          );
          return;
        }
        res.status(200).json(setup);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );

  app.post(
    "/_ref/connectors/:connectorId/draft-connection",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
      const connectorId = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
      let ownerSubjectId: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);

        // Reject an unknown connector before doing anything else (404).
        const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);

        const credentialKind = expectedStaticSecretCredentialKind(connectorId, manifest);
        const captureSetup = staticSecretCredentialCaptureFromManifest(manifest);
        if (!credentialKind) {
          await emitDraftAudit(ctx, req, res, {
            connectorId,
            error: errWithCode("static_secret_credential_unsupported"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            409,
            "static_secret_credential_unsupported",
            `Connector '${connectorId}' is not a static-secret connector; a draft connection is only created for static-secret connectors.`
          );
          return;
        }
        if (!captureSetup) {
          await emitDraftAudit(ctx, req, res, {
            connectorId,
            error: errWithCode("static_secret_setup_missing"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            409,
            "static_secret_setup_missing",
            `Connector '${connectorId}' is missing manifest setup.credential_capture metadata.`
          );
          return;
        }
        if (!isCredentialEncryptionConfigured()) {
          await emitDraftAudit(ctx, req, res, {
            connectorId,
            credentialKind,
            error: errWithCode("credential_encryption_key_missing"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(res, 503, "credential_encryption_key_missing", staticSecretSetupErrorMessage());
          return;
        }
        const parsedSetup = parseDraftSetup(ctx, res, req.body, captureSetup.fields);
        if (parsedSetup === null) {
          await emitDraftAudit(ctx, req, res, {
            connectorId,
            credentialKind,
            error: errWithCode("invalid_request"),
            outcome: "failed",
            ownerSubjectId,
          });
          return;
        }
        const { displayName: requestedDisplayName, setupFields } = parsedSetup;

        let existingIdentity: ConnectorInstance | null = null;
        if (credentialValidationMode(connectorId) === "synchronous") {
          existingIdentity = await findExistingStaticSecretIdentity<ConnectorInstance>({
            connectorId,
            fields: captureSetup.fields,
            ownerSubjectId,
            setupFields,
            store: ctx.createRequestConnectorInstanceStore(),
          });
        }
        let displayName: string;
        let instance: ConnectorInstance;
        let created = false;
        if (existingIdentity) {
          instance = existingIdentity;
          displayName = existingIdentity.displayName ?? displayNameForConnector(connectorId, manifest);
        } else {
          const createdDraft = createDraftConnection(ctx, {
            captureSetup,
            connectorId,
            displayName: requestedDisplayName,
            manifest,
            ownerSubjectId,
            setupFields,
          });
          const { displayName: createdDisplayName, instance: createdInstance } = createdDraft;
          instance = await createdInstance;
          displayName = createdDisplayName;
          created = true;
        }

        await emitDraftAudit(ctx, req, res, {
          connectionId: instance.connectorInstanceId,
          connectorId,
          credentialKind,
          outcome: "succeeded",
          ownerSubjectId,
        });

        res.status(created ? 201 : 200).json({
          connection_id: instance.connectorInstanceId,
          connector_id: connectorId,
          connector_instance_id: instance.connectorInstanceId,
          credential_kind: credentialKind,
          display_name: displayName,
          next_step: {
            kind: "capture_static_secret_credential",
            method: "POST",
            reason:
              "Capture the provider static secret onto this draft from the owner session. The connection stays invisible until its first successful ingest.",
            url: `/_ref/connections/${encodeURIComponent(instance.connectorInstanceId)}/static-secret-credential`,
          },
          object: "static_secret_draft_connection",
          status: instance.status,
        });
      } catch (err) {
        await emitDraftAudit(ctx, req, res, {
          connectorId,
          error: err,
          outcome: "failed",
          ownerSubjectId,
        });
        ctx.handleError(res, err);
      }
    }
  );
}
