// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Detects whether a connector's code transitively touches the reference
 * browser runtime, for `browser-manifest-honesty.test.ts`'s manifest
 * cross-check.
 *
 * This is deliberately NOT a single-file source-text regex. A prior version
 * of this check scanned only `connectors/<name>/index.ts`'s raw text against
 * two hand-tuned patterns (`/\bbrowser\s*:\s*\{/u` for `runConnector`'s
 * config, `/\bacquireBrowserForConnector\b/u` for scoped acquisition). Both
 * were defeated by realistic, non-adversarial authoring patterns a future
 * connector maintainer could hit without any intent to evade the guard:
 *   - A browser-acquisition helper factored into a separate module (e.g.
 *     `browser-helper.ts`) and imported into `index.ts` under any local
 *     name — the literal string `acquireBrowserForConnector` never appears
 *     in `index.ts` itself, so a single-file scan misses it entirely.
 *   - `runConnector({ browser: someConfigVariable })` where the browser
 *     config is built as a variable rather than an inline object literal —
 *     a regex requiring a literal `{` after the `browser:` colon misses it.
 *
 * The fix here is systemic on two axes:
 *   1. TRANSITIVE: follows every relative import reachable from
 *      `connectors/<name>/index.ts` (via `relativeRuntimeImportSpecifiers`,
 *      the same real-parser import-graph primitive
 *      `scripts/test-migration/import-resolution.ts` already uses for
 *      rename-safety verification) and scans the whole reachable module set,
 *      not just the entry file. A helper module anywhere in that closure is
 *      caught regardless of how many hops of re-export/import it sits behind.
 *   2. STRUCTURAL: uses `@babel/parser` to build a real AST and matches on
 *      NODE SHAPE — a `CallExpression` whose callee is the identifier
 *      `runConnector` with an argument `ObjectExpression` containing an
 *      `ObjectProperty` keyed `browser` (any value: object literal,
 *      identifier, spread-sourced, doesn't matter — the KEY existing is
 *      what declares intent to pass browser config), or any reference to
 *      the imported binding `acquireBrowserForConnector` regardless of
 *      import alias. This is immune to whitespace/comment formatting and to
 *      whether the value is a literal or a variable, because it never looks
 *      at the value's syntax at all — only whether the property key is
 *      present.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "@babel/parser";

const AST_SKIPPED_KEYS = new Set(["loc", "start", "end", "type"]);

/**
 * Generic recursive-descent walker over a @babel/parser AST — visits `node`
 * and every descendant reachable through its own properties. Kept local to
 * this package (mirrors `scripts/test-migration/babel-ast-walk.ts`'s
 * primitive rather than importing across the package boundary) so this
 * module has no dependency on the repo-root migration tooling directory.
 */
function walkBabelAst(node: unknown, onNode: (node: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  const typed = node as Record<string, unknown>;
  onNode(typed);
  for (const key of Object.keys(typed)) {
    if (AST_SKIPPED_KEYS.has(key)) {
      continue;
    }
    const value = typed[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        walkBabelAst(item, onNode);
      }
    } else if (value && typeof value === "object") {
      walkBabelAst(value, onNode);
    }
  }
}

const RELATIVE_SPECIFIER_PATTERN = /^\.\.?\//;
const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
const ACQUIRE_BROWSER_FOR_CONNECTOR_NAME = "acquireBrowserForConnector";
const RUN_CONNECTOR_NAME = "runConnector";
const BROWSER_PROPERTY_KEY = "browser";

interface BabelNodeWithLoc extends Record<string, unknown> {
  type: string;
}

/**
 * Returns `ast.program` untyped (matching `scripts/test-migration/
 * import-resolution.ts`'s own `walkBabelAst(ast.program, ...)` call — it
 * passes the same value with no cast at all, because `walkBabelAst`'s first
 * parameter is `unknown` by design). `@babel/parser`'s real `Program` type
 * is a specific tagged union with literal/known-shape fields, not a
 * `Record<string, unknown>` index signature, so there is no honest single
 * cast from it to this module's generic-traversal node shape; every
 * individual node this module actually inspects is cast to
 * `BabelNodeWithLoc` once, inside `walkBabelAst`'s callback, where the
 * runtime shape is genuinely being narrowed at the point of use.
 */
function parseModule(sourceText: string, fileName: string): unknown {
  const ast = parse(sourceText, { sourceType: "module", plugins: ["typescript"], sourceFilename: fileName });
  return ast.program;
}

interface CallExpressionNode extends BabelNodeWithLoc {
  arguments?: Record<string, unknown>[];
  callee?: { name?: string; type?: string };
}

interface StringLiteralNode {
  type?: string;
  value?: string;
}

function importDeclarationSource(typed: BabelNodeWithLoc): StringLiteralNode | undefined {
  const isImportLike =
    typed.type === "ImportDeclaration" ||
    typed.type === "ExportNamedDeclaration" ||
    typed.type === "ExportAllDeclaration";
  return isImportLike ? (typed as { source?: StringLiteralNode }).source : undefined;
}

function requireCallArgument(typed: BabelNodeWithLoc): StringLiteralNode | undefined {
  if (typed.type !== "CallExpression") {
    return;
  }
  const { arguments: args, callee } = typed as CallExpressionNode;
  const isRequireCall = callee?.type === "Identifier" && callee.name === "require";
  const [firstArg] = args ?? [];
  return isRequireCall ? (firstArg as StringLiteralNode | undefined) : undefined;
}

function relativeSpecifierValue(node: StringLiteralNode | undefined): string | undefined {
  if (node?.type !== "StringLiteral" || typeof node.value !== "string") {
    return;
  }
  return RELATIVE_SPECIFIER_PATTERN.test(node.value) ? node.value : undefined;
}

/** Every relative import/re-export/require specifier's raw text, static or executable. */
function relativeSpecifiersIn(programNode: unknown): string[] {
  const found: string[] = [];
  walkBabelAst(programNode, (node) => {
    const typed = node as BabelNodeWithLoc;
    const specifier =
      relativeSpecifierValue(importDeclarationSource(typed)) ?? relativeSpecifierValue(requireCallArgument(typed));
    if (specifier) {
      found.push(specifier);
    }
  });
  return found;
}

function resolveOnDisk(specifier: string, baseAbsoluteFilePath: string): string | null {
  const baseUrl = pathToFileURL(baseAbsoluteFilePath);
  const candidates: string[] = [];
  if (extname(specifier)) {
    candidates.push(specifier);
  } else {
    for (const ext of RESOLVABLE_EXTENSIONS) {
      candidates.push(`${specifier}${ext}`);
    }
    for (const ext of RESOLVABLE_EXTENSIONS) {
      candidates.push(`${specifier}/index${ext}`);
    }
  }
  for (const candidate of candidates) {
    try {
      const resolved = fileURLToPath(new URL(candidate, baseUrl));
      if (existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // not a resolvable candidate; try the next one
    }
  }
  return null;
}

interface ObjectPropertyNode {
  computed?: boolean;
  key?: { name?: string; value?: string };
  type?: string;
}

/**
 * Axis 1: any reference to the imported binding `acquireBrowserForConnector`,
 * regardless of local alias — an `ImportSpecifier` node carries BOTH the
 * imported name (`imported`, stable across aliasing) and the local binding
 * name (`local`, what call sites actually use); matching on `imported`
 * catches `import { acquireBrowserForConnector as getBrowser } from "..."`
 * even though every call site in the file says `getBrowser(...)`.
 */
function isAcquireBrowserForConnectorImport(typed: BabelNodeWithLoc): boolean {
  if (typed.type !== "ImportSpecifier") {
    return false;
  }
  const { imported } = typed as { imported?: { name?: string; value?: string } };
  return (imported?.name ?? imported?.value) === ACQUIRE_BROWSER_FOR_CONNECTOR_NAME;
}

/**
 * Axis 2: `runConnector({ ..., browser: <anything> })` — matches on the
 * PROPERTY KEY existing in the call's argument object, never on the shape
 * of the value, so a variable-sourced config (`browser: cfgVar`), a spread
 * (`browser: { ...shared }`), or a computed reference all count identically
 * to an inline literal.
 */
function isRunConnectorBrowserConfigCall(typed: BabelNodeWithLoc): boolean {
  if (typed.type !== "CallExpression") {
    return false;
  }
  const { arguments: args, callee } = typed as CallExpressionNode;
  if (callee?.type !== "Identifier" || callee.name !== RUN_CONNECTOR_NAME) {
    return false;
  }
  const [configArg] = args ?? [];
  if (configArg?.type !== "ObjectExpression") {
    return false;
  }
  const { properties } = configArg as { properties?: ObjectPropertyNode[] };
  return (properties ?? []).some((prop) => {
    if (prop.type !== "ObjectProperty" || prop.computed) {
      return false;
    }
    return prop.key?.name === BROWSER_PROPERTY_KEY || prop.key?.value === BROWSER_PROPERTY_KEY;
  });
}

/**
 * True if `programNode` (a parsed module's AST) itself references the
 * browser runtime, checking BOTH detection axes described in the module
 * header. Local-file-only — callers combine this across the transitive
 * import closure via `connectorUsesBrowserRuntimeTransitively`.
 */
function moduleReferencesBrowserRuntime(programNode: unknown): boolean {
  let found = false;
  walkBabelAst(programNode, (node) => {
    if (found) {
      return;
    }
    const typed = node as BabelNodeWithLoc;
    if (isAcquireBrowserForConnectorImport(typed) || isRunConnectorBrowserConfigCall(typed)) {
      found = true;
    }
  });
  return found;
}

/**
 * True if `entryAbsolutePath` or ANY module reachable from it through
 * relative imports (recursively, cycle-safe) references the browser
 * runtime per `moduleReferencesBrowserRuntime`. This is what makes the
 * check immune to helper-module indirection: a connector's `index.ts` can
 * import a browser-acquisition helper from any depth of relative-import
 * chain and it is still found, because every file in the closure is
 * individually AST-scanned, not just the entry point.
 *
 * Bare/package specifiers (e.g. `../../src/browser-launch.ts` is relative
 * and followed; a hypothetical future `@pdpp/something` bare specifier
 * would not be) are out of scope — matching `relativeImportSpecifiers`'
 * documented scope in `import-resolution.ts`, since bare specifiers resolve
 * through node_modules/workspace mechanisms this checker does not
 * reproduce and connector-local helper modules are always relative imports
 * in this codebase's conventions.
 */
export function connectorUsesBrowserRuntimeTransitively(entryAbsolutePath: string): boolean {
  const visited = new Set<string>();
  const stack = [entryAbsolutePath];
  while (stack.length > 0) {
    const path = stack.pop();
    if (!path || visited.has(path) || !existsSync(path)) {
      continue;
    }
    visited.add(path);
    const source = readFileSync(path, "utf8");
    const programNode = parseModule(source, path);
    if (moduleReferencesBrowserRuntime(programNode)) {
      return true;
    }
    for (const specifier of relativeSpecifiersIn(programNode)) {
      const resolved = resolveOnDisk(specifier, path);
      if (resolved && !visited.has(resolved)) {
        stack.push(resolved);
      }
    }
  }
  return false;
}
