// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFixtureRepo, disposeFixtureRepo } from "./fixture-repo.ts";
import { runStageA, stageAPrecheck } from "./stage-a.ts";

const TEST_DIR = "reference-implementation/test";
const PRECONDITION_FAILED_PATTERN = /precondition failed/;
const ONE_FILE_CHANGED_PATTERN = /1 file changed/;
const ZERO_INSERTIONS_DELETIONS_PATTERN = /0 insertions?\(\+\), 0 deletions?\(-\)/;
const SERVER_DIR = "reference-implementation/server";

test("stageAPrecheck is clean for a well-formed rename batch", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit(
      [
        { path: `${SERVER_DIR}/widget.js`, content: "export const widget = 1;\n" },
        {
          path: `${TEST_DIR}/a.test.js`,
          content:
            "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { widget } from '../server/widget.js';\ntest('a', () => { assert.equal(widget, 1); });\n",
        },
      ],
      "before"
    );
    const report = stageAPrecheck([`${TEST_DIR}/a.test.js`], repo.dir);
    assert.equal(report.ok, true);
    assert.deepEqual(report.failures, []);
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("stageAPrecheck fails closed on an already-broken relative import (does not silently pass through a pre-existing defect)", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit(
      [{ path: `${TEST_DIR}/a.test.js`, content: "import { widget } from '../server/missing.js';\n" }],
      "before"
    );
    const report = stageAPrecheck([`${TEST_DIR}/a.test.js`], repo.dir);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((f) => f.kind === "import-resolution"));
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("stageAPrecheck fails closed on a stale literal path elsewhere in the tree referencing a file in THIS batch", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit(
      [
        { path: `${TEST_DIR}/a.test.js`, content: "test('a', () => {});\n" },
        {
          path: `${TEST_DIR}/boundary.test.js`,
          content: `readFileSync(${JSON.stringify(`${TEST_DIR}/a.test.js`)});\n`,
        },
      ],
      "before"
    );
    const report = stageAPrecheck([`${TEST_DIR}/a.test.js`], repo.dir);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((f) => f.kind === "literal-path" && f.file === `${TEST_DIR}/boundary.test.js`));
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("runStageA refuses to run (throws) when the precheck is not clean — never best-effort", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit(
      [{ path: `${TEST_DIR}/a.test.js`, content: "import { widget } from '../server/missing.js';\n" }],
      "before"
    );
    assert.throws(() => runStageA([`${TEST_DIR}/a.test.js`], repo.dir), PRECONDITION_FAILED_PATTERN);
    // And nothing was mutated: the file must still be a .js on disk.
    const status = repo.git(["status", "--porcelain"]).trim();
    assert.equal(status, "");
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("runStageA performs a byte-identical git mv (rename detected, zero content diff)", () => {
  const repo = createFixtureRepo();
  try {
    const content =
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('a', () => { assert.ok(true); });\n";
    repo.writeAndCommit([{ path: `${TEST_DIR}/a.test.js`, content }], "before");
    const result = runStageA([`${TEST_DIR}/a.test.js`], repo.dir);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]?.fromPath, `${TEST_DIR}/a.test.js`);
    assert.equal(result.files[0]?.toPath, `${TEST_DIR}/a.test.ts`);
    const rewritten = readFileSync(`${repo.dir}/${TEST_DIR}/a.test.ts`, "utf8");
    assert.equal(
      rewritten,
      content,
      "a file with no eligible catch-clause narrowing must be byte-identical after rename"
    );
    const diffStat = repo.git(["diff", "--cached", "--stat"]);
    assert.match(diffStat, ONE_FILE_CHANGED_PATTERN);
    assert.match(
      diffStat,
      ZERO_INSERTIONS_DELETIONS_PATTERN,
      "a pure rename with no narrowing must show exactly 0 insertions/deletions"
    );
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("runStageA applies catch-clause narrowing only where eligible, alongside the rename", () => {
  const repo = createFixtureRepo();
  try {
    const content = "try { x(); } catch (err) { log(err.message); }\n";
    repo.writeAndCommit([{ path: `${TEST_DIR}/a.test.js`, content }], "before");
    runStageA([`${TEST_DIR}/a.test.js`], repo.dir);
    const rewritten = readFileSync(`${repo.dir}/${TEST_DIR}/a.test.ts`, "utf8");
    assert.equal(rewritten, "try { x(); } catch (err) { log((err instanceof Error ? err.message : String(err))); }\n");
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("runStageA is rollback-clean: git reset --hard returns a byte-identical tree", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit([{ path: `${TEST_DIR}/a.test.js`, content: "test('a', () => {});\n" }], "before");
    const beforeCommit = repo.git(["rev-parse", "HEAD"]).trim();
    const beforeTree = repo.git(["rev-parse", `${beforeCommit}^{tree}`]).trim();
    runStageA([`${TEST_DIR}/a.test.js`], repo.dir);
    repo.git(["reset", "--hard", beforeCommit]);
    const afterTree = repo.git(["rev-parse", "HEAD^{tree}"]).trim();
    assert.equal(beforeTree, afterTree);
    assert.equal(repo.git(["status", "--porcelain"]).trim(), "");
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("stageAPrecheck on an unknown/nonexistent source path fails via the rename-map precondition, not a crash", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit([{ path: `${TEST_DIR}/a.test.js`, content: "test('a', () => {});\n" }], "before");
    const report = stageAPrecheck([`${TEST_DIR}/missing.test.js`], repo.dir);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((f) => f.kind === "rename-map"));
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("stageAPrecheck fails closed on a repo-wide importer-side edge: an importer OUTSIDE reference-implementation/test using a short relative specifier left stale", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit(
      [
        { path: `${SERVER_DIR}/helpers/widget.js`, content: "module.exports = { widget: 1 };\n" },
        {
          path: `${SERVER_DIR}/consumer.js`,
          content: "const { widget } = require('./helpers/widget.js');\nmodule.exports = { widget };\n",
        },
      ],
      "before"
    );
    // Rename ONLY the helper — its importer (consumer.js, which is not
    // itself being renamed, and lives outside reference-implementation/test)
    // still uses the pre-rename short relative specifier via require() — a
    // CJS consumer this authority gates conservatively (not proven to run
    // under the tsx loader; see importer-scan.ts's header). Neither the
    // existing import-resolution check (only checks the renamed file's OWN
    // outgoing imports) nor literal-path-scan (matches full repo-relative
    // path strings, not a short specifier like './helpers/widget.js') can
    // see this — this is the exact defect the lane exists to close.
    const report = stageAPrecheck([`${SERVER_DIR}/helpers/widget.js`], repo.dir);
    assert.equal(report.ok, false);
    assert.ok(
      report.failures.some((f) => f.kind === "importer-edge" && f.file === `${SERVER_DIR}/consumer.js`),
      `expected an importer-edge failure naming ${SERVER_DIR}/consumer.js, got: ${JSON.stringify(report.failures)}`
    );
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("stageAPrecheck is clean when the same importer is updated to the post-rename specifier (positive control for the importer-edge check)", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit(
      [
        { path: `${SERVER_DIR}/helpers/widget.js`, content: "module.exports = { widget: 1 };\n" },
        {
          path: `${SERVER_DIR}/consumer.js`,
          content: "const { widget } = require('./helpers/widget.ts');\nmodule.exports = { widget };\n",
        },
      ],
      "before"
    );
    const report = stageAPrecheck([`${SERVER_DIR}/helpers/widget.js`], repo.dir);
    assert.equal(report.ok, true);
    assert.deepEqual(report.failures, []);
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("stageAPrecheck's importer-edge scan does NOT fail a stale .js static-import specifier that resolves safely under the real tsx execution path (VALID, reported only as normalization debt)", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit(
      [
        { path: `${SERVER_DIR}/helpers/widget.js`, content: "export const widget = 1;\n" },
        {
          path: `${SERVER_DIR}/consumer.ts`,
          content: "import { widget } from './helpers/widget.js';\nexport { widget };\n",
        },
      ],
      "before"
    );
    const report = stageAPrecheck([`${SERVER_DIR}/helpers/widget.js`], repo.dir);
    assert.equal(report.ok, true, `expected VALID/no-failure, got: ${JSON.stringify(report.failures)}`);
    assert.ok(
      report.normalizeDebt.some((d) => d.file === `${SERVER_DIR}/consumer.ts`),
      `expected normalization debt naming ${SERVER_DIR}/consumer.ts, got: ${JSON.stringify(report.normalizeDebt)}`
    );
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("stageAPrecheck's literal-path scan now runs REPO-WIDE, not just under reference-implementation/test", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit(
      [
        { path: `${SERVER_DIR}/helpers/widget.js`, content: "export const widget = 1;\n" },
        {
          path: "scripts/spawn-consumer.js",
          content: `spawnSync('cat', [${JSON.stringify(`${SERVER_DIR}/helpers/widget.js`)}]);\n`,
        },
      ],
      "before"
    );
    const report = stageAPrecheck([`${SERVER_DIR}/helpers/widget.js`], repo.dir);
    assert.equal(report.ok, false);
    assert.ok(
      report.failures.some((f) => f.kind === "literal-path" && f.file === "scripts/spawn-consumer.js"),
      `expected a literal-path failure naming scripts/spawn-consumer.js, got: ${JSON.stringify(report.failures)}`
    );
  } finally {
    disposeFixtureRepo(repo);
  }
});

test("existing import-resolution and literal-path checks still fire on the cases they already caught (no weakening)", () => {
  const repo = createFixtureRepo();
  try {
    repo.writeAndCommit(
      [{ path: `${TEST_DIR}/a.test.js`, content: "import { widget } from '../server/missing.js';\n" }],
      "before"
    );
    const report = stageAPrecheck([`${TEST_DIR}/a.test.js`], repo.dir);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((f) => f.kind === "import-resolution"));
  } finally {
    disposeFixtureRepo(repo);
  }
});
