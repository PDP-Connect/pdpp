// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AST-based identity/dispatch scanner backing the zero-connector-knowledge
 * conformance guard's rules (1), (6), and (7).
 *
 * The terminal invariant (ri-zero-knowledge-terminal-revise-0810) is
 * deliberately simpler than the shape-enumeration this module used to do
 * (`===`/`switch`/`.includes()`/`.has()` specifically): in a scanned
 * production root, any STATICALLY RESOLVABLE string expression equal to a
 * manifest-derived connector key or validation kind is prohibited, no matter
 * where it appears in the AST — an object-literal key or value, an array/Set
 * element, a `let`/`const` declaration's initializer, a destructured
 * property key, a comparison operand, a switch case — every one of those
 * positions is, structurally, just "a string literal (or something that
 * resolves to one) appears at this AST location." Enumerating consumption
 * shapes one at a time (the prior design) is a losing game against ordinary
 * authorship: the most idiomatic TypeScript dispatch shape in this
 * codebase's own style, `const HANDLERS = { gmail: ..., slack: ... }`,
 * doesn't have a `===` or `.includes()` anywhere in it, and neither does
 * `const KNOWN_KEY = "gmail";` sitting unused, or `const { gmail: g } =
 * REGISTRY;`. This module instead resolves EVERY string-literal-bearing
 * position in the file — walking the whole AST rather than a curated list of
 * "comparison sites" — and checks each resolved value against the manifest-
 * derived vocabulary. A resolved value is:
 *
 *   1. A `StringLiteral`.
 *   2. A `TemplateLiteral` with no interpolated expressions (all-static
 *      quasis) — same posture as before.
 *   3. A `BinaryExpression` `+` of two resolvable string values (NEW: bounded
 *      concatenation folding — `"gm" + "ail"` resolves to `"gmail"`).
 *   4. An `Identifier` resolved through one hop of `const` indirection
 *      (module- or function-scope, cycle-guarded) or one hop of same-file
 *      non-exported function parameter indirection (all call sites must
 *      agree) — unchanged from before.
 *
 * The AST positions checked are not an enumerated list of "shapes a
 * connector-identity check might take" — they are every position in the tree
 * where a resolvable-string-typed child can occur: `ObjectExpression`
 * property keys (identifier or string-literal) and values, `ObjectPattern`
 * (destructuring) property keys, `ArrayExpression`/`NewExpression Set(...)`
 * elements, `VariableDeclarator` initializers (so a `let`/`const` bound to a
 * connector-key literal is itself the violation site, independent of whether
 * it is later compared against anything), `BinaryExpression` comparison
 * operands, and `SwitchCase` tests. `.includes()`/`.has()`/`.indexOf()`/`in`
 * membership checks need no special-casing under this design: the array/
 * object LITERAL itself is already a checked position (its elements/values),
 * so a hardcoded vocabulary term is caught the moment it is written into a
 * collection literal, whether or not that collection is ever queried.
 *
 * This module still parses with `@babel/parser` (the same real-AST
 * dependency `ri-zero-connector-knowledge-data-load-scan.ts` already uses
 * for rule (5), both now sharing `ri-zero-connector-knowledge-ast-shared.ts`
 * for the generic tree-walk plumbing) and separately:
 *
 *   - Finds every IMPORT/RE-EXPORT/DYNAMIC-IMPORT specifier that resolves
 *     (via the same relative-path constant-folder) into a connector's own
 *     module directory, including specifiers assembled via template-literal
 *     composition.
 *   - Finds any production import of a connector MANIFEST JSON file
 *     (`with { type: "json" }`, `require`, or dynamic `import()`) followed
 *     by a member-access chain reading `.connector_key`/`.connector_id`/
 *     `...validation.kind` off the imported binding — importing the data
 *     file directly and pulling the same fact out is exactly as much
 *     hardcoded-at-this-call-site knowledge as importing the module.
 *
 * Residual, disclosed precisely (matching the data-load scanner's own
 * disclosed posture): single-file analysis; a value that crosses a
 * cross-module function call, is reassigned after declaration (`let`
 * bindings' initializers ARE checked as a literal-bearing position, but a
 * `let` is never trusted as a resolvable SOURCE for a later reference to
 * it), or involves runtime string concatenation with a non-const/non-literal
 * value is UNRESOLVABLE. Destructuring a COMPUTED property (`const { [key]:
 * x } = obj`) is unresolvable — `key` is a runtime expression, not a
 * literal-bearing position. Unlike rule (5) — where "unresolvable" itself is
 * a violation ("no unknown data loads pass") — rules (1)/(6)/(7) only flag a
 * resolved match against the manifest-derived vocabulary or a resolved
 * connector-module specifier; an unresolvable value that never concretely
 * proves to be connector-identity knowledge is not flagged by this scanner
 * (it may still be caught by other rules, e.g. rule (5) if it is also a data
 * load). This is a deliberate, narrower failure posture than rule (5): rule
 * (5) closes "did ANY data reach this file", where "don't know" must fail
 * closed; rules (1)/(6)/(7) close "does an identifier PROVABLY carry a
 * manifest-derived connector fact", where "don't know" correctly means "not
 * proven" rather than "assume the worst" — an unresolvable generic string is
 * common, legitimate code (e.g. an unrelated runtime-supplied discriminator)
 * that a fail-closed posture here would flood with false positives.
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

// --- Universal literal-position detection (rules 1/6): rather than
// enumerate AST shapes that "consume" a resolved value (comparison,
// membership call, switch), walk every node in the file and collect every
// AST POSITION that can syntactically hold a resolvable string value --
// object-literal keys and values, destructuring-pattern keys, array/Set
// elements, variable-declarator initializers, comparison operands, and
// switch-case tests. A hardcoded vocabulary term is caught the moment it is
// WRITTEN at any of these positions, independent of whether or how it is
// later consumed -- this is what makes `const HANDLERS = { gmail: fn }` and
// `const UNUSED_KEY = "gmail";` violations without needing a `.includes()`
// or `===` anywhere in the file.

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

/** `ObjectExpression`/`ObjectPattern` property KEY, if it is a literal-typed
 * key position: a non-computed `Identifier` key (`{ gmail: ... }`) or a
 * `StringLiteral` key (`{ "gmail": ... }`) -- covers both object-literal
 * dispatch tables and destructuring-pattern property keys (`const { gmail:
 * g } = REGISTRY`), the same key shape in both directions. A `computed:
 * true` key is a runtime expression, not a literal position, and is
 * deliberately not resolved here (matches the module's disclosed residual:
 * arbitrary computed property access is unresolvable). Returns null if this
 * property has no literal-typed key.
 *
 * An `Identifier` key names the property by its literal TEXT (`{ gmail:
 * ... }` means the key IS the string "gmail") -- it is NOT a variable
 * reference, so it is wrapped as a synthetic `StringLiteral`-shaped node
 * (same `loc`, for correct line reporting) rather than passed through
 * `resolveStringValue`'s own `Identifier` branch, which resolves an
 * identifier by looking up a same-named `const`/parameter binding -- the
 * wrong lookup entirely for a key that IS its own name. */
/**
 * Reviewed, closed carve-out for a property/pattern KEY name that is a real
 * manifest-derived connector key but is ALSO this codebase's own generic
 * vocabulary for something unrelated to connector identity. Deliberately
 * scoped to KEY positions only (never VALUE positions, never import/manifest
 * rules) -- a key is a NAME (`{ meta: x }` means "this slot is called
 * meta"), while a value is an ASSERTION (`x === "meta"` or `{ id: "meta" }`
 * means "this concretely IS meta"), so the ambiguity that motivates this
 * carve-out only exists on the naming side. `meta` collides with the `meta`
 * (Meta/Facebook) connector_key and is also this codebase's single most
 * common generic JSON-envelope field name (`{ data, meta: {...} }`
 * pagination/warning wrapper) and destructuring target (`const { meta } =
 * acc`) -- reviewed 2026-08-10 (ri-zero-knowledge-terminal-revise-0810): no
 * RI production file uses the KEY name "meta" to mean the Meta connector
 * anywhere in the current tree (grep-verified against every flagged site
 * before adding this entry), so this entry does not reopen a real gap. A
 * genuine `{ meta: CONNECTOR_SPECIFIC_HANDLER }` dispatch table would still
 * need `meta` to be a VALUE somewhere (unaffected) or use a different key
 * name for its OTHER connectors, at least one of which would still trip the
 * dispatch-table-value check.
 */
const GENERIC_KEY_NAME_VOCABULARY_COLLISIONS = new Set(["meta"]);

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

/** Collect every literal-bearing AST position in the file: object/pattern
 * property keys (only for objects proven to be dispatch tables, see
 * {@link objectExpressionsUsedAsDispatchTables}) and values (unconditional --
 * a value is an assertion, not a naming choice), array/Set elements,
 * variable-declarator initializers, binary comparison operands, and
 * switch-case tests. */
/** `ObjectExpression`/`ObjectPattern` branch of {@link collectLiteralPositions}:
 * appends the property KEY (only for a table proven used as dispatch, or
 * always for a destructuring pattern) and, for a real object literal, the
 * property VALUE. Split out purely to keep `collectLiteralPositions` itself
 * under the cognitive-complexity budget. */
function pushObjectPositions(
  node: Node,
  enclosingFunctionName: string | null,
  dispatchTables: ReadonlySet<Node>,
  sites: LiteralPosition[]
): void {
  const checkKeys = node.type === "ObjectPattern" || dispatchTables.has(node);
  for (const property of nodeArrayField(node, "properties")) {
    const keyNode = checkKeys ? objectPropertyKeyLiteralNode(property) : null;
    if (keyNode) {
      sites.push({ enclosingFunctionName, node: keyNode });
    }
    // Values: only for ObjectExpression (a literal being WRITTEN).
    // ObjectPattern's "value" side is a binding target (a variable being
    // declared), not a value position -- `const { gmail: TARGET } = x`
    // has no literal at TARGET.
    if (node.type === "ObjectExpression" && property.type === "ObjectProperty") {
      sites.push({ enclosingFunctionName, node: property.value as Node });
    }
  }
}

/** `ArrayExpression` and `new Set([...])` branch of {@link collectLiteralPositions}. */
function pushCollectionLiteralPositions(
  node: Node,
  enclosingFunctionName: string | null,
  sites: LiteralPosition[]
): void {
  if (node.type === "ArrayExpression") {
    for (const element of nodeArrayField(node, "elements")) {
      sites.push({ enclosingFunctionName, node: element });
    }
    return;
  }
  if (node.type === "NewExpression" && isIdentifier(node.callee as Node, "Set")) {
    const [first] = nodeArrayField(node, "arguments");
    if (first?.type === "ArrayExpression") {
      for (const element of nodeArrayField(first, "elements")) {
        sites.push({ enclosingFunctionName, node: element });
      }
    }
  }
}

function collectLiteralPositions(program: Node, analysis: FileAnalysis): LiteralPosition[] {
  const sites: LiteralPosition[] = [];
  const dispatchTables = objectExpressionsUsedAsDispatchTables(program, analysis);
  walk(program, (node, _parent, ancestors) => {
    const enclosingFunctionName = enclosingFunctionNameOf(ancestors);
    if (node.type === "ObjectExpression" || node.type === "ObjectPattern") {
      pushObjectPositions(node, enclosingFunctionName, dispatchTables, sites);
      return;
    }
    if (node.type === "ArrayExpression" || node.type === "NewExpression") {
      pushCollectionLiteralPositions(node, enclosingFunctionName, sites);
      return;
    }
    if (node.type === "VariableDeclarator" && node.init) {
      sites.push({ enclosingFunctionName, node: node.init as Node });
      return;
    }
    if (node.type === "BinaryExpression" && ["!=", "!==", "==", "===", "+"].includes(node.operator as string)) {
      // `+` (concatenation) operands are also checked as standalone
      // positions here (in addition to resolveStringValue's own concat
      // FOLDING when a `+` expression is itself the value at some other
      // site) -- catches `"gm" + suffix` where `suffix` is unresolvable but
      // "gm" alone is not a vocabulary term, while a bare literal operand
      // that IS a full vocabulary term on its own is still caught even if
      // concatenated with something unresolvable, matching "prohibited
      // anywhere" rather than only at the fully-folded top level.
      sites.push(
        { enclosingFunctionName, node: node.left as Node },
        { enclosingFunctionName, node: node.right as Node }
      );
      return;
    }
    if (node.type === "SwitchCase" && node.test) {
      sites.push({ enclosingFunctionName, node: node.test as Node });
    }
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
  } catch {
    return [];
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
