// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reference-only owner-session static-secret credential capture.
//
// This is the owner-trusted surface for sealing one connector-declared provider
// static secret onto one existing connection. It is NOT an owner-agent bearer
// route and it never returns the submitted secret. Owner-agent intent may point
// at the owner-session capture page, but it never carries the credential itself.

import {
  isBundledStaticSecretCredentialKind,
  isFullyBundledStaticSecretCredentialKind,
} from "../../../packages/polyfill-connectors/src/static-secret-credential-capture.ts";

import {
  type ConnectorManifestLike,
  expectedStaticSecretCredentialKind,
  type StaticSecretSetupField,
  staticSecretCredentialCaptureFromManifest,
} from "../connection-setup-plan.ts";
import {
  assertStaticSecretActiveCredentialReplacementAllowed,
  isStaticSecretBindingUniqueConflict,
  isStaticSecretPipelineBinding,
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
  // Non-secret, key-derived fingerprint of a candidate plaintext — used to
  // prove "is this the exact same credential already stored" without
  // sealing/persisting anything. See connector-instance-credential-store.ts.
  fingerprintCandidate: (secret: string) => string | null;
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
    ownerSubjectId: string;
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
  // Credential capture changes the owner-facing connector summary state and
  // must invalidate any in-flight summary projection before the response.
  invalidateConnectorSummariesCache?: () => void;
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
  /** Block-level `credential_capture.required` — see `validateBundledSecret`'s doc. */
  readonly required: boolean;
}

async function staticSecretCredentialContract(
  ctx: MountRefStaticSecretCredentialsContext,
  connectorId: string
): Promise<StaticSecretCredentialContract | null> {
  const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
  const credentialKind = expectedStaticSecretCredentialKind(connectorId, manifest);
  const capture = staticSecretCredentialCaptureFromManifest(manifest);
  return credentialKind && capture ? { credentialKind, fields: capture.fields, required: capture.required } : null;
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
  credential: CredentialMetadata,
  ownerSubjectId: string
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
      ownerSubjectId,
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
    ownerSubjectId: string;
    probedIdentity: string;
    secret: string;
    setupFields?: Record<string, string>;
  }
): Promise<ClaimedStaticSecretIdentity> {
  const store = requireConnectorInstanceStore(ctx);
  const { identity, sourceBindingKey } = staticSecretIdentityClaim(input);
  const current = await currentInstanceOrThrow(store, input.connectorInstanceId);
  const binding = currentBindingOrThrow(current);
  if (current.status === "active" && isStaticSecretPipelineBinding(current.sourceBinding)) {
    const credentialStore = ctx.createRequestConnectorInstanceCredentialStore();
    const existingCredential = await credentialStore.getMetadata(input.connectorInstanceId);
    assertStaticSecretActiveCredentialReplacementAllowed({
      existingCredentialFingerprint: existingCredential?.fingerprint ?? null,
      hasExistingCredential: existingCredential !== null,
      newSecretFingerprint: credentialStore.fingerprintCandidate(input.secret),
      probedIdentity: identity,
      sourceBinding: current.sourceBinding,
      status: current.status,
    });
  }
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

// Guards a credential replacement when there is no probed identity to claim
// (no-probe connector, or a probe that self-reported skipped). The active-
// connection fail-closed rule still applies here — this is the primary
// reproduction path for PR #84's P1: a connection that reached `active`
// through first-sync with no probe ever running has no durable identity
// signal on its binding, and nothing about that absence licenses a silent
// credential swap.
//
// Deliberately never passes anything derived from `setup_fields` as identity
// proof here: those are owner-typed, non-secret, and trivially resubmittable
// by an attacker alongside a stolen secret. With no probe, the only channel
// this route can offer is the credential fingerprint.
async function assertActiveReplacementAllowedWithoutProbe(
  ctx: MountRefStaticSecretCredentialsContext,
  input: { connectorInstanceId: string; secret: string }
): Promise<void> {
  const store = requireConnectorInstanceStore(ctx);
  const current = await currentInstanceOrThrow(store, input.connectorInstanceId);
  if (current.status !== "active" || !isStaticSecretPipelineBinding(current.sourceBinding)) {
    return;
  }
  const credentialStore = ctx.createRequestConnectorInstanceCredentialStore();
  const existingCredential = await credentialStore.getMetadata(input.connectorInstanceId);
  assertStaticSecretActiveCredentialReplacementAllowed({
    existingCredentialFingerprint: existingCredential?.fingerprint ?? null,
    hasExistingCredential: existingCredential !== null,
    newSecretFingerprint: credentialStore.fingerprintCandidate(input.secret),
    sourceBinding: current.sourceBinding,
    status: current.status,
  });
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

// A REQUIRED contract (credential_capture.required is not false) whose
// secret fields are all individually optional describes "at least one
// credential path" (for example, username+password OR an API key) —
// per-field `required` checks never fire on a fully empty submission for
// that shape, so it needs its own presence check to reject one.
function isAtLeastOnePathContract(secretFields: readonly StaticSecretSetupField[]): boolean {
  return secretFields.length > 0 && !secretFields.some((field) => field.required);
}

function parseSecretBundle(secret: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function bundleHasAnySecret(bundle: Record<string, unknown>, secretFields: readonly StaticSecretSetupField[]): boolean {
  return secretFields.some((field) => {
    const value = bundle[field.name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function bundleHasField(bundle: Record<string, unknown>, field: StaticSecretSetupField): boolean {
  const value = bundle[field.name];
  return typeof value === "string" && value.trim().length > 0;
}

// Shared reject path for every `validateBundledSecret` rejection: audit +
// respond identically, only the message differs.
async function rejectMissingCredential(
  ctx: MountRefStaticSecretCredentialsContext,
  req: RouteRequest,
  res: RouteResponse,
  namespace: ConnectorNamespace,
  credentialKind: string | null,
  ownerSubjectId: string | null,
  message: string
): Promise<void> {
  await emitCaptureAudit(ctx, req, res, {
    connectionId: namespace.connectorInstanceId,
    connectorId: namespace.connectorId,
    credentialKind,
    error: errWithCode("missing_credential"),
    outcome: "failed",
    ownerSubjectId,
  });
  ctx.pdppError(res, 400, "missing_credential", message, "secret");
}

/** Every field in the bundle is absent — the connector-honest "sign in by hand" choice, never a partial submission. */
function bundleIsEntirelyBlank(contract: StaticSecretCredentialContract, bundle: Record<string, unknown>): boolean {
  return !contract.fields.some((field) => bundleHasField(bundle, field));
}

// The ONE per-field completeness rule, shared by BOTH `validateBundledSecret`
// branches. A fully bundled credential requires every required capture field;
// a partially bundled credential requires its required secret fields. For a REQUIRED capture this is the
// manifest contract enforced directly (a partial username/password bundle or
// a literal `{}` fails here, before any probe or store). For an OPTIONAL
// capture (BOTH-OR-NONE) the caller must check
// `bundleIsEntirelyBlank` FIRST — an entirely blank bundle is the valid
// "sign in by hand" choice this function does not itself special-case — and
// the moment ANY field is present, the same rule applies unchanged.
// The credential-kind fact is load-bearing: `secret_bundle` seals non-secret
// fields too, while `username_password` keeps setup fields (such as a base URL)
// outside the credential so rotation does not require resubmitting them.
function missingRequiredBundledFields(
  contract: StaticSecretCredentialContract,
  bundle: Record<string, unknown>
): readonly StaticSecretSetupField[] {
  const fullyBundled = isFullyBundledStaticSecretCredentialKind(contract.credentialKind);
  return contract.fields.filter(
    (field) => (fullyBundled || field.secret) && field.required && !bundleHasField(bundle, field)
  );
}

// The wire encoding for "no credential was submitted" on an OPTIONAL
// capture, for EITHER kind shape — mirrors the console's
// `BLANK_OPTIONAL_SECRET_SENTINEL` (`static-secret-payload.ts`) exactly.
// `parseCaptureBody` above rejects a genuinely empty string outright as
// `invalid_request` before any required/optional logic runs, so a blank
// choice must arrive as a non-empty sentinel. Checked by EXACT string
// equality, never a length/trim heuristic — a bare provider secret is
// legitimately allowed to be short, and only this one reserved value means
// "nothing was chosen".
const BLANK_OPTIONAL_SECRET_SENTINEL = "{}";

/**
 * Outcome of validating a submitted secret/bundle against the manifest's
 * contract, before ANY store write. A `"rejected"` outcome carries its owner-
 * facing message so the decision and its explanation come from the SAME
 * branch — never a second function re-deriving which rule fired.
 */
type BundledSecretValidation =
  | { readonly kind: "blank_optional" }
  | { readonly kind: "proceed" }
  | { readonly kind: "rejected"; readonly message: string };

function validateSingleSecret(contract: StaticSecretCredentialContract, secret: string): BundledSecretValidation {
  if (secret !== BLANK_OPTIONAL_SECRET_SENTINEL) {
    return { kind: "proceed" };
  }
  // F4: the blank-sentinel single secret on an OPTIONAL capture is the same
  // valid "sign in by hand" choice a blank bundle is for a multi-field
  // capture — not reachable by any shipped manifest today (every
  // `required: false` manifest is `username_password`), but the next
  // single-field optional manifest must not silently inherit the
  // always-required assumption the pre-F4 code made by omission.
  if (contract.required === false) {
    return { kind: "blank_optional" };
  }
  const field = contract.fields.find((candidate) => candidate.secret);
  return { kind: "rejected", message: field ? `${field.label} is required.` : "A secret field is required." };
}

/**
 * The server-side re-validation twin of the console's `bundledSecretPayload`
 * — the console already applied this rule once when it built `secret`, but
 * this route is the one place every manifest is actually enforced (an
 * owner-agent or a future non-console client could submit here directly),
 * so the rule cannot live in the console alone.
 *
 * `contract.required` (block-level `credential_capture.required`, default
 * true) is the ONE provider-neutral fact this decides on — never a
 * connector-name branch, never an inference from field count.
 *
 * Returns `"blank_optional"` — rather than `"proceed"` — for an entirely
 * blank bundle on an OPTIONAL capture: the caller must NOT store `"{}"` as a
 * credential for that case (F1). An optional capture's blank choice means
 * "proceed with manual browser sign-in", not "store an empty secret" —
 * those are different outcomes the old boolean return could not express.
 *
 * Past that one optional-only escape, required and optional captures share
 * the SAME per-field rule (`missingRequiredBundledFields`): a bundle missing
 * any field required by its credential-kind bundling policy is rejected before the
 * credential probe, the replacement guard, and the store. A REQUIRED
 * username/password capture therefore fails closed on a partial bundle or a
 * literal `{}` at capture time — not later at injection.
 */
function validateBundledSecret(contract: StaticSecretCredentialContract, secret: string): BundledSecretValidation {
  if (!isBundledStaticSecretCredentialKind(contract.credentialKind)) {
    return validateSingleSecret(contract, secret);
  }
  const bundle = parseSecretBundle(secret);
  if (contract.required === false && bundleIsEntirelyBlank(contract, bundle)) {
    return { kind: "blank_optional" };
  }
  const missing = missingRequiredBundledFields(contract, bundle);
  if (missing.length > 0) {
    const labels = missing.map((field) => field.label).join(", ");
    return {
      kind: "rejected",
      message:
        contract.required === false
          ? `${labels} is required once any credential field is filled.`
          : `${labels} is required.`,
    };
  }
  const secretFields = contract.fields.filter((field) => field.secret);
  if (isAtLeastOnePathContract(secretFields) && !bundleHasAnySecret(bundle, secretFields)) {
    return {
      kind: "rejected",
      message: `At least one of ${secretFields.map((field) => field.label).join(", ")} is required.`,
    };
  }
  return { kind: "proceed" };
}

// Stores the validated credential and sends the success response.
// A `paused` connection is the only status admitted by this route's
// `allowStatuses` that isn't already collectible (`active`) or pre-first-sync
// (`draft`). Widening the allowlist to admit it without also resuming it here
// would leave the owner's "fix and resume" action stuck: the credential
// saves, but `admitOwnerRunConnection`'s active-only gate keeps rejecting
// both the manual run this response links to and every scheduled run, with
// no other path in this codebase that ever flips `paused` back to `active`.
// This mirrors owner-connection-reactivate.ts's `revoked -> active` flip,
// scoped to `paused` and with no `revokedAt` field to clear.
async function resumePausedConnectionAfterCredentialCapture(
  ctx: MountRefStaticSecretCredentialsContext,
  connectorInstanceId: string,
  updatedAt: string
): Promise<boolean> {
  if (typeof ctx.createRequestConnectorInstanceStore !== "function") {
    return false;
  }
  const store = ctx.createRequestConnectorInstanceStore();
  const current = await store.get(connectorInstanceId);
  if (!current || current.status !== "paused") {
    return false;
  }
  await store.updateStatus(connectorInstanceId, { status: "active", updatedAt });
  return true;
}

async function storeAndRespond(
  ctx: MountRefStaticSecretCredentialsContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    credentialKind: string | null;
    deduplicated?: boolean;
    namespace: ConnectorNamespace;
    ownerSubjectId: string;
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
    ownerSubjectId: args.ownerSubjectId,
    secret: args.secret,
  });
  ctx.invalidateConnectorSummariesCache?.();
  const resumed = await resumePausedConnectionAfterCredentialCapture(ctx, args.namespace.connectorInstanceId, now);
  const rotated = Boolean(previous);
  const autoResume = await autoResumeAfterCredentialCapture(ctx, args.namespace, metadata, args.ownerSubjectId);
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
    ...(resumed ? { resumed_from_paused: true } : {}),
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

/**
 * Ruling (F1): an entirely blank submission on an OPTIONAL capture means
 * "proceed with manual browser sign-in", never "store an empty credential".
 * This function therefore:
 *   - never calls `store.capture(...)` — no row is written, no existing
 *     credential is touched, rotated, or cleared;
 *   - projects `credential.present: false` honestly (never the store's
 *     always-`present:true` shape a written row would carry);
 *   - still returns 200/201 and a `run_connection` next step, because a
 *     blank optional choice is a VALID, complete setup outcome — the
 *     connector's own manual-sign-in fallback is what makes the run able to
 *     proceed with zero credentials (see `isStaticSecretCaptureOptional` in
 *     `static-secret-injection.ts` for the run-time half of this contract).
 * No credential probe runs (there is nothing to probe) and no
 * active-replacement guard runs (there is nothing to replace).
 */
async function respondWithoutStoringCredential(
  ctx: MountRefStaticSecretCredentialsContext,
  req: RouteRequest,
  res: RouteResponse,
  args: { credentialKind: string | null; namespace: ConnectorNamespace; ownerSubjectId: string | null }
): Promise<void> {
  await emitCaptureAudit(ctx, req, res, {
    connectionId: args.namespace.connectorInstanceId,
    connectorId: args.namespace.connectorId,
    credentialKind: args.credentialKind,
    outcome: "succeeded",
    ownerSubjectId: args.ownerSubjectId,
    rotated: false,
  });
  res.status(200).json({
    auto_resume: null,
    connection_id: args.namespace.connectorInstanceId,
    connector_id: args.namespace.connectorId,
    connector_instance_id: args.namespace.connectorInstanceId,
    credential: {
      captured_at: null,
      credential_kind: null,
      fingerprint: null,
      present: false,
      revoked_at: null,
      rotated_at: null,
      status: null,
    },
    identity: null,
    next_step: {
      kind: "run_connection",
      method: "POST",
      reason:
        "No credential was saved — this connector signs in through the secure browser instead. Run this connection to begin that sign-in.",
      url: `/_ref/connections/${encodeURIComponent(args.namespace.connectorInstanceId)}/run`,
    },
    object: "static_secret_credential_capture",
    validation: "first_sync",
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
    // Admit `paused` too: a paused connection is still owned and still has a
    // durable identity/binding — updating its sign-in details is the
    // supported "fix and resume" action, not a state the owner is blocked
    // from touching. `revoked` is deliberately excluded; that path stays
    // owner-connection-reactivate.ts's job (see storeAndRespond's paused ->
    // active flip below for the resume half of this contract).
    allowStatuses: ["active", "draft", "paused"],
    connectorInstanceId,
    ownerSubjectId,
  });
  state.namespace = namespace;
  const contract = await validateCredentialKind(ctx, req, res, namespace, credentialKind, ownerSubjectId);
  if (!contract) {
    return;
  }
  const validation = validateBundledSecret(contract, secret);
  if (validation.kind === "rejected") {
    await rejectMissingCredential(ctx, req, res, namespace, credentialKind, ownerSubjectId, validation.message);
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

  // F1: an entirely blank submission on an OPTIONAL capture proceeds with
  // manual browser sign-in — it never reaches the credential probe, the
  // active-replacement guard, or the store. Nothing is written, nothing
  // existing is touched, and the response is honest that no credential is
  // present.
  if (validation.kind === "blank_optional") {
    await respondWithoutStoringCredential(ctx, req, res, { credentialKind, namespace, ownerSubjectId });
    return;
  }

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
  const { probedIdentity } = probeOutcome;
  const { deduplicated, responseNamespace } = await claimOrGuardReplacement(ctx, {
    namespace,
    ownerSubjectId,
    probedIdentity,
    secret,
    ...(submittedSetupFields ? { submittedSetupFields } : {}),
  });
  await storeAndRespond(ctx, req, res, {
    credentialKind,
    ...(deduplicated ? { deduplicated: true } : {}),
    namespace: responseNamespace,
    ownerSubjectId,
    probedIdentity,
    secret,
  });
}

// After a probe either names an identity or is skipped, either claims that
// identity (existing behavior) or — with no probed identity to claim — still
// runs the active-replacement guard. An active connection with no durable,
// provider-verified identity is never silently retargetable just because
// nothing on record contradicts the new secret; owner-typed `setup_fields`
// are never consulted as proof here (see assertActiveReplacementAllowedWithoutProbe).
async function claimOrGuardReplacement(
  ctx: MountRefStaticSecretCredentialsContext,
  input: {
    namespace: ConnectorNamespace;
    ownerSubjectId: string;
    probedIdentity: { detail: string | null; identity: string } | null;
    secret: string;
    submittedSetupFields?: Record<string, string>;
  }
): Promise<{ deduplicated: boolean; responseNamespace: ConnectorNamespace }> {
  if (input.probedIdentity) {
    const claim = await claimProbedStaticSecretIdentity(ctx, {
      connectorId: input.namespace.connectorId,
      connectorInstanceId: input.namespace.connectorInstanceId,
      ownerSubjectId: input.ownerSubjectId,
      probedIdentity: input.probedIdentity.identity,
      secret: input.secret,
      ...(input.submittedSetupFields ? { setupFields: input.submittedSetupFields } : {}),
    });
    return {
      deduplicated: claim.deduplicated,
      responseNamespace: { ...input.namespace, connectorInstanceId: claim.instance.connectorInstanceId },
    };
  }
  await assertActiveReplacementAllowedWithoutProbe(ctx, {
    connectorInstanceId: input.namespace.connectorInstanceId,
    secret: input.secret,
  });
  return { deduplicated: false, responseNamespace: input.namespace };
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
