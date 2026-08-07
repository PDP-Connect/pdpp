// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the bearer-authed owner-agent connector-template listing
// route `GET /v1/owner/connector-templates`.
//
// This route is intentionally template-level. It tells a trusted owner agent
// what registered connector implementations exist and which configured
// connection instances currently belong to each template. Stateful work still
// targets `connection_id` through `/v1/owner/connections`; adding a new
// connection is exposed only as a typed intent when the server-owned planner
// and proof/listing contract mark that action supported.

import { buildConnectionSetupPlan } from "../connection-setup-plan.ts";
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
      readonly listed?: boolean | null;
      readonly status?: string | null;
    } | null;
  } | null;
  readonly connector_id?: string | null;
  readonly connector_key?: string | null;
  readonly display_name?: string | null;
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
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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

const ACTIONABLE_PUBLIC_LISTING_STATUSES = new Set(["proven", "needs_human_auth"]);
const ACTIONABLE_CATALOG_DISPOSITIONS = new Set([
  "local_collector_enroll",
  "manual_upload_connect",
  "provider_auth_connect",
  "static_secret_connect",
]);

function isActionablePublicListing(manifest: ConnectorManifestLike): boolean {
  // `needs_human_auth` is an explicitly actionable listing state for sources
  // whose owner-mediated setup still requires an interactive provider step.
  const listing = manifest.capabilities?.public_listing;
  return (
    listing?.listed === true &&
    typeof listing.status === "string" &&
    ACTIONABLE_PUBLIC_LISTING_STATUSES.has(listing.status)
  );
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

function buildTemplateSupportedActions(args: {
  manifest: ConnectorManifestLike;
  plan: ReturnType<typeof buildConnectionSetupPlan>;
  resource: string;
}): OwnerAgentControlAction[] {
  const rs = stripTrailingSlash(args.resource);
  if (isActionablePublicListing(args.manifest) && isSupportedOwnerActionPlan(args.plan)) {
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
  return {
    catalog_disposition: plan.catalogDisposition,
    deployment_readiness: plan.deploymentReadiness,
    enrollment_key: plan.enrollmentKey ?? null,
    next_step_kind: plan.nextStepKind,
    owner_actionable: isActionablePublicListing(manifest) && isSupportedOwnerActionPlan(plan),
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
  return {
    connection_count: connections.length,
    connections,
    connector_id: connectorKey,
    connector_key: connectorKey,
    connector_modality: modality,
    display_name: displayNameForTemplate(connectorKey, manifest),
    object: "owner_connector_template",
    public_listing: manifest.capabilities?.public_listing ?? null,
    registration_status: "registered",
    setup_plan: projectSetupPlan(manifest, plan),
    stream_count: Array.isArray(manifest.streams) ? manifest.streams.length : 0,
    supported_actions: buildTemplateSupportedActions({ manifest, plan, resource }),
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
            .map((manifest) => projectTemplate(ctx, manifest, connections, resource))
            .filter((item): item is Record<string, unknown> => Boolean(item)),
          object: "list",
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}
