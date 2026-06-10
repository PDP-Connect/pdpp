// Reference-only owner-session static-secret credential capture.
//
// This is the owner-trusted surface for sealing one connector-declared provider
// static secret onto one existing connection. It is NOT an owner-agent bearer
// route and it never returns the submitted secret. Owner-agent intent may point
// at the owner-session capture page, but it never carries the credential itself.

import { expectedStaticSecretCredentialKind, type ConnectorManifestLike } from "../connection-setup-plan.ts";
import { isCredentialEncryptionConfigured } from "../stores/credential-encryption.js";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import { codeToStatus } from "./ref-error-status.ts";

// Owner-facing result of a synchronous credential probe.
//   - `skipped: true`   — this connector has no synchronous probe; take the
//                         first-sync path (no rejection, no identity echo).
//   - `ok: true`        — the credential validated; carries the non-secret
//                         account identity to echo.
//   - `ok: false`       — the credential was rejected (or the provider was
//                         unreachable); carries a provider-named, owner-causal
//                         reason. Never a raw provider error, never the secret.
export type StaticSecretProbeResult =
  | { readonly ok: true; readonly skipped: true }
  | { readonly detail?: string | null; readonly identity: string; readonly ok: true; readonly skipped?: false }
  | { readonly code: string; readonly message: string; readonly ok: false; readonly retryable?: boolean };

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
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

interface ConnectorNamespace {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
}

interface CredentialMetadata {
  readonly capturedAt?: string | null;
  readonly connectorInstanceId?: string | null;
  readonly credentialKind?: string | null;
  readonly fingerprint?: string | null;
  readonly present?: boolean;
  readonly revokedAt?: string | null;
  readonly rotatedAt?: string | null;
  readonly status?: string | null;
}

interface ConnectorInstanceCredentialStore {
  capture(input: {
    connectorInstanceId: string;
    ownerSubjectId: string;
    credentialKind: string;
    secret: string;
    now: string;
  }): Promise<CredentialMetadata> | CredentialMetadata;
  getMetadata(connectorInstanceId: string): Promise<CredentialMetadata | null> | CredentialMetadata | null;
}

interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly sourceBinding?: unknown;
  readonly status: string;
}

interface ConnectorInstanceStore {
  get(connectorInstanceId: string): Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
  updateStatus(
    connectorInstanceId: string,
    args: { readonly revokedAt?: string | null; readonly status: string; readonly updatedAt: string }
  ): Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
}

// Non-secret context handed to a probe. The Gmail probe needs the mailbox
// address (a non-secret setup field captured at draft creation); the GitHub
// probe needs only the secret. Never carries the secret.
export interface StaticSecretProbeContext {
  readonly connectorInstanceId?: string | null;
  readonly setupFields?: Readonly<Record<string, string>> | null;
}

export interface MountRefStaticSecretCredentialsContext {
  // Canonicalize a connector id/key (strip the registry prefix) so the probe
  // registry lookup matches. Optional: when absent the connector id is used as
  // given (matching the existing draft-route fallback).
  canonicalConnectorKey?(value: string | null | undefined): string | null;
  createRequestConnectorInstanceCredentialStore(): ConnectorInstanceCredentialStore;
  // Connector-instance store, used to recover the draft's non-secret setup
  // fields for the probe context and to retire rejected first-time draft setup
  // rows. Optional: when absent the probe runs with no setup-field context
  // (fine for connectors whose probe needs none, e.g. GitHub) and cannot
  // perform draft cleanup.
  createRequestConnectorInstanceStore?(): ConnectorInstanceStore;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  getOwnerSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  now?(): string;
  pdppError: PdppErrorFn;
  // Run the connector's synchronous credential probe. Injected so the route is
  // transport-agnostic: production wires the package probe + live transport;
  // tests inject a deterministic double. Returns a typed result and MUST NOT
  // throw for a normal rejection. It returns `{ ok: true, skipped: true }` for a
  // connector with no probe (the route then keeps the first-sync path), so the
  // route needs no separate has-probe gate. It MUST NOT echo the secret. When
  // this is not injected at all, every connector takes the first-sync path.
  probeStaticSecretCredential?(input: {
    connectorKey: string;
    context: StaticSecretProbeContext;
    secret: string;
  }): Promise<StaticSecretProbeResult>;
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
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
}

const MAX_SECRET_LENGTH = 64 * 1024;

function errWithCode(code: string): { code: string } {
  return { code };
}

async function expectedCredentialKindForConnector(
  ctx: MountRefStaticSecretCredentialsContext,
  connectorId: string
): Promise<string | null> {
  const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
  return expectedStaticSecretCredentialKind(connectorId, manifest);
}

function projectCredentialMetadata(meta: CredentialMetadata): Record<string, unknown> {
  return {
    present: meta.present === true,
    credential_kind: meta.credentialKind ?? null,
    status: meta.status ?? null,
    fingerprint: meta.fingerprint ?? null,
    captured_at: meta.capturedAt ?? null,
    rotated_at: meta.rotatedAt ?? null,
    revoked_at: meta.revokedAt ?? null,
  };
}

function credentialCaptureErrorStatus(err: unknown): number {
  const code = (err as { code?: unknown })?.code;
  if (
    code === "credential_encryption_key_missing" ||
    code === "credential_encryption_key_invalid" ||
    code === "credential_encryption_key_file_unreadable"
  ) {
    return 503;
  }
  return typeof code === "string" ? (codeToStatus[code] ?? 500) : 500;
}

function buildAuditTrace(ctx: MountRefStaticSecretCredentialsContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return {
    request_id: requestId,
    scenario_id: trace.scenario_id,
    trace_id: trace.trace_id,
  };
}

async function emitCaptureAudit(
  ctx: MountRefStaticSecretCredentialsContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorId?: string | null;
    credentialKind?: string | null;
    error?: unknown;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
    rotated?: boolean;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, res);
  const ownerSubjectId = args.ownerSubjectId ?? req.ownerSession?.sub ?? null;
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    event_type: "owner.connection.static_secret_credential.capture",
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
      operation: "capture_static_secret_credential",
      outcome: args.outcome,
      rotated: args.rotated ?? false,
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

// Pull the non-secret setup fields out of the draft's source binding. The draft
// binding is `{ kind: "static_secret_draft", setup_fields: {...} }`; only
// non-secret fields are ever stored there (the secret lives in the credential
// store), so this is safe to read for the probe context.
function setupFieldsFromBinding(sourceBinding: unknown): Record<string, string> | null {
  if (!sourceBinding || typeof sourceBinding !== "object" || Array.isArray(sourceBinding)) {
    return null;
  }
  const raw = (sourceBinding as { setup_fields?: unknown }).setup_fields;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.length > 0) {
      fields[key] = value;
    }
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

function isStaticSecretDraftInstance(instance: ConnectorInstanceRow | null): instance is ConnectorInstanceRow {
  if (!instance || instance.status !== "draft") {
    return false;
  }
  const binding = instance.sourceBinding;
  return Boolean(
    binding &&
      typeof binding === "object" &&
      !Array.isArray(binding) &&
      (binding as { kind?: unknown }).kind === "static_secret_draft"
  );
}

async function retireRejectedStaticSecretDraft(
  ctx: MountRefStaticSecretCredentialsContext,
  connectorInstanceId: string,
  now: string
): Promise<void> {
  if (typeof ctx.createRequestConnectorInstanceStore !== "function") {
    return;
  }
  const store = ctx.createRequestConnectorInstanceStore();
  const instance = await store.get(connectorInstanceId);
  if (!isStaticSecretDraftInstance(instance)) {
    return;
  }
  await store.updateStatus(connectorInstanceId, {
    status: "revoked",
    updatedAt: now,
    revokedAt: now,
  });
}

// Resolve the non-secret setup-field context for a connector's probe by reading
// the draft instance's source binding. Best-effort: a connector whose probe
// needs no setup fields (e.g. GitHub) is unaffected when this returns null.
async function probeContextForInstance(
  ctx: MountRefStaticSecretCredentialsContext,
  connectorInstanceId: string
): Promise<StaticSecretProbeContext> {
  if (typeof ctx.createRequestConnectorInstanceStore !== "function") {
    return { connectorInstanceId, setupFields: null };
  }
  const store = ctx.createRequestConnectorInstanceStore();
  const instance = await store.get(connectorInstanceId);
  return {
    connectorInstanceId,
    setupFields: instance ? setupFieldsFromBinding(instance.sourceBinding) : null,
  };
}

function parseCaptureBody(
  ctx: MountRefStaticSecretCredentialsContext,
  res: RouteResponse,
  body: unknown
): { credentialKind: string | null; secret: string } | null {
  const objectBody = (body as Record<string, unknown> | null) || {};
  const secret = objectBody.secret;
  if (typeof secret !== "string" || secret.length === 0 || Buffer.byteLength(secret, "utf8") > MAX_SECRET_LENGTH) {
    ctx.pdppError(
      res,
      400,
      "invalid_request",
      `secret must be a non-empty string no longer than ${MAX_SECRET_LENGTH} bytes`,
      "secret"
    );
    return null;
  }
  return {
    credentialKind: typeof objectBody.credential_kind === "string" ? objectBody.credential_kind.trim() : null,
    secret,
  };
}

// POST /_ref/connections/:connectorInstanceId/static-secret-credential
//
// Owner-session-only credential capture for one existing connection. The
// plaintext appears only in the request body and the store's sealing call; the
// response and audit event contain non-secret metadata only.
export function mountRefStaticSecretCredentialCapture(app: AppLike, ctx: MountRefStaticSecretCredentialsContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/static-secret-credential",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
      let ownerSubjectId: string | null = null;
      let namespace: ConnectorNamespace | null = null;
      let credentialKind: string | null = null;
      try {
        ownerSubjectId = ctx.getOwnerSubjectId(req);
        const capture = parseCaptureBody(ctx, res, req.body);
        if (!capture) {
          await emitCaptureAudit(ctx, req, res, {
            connectionId: connectorInstanceId,
            credentialKind,
            error: errWithCode("invalid_request"),
            outcome: "failed",
            ownerSubjectId,
          });
          return;
        }
        credentialKind = capture.credentialKind;
        namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
          ownerSubjectId,
          allowDefaultAccount: false,
          // Admit a `draft` target so the owner can seal a credential onto a
          // not-yet-ingested first static-secret connection. This is owner-
          // session-only; no bearer/agent path passes allowStatuses. See
          // add-static-secret-owner-session-connect-path design Decisions 3 & 5.
          allowStatuses: ["active", "draft"],
          connectorInstanceId,
        });
        const expectedKind = await expectedCredentialKindForConnector(ctx, namespace.connectorId);
        if (!expectedKind) {
          await emitCaptureAudit(ctx, req, res, {
            connectionId: namespace.connectorInstanceId,
            connectorId: namespace.connectorId,
            credentialKind,
            error: errWithCode("static_secret_credential_unsupported"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            409,
            "static_secret_credential_unsupported",
            `Connection '${namespace.connectorInstanceId}' belongs to connector '${namespace.connectorId}', which is not a static-secret connector.`
          );
          return;
        }
        if (credentialKind !== expectedKind) {
          await emitCaptureAudit(ctx, req, res, {
            connectionId: namespace.connectorInstanceId,
            connectorId: namespace.connectorId,
            credentialKind,
            error: errWithCode("credential_kind_mismatch"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            400,
            "credential_kind_mismatch",
            `credential_kind must be '${expectedKind}' for connector '${namespace.connectorId}'.`,
            "credential_kind"
          );
          return;
        }
        // Fail closed before probing when the instance-level credential key
        // provider is missing: there is no point validating a credential we
        // cannot store, and this preserves the existing 503
        // `credential_encryption_key_missing` contract ahead of the probe.
        if (!isCredentialEncryptionConfigured()) {
          await emitCaptureAudit(ctx, req, res, {
            connectionId: namespace.connectorInstanceId,
            connectorId: namespace.connectorId,
            credentialKind,
            error: errWithCode("credential_encryption_key_missing"),
            outcome: "failed",
            ownerSubjectId,
          });
          ctx.pdppError(
            res,
            503,
            "credential_encryption_key_missing",
            "Credential encryption is required but no instance-level key provider is configured. Configure it before capturing a static-secret credential. No credential was validated or stored."
          );
          return;
        }

        // Synchronous validation moment (owner-journey flow design B1). When a
        // probe is injected, validate the credential against the provider BEFORE
        // storing it: a known-bad credential is rejected with a provider-named,
        // owner-causal message and NOTHING is written to the credential store.
        // The prober self-reports `skipped: true` for a connector with no probe,
        // so the first-sync path is preserved without a separate gate. The probe
        // is injected, so no live provider call happens under test.
        const probeConnectorKey = ctx.canonicalConnectorKey
          ? (ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId)
          : namespace.connectorId;
        let probedIdentity: { detail: string | null; identity: string } | null = null;
        if (typeof ctx.probeStaticSecretCredential === "function") {
          const probeContext = await probeContextForInstance(ctx, namespace.connectorInstanceId);
          const probeResult = await ctx.probeStaticSecretCredential({
            connectorKey: probeConnectorKey,
            context: probeContext,
            secret: capture.secret,
          });
          if (!probeResult.ok) {
            // Validation failed: do NOT store the credential or any of its
            // metadata. If this was a first-time draft setup, retire the draft
            // so it cannot become an invisible black-hole row. Active
            // connections are left untouched so failed rotation attempts never
            // revoke a working connection. Audit the rejection with the typed
            // code only (no secret, no raw provider error). The owner sees the
            // provider-named message and keeps their form context.
            const now = ctx.now ? ctx.now() : new Date().toISOString();
            await retireRejectedStaticSecretDraft(ctx, namespace.connectorInstanceId, now);
            await emitCaptureAudit(ctx, req, res, {
              connectionId: namespace.connectorInstanceId,
              connectorId: namespace.connectorId,
              credentialKind,
              error: errWithCode(probeResult.code),
              outcome: "failed",
              ownerSubjectId,
            });
            ctx.pdppError(res, 400, "static_secret_credential_rejected", probeResult.message);
            return;
          }
          if (probeResult.skipped !== true) {
            probedIdentity = { detail: probeResult.detail ?? null, identity: probeResult.identity };
          }
        }
        const store = ctx.createRequestConnectorInstanceCredentialStore();
        const previous = await store.getMetadata(namespace.connectorInstanceId);
        const now = ctx.now ? ctx.now() : new Date().toISOString();
        const metadata = await store.capture({
          connectorInstanceId: namespace.connectorInstanceId,
          ownerSubjectId,
          credentialKind,
          secret: capture.secret,
          now,
        });
        const rotated = Boolean(previous);
        await emitCaptureAudit(ctx, req, res, {
          connectionId: namespace.connectorInstanceId,
          connectorId: namespace.connectorId,
          credentialKind,
          outcome: "succeeded",
          ownerSubjectId,
          rotated,
        });
        res.status(rotated ? 200 : 201).json({
          object: "static_secret_credential_capture",
          connection_id: namespace.connectorInstanceId,
          connector_instance_id: namespace.connectorInstanceId,
          connector_id: namespace.connectorId,
          credential: projectCredentialMetadata(metadata),
          // Non-secret account identity from a synchronous probe ("Connected as
          // {identity}"). Null when the connector has no probe (first-sync path)
          // or the probe returned no identity. Never carries the secret.
          identity: probedIdentity
            ? { account_identity: probedIdentity.identity, detail: probedIdentity.detail }
            : null,
          // Whether the credential was validated synchronously before storing.
          validation: probedIdentity ? "synchronous" : "first_sync",
          next_step: {
            kind: "run_connection",
            method: "POST",
            url: `/_ref/connections/${encodeURIComponent(namespace.connectorInstanceId)}/run`,
            reason:
              "Run this connection from the owner session or scheduler. The connection stays hidden until first ingest accepts records.",
          },
        });
      } catch (err) {
        await emitCaptureAudit(ctx, req, res, {
          connectionId: namespace?.connectorInstanceId ?? connectorInstanceId,
          connectorId: namespace?.connectorId ?? null,
          credentialKind,
          error: err,
          outcome: "failed",
          ownerSubjectId,
        });
        const status = credentialCaptureErrorStatus(err);
        const code = (err as { code?: unknown })?.code;
        if (typeof code === "string" && status !== 500) {
          ctx.pdppError(res, status, code, (err as Error).message);
          return;
        }
        ctx.handleError(res, err);
      }
    }
  );
}
