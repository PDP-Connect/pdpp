// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeContinuationFact } from "@pdpp/connector-protocol/connector-runtime-protocol";
import type { CoverageAxis } from "./connector-coverage-policy.ts";
import type { CollectionReportEntry, ConnectorRunSummary, RuntimeCollectionFact } from "./ref-control.ts";

const CONTINUATION_PROOF_KEYS = [
  "boundary",
  "considered",
  "covered",
  "owner",
  "remaining",
  "slice_start",
  "slice_end",
] as const satisfies readonly (keyof RuntimeContinuationFact)[];

/** Compare every field that identifies a bounded runtime continuation. */
export function sameRuntimeContinuation(left: unknown, right: unknown): boolean {
  if (!(left && right && typeof left === "object" && typeof right === "object")) {
    return false;
  }
  const leftProof = left as Record<string, unknown>;
  const rightProof = right as Record<string, unknown>;
  return CONTINUATION_PROOF_KEYS.every((key) => leftProof[key] === rightProof[key]);
}

/** Remove only run gaps superseded by exact, complete continuation proof. */
export function filterRunGapsProvenCompleteByReport(
  run: ConnectorRunSummary | null,
  report: readonly CollectionReportEntry[]
): ConnectorRunSummary | null {
  if (!run || run.known_gaps.length === 0) {
    return run;
  }
  const completeByStream = new Map(
    report
      .filter((entry) => entry.coverage_condition === "complete" && entry.skipped?.continuation)
      .map((entry) => [entry.stream, entry] as const)
  );
  const requiredEntries = report.filter((entry) => entry.required);
  const allRequiredComplete =
    requiredEntries.length > 0 && requiredEntries.every((entry) => entry.coverage_condition === "complete");
  if (completeByStream.size === 0 && !allRequiredComplete) {
    return run;
  }
  const knownGaps = run.known_gaps.filter(
    (gap) =>
      !(
        knownGapMatchesCompleteContinuation(gap, completeByStream) ||
        (allRequiredComplete && (isUnscopedCheckpointCommitGap(gap) || isUnscopedSupersededInteractionGap(gap, run)))
      )
  );
  return knownGaps.length === run.known_gaps.length ? run : { ...run, known_gaps: knownGaps };
}

/**
 * A run-level checkpoint warning does not identify which staged stream failed
 * to commit. Once the per-stream report proves every required stream complete,
 * that warning can only describe optional or undeclared work and must not
 * downgrade the connection. The warning remains on the run itself; this filter
 * only scopes the connection-health projection.
 */
function isUnscopedCheckpointCommitGap(gap: unknown): boolean {
  const candidate = new Object(gap) as { kind?: unknown; stream?: unknown };
  return candidate.kind === "checkpoint_commit" && (candidate.stream === null || candidate.stream === undefined);
}

const RUN_SUCCEEDED_STATUSES: ReadonlySet<string> = new Set(["succeeded", "success"]);

/**
 * An `interaction_required` gap with no `stream` records a credential/login
 * prompt raised at the connection level, not against any one stream. When the
 * SAME run went on to a proven-successful terminal status AND every required
 * stream reached `complete`, the interaction the gap describes was resolved
 * (or made moot) before the run finished — the gap is a leftover trace of
 * that interaction, not evidence this run's coverage is incomplete.
 *
 * Reusing this run's OWN terminal status and per-stream completeness (never a
 * subsequent run's) keeps the same "proof from the SAME evidence, never
 * inferred forward" discipline as `knownGapMatchesCompleteContinuation`: a
 * run that did NOT reach a successful status, or that left any required
 * stream short of `complete`, leaves this gap untouched, so it continues to
 * surface as `terminal_gap` and the next login request is still asked for
 * exactly when the evidence says it is needed — never softened
 * preemptively. A run cannot both fail overall and have every required
 * stream proven complete, so this can never mask a run the caller would
 * otherwise treat as a failure.
 */
function isUnscopedSupersededInteractionGap(gap: unknown, run: ConnectorRunSummary): boolean {
  if (!RUN_SUCCEEDED_STATUSES.has(run.status)) {
    return false;
  }
  const candidate = new Object(gap) as { kind?: unknown; stream?: unknown };
  return candidate.kind === "interaction_required" && (candidate.stream === null || candidate.stream === undefined);
}

function knownGapMatchesCompleteContinuation(
  gap: unknown,
  completeByStream: ReadonlyMap<string, CollectionReportEntry>
): boolean {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return false;
  }
  const candidate = gap as { continuation?: unknown; kind?: unknown; reason?: unknown; stream?: unknown };
  if (candidate.kind !== "skip_result" || typeof candidate.stream !== "string") {
    return false;
  }
  const entry = completeByStream.get(candidate.stream);
  return Boolean(
    entry?.skipped &&
      entry.skipped.reason === candidate.reason &&
      sameRuntimeContinuation(candidate.continuation, entry.skipped.continuation)
  );
}

/** True only for a runtime-owned continuation bound to complete same-page facts. */
export function isHealthyBoundedContinuation(fact: RuntimeCollectionFact, isCompleteEvidence: boolean): boolean {
  const continuation = fact.skipped?.continuation;
  return [
    continuation !== undefined,
    fact.scoped !== false,
    fact.considered !== null,
    fact.covered !== null,
    continuation?.owner === "runtime",
    continuation?.boundary === fact.collection_scope,
    continuation?.remaining === true,
    continuation?.considered === fact.considered,
    continuation?.covered === fact.covered,
    fact.considered === fact.covered,
    isCompleteEvidence,
  ].every(Boolean);
}

export function classifyContinuationCoverage(
  fact: RuntimeCollectionFact,
  isCompleteEvidence: boolean
): "complete" | "partial" | "unknown" | null {
  const continuation = fact.skipped?.continuation;
  const shortfall = fact.considered !== null && fact.covered !== null && fact.covered < fact.considered;
  return (
    ([
      [fact.skipped === null || fact.skipped === undefined, null],
      [continuation !== undefined && fact.scoped === false, "unknown"],
      [shortfall, "partial"],
      [isHealthyBoundedContinuation(fact, isCompleteEvidence), "complete"],
    ].find(([matches]) => matches)?.[1] as "complete" | "partial" | "unknown" | undefined) ?? null
  );
}

export function resolveSkippedCoverage(
  continuationCoverage: "complete" | "partial" | "unknown" | null,
  skipCoverage: CoverageAxis,
  pendingDetailGaps: number
): CoverageAxis {
  return (
    continuationCoverage ?? (pendingDetailGaps > 0 && skipCoverage === "terminal_gap" ? "retryable_gap" : skipCoverage)
  );
}
