// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "@babel/parser";
import { walkBabelAst } from "./babel-ast-walk.ts";

test("visits the root node itself", () => {
  const ast = parse("const a = 1;", { sourceType: "module", plugins: ["typescript"] });
  const visitedTypes: string[] = [];
  walkBabelAst(ast.program, (node) => {
    visitedTypes.push(node.type as string);
  });
  assert.ok(visitedTypes.includes("Program"));
});

test("visits every descendant node", () => {
  const ast = parse("function f(a, b) { return a + b; }", { sourceType: "module", plugins: ["typescript"] });
  const visitedTypes: string[] = [];
  walkBabelAst(ast.program, (node) => {
    visitedTypes.push(node.type as string);
  });
  assert.ok(visitedTypes.includes("FunctionDeclaration"));
  assert.ok(visitedTypes.includes("BinaryExpression"));
  assert.ok(visitedTypes.includes("Identifier"));
  assert.ok(visitedTypes.includes("ReturnStatement"));
});

test("visits nodes inside array-valued properties (e.g. a block's statement list)", () => {
  const ast = parse("{ const a = 1; const b = 2; }", { sourceType: "module", plugins: ["typescript"] });
  let variableDeclarationCount = 0;
  walkBabelAst(ast.program, (node) => {
    if (node.type === "VariableDeclaration") {
      variableDeclarationCount += 1;
    }
  });
  assert.equal(variableDeclarationCount, 2);
});

test("does not recurse into non-object, non-array property values", () => {
  const ast = parse("const x = 'hello';", { sourceType: "module", plugins: ["typescript"] });
  // Should not throw walking into `value: "hello"` (a plain string property).
  assert.doesNotThrow(() => walkBabelAst(ast.program, () => undefined));
});

test("null and non-object inputs are a no-op, never throw", () => {
  assert.doesNotThrow(() => walkBabelAst(null, () => undefined));
  assert.doesNotThrow(() => walkBabelAst(42, () => undefined));
  assert.doesNotThrow(() => walkBabelAst("string", () => undefined));
});
