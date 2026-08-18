// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

// Import the TypeScript file directly - tsx will handle the transpilation.
const { bareImportSpecifiers, bareSpecifierPackageName } = await import("../scripts/validate-package.ts");

test("bareImportSpecifiers catches the exact defect: an undeclared @pdpp/reference-contract bare import", () => {
  const source = `import { canonicalTerminalRunCommitEnvelope } from "@pdpp/reference-contract/common";
import { COLLECTOR_PROTOCOL_HEADER } from "./collector-protocol.js";
`;
  assert.deepEqual([...bareImportSpecifiers(source)], ["@pdpp/reference-contract/common"]);
  assert.equal(bareSpecifierPackageName("@pdpp/reference-contract/common"), "@pdpp/reference-contract");
});

test("bareImportSpecifiers ignores relative and node: specifiers", () => {
  const source = `import { a } from "./local.js";
import fs from "node:fs";
import type { X } from "../other.js";
`;
  assert.deepEqual([...bareImportSpecifiers(source)], []);
});

test("bareImportSpecifiers catches export-from, dynamic import(), and require()", () => {
  const source = `export { foo } from "zod";
export * as ns from "@pdpp/read-core/records";
const dyn = await import("@pdpp/mcp-server");
const req = require("left-pad");
`;
  assert.deepEqual(
    [...bareImportSpecifiers(source)].sort(),
    ["@pdpp/mcp-server", "@pdpp/read-core/records", "left-pad", "zod"].sort()
  );
});

test("bareImportSpecifiers does not false-positive on 'import'/'export' appearing inside string literals or property access", () => {
  // This is the exact shape pdpp-local-collector.ts's own env-file parser
  // uses (`line.startsWith("export ")`) — a naive "contains the word import
  // or export" regex would misfire on this and treat `") ? line.slice("` as
  // a bare specifier.
  const source = `
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const importantNote = "this mentions import and export but is not a statement";
    function importThing() { return doImportSomething("not-a-specifier"); }
  `;
  assert.deepEqual([...bareImportSpecifiers(source)], []);
});

test("bareImportSpecifiers requires 'export' to have a trailing 'from \"…\"' (bare export \"x\" is not legal JS)", () => {
  const source = `export const REPRO_MARKER = 1;\n`;
  assert.deepEqual([...bareImportSpecifiers(source)], []);
});

test("bareSpecifierPackageName resolves scoped and unscoped package names from a subpath specifier", () => {
  assert.equal(bareSpecifierPackageName("zod"), "zod");
  assert.equal(bareSpecifierPackageName("zod/v4"), "zod");
  assert.equal(bareSpecifierPackageName("@pdpp/reference-contract"), "@pdpp/reference-contract");
  assert.equal(bareSpecifierPackageName("@pdpp/reference-contract/common"), "@pdpp/reference-contract");
});

test("bareImportSpecifiers recognizes the bare side-effect import form", () => {
  const source = `import "@pdpp/reference-contract/register";\n`;
  assert.deepEqual([...bareImportSpecifiers(source)], ["@pdpp/reference-contract/register"]);
});

test("bareImportSpecifiers only matches import/export at the start of a (possibly indented) line", () => {
  // A specifier-looking string appearing mid-expression (never a real static
  // import/export statement in tsc/esbuild output) must not be treated as one.
  const source = `const notAnImport = someCall(x, "import from \\"@pdpp/not-real\\"");\n`;
  assert.deepEqual([...bareImportSpecifiers(source)], []);
});
