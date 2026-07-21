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

import { deriveReferenceFreshness } from './freshness.ts';
import { listGrantedConnectionsForStream } from './connection-identity.js';
import { listAllStreams, listStreams } from './records.js';
import {
  buildExpandCapabilities,
  buildFieldCapabilities,
} from './schema-capabilities.js';
import {
  getConnectorRunEvidenceSource,
  getLatestConnectorRunSummary,
  getManifestRefreshPolicy,
  getMaximumStalenessSeconds,
} from './connector-run-evidence.ts';

function normalizePrimaryKey(primaryKey) {
  if (Array.isArray(primaryKey)) return primaryKey;
  if (typeof primaryKey === 'string' && primaryKey.trim()) return [primaryKey];
  return [];
}

function buildFreshness(lastUpdated = null) {
  return deriveReferenceFreshness({ recordLastUpdatedAt: lastUpdated });
}

export async function getConnectorFreshnessEvidence({ source, manifest }) {
  const connectorId = getConnectorRunEvidenceSource(source);
  const refreshPolicy = getManifestRefreshPolicy(manifest);
  const [lastRun, lastSuccessfulRun] = await Promise.all([
    getLatestConnectorRunSummary(connectorId),
    getLatestConnectorRunSummary(connectorId, 'succeeded'),
  ]);
  return {
    lastRun,
    lastSuccessfulRun,
    maximumStalenessSeconds: getMaximumStalenessSeconds(refreshPolicy),
  };
}

export function buildConnectorAwareFreshness(evidence, recordLastUpdatedAt = null) {
  return deriveReferenceFreshness({
    lastAttemptedAt: evidence?.lastRun?.last_at ?? null,
    lastAttemptStatus: evidence?.lastRun?.status ?? null,
    lastSuccessfulRunAt: evidence?.lastSuccessfulRun?.last_at ?? null,
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
}) {
  const expandStreamGrant = streamGrant
    ? { ...streamGrant, grantStreams }
    : null;
  const entry = {
    object: 'stream_metadata',
    name: manifestStream.name,
    semantics: manifestStream.semantics,
    schema: manifestStream.schema,
    primary_key: normalizePrimaryKey(manifestStream.primary_key),
    cursor_field: manifestStream.cursor_field,
    consent_time_field: manifestStream.consent_time_field,
    selection: manifestStream.selection,
    views: manifestStream.views || [],
    relationships: manifestStream.relationships || [],
    query: manifestStream.query || {},
    field_capabilities: buildFieldCapabilities(manifestStream, streamGrant),
    expand_capabilities: buildExpandCapabilities(manifestStream, expandStreamGrant, manifestStreamNames),
    freshness: freshness ?? buildFreshness(null),
  };
  if (Array.isArray(grantedConnections)) {
    entry.granted_connections = grantedConnections;
  }
  return entry;
}

export async function buildConnectorSchemaItem({ source, storageBinding, manifest, grant = null, ownerSubjectId = null }) {
  const connectorId = source?.kind === 'connector' ? source.id : null;
  const streamSummaries = grant
    ? await listStreams(storageBinding, grant, manifest)
    : await listAllStreams(storageBinding);
  const summaryByName = new Map(streamSummaries.map((summary) => [summary.name, summary]));
  const grantStreamByName = grant
    ? new Map((grant.streams || []).map((streamGrant) => [streamGrant.name, streamGrant]))
    : null;
  const visibleStreams = grant
    ? grant.streams
      .map((streamGrant) => manifest.streams.find((stream) => stream.name === streamGrant.name))
      .filter(Boolean)
    : manifest.streams || [];
  const grantStreams = grant?.streams || [];
  // Streams the loaded manifest declares — lets the expand-capabilities builder
  // distinguish "target stream not granted" from "target stream unknown".
  const manifestStreamNames = new Set((manifest.streams || []).map((stream) => stream.name));
  const freshnessEvidence = await getConnectorFreshnessEvidence({ source, manifest });

  // Look up granted connections once per connector. For polyfill connectors
  // we batch a single owner+connector store query and reuse the result for
  // every stream entry, narrowing per-stream by `grant.streams[].connection_id`
  // when the grant pins a single connection. For provider_native sources we
  // omit the field — those grants do not address a connection_id.
  let activeBindings = null;
  if (connectorId && ownerSubjectId) {
    activeBindings = await listGrantedConnectionsForStream({
      ownerSubjectId,
      connectorId,
      grantStreamConnectionId: null,
    });
  }

  const streams = visibleStreams.map((manifestStream) => {
    const lastUpdated = summaryByName.get(manifestStream.name)?.last_updated || null;
    const streamGrant = grantStreamByName ? grantStreamByName.get(manifestStream.name) || null : null;
    let grantedConnections = null;
    if (activeBindings) {
      const pin = streamGrant?.connection_id || null;
      grantedConnections = pin
        ? activeBindings.filter((entry) => entry.connection_id === pin)
        : activeBindings;
    }
    return buildStreamMetadataEntry({
      manifestStream,
      streamGrant,
      grantStreams,
      freshness: buildConnectorAwareFreshness(freshnessEvidence, lastUpdated),
      grantedConnections,
      manifestStreamNames,
    });
  });

  const item = {
    object: 'connector',
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

export async function getVisibleStreamFreshness({ tokenInfo, source, storageBinding, stream, manifest }) {
  const freshnessEvidence = await getConnectorFreshnessEvidence({ source, manifest });
  if (tokenInfo?.pdpp_token_kind === 'owner') {
    const summaries = await listAllStreams(storageBinding);
    const summary = summaries.find((entry) => entry.name === stream);
    return buildConnectorAwareFreshness(freshnessEvidence, summary?.last_updated || null);
  }

  const streamGrant = tokenInfo?.grant?.streams?.find((entry) => entry.name === stream);
  if (!streamGrant) {
    const err = new Error(`Stream '${stream}' not in grant`);
    err.code = 'grant_stream_not_allowed';
    throw err;
  }
  const summaries = await listStreams(storageBinding, { streams: [streamGrant] }, manifest);
  return buildConnectorAwareFreshness(freshnessEvidence, summaries[0]?.last_updated || null);
}
