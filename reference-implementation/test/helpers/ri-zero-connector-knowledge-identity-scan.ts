// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AST-based identity/dispatch scanner backing the zero-connector-knowledge
 * conformance guard's rules (1), (6), and (7).
 *
 * `ri-zero-connector-knowledge-scan.ts`'s original rules (1)/(6)/(7) were a
 * text-structural regex over string literals with a short "is this near an
 * identity-shaped identifier" context window. That trade was disclosed as
 * correct for rules (3)/(4) (URL hosts, env-var names — nearly always
 * standalone literals with no meaningful indirection shape), but for
 * connector-identity/kind comparisons and connector-module imports it misses
 * ordinary indirection a real author writes without any intent to evade:
 *
 *   const kind = manifest.setup.manual_or_upload.validation.kind;
 *   if (kind === "whatsapp_chat_export") { ... }        // literal one hop away
 *
 *   const KNOWN = ["gmail", "slack"];
 *   if (KNOWN.includes(connectorId)) { ... }             // membership, not ===
 *
 *   switch (canonicalKey) { case "codex": ... }          // switch, not if/===
 *
 *   const path = `../connectors/${name}/validation.ts`;  // template composition
 *   await import(path);                                  // dynamic, not static
 *
 *   export { validateX } from "../connectors/whatsapp/validation.ts";  // re-export
 *
 *   import whatsappManifest from "../manifests/whatsapp.json" with { type: "json" };
 *   if (kind === whatsappManifest.setup.manual_or_upload.validation.kind) { ... }
 *
 * None of these contain a bare string literal sitting directly next to an
 * identity-shaped identifier the way the regex's context window expects —
 * each is a form of value flow or a specifier shape the regex never looked
 * at. This module parses with `@babel/parser` (the same real-AST dependency
 * `ri-zero-connector-knowledge-data-load-scan.ts` already uses for rule (5))
 * and:
 *
 *   1. Resolves string-valued bindings (module-level and function-local
 *      `const`, one hop of parameter indirection through a same-file
 *      non-exported function — mirroring the data-load scanner's bounded
 *      constant-folder) so a literal reached through a variable is treated
 *      identically to one written inline.
 *   2. Finds every VALUE-COMPARISON shape a resolved identity/kind value can
 *      appear in: `===`/`!==`/`==`/`!=`, a `switch` `case`, `.includes(...)`/
 *      `.has(...)` call receivers, and array/object/Set/Map literal
 *      membership — not just a bare `===`.
 *   3. Finds every IMPORT/RE-EXPORT/DYNAMIC-IMPORT specifier that resolves
 *      (via the same relative-path constant-folder) into a connector's own
 *      module directory, including specifiers assembled via template-literal
 *      composition.
 *   4. Finds any production import of a connector MANIFEST JSON file
 *      (`with { type: "json" }`, `require`, or dynamic `import()`) followed
 *      by a member-access chain reading `.connector_key`/`.connector_id`/
 *      `...validation.kind` off the imported binding — importing the data
 *      file directly and pulling the same fact out is exactly as much
 *      hardcoded-at-this-call-site knowledge as importing the module.
 *
 * Residual, disclosed precisely (matching the data-load scanner's own
 * disclosed posture): single-file analysis; a value that crosses a
 * cross-module function call, is reassigned after declaration (`let`
 * bindings are never trusted), or involves runtime string concatenation with
 * a non-const value is UNRESOLVABLE. Unlike rule (5) — where "unresolvable"
 * itself is a violation ("no unknown data loads pass") — rules (1)/(6)/(7)
 * only flag a resolved match against the manifest-derived vocabulary or a
 * resolved connector-module specifier; an unresolvable value that never
 * concretely proves to be connector-identity knowledge is not flagged by
 * this scanner (it may still be caught by other rules, e.g. rule (5) if it
 * is also a data load). This is a deliberate, narrower failure posture than
 * rule (5): rule (5) closes "did ANY data reach this file", where "don't
 * know" must fail closed; rules (1)/(6)/(7) close "does an identifier
 * PROVABLY carry a manifest-derived connector fact", where "don't know"
 * correctly means "not proven" rather than "assume the worst" — an
 * unresolvable generic string comparison is common, legitimate code (e.g.
 * comparing against an unrelated runtime-supplied discriminator) that a
 * fail-closed posture here would flood with false positives.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { parse } from "@babel/parser";

export interface IdentityViolation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

// --- Minimal structural AST typing, matching the data-load scanner's own
// loosely-typed Node interface (kept independent rather than imported, so
// this module has no coupling to that module's internal helper functions —
// only true code reuse candidates, like `children`/`walk`, would justify a
// shared internal module, and duplicating ~20 lines of generic tree-walk
// plumbing is cheaper than introducing that coupling for two call sites).

interface Node {
  end?: number | null;
  loc?: { start: { line: number } } | null;
  start?: number | null;
  type: string;
  [key: string]: unknown;
}

function nodeArrayField(node: Node, field: string): Node[] {
  const value = node[field];
  return Array.isArray(value) ? (value as Node[]) : [];
}

function nodeField(node: Node, field: string): Node | undefined {
  const value = node[field];
  return value && typeof value === "object" ? (value as Node) : undefined;
}

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") {
      continue;
    }
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && typeof (item as Node).type === "string") {
          out.push(item as Node);
        }
      }
    } else if (value && typeof value === "object" && typeof (value as Node).type === "string") {
      out.push(value as Node);
    }
  }
  return out;
}

function walk(node: Node, visit: (n: Node, parent: Node | null, ancestors: Node[]) => void): void {
  const stack: Array<{ node: Node; ancestors: Node[] }> = [{ ancestors: [], node }];
  while (stack.length > 0) {
    const { node: current, ancestors } = stack.pop() as { node: Node; ancestors: Node[] };
    visit(current, ancestors.at(-1) ?? null, ancestors);
    const nextAncestors = [...ancestors, current];
    for (const child of children(current)) {
      stack.push({ ancestors: nextAncestors, node: child });
    }
  }
}

function isIdentifier(node: Node | undefined, name?: string): boolean {
  return !!node && node.type === "Identifier" && (name === undefined || node.name === name);
}

function lineOf(node: Node): number {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `loc` is declared `?: {...} | null` on the loosely-typed Node interface; real Babel AST nodes can genuinely have a null/absent loc (synthetic nodes). tsc --strict raises no error here.
  return node.loc?.start.line ?? 0;
}

function enclosingFunctionNameOf(ancestors: Node[]): string | null {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i] as Node;
    const id = ancestor.id as Node | undefined;
    if (ancestor.type === "FunctionDeclaration" && id?.type === "Identifier") {
      return id.name as string;
    }
  }
  return null;
}

// --- String-value resolution: identical bounded posture to the data-load
// scanner's constant-folder, but resolving to a plain string VALUE (not a
// repo-relative path) since rules (1)/(6) compare against manifest-derived
// vocabulary, not file paths.

type ResolvedValue = { kind: "static"; value: string } | { kind: "unresolvable" };

interface FileAnalysis {
  allCalls: Node[];
  localFunctions: Map<string, { params: string[]; exported: boolean }>;
  /** Module- or function-scope `const` declarators, by name. `let`/`var` are
   * deliberately excluded (reassignable after declaration -> untrustworthy),
   * matching the data-load scanner's own posture. A name bound to more than
   * one syntactically distinct initializer anywhere in the file is dropped
   * (ambiguous -> unresolvable), not guessed. */
  moduleConsts: Map<string, Node>;
}

function collectConstsAndFunctions(program: Node): {
  localFunctions: Map<string, { params: string[]; exported: boolean }>;
  moduleConsts: Map<string, Node>;
} {
  const moduleConsts = new Map<string, Node>();
  const ambiguousNames = new Set<string>();
  const localFunctions = new Map<string, { params: string[]; exported: boolean }>();

  walk(program, (node) => {
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const decl of nodeArrayField(node, "declarations")) {
        const declId = decl.id as Node | undefined;
        if (declId?.type !== "Identifier" || !decl.init) {
          continue;
        }
        const name = declId.name as string;
        if (ambiguousNames.has(name)) {
          continue;
        }
        const existing = moduleConsts.get(name);
        if (existing && existing !== decl.init) {
          moduleConsts.delete(name);
          ambiguousNames.add(name);
          continue;
        }
        moduleConsts.set(name, decl.init as Node);
      }
    }
  });

  function paramNames(params: Node[]): string[] {
    return params.filter((p) => p.type === "Identifier").map((p) => p.name as string);
  }

  for (const stmt of nodeArrayField(program, "body")) {
    let target = stmt;
    let exported = false;
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
      target = stmt.declaration as Node;
      exported = true;
    }
    const targetId = target.id as Node | undefined;
    if (target.type === "FunctionDeclaration" && targetId?.type === "Identifier") {
      localFunctions.set(targetId.name as string, {
        exported,
        params: paramNames(nodeArrayField(target, "params")),
      });
    }
  }
  return { localFunctions, moduleConsts };
}

function calleeName(callee: Node | undefined): string | null {
  if (!callee) {
    return null;
  }
  if (callee.type === "Identifier") {
    return callee.name as string;
  }
  const property = callee.property as Node | undefined;
  if (callee.type === "MemberExpression" && property?.type === "Identifier") {
    return property.name as string;
  }
  return null;
}

/**
 * Resolve one expression to a plain string value, following one hop of
 * `const` identifier indirection (cycle-guarded) and one hop of same-file
 * non-exported function parameter indirection (all call sites must agree).
 * Template literals with ALL-STATIC quasis and no expressions resolve like a
 * plain string; a template literal with any interpolated expression is
 * unresolvable as a VALUE (unlike the data-load scanner's path resolver,
 * which treats an interpolated segment as a bounded PLACEHOLDER within an
 * otherwise-anchored directory — here there is no "directory" to anchor to,
 * so an interpolated identity string is genuinely opaque).
 */
function resolveStringValue(
  expr: Node,
  analysis: FileAnalysis,
  enclosingFunctionName: string | null,
  depth: number,
  visiting: Set<string>
): ResolvedValue {
  if (depth > 12) {
    return { kind: "unresolvable" };
  }
  if (expr.type === "StringLiteral") {
    return { kind: "static", value: expr.value as string };
  }
  if (expr.type === "TemplateLiteral") {
    const expressions = nodeArrayField(expr, "expressions");
    if (expressions.length > 0) {
      return { kind: "unresolvable" };
    }
    const quasis = nodeArrayField(expr, "quasis");
    const [only] = quasis;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `only.value` is `unknown` on the loosely-typed Node interface's index signature; the `as {raw: string}` cast changes the STATIC type only, a real Babel TemplateElement's `raw` field is not statically guaranteed present at this cast site. tsc --strict raises no error on this file.
    const raw = only ? ((only.value as { raw: string } | undefined)?.raw ?? "") : "";
    return { kind: "static", value: raw };
  }
  if (expr.type === "Identifier") {
    const name = expr.name as string;
    if (visiting.has(name)) {
      return { kind: "unresolvable" };
    }
    const decl = analysis.moduleConsts.get(name);
    if (decl) {
      visiting.add(name);
      const result = resolveStringValue(decl, analysis, enclosingFunctionName, depth + 1, visiting);
      visiting.delete(name);
      return result;
    }
    const viaParam = resolveViaParameterIndirection(expr, analysis, enclosingFunctionName, depth, visiting);
    return viaParam ?? { kind: "unresolvable" };
  }
  return { kind: "unresolvable" };
}

function resolveViaParameterIndirection(
  expr: Node,
  analysis: FileAnalysis,
  enclosingFunctionName: string | null,
  depth: number,
  visiting: Set<string>
): ResolvedValue | null {
  if (expr.type !== "Identifier" || !enclosingFunctionName) {
    return null;
  }
  const info = analysis.localFunctions.get(enclosingFunctionName);
  const paramName = expr.name as string;
  if (!info || info.exported || !info.params.includes(paramName)) {
    return null;
  }
  const paramIndex = info.params.indexOf(paramName);
  const callSites = analysis.allCalls.filter((c) => calleeName(c.callee as Node) === enclosingFunctionName);
  if (callSites.length === 0) {
    return { kind: "unresolvable" };
  }
  let agreed: string | null = null;
  for (const call of callSites) {
    const args = nodeArrayField(call, "arguments");
    const argNode = args[paramIndex];
    if (!argNode) {
      return { kind: "unresolvable" };
    }
    const r = resolveStringValue(argNode, analysis, null, depth + 1, visiting);
    if (r.kind !== "static") {
      return { kind: "unresolvable" };
    }
    if (agreed === null) {
      agreed = r.value;
    } else if (agreed !== r.value) {
      return { kind: "unresolvable" };
    }
  }
  return agreed === null ? { kind: "unresolvable" } : { kind: "static", value: agreed };
}

// --- Relative import/re-export specifier resolution (repo-root-relative),
// reused for both rule (7)'s connector-module-import check and rule (4)'s
// manifest-import-then-extract check. Deliberately simpler than the
// data-load scanner's path resolver (join/resolve/__dirname arithmetic):
// import specifiers are always a single string literal (or, per this
// module's added coverage, a template literal / identifier resolving to
// one) relative to the importing file — there is no join()/resolve() call
// tree to fold for a specifier position.

function joinRelative(baseDir: string, part: string): string {
  const segments = [...baseDir.split("/"), ...part.split("/")];
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (out.length > 0 && out.at(-1) !== "..") {
        out.pop();
      } else {
        out.push(seg);
      }
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

function isRelativeSpecifier(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
}

// Matches a resolved repo-root-relative path that lands inside a THIRD-PARTY
// connector's own module directory under either polyfill-connectors root,
// mirroring CONNECTOR_MODULE_IMPORT_RE's scope in the sibling literal-scan
// module: scoped to `polyfill-connectors/connectors/<name>/...`
// specifically, not any path segment literally named `connectors` (RI's own
// `reference-implementation/connectors/seed/` fixture connector is not
// third-party knowledge).
const THIRD_PARTY_CONNECTOR_MODULE_PATH_RE = /(^|\/)packages\/polyfill-connectors\/connectors\/[^/]+\//;
function isThirdPartyConnectorModulePath(resolvedRelPath: string): boolean {
  return THIRD_PARTY_CONNECTOR_MODULE_PATH_RE.test(resolvedRelPath);
}

// The shared-library scan root's own files reference a sibling connector via
// a package-relative specifier (`../connectors/whatsapp/validation.ts`) that
// never spells out the `polyfill-connectors/connectors/` segment — mirrors
// SHARED_LIBRARY_RELATIVE_CONNECTOR_IMPORT_RE's scope.
const SHARED_LIBRARY_RELATIVE_CONNECTOR_MODULE_PATH_RE = /(^|\/)connectors\/[^/]+\//;
function isSharedLibraryRelativeConnectorModulePath(resolvedRelPath: string): boolean {
  return SHARED_LIBRARY_RELATIVE_CONNECTOR_MODULE_PATH_RE.test(resolvedRelPath);
}

const MANIFEST_ROOTS = ["reference-implementation/manifests", "packages/polyfill-connectors/manifests"];

function isUnderManifestRoot(resolvedRelPath: string): boolean {
  return MANIFEST_ROOTS.some((root) => resolvedRelPath === root || resolvedRelPath.startsWith(`${root}/`));
}

/** Resolve an import/require/dynamic-import specifier expression to a
 * repo-root-relative path, following the same const/template resolution as
 * `resolveStringValue` (closing "template-literal composition" for import
 * specifiers, e.g. `` `../connectors/${name}/validation.ts` `` is NOT
 * resolvable this way since it has an interpolated expression -- it falls
 * through to unresolvable, which is correct: this scanner does not attempt
 * to enumerate every possible interpolation value, it just refuses to wave
 * a dynamic connector-path specifier through as proven-safe). Returns null
 * if the specifier does not resolve to a relative (`./`/`../`) literal at
 * all (a bare package specifier, or genuinely unresolvable). */
function resolveImportSpecifierPath(
  expr: Node,
  analysis: FileAnalysis,
  enclosingFunctionName: string | null,
  fileDir: string
): string | null {
  const resolved = resolveStringValue(expr, analysis, enclosingFunctionName, 0, new Set());
  if (resolved.kind !== "static" || !isRelativeSpecifier(resolved.value)) {
    return null;
  }
  return joinRelative(fileDir, resolved.value);
}

// --- Value-comparison-shape detection (rules 1/6): every AST shape in which
// a resolved string value can be tested for identity/membership against a
// known-vocabulary set.

/** Every "comparison operand" site the scanner checks a resolved value
 * against: binary `===`/`!==`/`==`/`!=` operands and `switch` case tests
 * directly, plus — for `.includes(...)`/`.has(...)` calls — the ELEMENTS of
 * the RECEIVER array/Set literal (resolved through one hop of const
 * indirection, matching `resolveStringValue`'s own posture), not the call's
 * argument. The argument to `KNOWN.includes(connectorId)` is a runtime value
 * being tested, almost never itself a literal; the receiver's literal
 * elements are what carry the hardcoded vocabulary being checked against —
 * the membership CHECK (an actual `.includes()`/`.has()` call site, not just
 * the collection literal's existence) is what proves identity intent, so an
 * array/Set that is built but never checked against anything is correctly
 * not flagged. Each site is paired with the name of its own
 * lexically-enclosing top-level function (for parameter indirection),
 * computed from the SAME ancestor-tracking walk that finds the site itself
 * -- not a separate pass -- so the enclosing-function lookup can never
 * desync from the site it's paired with. */
interface ComparisonSite {
  enclosingFunctionName: string | null;
  node: Node;
}

/** Resolve `expr` one hop through const indirection to an ArrayExpression or
 * `new Set([...])` literal node, or null if it isn't one (already a
 * literal, or resolves to neither). Mirrors `resolveStringValue`'s single-
 * hop-of-const-indirection posture, applied to a collection literal instead
 * of a string value. */
function resolveToCollectionLiteral(expr: Node, analysis: FileAnalysis): Node | null {
  if (expr.type === "ArrayExpression") {
    return expr;
  }
  if (expr.type === "NewExpression" && isIdentifier(expr.callee as Node, "Set")) {
    const [first] = nodeArrayField(expr, "arguments");
    return first?.type === "ArrayExpression" ? first : null;
  }
  if (expr.type === "Identifier") {
    const decl = analysis.moduleConsts.get(expr.name as string);
    return decl ? resolveToCollectionLiteral(decl, analysis) : null;
  }
  return null;
}

/** `.includes(...)`/`.has(...)` branch of {@link collectComparisonSites}:
 * appends one site per element of the call's RECEIVER collection literal
 * (resolved via {@link resolveToCollectionLiteral}), or does nothing if the
 * call isn't a membership check on a resolvable collection. Split out purely
 * to keep `collectComparisonSites` itself under the cognitive-complexity
 * budget -- this is one AST-shape branch among three, not an independently
 * reusable concept. */
function pushMembershipCallSites(node: Node, ancestors: Node[], analysis: FileAnalysis, sites: ComparisonSite[]): void {
  if (node.type !== "CallExpression") {
    return;
  }
  const callee = node.callee as Node;
  const name = calleeName(callee);
  if (name !== "includes" && name !== "has") {
    return;
  }
  const receiver = callee.type === "MemberExpression" ? (callee.object as Node) : null;
  const collection = receiver ? resolveToCollectionLiteral(receiver, analysis) : null;
  if (!collection) {
    return;
  }
  const enclosingFunctionName = enclosingFunctionNameOf(ancestors);
  for (const element of nodeArrayField(collection, "elements")) {
    sites.push({ enclosingFunctionName, node: element });
  }
}

function collectComparisonSites(program: Node, analysis: FileAnalysis): ComparisonSite[] {
  const sites: ComparisonSite[] = [];
  walk(program, (node, _parent, ancestors) => {
    if (node.type === "BinaryExpression" && ["!=", "!==", "==", "==="].includes(node.operator as string)) {
      const enclosingFunctionName = enclosingFunctionNameOf(ancestors);
      sites.push(
        { enclosingFunctionName, node: node.left as Node },
        { enclosingFunctionName, node: node.right as Node }
      );
      return;
    }
    if (node.type === "SwitchCase" && node.test) {
      sites.push({ enclosingFunctionName: enclosingFunctionNameOf(ancestors), node: node.test as Node });
      return;
    }
    pushMembershipCallSites(node, ancestors, analysis, sites);
  });
  return sites;
}

function reportKey(relPath: string, line: number, rule: string): string {
  return `${relPath}:${line}:${rule}`;
}

/**
 * Scan one production file's AST for rules (1)/(6)/(7)/(4b):
 *
 * (1) hardcoded-connector-identity-literal: a resolved string value (direct
 *     literal or reached through const/parameter indirection) equal to a
 *     manifest-derived `connector_key`/`connector_id`, appearing at a
 *     comparison/membership site.
 * (6) hardcoded-validation-kind-literal: same shape, against the manifest-
 *     derived `validation.kind` vocabulary.
 * (7) connector-module-import: a static import, dynamic `import()`, `export
 *     ... from`, or CommonJS `require(...)` specifier that resolves (via
 *     const/template indirection) into a connector's own module directory.
 * (4b) hardcoded-connector-manifest-import: a production file statically or
 *     dynamically importing a connector manifest JSON file directly (rather
 *     than going through the shared manifest-loading registry) — importing
 *     the data file and reading `connector_key`/`connector_id`/`.kind` off
 *     it is the same knowledge as rule (1)/(6), reached via a different
 *     seam.
 */
type ReportFn = (node: Node, rule: string) => void;

/** Rules (1)/(6): every comparison-site value that resolves to a known
 * connector-identity or validation-kind literal. */
function scanComparisonSites(
  program: Node,
  analysis: FileAnalysis,
  connectorKeys: ReadonlySet<string>,
  validationKinds: ReadonlySet<string>,
  report: ReportFn
): void {
  for (const { enclosingFunctionName, node: site } of collectComparisonSites(program, analysis)) {
    const resolved = resolveStringValue(site, analysis, enclosingFunctionName, 0, new Set());
    if (resolved.kind !== "static") {
      continue;
    }
    if (connectorKeys.has(resolved.value)) {
      report(site, "hardcoded-connector-identity-literal");
    } else if (validationKinds.has(resolved.value)) {
      report(site, "hardcoded-validation-kind-literal");
    }
  }
}

/** Rule (7), static half: `import`/`export ... from`/`export * from` specifiers. */
function scanStaticImportSpecifiers(
  program: Node,
  fileDir: string,
  isConnectorModulePath: (resolvedRelPath: string) => boolean,
  report: ReportFn
): void {
  for (const stmt of nodeArrayField(program, "body")) {
    if (
      stmt.type !== "ImportDeclaration" &&
      stmt.type !== "ExportNamedDeclaration" &&
      stmt.type !== "ExportAllDeclaration"
    ) {
      continue;
    }
    const source = nodeField(stmt, "source");
    if (source?.type !== "StringLiteral") {
      continue;
    }
    const value = source.value as string;
    if (!isRelativeSpecifier(value)) {
      continue;
    }
    const resolvedPath = joinRelative(fileDir, value);
    if (isConnectorModulePath(resolvedPath)) {
      report(stmt, "connector-module-import");
    }
  }
}

/** Rule (7), dynamic half: `import(...)` and `require(...)` call sites. */
function scanDynamicImportSpecifiers(
  program: Node,
  analysis: FileAnalysis,
  fileDir: string,
  isConnectorModulePath: (resolvedRelPath: string) => boolean,
  report: ReportFn
): void {
  walk(program, (node, _parent, ancestors) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = node.callee as Node;
    const isDynamicImport = callee.type === "Import";
    const isRequire = isIdentifier(callee, "require");
    if (!(isDynamicImport || isRequire)) {
      return;
    }
    const [first] = nodeArrayField(node, "arguments");
    if (!first) {
      return;
    }
    const enclosingFunctionName = enclosingFunctionNameOf(ancestors);
    const resolvedPath = resolveImportSpecifierPath(first, analysis, enclosingFunctionName, fileDir);
    if (resolvedPath && isConnectorModulePath(resolvedPath)) {
      report(node, "connector-module-import");
    }
  });
}

/** Every local name bound to a manifest-root JSON import, across the static
 * `import ... with { type: "json" }`, `require(...)`, and dynamic
 * `import(...)` binding forms. */
function collectManifestImportBindings(program: Node, fileDir: string): Set<string> {
  const bindings = new Set<string>();
  for (const stmt of nodeArrayField(program, "body")) {
    if (stmt.type !== "ImportDeclaration") {
      continue;
    }
    const source = nodeField(stmt, "source");
    if (source?.type !== "StringLiteral" || !isRelativeSpecifier(source.value as string)) {
      continue;
    }
    if (!isUnderManifestRoot(joinRelative(fileDir, source.value as string))) {
      continue;
    }
    for (const specifier of nodeArrayField(stmt, "specifiers")) {
      const local = nodeField(specifier, "local");
      if (local?.type === "Identifier") {
        bindings.add(local.name as string);
      }
    }
  }
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || !node.init) {
      return;
    }
    const init = node.init as Node;
    const isRequireOrImportCall =
      init.type === "CallExpression" &&
      (isIdentifier(init.callee as Node, "require") || (init.callee as Node).type === "Import");
    if (!isRequireOrImportCall) {
      return;
    }
    const [first] = nodeArrayField(init, "arguments");
    if (first?.type !== "StringLiteral" || !isRelativeSpecifier(first.value as string)) {
      return;
    }
    if (!isUnderManifestRoot(joinRelative(fileDir, first.value as string))) {
      return;
    }
    const declId = node.id as Node;
    if (declId.type === "Identifier") {
      bindings.add(declId.name as string);
    }
  });
  return bindings;
}

const MANIFEST_IDENTITY_FIELD_NAMES = new Set(["kind", "connector_key", "connector_id"]);

/** Rule (4b): a production file importing a connector manifest JSON directly,
 * then reading an identity/kind field off the imported binding. Static
 * `import x from "../manifests/whatsapp.json" with { type: "json" }` and
 * `require("../manifests/whatsapp.json")` / dynamic `import(...)` forms all
 * bind a local name to the parsed manifest object; any member-access chain
 * off that binding ending in connector_key/connector_id/kind is the same
 * fact rule (1)/(6) forbid, reached by importing the data file instead of
 * comparing a literal. */
function scanManifestImportExtraction(program: Node, fileDir: string, report: ReportFn): void {
  const manifestImportBindings = collectManifestImportBindings(program, fileDir);
  if (manifestImportBindings.size === 0) {
    return;
  }
  walk(program, (node) => {
    if (node.type !== "MemberExpression") {
      return;
    }
    const property = node.property as Node | undefined;
    const propName = property?.type === "Identifier" ? (property.name as string) : null;
    if (!(propName && MANIFEST_IDENTITY_FIELD_NAMES.has(propName))) {
      return;
    }
    let base: Node = node.object as Node;
    while (base.type === "MemberExpression") {
      base = base.object as Node;
    }
    if (base.type === "Identifier" && manifestImportBindings.has(base.name as string)) {
      report(node, "hardcoded-connector-manifest-import");
    }
  });
}

export function scanFileIdentity(
  absPath: string,
  relPath: string,
  connectorKeys: ReadonlySet<string>,
  validationKinds: ReadonlySet<string>,
  isSharedLibraryFile: boolean
): IdentityViolation[] {
  const raw = readFileSync(absPath, "utf8");
  let ast: Node;
  try {
    const isJsxExtension = absPath.endsWith(".tsx") || absPath.endsWith(".jsx");
    ast = parse(raw, {
      errorRecovery: true,
      plugins: isJsxExtension ? ["typescript", "jsx", "importAttributes"] : ["typescript", "importAttributes"],
      sourceType: "module",
    }) as unknown as Node;
  } catch {
    return [];
  }

  const program = ast.program as Node;
  const { moduleConsts, localFunctions } = collectConstsAndFunctions(program);
  const allCalls: Node[] = [];
  walk(program, (n) => {
    if (n.type === "CallExpression") {
      allCalls.push(n);
    }
  });
  const analysis: FileAnalysis = { allCalls, localFunctions, moduleConsts };
  const fileDir = dirname(relPath);

  const violations: IdentityViolation[] = [];
  const reported = new Set<string>();
  const report: ReportFn = (node, rule) => {
    const line = lineOf(node);
    const key = reportKey(relPath, line, rule);
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    const lineText = raw.split("\n")[line - 1]?.trim() ?? "";
    violations.push({ file: relPath, line, rule, snippet: lineText });
  };

  const isConnectorModulePath = isSharedLibraryFile
    ? isSharedLibraryRelativeConnectorModulePath
    : isThirdPartyConnectorModulePath;

  scanComparisonSites(program, analysis, connectorKeys, validationKinds, report);
  scanStaticImportSpecifiers(program, fileDir, isConnectorModulePath, report);
  scanDynamicImportSpecifiers(program, analysis, fileDir, isConnectorModulePath, report);
  scanManifestImportExtraction(program, fileDir, report);

  return violations;
}
