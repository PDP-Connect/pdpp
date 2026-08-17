// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the bearer-authed owner-agent connection-intent route
// `POST /v1/owner/connections/intents`.
//
// This is the owner-agent (bearer) entrypoint a trusted local agent
// (Daisy/Simon-style automation) uses to answer "how do I add a new connection
// for connector X?". It does NOT create a connection: it returns a typed,
// auditable, owner-mediated next step. The connection only materializes when the
// owner-mediated step completes (for the local-collector path, when the device
// exchanges the minted enrollment code and ingests).
//
// It is the `/v1/owner/*` sibling of the cookie-authed `/_ref/*` surface and
// reuses the existing owner-bearer guards (`requireToken` + `requireOwner`)
// without teaching `requireOwnerSession` (cookie) a second identity source.
// `/mcp` owner-bearer rejection (`requireClientOrMcpPackage`) is untouched.
//
// Honesty rule (full-context-refresh "Treat gaps as first-class outputs"): the
// route classifies the connector through the shared setup planner and returns
// the planner's typed support state, proof gate, deployment readiness, and next
// owner step. It only mints enrollment material for supported paths. Proof-gated
// and deployment-blocked paths return non-secret next steps, never faked active
// connections.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control SHALL initiate connections as typed
//         owner-mediated intents")

import { buildConnectionSetupPlan, type ConnectorIntentModality } from "../connection-setup-plan.ts";
import { auditActorKind, buildAuditTrace } from "./_owner-connection-helpers.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg, TraceContext } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/owner-connections.ts`.

interface RouteRequest {
  readonly body?: unknown;
  get: (name: string) => string | undefined;
  readonly hostname: string;
  readonly protocol: string;
  readonly tokenInfo?: {
    readonly client_id?: string | null;
    readonly client_name?: string | null;
    readonly pdpp_token_kind?: string | null;
    readonly scenario_id?: string | null;
    readonly subject_id?: string | null;
  } | null;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

// Minimal connector manifest shape this classifier reads. Manifests carry far
// more; the classifier only inspects the runtime binding requirements.
interface ConnectorManifestLike {
  readonly connector_id?: string | null;
  readonly display_name?: string | null;
  readonly runtime_requirements?: {
    readonly bindings?: Readonly<Record<string, unknown>> | null;
  } | null;
}

interface DeviceExporterEnrollmentStore {
  createEnrollmentCode: (input: {
    enrollmentCodeId: string;
    codeHash: string;
    ownerSubjectId: string;
    connectorId: string;
    localBindingId: string;
    displayName: string | null;
    createdAt: string;
    expiresAt: string;
    // The boundary the owner declared while initiating this connection, or
    // `null` for an unscoped (full-corpus) collection. Staged here because no
    // connection exists yet to hold `connector_state.$collection_scope`; the
    // enroll route (`ref-device-exporters.ts`) applies it to that reserved key
    // the moment the connector instance first materializes.
    collectionScope?: { since?: string; source_roots?: string[] } | null;
  }) => Promise<unknown> | unknown;
}

export interface MountOwnerConnectionIntentContext {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  deviceExporterStore: DeviceExporterEnrollmentStore;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  ensureRequestId: (res: RouteResponse) => string;
  generateReferenceSecret: (prefix: string, bytes?: number) => string;
  generateSpineId: (prefix: string) => string;
  // Resolves a connector manifest for a registered connector. Returns `null`
  // for an unknown connector. Async to match the host's `getConnectorManifest`.
  getConnectorManifest: (connectorId: string) => Promise<ConnectorManifestLike | null> | ConnectorManifestLike | null;
  getOwnerTokenSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  hashDeviceSecret: (value: string) => string;
  now?: () => string;
  pdppError: PdppErrorFn;
  // Resolves a local-collector catalog manifest (claude-code, codex) by key, or
  // `null` for connectors not in the local-collector catalog. Mirrors the host's
  // `readReferenceLocalConnectorCatalogManifest`.
  readReferenceLocalConnectorCatalogManifest: (connectorId: string) => ConnectorManifestLike | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Resolves the caller-visible trusted AS issuer base (forwarded-origin-safe).
  // The device-exporter enroll route lives on the AS app, so the enroll endpoint
  // the local collector should call is built from the AS base, not the RS base
  // this route is served from.
  resolveEnrollBaseUrl: (req: unknown) => string;
  setReferenceTraceId: (res: RouteResponse, traceId: string) => void;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

// Emits non-secret audit evidence for an owner-agent connection-initiation
// attempt. Records actor kind/client, target connector identity, modality, the
// returned next-step kind, and outcome. Never logs bearer tokens, the minted
// enrollment code, or the caller-supplied display name. Mirrors the rename
// route's `owner_agent.connection.rename` evidence quality.
async function emitConnectionIntentAudit(
  ctx: MountOwnerConnectionIntentContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectorKey?: string | null;
    connectorModality?: ConnectorIntentModality | null;
    displayNameSupplied?: boolean;
    error?: unknown;
    nextStepKind?: string | null;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, req, res);
  const clientId = typeof req.tokenInfo?.client_id === "string" ? req.tokenInfo.client_id : null;
  const clientName = typeof req.tokenInfo?.client_name === "string" ? req.tokenInfo.client_name : null;
  const actorKind = auditActorKind(req);
  const ownerSubjectId =
    args.ownerSubjectId ?? (typeof req.tokenInfo?.subject_id === "string" ? req.tokenInfo.subject_id : null);
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    actor_id: clientId ?? ownerSubjectId ?? actorKind,
    actor_type: actorKind,
    client_id: clientId,
    data: {
      actor_kind: actorKind,
      auth_token_kind: req.tokenInfo?.pdpp_token_kind ?? null,
      client_id: clientId,
      client_name: clientName,
      connector_key: args.connectorKey ?? null,
      connector_modality: args.connectorModality ?? null,
      display_name_supplied: args.displayNameSupplied ?? false,
      next_step_kind: args.nextStepKind ?? null,
      operation: "initiate_connection",
      outcome: args.outcome,
      target_resource: "connection_intent",
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
            },
          }
        : {}),
    },
    event_type: "owner_agent.connection.initiate",
    object_id: args.connectorKey || "unknown_connector",
    object_type: "connection_intent",
    request_id: trace.request_id,
    scenario_id: trace.scenario_id,
    status: args.outcome,
    subject_id: ownerSubjectId,
    subject_type: "subject",
    trace_id: trace.trace_id,
  });
}

// Owner-agent bearer guard that emits a failed-initiation audit event before
// rejecting a non-owner bearer, so an unauthorized initiation attempt is
// recorded with the same evidence quality as the rename route.
function buildConnectionIntentRequireOwner(ctx: MountOwnerConnectionIntentContext): MiddlewareHandler {
  return async (...args: unknown[]) => {
    const [req, res, next] = args as [RouteRequest, RouteResponse, () => unknown | Promise<unknown>];
    if (req.tokenInfo?.pdpp_token_kind === "owner") {
      await next();
      return;
    }
    const err = new Error("Owner token required") as Error & { code: string };
    err.code = "permission_error";
    await emitConnectionIntentAudit(ctx, req, res, {
      error: err,
      outcome: "failed",
      ownerSubjectId: typeof req.tokenInfo?.subject_id === "string" ? req.tokenInfo.subject_id : null,
    });
    ctx.pdppError(res, 403, "permission_error", "Owner token required");
  };
}

/** Validate `collection_scope.since`. `undefined`/`null` means "not declared", not an error. */
function parseIntentScopeSince(value: unknown): { ok: true; since?: string } | { ok: false; message: string } {
  if (value === undefined || value === null) {
    return { ok: true };
  }
  if (typeof value !== "string" || !value.trim()) {
    return { message: "collection_scope.since must be a non-empty ISO-8601 string", ok: false };
  }
  if (Number.isNaN(Date.parse(value.trim()))) {
    return { message: `collection_scope.since is not a parseable instant: ${value}`, ok: false };
  }
  return { ok: true, since: value.trim() };
}

/** Validate `collection_scope.source_roots`. `undefined`/`null` means "not declared", not an error. */
function parseIntentScopeSourceRoots(
  value: unknown
): { ok: true; source_roots?: string[] } | { ok: false; message: string } {
  if (value === undefined || value === null) {
    return { ok: true };
  }
  if (!Array.isArray(value)) {
    return { message: "collection_scope.source_roots must be an array of strings", ok: false };
  }
  const roots: string[] = [];
  for (const root of value) {
    if (typeof root !== "string" || !root.trim()) {
      return { message: "collection_scope.source_roots entries must be non-empty strings", ok: false };
    }
    roots.push(root.trim());
  }
  return roots.length > 0 ? { ok: true, source_roots: roots } : { ok: true };
}

/**
 * Validate an owner-declared `{ since?, source_roots? }` boundary from a raw
 * request field.
 *
 * Deliberately the same rules as `owner-connection-collection-scope.ts`'s
 * `parseScopeBody` (kept as a sibling copy rather than a shared import so this
 * route's request shape does not couple to that route's module): reject
 * rather than coerce, so a bound the server cannot parse never silently
 * becomes "matches everything", and a malformed root never silently widens
 * the selection.
 */
function parseIntentCollectionScope(
  value: unknown
): { ok: true; scope: { since?: string; source_roots?: string[] } | null } | { ok: false; message: string } {
  if (value === undefined || value === null) {
    return { ok: true, scope: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { message: "collection_scope must be an object", ok: false };
  }
  const body = value as Record<string, unknown>;
  const since = parseIntentScopeSince(body.since);
  if (!since.ok) {
    return since;
  }
  const roots = parseIntentScopeSourceRoots(body.source_roots);
  if (!roots.ok) {
    return roots;
  }
  if (since.since === undefined && roots.source_roots === undefined) {
    // An explicitly-empty `{}` declares no boundary; omit the field entirely
    // to mean the same thing. Neither is an error — only a malformed value is.
    return { ok: true, scope: null };
  }
  return {
    ok: true,
    scope: {
      ...(since.since === undefined ? {} : { since: since.since }),
      ...(roots.source_roots === undefined ? {} : { source_roots: roots.source_roots }),
    },
  };
}

// Validates connector_id, display_name, and an optional collection_scope from
// a raw request body. Returns a parsed result on success, or a descriptor of
// the validation failure so the caller can emit the audit event and respond
// consistently without nesting.
function parseConnectionIntentBody(body: Record<string, unknown>):
  | {
      ok: true;
      connectorId: string;
      displayName: string | null;
      displayNameSupplied: boolean;
      collectionScope: { since?: string; source_roots?: string[] } | null;
    }
  | {
      ok: false;
      field: "connector_id" | "display_name" | "collection_scope";
      message: string;
      displayNameSupplied: boolean;
    } {
  const rawConnectorId = body.connector_id;
  if (typeof rawConnectorId !== "string" || !rawConnectorId.trim()) {
    return {
      displayNameSupplied: false,
      field: "connector_id",
      message: "connector_id must be a non-empty string",
      ok: false,
    };
  }
  const displayNameSupplied = Object.hasOwn(body, "display_name");
  const displayNameRaw = body.display_name;
  if (
    displayNameSupplied &&
    (typeof displayNameRaw !== "string" || !displayNameRaw.trim() || displayNameRaw.trim().length > 200)
  ) {
    return {
      displayNameSupplied: true,
      field: "display_name",
      message: "display_name must be a non-empty string up to 200 characters when provided",
      ok: false,
    };
  }
  const parsedScope = parseIntentCollectionScope(body.collection_scope);
  if (!parsedScope.ok) {
    return {
      displayNameSupplied,
      field: "collection_scope",
      message: parsedScope.message,
      ok: false,
    };
  }
  return {
    collectionScope: parsedScope.scope,
    connectorId: rawConnectorId.trim(),
    displayName: typeof displayNameRaw === "string" ? displayNameRaw.trim() : null,
    displayNameSupplied,
    ok: true,
  };
}

// Mints a single-use enrollment code, persists it, and returns the enrollment
// payload for the `enroll_local_collector` next-step response. Extracts the
// time/secret/store operations so the main handler reads linearly.
async function mintEnrollmentNextStep(
  ctx: MountOwnerConnectionIntentContext,
  req: RouteRequest,
  args: {
    connectorKey: string;
    displayName: string | null;
    ownerSubjectId: string;
    collectionScope: { since?: string; source_roots?: string[] } | null;
  }
): Promise<{ enrollmentCode: string; enrollEndpoint: string; localBindingId: string; expiresAt: string }> {
  const enrollmentCode = ctx.generateReferenceSecret("lde", 18);
  const now = ctx.now ? ctx.now() : new Date().toISOString();
  const ENROLLMENT_TTL_SECONDS = 15 * 60;
  const expiresAt = new Date(Date.parse(now) + ENROLLMENT_TTL_SECONDS * 1000).toISOString();
  // The local binding id defaults to the connector key; the owner's
  // collector reuses it as the local binding name on enroll.
  const localBindingId = args.connectorKey;
  await ctx.deviceExporterStore.createEnrollmentCode({
    codeHash: ctx.hashDeviceSecret(enrollmentCode),
    collectionScope: args.collectionScope,
    connectorId: args.connectorKey,
    createdAt: now,
    displayName: args.displayName,
    enrollmentCodeId: ctx.generateSpineId("denroll"),
    expiresAt,
    localBindingId,
    ownerSubjectId: args.ownerSubjectId,
  });
  const enrollEndpoint = `${stripTrailingSlash(ctx.resolveEnrollBaseUrl(req))}/_ref/device-exporters/enroll`;
  return { enrollEndpoint, enrollmentCode, expiresAt, localBindingId };
}

// POST /v1/owner/connections/intents — bearer-authed owner-agent connection
// initiation. Auth: owner bearer (`pdpp_token_kind: "owner"`). Client and
// `mcp_package` bearers are rejected with 403; a missing bearer is rejected with
// 401 by `requireToken`. `/mcp` owner-bearer rejection is untouched.
export function mountOwnerConnectionIntent(app: AppLike, ctx: MountOwnerConnectionIntentContext): void {
  app.post(
    "/v1/owner/connections/intents",
    { contract: "ownerCreateConnectionIntent" },
    ctx.requireToken,
    buildConnectionIntentRequireOwner(ctx),
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const body = (req.body as Record<string, unknown> | null) || {};
        const parsed = parseConnectionIntentBody(body);
        if (!parsed.ok) {
          const err = new Error(parsed.message) as Error & { code: string; param: string };
          err.code = "invalid_request";
          err.param = parsed.field;
          await emitConnectionIntentAudit(ctx, req, res, {
            displayNameSupplied: parsed.displayNameSupplied,
            error: err,
            outcome: "failed",
            ownerSubjectId: ctx.getOwnerTokenSubjectId(req),
          });
          ctx.pdppError(res, 400, "invalid_request", parsed.message, parsed.field);
          return;
        }
        const { connectorId, displayName, displayNameSupplied, collectionScope } = parsed;
        const connectorKey = ctx.canonicalConnectorKey(connectorId) ?? connectorId;

        // Resolve the manifest from the local-collector catalog first (so a
        // claude-code/codex intent classifies even before any instance exists),
        // then fall back to a registered connector manifest. A null manifest is
        // an unknown connector.
        const localManifest = ctx.readReferenceLocalConnectorCatalogManifest(connectorKey);
        const manifest = localManifest ?? (await ctx.getConnectorManifest(connectorKey));
        const plan = buildConnectionSetupPlan({ connectorKey, manifest });
        const modality = plan.connectorModality;
        const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);

        if (
          plan.ownerAgentIntent.status === "supported" &&
          plan.ownerAgentIntent.nextStepKind === "enroll_local_collector"
        ) {
          // Mint a real single-use enrollment code via the SAME store operation
          // the cookie-authed `/_ref/device-exporters/enrollment-codes` route
          // uses (separate bearer auth adapter — no handler cloning). The owner's
          // local collector exchanges this code to materialize the connection and
          // performs any provider/browser step locally. No connection row is
          // written here; the instance materializes on enroll + ingest.
          const { enrollmentCode, enrollEndpoint, localBindingId, expiresAt } = await mintEnrollmentNextStep(ctx, req, {
            collectionScope,
            connectorKey,
            displayName,
            ownerSubjectId,
          });
          await emitConnectionIntentAudit(ctx, req, res, {
            connectorKey,
            connectorModality: modality,
            displayNameSupplied,
            nextStepKind: "enroll_local_collector",
            outcome: "succeeded",
            ownerSubjectId,
          });
          res.status(201).json({
            connection_active: false,
            connector_id: connectorKey,
            connector_key: connectorKey,
            connector_modality: modality,
            deployment_readiness: plan.deploymentReadiness,
            next_step: {
              // Echoed non-secret so the caller can confirm what boundary will
              // apply once the device enrolls, without a second round trip to
              // GET .../collection-scope. `null` means unscoped (full pass) —
              // the same honest default as declaring no scope at all.
              collection_scope: collectionScope,
              enroll_endpoint: enrollEndpoint,
              enrollment_code: enrollmentCode,
              expires_at: expiresAt,
              kind: "enroll_local_collector",
              local_binding_name: localBindingId,
              reason:
                "Run the owner's local collector for this connector and exchange the enrollment_code at enroll_endpoint. The connection materializes when the device enrolls and ingests; any provider login happens locally.",
            },
            object: "owner_connection_intent",
            proof_gate: plan.proofGate,
            runbook_path: plan.runbookPath,
            setup_modality: plan.setupModality,
            support_state: plan.supportState,
            validation: plan.validationMode,
          });
          return;
        }

        // Proof-gated, deployment-blocked, and unsupported connectors still
        // return the same setup-plan projection. They do not mint codes, return
        // secrets, or create connection rows.
        // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
        const reason = plan.ownerAgentIntent.reason;
        // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
        const nextStepKind = plan.ownerAgentIntent.nextStepKind;
        await emitConnectionIntentAudit(ctx, req, res, {
          connectorKey,
          connectorModality: modality,
          displayNameSupplied,
          nextStepKind,
          outcome: "succeeded",
          ownerSubjectId,
        });
        const nextStep: Record<string, unknown> = {
          kind: nextStepKind,
          reason,
        };
        if (nextStepKind === "capture_static_secret") {
          nextStep.capture_endpoint = `/connect/static-secret/${encodeURIComponent(connectorKey)}`;
        }
        if (nextStepKind === "provide_import_file") {
          nextStep.upload_endpoint = `/connect/manual-upload/${encodeURIComponent(connectorKey)}`;
        }
        if (plan.runbookPath) {
          nextStep.runbook_path = plan.runbookPath;
        }
        res.status(201).json({
          connection_active: false,
          connector_id: connectorKey,
          connector_key: connectorKey,
          connector_modality: modality,
          deployment_readiness: plan.deploymentReadiness,
          next_step: nextStep,
          object: "owner_connection_intent",
          proof_gate: plan.proofGate,
          runbook_path: plan.runbookPath,
          setup_modality: plan.setupModality,
          support_state: plan.supportState,
          validation: plan.validationMode,
        });
      } catch (err) {
        await emitConnectionIntentAudit(ctx, req, res, {
          error: err,
          outcome: "failed",
          ownerSubjectId: ctx.getOwnerTokenSubjectId(req),
        });
        ctx.handleError(res, err);
      }
    }
  );
}
