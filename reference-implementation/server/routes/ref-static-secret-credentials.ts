// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reference-only owner-session static-secret credential capture.
//
// This is the owner-trusted surface for sealing one connector-declared provider
// static secret onto one existing connection. It is NOT an owner-agent bearer
// route and it never returns the submitted secret. Owner-agent intent may point
// at the owner-session capture page, but it never carries the credential itself.

import {
  type ConnectorManifestLike,
  expectedStaticSecretCredentialKind,
  type StaticSecretSetupField,
  staticSecretCredentialCaptureFromManifest,
} from "../connection-setup-plan.ts";
import {
  assertStaticSecretActiveIdentityCanClaim,
  isStaticSecretBindingUniqueConflict,
  parseStaticSecretSetupFields,
  staticSecretBindingRecord,
  staticSecretIdentityClaim,
  staticSecretSetupFieldsFromBinding,
} from "../static-secret-identity.ts";
import { isCredentialEncryptionConfigured } from "../stores/credential-encryption.ts";
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

interface AutoResumeRequiredAction {
  readonly affects: readonly string[];
  readonly audience: "maintainer" | "none" | "owner";
  readonly cta: string;
  readonly kind:
    | "add_info"
    | "backfill"
    | "code_fix"
    | "contact_support"
    | "reattach_schedule"
    | "reauth"
    | "refresh_now"
    | "retry_gap"
    | "wait";
  readonly satisfied_when:
    | { readonly kind: "attention_resolved" }
    | { readonly kind: "backfill_window_covered" }
    | { readonly kind: "confirming_run_succeeded" }
    | { readonly kind: "credential_present_and_unrejected" }
    | { readonly kind: "gap_recovered" }
    | { readonly kind: "none" }
    | { readonly kind: "schedule_attached_and_enabled" };
  readonly terminal: boolean;
  readonly urgency: "now" | "overdue" | "soon" | "verifying";
}

interface AutoResumeResult {
  readonly confirming_run: unknown | null;
  readonly error_code?: string;
  readonly error_message?: string;
  readonly object: "connection_self_heal";
  readonly satisfied_actions: readonly AutoResumeRequiredAction[];
  readonly status: "active_run_exists" | "blocked" | "no_satisfied_action" | "started";
  readonly terminal_status?: "failed" | "succeeded";
}

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
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
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
  capture: (input: {
    connectorInstanceId: string;
    ownerSubjectId: string;
    credentialKind: string;
    secret: string;
    now: string;
  }) => Promise<CredentialMetadata> | CredentialMetadata;
  getMetadata: (connectorInstanceId: string) => Promise<CredentialMetadata | null> | CredentialMetadata | null;
}

interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
  readonly sourceBinding?: unknown;
  readonly sourceBindingKey: string;
  readonly status: string;
}

interface ConnectorInstanceStore {
  get: (connectorInstanceId: string) => Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
  getByBinding: (input: {
    ownerSubjectId: string;
    connectorId: string;
    sourceKind: string;
    sourceBindingKey: string;
  }) => Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
  updateStaticSecretBinding: (input: {
    connectorInstanceId: string;
    connectorId: string;
    ownerSubjectId: string;
    sourceBinding: Record<string, unknown>;
    sourceBindingKey: string;
    updatedAt: string;
  }) => Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
  updateStatus: (
    connectorInstanceId: string,
    args: { readonly revokedAt?: string | null; readonly status: string; readonly updatedAt: string }
  ) => Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
}

// Non-secret context handed to a probe. The Gmail probe needs the mailbox
// address (a non-secret setup field captured at draft creation); the GitHub
// probe needs only the secret. Never carries the secret.
export interface StaticSecretProbeContext {
  readonly connectorInstanceId?: string | null;
  readonly setupFields?: Readonly<Record<string, string>> | null;
}

export interface MountRefStaticSecretCredentialsContext {
  autoResumeSatisfiedActions?: (input: {
    connectorId: string;
    connectorInstanceId: string;
    evidence: {
      credential: {
        present: boolean;
        rejected: boolean;
        status: string | null;
      };
    };
    requiredActions: readonly AutoResumeRequiredAction[];
  }) => Promise<AutoResumeResult> | AutoResumeResult;
  // Canonicalize a connector id/key (strip the registry prefix) so the probe
  // registry lookup matches. Optional: when absent the connector id is used as
  // given (matching the existing draft-route fallback).
  canonicalConnectorKey?: (value: string | null | undefined) => string | null;
  createRequestConnectorInstanceCredentialStore: () => ConnectorInstanceCredentialStore;
  // Connector-instance store, used to recover/update non-secret setup fields
  // and claim a verified provider identity. Optional only for narrow injected
  // callers that do not use setup-field or identity-aware probing.
  createRequestConnectorInstanceStore?: () => ConnectorInstanceStore;
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  ensureRequestId: (res: RouteResponse) => string;
  getOwnerSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  now?: () => string;
  pdppError: PdppErrorFn;
  // Run the connector's synchronous credential probe. Injected so the route is
  // transport-agnostic: production wires the package probe + live transport;
  // tests inject a deterministic double. Returns a typed result and MUST NOT
  // throw for a normal rejection. It returns `{ ok: true, skipped: true }` for a
  // connector with no probe (the route then keeps the first-sync path), so the
  // route needs no separate has-probe gate. It MUST NOT echo the secret. When
  // this is not injected at all, every connector takes the first-sync path.
  probeStaticSecretCredential?: (input: {
    connectorKey: string;
    context: StaticSecretProbeContext;
    secret: string;
  }) => Promise<StaticSecretProbeResult>;
  requireOwnerSession: MiddlewareHandler;
  resolveOwnerConnectorNamespace: (
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly allowStatuses?: readonly string[];
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ) => Promise<ConnectorNamespace>;
  resolveRegisteredConnectorManifest: (connectorId: string) => Promise<ConnectorManifestLike>;
  setReferenceTraceId: (res: RouteResponse, traceId: string) => void;
}

const MAX_SECRET_LENGTH = 64 * 1024;

function errWithCode(code: string): { code: string } {
  return { code };
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function throwCodedError(code: string, message: string): never {
  throw codedError(code, message);
}

function nowFor(ctx: MountRefStaticSecretCredentialsContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

interface StaticSecretCredentialContract {
  readonly credentialKind: string;
  readonly fields: readonly StaticSecretSetupField[];
}

async function staticSecretCredentialContract(
  ctx: MountRefStaticSecretCredentialsContext,
  connectorId: string
): Promise<StaticSecretCredentialContract | null> {
  const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
  const credentialKind = expectedStaticSecretCredentialKind(connectorId, manifest);
  const capture = staticSecretCredentialCaptureFromManifest(manifest);
  return credentialKind && capture ? { credentialKind, fields: capture.fields } : null;
}

function projectCredentialMetadata(meta: CredentialMetadata): Record<string, unknown> {
  return {
    captured_at: meta.capturedAt ?? null,
    credential_kind: meta.credentialKind ?? null,
    fingerprint: meta.fingerprint ?? null,
    present: meta.present === true,
    revoked_at: meta.revokedAt ?? null,
    rotated_at: meta.rotatedAt ?? null,
    status: meta.status ?? null,
  };
}

function credentialRepairAction(): AutoResumeRequiredAction {
  return {
    affects: [],
    audience: "owner",
    cta: "Reconnect this account",
    kind: "reauth",
    satisfied_when: { kind: "credential_present_and_unrejected" },
    terminal: false,
    urgency: "now",
  };
}

async function autoResumeAfterCredentialCapture(
  ctx: MountRefStaticSecretCredentialsContext,
  namespace: ConnectorNamespace,
  credential: CredentialMetadata
): Promise<AutoResumeResult | null> {
  if (typeof ctx.autoResumeSatisfiedActions !== "function") {
    return null;
  }
  try {
    return await ctx.autoResumeSatisfiedActions({
      connectorId: namespace.connectorId,
      connectorInstanceId: namespace.connectorInstanceId,
      evidence: {
        credential: {
          present: credential.present === true,
          rejected:
            credential.revokedAt !== null || credential.status === "revoked" || credential.status === "rejected",
          status: credential.status ?? null,
        },
      },
      requiredActions: [credentialRepairAction()],
    });
  } catch (err) {
    return {
      confirming_run: null,
      error_message: err instanceof Error ? err.message : String(err),
      object: "connection_self_heal",
      satisfied_actions: [],
      status: "blocked",
    };
  }
}

function credentialCaptureErrorStatus(err: unknown): number {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
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
    actor_id: ownerSubjectId ?? "owner_session",
    actor_type: "owner_session",
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
    event_type: "owner.connection.static_secret_credential.capture",
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

// Resolve the non-secret setup-field context for a connector's probe by reading
// the draft instance's source binding. Best-effort: a connector whose probe
// needs no setup fields (e.g. GitHub) is unaffected when this returns null.
async function probeContextForInstance(
  ctx: MountRefStaticSecretCredentialsContext,
  connectorInstanceId: string,
  setupFieldsOverride?: Record<string, string>
): Promise<StaticSecretProbeContext> {
  if (setupFieldsOverride) {
    return { connectorInstanceId, setupFields: setupFieldsOverride };
  }
  if (typeof ctx.createRequestConnectorInstanceStore !== "function") {
    return { connectorInstanceId, setupFields: null };
  }
  const store = ctx.createRequestConnectorInstanceStore();
  const instance = await store.get(connectorInstanceId);
  return {
    connectorInstanceId,
    setupFields: instance ? staticSecretSetupFieldsFromBinding(instance.sourceBinding) : null,
  };
}

function parseCaptureBody(
  ctx: MountRefStaticSecretCredentialsContext,
  res: RouteResponse,
  body: unknown
): { credentialKind: string | null; secret: string; setupFieldsRaw?: unknown } | null {
  const objectBody = (body as Record<string, unknown> | null) || {};
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
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
    ...(Object.hasOwn(objectBody, "setup_fields") ? { setupFieldsRaw: objectBody.setup_fields } : {}),
  };
}

async function updateDraftSetupFieldsBeforeProbe(
  ctx: MountRefStaticSecretCredentialsContext,
  input: {
    connectorId: string;
    connectorInstanceId: string;
    ownerSubjectId: string;
    setupFields?: Record<string, string>;
  }
): Promise<void> {
  if (!input.setupFields || typeof ctx.createRequestConnectorInstanceStore !== "function") {
    return;
  }
  const store = ctx.createRequestConnectorInstanceStore();
  const instance = await store.get(input.connectorInstanceId);
  if (instance?.status !== "draft") {
    return;
  }
  const binding = staticSecretBindingRecord(instance.sourceBinding);
  if (binding?.kind !== "static_secret_draft") {
    throwCodedError("static_secret_draft_required", "Only a static-secret draft can update setup fields during retry.");
  }
  binding.setup_fields = input.setupFields;
  await store.updateStaticSecretBinding({
    connectorId: input.connectorId,
    connectorInstanceId: input.connectorInstanceId,
    ownerSubjectId: input.ownerSubjectId,
    sourceBinding: binding,
    sourceBindingKey: instance.sourceBindingKey,
    updatedAt: ctx.now ? ctx.now() : new Date().toISOString(),
  });
}

interface ClaimedStaticSecretIdentity {
  readonly deduplicated: boolean;
  readonly instance: ConnectorInstanceRow;
}

function requireConnectorInstanceStore(ctx: MountRefStaticSecretCredentialsContext): ConnectorInstanceStore {
  if (typeof ctx.createRequestConnectorInstanceStore !== "function") {
    throwCodedError(
      "static_secret_identity_unavailable",
      "A connector-instance store is required to claim a verified provider identity."
    );
  }
  return ctx.createRequestConnectorInstanceStore();
}

async function currentInstanceOrThrow(
  store: ConnectorInstanceStore,
  connectorInstanceId: string
): Promise<ConnectorInstanceRow> {
  const current = await store.get(connectorInstanceId);
  if (!current) {
    throwCodedError("connector_instance_not_found", `Connection '${connectorInstanceId}' does not exist.`);
  }
  return current;
}

function currentBindingOrThrow(current: ConnectorInstanceRow): Record<string, unknown> {
  const binding = staticSecretBindingRecord(current.sourceBinding);
  if (!binding) {
    throwCodedError(
      "static_secret_binding_invalid",
      "The connection has no valid static-secret binding; refusing to store the credential."
    );
  }
  return binding;
}

async function resolveIdentityBindingConflict(
  ctx: MountRefStaticSecretCredentialsContext,
  store: ConnectorInstanceStore,
  current: ConnectorInstanceRow,
  sourceBindingKey: string,
  originalError: unknown,
  input: { connectorId: string; ownerSubjectId: string }
): Promise<ClaimedStaticSecretIdentity> {
  const winner = await store.getByBinding({
    connectorId: input.connectorId,
    ownerSubjectId: input.ownerSubjectId,
    sourceBindingKey,
    sourceKind: "account",
  });
  if (!winner) {
    throw originalError;
  }
  if (winner.status === "revoked") {
    throwCodedError(
      "static_secret_identity_revoked",
      "This provider identity belongs to a revoked connection; refusing to create or reactivate another connection silently."
    );
  }
  if (current.status === "active" && winner.connectorInstanceId !== current.connectorInstanceId) {
    throwCodedError(
      "static_secret_identity_conflict",
      "Another active connection already owns this verified provider identity; refusing to retarget this active connection."
    );
  }
  if (winner.connectorInstanceId !== current.connectorInstanceId && current.status === "draft") {
    const now = nowFor(ctx);
    await store.updateStatus(current.connectorInstanceId, {
      revokedAt: now,
      status: "revoked",
      updatedAt: now,
    });
  }
  return { deduplicated: true, instance: winner };
}

async function claimProbedStaticSecretIdentity(
  ctx: MountRefStaticSecretCredentialsContext,
  input: {
    connectorId: string;
    connectorInstanceId: string;
    identityFieldName?: string;
    ownerSubjectId: string;
    probedIdentity: string;
    setupFields?: Record<string, string>;
  }
): Promise<ClaimedStaticSecretIdentity> {
  const store = requireConnectorInstanceStore(ctx);
  const { identity, sourceBindingKey } = staticSecretIdentityClaim(input);
  const current = await currentInstanceOrThrow(store, input.connectorInstanceId);
  const binding = currentBindingOrThrow(current);
  assertStaticSecretActiveIdentityCanClaim({
    identity,
    identityFieldName: input.identityFieldName,
    sourceBinding: current.sourceBinding,
    status: current.status,
  });
  binding.verified_identity = identity;
  if (input.setupFields) {
    binding.setup_fields = input.setupFields;
  }
  try {
    const updated = await store.updateStaticSecretBinding({
      connectorId: input.connectorId,
      connectorInstanceId: input.connectorInstanceId,
      ownerSubjectId: input.ownerSubjectId,
      sourceBinding: binding,
      sourceBindingKey,
      updatedAt: nowFor(ctx),
    });
    if (!updated) {
      throwCodedError(
        "connector_instance_not_found",
        `Connection '${input.connectorInstanceId}' is no longer capturable.`
      );
    }
    return { deduplicated: false, instance: updated };
  } catch (err) {
    if (!isStaticSecretBindingUniqueConflict(err)) {
      throw err;
    }
    return resolveIdentityBindingConflict(ctx, store, current, sourceBindingKey, err, input);
  }
}

// Runs the synchronous credential probe when one is configured. Returns the
// probed identity on success, null-with-side-effects on rejection (audit emitted,
// error sent, draft remains resumable), or `{ probedIdentity: null }` when the probe is
// absent or skipped.
async function runCredentialProbe(
  ctx: MountRefStaticSecretCredentialsContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectorInstanceId: string;
    connectorId: string;
    connectorKey: string;
    credentialKind: string | null;
    ownerSubjectId: string | null;
    secret: string;
    setupFields?: Record<string, string>;
  }
): Promise<{ probedIdentity: { detail: string | null; identity: string } | null } | null> {
  if (typeof ctx.probeStaticSecretCredential !== "function") {
    return { probedIdentity: null };
  }
  const probeContext = await probeContextForInstance(ctx, args.connectorInstanceId, args.setupFields);
  const probeResult = await ctx.probeStaticSecretCredential({
    connectorKey: args.connectorKey,
    context: probeContext,
    secret: args.secret,
  });
  if (!probeResult.ok) {
    await emitCaptureAudit(ctx, req, res, {
      connectionId: args.connectorInstanceId,
      connectorId: args.connectorId,
      credentialKind: args.credentialKind,
      error: errWithCode(probeResult.code),
      outcome: "failed",
      ownerSubjectId: args.ownerSubjectId,
    });
    ctx.pdppError(res, 400, "static_secret_credential_rejected", probeResult.message);
    return null;
  }
  if (probeResult.skipped === true) {
    return { probedIdentity: null };
  }
  return { probedIdentity: { detail: probeResult.detail ?? null, identity: probeResult.identity } };
}

// Validates the expected credential kind for a namespace and that encryption is
// configured. Emits audit + sends the error response on failure and returns
// null; returns the manifest's non-secret setup fields when all checks pass.
async function validateCredentialKind(
  ctx: MountRefStaticSecretCredentialsContext,
  req: RouteRequest,
  res: RouteResponse,
  namespace: ConnectorNamespace,
  credentialKind: string | null,
  ownerSubjectId: string | null
): Promise<StaticSecretCredentialContract | null> {
  const contract = await staticSecretCredentialContract(ctx, namespace.connectorId);
  if (!contract) {
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
    return null;
  }
  if (credentialKind !== contract.credentialKind) {
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
      `credential_kind must be '${contract.credentialKind}' for connector '${namespace.connectorId}'.`,
      "credential_kind"
    );
    return null;
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
    return null;
  }
  return contract;
}

// Stores the validated credential and sends the success response.
async function storeAndRespond(
  ctx: MountRefStaticSecretCredentialsContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    credentialKind: string | null;
    deduplicated?: boolean;
    namespace: ConnectorNamespace;
    ownerSubjectId: string | null;
    probedIdentity: { detail: string | null; identity: string } | null;
    secret: string;
  }
): Promise<void> {
  const store = ctx.createRequestConnectorInstanceCredentialStore();
  const previous = await store.getMetadata(args.namespace.connectorInstanceId);
  const now = ctx.now ? ctx.now() : new Date().toISOString();
  const metadata = await store.capture({
    connectorInstanceId: args.namespace.connectorInstanceId,
    credentialKind: args.credentialKind ?? "",
    now,
    ownerSubjectId: args.ownerSubjectId ?? "",
    secret: args.secret,
  });
  const rotated = Boolean(previous);
  const autoResume = await autoResumeAfterCredentialCapture(ctx, args.namespace, metadata);
  await emitCaptureAudit(ctx, req, res, {
    connectionId: args.namespace.connectorInstanceId,
    connectorId: args.namespace.connectorId,
    credentialKind: args.credentialKind,
    outcome: "succeeded",
    ownerSubjectId: args.ownerSubjectId,
    rotated,
  });
  res.status(rotated ? 200 : 201).json({
    auto_resume: autoResume,
    connection_id: args.namespace.connectorInstanceId,
    connector_id: args.namespace.connectorId,
    connector_instance_id: args.namespace.connectorInstanceId,
    credential: projectCredentialMetadata(metadata),
    // Non-secret account identity from a synchronous probe ("Connected as
    // {identity}"). Null when the connector has no probe (first-sync path)
    // or the probe returned no identity. Never carries the secret.
    identity: args.probedIdentity
      ? { account_identity: args.probedIdentity.identity, detail: args.probedIdentity.detail }
      : null,
    ...(args.deduplicated ? { deduplicated: true } : {}),
    next_step: {
      kind: "run_connection",
      method: "POST",
      reason:
        "Run this connection from the owner session or scheduler. The connection stays hidden until first ingest accepts records.",
      url: `/_ref/connections/${encodeURIComponent(args.namespace.connectorInstanceId)}/run`,
    },
    object: "static_secret_credential_capture",
    // Whether the credential was validated synchronously before storing.
    validation: args.probedIdentity ? "synchronous" : "first_sync",
  });
}

// POST /_ref/connections/:connectorInstanceId/static-secret-credential
//
// Owner-session-only credential capture for one existing connection. The
// plaintext appears only in the request body and the store's sealing call; the
// response and audit event contain non-secret metadata only.
interface CaptureRequestState {
  credentialKind: string | null;
  namespace: ConnectorNamespace | null;
  ownerSubjectId: string | null;
}

async function runStaticSecretCredentialCapture(
  ctx: MountRefStaticSecretCredentialsContext,
  req: RouteRequest,
  res: RouteResponse,
  connectorInstanceId: string,
  state: CaptureRequestState
): Promise<void> {
  const ownerSubjectId = ctx.getOwnerSubjectId(req);
  state.ownerSubjectId = ownerSubjectId;
  const capture = parseCaptureBody(ctx, res, req.body);
  if (!capture) {
    await emitCaptureAudit(ctx, req, res, {
      connectionId: connectorInstanceId,
      credentialKind: state.credentialKind,
      error: errWithCode("invalid_request"),
      outcome: "failed",
      ownerSubjectId,
    });
    return;
  }
  const { credentialKind, secret, setupFieldsRaw } = capture;
  state.credentialKind = credentialKind;
  const namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
    allowDefaultAccount: false,
    // Admit a `draft` target so the owner can seal a credential onto a
    // not-yet-ingested first static-secret connection. This is owner-
    // session-only; no bearer/agent path passes allowStatuses. See
    // add-static-secret-owner-session-connect-path design Decisions 3 & 5.
    allowStatuses: ["active", "draft"],
    connectorInstanceId,
    ownerSubjectId,
  });
  state.namespace = namespace;
  const contract = await validateCredentialKind(ctx, req, res, namespace, credentialKind, ownerSubjectId);
  if (!contract) {
    return;
  }
  const submittedSetupFields = parseStaticSecretSetupFields(setupFieldsRaw, contract.fields, (code, message, param) =>
    ctx.pdppError(res, 400, code, message, param)
  );
  if (submittedSetupFields === null) {
    return;
  }
  await updateDraftSetupFieldsBeforeProbe(ctx, {
    connectorId: namespace.connectorId,
    connectorInstanceId: namespace.connectorInstanceId,
    ownerSubjectId,
    ...(submittedSetupFields ? { setupFields: submittedSetupFields } : {}),
  });
  // Synchronous validation moment (owner-journey flow design B1). When a
  // probe is injected, validate the credential against the provider BEFORE
  // storing it. A known-bad credential is rejected and NOTHING is written.
  // A skipped probe preserves the first-sync path.
  const probeConnectorKey = ctx.canonicalConnectorKey
    ? (ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId)
    : namespace.connectorId;
  const probeOutcome = await runCredentialProbe(ctx, req, res, {
    connectorId: namespace.connectorId,
    connectorInstanceId: namespace.connectorInstanceId,
    connectorKey: probeConnectorKey,
    credentialKind,
    ownerSubjectId,
    secret,
    ...(submittedSetupFields ? { setupFields: submittedSetupFields } : {}),
  });
  if (probeOutcome === null) {
    return;
  }
  let responseNamespace = namespace;
  let deduplicated = false;
  const { probedIdentity } = probeOutcome;
  if (probedIdentity) {
    const identityFieldName = contract.fields.find((field) => field.identity && !field.secret)?.name;
    const claim = await claimProbedStaticSecretIdentity(ctx, {
      connectorId: namespace.connectorId,
      connectorInstanceId: namespace.connectorInstanceId,
      ...(identityFieldName ? { identityFieldName } : {}),
      ownerSubjectId,
      probedIdentity: probedIdentity.identity,
      ...(submittedSetupFields ? { setupFields: submittedSetupFields } : {}),
    });
    const { deduplicated: claimWasDeduplicated, instance } = claim;
    deduplicated = claimWasDeduplicated;
    responseNamespace = { ...namespace, connectorInstanceId: instance.connectorInstanceId };
  }
  await storeAndRespond(ctx, req, res, {
    credentialKind,
    ...(deduplicated ? { deduplicated: true } : {}),
    namespace: responseNamespace,
    ownerSubjectId,
    probedIdentity,
    secret,
  });
}

async function handleStaticSecretCredentialCapture(
  ctx: MountRefStaticSecretCredentialsContext,
  req: RouteRequest,
  res: RouteResponse,
  connectorInstanceId: string
): Promise<void> {
  const state: CaptureRequestState = { credentialKind: null, namespace: null, ownerSubjectId: null };
  try {
    await runStaticSecretCredentialCapture(ctx, req, res, connectorInstanceId, state);
  } catch (err) {
    const auditNamespace = state.namespace;
    await emitCaptureAudit(ctx, req, res, {
      connectionId: auditNamespace ? auditNamespace.connectorInstanceId : connectorInstanceId,
      connectorId: auditNamespace ? auditNamespace.connectorId : null,
      credentialKind: state.credentialKind,
      error: err,
      outcome: "failed",
      ownerSubjectId: state.ownerSubjectId,
    });
    const status = credentialCaptureErrorStatus(err);
    const { code } = err as { code?: unknown };
    if (typeof code === "string" && status !== 500) {
      ctx.pdppError(res, status, code, err instanceof Error ? err.message : String(err));
      return;
    }
    ctx.handleError(res, err);
  }
}

export function mountRefStaticSecretCredentialCapture(app: AppLike, ctx: MountRefStaticSecretCredentialsContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/static-secret-credential",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) =>
      handleStaticSecretCredentialCapture(ctx, req, res, decodeURIComponent(req.params.connectorInstanceId as string))
  );
}
