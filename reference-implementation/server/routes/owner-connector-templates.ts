// HTTP adapter for the bearer-authed owner-agent connector-template listing
// route `GET /v1/owner/connector-templates`.
//
// This route is intentionally template-level. It tells a trusted owner agent
// what connector implementations exist and which configured connection
// instances currently belong to each template. Stateful work still targets
// `connection_id` through `/v1/owner/connections`; adding a new connection is
// exposed only as a typed intent and is marked unsupported when this reference
// build lacks a proven provider primitive.

import type { OwnerAgentControlAction } from "../metadata.ts";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";
import {
  type ConnectorIntentModality,
  classifyConnectorIntentModality,
  unsupportedReason,
} from "./owner-connection-intent.ts";

interface RouteRequest {
  readonly tokenInfo?: {
    readonly subject_id?: string | null;
  } | null;
}

interface RouteResponse {
  json(body: unknown): unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

interface ConnectorManifestLike {
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
  listByOwner(ownerSubjectId: string): Promise<ConnectorInstanceRow[]> | ConnectorInstanceRow[];
}

export interface MountOwnerConnectorTemplatesContext {
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  getConnectorManifest(connectorId: string): Promise<ConnectorManifestLike | null> | ConnectorManifestLike | null;
  getOwnerTokenSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  listReferenceLocalConnectorCatalogManifests(): readonly ConnectorManifestLike[];
  listRegisteredConnectorIds(): Promise<readonly string[]> | readonly string[];
  projectStorageDisplayName(
    displayName: string | null | undefined,
    options: { connectorId?: string | null; connectorInstanceId?: string | null }
  ): string | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  resolveResource(req: unknown): string;
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
    object: "owner_connection_summary",
    connection_id: instance.connectorInstanceId,
    connector_instance_id: instance.connectorInstanceId,
    connector_id: connectorKey,
    connector_key: connectorKey,
    display_name: instance.displayName ?? null,
    label_status: ownerMeaningfulName ? "owner_set" : "fallback",
    status: instance.status ?? null,
    source_kind: instance.sourceKind ?? null,
    created_at: instance.createdAt ?? null,
    updated_at: instance.updatedAt ?? null,
    revoked_at: instance.revokedAt ?? null,
  };
}

function buildTemplateSupportedActions(args: {
  connectorKey: string;
  modality: ConnectorIntentModality;
  resource: string;
}): OwnerAgentControlAction[] {
  const rs = stripTrailingSlash(args.resource);
  if (args.modality === "local_collector") {
    return [
      {
        family: "initiate_connection",
        status: "supported",
        method: "POST",
        url: `${rs}/v1/owner/connections/intents`,
        reason:
          "Create an owner-mediated local-collector enrollment intent. Body: { connector_id, display_name? }. The connection materializes only after the owner's local collector exchanges the enrollment code and ingests.",
      },
    ];
  }
  return [
    {
      family: "initiate_connection",
      status: "unsupported",
      method: null,
      url: null,
      reason: unsupportedReason(args.modality),
    },
  ];
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
  const modality = classifyConnectorIntentModality(manifest);
  const connections = (connectionsByConnector.get(connectorKey) ?? []).map((instance) =>
    projectConnectionSummary(ctx, instance)
  );
  return {
    object: "owner_connector_template",
    connector_id: connectorKey,
    connector_key: connectorKey,
    display_name: displayNameForTemplate(connectorKey, manifest),
    version: manifest.version ?? null,
    connector_modality: modality,
    stream_count: Array.isArray(manifest.streams) ? manifest.streams.length : 0,
    connection_count: connections.length,
    connections,
    supported_actions: buildTemplateSupportedActions({ connectorKey, modality, resource }),
  };
}

async function collectConnectorTemplates(ctx: MountOwnerConnectorTemplatesContext): Promise<ConnectorManifestLike[]> {
  const byConnectorKey = new Map<string, ConnectorManifestLike>();
  for (const manifest of ctx.listReferenceLocalConnectorCatalogManifests()) {
    const key = connectorKeyFromManifest(ctx, manifest);
    if (key) {
      byConnectorKey.set(key, manifest);
    }
  }
  for (const connectorId of await ctx.listRegisteredConnectorIds()) {
    const connectorKey = ctx.canonicalConnectorKey(connectorId) ?? connectorId;
    try {
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
          object: "list",
          data: templates
            .map((manifest) => projectTemplate(ctx, manifest, connections, resource))
            .filter((item): item is Record<string, unknown> => Boolean(item)),
        });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}
