// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * T2-BATCH-PREP deliverable: turns helper-family.ts's mechanical grouping
 * into a ranked, sized batching PLAN for the 741-file
 * `reference-implementation/test/**\/*.js` tranche. This module makes NO
 * batching decisions that aren't derived from measured data (family size,
 * LOC, Stage-B same-file cluster mass) — the one place judgment enters
 * (target batch size, execution order) is documented inline, not hidden.
 *
 * Per-file error projection uses T1-SAMPLE's own measured mean
 * (17.75 errors/file, the T1-SAMPLE measurement report §1.4) —
 * reused, not re-derived, exactly as the packet instructs ("build on it,
 * don't re-derive it").
 *
 * "Projected Stage-B-clusterable share" per family starts from the SAME
 * mechanism T1 already ships (`detectStageBClusters`, imported via
 * helper-family.ts's `localHelperClusterErrorMass`) applied to EVERY file
 * in the family, not just one representative file — this is the
 * mechanical projection. The REAL measured share (from disposable-worktree
 * validation, family-validate.ts) supersedes the projection for whichever
 * families were actually validated; batch-plan.ts keeps both numbers
 * visible rather than overwriting the mechanical projection with the
 * validated one, so a reader can see projection vs. ground truth
 * side-by-side.
 */

import type { FamilyValidationResult } from "./family-validate.ts";
import type { FileHelperSurface, HelperFamily } from "./helper-family.ts";

/** T1-SAMPLE §1.4 measured mean, reused per the packet's instruction not to re-derive it. */
export const MEASURED_MEAN_ERRORS_PER_FILE = 17.75;
/** T1-BUILD §3.4's flat/random-slice baseline this plan's hypothesis is tested against. */
export const FLAT_SLICE_BASELINE_CLUSTERABLE_SHARE_PERCENT = 9.6;

export interface BatchPlanEntry {
  fileCount: number;
  files: string[];
  kind: HelperFamily["kind"];
  /** Real disposable-worktree measurement, present only for validated families (see validation section of the report). */
  measuredClusterableSharePercent: number | null;
  name: string;
  projectedClusterableErrorMass: number;
  projectedClusterableSharePercent: number;
  projectedErrorCount: number;
  totalLoc: number;
}

function projectedErrorCountFor(files: FileHelperSurface[]): number {
  return Math.round(files.length * MEASURED_MEAN_ERRORS_PER_FILE);
}

function projectedClusterableMassFor(files: FileHelperSurface[]): number {
  return files.reduce((sum, f) => sum + f.localHelperClusterErrorMass, 0);
}

/**
 * Builds one ranked, sized plan entry per family. Families are ranked by
 * `projectedClusterableErrorMass` DESCENDING — the packet's own framing
 * ("rank ... by ... the important one — projected Stage-B-clusterable
 * share") — so the highest-leverage batches (most propagable error mass
 * per authored decision) sort first; ties broken by file count descending
 * (bigger batches, more amortization of the one authored decision).
 */
export function buildBatchPlan(
  families: HelperFamily[],
  measurements: Map<string, FamilyValidationResult> = new Map()
): BatchPlanEntry[] {
  const entries = families.map((family) => {
    const projectedErrorCount = projectedErrorCountFor(family.files);
    const projectedClusterableErrorMass = projectedClusterableMassFor(family.files);
    const projectedClusterableSharePercent =
      projectedErrorCount > 0 ? (projectedClusterableErrorMass / projectedErrorCount) * 100 : 0;
    const measured = measurements.get(family.name);
    return {
      name: family.name,
      kind: family.kind,
      fileCount: family.files.length,
      totalLoc: family.files.reduce((sum, f) => sum + f.loc, 0),
      files: family.files.map((f) => f.file),
      projectedErrorCount,
      projectedClusterableErrorMass,
      projectedClusterableSharePercent,
      measuredClusterableSharePercent: measured ? measured.clusterableSharePercent : null,
    } satisfies BatchPlanEntry;
  });
  return entries.sort((a, b) => {
    if (b.projectedClusterableErrorMass !== a.projectedClusterableErrorMass) {
      return b.projectedClusterableErrorMass - a.projectedClusterableErrorMass;
    }
    return b.fileCount - a.fileCount;
  });
}

export interface PlanSummary {
  familiesWithClusterSignal: number;
  totalFamilies: number;
  totalFiles: number;
  ungroupedSingletonFiles: number;
}

export function summarizePlan(entries: BatchPlanEntry[]): PlanSummary {
  return {
    totalFamilies: entries.length,
    totalFiles: entries.reduce((sum, e) => sum + e.fileCount, 0),
    familiesWithClusterSignal: entries.filter((e) => e.projectedClusterableErrorMass > 0).length,
    ungroupedSingletonFiles: entries.filter((e) => e.kind === "ungrouped").reduce((sum, e) => sum + e.fileCount, 0),
  };
}
