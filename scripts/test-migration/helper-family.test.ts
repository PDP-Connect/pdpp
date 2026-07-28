// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractFileHelperSurface, groupIntoFamilies } from "./helper-family.ts";

function withTempFile<T>(content: string, run: (absolutePath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-helper-family-test-"));
  const absolutePath = join(dir, "sample.test.js");
  writeFileSync(absolutePath, content, "utf8");
  try {
    return run(absolutePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WITH_SERVER_SOURCE = [
  "async function withServer(fn) {",
  "  return fn({ asUrl: 'x', rsUrl: 'y' });",
  "}",
  "",
  "test('a', async () => { await withServer(async ({ asUrl, rsUrl }) => { use(asUrl, rsUrl); }); });",
  "test('b', async () => { await withServer(async ({ asUrl, rsUrl }) => { use(asUrl, rsUrl); }); });",
  "",
].join("\n");

test("extractFileHelperSurface reports a local-helper cluster key matching Stage B's own shape encoding", () => {
  withTempFile(WITH_SERVER_SOURCE, (path) => {
    const surface = extractFileHelperSurface(path, "reference-implementation/test/sample.test.js");
    assert.equal(surface.unparseable, false);
    assert.deepEqual(surface.localHelperClusterKeys, ["withServer::destructured:asUrl,rsUrl"]);
    assert.equal(surface.localHelperClusterErrorMass, 4); // 2 call sites * 2 destructured names
    assert.equal(surface.importedHelperModules.length, 0);
  });
});

test("extractFileHelperSurface reports imported ./helpers/*.js module names, extension-stripped", () => {
  const source = [
    "import { withOperationBoundary } from './helpers/operation-boundary.js';",
    "import { anotherThing } from './helpers/temp-dir.js';",
    "test('a', () => { withOperationBoundary(); anotherThing(); });",
    "",
  ].join("\n");
  withTempFile(source, (path) => {
    const surface = extractFileHelperSurface(path, "reference-implementation/test/sample.test.js");
    assert.deepEqual(surface.importedHelperModules, ["operation-boundary", "temp-dir"]);
  });
});

test("extractFileHelperSurface recognizes require('./helpers/x.js') form, not just ESM import", () => {
  const source = ["const { thing } = require('./helpers/temp-dir.js');", "test('a', () => { thing(); });", ""].join(
    "\n"
  );
  withTempFile(source, (path) => {
    const surface = extractFileHelperSurface(path, "reference-implementation/test/sample.test.js");
    assert.deepEqual(surface.importedHelperModules, ["temp-dir"]);
  });
});

test("extractFileHelperSurface does not report an import from ../server/* as a helper module (production import, not shared test infra)", () => {
  const source = ["import { db } from '../server/db.js';", "test('a', () => { db(); });", ""].join("\n");
  withTempFile(source, (path) => {
    const surface = extractFileHelperSurface(path, "reference-implementation/test/sample.test.js");
    assert.deepEqual(surface.importedHelperModules, []);
  });
});

test("extractFileHelperSurface marks an unparseable file rather than throwing or silently dropping it", () => {
  withTempFile("this is not { valid javascript at ALL (((", (path) => {
    const surface = extractFileHelperSurface(path, "reference-implementation/test/sample.test.js");
    assert.equal(surface.unparseable, true);
    assert.deepEqual(surface.localHelperClusterKeys, []);
    assert.deepEqual(surface.importedHelperModules, []);
  });
});

test("extractFileHelperSurface on a nonexistent file reports unparseable rather than throwing", () => {
  const surface = extractFileHelperSurface("/nonexistent/path/does-not-exist.js", "reference-implementation/test/x.js");
  assert.equal(surface.unparseable, true);
});

test("groupIntoFamilies puts two files that declare the SAME local-helper shape (independently, no import between them) in one family", () => {
  const a = extractFileHelperSurfaceFromSource(WITH_SERVER_SOURCE, "reference-implementation/test/a.test.js");
  const b = extractFileHelperSurfaceFromSource(WITH_SERVER_SOURCE, "reference-implementation/test/b.test.js");
  const families = groupIntoFamilies([a, b]);
  assert.equal(families.length, 1);
  const [family] = families;
  assert.ok(family);
  assert.equal(family.kind, "local-helper");
  assert.equal(family.files.length, 2);
  assert.deepEqual(
    family.files.map((f) => f.file),
    ["reference-implementation/test/a.test.js", "reference-implementation/test/b.test.js"]
  );
});

test("groupIntoFamilies puts two files that import the SAME ./helpers/*.js module in one family, kind imported-module", () => {
  const source = ["import { x } from './helpers/operation-boundary.js';", "test('a', () => { x(); });", ""].join("\n");
  const a = extractFileHelperSurfaceFromSource(source, "reference-implementation/test/a.test.js");
  const b = extractFileHelperSurfaceFromSource(source, "reference-implementation/test/b.test.js");
  const families = groupIntoFamilies([a, b]);
  assert.equal(families.length, 1);
  const [family] = families;
  assert.ok(family);
  assert.equal(family.kind, "imported-module");
});

test("groupIntoFamilies leaves a file with no shared signal as its own singleton, kind ungrouped", () => {
  const source = ["test('a', () => { assert.ok(true); });", ""].join("\n");
  const a = extractFileHelperSurfaceFromSource(source, "reference-implementation/test/lonely.test.js");
  const families = groupIntoFamilies([a]);
  assert.equal(families.length, 1);
  const [family] = families;
  assert.ok(family);
  assert.equal(family.kind, "ungrouped");
  assert.equal(family.files.length, 1);
});

test("groupIntoFamilies transitively merges families: file A shares a local-helper key with B, B shares an imported-module key with C -> all three in one family", () => {
  const bothSignalsSource = ["import { x } from './helpers/operation-boundary.js';", WITH_SERVER_SOURCE].join("\n");
  const a = extractFileHelperSurfaceFromSource(WITH_SERVER_SOURCE, "reference-implementation/test/a.test.js");
  const b = extractFileHelperSurfaceFromSource(bothSignalsSource, "reference-implementation/test/b.test.js");
  const c = extractFileHelperSurfaceFromSource(
    "import { x } from './helpers/operation-boundary.js';\ntest('c', () => { x(); });\n",
    "reference-implementation/test/c.test.js"
  );
  const families = groupIntoFamilies([a, b, c]);
  assert.equal(families.length, 1);
  const [family] = families;
  assert.ok(family);
  assert.equal(family.files.length, 3);
});

test("groupIntoFamilies output covers every input file exactly once (no file dropped, none duplicated)", () => {
  const surfaces = [
    extractFileHelperSurfaceFromSource(WITH_SERVER_SOURCE, "reference-implementation/test/a.test.js"),
    extractFileHelperSurfaceFromSource("test('x', () => {});\n", "reference-implementation/test/b.test.js"),
    extractFileHelperSurfaceFromSource(WITH_SERVER_SOURCE, "reference-implementation/test/c.test.js"),
  ];
  const families = groupIntoFamilies(surfaces);
  const allFiles = families.flatMap((f) => f.files.map((s) => s.file)).sort();
  assert.deepEqual(allFiles, [
    "reference-implementation/test/a.test.js",
    "reference-implementation/test/b.test.js",
    "reference-implementation/test/c.test.js",
  ]);
});

test("groupIntoFamilies sorts families by descending file count", () => {
  const shared = WITH_SERVER_SOURCE;
  const surfaces = [
    extractFileHelperSurfaceFromSource(shared, "reference-implementation/test/a.test.js"),
    extractFileHelperSurfaceFromSource(shared, "reference-implementation/test/b.test.js"),
    extractFileHelperSurfaceFromSource(shared, "reference-implementation/test/c.test.js"),
    extractFileHelperSurfaceFromSource("test('x', () => {});\n", "reference-implementation/test/singleton.test.js"),
  ];
  const families = groupIntoFamilies(surfaces);
  assert.equal(families.length, 2);
  const [first, second] = families;
  assert.ok(first && second);
  assert.equal(first.files.length, 3);
  assert.equal(second.files.length, 1);
});

/** Test-only convenience: extractFileHelperSurface without touching disk, by writing to a throwaway temp file. */
function extractFileHelperSurfaceFromSource(source: string, repoRelativePath: string) {
  return withTempFile(source, (path) => extractFileHelperSurface(path, repoRelativePath));
}
