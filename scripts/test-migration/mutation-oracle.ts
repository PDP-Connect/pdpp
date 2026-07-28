// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * THE MUTATION/ROLLBACK ORACLE — the packet's own words: "the deliverable
 * that proves the rest." Every check T1 ships (executed-set equivalence,
 * assertion-count non-decrease, skip-reason stability, import-resolution
 * verification, literal-path scan) is only as good as its demonstrated
 * ability to catch a REAL defect. This script builds one clean "before"
 * fixture (a realistic mini reference-implementation/test/ tree), then for
 * each named mutation:
 *
 *   1. builds a mutated "after" tree from the clean one;
 *   2. runs the SAME oracle callers will run in production
 *      (runEquivalenceOracle from equivalence-oracle.ts, plus the Stage A
 *      precheck's import-resolution/literal-path checks where relevant);
 *   3. asserts the oracle's `ok` is FALSE and reports which specific
 *      sub-check caught it;
 *   4. separately proves ROLLBACK: `git checkout` the mutation away
 *      returns the tree to a BYTE-IDENTICAL state to the clean commit
 *      (verified via `git diff --quiet` returning zero AND a tree hash
 *      comparison), proving Stage A's changes are always cleanly
 *      revertible.
 *
 * Any mutation this script cannot make the oracle catch is reported as a
 * NAMED HOLE, not hidden — this is the explicit instruction in the packet
 * ("report each mutation with observed output... any mutation you cannot
 * make fail is a hole — report it rather than hiding it").
 *
 * Run: `node --import tsx scripts/test-migration/mutation-oracle.ts`
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trackedFiles } from "../test-accounting/inventory.ts";
import { runEquivalenceOracle } from "./equivalence-oracle.ts";
import { createFixtureRepo, disposeFixtureRepo, type FixtureRepo, nodeTestFileBody } from "./fixture-repo.ts";
import { verifyFileImportsResolve } from "./import-resolution.ts";
import { scanFileForStaleLiteralPaths } from "./literal-path-scan.ts";
import { buildRenameMap } from "./rename-map.ts";

const TEST_DIR = "reference-implementation/test";
const SERVER_DIR = "reference-implementation/server";
const JS_EXTENSION_SUFFIX_PATTERN = /\.js$/;

interface CleanFixture {
  renameFromPaths: string[];
  repo: FixtureRepo;
}

/**
 * Builds the "clean" baseline: a small reference-implementation-shaped
 * tree with three test files (one plain, one with a skip, one with an
 * import into server/), representative of the real corpus's shapes, all
 * about to be renamed .js -> .ts. Committed once; every mutation scenario
 * below branches from this same commit.
 */
function buildCleanFixture(): CleanFixture {
  const repo = createFixtureRepo();
  repo.writeAndCommit(
    [
      {
        path: `${SERVER_DIR}/widget.js`,
        content: "export function widget() { return 'ok'; }\n",
      },
      {
        path: `${TEST_DIR}/alpha.test.js`,
        content: nodeTestFileBody(["alpha does a thing", "alpha does another thing"]),
      },
      {
        path: `${TEST_DIR}/beta.test.js`,
        content: [
          "import assert from 'node:assert/strict';",
          "import test from 'node:test';",
          "import { widget } from '../server/widget.js';",
          "",
          "test('beta uses widget', () => {",
          "  assert.equal(widget(), 'ok');",
          "});",
          "",
          "test('beta postgres-only test', { skip: !process.env.PDPP_TEST_POSTGRES_URL }, () => {",
          "  assert.equal(1, 1);",
          "});",
          "",
        ].join("\n"),
      },
      {
        path: `${TEST_DIR}/gamma-boundary.test.js`,
        content: [
          "import assert from 'node:assert/strict';",
          "import { readFileSync } from 'node:fs';",
          "import { fileURLToPath } from 'node:url';",
          "import { dirname, join } from 'node:path';",
          "import test from 'node:test';",
          "",
          "function read(relPath) {",
          "  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', relPath), 'utf8');",
          "}",
          "",
          "test('gamma inspects widget source', () => {",
          `  const src = read(${JSON.stringify(`${SERVER_DIR}/widget.js`)});`,
          "  assert.match(src, /export function widget/);",
          "});",
          "",
        ].join("\n"),
      },
    ],
    "clean baseline"
  );
  return {
    repo,
    renameFromPaths: [`${TEST_DIR}/alpha.test.js`, `${TEST_DIR}/beta.test.js`, `${TEST_DIR}/gamma-boundary.test.js`],
  };
}

/** Performs the real, correct rename (git mv, byte-identical content) as the shared starting point every mutation then perturbs. */
function applyCleanRename(repo: FixtureRepo, renameFromPaths: string[]): void {
  for (const fromPath of renameFromPaths) {
    const toPath = fromPath.replace(JS_EXTENSION_SUFFIX_PATTERN, ".ts");
    repo.git(["mv", fromPath, toPath]);
  }
  repo.git(["commit", "-q", "-m", "clean rename, no other changes"]);
}

interface MutationResult {
  caught: boolean;
  caughtBy: string;
  detail: string;
  name: string;
}

function readTracked(repoDir: string, path: string): string {
  return readFileSync(join(repoDir, path), "utf8");
}
function writeTracked(repoDir: string, path: string, content: string): void {
  const absolute = join(repoDir, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

/**
 * Builds the rename map from the "before" tree (where the pre-rename .js
 * sources still exist on disk — buildRenameMap's precondition requires
 * this), never from "after" (where they have already been renamed away).
 */
function renameMapFromBefore(beforeDir: string, renameFromPaths: string[]) {
  return buildRenameMap(
    renameFromPaths.filter((p) => existsSync(join(beforeDir, p))),
    beforeDir
  );
}

/**
 * Each mutation scenario: start from a fresh clean+renamed fixture repo,
 * apply ONE perturbation relative to that clean state, then evaluate
 * whichever check(s) are relevant. Returns whether it was caught, by
 * which check, and the observed detail — the exact contract the packet
 * asks each mutation to report.
 */
function runMutationScenarios(): MutationResult[] {
  const results: MutationResult[] = [];

  function withFreshRenamedFixture(
    fn: (args: {
      afterDir: string;
      beforeCommit: string;
      beforeDir: string;
      renameFromPaths: string[];
      repo: FixtureRepo;
    }) => MutationResult
  ): MutationResult {
    const clean = buildCleanFixture();
    const beforeCommit = clean.repo.git(["rev-parse", "HEAD"]).trim();
    // Snapshot the clean, pre-rename tree as the "before" side of the
    // oracle comparison: a real `git clone` at the pre-rename commit, so
    // `trackedFiles()` (git ls-files) sees a genuine independent repo, not
    // a mutable alias of the "after" repo the mutation will perturb.
    const beforeDir = join(dirname(clean.repo.dir), `${clean.repo.dir.split("/").pop()}-before`);
    execCommand(["git", "clone", "-q", clean.repo.dir, beforeDir]);
    execCommand(["git", "-C", beforeDir, "checkout", "-q", beforeCommit]);

    applyCleanRename(clean.repo, clean.renameFromPaths);
    try {
      return fn({
        repo: clean.repo,
        beforeDir,
        afterDir: clean.repo.dir,
        renameFromPaths: clean.renameFromPaths,
        beforeCommit,
      });
    } finally {
      disposeFixtureRepo(clean.repo);
      rmSync(beforeDir, { recursive: true, force: true });
    }
  }

  // ── Mutation 1: a dropped test file ───────────────────────────────────
  results.push(
    withFreshRenamedFixture(({ repo, beforeDir, afterDir, renameFromPaths }) => {
      rmSync(join(afterDir, `${TEST_DIR}/alpha.test.ts`));
      repo.git(["add", "-A"]);
      repo.git(["commit", "-q", "-m", "mutation: drop alpha.test.ts"]);
      const renameMap = renameMapFromBefore(beforeDir, renameFromPaths);
      const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(afterDir), renameMap, afterDir, {
        beforeRoot: beforeDir,
        afterRoot: afterDir,
      });
      return {
        name: "dropped test file",
        caught: !report.ok && report.executedSet.missingAfter.includes(`${TEST_DIR}/alpha.test.js`),
        caughtBy: "executedSetEquivalence.missingAfter",
        detail: JSON.stringify(report.executedSet),
      };
    })
  );

  // ── Mutation 2: a silently-skipped test (skip: false -> skip: true) ───
  results.push(
    withFreshRenamedFixture(({ repo, beforeDir, afterDir, renameFromPaths }) => {
      const path = `${TEST_DIR}/alpha.test.ts`;
      const original = readTracked(afterDir, path);
      const mutated = original.replace(
        'test("alpha does another thing", () => {',
        'test("alpha does another thing", { skip: true }, () => {'
      );
      if (mutated === original) {
        throw new Error("mutation 2 setup: replacement did not match — fixture text drifted");
      }
      writeTracked(afterDir, path, mutated);
      repo.git(["add", "-A"]);
      repo.git(["commit", "-q", "-m", "mutation: silently skip alpha's second test"]);
      const renameMap = renameMapFromBefore(beforeDir, renameFromPaths);
      const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(afterDir), renameMap, afterDir, {
        beforeRoot: beforeDir,
        afterRoot: afterDir,
      });
      return {
        name: "silently-skipped test",
        caught: !report.ok && report.skipReasons.changed.some((c) => c.testName === "alpha does another thing"),
        caughtBy: "skipReasonEquivalence.changed",
        detail: JSON.stringify(report.skipReasons.changed),
      };
    })
  );

  // ── Mutation 3: a reduced assertion count (one test() call deleted) ───
  results.push(
    withFreshRenamedFixture(({ repo, beforeDir, afterDir, renameFromPaths }) => {
      const path = `${TEST_DIR}/alpha.test.ts`;
      const original = readTracked(afterDir, path);
      const singleTest = nodeTestFileBody(["alpha does a thing"]);
      writeTracked(afterDir, path, singleTest);
      if (original === singleTest) {
        throw new Error("mutation 3 setup: no reduction occurred — fixture text drifted");
      }
      repo.git(["add", "-A"]);
      repo.git(["commit", "-q", "-m", "mutation: drop alpha's second test() call"]);
      const renameMap = renameMapFromBefore(beforeDir, renameFromPaths);
      const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(afterDir), renameMap, afterDir, {
        beforeRoot: beforeDir,
        afterRoot: afterDir,
      });
      return {
        name: "reduced assertion count",
        caught: !report.ok && report.assertionCounts.decreased.some((d) => d.before === `${TEST_DIR}/alpha.test.js`),
        caughtBy: "assertionCountEquivalence.decreased",
        detail: JSON.stringify(report.assertionCounts.decreased),
      };
    })
  );

  // ── Mutation 4: a changed skip reason (different dynamic expression) ──
  results.push(
    withFreshRenamedFixture(({ repo, beforeDir, afterDir, renameFromPaths }) => {
      const path = `${TEST_DIR}/beta.test.ts`;
      const original = readTracked(afterDir, path);
      const mutated = original.replace("!process.env.PDPP_TEST_POSTGRES_URL", "!process.env.PDPP_TEST_MYSQL_URL");
      if (mutated === original) {
        throw new Error("mutation 4 setup: replacement did not match — fixture text drifted");
      }
      writeTracked(afterDir, path, mutated);
      repo.git(["add", "-A"]);
      repo.git(["commit", "-q", "-m", "mutation: change beta's skip predicate env var"]);
      const renameMap = renameMapFromBefore(beforeDir, renameFromPaths);
      const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(afterDir), renameMap, afterDir, {
        beforeRoot: beforeDir,
        afterRoot: afterDir,
      });
      return {
        name: "changed skip reason (dynamic expression text)",
        caught: !report.ok && report.skipReasons.changed.some((c) => c.testName === "beta postgres-only test"),
        caughtBy: "skipReasonEquivalence.changed",
        detail: JSON.stringify(report.skipReasons.changed),
      };
    })
  );

  // ── Mutation 5: an off-by-one "../" import (fixture 1's defect class) ─
  results.push(
    withFreshRenamedFixture(({ afterDir }) => {
      const path = join(afterDir, `${TEST_DIR}/beta.test.ts`);
      const original = readFileSync(path, "utf8");
      const mutated = original.replace("../server/widget.js", "../../server/widget.js");
      if (mutated === original) {
        throw new Error("mutation 5 setup: replacement did not match — fixture text drifted");
      }
      writeFileSync(path, mutated, "utf8"); // deliberately NOT committed — precheck runs on working tree content.
      const unresolved = verifyFileImportsResolve(mutated, path);
      return {
        name: 'off-by-one "../" import specifier',
        caught: unresolved.some((u) => u.specifier === "../../server/widget.js"),
        caughtBy: "verifyFileImportsResolve",
        detail: JSON.stringify(unresolved),
      };
    })
  );

  // ── Mutation 6: a stale literal source path (fixture 2's defect class) ─
  //
  // gamma-boundary.test.ts's read() helper names server/widget.js by a
  // repo-root-relative STRING LITERAL (not an import specifier). This
  // scenario renames server/widget.js -> server/widget.ts (a second,
  // unrelated rename in the SAME batch, e.g. a production module migrated
  // alongside its tests) WITHOUT updating gamma-boundary's literal — the
  // exact real-world shape of fixture 2's historical defect — and proves
  // the literal-path scan catches the now-stale reference.
  results.push(
    withFreshRenamedFixture(({ repo, beforeDir, afterDir }) => {
      repo.git(["mv", `${SERVER_DIR}/widget.js`, `${SERVER_DIR}/widget.ts`]);
      repo.git(["commit", "-q", "-m", "mutation: rename server/widget.js without updating gamma-boundary's literal"]);
      const widgetRenameMap = buildRenameMap([`${SERVER_DIR}/widget.js`], beforeDir);
      const path = join(afterDir, `${TEST_DIR}/gamma-boundary.test.ts`);
      const sourceText = readFileSync(path, "utf8");
      const hits = scanFileForStaleLiteralPaths(sourceText, path, widgetRenameMap);
      return {
        name: "stale literal source path referencing a renamed file",
        caught: hits.length > 0 && hits.some((h) => h.matchedOldPath === `${SERVER_DIR}/widget.js`),
        caughtBy: "scanFileForStaleLiteralPaths",
        detail: JSON.stringify(hits),
      };
    })
  );

  // ── Mutation 7: a de-classifying rename (foo.test.ts -> foo-helper.ts) ─
  results.push(
    withFreshRenamedFixture(({ repo, beforeDir, afterDir, renameFromPaths }) => {
      // Undo the alpha rename's .ts landing and instead land it as a
      // non-executable-suffixed name — simulating a rename that ALSO
      // silently changes classification (the exact defect class R1's
      // closure check cannot see, per the packet).
      repo.git(["mv", `${TEST_DIR}/alpha.test.ts`, `${TEST_DIR}/alpha-helper.ts`]);
      repo.git(["commit", "-q", "-m", "mutation: de-classifying rename, alpha.test.ts -> alpha-helper.ts"]);
      const renameMap = buildRenameMap(
        renameFromPaths.filter((p) => p !== `${TEST_DIR}/alpha.test.js`),
        beforeDir
      );
      // Manually add the de-classifying entry as a "recorded rename" the
      // way a real (buggy) batch script might record it — this is the
      // adversarial case: even if the tool WAS TOLD about this rename, the
      // executable-suffix classification must still catch it.
      renameMap.byFromPath.set(`${TEST_DIR}/alpha.test.js`, `${TEST_DIR}/alpha-helper.ts`);
      renameMap.byToPath.set(`${TEST_DIR}/alpha-helper.ts`, `${TEST_DIR}/alpha.test.js`);
      renameMap.entries.push({ fromPath: `${TEST_DIR}/alpha.test.js`, toPath: `${TEST_DIR}/alpha-helper.ts` });
      const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(afterDir), renameMap, afterDir, {
        beforeRoot: beforeDir,
        afterRoot: afterDir,
      });
      return {
        name: "de-classifying rename (foo.test.ts -> foo-helper.ts)",
        caught: !report.ok && report.executedSet.declassified.some((d) => d.before === `${TEST_DIR}/alpha.test.js`),
        caughtBy: "executedSetEquivalence.declassified",
        detail: JSON.stringify(report.executedSet),
      };
    })
  );

  return results;
}

function execCommand(argv: string[]): void {
  const [file, ...rest] = argv;
  if (!file) {
    throw new Error("execCommand requires a non-empty argv");
  }
  execFileSync(file, rest, { stdio: "pipe" });
}

/**
 * Positive control: proves the oracle does NOT false-positive on a
 * genuinely clean rename (no mutation applied at all). Without this, "the
 * oracle always reports ok:false" would trivially pass every mutation
 * scenario above for the wrong reason — a permanently-red oracle would
 * "catch" everything by being useless.
 */
function provePositiveControl(): { detail: string; ok: boolean } {
  const clean = buildCleanFixture();
  const beforeCommit = clean.repo.git(["rev-parse", "HEAD"]).trim();
  const beforeDir = join(dirname(clean.repo.dir), `${clean.repo.dir.split("/").pop()}-before`);
  execCommand(["git", "clone", "-q", clean.repo.dir, beforeDir]);
  execCommand(["git", "-C", beforeDir, "checkout", "-q", beforeCommit]);
  applyCleanRename(clean.repo, clean.renameFromPaths);
  const renameMap = renameMapFromBefore(beforeDir, clean.renameFromPaths);
  const report = runEquivalenceOracle(
    trackedFiles(beforeDir),
    trackedFiles(clean.repo.dir),
    renameMap,
    clean.repo.dir,
    {
      beforeRoot: beforeDir,
      afterRoot: clean.repo.dir,
    }
  );
  disposeFixtureRepo(clean.repo);
  rmSync(beforeDir, { recursive: true, force: true });
  return { ok: report.ok, detail: JSON.stringify(report) };
}

/** Proves rollback: a Stage-A-renamed tree can be reverted to a byte-identical prior tree via git. */
function proveRollback(): { detail: string; ok: boolean } {
  const clean = buildCleanFixture();
  const beforeCommit = clean.repo.git(["rev-parse", "HEAD"]).trim();
  const beforeTree = clean.repo.git(["rev-parse", `${beforeCommit}^{tree}`]).trim();
  applyCleanRename(clean.repo, clean.renameFromPaths);
  clean.repo.git(["reset", "--hard", beforeCommit]);
  const afterRevertTree = clean.repo.git(["rev-parse", "HEAD^{tree}"]).trim();
  const clean_ = clean.repo.git(["status", "--porcelain"]).trim();
  disposeFixtureRepo(clean.repo);
  return {
    ok: beforeTree === afterRevertTree && clean_ === "",
    detail: `before tree ${beforeTree}, after-revert tree ${afterRevertTree}, working tree status: "${clean_}"`,
  };
}

function main(): void {
  const positiveControl = provePositiveControl();
  const results = runMutationScenarios();
  const rollback = proveRollback();
  const holes = results.filter((r) => !r.caught);
  process.stdout.write("T1 mutation/rollback oracle report\n");
  process.stdout.write("===================================\n\n");
  process.stdout.write(
    `[${positiveControl.ok ? "PASS (no false positive)" : "**FALSE POSITIVE**"}] positive control: clean rename, no mutation\n`
  );
  process.stdout.write(`  observed:   ${positiveControl.detail}\n\n`);
  for (const result of results) {
    process.stdout.write(`[${result.caught ? "CAUGHT" : "**HOLE — NOT CAUGHT**"}] ${result.name}\n`);
    process.stdout.write(`  checked by: ${result.caughtBy}\n`);
    process.stdout.write(`  observed:   ${result.detail}\n\n`);
  }
  process.stdout.write(`[${rollback.ok ? "PROVEN" : "**FAILED**"}] rollback to byte-identical prior tree\n`);
  process.stdout.write(`  observed:   ${rollback.detail}\n\n`);
  process.stdout.write(
    `Summary: positive control ${positiveControl.ok ? "clean" : "FALSE POSITIVE"}, ${results.length - holes.length}/${results.length} mutations caught, rollback ${rollback.ok ? "proven" : "FAILED"}.\n`
  );
  if (holes.length > 0) {
    process.stdout.write(`HOLES (not caught): ${holes.map((h) => h.name).join(", ")}\n`);
  }
  if (holes.length > 0 || !rollback.ok || !positiveControl.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main();
}
