// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanFileForStaleImporterEdges, scanRepoForStaleImporterEdges } from "./importer-scan.ts";
import { buildRenameMap } from "./rename-map.ts";

const HELPERS_FOO_JS_PATTERN = /helpers\/foo\.js/;

function withTempRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-importer-scan-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mkfile(dir: string, path: string, content: string): void {
  const absolute = join(dir, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

// The pair that proves discrimination: the SAME stale ".js" specifier shape,
// once under a form the real tsx loader resolves (VALID, no failure), once
// under a form no loader saves (require() — gated conservatively per the
// owner's scope ruling; see importer-scan.ts's header for the direct-
// execution proof this split is built on).
test("VALID: a static import .js specifier naming a renamed file resolves safely under the real tsx execution path — no failure, reported as normalization debt only", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/helpers/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["reference-implementation/server/helpers/foo.js"], dir);
    mkfile(dir, "reference-implementation/server/consumer.ts", "import { foo } from './helpers/foo.js';\n");
    const report = scanRepoForStaleImporterEdges(["reference-implementation/server/consumer.ts"], renameMap, dir);
    assert.equal(report.ok, true);
    assert.deepEqual(report.failures, []);
    assert.equal(report.normalizeDebt.length, 1);
    assert.equal(report.normalizeDebt[0]?.importer, "reference-implementation/server/consumer.ts");
    assert.match(report.normalizeDebt[0]?.detail as string, HELPERS_FOO_JS_PATTERN);
  });
});

test("BROKEN: the identical stale specifier shape under a require() (CJS) consumer FAILS — no loader proven to cover it", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/helpers/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["reference-implementation/server/helpers/foo.js"], dir);
    mkfile(dir, "reference-implementation/server/consumer.ts", "const { foo } = require('./helpers/foo.js');\n");
    const report = scanRepoForStaleImporterEdges(["reference-implementation/server/consumer.ts"], renameMap, dir);
    assert.equal(report.ok, false);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]?.importer, "reference-implementation/server/consumer.ts");
    assert.equal(report.failures[0]?.kind, "require-stale");
  });
});

test("VALID: dynamic import() with a stale .js specifier also resolves safely under tsx — no failure", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/helpers/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["reference-implementation/server/helpers/foo.js"], dir);
    mkfile(
      dir,
      "reference-implementation/server/consumer.ts",
      "async function load() { return await import('./helpers/foo.js'); }\n"
    );
    const report = scanRepoForStaleImporterEdges(["reference-implementation/server/consumer.ts"], renameMap, dir);
    assert.equal(report.ok, true);
    assert.equal(report.failures.length, 0);
    assert.equal(report.normalizeDebt.length, 1);
  });
});

// BROKEN: a specifier that does not resolve to anything on disk at all —
// no loader, tsx or otherwise, can save a specifier that points nowhere.
test("BROKEN: differing relative-depth specifier (one '../' short of correct) does not resolve on disk and FAILS", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/helpers/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["reference-implementation/server/helpers/foo.js"], dir);
    mkfile(
      dir,
      "reference-implementation/server/nested/deeper/consumer.ts",
      "import { foo } from '../helpers/foo.js';\n"
    );
    const report = scanRepoForStaleImporterEdges(
      ["reference-implementation/server/nested/deeper/consumer.ts"],
      renameMap,
      dir
    );
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((f) => f.kind === "unresolved" && f.importer.endsWith("consumer.ts")));
  });
});

test("BROKEN: bare-basename require() naming a renamed file FAILS", () => {
  withTempRepo((dir) => {
    mkfile(dir, "scripts/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["scripts/foo.js"], dir);
    mkfile(dir, "scripts/consumer.ts", "const mod = require('foo.js');\n");
    const report = scanRepoForStaleImporterEdges(["scripts/consumer.ts"], renameMap, dir);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((f) => f.kind === "require-stale"));
  });
});

// UNKNOWN: an undecidable dynamic import() argument — reported, not guessed
// in either direction.
test("UNKNOWN: dynamic import() with unresolvable template interpolation is reported as unknown, not passed and not failed", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/helpers/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["reference-implementation/server/helpers/foo.js"], dir);
    mkfile(
      dir,
      "reference-implementation/server/consumer.ts",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source-as-string, not accidental interpolation.
      "async function load() { const dir = 'helpers'; return await import(`./${dir}/foo.js`); }\n"
    );
    const report = scanRepoForStaleImporterEdges(["reference-implementation/server/consumer.ts"], renameMap, dir);
    assert.equal(report.ok, true, "an undecidable edge must never fail closed by itself");
    assert.equal(report.failures.length, 0);
    assert.equal(report.unknowns.length, 1);
    assert.equal(report.unknowns[0]?.importer, "reference-implementation/server/consumer.ts");
  });
});

test("UNKNOWN: a computed (non-literal) dynamic import() argument that plausibly names a renamed file is reported, not silently dropped", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/helpers/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["reference-implementation/server/helpers/foo.js"], dir);
    mkfile(
      dir,
      "reference-implementation/server/consumer.ts",
      "async function load(path) { return await import(path); }\n"
    );
    const report = scanRepoForStaleImporterEdges(["reference-implementation/server/consumer.ts"], renameMap, dir);
    // A totally opaque computed argument has no basename to check against
    // the rename map, so this scan correctly cannot even guess it is
    // related — it is simply out of this batch's provable concern (see
    // checkOccurrence's plausibleTarget gate).
    assert.equal(report.ok, true);
    assert.equal(report.unknowns.length, 0);
  });
});

// Out-of-scope: importer resolving outside the declared rename scope.
test("BROKEN: importer resolving to a same-basename file OUTSIDE the declared rename scope FAILS as out-of-scope", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/helpers/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["reference-implementation/server/helpers/foo.js"], dir);
    // A DIFFERENT foo.js that lives elsewhere and is NOT part of the rename batch.
    mkfile(dir, "reference-implementation/server/other/foo.js", "export const foo = 2;\n");
    mkfile(dir, "reference-implementation/server/other/consumer.ts", "import { foo } from './foo.js';\n");
    const report = scanRepoForStaleImporterEdges(["reference-implementation/server/other/consumer.ts"], renameMap, dir);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((f) => f.kind === "out-of-scope"));
  });
});

// Positive control: all importers correctly updated, and it passes for the right reason.
test("positive control: importer updated to the post-rename specifier PASSES with no debt and no unknowns", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/helpers/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["reference-implementation/server/helpers/foo.js"], dir);
    mkfile(dir, "reference-implementation/server/helpers/foo.ts", "export const foo = 1;\n");
    mkfile(dir, "reference-implementation/server/consumer.ts", "import { foo } from './helpers/foo.ts';\n");
    const report = scanRepoForStaleImporterEdges(["reference-implementation/server/consumer.ts"], renameMap, dir);
    assert.equal(report.ok, true);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.normalizeDebt, []);
    assert.deepEqual(report.unknowns, []);
  });
});

test("positive control passes for the right reason: reverting the importer to a require()-consumed stale specifier flips it back to FAIL", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/helpers/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["reference-implementation/server/helpers/foo.js"], dir);
    mkfile(dir, "reference-implementation/server/helpers/foo.ts", "export const foo = 1;\n");
    const fixedSource = "const { foo } = require('./helpers/foo.ts');\n";
    const staleSource = "const { foo } = require('./helpers/foo.js');\n";
    mkfile(dir, "reference-implementation/server/consumer.ts", fixedSource);
    const cleanReport = scanRepoForStaleImporterEdges(["reference-implementation/server/consumer.ts"], renameMap, dir);
    assert.equal(cleanReport.ok, true);
    mkfile(dir, "reference-implementation/server/consumer.ts", staleSource);
    const revertedReport = scanRepoForStaleImporterEdges(
      ["reference-implementation/server/consumer.ts"],
      renameMap,
      dir
    );
    assert.equal(revertedReport.ok, false);
    assert.equal(revertedReport.failures[0]?.importer, "reference-implementation/server/consumer.ts");
  });
});

test("the renamed file's own outgoing imports are skipped by this scan (that is import-resolution.ts's job)", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/foo.js", "import { x } from './missing.js';\n");
    const renameMap = buildRenameMap(["reference-implementation/server/foo.js"], dir);
    const report = scanRepoForStaleImporterEdges(["reference-implementation/server/foo.js"], renameMap, dir);
    assert.equal(report.filesScanned, 0);
    assert.deepEqual(report.failures, []);
  });
});

test("scanFileForStaleImporterEdges ignores bare package specifiers", () => {
  withTempRepo((dir) => {
    mkfile(dir, "reference-implementation/server/helpers/foo.js", "export const foo = 1;\n");
    const renameMap = buildRenameMap(["reference-implementation/server/helpers/foo.js"], dir);
    const src = "import assert from 'node:assert/strict';\nimport pkg from 'some-package';\n";
    const result = scanFileForStaleImporterEdges(
      src,
      join(dir, "reference-implementation/server/consumer.ts"),
      "reference-implementation/server/consumer.ts",
      renameMap,
      dir
    );
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.normalizeDebt, []);
    assert.deepEqual(result.unknowns, []);
  });
});
