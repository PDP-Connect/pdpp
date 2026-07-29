// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector schema and freshness projection.
 *
 * Scope: owns connector schema item construction, stream metadata entries, and
 * visible-stream freshness projection. It does not own route mounting,
 * grant resolution, record querying, or connector-run evidence lookup internals.
 *
 * Invariant: no import from index.js; imports run evidence from
 * connector-run-evidence.js, yielding an acyclic B -> A edge.
 */

import { listGrantedConnectionsForStream } from "./connection-identity.ts";
import {
  getConnectorRunEvidenceSource,
  getLatestConnectorRunSummary,
  getManifestRefreshPolicy,
  getMaximumStalenessSeconds,
} from "./connector-run-evidence.ts";
import { deriveReferenceFreshness } from "./freshness.ts";
import { listAllStreams, listStreams } from "./records.ts";
import { buildExpandCapabilities, buildFieldCapabilities } from "./schema-capabilities.ts";

export interface ConnectorSchemaManifestStream extends Record<string, unknown> {
  fields?: Array<{ name: string; type: string; semantic_class?: string }>;
  name: string;
  primary_key?: unknown;
  query?: {
    aggregations?: Record<string, boolean | string[]>;
    expand?: Array<{ default_limit?: unknown; max_limit?: unknown; name: string }>;
    range_filters?: Record<string, string[]>;
    search?: { lexical_fields?: string[]; semantic_fields?: string[] };
  };
  relationships?: Array<{ cardinality: string; foreign_key?: string; name: string; stream: string }>;
  schema?: {
    fields?: Array<{ name: string; type: string; semantic_class?: string }>;
    properties?: Record<string, { type?: string | string[]; [key: string]: unknown }>;
  };
}

interface Manifest {
  capabilities?: unknown;
  streams: ConnectorSchemaManifestStream[];
}

export interface ConnectorSchemaGrantStream extends Record<string, unknown> {
  connection_id?: string;
  fields?: string[];
  grantStreams?: Array<{ name: string }>;
  name: string;
}

interface Grant {
  streams: ConnectorSchemaGrantStream[];
}

interface ConnectorSource {
  id?: string;
  kind?: string;
}

export interface ConnectorFreshnessEvidence {
  lastRun: { last_at?: unknown; status?: unknown } | null;
  lastSuccessfulRun: { last_at?: unknown } | null;
  maximumStalenessSeconds: number | null;
}

export interface BuildStreamMetadataEntryOptions {
  freshness?: unknown;
  grantedConnections?: unknown[] | null;
  grantStreams?: ConnectorSchemaGrantStream[];
  manifestStream: ConnectorSchemaManifestStream;
  manifestStreamNames?: Set<string> | null;
  streamGrant?: ConnectorSchemaGrantStream | null;
}

export interface StreamMetadataEntry extends Record<string, unknown> {
  expand_capabilities: Record<string, unknown>[];
  field_capabilities: Record<string, unknown>;
  freshness: unknown;
  granted_connections?: unknown[];
  name: string;
  object: "stream_metadata";
  primary_key: unknown[];
}

function normalizePrimaryKey(primaryKey: unknown): unknown[] {
  if (Array.isArray(primaryKey)) {
    return primaryKey;
  }
  if (typeof primaryKey === "string" && primaryKey.trim()) {
    return [primaryKey];
  }
  return [];
}

function buildFreshness(lastUpdated = null) {
  return deriveReferenceFreshness({ recordLastUpdatedAt: lastUpdated });
}

export async function getConnectorFreshnessEvidence({
  source,
  manifest,
}: {
  source: ConnectorSource | null | undefined;
  manifest: Manifest;
}): Promise<ConnectorFreshnessEvidence> {
  const connectorId = getConnectorRunEvidenceSource(source);
  const refreshPolicy = getManifestRefreshPolicy(manifest);
  const [lastRun, lastSuccessfulRun] = await Promise.all([
    getLatestConnectorRunSummary(connectorId),
    getLatestConnectorRunSummary(connectorId, "succeeded"),
  ]);
  return {
    lastRun,
    lastSuccessfulRun,
    maximumStalenessSeconds: getMaximumStalenessSeconds(refreshPolicy),
  };
}

export function buildConnectorAwareFreshness(
  evidence: ConnectorFreshnessEvidence | null | undefined,
  recordLastUpdatedAt: string | null = null
) {
  return deriveReferenceFreshness({
    lastAttemptedAt: typeof evidence?.lastRun?.last_at === "string" ? evidence.lastRun.last_at : null,
    lastAttemptStatus: typeof evidence?.lastRun?.status === "string" ? evidence.lastRun.status : null,
    lastSuccessfulRunAt:
      typeof evidence?.lastSuccessfulRun?.last_at === "string" ? evidence.lastSuccessfulRun.last_at : null,
    maximumStalenessSeconds: evidence?.maximumStalenessSeconds ?? null,
    recordLastUpdatedAt,
  });
}

export function buildStreamMetadataEntry({
  manifestStream,
  streamGrant = null,
  grantStreams = [],
  freshness = null,
  grantedConnections = null,
  manifestStreamNames = null,
}: BuildStreamMetadataEntryOptions): StreamMetadataEntry {
  const expandStreamGrant = streamGrant ? { ...streamGrant, grantStreams } : null;
  const entry: StreamMetadataEntry = {
    consent_time_field: manifestStream.consent_time_field,
    cursor_field: manifestStream.cursor_field,
    expand_capabilities: buildExpandCapabilities(manifestStream, expandStreamGrant, manifestStreamNames),
    field_capabilities: buildFieldCapabilities(manifestStream, streamGrant),
    freshness: freshness ?? buildFreshness(null),
    name: manifestStream.name,
    object: "stream_metadata",
    primary_key: normalizePrimaryKey(manifestStream.primary_key),
    query: manifestStream.query || {},
    relationships: manifestStream.relationships || [],
    schema: manifestStream.schema,
    selection: manifestStream.selection,
    semantics: manifestStream.semantics,
    views: manifestStream.views || [],
  };
  if (Array.isArray(grantedConnections)) {
    entry.granted_connections = grantedConnections;
  }
  return entry;
}

export async function buildConnectorSchemaItem({
  source,
  storageBinding,
  manifest,
  grant = null,
  ownerSubjectId = null,
}: {
  grant?: Grant | null;
  manifest: Manifest;
  ownerSubjectId?: string | null;
  source: ConnectorSource | null | undefined;
  storageBinding: unknown;
}) {
  const connectorId = source?.kind === "connector" ? source.id : null;
  const streamSummaries: Array<{ last_updated?: string | null; name: string }> = grant
    ? await Reflect.apply(listStreams, undefined, [storageBinding, grant, manifest])
    : await Reflect.apply(listAllStreams, undefined, [storageBinding]);
  const summaryByName = new Map<string, { last_updated?: string | null; name: string }>(
    streamSummaries.map((summary) => [summary.name, summary])
  );
  const grantStreamByName = grant ? new Map(grant.streams.map((streamGrant) => [streamGrant.name, streamGrant])) : null;
  const visibleStreams: ConnectorSchemaManifestStream[] = grant
    ? grant.streams
        .map((streamGrant) => manifest.streams.find((stream) => stream.name === streamGrant.name))
        .filter((stream): stream is ConnectorSchemaManifestStream => stream !== undefined)
    : manifest.streams;
  const grantStreams = grant ? grant.streams : [];
  // Streams the loaded manifest declares — lets the expand-capabilities builder
  // distinguish "target stream not granted" from "target stream unknown".
  const manifestStreamNames = new Set(manifest.streams.map((stream) => stream.name));
  const freshnessEvidence = await getConnectorFreshnessEvidence({ manifest, source });

  // Look up granted connections once per connector. For polyfill connectors
  // we batch a single owner+connector store query and reuse the result for
  // every stream entry, narrowing per-stream by `grant.streams[].connection_id`
  // when the grant pins a single connection. For provider_native sources we
  // omit the field — those grants do not address a connection_id.
  let activeBindings: Array<{ connection_id: string }> | null = null;
  if (connectorId && ownerSubjectId) {
    activeBindings = await listGrantedConnectionsForStream({
      connectorId,
      grantStreamConnectionId: null,
      ownerSubjectId,
    });
  }

  const streams = visibleStreams.map((manifestStream) => {
    const lastUpdated = summaryByName.get(manifestStream.name)?.last_updated || null;
    const streamGrant = grantStreamByName ? grantStreamByName.get(manifestStream.name) || null : null;
    let grantedConnections: Array<{ connection_id: string }> | null = null;
    if (activeBindings) {
      const pin = streamGrant?.connection_id || null;
      grantedConnections = pin ? activeBindings.filter((entry) => entry.connection_id === pin) : activeBindings;
    }
    return buildStreamMetadataEntry({
      freshness: buildConnectorAwareFreshness(freshnessEvidence, lastUpdated),
      grantedConnections,
      grantStreams,
      manifestStream,
      manifestStreamNames,
      streamGrant,
    });
  });

  const item: {
    connector_id?: string;
    connector_key?: string;
    object: "connector";
    source: ConnectorSource | null | undefined;
    stream_count: number;
    streams: StreamMetadataEntry[];
  } = {
    object: "connector",
    source,
    stream_count: streams.length,
    streams,
  };
  if (connectorId) {
    item.connector_key = connectorId;
    item.connector_id = connectorId;
  }
  return item;
}

export async function getVisibleStreamFreshness({
  tokenInfo,
  source,
  storageBinding,
  stream,
  manifest,
}: {
  manifest: Manifest;
  source: ConnectorSource | null | undefined;
  storageBinding: unknown;
  stream: string;
  tokenInfo: { grant: Grant; pdpp_token_kind?: string } | null | undefined;
}) {
  const freshnessEvidence = await getConnectorFreshnessEvidence({ manifest, source });
  if (tokenInfo?.pdpp_token_kind === "owner") {
    const summaries: Array<{ last_updated?: string | null; name: string }> = await Reflect.apply(
      listAllStreams,
      undefined,
      [storageBinding]
    );
    const summary = summaries.find((entry) => entry.name === stream);
    return buildConnectorAwareFreshness(freshnessEvidence, summary?.last_updated || null);
  }

  if (!tokenInfo) {
    const err = Object.assign(new Error(`Stream '${stream}' not in grant`), { code: "grant_stream_not_allowed" });
    throw err;
  }
  const streamGrant = tokenInfo.grant.streams.find((entry) => entry.name === stream);
  if (!streamGrant) {
    const err = Object.assign(new Error(`Stream '${stream}' not in grant`), { code: "grant_stream_not_allowed" });
    throw err;
  }
  const summaries: Array<{ last_updated?: string | null; name: string }> = await Reflect.apply(listStreams, undefined, [
    storageBinding,
    { streams: [streamGrant] },
    manifest,
  ]);
  return buildConnectorAwareFreshness(freshnessEvidence, summaries[0]?.last_updated || null);
}
