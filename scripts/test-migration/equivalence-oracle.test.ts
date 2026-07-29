// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { trackedFiles } from "../test-accounting/inventory.ts";
import { executedSetEquivalence, runEquivalenceOracle } from "./equivalence-oracle.ts";
import { createFixtureRepo, disposeFixtureRepo, nodeTestFileBody } from "./fixture-repo.ts";
import { buildRenameMap } from "./rename-map.ts";

const TEST_DIR = "reference-implementation/test";

function cloneAt(sourceDir: string, ref: string): string {
  const targetDir = join(dirname(sourceDir), `${sourceDir.split("/").pop()}-clone-${ref}`);
  execFileSync("git", ["clone", "-q", sourceDir, targetDir]);
  execFileSync("git", ["-C", targetDir, "checkout", "-q", ref]);
  return targetDir;
}

test("executedSetEquivalence: a pure rename with no other change is equivalent", () => {
  // buildRenameMap requires the .js source to exist on disk, so the map is
  // built against a clone taken BEFORE the rename (mirrors the real
  // production flow: Stage A's precheck runs before `git mv`).
  const repo = createFixtureRepo();
  let beforeDir = "";
  try {
    repo.writeAndCommit([{ path: `${TEST_DIR}/a.test.js`, content: nodeTestFileBody(["a"]) }], "before");
    const beforeCommit = repo.git(["rev-parse", "HEAD"]).trim();
    beforeDir = cloneAt(repo.dir, beforeCommit);
    const beforeFiles = trackedFiles(beforeDir);
    const renameMap = buildRenameMap([`${TEST_DIR}/a.test.js`], beforeDir);
    repo.git(["mv", `${TEST_DIR}/a.test.js`, `${TEST_DIR}/a.test.ts`]);
    repo.git(["commit", "-q", "-m", "rename"]);
    const afterFiles = trackedFiles(repo.dir);
    const result = executedSetEquivalence(beforeFiles, afterFiles, renameMap);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingAfter, []);
    assert.deepEqual(result.unexpectedNew, []);
    assert.deepEqual(result.declassified, []);
  } finally {
    disposeFixtureRepo(repo);
    if (beforeDir) {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  }
});

test("runEquivalenceOracle end-to-end: clean rename reports ok across all three checks", () => {
  const repo = createFixtureRepo();
  let beforeDir = "";
  try {
    repo.writeAndCommit(
      [
        { path: `${TEST_DIR}/a.test.js`, content: nodeTestFileBody(["a1", "a2"]) },
        { path: `${TEST_DIR}/b.test.js`, content: nodeTestFileBody(["b1"], { skip: { b1: "!process.env.X" } }) },
      ],
      "before"
    );
    const beforeCommit = repo.git(["rev-parse", "HEAD"]).trim();
    beforeDir = cloneAt(repo.dir, beforeCommit);
    const renameMap = buildRenameMap([`${TEST_DIR}/a.test.js`, `${TEST_DIR}/b.test.js`], beforeDir);
    repo.git(["mv", `${TEST_DIR}/a.test.js`, `${TEST_DIR}/a.test.ts`]);
    repo.git(["mv", `${TEST_DIR}/b.test.js`, `${TEST_DIR}/b.test.ts`]);
    repo.git(["commit", "-q", "-m", "rename"]);
    const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(repo.dir), renameMap, repo.dir, {
      beforeRoot: beforeDir,
      afterRoot: repo.dir,
    });
    assert.equal(report.ok, true);
    assert.equal(report.executedSet.ok, true);
    assert.equal(report.assertionCounts.ok, true);
    assert.equal(report.skipReasons.ok, true);
  } finally {
    disposeFixtureRepo(repo);
    if (beforeDir) {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  }
});

test("runEquivalenceOracle: a dropped file fails executedSet.missingAfter", () => {
  const repo = createFixtureRepo();
  let beforeDir = "";
  try {
    repo.writeAndCommit([{ path: `${TEST_DIR}/a.test.js`, content: nodeTestFileBody(["a1"]) }], "before");
    const beforeCommit = repo.git(["rev-parse", "HEAD"]).trim();
    beforeDir = cloneAt(repo.dir, beforeCommit);
    const renameMap = buildRenameMap([`${TEST_DIR}/a.test.js`], beforeDir);
    rmSync(join(repo.dir, `${TEST_DIR}/a.test.js`));
    repo.git(["add", "-A"]);
    repo.git(["commit", "-q", "-m", "drop"]);
    const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(repo.dir), renameMap, repo.dir, {
      beforeRoot: beforeDir,
      afterRoot: repo.dir,
    });
    assert.equal(report.ok, false);
    assert.deepEqual(report.executedSet.missingAfter, [`${TEST_DIR}/a.test.js`]);
  } finally {
    disposeFixtureRepo(repo);
    if (beforeDir) {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  }
});

test("executedSetEquivalence: an unexpected NEW executable file (not from a recorded rename) is reported", () => {
  const emptyMap = buildRenameMapNoop();
  const before = ["reference-implementation/test/a.test.js"];
  const after = ["reference-implementation/test/a.test.js", "reference-implementation/test/b.test.js"];
  const result = executedSetEquivalence(before, after, emptyMap);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpectedNew, ["reference-implementation/test/b.test.js"]);
});

function buildRenameMapNoop() {
  return { entries: [], byFromPath: new Map<string, string>(), byToPath: new Map<string, string>() };
}

test("assertion-count regression is detected even when the file itself is otherwise identical", () => {
  const repo = createFixtureRepo();
  let beforeDir = "";
  try {
    repo.writeAndCommit([{ path: `${TEST_DIR}/a.test.js`, content: nodeTestFileBody(["a1", "a2", "a3"]) }], "before");
    const beforeCommit = repo.git(["rev-parse", "HEAD"]).trim();
    beforeDir = cloneAt(repo.dir, beforeCommit);
    const renameMap = buildRenameMap([`${TEST_DIR}/a.test.js`], beforeDir);
    repo.git(["mv", `${TEST_DIR}/a.test.js`, `${TEST_DIR}/a.test.ts`]);
    writeFileSync(join(repo.dir, `${TEST_DIR}/a.test.ts`), nodeTestFileBody(["a1", "a2"]));
    repo.git(["add", "-A"]);
    repo.git(["commit", "-q", "-m", "drop a3 during migration"]);
    const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(repo.dir), renameMap, repo.dir, {
      beforeRoot: beforeDir,
      afterRoot: repo.dir,
    });
    assert.equal(report.ok, false);
    assert.equal(report.assertionCounts.decreased.length, 1);
    assert.equal(report.assertionCounts.decreased[0]?.beforeCount, 3);
    assert.equal(report.assertionCounts.decreased[0]?.afterCount, 2);
  } finally {
    disposeFixtureRepo(repo);
    if (beforeDir) {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  }
});

test("an increased assertion count is NOT a regression (non-decreasing, not exact-match)", () => {
  const repo = createFixtureRepo();
  let beforeDir = "";
  try {
    repo.writeAndCommit([{ path: `${TEST_DIR}/a.test.js`, content: nodeTestFileBody(["a1"]) }], "before");
    const beforeCommit = repo.git(["rev-parse", "HEAD"]).trim();
    beforeDir = cloneAt(repo.dir, beforeCommit);
    const renameMap = buildRenameMap([`${TEST_DIR}/a.test.js`], beforeDir);
    repo.git(["mv", `${TEST_DIR}/a.test.js`, `${TEST_DIR}/a.test.ts`]);
    writeFileSync(join(repo.dir, `${TEST_DIR}/a.test.ts`), nodeTestFileBody(["a1", "a2"]));
    repo.git(["add", "-A"]);
    repo.git(["commit", "-q", "-m", "added a2"]);
    const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(repo.dir), renameMap, repo.dir, {
      beforeRoot: beforeDir,
      afterRoot: repo.dir,
    });
    assert.equal(report.assertionCounts.ok, true);
    assert.equal(report.assertionCounts.decreased.length, 0);
  } finally {
    disposeFixtureRepo(repo);
    if (beforeDir) {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  }
});

test("a dynamic-registration conformance file (0 static call sites) is routed to requiresDynamicCheck, never silently assumed equal", () => {
  const repo = createFixtureRepo();
  let beforeDir = "";
  try {
    const body = [
      "import test from 'node:test';",
      "import { run } from './helpers/runner.js';",
      "run({ test });",
      "",
    ].join("\n");
    repo.writeAndCommit(
      [
        { path: `${TEST_DIR}/a.test.js`, content: body },
        { path: `${TEST_DIR}/helpers/runner.js`, content: "export function run() {}\n" },
      ],
      "before"
    );
    const beforeCommit = repo.git(["rev-parse", "HEAD"]).trim();
    beforeDir = cloneAt(repo.dir, beforeCommit);
    const renameMap = buildRenameMap([`${TEST_DIR}/a.test.js`], beforeDir);
    repo.git(["mv", `${TEST_DIR}/a.test.js`, `${TEST_DIR}/a.test.ts`]);
    repo.git(["commit", "-q", "-m", "rename"]);
    const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(repo.dir), renameMap, repo.dir, {
      beforeRoot: beforeDir,
      afterRoot: repo.dir,
    });
    assert.equal(
      report.ok,
      false,
      "a batch containing an opaque file it cannot statically verify must not report ok:true"
    );
    assert.equal(report.assertionCounts.requiresDynamicCheck.length, 1);
    assert.equal(report.assertionCounts.requiresDynamicCheck[0]?.before, `${TEST_DIR}/a.test.js`);
  } finally {
    disposeFixtureRepo(repo);
    if (beforeDir) {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  }
});

test("an opaque file OUTSIDE the current batch does not fail ok (it is a pre-existing, orthogonal limitation, not this batch's fault)", () => {
  const repo = createFixtureRepo();
  let beforeDir = "";
  try {
    const opaqueBody = [
      "import test from 'node:test';",
      "import { run } from './helpers/runner.js';",
      "run({ test });",
      "",
    ].join("\n");
    repo.writeAndCommit(
      [
        { path: `${TEST_DIR}/a.test.js`, content: nodeTestFileBody(["a1"]) },
        { path: `${TEST_DIR}/opaque.test.js`, content: opaqueBody },
        { path: `${TEST_DIR}/helpers/runner.js`, content: "export function run() {}\n" },
      ],
      "before"
    );
    const beforeCommit = repo.git(["rev-parse", "HEAD"]).trim();
    beforeDir = cloneAt(repo.dir, beforeCommit);
    // Only a.test.js is in THIS batch — opaque.test.js is untouched.
    const renameMap = buildRenameMap([`${TEST_DIR}/a.test.js`], beforeDir);
    repo.git(["mv", `${TEST_DIR}/a.test.js`, `${TEST_DIR}/a.test.ts`]);
    repo.git(["commit", "-q", "-m", "rename only a.test.js"]);
    const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(repo.dir), renameMap, repo.dir, {
      beforeRoot: beforeDir,
      afterRoot: repo.dir,
    });
    assert.equal(
      report.ok,
      true,
      "opaque.test.js is unchanged and out of batch, so it must not block this batch's verdict"
    );
    // It is still reported (never hidden), just doesn't gate ok.
    assert.equal(report.assertionCounts.requiresDynamicCheck.length, 1);
    assert.equal(report.assertionCounts.requiresDynamicCheck[0]?.before, `${TEST_DIR}/opaque.test.js`);
  } finally {
    disposeFixtureRepo(repo);
    if (beforeDir) {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  }
});

test("a de-classifying rename (foo.test.ts -> foo-helper.ts) is caught even when recorded in the rename map", () => {
  const repo = createFixtureRepo();
  let beforeDir = "";
  try {
    repo.writeAndCommit([{ path: `${TEST_DIR}/a.test.js`, content: nodeTestFileBody(["a1"]) }], "before");
    const beforeCommit = repo.git(["rev-parse", "HEAD"]).trim();
    beforeDir = cloneAt(repo.dir, beforeCommit);
    const renameMap = buildRenameMap([`${TEST_DIR}/a.test.js`], beforeDir);
    // Simulate a buggy batch script that recorded the rename to a
    // non-executable-suffixed destination.
    renameMap.byFromPath.set(`${TEST_DIR}/a.test.js`, `${TEST_DIR}/a-helper.ts`);
    renameMap.byToPath.clear();
    renameMap.byToPath.set(`${TEST_DIR}/a-helper.ts`, `${TEST_DIR}/a.test.js`);
    renameMap.entries[0] = { fromPath: `${TEST_DIR}/a.test.js`, toPath: `${TEST_DIR}/a-helper.ts` };
    repo.git(["mv", `${TEST_DIR}/a.test.js`, `${TEST_DIR}/a-helper.ts`]);
    repo.git(["commit", "-q", "-m", "de-classifying rename"]);
    const report = runEquivalenceOracle(trackedFiles(beforeDir), trackedFiles(repo.dir), renameMap, repo.dir, {
      beforeRoot: beforeDir,
      afterRoot: repo.dir,
    });
    assert.equal(report.ok, false);
    assert.equal(report.executedSet.declassified.length, 1);
    assert.equal(report.executedSet.declassified[0]?.before, `${TEST_DIR}/a.test.js`);
    assert.equal(report.executedSet.declassified[0]?.after, `${TEST_DIR}/a-helper.ts`);
  } finally {
    disposeFixtureRepo(repo);
    if (beforeDir) {
      rmSync(beforeDir, { recursive: true, force: true });
    }
  }
});
