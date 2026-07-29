// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * T2-BATCH-PREP step 3: measures a family's ACTUAL Stage-B-clusterable
 * error share on disposable copies of the REAL repository — not a guess,
 * not an extrapolation from the family's own `localHelperClusterErrorMass`
 * sum (that number is a same-file proxy; this script measures the real
 * post-rename `tsc` attributable-error count exactly like
 * T1-BUILD/T1-SAMPLE did; see the T1-BUILD measurement report §3).
 *
 * Method, reusing T1's own proven machinery and its own documented
 * gotcha (mod-t1-build-0725.md §3, "GOTCHA CAUGHT ON MYSELF"): a `cp -r`
 * of a `git worktree add`-created directory is NOT independent — the
 * worktree's `.git` is a FILE pointing at the main repo's
 * `.git/worktrees/<name>` administrative area, so copying it with `cp -r`
 * shares the same index/tracked-state with the original. This script
 * therefore always uses a fresh, independent `git worktree add --detach`
 * call per measurement, never `cp -r` of a worktree.
 *
 *   1. `git worktree add --detach <dir> <ref>` from the CALLER's repo root
 *      (read-only with respect to the caller's own tree — a worktree add
 *      does not modify the source repo's working tree, only its
 *      `.git/worktrees/` metadata, which is why this is safe to run from
 *      inside another lane's own worktree).
 *   2. Run Stage A's rename (via runStageA, the real CLI-equivalent
 *      function — same code path `run.ts --stage-a` uses) for exactly the
 *      family's file list.
 *   3. `npx tsc --noEmit -p reference-implementation/tsconfig.json` BEFORE
 *      (on an untouched sibling worktree) and AFTER (on the renamed one),
 *      diffed the same way T1-SAMPLE/T1-BUILD attributed error counts
 *      (non-family error lines must be byte-identical before/after; the
 *      delta is the family's attributable error count).
 *   4. Run Stage B's real `detectStageBClusters` (not a re-implementation)
 *      against every renamed family file, sum `potentialErrorMassReduction`
 *      across all of them, and report that as a share of the attributable
 *      error count.
 *   5. Remove both worktrees (`git worktree remove --force`), never
 *      leaving disposable state behind.
 *
 * This script performs REAL git/tsc/filesystem operations — it is
 * deliberately not the kind of pure-function module this tool otherwise
 * favors for unit testing (see stage-a.ts's own mutation-oracle.ts for
 * the same shape of exception: an orchestration script proven correct by
 * being run for real and its output inspected, not by a mock).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStageA } from "./stage-a.ts";
import { detectStageBClusters } from "./stage-b.ts";

const TSC_ERROR_LINE_PATTERN = /^(\S+)\(\d+,\d+\): error (TS\d+):/;
const JS_EXTENSION_SUFFIX_PATTERN = /\.(?:js|mjs|cjs)$/;

export interface FamilyValidationResult {
  attributableErrorCount: number;
  clusterableErrorMass: number;
  clusterableSharePercent: number;
  familyName: string;
  files: string[];
}

function addDetachedWorktree(repoRoot: string, ref: string, label: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), `pdpp-t2-family-validate-${label}-`)));
  rmSync(dir, { recursive: true, force: true }); // git worktree add requires the target not exist
  execFileSync("git", ["worktree", "add", "--detach", dir, ref], { cwd: repoRoot, stdio: "pipe" });
  return dir;
}

function removeWorktree(repoRoot: string, dir: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot, stdio: "pipe" });
  } catch {
    // best-effort: if the worktree was already removed or is in a bad
    // state, fall back to a plain rm; `git worktree prune` in the caller
    // repo cleans up the remaining administrative pointer.
    rmSync(dir, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "pipe" });
  }
}

function runTsc(worktreeDir: string): string[] {
  try {
    execFileSync("npx", ["tsc", "--noEmit", "-p", "reference-implementation/tsconfig.json"], {
      cwd: worktreeDir,
      encoding: "utf8",
      stdio: "pipe",
    });
    return [];
  } catch (error) {
    const { stdout } = error as { stdout?: string };
    return (stdout ?? "").split("\n").filter((line) => TSC_ERROR_LINE_PATTERN.test(line));
  }
}

/**
 * Filters to only the error lines OUTSIDE `reference-implementation/test/`
 * — the same "non-test noise must stay byte-identical before/after"
 * attribution methodology T1-SAMPLE/T1-BUILD used (see those reports'
 * §1.3/§3.2). NOTE: `tsc` is invoked with `cwd: <worktree root>` and
 * `-p reference-implementation/tsconfig.json` (repo-root-relative, not
 * `reference-implementation`-relative), so its diagnostic paths are
 * repo-root-relative too (`reference-implementation/test/...`,
 * `packages/cli/src/...`) — this must match that convention, not the
 * bare `test/...` prefix T1-BUILD saw when it ran tsc FROM INSIDE
 * `reference-implementation/`.
 */
export function nonTestErrorLines(lines: string[]): string[] {
  return lines.filter((line) => {
    const match = TSC_ERROR_LINE_PATTERN.exec(line);
    return match?.[1] !== undefined && !match[1].startsWith("reference-implementation/test/");
  });
}

/** attributableErrorCount = after.length - before.length, matching T1-SAMPLE/T1-BUILD's own attribution formula. */
export function attributableErrorCount(beforeLines: string[], afterLines: string[]): number {
  return afterLines.length - beforeLines.length;
}

/** share = mass / attributable * 100, or 0 (never NaN/Infinity) when there is no attributable error mass to divide into. */
export function clusterableSharePercent(clusterableErrorMass: number, attributable: number): number {
  return attributable > 0 ? (clusterableErrorMass / attributable) * 100 : 0;
}

/**
 * Validates one family: renames its files for real on a disposable
 * worktree, measures the real tsc-attributable error delta, and measures
 * the real Stage-B-clusterable share against that delta. Requires
 * `pnpm install` to already have run in the caller's repo root (worktree
 * add does not re-install node_modules; see the caller's install step).
 */
export function validateFamily(
  repoRoot: string,
  familyName: string,
  files: string[],
  options: { installCommand?: [string, string[]] } = {}
): FamilyValidationResult {
  const beforeDir = addDetachedWorktree(repoRoot, "HEAD", "before");
  const afterDir = addDetachedWorktree(repoRoot, "HEAD", "after");
  try {
    if (options.installCommand) {
      const [cmd, args] = options.installCommand;
      execFileSync(cmd, args, { cwd: beforeDir, stdio: "pipe" });
      execFileSync(cmd, args, { cwd: afterDir, stdio: "pipe" });
    }
    const beforeErrors = runTsc(beforeDir);
    runStageA(files, afterDir);
    const afterErrors = runTsc(afterDir);
    const beforeNonTest = nonTestErrorLines(beforeErrors);
    const afterNonTest = nonTestErrorLines(afterErrors);
    if (beforeNonTest.length !== afterNonTest.length) {
      throw new Error(
        `family-validate: non-test error line count drifted (${beforeNonTest.length} -> ${afterNonTest.length}); attribution is unsafe, refusing to report a number`
      );
    }
    const attributable = attributableErrorCount(beforeErrors, afterErrors);
    let clusterableErrorMass = 0;
    for (const file of files) {
      const toPath = file.replace(JS_EXTENSION_SUFFIX_PATTERN, ".ts");
      const sourceText = readFileSync(join(afterDir, toPath), "utf8");
      const clusters = detectStageBClusters(sourceText, toPath);
      clusterableErrorMass += clusters.reduce((sum, c) => sum + c.potentialErrorMassReduction, 0);
    }
    return {
      familyName,
      files,
      attributableErrorCount: attributable,
      clusterableErrorMass,
      clusterableSharePercent: clusterableSharePercent(clusterableErrorMass, attributable),
    };
  } finally {
    removeWorktree(repoRoot, beforeDir);
    removeWorktree(repoRoot, afterDir);
  }
}
