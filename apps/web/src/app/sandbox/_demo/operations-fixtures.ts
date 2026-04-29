/**
 * Sandbox fixture dependencies for canonical reference operations.
 *
 * The sandbox HTTP routes under `/sandbox/v1/**` are hosts for the same
 * canonical operations the native reference server runs (see
 * `reference-implementation/operations/**`). This module wires those
 * operations to the deterministic demo dataset in `./dataset.ts`.
 *
 * Boundary rules:
 * - Imports here MUST stay framework-free (no Next, no Fastify, no SQLite).
 * - This module exposes only operation-shaped capability helpers; sandbox
 *   route handlers compose them into request adapters.
 * - This module replaces website-local AS/RS response builders for live
 *   operations (e.g. the deleted `buildLiveStreamsList`).
 */

import type {
  ConnectorSchemaItem,
  SchemaGetDependencies,
  SchemaGetSourceDescriptor,
} from "pdpp-reference-implementation/operations/rs-schema-get";
import type {
  StreamDetailDependencies,
  StreamDetailSourceDescriptor,
  StreamMetadataEnvelope,
} from "pdpp-reference-implementation/operations/rs-streams-detail";
import type {
  StreamSummary,
  StreamsListDependencies,
  StreamsListSourceDescriptor,
} from "pdpp-reference-implementation/operations/rs-streams-list";
import { buildLiveStreamMetadata } from "./builders.ts";
import { DEMO_CONNECTORS, DEMO_RECORDS, DEMO_STREAMS } from "./dataset.ts";

function streamRecordCount(streamKey: string): number {
  return DEMO_RECORDS.filter((record) => record.stream === streamKey).length;
}

function latestRecordTimeForStream(streamKey: string): string | null {
  const matching = DEMO_RECORDS.filter((r) => r.stream === streamKey).map((r) => r.record_time);
  if (matching.length === 0) {
    return null;
  }
  return matching.sort().at(-1) ?? null;
}

export interface SandboxStreamsListFixtureOptions {
  /** When provided, only streams from this fixture connector are listed. */
  connectorId?: string;
}

/**
 * Build dependencies for `rs.streams.list` against the sandbox demo dataset.
 *
 * The default scope returns every demo stream across every demo connector,
 * matching the previous `buildLiveStreamsList` behavior. A `connector_id`
 * filter narrows the listing to one connector, again preserving the prior
 * sandbox query-param semantics.
 */
export function createSandboxStreamsListDependencies(
  options: SandboxStreamsListFixtureOptions = {}
): StreamsListDependencies {
  const filtered = options.connectorId
    ? DEMO_STREAMS.filter((s) => s.connector_id === options.connectorId)
    : DEMO_STREAMS;
  const summaries: StreamSummary[] = filtered.map((stream) => {
    const lastUpdated = latestRecordTimeForStream(stream.key) ?? stream.latest_record_time;
    return {
      object: "stream",
      name: stream.key,
      record_count: streamRecordCount(stream.key),
      last_updated: lastUpdated,
    };
  });
  const sourceDescriptor: StreamsListSourceDescriptor = options.connectorId
    ? { binding_kind: "connector", connector_id: options.connectorId }
    : { binding_kind: "connector" };

  return {
    listSummaries: () => Promise.resolve(summaries),
    getSourceDescriptor: () => sourceDescriptor,
  };
}

/**
 * Build dependencies for `rs.streams.detail` against the sandbox demo dataset.
 *
 * The sandbox runs every demo as an owner-shaped read against the demo
 * dataset; there are no client/grant projections to apply, so
 * `isStreamInGrant` is unreachable from sandbox routes (owner actor) and
 * `hasManifestStream` simply mirrors the demo stream catalog. The metadata
 * envelope is assembled by the same `buildLiveStreamMetadata` helper used by
 * `/sandbox/v1/schema`, which keeps the sandbox stream-detail and
 * stream-listed-in-schema shapes in sync.
 */
export function createSandboxStreamDetailDependencies(): StreamDetailDependencies {
  const streamByKey = new Map(DEMO_STREAMS.map((stream) => [stream.key, stream]));
  const sourceDescriptor: StreamDetailSourceDescriptor = { binding_kind: "connector" };

  return {
    getSourceDescriptor: () => sourceDescriptor,
    hasManifestStream: (name: string) => Promise.resolve(streamByKey.has(name)),
    // Sandbox routes always run as owner; this dependency is unreachable from
    // the sandbox host but the operation requires it on the type. Returning
    // `true` matches owner-equivalent visibility so any future client-actor
    // mounting of this fixture profile would behave like the demo schema.
    isStreamInGrant: () => true,
    buildStreamMetadata: (name: string) => {
      const stream = streamByKey.get(name);
      if (!stream) {
        // The operation only calls this after `hasManifestStream` returns
        // true, so an unknown name here is a fixture bug.
        throw new Error(`Sandbox fixture: unknown stream '${name}'`);
      }
      const metadata: StreamMetadataEnvelope = {
        ...buildLiveStreamMetadata(stream),
        object: "stream_metadata",
        name: stream.key,
      };
      return Promise.resolve(metadata);
    },
  };
}

/**
 * Build dependencies for `rs.schema.get` against the sandbox demo dataset.
 *
 * The sandbox runs every demo as an owner-shaped read; the connector items
 * are assembled from the demo connector list, with each connector's streams
 * built through the same `buildLiveStreamMetadata` helper used by the
 * stream-detail fixture and (previously) by the deleted public schema
 * builder. Keeping one envelope helper means the schema and stream-detail
 * shapes cannot drift.
 *
 * The aggregate source descriptor is `{binding_kind: 'connector'}` (no
 * `connector_id`) — schema discovery spans every demo connector, so no
 * single connector_id applies to the disclosure event. Per-connector items
 * carry their own `source.connector_id`.
 */
export function createSandboxSchemaGetDependencies(): SchemaGetDependencies {
  const sourceDescriptor: SchemaGetSourceDescriptor = { binding_kind: "connector" };
  const connectors: ConnectorSchemaItem[] = DEMO_CONNECTORS.map((connector) => {
    const streams = DEMO_STREAMS.filter((s) => s.connector_id === connector.connector_id);
    return {
      object: "connector",
      source: { binding_kind: "connector", connector_id: connector.connector_id },
      connector_id: connector.connector_id,
      stream_count: streams.length,
      streams: streams.map((stream) => ({
        ...buildLiveStreamMetadata(stream),
        object: "stream_metadata",
        name: stream.key,
      })),
    };
  });

  return {
    getSourceDescriptor: () => sourceDescriptor,
    listConnectorItems: () => Promise.resolve(connectors),
  };
}
