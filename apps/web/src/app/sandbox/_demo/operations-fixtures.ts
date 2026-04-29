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
  StreamSummary,
  StreamsListDependencies,
  StreamsListSourceDescriptor,
} from "pdpp-reference-implementation/operations/rs-streams-list";
import { DEMO_RECORDS, DEMO_STREAMS } from "./dataset.ts";

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
  options: SandboxStreamsListFixtureOptions = {},
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
