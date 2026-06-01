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
// route classifies the connector by its manifest `runtime_requirements.bindings`
// and only returns a real owner-mediated next step (`enroll_local_collector`)
// for connectors the reference is proven to enroll and run locally. Browser-bound
// connectors (Amazon, chase, chatgpt) and API/network-only connectors (github,
// gmail) return a typed `unsupported` whose reason names the exact missing
// primitive — never a faked success that would assert an unproven flow.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control SHALL initiate connections as typed
//         owner-mediated intents")

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/owner-connections.ts`.

interface RouteRequest {
  readonly body?: unknown;
  get(name: string): string | undefined;
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
  json(body: unknown): unknown;
  setHeader(name: string, value: string): void;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
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

export type ConnectorIntentModality = "local_collector" | "browser_bound" | "api_network" | "unknown";

// Pure classifier: maps a connector manifest's `runtime_requirements.bindings`
// to the intent modality. The placement signal is the binding set, mirroring how
// the device-exporter path treats `filesystem` as the local-collector marker:
//
//   - a `filesystem` binding  → `local_collector` (claude-code, codex). The
//     reference is proven to enroll and run these via the device-exporter path.
//   - a `browser` binding      → `browser_bound` (amazon, chase, chatgpt). The
//     `browser_collector` enrollment primitive ships (the enrollment route
//     enrolls these as `browser_collector` instances), but committed proof of a
//     real logged-in browser session ingesting end-to-end is still pending, so
//     the intent route does not yet advertise a one-click next step (the flip
//     lands with the proof; see `unsupportedReason`).
//   - `network` only            → `api_network` (github, gmail). The reference
//     has no standalone owner-agent API-connect route.
//   - a `null` manifest         → `unknown` (connector not registered/known).
//
// `filesystem` wins over `browser` if a manifest somehow declares both, because
// a local collector is the proven path; this is defensive and no current
// manifest declares both.
export function classifyConnectorIntentModality(manifest: ConnectorManifestLike | null): ConnectorIntentModality {
  if (!manifest) {
    return "unknown";
  }
  const bindings = manifest.runtime_requirements?.bindings;
  if (!bindings || typeof bindings !== "object") {
    return "unknown";
  }
  if (Object.hasOwn(bindings, "filesystem")) {
    return "local_collector";
  }
  if (Object.hasOwn(bindings, "browser")) {
    return "browser_bound";
  }
  if (Object.hasOwn(bindings, "network")) {
    return "api_network";
  }
  return "unknown";
}

interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

interface DeviceExporterEnrollmentStore {
  createEnrollmentCode(input: {
    enrollmentCodeId: string;
    codeHash: string;
    ownerSubjectId: string;
    connectorId: string;
    localBindingId: string;
    displayName: string | null;
    createdAt: string;
    expiresAt: string;
  }): Promise<unknown> | unknown;
}

export interface MountOwnerConnectionIntentContext {
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  deviceExporterStore: DeviceExporterEnrollmentStore;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  generateReferenceSecret(prefix: string, bytes?: number): string;
  generateSpineId(prefix: string): string;
  // Resolves a connector manifest for a registered connector. Returns `null`
  // for an unknown connector. Async to match the host's `getConnectorManifest`.
  getConnectorManifest(connectorId: string): Promise<ConnectorManifestLike | null> | ConnectorManifestLike | null;
  getOwnerTokenSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  hashDeviceSecret(value: string): string;
  now?(): string;
  pdppError: PdppErrorFn;
  // Resolves a local-collector catalog manifest (claude-code, codex) by key, or
  // `null` for connectors not in the local-collector catalog. Mirrors the host's
  // `readReferenceLocalConnectorCatalogManifest`.
  readReferenceLocalConnectorCatalogManifest(connectorId: string): ConnectorManifestLike | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Resolves the caller-visible trusted AS issuer base (forwarded-origin-safe).
  // The device-exporter enroll route lives on the AS app, so the enroll endpoint
  // the local collector should call is built from the AS base, not the RS base
  // this route is served from.
  resolveEnrollBaseUrl(req: unknown): string;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildAuditTrace(ctx: MountOwnerConnectionIntentContext, req: RouteRequest, res: RouteResponse): TraceContext {
  const scenarioId = typeof req.tokenInfo?.scenario_id === "string" ? req.tokenInfo.scenario_id : undefined;
  const trace = scenarioId ? ctx.createTraceContext({ scenarioId }) : ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return {
    request_id: requestId,
    scenario_id: trace.scenario_id,
    trace_id: trace.trace_id,
  };
}

function auditActorKind(req: RouteRequest): "owner_agent" | "client" | "mcp_package" | "unknown" {
  const kind = req.tokenInfo?.pdpp_token_kind;
  if (kind === "owner") {
    return "owner_agent";
  }
  if (kind === "client" || kind === "mcp_package") {
    return kind;
  }
  return "unknown";
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
    event_type: "owner_agent.connection.initiate",
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    request_id: trace.request_id,
    actor_type: actorKind,
    actor_id: clientId ?? ownerSubjectId ?? actorKind,
    subject_type: "subject",
    subject_id: ownerSubjectId,
    client_id: clientId,
    object_type: "connection_intent",
    object_id: args.connectorKey || "unknown_connector",
    status: args.outcome,
    data: {
      auth_token_kind: req.tokenInfo?.pdpp_token_kind ?? null,
      actor_kind: actorKind,
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
        const rawConnectorId = body.connector_id;
        if (typeof rawConnectorId !== "string" || !rawConnectorId.trim()) {
          const err = new Error("connector_id must be a non-empty string") as Error & { code: string; param: string };
          err.code = "invalid_request";
          err.param = "connector_id";
          await emitConnectionIntentAudit(ctx, req, res, {
            error: err,
            outcome: "failed",
            ownerSubjectId: ctx.getOwnerTokenSubjectId(req),
          });
          ctx.pdppError(res, 400, "invalid_request", "connector_id must be a non-empty string", "connector_id");
          return;
        }
        const connectorId = rawConnectorId.trim();
        const displayNameRaw = body.display_name;
        const displayNameSupplied = Object.hasOwn(body, "display_name");
        if (
          displayNameSupplied &&
          (typeof displayNameRaw !== "string" || !displayNameRaw.trim() || displayNameRaw.trim().length > 200)
        ) {
          const err = new Error(
            "display_name must be a non-empty string up to 200 characters when provided"
          ) as Error & {
            code: string;
            param: string;
          };
          err.code = "invalid_request";
          err.param = "display_name";
          await emitConnectionIntentAudit(ctx, req, res, {
            displayNameSupplied: true,
            error: err,
            outcome: "failed",
            ownerSubjectId: ctx.getOwnerTokenSubjectId(req),
          });
          ctx.pdppError(
            res,
            400,
            "invalid_request",
            "display_name must be a non-empty string up to 200 characters when provided",
            "display_name"
          );
          return;
        }
        const displayName = typeof displayNameRaw === "string" ? displayNameRaw.trim() : null;
        const connectorKey = ctx.canonicalConnectorKey(connectorId) ?? connectorId;

        // Resolve the manifest from the local-collector catalog first (so a
        // claude-code/codex intent classifies even before any instance exists),
        // then fall back to a registered connector manifest. A null manifest is
        // an unknown connector.
        const localManifest = ctx.readReferenceLocalConnectorCatalogManifest(connectorKey);
        const manifest = localManifest ?? (await ctx.getConnectorManifest(connectorKey));
        const modality = classifyConnectorIntentModality(manifest);
        const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);

        if (modality === "local_collector") {
          // Mint a real single-use enrollment code via the SAME store operation
          // the cookie-authed `/_ref/device-exporters/enrollment-codes` route
          // uses (separate bearer auth adapter — no handler cloning). The owner's
          // local collector exchanges this code to materialize the connection and
          // performs any provider/browser step locally. No connection row is
          // written here; the instance materializes on enroll + ingest.
          const enrollmentCode = ctx.generateReferenceSecret("lde", 18);
          const now = ctx.now ? ctx.now() : new Date().toISOString();
          const expiresInSeconds = 15 * 60;
          const expiresAt = new Date(Date.parse(now) + expiresInSeconds * 1000).toISOString();
          // The local binding id defaults to the connector key; the owner's
          // collector reuses it as the local binding name on enroll.
          const localBindingId = connectorKey;
          await ctx.deviceExporterStore.createEnrollmentCode({
            enrollmentCodeId: ctx.generateSpineId("denroll"),
            codeHash: ctx.hashDeviceSecret(enrollmentCode),
            ownerSubjectId,
            connectorId: connectorKey,
            localBindingId,
            displayName,
            createdAt: now,
            expiresAt,
          });
          const enrollEndpoint = `${stripTrailingSlash(ctx.resolveEnrollBaseUrl(req))}/_ref/device-exporters/enroll`;
          await emitConnectionIntentAudit(ctx, req, res, {
            connectorKey,
            connectorModality: modality,
            displayNameSupplied,
            nextStepKind: "enroll_local_collector",
            outcome: "succeeded",
            ownerSubjectId,
          });
          res.status(201).json({
            object: "owner_connection_intent",
            connector_id: connectorKey,
            connector_key: connectorKey,
            connector_modality: modality,
            connection_active: false,
            next_step: {
              kind: "enroll_local_collector",
              reason:
                "Run the owner's local collector for this connector and exchange the enrollment_code at enroll_endpoint. The connection materializes when the device enrolls and ingests; any provider login happens locally.",
              enrollment_code: enrollmentCode,
              enroll_endpoint: enrollEndpoint,
              local_binding_name: localBindingId,
              expires_at: expiresAt,
            },
          });
          return;
        }

        // Browser-bound, API/network-only, and unknown connectors are typed
        // `unsupported` with a reason that names the exact missing primitive.
        const reason = unsupportedReason(modality);
        await emitConnectionIntentAudit(ctx, req, res, {
          connectorKey,
          connectorModality: modality,
          displayNameSupplied,
          nextStepKind: "unsupported",
          outcome: "succeeded",
          ownerSubjectId,
        });
        res.status(201).json({
          object: "owner_connection_intent",
          connector_id: connectorKey,
          connector_key: connectorKey,
          connector_modality: modality,
          connection_active: false,
          next_step: {
            kind: "unsupported",
            reason,
          },
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

// Names the exact missing internal primitive for each non-local-collector
// modality so a trusted agent can explain the gap and the owner can act. These
// are honest classifications, not stubs: the reference genuinely has no proven
// browser-collector enrollment or standalone API-connect route.
export function unsupportedReason(modality: ConnectorIntentModality): string {
  if (modality === "browser_bound") {
    return "This connector is browser-bound. The browser-collector enrollment primitive (`browser_collector` source kind plus binding-aware enrollment) already ships: the owner-authed enrollment-code route accepts this connector and enrolls a second account as a distinct `browser_collector` instance. What is not yet committed is end-to-end proof that a real owner-logged-in browser session ingests through that path, so this route stays `unsupported` and does not advertise a one-click next step. To add the connection today, follow the owner-run procedure in `docs/operator/browser-collector-proof-runbook.md` (mint an enrollment code for this connector, then run the monorepo local collector against your logged-in session). The one-click owner-agent next step lands together with the committed live proof.";
  }
  if (modality === "api_network") {
    return "This connector is API/network-only and authenticates with a static provider secret the owner supplies locally (gmail uses a Google app password over IMAP; github uses a personal access token) — there is no OAuth authorization URL to send the owner to. The reference now has the per-connection encrypted credential store, an owner-session credential capture route for existing connections, and connection-scoped subprocess injection for this credential model (add-static-secret-owner-connect-primitive), so a captured secret is sealed at rest, never agent-readable, and injected into exactly one connection run. What is still missing is the committed end-to-end proof — intent to owner capture to first ingest to an addressable connection_id, with two mailboxes proven as two connection_ids. Until that proof lands the route stays `unsupported` and does not advertise a one-click next step (`open_url` would apply only to a genuinely OAuth-backed connector, which none of the current ones are); an API connection still materializes only on first ingest, not from this intent. See openspec/changes/add-static-secret-owner-connect-primitive/design.md (Decision 6, proof-before-flip).";
  }
  return "Unknown connector: no manifest with runtime binding requirements is registered for this connector_id. Register the connector or check the connector_id.";
}
