// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `ref.spine.search` operation.
 *
 * Owns the envelope semantics for the reference-only operator-console
 * spine artifact-jump search that powers `GET /_ref/search`. The host
 * adapter supplies the already-executed search result via the
 * dependency contract; the operation projects each per-bucket summary
 * into the appropriate discriminator (`trace_summary` /
 * `grant_summary` / `run_summary`) and assembles the
 * `{object: 'search_result', exact, traces, grants, runs}` envelope.
 *
 * `/_ref/search` is reference-only — it is NOT the public lexical
 * retrieval contract at `GET /v1/search`. They share neither shape
 * nor backing.
 *
 * Boundary rules (see openspec/changes/mount-ref-spine-operations):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules,
 *   `reference-implementation/server/*` route or auth modules, or
 *   `process` / `process.env`.
 */

import type {
  RefSpineCorrelationKind,
  RefSpineCorrelationSummary,
  RefSpineGrantSummary,
  RefSpineRunSummary,
  RefSpineTraceSummary,
} from "../ref-spine-correlations-list/index.ts";
import {
  summaryToGrant,
  summaryToRun,
  summaryToTrace,
} from "../ref-spine-correlations-list/index.ts";

export interface RefSpineSearchExactRef {
  readonly kind: RefSpineCorrelationKind;
  readonly id: string;
}

export interface RefSpineSearchResult {
  readonly exact: RefSpineSearchExactRef | null;
  readonly traces: readonly RefSpineCorrelationSummary[];
  readonly grants: readonly RefSpineCorrelationSummary[];
  readonly runs: readonly RefSpineCorrelationSummary[];
}

export interface RefSpineSearchInput {
  readonly query: string;
}

export interface RefSpineSearchDependencies {
  /**
   * Optional owner-surface guard supplied by the host. The pure operation does
   * not import server connector-key helpers, but artifact search must not expose
   * reference-internal maintenance connectors.
   */
  isInternalConnectorId?(id: string): boolean;
  /**
   * Run the spine artifact-jump search. The host implementation owns
   * substrate access; the operation projects the per-bucket summaries
   * into discriminated entries.
   */
  searchSpine(query: string): Promise<RefSpineSearchResult> | RefSpineSearchResult;
}

export interface RefSpineSearchEnvelope {
  readonly object: "search_result";
  readonly exact: RefSpineSearchExactRef | null;
  readonly traces: readonly RefSpineTraceSummary[];
  readonly grants: readonly RefSpineGrantSummary[];
  readonly runs: readonly RefSpineRunSummary[];
}

function summarySourceId(s: RefSpineCorrelationSummary): string | null {
  if (s.source?.id) {
    return s.source.id;
  }
  if (s.source_id) {
    return s.source_id;
  }
  if (s.connector_id) {
    return s.connector_id;
  }
  return null;
}

function ownerVisibleSummaries(
  summaries: readonly RefSpineCorrelationSummary[],
  isInternalConnectorId: RefSpineSearchDependencies["isInternalConnectorId"],
): readonly RefSpineCorrelationSummary[] {
  return summaries.filter((summary) => {
    const sourceId = summarySourceId(summary);
    return !(sourceId && isInternalConnectorId?.(sourceId));
  });
}

function exactIfVisible(
  exact: RefSpineSearchExactRef | null,
  original: {
    readonly grants: readonly RefSpineCorrelationSummary[];
    readonly runs: readonly RefSpineCorrelationSummary[];
    readonly traces: readonly RefSpineCorrelationSummary[];
  },
  buckets: {
    readonly grants: readonly RefSpineCorrelationSummary[];
    readonly runs: readonly RefSpineCorrelationSummary[];
    readonly traces: readonly RefSpineCorrelationSummary[];
  },
): RefSpineSearchExactRef | null {
  if (!exact) {
    return null;
  }
  const originalSummaries = exact.kind === "grant" ? original.grants : exact.kind === "run" ? original.runs : original.traces;
  const filteredSummaries = exact.kind === "grant" ? buckets.grants : exact.kind === "run" ? buckets.runs : buckets.traces;
  if (!originalSummaries.some((summary) => summary.id === exact.id)) {
    return exact;
  }
  return filteredSummaries.some((summary) => summary.id === exact.id) ? exact : null;
}

/**
 * Execute the canonical `ref.spine.search` operation.
 *
 * The host adapter owns query-string parsing; the operation receives
 * the trimmed query, runs the dependency, and assembles the
 * search-result envelope.
 */
export async function executeRefSpineSearch(
  input: RefSpineSearchInput,
  dependencies: RefSpineSearchDependencies,
): Promise<RefSpineSearchEnvelope> {
  const result = await dependencies.searchSpine(input.query);
  const traces = ownerVisibleSummaries(result.traces, dependencies.isInternalConnectorId);
  const grants = ownerVisibleSummaries(result.grants, dependencies.isInternalConnectorId);
  const runs = ownerVisibleSummaries(result.runs, dependencies.isInternalConnectorId);
  return {
    object: "search_result",
    exact: exactIfVisible(result.exact, result, { traces, grants, runs }),
    traces: traces.map(summaryToTrace),
    grants: grants.map(summaryToGrant),
    runs: runs.map(summaryToRun),
  };
}
