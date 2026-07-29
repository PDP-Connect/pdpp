// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage A — the fully mechanical, zero-judgment transform (packet: "Stage A
 * — fully mechanical, zero judgment. Deterministic AST/text transform with
 * PROVEN PRECONDITIONS"). Every rewrite here is either:
 *
 *   (1) the rename itself (git mv, content byte-identical — proven safe by
 *       the T1-SAMPLE measurement: 20/20 files, 0 content bytes changed,
 *       verified via `git diff --cached --stat`);
 *   (2) a VERIFICATION that must pass before the batch is considered clean
 *       (import-resolution check, literal-path scan, importer-edge scan) —
 *       these do not rewrite anything; they fail closed and report exactly
 *       what a human/Terra must fix. import-resolution and literal-path
 *       check the defect classes historically introduced by a HAND EDIT
 *       alongside a rename (fixtures 1 and 2); importer-scan closes the
 *       OPPOSITE-direction gap those two never covered — every OTHER
 *       tracked file repo-wide that imports/requires/spawns the renamed
 *       file. importer-scan's outcomes are NOT binary pass/fail: a stale
 *       `.js` specifier that resolves safely under the real `--import tsx`
 *       execution path is reported as normalization debt (not gated,
 *       toward this program's all-TypeScript terminal invariant); a
 *       require() consumer or an unresolvable/out-of-scope edge fails
 *       closed; a statically-undecidable dynamic import() is reported as
 *       an unknown for human adjudication, never guessed — see
 *       importer-scan.ts's header for the full, empirically-verified
 *       rationale;
 *   (3) the one measured-mechanical content rewrite, catch-clause
 *       `.message` narrowing (catch-clause-narrowing.ts), which is
 *       genuinely a text transform, scoped narrowly enough to be
 *       provably behavior-preserving (see that module's header).
 *
 * Stage A refuses to run (throws, fails closed) if ANY precondition does
 * not hold for ANY file in the batch — "fail closed, never best-effort" is
 * a hard requirement from the packet, not an aspiration. A caller that
 * wants partial progress must shrink the batch itself; this tool will not
 * silently skip a failing file and report the rest as clean.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCatchClauseNarrowing,
  type CatchNarrowingPlanEntry,
  planCatchClauseNarrowing,
} from "./catch-clause-narrowing.ts";
import { verifyFileImportsResolve } from "./import-resolution.ts";
import { scanRepoForStaleImporterEdges } from "./importer-scan.ts";
import { type StaleLiteralPathHit, scanFileForStaleLiteralPaths } from "./literal-path-scan.ts";
import { createMagicString } from "./magic-string.ts";
import { buildRenameMap, type RenameMap } from "./rename-map.ts";

export interface StageAPrecheckFailure {
  detail: string;
  file: string;
  kind: "import-resolution" | "importer-edge" | "literal-path" | "rename-map";
}

export interface StageAPrecheckUnknown {
  detail: string;
  file: string;
}

export interface StageAPrecheckNormalizeDebt {
  detail: string;
  file: string;
}

export interface StageAPrecheckReport {
  failures: StageAPrecheckFailure[];
  /** Stale `.js` importer specifiers that resolve safely under the real tsx execution path — not gated, but reported toward this program's all-TypeScript terminal invariant (see importer-scan.ts's header). Never folded into `ok`. */
  normalizeDebt: StageAPrecheckNormalizeDebt[];
  ok: boolean;
  renameMap: RenameMap;
  /** Importer edges this authority could not statically classify as safe or broken (see importer-scan.ts's header) — reported for human adjudication, never silently folded into `ok`. */
  unknowns: StageAPrecheckUnknown[];
}

/**
 * Runs Stage A's verification checks WITHOUT mutating anything on disk —
 * this is what a caller should run first, and what the batch-runner
 * refuses to proceed past if it is not clean. Checks every file that will
 * exist AFTER the rename (i.e. reads .js content but resolves imports as
 * if renamed — since a pure filename rename never changes byte content or
 * directory, checking the pre-rename file's import specifiers against its
 * pre-rename location is equivalent to checking them post-rename; see
 * rename-map.ts's header for why the directory never changes).
 */
export function stageAPrecheck(fromPaths: string[], repoRoot: string): StageAPrecheckReport {
  let renameMap: RenameMap;
  try {
    renameMap = buildRenameMap(fromPaths, repoRoot);
  } catch (error) {
    return {
      ok: false,
      renameMap: { entries: [], byFromPath: new Map(), byToPath: new Map() },
      failures: [{ file: "<rename map>", kind: "rename-map", detail: (error as Error).message }],
      normalizeDebt: [],
      unknowns: [],
    };
  }
  const failures: StageAPrecheckFailure[] = [];
  // Literal-path scan runs over EVERY TRACKED FILE REPO-WIDE (not just
  // reference-implementation/test, and not just the renamed set) — a file
  // anywhere in the repo that is not itself being renamed can still hold a
  // stale literal referring to a file that IS being renamed (this is
  // exactly fixture 2's shape: the boundary test names OTHER files by
  // path, it is not itself renamed in that scenario; nothing restricts
  // that shape to the test/ directory).
  const allTrackedRepoFiles = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  for (const trackedPath of allTrackedRepoFiles) {
    const absolute = join(repoRoot, trackedPath);
    let sourceText: string;
    try {
      sourceText = readFileSync(absolute, "utf8");
    } catch {
      continue; // binary or unreadable — not a text source file we can scan.
    }
    let hits: StaleLiteralPathHit[];
    try {
      hits = scanFileForStaleLiteralPaths(sourceText, absolute, renameMap);
    } catch {
      continue; // not parseable as JS/TS (e.g. .sh, .json fixture) — out of scope for a literal-path scan.
    }
    for (const hit of hits) {
      failures.push({
        file: trackedPath,
        kind: "literal-path",
        detail: `line ${hit.line}: literal "${hit.literal}" names pre-rename path "${hit.matchedOldPath}"`,
      });
    }
  }
  // Importer-side edge scan runs over EVERY TRACKED FILE REPO-WIDE, in the
  // OPPOSITE direction from the import-resolution check below: it asks
  // "who else in the repo still imports the renamed file by a specifier
  // that was never updated" — static imports/exports, dynamic import(),
  // require(), including short relative specifiers, differing relative
  // depths, and bare-basename forms. Three outcomes, not two: BROKEN edges
  // fail closed; a `.js` specifier that resolves safely under the real
  // tsx execution path is normalization debt, reported, never gated; a
  // statically-undecidable dynamic import() is reported as unknown for a
  // human, never guessed. See importer-scan.ts's header for the full,
  // empirically-verified rationale.
  const importerScan = scanRepoForStaleImporterEdges(allTrackedRepoFiles, renameMap, repoRoot);
  const normalizeDebt: StageAPrecheckNormalizeDebt[] = importerScan.normalizeDebt.map((debt) => ({
    file: debt.importer,
    detail: `line ${debt.line}: ${debt.detail}`,
  }));
  const unknowns: StageAPrecheckUnknown[] = importerScan.unknowns.map((unknown) => ({
    file: unknown.importer,
    detail: `line ${unknown.line}: ${unknown.detail}`,
  }));
  for (const edge of importerScan.failures) {
    failures.push({
      file: edge.importer,
      kind: "importer-edge",
      detail: `line ${edge.line}: [${edge.kind}] ${edge.detail}`,
    });
  }
  // Import-resolution check: only the renamed files themselves need
  // checking (their content and directory are unchanged by the rename, so
  // their relative imports were already resolving before; this check
  // exists to catch a REGRESSION introduced by a hand-edit made alongside
  // the rename — see the module header).
  for (const entry of renameMap.entries) {
    const absolute = join(repoRoot, entry.fromPath);
    const sourceText = readFileSync(absolute, "utf8");
    const unresolved = verifyFileImportsResolve(sourceText, join(repoRoot, entry.toPath));
    for (const bad of unresolved) {
      failures.push({
        file: entry.fromPath,
        kind: "import-resolution",
        detail: `line ${bad.line}: specifier "${bad.specifier}" ${bad.reason}`,
      });
    }
  }
  return { ok: failures.length === 0, renameMap, failures, normalizeDebt, unknowns };
}

export interface StageAFileResult {
  catchNarrowingPlan: CatchNarrowingPlanEntry[];
  fromPath: string;
  toPath: string;
}

export interface StageAResult {
  files: StageAFileResult[];
  renameMap: RenameMap;
}

/**
 * Executes Stage A: `git mv` every file in the rename map, then applies
 * catch-clause narrowing to the renamed content in place. MUST be preceded
 * by a clean `stageAPrecheck` — this function re-runs the precheck itself
 * and throws if it is not clean, so it can never be called in a
 * best-effort way that skips the fail-closed gate.
 */
export function runStageA(fromPaths: string[], repoRoot: string): StageAResult {
  const precheck = stageAPrecheck(fromPaths, repoRoot);
  if (!precheck.ok) {
    throw new Error(
      `stage A precondition failed, refusing to run:\n${precheck.failures.map((f) => `  ${f.kind} ${f.file}: ${f.detail}`).join("\n")}`
    );
  }
  const files: StageAFileResult[] = [];
  for (const entry of precheck.renameMap.entries) {
    execFileSync("git", ["mv", entry.fromPath, entry.toPath], { cwd: repoRoot });
    const absolute = join(repoRoot, entry.toPath);
    const sourceText = readFileSync(absolute, "utf8");
    const plan = planCatchClauseNarrowing(sourceText, absolute);
    const eligible = plan.filter((p) => p.reason === "eligible");
    if (eligible.length > 0) {
      const rewritten = applyCatchClauseNarrowing(sourceText, plan, createMagicString);
      writeFileSync(absolute, rewritten, "utf8");
    }
    files.push({ fromPath: entry.fromPath, toPath: entry.toPath, catchNarrowingPlan: plan });
  }
  return { files, renameMap: precheck.renameMap };
}
