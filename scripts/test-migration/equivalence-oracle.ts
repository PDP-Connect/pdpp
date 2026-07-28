// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The T1 equivalence oracle — the fixed contract from the packet:
 *
 *   executed test-file set identical modulo RECORDED renames;
 *   assertion count non-decreasing;
 *   skip reasons unchanged.
 *
 * This module compares a "before" snapshot (the tracked `.js` test files and
 * their static test inventories) against an "after" snapshot (the tracked
 * `.ts` test files post-migration), given the SAME RenameMap Stage A used.
 * It never re-derives what was renamed — a rename the equivalence check
 * doesn't already know about is exactly the "de-classifying rename" defect
 * class (a rename that drops a file from the executable set and off the
 * oracle's radar at the same time), which is why "modulo recorded renames"
 * must consult the map, not re-infer renames from a diff heuristic.
 *
 * Three independent checks, each individually falsifiable (see
 * mutation-oracle.ts for the proof):
 *
 *  1. `executedSetEquivalence` — the set of executable-classified test
 *     files must be identical before/after, up to the rename map. A file
 *     dropped, or a file whose classification silently changed (e.g.
 *     `foo.test.ts` renamed to `foo-helper.ts` — no longer matching
 *     EXECUTABLE_TEST_SUFFIX), fails this check. Reuses
 *     `classifyTrackedPath` from scripts/test-accounting/inventory.ts so
 *     "executable" means exactly what the accounting gate means — this
 *     oracle and the accounting gate must never define "executable"
 *     differently, or a file could pass one and silently fail the other.
 *
 *  2. `assertionCountEquivalence` — per file (mapped through the rename),
 *     the number of statically-discovered `test(...)`/`it(...)` call sites
 *     must be non-decreasing. Files where either side is "opaque" (dynamic
 *     test registration via an imported conformance-runner helper — see
 *     static-test-inventory.ts) are reported separately as
 *     `requiresDynamicCheck`, never silently assumed equivalent.
 *
 *  3. `skipReasonEquivalence` — per file, per test name, the skip state
 *     (not-skipped / skipped-literal / skipped-dynamic:<expr text>) must be
 *     identical before/after. A test whose name did not change but whose
 *     skip classification did (including a changed dynamic-skip expression
 *     TEXT) fails this check.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyTrackedPath } from "../test-accounting/inventory.ts";
import type { RenameMap } from "./rename-map.ts";
import { type SkipState, type StaticTestInventory, staticTestInventoryForFile } from "./static-test-inventory.ts";

// Static (AST-based) counting only applies to JS/TS executable test files.
// `classifyTrackedPath` (test-accounting) also classifies .py and .sh test
// files as "executable" — those are legitimately out of scope for a JS/TS
// parser and are always routed to requiresDynamicCheck below, never parsed.
const JS_TS_SUFFIX_PATTERN = /\.(?:js|mjs|cjs|ts|tsx)$/;

export interface ExecutedSetEquivalenceResult {
  /** Files that mapped through a recorded rename but whose classification changed (e.g. no longer matches the executable suffix). */
  declassified: { after: string; before: string }[];
  /** Files executable BEFORE that have no accounted-for counterpart AFTER. */
  missingAfter: string[];
  ok: boolean;
  /** Files executable AFTER that were not executable BEFORE and are not a recorded rename target. */
  unexpectedNew: string[];
}

/**
 * Maps a "before" path through the rename map to what it should be called
 * "after" (or itself, if not renamed).
 */
function afterPathFor(beforePath: string, renameMap: RenameMap): string {
  return renameMap.byFromPath.get(beforePath) ?? beforePath;
}

export function executedSetEquivalence(
  beforeFiles: string[],
  afterFiles: string[],
  renameMap: RenameMap
): ExecutedSetEquivalenceResult {
  const beforeExecutable = beforeFiles.filter((path) => classifyTrackedPath(path).kind === "executable");
  const afterExecutableSet = new Set(afterFiles.filter((path) => classifyTrackedPath(path).kind === "executable"));
  const afterAllSet = new Set(afterFiles);

  const missingAfter: string[] = [];
  const declassified: { after: string; before: string }[] = [];
  for (const before of beforeExecutable) {
    const expectedAfter = afterPathFor(before, renameMap);
    if (afterExecutableSet.has(expectedAfter)) {
      continue;
    }
    if (afterAllSet.has(expectedAfter)) {
      // The mapped file exists but no longer classifies as executable — the
      // de-classifying-rename defect class the packet calls out by name.
      declassified.push({ before, after: expectedAfter });
    } else {
      missingAfter.push(before);
    }
  }

  const beforeExpectedAfterSet = new Set(beforeExecutable.map((path) => afterPathFor(path, renameMap)));
  const unexpectedNew = [...afterExecutableSet].filter((path) => !beforeExpectedAfterSet.has(path));

  return {
    ok: missingAfter.length === 0 && unexpectedNew.length === 0 && declassified.length === 0,
    missingAfter,
    unexpectedNew,
    declassified,
  };
}

/**
 * Resolves both sides' static test inventories for one before/after file
 * pair, or reports that this pair is opaque to static analysis (missing on
 * either side — handled by executedSetEquivalence, not repeated here; a
 * non-JS/TS executable like .py/.sh; or a dynamic-registration conformance
 * file with zero statically-visible call sites). Shared by
 * assertionCountEquivalence and skipReasonEquivalence so both apply the
 * exact same "can this pair be verified statically" rule.
 */
function resolveInventoryPair(
  before: string,
  after: string,
  beforeRoot: string,
  afterRoot: string
): { afterInv: StaticTestInventory; beforeInv: StaticTestInventory } | { opaque: true } | { skip: true } {
  const beforeAbs = join(beforeRoot, before);
  const afterAbs = join(afterRoot, after);
  if (!(existsSync(beforeAbs) && existsSync(afterAbs))) {
    // executedSetEquivalence already reports missing/declassified files;
    // this check only compares files present on both sides.
    return { skip: true };
  }
  if (!(JS_TS_SUFFIX_PATTERN.test(before) && JS_TS_SUFFIX_PATTERN.test(after))) {
    return { opaque: true };
  }
  const beforeInv = staticTestInventoryForFile(beforeAbs);
  const afterInv = staticTestInventoryForFile(afterAbs);
  if (
    (beforeInv.isNodeTestFile && beforeInv.callSites.length === 0) ||
    (afterInv.isNodeTestFile && afterInv.callSites.length === 0)
  ) {
    return { opaque: true };
  }
  return { beforeInv, afterInv };
}

export interface AssertionCountEquivalenceEntry {
  after: string;
  afterCount: number;
  before: string;
  beforeCount: number;
}
export interface AssertionCountEquivalenceResult {
  decreased: AssertionCountEquivalenceEntry[];
  ok: boolean;
  /** Files where before or after is opaque to static analysis (dynamic test registration) — must be checked by running the suite, not assumed equal. */
  requiresDynamicCheck: { after: string; before: string }[];
}

export function assertionCountEquivalence(
  beforeExecutable: string[],
  renameMap: RenameMap,
  repoRoot: string,
  { beforeRoot = repoRoot, afterRoot = repoRoot }: { afterRoot?: string; beforeRoot?: string } = {}
): AssertionCountEquivalenceResult {
  const decreased: AssertionCountEquivalenceEntry[] = [];
  const requiresDynamicCheck: { after: string; before: string }[] = [];
  for (const before of beforeExecutable) {
    const after = afterPathFor(before, renameMap);
    const resolved = resolveInventoryPair(before, after, beforeRoot, afterRoot);
    if ("skip" in resolved) {
      continue;
    }
    if ("opaque" in resolved) {
      requiresDynamicCheck.push({ before, after });
      continue;
    }
    if (resolved.afterInv.callSites.length < resolved.beforeInv.callSites.length) {
      decreased.push({
        before,
        after,
        beforeCount: resolved.beforeInv.callSites.length,
        afterCount: resolved.afterInv.callSites.length,
      });
    }
  }
  return { ok: decreased.length === 0, decreased, requiresDynamicCheck };
}

function skipStateKey(skip: SkipState): string {
  return skip.kind === "skipped-dynamic" ? `skipped-dynamic:${skip.expressionText}` : skip.kind;
}

export interface SkipReasonEquivalenceEntry {
  after: string;
  afterSkip: string;
  before: string;
  beforeSkip: string;
  testName: string;
}
export interface SkipReasonEquivalenceResult {
  changed: SkipReasonEquivalenceEntry[];
  ok: boolean;
  requiresDynamicCheck: { after: string; before: string }[];
}

/**
 * Compares skip state by test name for one already-resolved before/after
 * inventory pair. Dynamic (non-literal) names are excluded from this
 * per-name comparison (they cannot be matched across a rename by name),
 * but they were already counted in assertionCountEquivalence. A
 * renamed/removed test name is likewise out of scope here (caught by
 * assertion-count and executed-set concerns elsewhere) — this function
 * only compares skip state for names present on both sides.
 */
function skipChangesForFilePair(
  before: string,
  after: string,
  beforeInv: StaticTestInventory,
  afterInv: StaticTestInventory
): SkipReasonEquivalenceEntry[] {
  const afterByName = new Map(afterInv.callSites.filter((c) => !c.name.startsWith("<dynamic")).map((c) => [c.name, c]));
  const changed: SkipReasonEquivalenceEntry[] = [];
  for (const beforeCall of beforeInv.callSites) {
    if (beforeCall.name.startsWith("<dynamic")) {
      continue;
    }
    const afterCall = afterByName.get(beforeCall.name);
    if (!afterCall) {
      continue;
    }
    const beforeKey = skipStateKey(beforeCall.skip);
    const afterKey = skipStateKey(afterCall.skip);
    if (beforeKey !== afterKey) {
      changed.push({ before, after, testName: beforeCall.name, beforeSkip: beforeKey, afterSkip: afterKey });
    }
  }
  return changed;
}

export function skipReasonEquivalence(
  beforeExecutable: string[],
  renameMap: RenameMap,
  repoRoot: string,
  { beforeRoot = repoRoot, afterRoot = repoRoot }: { afterRoot?: string; beforeRoot?: string } = {}
): SkipReasonEquivalenceResult {
  const changed: SkipReasonEquivalenceEntry[] = [];
  const requiresDynamicCheck: { after: string; before: string }[] = [];
  for (const before of beforeExecutable) {
    const after = afterPathFor(before, renameMap);
    const resolved = resolveInventoryPair(before, after, beforeRoot, afterRoot);
    if ("skip" in resolved) {
      continue;
    }
    if ("opaque" in resolved) {
      requiresDynamicCheck.push({ before, after });
      continue;
    }
    changed.push(...skipChangesForFilePair(before, after, resolved.beforeInv, resolved.afterInv));
  }
  return { ok: changed.length === 0, changed, requiresDynamicCheck };
}

export interface EquivalenceReport {
  assertionCounts: AssertionCountEquivalenceResult;
  executedSet: ExecutedSetEquivalenceResult;
  ok: boolean;
  skipReasons: SkipReasonEquivalenceResult;
}

/**
 * Runs the full fixed-contract oracle over the WHOLE tracked executable set
 * (not just the current batch) — matching test-accounting's own
 * whole-manifest philosophy, so a regression anywhere is visible, not just
 * inside the batch under test.
 *
 * `ok` gating rule for `requiresDynamicCheck`: a dynamic-registration or
 * non-JS/TS executable file (conformance-runner suites, .py, .sh — see
 * static-test-inventory.ts and the JS_TS_SUFFIX_PATTERN guard above) is
 * ALWAYS reported when found, but only fails `ok` if that file is actually
 * part of THIS batch's rename map. An opaque file elsewhere in the tree
 * that this batch never touches is a pre-existing, orthogonal limitation
 * of static analysis — correctly surfaced, but not this batch's problem to
 * fail on. A file inside the batch that turns out to be opaque IS this
 * batch's problem: the tool cannot certify it statically, so the batch is
 * not "done" until that file is separately verified by actually running
 * it.
 */
export function runEquivalenceOracle(
  beforeFiles: string[],
  afterFiles: string[],
  renameMap: RenameMap,
  repoRoot: string,
  roots?: { afterRoot?: string; beforeRoot?: string }
): EquivalenceReport {
  const executedSet = executedSetEquivalence(beforeFiles, afterFiles, renameMap);
  const beforeExecutable = beforeFiles.filter((path) => classifyTrackedPath(path).kind === "executable");
  const assertionCounts = assertionCountEquivalence(beforeExecutable, renameMap, repoRoot, roots);
  const skipReasons = skipReasonEquivalence(beforeExecutable, renameMap, repoRoot, roots);
  const inBatchDynamicChecks = (entries: { before: string }[]) =>
    entries.filter((entry) => renameMap.byFromPath.has(entry.before)).length;
  const ok =
    executedSet.ok &&
    assertionCounts.ok &&
    inBatchDynamicChecks(assertionCounts.requiresDynamicCheck) === 0 &&
    skipReasons.ok &&
    inBatchDynamicChecks(skipReasons.requiresDynamicCheck) === 0;
  return { ok, executedSet, assertionCounts, skipReasons };
}
