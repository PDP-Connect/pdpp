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
// connectors are refused. Each call mints a fresh random source-binding key, so
// two mailboxes become two distinct `connection_id`s. See
// add-static-secret-owner-session-connect-path design Decision 4.

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
  CREDENTIAL_ENCRYPTION_KEY_ENV,
  CREDENTIAL_ENCRYPTION_KEY_FILE_ENV,
  isCredentialEncryptionConfigured,
} from "../stores/credential-encryption.js";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  readonly body?: unknown;
  ownerSession?: { readonly sub?: string | null } | null;
  readonly params: Readonly<Record<string, string>>;
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

export interface MountRefStaticSecretDraftConnectionContext {
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  getOwnerSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  now?(): string;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  // Resolves a registered connector manifest, throwing a typed not_found when
  // the connector is unknown. Used only to reject an unknown connector id with
  // 404 before creating a draft.
  resolveRegisteredConnectorManifest(connectorId: string): Promise<ConnectorManifestLike>;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
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
    object: "static_secret_setup",
    connector_id: connectorId,
    display_name: displayName,
    credential_kind: credentialKind,
    // Whether the credential is validated synchronously at capture (a registry
    // connector with a `probeCredential` hook echoes the account identity in
    // ≤10s) or only at first sync. Owner-generic; drives the Console form's
    // validate-then-activate flow with no connector-specific branch.
    validation: credentialValidationMode(connectorId),
    credential_capture: {
      description: capture.description,
      fields: capture.fields.map(projectField),
      kind: capture.kind,
      label: capture.label,
      submit_label: capture.submitLabel,
    },
    deployment_readiness: staticSecretDeploymentReadiness(),
  };
}

function parseSetupFields(
  ctx: MountRefStaticSecretDraftConnectionContext,
  res: RouteResponse,
  body: unknown,
  fields: readonly StaticSecretSetupField[]
): Record<string, string> | null {
  const objectBody = (body as Record<string, unknown> | null) || {};
  const raw = objectBody.setup_fields;
  const provided = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const allowed = new Set(fields.filter((field) => !field.secret).map((field) => field.name));
  const output: Record<string, string> = {};
  for (const key of Object.keys(provided)) {
    if (!allowed.has(key)) {
      ctx.pdppError(res, 400, "unknown_setup_field", `Unknown setup field: ${key}`, `setup_fields.${key}`);
      return null;
    }
  }
  for (const field of fields) {
    if (field.secret) {
      continue;
    }
    const value = provided[field.name];
    const text = typeof value === "string" ? value.trim() : "";
    if (field.required && !text) {
      ctx.pdppError(res, 400, "missing_setup_field", `${field.label} is required.`, `setup_fields.${field.name}`);
      return null;
    }
    if (text) {
      output[field.name] = text;
    }
  }
  return output;
}

function identityValue(fields: readonly StaticSecretSetupField[], setupFields: Record<string, string>): string | null {
  const field = fields.find((candidate) => candidate.identity && !candidate.secret);
  return field ? (setupFields[field.name] ?? null) : null;
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
    event_type: "owner.connection.static_secret_draft.create",
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
  });
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
        const setupFields = parseSetupFields(ctx, res, req.body, captureSetup.fields);
        if (setupFields === null) {
          await emitDraftAudit(ctx, req, res, {
            connectorId,
            credentialKind,
            error: errWithCode("invalid_request"),
            outcome: "failed",
            ownerSubjectId,
          });
          return;
        }

        // A fresh random binding key makes every draft a distinct connection
        // identity (two mailboxes → two connection_ids) and deliberately avoids
        // the deterministic default-account key, which is the phantom-
        // resurrection key. The store derives the connector_instance_id from
        // the binding key.
        const sourceBindingKey = `draft_${randomBytes(24).toString("hex")}`;
        const now = ctx.now ? ctx.now() : new Date().toISOString();
        const store = ctx.createRequestConnectorInstanceStore();
        const idValue = identityValue(captureSetup.fields, setupFields);
        const displayName = idValue
          ? `${displayNameForConnector(connectorId, manifest)} - ${idValue}`
          : displayNameForConnector(connectorId, manifest);
        const instance = await store.upsert({
          ownerSubjectId,
          connectorId,
          displayName,
          status: "draft",
          sourceKind: "account",
          sourceBindingKey,
          sourceBinding: { kind: "static_secret_draft", setup_fields: setupFields },
          createdAt: now,
          updatedAt: now,
        });

        await emitDraftAudit(ctx, req, res, {
          connectionId: instance.connectorInstanceId,
          connectorId,
          credentialKind,
          outcome: "succeeded",
          ownerSubjectId,
        });

        res.status(201).json({
          object: "static_secret_draft_connection",
          connection_id: instance.connectorInstanceId,
          connector_instance_id: instance.connectorInstanceId,
          connector_id: connectorId,
          display_name: displayName,
          status: instance.status,
          credential_kind: credentialKind,
          next_step: {
            kind: "capture_static_secret_credential",
            method: "POST",
            url: `/_ref/connections/${encodeURIComponent(instance.connectorInstanceId)}/static-secret-credential`,
            reason:
              "Capture the provider static secret onto this draft from the owner session. The connection stays invisible until its first successful ingest.",
          },
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
