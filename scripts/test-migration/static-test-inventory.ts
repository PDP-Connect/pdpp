// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Static, AST-based inventory of `node:test` call sites in a single test
 * file. This is the primitive the equivalence oracle (equivalence-oracle.ts)
 * builds on: it never executes a test file, it only counts what the source
 * text declares — the same cost profile the packet expects a codemod
 * pipeline to have across a 740-file tranche (fast, no PostgreSQL, no
 * Docker).
 *
 * Parses with @babel/parser (already resolved at a single pinned version,
 * 7.29.2, in this workspace's lockfile as a transitive dependency of
 * several existing tools) rather than a regex scan, so a string literal
 * inside a comment or an unrelated helper function named `test` cannot
 * produce a false match. We deliberately do NOT depend on @babel/types —
 * only the narrow node shapes actually touched are declared locally below,
 * to avoid adding a second dependency for type declarations alone.
 *
 * Deliberately conservative: any `skip` expression that is not a literal
 * `true`/`false` is classified `"skipped-dynamic"` rather than guessed, and
 * a changed dynamic-skip EXPRESSION TEXT (not its runtime value, which this
 * static tool cannot observe) still counts as a change the oracle must
 * flag. This trades false positives (a dynamic skip whose text changed but
 * whose runtime behavior is identical) for zero false negatives — the
 * oracle's job is to never silently pass a real regression.
 */

import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { walkBabelAst } from "./babel-ast-walk.ts";

export type SkipState =
  | { kind: "not-skipped" }
  | { kind: "skipped-literal" }
  | { kind: "skipped-dynamic"; expressionText: string };

export interface TestCallSite {
  /** 1-based line number of the call, for human-readable diagnostics. */
  line: number;
  name: string;
  skip: SkipState;
}

export interface StaticTestInventory {
  /** Every `test(...)`/`it(...)`/`test.skip(...)`/`it.skip(...)` call site found. */
  callSites: TestCallSite[];
  /** True if the file imports/requires `node:test`, or has at least one call site. */
  isNodeTestFile: boolean;
}

// Minimal local shapes for the @babel/parser AST nodes this module touches.
// (@babel/types is not a direct dependency; see file header.)
interface BabelNodeBase {
  end: number;
  loc: { start: { line: number } };
  start: number;
  type: string;
}
interface BabelIdentifier extends BabelNodeBase {
  name: string;
  type: "Identifier";
}
interface BabelStringLiteral extends BabelNodeBase {
  type: "StringLiteral";
  value: string;
}
interface BabelTemplateLiteral extends BabelNodeBase {
  expressions: unknown[];
  quasis: { value: { cooked: string } }[];
  type: "TemplateLiteral";
}
interface BabelBooleanLiteral extends BabelNodeBase {
  type: "BooleanLiteral";
  value: boolean;
}
interface BabelUnaryExpression extends BabelNodeBase {
  argument: BabelExpression;
  operator: string;
  type: "UnaryExpression";
}
interface BabelObjectProperty extends BabelNodeBase {
  key: BabelExpression;
  type: "ObjectProperty";
  value: BabelExpression;
}
interface BabelObjectExpression extends BabelNodeBase {
  properties: (BabelObjectProperty | BabelNodeBase)[];
  type: "ObjectExpression";
}
interface BabelMemberExpression extends BabelNodeBase {
  computed: boolean;
  object: BabelExpression;
  property: BabelExpression;
  type: "MemberExpression";
}
interface BabelCallExpression extends BabelNodeBase {
  arguments: BabelExpression[];
  callee: BabelExpression;
  type: "CallExpression";
}
interface BabelImportDeclaration extends BabelNodeBase {
  source: BabelStringLiteral;
  type: "ImportDeclaration";
}
type BabelExpression =
  | BabelCallExpression
  | BabelIdentifier
  | BabelMemberExpression
  | BabelObjectExpression
  | BabelObjectProperty
  | BabelStringLiteral
  | BabelTemplateLiteral
  | BabelBooleanLiteral
  | BabelUnaryExpression
  | BabelNodeBase;

const TEST_FUNCTION_NAMES = new Set(["test", "it"]);

function isIdentifier(node: BabelNodeBase): node is BabelIdentifier {
  return node.type === "Identifier";
}
function isMemberExpression(node: BabelNodeBase): node is BabelMemberExpression {
  return node.type === "MemberExpression";
}
function isCallExpression(node: BabelNodeBase): node is BabelCallExpression {
  return node.type === "CallExpression";
}
function isObjectExpression(node: BabelNodeBase): node is BabelObjectExpression {
  return node.type === "ObjectExpression";
}
function isObjectProperty(node: BabelNodeBase): node is BabelObjectProperty {
  return node.type === "ObjectProperty";
}

function stringLiteralValue(node: BabelExpression | undefined): string | undefined {
  if (node?.type === "StringLiteral") {
    return (node as BabelStringLiteral).value;
  }
  if (node?.type === "TemplateLiteral") {
    const template = node as BabelTemplateLiteral;
    if (template.expressions.length === 0 && template.quasis.length === 1) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: tsconfig's noUncheckedIndexedAccess (which Biome's analysis does not model) makes quasis[0] possibly undefined at the type level even though the length check above guarantees it at runtime.
      return template.quasis[0]?.value.cooked;
    }
  }
  // biome-ignore lint/complexity/noUselessUndefined: Explicit undefined is required by noImplicitReturns and documents the "not a resolvable string literal" absent-result contract.
  return undefined;
}

/** `test.skip(...)` / `it.skip(...)` shorthand. */
function isSkipShorthandCallee(callee: BabelExpression): callee is BabelMemberExpression {
  return (
    isMemberExpression(callee) &&
    !callee.computed &&
    isIdentifier(callee.object) &&
    TEST_FUNCTION_NAMES.has(callee.object.name) &&
    isIdentifier(callee.property) &&
    callee.property.name === "skip"
  );
}
function calledTestFunctionName(callee: BabelExpression): string | undefined {
  if (isIdentifier(callee) && TEST_FUNCTION_NAMES.has(callee.name)) {
    return callee.name;
  }
  if (isSkipShorthandCallee(callee) && isIdentifier(callee.object)) {
    return callee.object.name;
  }
  // biome-ignore lint/complexity/noUselessUndefined: Explicit undefined is required by noImplicitReturns and documents the "not a test/it call" absent-result contract.
  return undefined;
}

function exprSourceText(node: BabelNodeBase, sourceText: string): string {
  return sourceText.slice(node.start, node.end);
}

function skipStateFromOptionsArgument(argument: BabelExpression | undefined, sourceText: string): SkipState {
  if (!(argument && isObjectExpression(argument))) {
    return { kind: "not-skipped" };
  }
  for (const property of argument.properties) {
    if (!isObjectProperty(property)) {
      continue;
    }
    const { key, value } = property;
    const keyName = isIdentifier(key) ? key.name : stringLiteralValue(key);
    if (keyName !== "skip") {
      continue;
    }
    if (value.type === "BooleanLiteral") {
      return (value as BabelBooleanLiteral).value ? { kind: "skipped-literal" } : { kind: "not-skipped" };
    }
    return { kind: "skipped-dynamic", expressionText: exprSourceText(value, sourceText) };
  }
  return { kind: "not-skipped" };
}

/** True for `import ... from 'node:test'` and `require('node:test')`. */
function isNodeTestImport(typed: BabelNodeBase & Record<string, unknown>): boolean {
  if (typed.type === "ImportDeclaration") {
    return (typed as unknown as BabelImportDeclaration).source.value === "node:test";
  }
  return (
    isCallExpression(typed) &&
    isIdentifier(typed.callee) &&
    typed.callee.name === "require" &&
    stringLiteralValue(typed.arguments[0]) === "node:test"
  );
}

/** Builds a TestCallSite for a `test(...)`/`it(...)` call node, or undefined if this node isn't one. */
function testCallSiteFor(typed: BabelNodeBase & Record<string, unknown>, sourceText: string): TestCallSite | undefined {
  const functionName = isCallExpression(typed) ? calledTestFunctionName(typed.callee) : undefined;
  if (!(functionName && isCallExpression(typed))) {
    // biome-ignore lint/complexity/noUselessUndefined: Explicit undefined is required by noImplicitReturns and documents the "not a test/it call site" absent-result contract.
    return undefined;
  }
  const name = stringLiteralValue(typed.arguments[0]) ?? `<dynamic name at line ${typed.loc.start.line}>`;
  const skip = isSkipShorthandCallee(typed.callee)
    ? ({ kind: "skipped-literal" } as const)
    : skipStateFromOptionsArgument(typed.arguments[1], sourceText);
  return { name, line: typed.loc.start.line, skip };
}

/**
 * Parses a test file's source text and extracts every `test(...)`/`it(...)`
 * (and `.skip` shorthand) call site.
 */
export function staticTestInventory(sourceText: string, fileName: string): StaticTestInventory {
  const ast = parse(sourceText, {
    sourceType: "module",
    plugins: ["typescript"],
    sourceFilename: fileName,
    errorRecovery: false,
  });
  const callSites: TestCallSite[] = [];
  let sawTestImport = false;

  walkBabelAst(ast.program, (node) => {
    const typed = node as BabelNodeBase & Record<string, unknown>;
    if (isNodeTestImport(typed)) {
      sawTestImport = true;
    }
    const callSite = testCallSiteFor(typed, sourceText);
    if (callSite) {
      callSites.push(callSite);
    }
  });
  return { callSites, isNodeTestFile: sawTestImport || callSites.length > 0 };
}

export function staticTestInventoryForFile(absolutePath: string): StaticTestInventory {
  return staticTestInventory(readFileSync(absolutePath, "utf8"), absolutePath);
}
