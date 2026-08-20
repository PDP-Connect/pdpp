// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AST-based identity/dispatch scanner backing the zero-connector-knowledge
 * conformance guard's rules (1), (6), and (7).
 *
 * Invariant: every node in the file is a candidate. The walk hands each node
 * to `resolveStringValue`; if it resolves to a static string equal to a
 * manifest-derived connector key or validation kind, it's a violation,
 * regardless of what kind of node holds it or where it sits in the tree.
 *
 * One exception: an object/pattern property KEY DECLARATION (`{ meta: x }`)
 * is a slot name, not an asserted value, so it's only trusted as identity
 * evidence when the object is proven used as a dispatch table
 * (`objectExpressionsUsedAsDispatchTables`) — narrowed further by
 * `GENERIC_KEY_NAME_VOCABULARY_COLLISIONS`. This carve-out is scoped to that
 * one declaration shape and nothing else: a membership check (`"meta" in
 * obj`), a call argument, a return value, or any other value position is
 * checked unconditionally and is never exempt, even for a colliding name —
 * `"meta" in registry` is exactly the dynamic identity-membership shape this
 * scanner exists to catch.
 *
 * `resolveStringValue` also drives rules (7)/(4b) below: connector-module
 * import/require/re-export specifiers, and direct manifest-JSON imports
 * whose `.connector_key`/`.connector_id`/`.kind` field is read off.
 *
 * Disclosed residual: single-file analysis; a value crossing a cross-module
 * call, a reassigned `let`, or runtime concatenation with a non-const value
 * is unresolvable. Unlike rule (5) (data loads, where "unknown" fails
 * closed), rules (1)/(6)/(7) only flag a *proven* match at the VALUE level —
 * an unresolvable generic string is common, legitimate code that a
 * fail-closed posture here would flood with false positives. A file this
 * scanner cannot parse at all is a different failure mode, not a value
 * ambiguity: `scanFileIdentity` fails closed on that, reporting an
 * `unparseable-production-file` violation rather than silently returning no
 * findings — a file the scanner cannot read is a file it cannot prove clean.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  calleeName,
  collectConstsAndFunctions,
  enclosingFunctionNameOf,
  isIdentifier,
  lineOf,
  type Node,
  nodeArrayField,
  nodeField,
  parseFailureViolation,
  parseSource,
  walk,
} from "./ri-zero-connector-knowledge-ast-shared.ts";

export interface IdentityViolation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
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
  // Bounded concatenation folding: `"gm" + "ail"` (or any depth of nested
  // `+` on resolvable operands, e.g. via const indirection) resolves to the
  // concatenated string. Only `+` folds; every other binary operator is a
  // comparison operator handled at its own AST position (see
  // `collectLiteralPositions`), not a value-producing expression here.
  if (expr.type === "BinaryExpression" && expr.operator === "+") {
    const left = resolveStringValue(expr.left as Node, analysis, enclosingFunctionName, depth + 1, visiting);
    if (left.kind !== "static") {
      return { kind: "unresolvable" };
    }
    const right = resolveStringValue(expr.right as Node, analysis, enclosingFunctionName, depth + 1, visiting);
    if (right.kind !== "static") {
      return { kind: "unresolvable" };
    }
    return { kind: "static", value: left.value + right.value };
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

const MANIFEST_ROOTS = ["reference-implementation/fixtures/seed-manifests", "packages/polyfill-connectors/manifests"];

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

// --- Universal literal-position detection (rules 1/6): every node in the
// file is a candidate -- `scanLiteralPositions` hands EVERY visited node to
// `resolveStringValue` and checks whatever resolves. There is no list of
// "positions a value can be written into" to fall behind; a `CallExpression`
// argument, a `ReturnStatement` argument, a class field initializer, a
// `TSEnumMember` initializer, a default-parameter value, a tagged-template
// quasi, and every shape the prior enumerated design already covered
// (object/pattern property values, array/Set elements, declarator
// initializers, comparison operands, switch-case tests) are all just nodes
// in the tree, visited the same way. The only exclusion is object/pattern
// property KEYS, gated on {@link objectExpressionsUsedAsDispatchTables} --
// see that function's doc comment for why keys (not values) are the one
// position where naming ambiguity is real.

/** One AST position the scanner treats as potentially holding a resolvable
 * string value, paired with the name of its own lexically-enclosing
 * top-level function (for parameter indirection), computed from the SAME
 * ancestor-tracking walk that finds the site itself -- not a separate pass
 * -- so the enclosing-function lookup can never desync from the site it's
 * paired with. */
interface LiteralPosition {
  enclosingFunctionName: string | null;
  node: Node;
}

/** A property/pattern KEY DECLARATION name that is a real connector key but
 * ALSO this codebase's generic vocabulary for something unrelated (e.g.
 * `meta`, the JSON-envelope field name, colliding with the `meta`/Facebook
 * connector). Scoped strictly to a literal key declaration (`{ meta: x }`
 * names a slot) -- never a membership check (`"meta" in obj`), comparison,
 * or a value written into a proven dispatch table, all of which are
 * assertions and remain flagged unconditionally. Reviewed per entry: no RI
 * production file uses the name to mean the colliding connector. */
const GENERIC_KEY_NAME_VOCABULARY_COLLISIONS = new Set(["meta"]);

/** `ObjectExpression`/`ObjectPattern` property KEY as a literal position, or
 * null if computed (a runtime expression, unresolvable by design) or absent.
 * An `Identifier` key names the property by its own text, so it is wrapped
 * as a synthetic `StringLiteral` node rather than resolved as a variable
 * reference. */
function objectPropertyKeyLiteralNode(property: Node): Node | null {
  if (property.type !== "ObjectProperty" && property.type !== "ObjectMethod") {
    return null;
  }
  if (property.computed === true) {
    return null;
  }
  const key = property.key as Node | undefined;
  if (!key) {
    return null;
  }
  if (key.type === "StringLiteral") {
    return GENERIC_KEY_NAME_VOCABULARY_COLLISIONS.has(key.value as string) ? null : key;
  }
  if (key.type === "Identifier") {
    const name = key.name as string;
    if (GENERIC_KEY_NAME_VOCABULARY_COLLISIONS.has(name)) {
      return null;
    }
    return { loc: key.loc ?? null, type: "StringLiteral", value: name };
  }
  return null;
}

/** Unwrap a same-file-idiomatic `Object.freeze(<expr>)` call to its inner
 * expression, one hop (this codebase writes every dispatch-table constant as
 * `Object.freeze({...})`, so a resolver that only recognized a bare
 * `ObjectExpression` init would miss every real one). Returns `expr`
 * unchanged if it isn't an `Object.freeze(...)` call. */
function unwrapObjectFreeze(expr: Node): Node {
  if (expr.type !== "CallExpression") {
    return expr;
  }
  const callee = expr.callee as Node;
  const isObjectFreeze =
    callee.type === "MemberExpression" &&
    isIdentifier(callee.object as Node, "Object") &&
    isIdentifier(callee.property as Node, "freeze");
  if (!isObjectFreeze) {
    return expr;
  }
  const [first] = nodeArrayField(expr, "arguments");
  return first ?? expr;
}

/**
 * Every module-level `const`-bound `ObjectExpression` (optionally wrapped in
 * `Object.freeze(...)`, this codebase's own idiom for a dispatch-table
 * constant) that is later proven, by an ACTUAL dispatch-shaped usage
 * elsewhere in the file, to be used as a table keyed by identity rather than
 * merely a record with named fields: computed (bracket) member access on the
 * const binding (`TABLE[x]`), `Object.keys(TABLE)`/`Object.values(TABLE)`,
 * or `key in TABLE`. Mirrors the array/Set membership rule's own "the check
 * proves intent" gate (`resolveToCollectionLiteral` + `.includes()`/
 * `.has()` call-site requirement): an object literal's KEYS are property
 * NAMES, not asserted values -- `{ meta: {...} }` is exactly as likely to
 * mean "this field is called meta" (a JSON-envelope wrapper key, unrelated
 * to the `meta` connector) as "this dispatch table has a meta entry", so a
 * key is only trusted as connector-identity evidence when the object is
 * DEMONSTRABLY used as a lookup table, not merely constructed. An object
 * literal that is inlined directly at a bracket-access/`in`/`Object.keys`
 * call site (not bound to a const first) is also covered, via the
 * direct-literal branch below.
 */
function objectExpressionsUsedAsDispatchTables(program: Node, analysis: FileAnalysis): Set<Node> {
  const provenTables = new Set<Node>();
  function markIfDispatchUsage(receiver: Node | undefined): void {
    if (!receiver) {
      return;
    }
    const unwrapped = unwrapObjectFreeze(receiver);
    if (unwrapped.type === "ObjectExpression") {
      provenTables.add(unwrapped);
      return;
    }
    if (unwrapped.type === "Identifier") {
      const decl = analysis.moduleConsts.get(unwrapped.name as string);
      const unwrappedDecl = decl ? unwrapObjectFreeze(decl) : undefined;
      if (unwrappedDecl?.type === "ObjectExpression") {
        provenTables.add(unwrappedDecl);
      }
    }
  }
  walk(program, (node) => {
    if (node.type === "MemberExpression" && node.computed === true) {
      markIfDispatchUsage(node.object as Node | undefined);
      return;
    }
    if (node.type === "BinaryExpression" && node.operator === "in") {
      markIfDispatchUsage(node.right as Node | undefined);
      return;
    }
    if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      const isObjectKeysOrValues =
        callee.type === "MemberExpression" &&
        isIdentifier(callee.object as Node, "Object") &&
        (isIdentifier(callee.property as Node, "keys") || isIdentifier(callee.property as Node, "values"));
      if (isObjectKeysOrValues) {
        const [first] = nodeArrayField(node, "arguments");
        markIfDispatchUsage(first);
      }
    }
  });
  return provenTables;
}

/** Every object/pattern property KEY node decided by the key-collision rule
 * (see {@link objectPropertyKeyLiteralNode}) rather than the generic value
 * walk below -- collected up front so the generic walk can skip exactly
 * these nodes by identity. Scoped to literal key DECLARATIONS only: a
 * membership/call/return value (including `x in obj`, a real dynamic
 * identity-membership check against a registry) is never covered by this
 * carve-out and is always pushed as an ordinary value position. */
function objectPropertyKeyPositions(
  program: Node,
  dispatchTables: ReadonlySet<Node>
): { decidedKeys: Set<Node>; sites: LiteralPosition[] } {
  const decidedKeys = new Set<Node>();
  const sites: LiteralPosition[] = [];
  walk(program, (node, parent, ancestors) => {
    if (node.type !== "ObjectProperty" && node.type !== "ObjectMethod") {
      return;
    }
    const key = node.key as Node | undefined;
    if (key && (key.type === "Identifier" || key.type === "StringLiteral")) {
      decidedKeys.add(key);
    }
    const owner = parent as Node;
    const checkKeys = owner.type === "ObjectPattern" || dispatchTables.has(owner);
    const keyNode = checkKeys ? objectPropertyKeyLiteralNode(node) : null;
    if (keyNode) {
      sites.push({ enclosingFunctionName: enclosingFunctionNameOf(ancestors), node: keyNode });
    }
  });
  return { decidedKeys, sites };
}

/** Every literal-bearing AST position in the file: every node is a candidate
 * -- `resolveStringValue` decides what actually resolves, so pushing a node
 * whose shape it doesn't recognize just costs a wasted attempt. The one
 * exclusion is an object/pattern property KEY declaration, gated by
 * {@link objectPropertyKeyPositions} instead of the generic push (see that
 * function's doc comment for why membership/call/return values, including
 * `x in obj`, are deliberately NOT covered by this exclusion). Every real
 * value position -- object VALUES, class fields, call arguments, return
 * values, everything else -- is pushed unconditionally. */
function collectLiteralPositions(program: Node, analysis: FileAnalysis): LiteralPosition[] {
  const dispatchTables = objectExpressionsUsedAsDispatchTables(program, analysis);
  const { decidedKeys, sites } = objectPropertyKeyPositions(program, dispatchTables);
  walk(program, (node, _parent, ancestors) => {
    if (decidedKeys.has(node) || node.type === "ObjectProperty" || node.type === "ObjectMethod") {
      return;
    }
    sites.push({ enclosingFunctionName: enclosingFunctionNameOf(ancestors), node });
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
 *     literal, or reached through const/parameter indirection or bounded `+`
 *     concatenation), equal to a manifest-derived `connector_key`/
 *     `connector_id`, appearing at ANY literal-bearing AST position — not
 *     just a comparison/membership site.
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

/** Rules (1)/(6): every literal-bearing position whose resolved value is a
 * known connector-identity or validation-kind literal. */
function scanLiteralPositions(
  program: Node,
  analysis: FileAnalysis,
  connectorKeys: ReadonlySet<string>,
  validationKinds: ReadonlySet<string>,
  report: ReportFn
): void {
  for (const { enclosingFunctionName, node: site } of collectLiteralPositions(program, analysis)) {
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
  let program: Node;
  try {
    program = parseSource(raw, absPath);
  } catch (error) {
    // A file this scanner cannot parse is a file it cannot prove carries
    // zero connector knowledge — reporting nothing here would silently
    // certify unsupported or malformed production source as clean. Fail
    // closed via the shared typed contract (see that function's doc
    // comment): a parse failure is itself a violation, not a skip.
    return [parseFailureViolation(relPath, error)];
  }

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

  scanLiteralPositions(program, analysis, connectorKeys, validationKinds, report);
  scanStaticImportSpecifiers(program, fileDir, isConnectorModulePath, report);
  scanDynamicImportSpecifiers(program, analysis, fileDir, isConnectorModulePath, report);
  scanManifestImportExtraction(program, fileDir, report);

  return violations;
}
