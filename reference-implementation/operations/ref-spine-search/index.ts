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
  return {
    object: "search_result",
    exact: result.exact,
    traces: result.traces.map(summaryToTrace),
    grants: result.grants.map(summaryToGrant),
    runs: result.runs.map(summaryToRun),
  };
}
