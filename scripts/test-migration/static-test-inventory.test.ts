// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { staticTestInventory } from "./static-test-inventory.ts";

const DYNAMIC_NAME_PLACEHOLDER_PATTERN = /^<dynamic name at line \d+>$/;

test("finds a plain test() call with no skip", () => {
  const inv = staticTestInventory("import test from 'node:test';\ntest('a', () => {});\n", "f.ts");
  assert.equal(inv.isNodeTestFile, true);
  assert.equal(inv.callSites.length, 1);
  assert.deepEqual(inv.callSites[0]?.skip, { kind: "not-skipped" });
  assert.equal(inv.callSites[0]?.name, "a");
});

test("finds it() calls too", () => {
  const inv = staticTestInventory("import { it } from 'node:test';\nit('b', () => {});\n", "f.ts");
  assert.equal(inv.callSites.length, 1);
  assert.equal(inv.callSites[0]?.name, "b");
});

test("classifies { skip: true } as skipped-literal", () => {
  const inv = staticTestInventory("test('a', { skip: true }, () => {});\n", "f.ts");
  assert.deepEqual(inv.callSites[0]?.skip, { kind: "skipped-literal" });
});

test("classifies { skip: false } as not-skipped", () => {
  const inv = staticTestInventory("test('a', { skip: false }, () => {});\n", "f.ts");
  assert.deepEqual(inv.callSites[0]?.skip, { kind: "not-skipped" });
});

test("classifies test.skip(...) shorthand as skipped-literal", () => {
  const inv = staticTestInventory("test.skip('a', () => {});\n", "f.ts");
  assert.equal(inv.callSites.length, 1);
  assert.deepEqual(inv.callSites[0]?.skip, { kind: "skipped-literal" });
});

test("classifies a dynamic skip expression by its exact source text", () => {
  const inv = staticTestInventory("test('a', { skip: !process.env.X }, () => {});\n", "f.ts");
  assert.deepEqual(inv.callSites[0]?.skip, { kind: "skipped-dynamic", expressionText: "!process.env.X" });
});

test("a dynamic skip expression that changes text is a distinct skip state", () => {
  const before = staticTestInventory("test('a', { skip: !process.env.X }, () => {});\n", "f.ts");
  const after = staticTestInventory("test('a', { skip: !process.env.Y }, () => {});\n", "f.ts");
  assert.notDeepEqual(before.callSites[0]?.skip, after.callSites[0]?.skip);
});

test("a helper function named test/it that is not from node:test is still counted (conservative: never silently drop a call site)", () => {
  // This tool intentionally does not attempt scope resolution — a local
  // function literally named `test` would be indistinguishable from
  // node:test's `test` without a full type checker. Being conservative
  // (counting it) is the safe failure direction: it can only ever make the
  // oracle MORE cautious (never silently miss a real removed test), never
  // less.
  const inv = staticTestInventory("function test(name, fn) { return fn(); }\ntest('x', () => {});\n", "f.ts");
  assert.equal(inv.callSites.length, 1);
});

test("isNodeTestFile is true even with zero call sites when node:test is imported (dynamic-registration conformance file shape)", () => {
  const inv = staticTestInventory(
    "import test from 'node:test';\nimport { run } from './helper.js';\nrun({ test });\n",
    "f.ts"
  );
  assert.equal(inv.isNodeTestFile, true);
  assert.equal(inv.callSites.length, 0);
});

test("isNodeTestFile is false for a file with no node:test import and no test/it calls", () => {
  const inv = staticTestInventory("export function widget() { return 1; }\n", "f.ts");
  assert.equal(inv.isNodeTestFile, false);
  assert.equal(inv.callSites.length, 0);
});

test("a dynamic (non-literal) test name is reported with a synthesized placeholder, never dropped", () => {
  const inv = staticTestInventory("const name = 'x';\ntest(name, () => {});\n", "f.ts");
  assert.equal(inv.callSites.length, 1);
  assert.match(inv.callSites[0]?.name as string, DYNAMIC_NAME_PLACEHOLDER_PATTERN);
});

test("does not false-match a string literal that merely CONTAINS the word test", () => {
  const inv = staticTestInventory("const s = 'this is not a test call';\n", "f.ts");
  assert.equal(inv.callSites.length, 0);
});

test("parses real TypeScript syntax (types, generics, decorators-free) without error", () => {
  const src = [
    "import test from 'node:test';",
    "interface Foo { x: number }",
    "function make<T>(v: T): T { return v; }",
    "test('typed', () => { const f: Foo = { x: make(1) }; });",
    "",
  ].join("\n");
  const inv = staticTestInventory(src, "f.ts");
  assert.equal(inv.callSites.length, 1);
});
