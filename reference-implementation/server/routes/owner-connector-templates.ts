// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the bearer-authed owner-agent connector-template listing
// route `GET /v1/owner/connector-templates`.
//
// This route is intentionally template-level. It tells a trusted owner agent
// what registered connector implementations exist and which configured
// connection instances currently belong to each template. Stateful work still
// targets `connection_id` through `/v1/owner/connections`; adding a new
// connection is exposed as a typed owner-agent intent only when the
// server-owned planner and proof/listing contract mark that REST action
// supported. Interactive browser setup remains owner-mediated in Console.

import {
  buildConnectionSetupPlan,
  isSupportedBrowserCollectorConnector,
  staticSecretCredentialCaptureFromManifest,
} from "../connection-setup-plan.ts";
import type { OwnerAgentControlAction } from "../metadata.ts";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";

interface RouteRequest {
  readonly tokenInfo?: {
    readonly subject_id?: string | null;
  } | null;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

interface ConnectorManifestLike {
  readonly capabilities?: {
    readonly auth?: {
      readonly deployment_config?: readonly string[] | null;
      readonly kind?: string | null;
      readonly mode?: string | null;
      readonly required?: readonly string[] | null;
      readonly type?: string | null;
    } | null;
    readonly public_listing?: {
      readonly tier?: "supported" | "preview" | "development" | null;
    } | null;
  } | null;
  readonly connector_id?: string | null;
  readonly connector_key?: string | null;
  readonly display_name?: string | null;
  readonly icon?: {
    readonly color?: string | null;
    readonly kind?: string | null;
    readonly svg?: string | null;
  } | null;
  readonly name?: string | null;
  readonly runtime_requirements?: {
    readonly bindings?: Readonly<Record<string, unknown>> | null;
  } | null;
  readonly streams?: readonly unknown[] | null;
  readonly version?: string | null;
}

interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt?: string | null;
  readonly displayName?: string | null;
  readonly revokedAt?: string | null;
  readonly sourceKind?: string | null;
  readonly status?: string | null;
  readonly updatedAt?: string | null;
}

interface ConnectorInstanceStore {
  listByOwner: (ownerSubjectId: string) => Promise<ConnectorInstanceRow[]> | ConnectorInstanceRow[];
}

export interface MountOwnerConnectorTemplatesContext {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  configuredProviderAuthConnectorKeys?: readonly string[];
  createRequestConnectorInstanceStore: () => ConnectorInstanceStore;
  getConnectorManifest: (connectorId: string) => Promise<ConnectorManifestLike | null> | ConnectorManifestLike | null;
  getOwnerTokenSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  listRegisteredConnectorIds: () => Promise<readonly string[]> | readonly string[];
  projectStorageDisplayName: (
    displayName: string | null | undefined,
    options: { connectorId?: string | null; connectorInstanceId?: string | null }
  ) => string | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  resolveResource: (req: unknown) => string;
  uatExposeUnlistedConnectors?: boolean;
  uatConnectorAllowlist?: ReadonlySet<string>;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function parseUatConnectorAllowlist(input: string | undefined): ReadonlySet<string> {
  if (!input || typeof input !== "string") {
    return new Set();
  }
  return new Set(
    input
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0 && /^[a-z0-9_-]+$/.test(k))
  );
}

function connectorKeyFromManifest(
  ctx: MountOwnerConnectorTemplatesContext,
  manifest: ConnectorManifestLike
): string | null {
  return (
    ctx.canonicalConnectorKey(manifest.connector_key) ??
    ctx.canonicalConnectorKey(manifest.connector_id) ??
    manifest.connector_key?.trim() ??
    manifest.connector_id?.trim() ??
    null
  );
}

function displayNameForTemplate(connectorKey: string, manifest: ConnectorManifestLike): string {
  return manifest.display_name?.trim() || manifest.name?.trim() || connectorKey;
}

function projectConnectionSummary(
  ctx: MountOwnerConnectorTemplatesContext,
  instance: ConnectorInstanceRow
): Record<string, unknown> {
  const connectorKey = ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId;
  const ownerMeaningfulName = ctx.projectStorageDisplayName(instance.displayName, {
    connectorId: connectorKey,
    connectorInstanceId: instance.connectorInstanceId,
  });
  return {
    connection_id: instance.connectorInstanceId,
    connector_id: connectorKey,
    connector_instance_id: instance.connectorInstanceId,
    connector_key: connectorKey,
    created_at: instance.createdAt ?? null,
    display_name: instance.displayName ?? null,
    label_status: ownerMeaningfulName ? "owner_set" : "fallback",
    object: "owner_connection_summary",
    revoked_at: instance.revokedAt ?? null,
    source_kind: instance.sourceKind ?? null,
    status: instance.status ?? null,
    updated_at: instance.updatedAt ?? null,
  };
}

// These are the dispositions with a supported owner-agent REST intent. Browser
// setup is intentionally handled by the separate owner-session projection
// below, because the REST intent route cannot launch interactive login.
const ACTIONABLE_CATALOG_DISPOSITIONS = new Set([
  "local_collector_enroll",
  "manual_upload_connect",
  "provider_auth_connect",
  "static_secret_connect",
]);

const OWNER_SESSION_BROWSER_ACTION_REASON =
  "Connect this account from the owner's secure browser-session dashboard. Owner-agent REST does not launch interactive browser setup.";

function isActionablePublicListing(manifest: ConnectorManifestLike): boolean {
  // `needs_human_auth` is an explicitly actionable listing state for sources
  // whose owner-mediated setup still requires an interactive provider step.
  const listing = manifest.capabilities?.public_listing;
  return listing?.tier !== undefined && listing.tier !== "development";
}

export function isSupportedOwnerActionPlan(plan: ReturnType<typeof buildConnectionSetupPlan>): boolean {
  return (
    ACTIONABLE_CATALOG_DISPOSITIONS.has(plan.catalogDisposition) &&
    plan.ownerAgentIntent.status === "supported" &&
    plan.ownerAgentIntent.method !== null &&
    plan.ownerAgentIntent.nextStepKind === plan.nextStepKind &&
    plan.supportState === "supported" &&
    plan.proofGate === null
  );
}

/**
 * Browser setup has a shipped owner-session route, but it is not an
 * owner-agent REST primitive: the owner must complete interactive login in
 * the secure browser. The planner's production-ready browser roster is the
 * proof for browser-backed static-secret entries; the manual disposition is
 * already the planner's proof-backed browser classification.
 */
export function isOwnerSessionBrowserActionPlan(plan: ReturnType<typeof buildConnectionSetupPlan>): boolean {
  if (plan.connectorModality !== "browser_bound") {
    return false;
  }
  if (plan.catalogDisposition === "browser_collector_manual") {
    return plan.nextStepKind === "enroll_browser_collector" && typeof plan.enrollmentKey === "string";
  }
  return (
    plan.catalogDisposition === "static_secret_connect" &&
    plan.setupModality === "static_secret" &&
    isSupportedBrowserCollectorConnector(plan.connectorKey)
  );
}

function isOwnerActionablePlan(plan: ReturnType<typeof buildConnectionSetupPlan>): boolean {
  return isSupportedOwnerActionPlan(plan) || isOwnerSessionBrowserActionPlan(plan);
}

function isUatExposablePlan(
  plan: ReturnType<typeof buildConnectionSetupPlan>,
  manifest: ConnectorManifestLike,
  connectorKey?: string | null,
  allowlist?: ReadonlySet<string>
): boolean {
  const basePlan = [
    isOwnerActionablePlan(plan),
    plan.catalogDisposition === "static_secret_experimental",
    plan.catalogDisposition === "static_secret_connect" &&
      plan.setupModality === "static_secret" &&
      staticSecretCredentialCaptureFromManifest(manifest) !== null,
  ].includes(true);

  if (basePlan) {
    return true;
  }

  // Allowlist-based UAT exposure: development connectors explicitly listed
  // can be exposed when they have a valid setup path
  if (allowlist && connectorKey && allowlist.has(connectorKey)) {
    const listing = manifest.capabilities?.public_listing;
    const isDevelopment = listing?.tier === "development";
    if (isDevelopment) {
      const hasValidSetup =
        plan.catalogDisposition === "static_secret_connect" &&
        plan.setupModality === "static_secret" &&
        staticSecretCredentialCaptureFromManifest(manifest) !== null;
      return hasValidSetup;
    }
  }

  return false;
}

function buildTemplateSupportedActions(args: {
  manifest: ConnectorManifestLike;
  plan: ReturnType<typeof buildConnectionSetupPlan>;
  resource: string;
  uatExposeUnlistedConnectors?: boolean;
}): OwnerAgentControlAction[] {
  const rs = stripTrailingSlash(args.resource);
  const isActionable =
    isActionablePublicListing(args.manifest) ||
    (args.uatExposeUnlistedConnectors === true && isSupportedOwnerActionPlan(args.plan));
  if (isActionable && isSupportedOwnerActionPlan(args.plan)) {
    return [
      {
        family: "initiate_connection",
        method: args.plan.ownerAgentIntent.method,
        reason: `${args.plan.ownerAgentIntent.reason} Body: { connector_id, display_name? }.`,
        status: "supported",
        url: `${rs}/v1/owner/connections/intents`,
      },
    ];
  }
  if (isActionable && isOwnerSessionBrowserActionPlan(args.plan)) {
    return [
      {
        family: "initiate_connection",
        method: null,
        reason: OWNER_SESSION_BROWSER_ACTION_REASON,
        status: "owner_mediated",
        url: null,
      },
    ];
  }
  return [
    {
      family: "initiate_connection",
      method: null,
      reason: args.plan.ownerAgentIntent.reason,
      status: "unsupported",
      url: null,
    },
  ];
}

function projectSetupPlan(
  manifest: ConnectorManifestLike,
  plan: ReturnType<typeof buildConnectionSetupPlan>
): Record<string, unknown> {
  // Owner-facing actionability: manifest is listed AND plan is actionable (lifecycle authority unchanged).
  // UAT exposure via uat_expose_unlisted_connectors does not modify setup_plan; it is a separate flag
  // for the console to enable testing without claiming Supported or Preview tier.
  const isActionableManifest = isActionablePublicListing(manifest);
  const isActionablePlan = isOwnerActionablePlan(plan);
  const ownerActionable = isActionableManifest && isActionablePlan;
  return {
    catalog_disposition: plan.catalogDisposition,
    deployment_readiness: plan.deploymentReadiness,
    enrollment_key: plan.enrollmentKey ?? null,
    next_step_kind: plan.nextStepKind,
    // This is owner-facing actionability, not owner-agent REST support. A
    // browser action is represented in supported_actions as owner_mediated
    // with no method or URL because interactive setup stays in Console.
    owner_actionable: ownerActionable,
    proof_gate: plan.proofGate,
    runbook_path: plan.runbookPath,
    setup_modality: plan.setupModality,
    support_state: plan.supportState,
    validation: plan.validationMode,
  };
}

function projectTemplate(
  ctx: MountOwnerConnectorTemplatesContext,
  manifest: ConnectorManifestLike,
  connectionsByConnector: ReadonlyMap<string, readonly ConnectorInstanceRow[]>,
  resource: string
): Record<string, unknown> | null {
  const connectorKey = connectorKeyFromManifest(ctx, manifest);
  if (!connectorKey) {
    return null;
  }
  const plan = buildConnectionSetupPlan({
    configuredProviderAuthConnectorKeys: ctx.configuredProviderAuthConnectorKeys ?? [],
    connectorKey,
    manifest,
  });
  const modality = plan.connectorModality;
  const connections = (connectionsByConnector.get(connectorKey) ?? []).map((instance) =>
    projectConnectionSummary(ctx, instance)
  );
  // Explicit UAT exposure fact: true only when deployment opts in, AND
  // (connector is preview tier unproven OR development tier on allowlist),
  // AND the plan is UAT-exposable (has a valid setup path).
  const listing = manifest.capabilities?.public_listing;
  const isUnproven = listing?.tier === "preview";
  const isDevelopment = listing?.tier === "development";
  const isAllowlisted = ctx.uatConnectorAllowlist?.has(connectorKey) === true;

  const uatExposeUnlistedConnectors =
    ctx.uatExposeUnlistedConnectors === true &&
    ((isUnproven && isUatExposablePlan(plan, manifest, connectorKey, ctx.uatConnectorAllowlist)) ||
      (isDevelopment && isAllowlisted && isUatExposablePlan(plan, manifest, connectorKey, ctx.uatConnectorAllowlist)));

  return {
    connection_count: connections.length,
    connections,
    connector_id: connectorKey,
    connector_key: connectorKey,
    connector_modality: modality,
    display_name: displayNameForTemplate(connectorKey, manifest),
    icon: manifest.icon ?? null,
    object: "owner_connector_template",
    public_listing: manifest.capabilities?.public_listing ?? null,
    registration_status: "registered",
    setup_plan: projectSetupPlan(manifest, plan),
    stream_count: Array.isArray(manifest.streams) ? manifest.streams.length : 0,
    supported_actions: buildTemplateSupportedActions({ manifest, plan, resource, uatExposeUnlistedConnectors }),
    uat_expose_unlisted_connectors: uatExposeUnlistedConnectors,
    version: manifest.version ?? null,
  };
}

async function collectConnectorTemplates(ctx: MountOwnerConnectorTemplatesContext): Promise<ConnectorManifestLike[]> {
  const byConnectorKey = new Map<string, ConnectorManifestLike>();
  for (const connectorId of await ctx.listRegisteredConnectorIds()) {
    const connectorKey = ctx.canonicalConnectorKey(connectorId) ?? connectorId;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const manifest = await ctx.getConnectorManifest(connectorKey);
      if (manifest) {
        byConnectorKey.set(connectorKey, manifest);
      }
    } catch {
      // A malformed registered manifest should not hide every other template
      // from an owner agent. Runtime reads will surface that connector-specific
      // defect when addressed directly.
    }
  }
  return Array.from(byConnectorKey.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, manifest]) => manifest);
}

async function connectionsByConnectorKey(
  ctx: MountOwnerConnectorTemplatesContext,
  ownerSubjectId: string
): Promise<Map<string, ConnectorInstanceRow[]>> {
  const grouped = new Map<string, ConnectorInstanceRow[]>();
  const store = ctx.createRequestConnectorInstanceStore();
  for (const instance of await store.listByOwner(ownerSubjectId)) {
    const connectorKey = ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId;
    const existing = grouped.get(connectorKey);
    if (existing) {
      existing.push(instance);
    } else {
      grouped.set(connectorKey, [instance]);
    }
  }
  for (const rows of grouped.values()) {
    rows.sort((left, right) => left.connectorInstanceId.localeCompare(right.connectorInstanceId));
  }
  return grouped;
}

export function mountOwnerConnectorTemplates(app: AppLike, ctx: MountOwnerConnectorTemplatesContext): void {
  app.get(
    "/v1/owner/connector-templates",
    { contract: "ownerListConnectorTemplates" },
    ctx.requireToken,
    ctx.requireOwner,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const resource = ctx.resolveResource(req);
        const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
        const [templates, connections] = await Promise.all([
          collectConnectorTemplates(ctx),
          connectionsByConnectorKey(ctx, ownerSubjectId),
        ]);
        res.json({
          data: templates
            .map((manifest) => {
              // A malformed registered manifest should not blank every other
              // template from an owner agent — same isolation as the read loop
              // in collectConnectorTemplates above.
              try {
                return projectTemplate(ctx, manifest, connections, resource);
              } catch {
                return null;
              }
            })
            .filter((item): item is Record<string, unknown> => Boolean(item)),
          object: "list",
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}
