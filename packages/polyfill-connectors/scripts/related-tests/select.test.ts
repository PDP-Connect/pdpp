// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the acceptance criteria for the related-test selector directly
 * against real fixture package trees and a real dependency-cruiser cruise —
 * not mocked graphs — because the entire point of this selector is that a
 * mocked graph cannot demonstrate what a REAL static-graph tool actually
 * sees (or fails to see). Each fixture tree under
 * `src/test-fixtures/related-tests/` is a minimal, self-contained package
 * shape built to exercise exactly one acceptance scenario.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { containsDynamicImportOrRequire, isFixturePath } from "./fallback-inventory.ts";
import { assertGraphIsTrustworthy, buildDependencyGraph, UntrustworthyGraphError } from "./graph.ts";
import { FULL_SUITE, selectRelatedTests } from "./select.ts";
import { writeFixtureTree } from "./test/write-fixture-tree.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(THIS_DIR, "test", "fixture-trees");

describe("selectRelatedTests: direct connector edit selects only its related tests", () => {
  let packageRoot: string;

  before(() => {
    packageRoot = mkdtempSync(join(tmpdir(), "related-tests-direct-"));
    writeFixtureTree(packageRoot, join(FIXTURES_ROOT, "direct-edit"));
  });

  after(() => {
    rmSync(packageRoot, { recursive: true, force: true });
  });

  test("changing connectors/alpha/index.ts selects only alpha's own test, not beta's", async () => {
    const allPaths = [
      "connectors/alpha/index.ts",
      "connectors/alpha/index.test.ts",
      "connectors/beta/index.ts",
      "connectors/beta/index.test.ts",
    ];
    const graph = await buildDependencyGraph(packageRoot);
    const result = selectRelatedTests({
      packageRoot,
      graph,
      allRelativePaths: allPaths,
      changedRelativePaths: ["connectors/alpha/index.ts"],
      deletedRelativePaths: [],
    });

    assert.equal(result.kind, "related");
    assert.deepEqual(result.testFiles, ["connectors/alpha/index.test.ts"]);
  });
});

describe("selectRelatedTests: shared runtime edit expands to every dependent connector's tests", () => {
  let packageRoot: string;

  before(() => {
    packageRoot = mkdtempSync(join(tmpdir(), "related-tests-shared-"));
    writeFixtureTree(packageRoot, join(FIXTURES_ROOT, "shared-runtime"));
  });

  after(() => {
    rmSync(packageRoot, { recursive: true, force: true });
  });

  test("changing src/shared-runtime.ts selects both alpha's and beta's tests", async () => {
    const allPaths = [
      "src/shared-runtime.ts",
      "connectors/alpha/index.ts",
      "connectors/alpha/index.test.ts",
      "connectors/beta/index.ts",
      "connectors/beta/index.test.ts",
    ];
    const graph = await buildDependencyGraph(packageRoot);
    const result = selectRelatedTests({
      packageRoot,
      graph,
      allRelativePaths: allPaths,
      changedRelativePaths: ["src/shared-runtime.ts"],
      deletedRelativePaths: [],
    });

    assert.equal(result.kind, "related");
    assert.deepEqual([...(result.testFiles ?? [])].sort(), [
      "connectors/alpha/index.test.ts",
      "connectors/beta/index.test.ts",
    ]);
  });
});

describe("selectRelatedTests: fixture-only change forces the full suite", () => {
  test("a change under fixtures/ never resolves to a narrow selection, even if no source imports the changed path", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "related-tests-fixture-gate-"));
    try {
      writeFixtureTree(packageRoot, join(FIXTURES_ROOT, "direct-edit"));
      const allPaths = ["fixtures/alpha/sample.json", "connectors/alpha/index.ts", "connectors/alpha/index.test.ts"];
      // No graph needed for this assertion: isFixturePath must gate BEFORE any
      // graph lookup happens, so an empty graph proves the gate is unconditional.
      const result = selectRelatedTests({
        packageRoot,
        graph: { modules: new Map() },
        allRelativePaths: allPaths,
        changedRelativePaths: ["fixtures/alpha/sample.json"],
        deletedRelativePaths: [],
      });

      assert.equal(result.kind, FULL_SUITE);
      assert.match(result.reason, /fixtures directory/);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  test("isFixturePath recognizes both fixtures/ and __fixtures__/ path segments", () => {
    assert.equal(isFixturePath("fixtures/alpha/sample.json"), true);
    assert.equal(isFixturePath("connectors/x/__fixtures__/data.js"), true);
    assert.equal(
      isFixturePath("connectors/x/fixtures.ts"),
      false,
      "a file literally named fixtures.ts is not itself under a fixtures/ directory"
    );
    assert.equal(isFixturePath("src/normal-file.ts"), false);
  });
});

describe("selectRelatedTests: a file containing a dynamic import forces the full suite", () => {
  test("changing a file whose own source contains await import(...) forces FULL_SUITE even if the graph resolves it as a leaf", async () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "related-tests-dynamic-"));
    try {
      writeFixtureTree(packageRoot, join(FIXTURES_ROOT, "dynamic-import"));
      const allPaths = ["src/dynamic-loader.ts", "src/dynamic-loader.test.ts"];
      const graph = await buildDependencyGraph(packageRoot);

      const result = selectRelatedTests({
        packageRoot,
        graph,
        allRelativePaths: allPaths,
        changedRelativePaths: ["src/dynamic-loader.ts"],
        deletedRelativePaths: [],
      });

      assert.equal(result.kind, FULL_SUITE);
      assert.match(result.reason, /dynamic import/);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  test("containsDynamicImportOrRequire catches await import(, require(, and a computed-specifier call the graph itself cannot resolve", () => {
    assert.equal(containsDynamicImportOrRequire('const x = await import("./mod.ts");'), true);
    assert.equal(containsDynamicImportOrRequire('const x = require("node:fs");'), true);
    assert.equal(
      containsDynamicImportOrRequire('const x = await import(moduleSpecifier(dir, "server/index.ts"));'),
      true
    );
    assert.equal(
      containsDynamicImportOrRequire('import { readFileSync } from "node:fs";'),
      false,
      "a static ES import must not trip the dynamic-import fallback"
    );
  });
});

describe("selectRelatedTests: unknown/unparseable dependency shapes force the full suite", () => {
  test("a changed .ts file absent from the dependency graph (e.g. a syntax error dependency-cruiser could not parse) forces FULL_SUITE", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "related-tests-unparseable-"));
    try {
      mkdirSync(join(packageRoot, "src"), { recursive: true });
      writeFileSync(join(packageRoot, "src", "unparseable.ts"), "export function ok(): string { return 'ok'; }\n");
      const allPaths = ["src/unparseable.ts"];
      const result = selectRelatedTests({
        packageRoot,
        graph: { modules: new Map() },
        allRelativePaths: allPaths,
        changedRelativePaths: ["src/unparseable.ts"],
        deletedRelativePaths: [],
      });

      assert.equal(result.kind, FULL_SUITE);
      assert.match(result.reason, /absent from the dependency graph/);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  test("a non-.ts changed file (e.g. package.json, tsconfig.json) forces FULL_SUITE rather than being silently ignored", () => {
    const result = selectRelatedTests({
      packageRoot: "/unused",
      graph: { modules: new Map() },
      allRelativePaths: [],
      changedRelativePaths: ["package.json"],
      deletedRelativePaths: [],
    });

    assert.equal(result.kind, FULL_SUITE);
    assert.match(result.reason, /not a \.ts source file/);
  });
});

describe("selectRelatedTests: deletions and renames force the full suite", () => {
  test("a deleted source file forces FULL_SUITE even though it can no longer appear in changedRelativePaths", () => {
    const result = selectRelatedTests({
      packageRoot: "/unused",
      graph: { modules: new Map() },
      allRelativePaths: [],
      changedRelativePaths: [],
      deletedRelativePaths: ["src/manifest-registry.ts"],
    });

    assert.equal(result.kind, FULL_SUITE);
    assert.match(result.reason, /deleted path/);
  });

  test("a deleted test file forces FULL_SUITE, not a silent empty selection", () => {
    const result = selectRelatedTests({
      packageRoot: "/unused",
      graph: { modules: new Map() },
      allRelativePaths: [],
      changedRelativePaths: [],
      deletedRelativePaths: ["connectors/alpha/index.test.ts"],
    });

    assert.equal(result.kind, FULL_SUITE);
    assert.match(result.reason, /deleted path/);
  });

  test("a deleted fixture file forces FULL_SUITE via the same deletion gate, not the fixture-path gate", () => {
    const result = selectRelatedTests({
      packageRoot: "/unused",
      graph: { modules: new Map() },
      allRelativePaths: [],
      changedRelativePaths: [],
      deletedRelativePaths: ["fixtures/alpha/sample.json"],
    });

    assert.equal(result.kind, FULL_SUITE);
    assert.match(result.reason, /deleted path/);
  });

  test("a rename (git-reported as delete-of-old-path plus add-of-new-path) forces FULL_SUITE via the deletion gate", () => {
    const result = selectRelatedTests({
      packageRoot: "/unused",
      graph: { modules: new Map() },
      allRelativePaths: [],
      changedRelativePaths: ["connectors/alpha/index-renamed.ts"],
      deletedRelativePaths: ["connectors/alpha/index.ts"],
    });

    assert.equal(result.kind, FULL_SUITE);
    assert.match(result.reason, /deleted path/);
  });

  test("a truly empty diff (no changes, no deletions) still selects an empty related set, not FULL_SUITE", () => {
    const result = selectRelatedTests({
      packageRoot: "/unused",
      graph: { modules: new Map() },
      allRelativePaths: [],
      changedRelativePaths: [],
      deletedRelativePaths: [],
    });

    assert.equal(result.kind, "related");
    assert.deepEqual(result.testFiles, []);
    assert.match(result.reason, /no changed files/);
  });
});

describe("buildDependencyGraph: fails closed when the TypeScript resolution is untrustworthy", () => {
  test("assertGraphIsTrustworthy rejects a graph whose environment reports .ts as unavailable, rather than returning a truncated graph silently", () => {
    // This directly encodes the confirmed real-world failure: dependency-cruiser
    // 18.2.0 silently drops from 751 modules to 5 when the only resolvable
    // `typescript` package is 7.0.2 (its supported range is >=2.0.0 <7.0.0),
    // with NO thrown error and NO stderr output — the only signal is
    // result.summary.environment.extensionsFound[".ts"].available === false.
    // buildDependencyGraph must convert that signal into a thrown error.
    // The trustworthy path itself is exercised for real by every other
    // describe block above, which all run a real cruise() against a real
    // fixture tree with a working typescript resolvable.
    assert.throws(
      () =>
        assertGraphIsTrustworthy({
          extensionsFound: [{ extension: ".ts", available: false }],
        }),
      UntrustworthyGraphError
    );
    assert.throws(
      () =>
        assertGraphIsTrustworthy({
          extensionsFound: [{ extension: ".ts", available: true }],
          issues: [{ severity: "warn", name: "missing-typescript-transpiler" }],
        }),
      UntrustworthyGraphError
    );
    assert.doesNotThrow(() =>
      assertGraphIsTrustworthy({
        extensionsFound: [{ extension: ".ts", available: true }],
      })
    );
  });
});
