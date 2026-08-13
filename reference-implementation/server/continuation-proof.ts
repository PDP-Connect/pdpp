// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeCollectionFact } from "./ref-control.ts";
import type { CoverageAxis } from "./connector-coverage-policy.ts";

/** True only for a runtime-owned continuation bound to complete same-page facts. */
export function isHealthyBoundedContinuation(
  fact: RuntimeCollectionFact,
  isCompleteEvidence: boolean
): boolean {
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
    [
      [fact.skipped === null || fact.skipped === undefined, null],
      [continuation !== undefined && fact.scoped === false, "unknown"],
      [shortfall, "partial"],
      [isHealthyBoundedContinuation(fact, isCompleteEvidence), "complete"],
    ].find(([matches]) => matches)?.[1] as "complete" | "partial" | "unknown" | undefined
  ) ?? null;
}

export function resolveSkippedCoverage(
  continuationCoverage: "complete" | "partial" | "unknown" | null,
  skipCoverage: CoverageAxis,
  pendingDetailGaps: number
): CoverageAxis {
  return continuationCoverage ?? (pendingDetailGaps > 0 && skipCoverage === "terminal_gap" ? "retryable_gap" : skipCoverage);
}
