// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AST-based data-resource-load scanner backing the zero-connector-knowledge
 * conformance guard's rule (5).
 *
 * The rest of the guard (`ri-zero-connector-knowledge-scan.ts`, rules 1-4) is
 * a deliberate text-structural scan over string literals — that non-goal is
 * still correct for THOSE rules (see the change's design.md). This module
 * exists because rule (5) makes a load-site-closure claim ("RI code cannot
 * evade the identity/endpoint/env-key rules by moving the same facts into a
 * sibling data file") that a single regex over one JS syntax shape cannot
 * actually back up: `readFileSync`, `require`, dynamic `import()`, static
 * `import ... with { type: "json" }`, and `new URL(..., import.meta.url)`
 * piped through `join`/`resolve` are all distinct AST shapes reaching the
 * identical sibling file with identical runtime behavior. A syntax-specific
 * regex closes exactly one of those shapes and is silent about the rest.
 *
 * This scanner instead parses each production file with `@babel/parser`
 * (real AST, TypeScript syntax, no dependency on the `typescript` package's
 * unstable compiler internals) and:
 *   1. Finds every JSON/YAML-consuming call site — `readFileSync`/`readFile`
 *      (data-only in this codebase; never used to load executable code) and
 *      `require`/dynamic `import`/static json-attribute imports whose target
 *      resolves to (or cannot be proven not to be) a `.json`/`.yaml`/`.yml`
 *      resource, or whose result flows into `JSON.parse`.
 *   2. Statically resolves each call's path argument via a bounded,
 *      single-file constant-folder: string/template literals,
 *      `join`/`resolve` call trees, `import.meta.url`/`__dirname`
 *      resolution, module-level `const` identifier chains (fixed-point,
 *      cycle-guarded), and — for non-exported same-file helper functions —
 *      one hop of parameter resolution to the union of that function's own
 *      call-site arguments.
 *   3. Classifies the resolved (or unresolved) target: legitimate if it
 *      lands inside a sanctioned manifest root WITH the manifest-content
 *      provenance check (a `connector_id`/`connector_key` string field —
 *      not path-prefix alone), matches the closed `SANCTIONED_POLICY_RESOURCES`
 *      allowlist, or matches the closed, human-reviewed
 *      `SANCTIONED_GENERIC_DATA_READ_CALL_SITES` allowlist for call sites
 *      proven (by inspection, recorded here) to read operator/CLI-path or
 *      tooling data that never carries connector/provider identity.
 *      EVERYTHING ELSE — including a call whose path argument could not be
 *      statically resolved at all — is a violation. There is no default-pass
 *      branch for "couldn't figure it out."
 *
 * Residual, disclosed precisely (not silently accepted): this is still a
 * single-file analysis. It does not follow a value across a cross-module
 * function call (e.g. an exported helper whose caller lives in a different
 * file), and does not evaluate arbitrary computed property access, string
 * concatenation with a non-const runtime value, or a value that has been
 * reassigned after its declaration. Any of those shapes hits the
 * "unresolvable → violation" branch rather than silently passing — the gate
 * fails closed on what it cannot prove, per design.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";

import { parse } from "@babel/parser";

export interface DataLoadViolation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

const MANIFEST_ROOTS = ["reference-implementation/manifests", "packages/polyfill-connectors/manifests"];

/**
 * The complete, hand-maintained allowlist of RI-owned policy resources a
 * production file may load. Keyed by the exact production file path (repo
 * root relative) that may load it, mapping to the exact resolved sibling
 * path (also repo-root relative) it may load. This is deliberately NOT
 * auto-derived: these are RI-maintainer-owned security registries that must
 * never be self-attested by a manifest or connector, so the allowlist itself
 * has to be a closed, PR-reviewed set. It contains no connector names, only
 * file-path pairs, so it does not reintroduce the violation class the guard
 * exists to forbid.
 */
const SANCTIONED_POLICY_RESOURCES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "reference-implementation/server/version-disposition.ts",
    new Set(["reference-implementation/server/version-disposition-policy.json"]),
  ],
  [
    "reference-implementation/scripts/compact-record-history.ts",
    new Set(["reference-implementation/scripts/compact-record-history-local-device-policy.json"]),
  ],
]);

/**
 * Closed, human-reviewed allowlist of call sites (file + 1-indexed line of
 * the read call) that consume JSON but were individually inspected and
 * confirmed to never carry connector/provider identity: CLI-operator-
 * supplied paths (cache files, stdin/`-`, artifact staging paths), quality-
 * ratchet/build tooling reading its own baseline/config files, and the
 * repo's own `package.json`. Each entry records WHY in a trailing comment so
 * a future reviewer can re-verify rather than trust the list blindly. Adding
 * an entry here is a real security decision, same bar as
 * `SANCTIONED_POLICY_RESOURCES` — it must be re-derived if the line moves
 * for an unrelated reason (a stale entry simply stops matching and the call
 * site starts failing the gate again, fail-closed by construction).
 */
const SANCTIONED_GENERIC_DATA_READ_CALL_SITES: ReadonlySet<string> = new Set([
  // readJson<T>(path): path is the CLI's own token-cache directory, operator/OS-derived, never connector-identity data.
  "reference-implementation/cli/lib/cache.ts:125",
  // readJsonInput(pathOrDash): explicit CLI `--file`/stdin argument, generic JSON-in-JSON-out CLI utility.
  "reference-implementation/cli/lib/common.ts:35",
  // check-direct-prepare-conformance.ts is itself a lint tool; it reads the file paths given to it by its own CLI arguments to scan their text, not connector policy.
  "reference-implementation/scripts/check-direct-prepare-conformance.ts:102",
  // run-tests.ts reads an optional operator-supplied --accounting-authority path; test-accounting shape, not connector identity.
  "reference-implementation/scripts/run-tests.ts:90",
  // apply-browser-surface-replacement-correction.ts reads an operator-supplied --artifact repair-script path.
  "reference-implementation/scripts/repair/apply-browser-surface-replacement-correction.ts:112",
  // quality-ratchet tooling reads its own mass-baseline.json/package.json config, no connector identity.
  "reference-implementation/scripts/quality-ratchet/measure-mass.ts:243",
  "reference-implementation/scripts/quality-ratchet/mass-delta-report.ts:134",
  "reference-implementation/scripts/quality-ratchet/check-mass-ratchet.ts:94",
  // reference-revision.ts reads the repo's own package.json for its version string.
  "reference-implementation/server/reference-revision.ts:17",
  // readManifestJson(path) in polyfill-manifest-reconcile.ts: both call sites
  // pass join(<manifest-root-derived-dir>, entryName) (defaultPolyfillManifestsDir()
  // / defaultReferenceFixturesDir(), both resolve()'d off the two sanctioned
  // manifest roots), but through 2 hops of parameter indirection
  // (readManifestJson's own `path` param, fed by loadReferenceFixtureFingerprints's/
  // reconcilePolyfillManifests's `referenceFixturesDir`/`manifestsDir` params) —
  // one hop deeper than this scanner's bounded parameter resolver follows.
  // Verified by direct inspection, not by the scanner, hence the allowlist entry.
  "reference-implementation/server/polyfill-manifest-reconcile.ts:96",
]);

/** Directory segments, relative to a production scan root (e.g. `server/`),
 * that are exempt end-to-end (not just at the top level): connector-owned
 * code and generated/doc output that never contains hand-authored production
 * logic. Unlike the legacy any-depth exemption this replaces, this list is
 * matched only against paths already known to be test-free — `*.test.ts` is
 * excluded by filename regardless of directory. */
const EXEMPT_DIR_SEGMENTS = new Set(["connectors", "generated", "docs", "openapi"]);

function isDataResourceExtension(ext: string): boolean {
  return ext === ".json" || ext === ".yaml" || ext === ".yml" || ext === "";
}

/** A relative specifier (`./x`, `../x`) can only ever name a sibling file in
 * this repo; anything else (a bare package name, a `node:` builtin, an
 * absolute path) is a code-loading specifier, never a connector-data file. */
function isRelativeSpecifierLiteral(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
}

function isUnderSanctionedManifestRoot(resolvedRelPath: string): boolean {
  return MANIFEST_ROOTS.some((root) => resolvedRelPath === root || resolvedRelPath.startsWith(`${root}/`));
}

/**
 * Manifest-root trust requires real content provenance, not path prefix
 * alone (a `.json` file dropped next to real manifests with no manifest
 * shape must still be rejected). A manifest is proven legitimate if it
 * parses as JSON and declares a non-empty string `connector_id` or
 * `connector_key` — the same two fields `manifestDerivedConnectorKeys` in
 * the sibling literal-scan module already requires to treat a file as a real
 * manifest.
 */
function manifestRootFileHasManifestProvenance(repoRoot: string, resolvedRelPath: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(join(repoRoot, resolvedRelPath), "utf8"));
  } catch {
    return false;
  }
  const key = parsed.connector_key;
  const id = parsed.connector_id;
  return (typeof key === "string" && key.length > 0) || (typeof id === "string" && id.length > 0);
}

// --- Babel AST node shapes used below (loosely typed: @babel/parser's AST
// is a plain discriminated-union object tree; we only need a handful of
// fields per node type, so a minimal structural type is enough here and
// keeps this module decoupled from @babel/types version churn). ---

interface Node {
  end?: number | null;
  loc?: { start: { line: number } } | null;
  start?: number | null;
  type: string;
  [key: string]: unknown;
}

/**
 * Read a Babel AST array-valued field (`arguments`, `declarations`,
 * `params`, `quasis`, `attributes`/`assertions`, `body`) as `Node[]`,
 * defaulting to `[]` when absent. Centralizes the `(x.field as Node[]) ??
 * []` cast so the fallback stays genuinely meaningful to the type checker
 * (the field really is `unknown` on the loosely-typed `Node` interface,
 * unlike a per-site `as Node[]` cast, which erases that and makes the `??`
 * look like dead code).
 */
function nodeArrayField(node: Node, field: string): Node[] {
  const value = node[field];
  return Array.isArray(value) ? (value as Node[]) : [];
}

/** Read a Babel AST node-valued field, or undefined if absent — same
 * cast-centralizing rationale as `nodeArrayField`. */
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

/**
 * Nearest enclosing TOP-LEVEL named `function foo(...) {}` declaration
 * (matching `localFunctions`' collection scope), or null if `node` is not
 * lexically inside one (module-level code, or inside an arrow function/
 * nested function declaration — deliberately not resolved through those,
 * since `localFunctions` only tracks top-level declarations). Walking from
 * the END of `ancestors` finds the nearest (innermost) enclosing function
 * first, so a function nested inside another top-level function correctly
 * resolves to its OWN immediate parent, not the outermost one — though in
 * practice `localFunctions` only recognizes the outer one as call-site-
 * indirectable, so a doubly-nested reference simply won't resolve, which is
 * the fail-closed behavior this scanner wants.
 */
function enclosingFunctionNameOf(ancestors: Node[]): string | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i] as Node;
    const id = ancestor.id as Node | undefined;
    if (ancestor.type === "FunctionDeclaration" && id?.type === "Identifier") {
      return id.name as string;
    }
  }
  return null;
}

function lineOf(node: Node): number {
  return node.loc?.start.line ?? 0;
}

// --- Resolved-path representation: either a fully static relative path
// (possibly containing PLACEHOLDER segments standing in for runtime
// interpolation), or "unresolvable". A path containing PLACEHOLDER is only
// trusted if the manifest-root check still holds after substitution --
// PLACEHOLDER can never make an out-of-root path look in-root, since the
// directory portion up to the last statically-known segment is unaffected.

type ResolvedPath = { kind: "static"; relPath: string } | { kind: "unresolvable" };

const PLACEHOLDER = " DYNAMIC ";

function joinRelative(baseDir: string, ...parts: string[]): string {
  // Manual POSIX-style join + normalize (avoids node:path's OS-specific
  // behavior; this scanner only ever deals with repo-relative forward-slash
  // paths). ".." pops a segment; "." is dropped; PLACEHOLDER segments are
  // preserved verbatim since they are opaque to path arithmetic.
  const segments = [...baseDir.split("/"), ...parts.flatMap((p) => p.split("/"))];
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

interface FileAnalysis {
  /** All call expressions anywhere in the file, for parameter-resolution
   * call-site lookup. */
  allCalls: Node[];
  fileDir: string;
  /** Non-exported top-level function declarations, by name, so a parameter
   * can be resolved to the union of its own call sites (single hop). */
  localFunctions: Map<string, { params: string[]; exported: boolean }>;
  /** Module-level `const NAME = <init>` declarators, by name. Used to
   * resolve identifiers like `__dirname`/`REFERENCE_MANIFESTS_DIR`. */
  moduleConsts: Map<string, Node>;
  relPath: string;
}

function isIdentifier(node: Node, name?: string): boolean {
  return node.type === "Identifier" && (name === undefined || node.name === name);
}

function calleeName(callee: Node): string | null {
  if (callee.type === "Identifier") {
    return callee.name as string;
  }
  if (callee.type === "MemberExpression" && (callee.property as Node)?.type === "Identifier") {
    return (callee.property as Node).name as string;
  }
  return null;
}

// A resolved fragment is either "already a full repo-root-relative path"
// (anchored: __dirname itself, a nested join/resolve/fileURLToPath chain,
// a new URL(...) reference) or "bare text that still needs anchoring to
// SOME base directory" (a plain string/template literal, which only means
// something once joined onto a base — either the current file's own
// directory, when it's the outermost expression, or whatever base an
// enclosing join/resolve call already established).
type SegmentResult = { kind: "anchored"; relPath: string } | { kind: "bare"; text: string } | { kind: "unresolvable" };

/**
 * Resolve one expression to a segment fragment. `depth` guards recursion;
 * `visiting` guards identifier cycles.
 */
function resolveSegment(expr: Node, analysis: FileAnalysis, depth: number, visiting: Set<string>): SegmentResult {
  if (depth > 12) {
    return { kind: "unresolvable" };
  }

  if (expr.type === "StringLiteral") {
    return { kind: "bare", text: expr.value as string };
  }

  if (expr.type === "TemplateLiteral") {
    const quasis = expr.quasis as Node[];
    return { kind: "bare", text: quasis.map((q) => (q.value as { raw: string }).raw ?? "").join(PLACEHOLDER) };
  }

  if (isDirnameLikeExpr(expr)) {
    return { kind: "anchored", relPath: analysis.fileDir };
  }

  if (expr.type === "NewExpression" && isIdentifier(expr.callee as Node, "URL")) {
    const args = nodeArrayField(expr, "arguments");
    const first = args[0];
    const second = args[1];
    if (first && second && isImportMetaUrl(second)) {
      const anchored = resolveAnchoredExpr(first, analysis, depth + 1, visiting);
      return anchored.kind === "static" ? { kind: "anchored", relPath: anchored.relPath } : { kind: "unresolvable" };
    }
    return { kind: "unresolvable" };
  }

  if (expr.type === "CallExpression") {
    const name = calleeName(expr.callee as Node);
    if (name === "join" || name === "resolve") {
      const joined = resolveJoinOrResolveCall(expr, analysis, depth, visiting);
      return joined.kind === "static" ? { kind: "anchored", relPath: joined.relPath } : { kind: "unresolvable" };
    }
    if (name === "fileURLToPath") {
      const args = nodeArrayField(expr, "arguments");
      if (args[0]) {
        const anchored = resolveAnchoredExpr(args[0] as Node, analysis, depth + 1, visiting);
        return anchored.kind === "static" ? { kind: "anchored", relPath: anchored.relPath } : { kind: "unresolvable" };
      }
    }
    return { kind: "unresolvable" };
  }

  if (expr.type === "Identifier") {
    const name = expr.name as string;
    if (visiting.has(name)) {
      return { kind: "unresolvable" };
    }
    const decl = analysis.moduleConsts.get(name);
    if (decl) {
      visiting.add(name);
      const result = resolveSegment(decl, analysis, depth + 1, visiting);
      visiting.delete(name);
      return result;
    }
    return { kind: "unresolvable" };
  }

  if (expr.type === "MemberExpression") {
    // `import.meta.url` handled above via isImportMetaUrl/isDirnameLikeExpr.
    // `<expr>.href` / `<expr>.pathname` off a resolvable base (typically a
    // `new URL(...)`) denotes the same resolved fragment as the base itself
    // — e.g. `import(new URL("./auth.ts", import.meta.url).href)`. Any
    // other member access (e.g. `local.entryName`, a runtime lookup) is not
    // statically resolvable.
    const propName = (expr.property as Node)?.type === "Identifier" ? ((expr.property as Node).name as string) : null;
    if (propName === "href" || propName === "pathname") {
      return resolveSegment(expr.object as Node, analysis, depth + 1, visiting);
    }
    return { kind: "unresolvable" };
  }

  return { kind: "unresolvable" };
}

/** A segment used as plain text WITHIN a join/resolve call (never
 * independently anchored to the current file, even if it happens to be an
 * "anchored" fragment like __dirname — joining __dirname as a later
 * argument is nonsensical but if it occurs, its resolved path is still the
 * correct text to append). */
function segmentAsJoinArgText(result: SegmentResult): string | typeof PLACEHOLDER {
  if (result.kind === "bare") {
    return result.text;
  }
  if (result.kind === "anchored") {
    return result.relPath;
  }
  return PLACEHOLDER;
}

/**
 * Resolve a `join(...)`/`resolve(...)` call to a full repo-root-relative
 * path. The FIRST argument anchors the call (resolved via the ANCHORED
 * resolver, so a bare relative literal there is still relative to the
 * current file — matching Node's own `path.join`/`path.resolve` semantics
 * where the first segment is the base). Every subsequent argument is plain
 * segment text (never independently anchored to the current file) — an
 * unresolvable later argument (e.g. a `readdirSync` loop variable naming a
 * specific file) degrades to a PLACEHOLDER segment rather than aborting
 * resolution outright, the same "select a specific file within an
 * already-resolved directory" shape a template-literal interpolation
 * already represents.
 */
function resolveJoinOrResolveCall(
  expr: Node,
  analysis: FileAnalysis,
  depth: number,
  visiting: Set<string>
): ResolvedPath {
  const args = nodeArrayField(expr, "arguments");
  if (args.length === 0) {
    return { kind: "unresolvable" };
  }
  const firstResolved = resolveAnchoredExpr(args[0] as Node, analysis, depth + 1, visiting);
  if (firstResolved.kind !== "static") {
    return { kind: "unresolvable" };
  }
  const resolvedParts: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const r = resolveSegment(args[i] as Node, analysis, depth + 1, visiting);
    resolvedParts.push(segmentAsJoinArgText(r));
  }
  return { kind: "static", relPath: joinRelative(firstResolved.relPath, ...resolvedParts) };
}

/**
 * Resolve one TOP-LEVEL path-argument expression (the thing passed to
 * `readFileSync`/`require`/dynamic `import`/`new URL(..., import.meta.url)`,
 * or the anchor argument of a `join`/`resolve` call) to a static
 * repo-root-relative path, or "unresolvable". A bare string/template
 * literal here IS anchored to `analysis.fileDir` (this is the "path
 * relative to the current file" position); an "anchored" fragment
 * (`__dirname`, a nested join/resolve chain) is already a full path and is
 * NOT re-prefixed with fileDir again.
 */
function resolveAnchoredExpr(expr: Node, analysis: FileAnalysis, depth: number, visiting: Set<string>): ResolvedPath {
  if (depth > 12) {
    return { kind: "unresolvable" };
  }
  if (expr.type === "CallExpression") {
    const name = calleeName(expr.callee as Node);
    if (name === "join" || name === "resolve") {
      return resolveJoinOrResolveCall(expr, analysis, depth, visiting);
    }
  }
  const segment = resolveSegment(expr, analysis, depth, visiting);
  if (segment.kind === "anchored") {
    return { kind: "static", relPath: segment.relPath };
  }
  if (segment.kind === "bare") {
    return { kind: "static", relPath: joinRelative(analysis.fileDir, segment.text) };
  }
  return { kind: "unresolvable" };
}

/** Backwards-compatible alias used by callers below. */
function resolveExpr(expr: Node, analysis: FileAnalysis, depth: number, visiting: Set<string>): ResolvedPath {
  return resolveAnchoredExpr(expr, analysis, depth, visiting);
}

/**
 * Resolve `expr` to its plain literal string value (following identifier/
 * const indirection, NOT anchored to any directory) — used to classify a
 * `require`/`import()` specifier as bare-vs-relative BEFORE anchoring, since
 * anchoring a bare specifier like `"web-push"` to the current file's
 * directory would wrongly make it look like a relative sibling path.
 * Returns null if `expr` doesn't resolve to a plain bare/relative literal
 * (e.g. it resolves to an "anchored" fragment like `__dirname`, or is
 * unresolvable) — callers treat null as "cannot prove it's a bare
 * specifier," not as "it must be a data path."
 */
function resolveToLiteralStringValue(expr: Node, analysis: FileAnalysis): string | null {
  const segment = resolveSegment(expr, analysis, 0, new Set());
  return segment.kind === "bare" ? segment.text : null;
}

function isImportMetaUrl(node: Node): boolean {
  return (
    node.type === "MemberExpression" &&
    (node.object as Node)?.type === "MetaProperty" &&
    (node.property as Node)?.type === "Identifier" &&
    (node.property as Node).name === "url"
  );
}

function isDirnameLikeExpr(node: Node): boolean {
  if (isIdentifier(node, "__dirname")) {
    return true;
  }
  // dirname(fileURLToPath(import.meta.url)) inlined at the call site.
  if (node.type === "CallExpression" && calleeName(node.callee as Node) === "dirname") {
    const args = nodeArrayField(node, "arguments");
    const inner = args[0];
    if (inner?.type === "CallExpression" && calleeName(inner.callee as Node) === "fileURLToPath") {
      const innerArgs = nodeArrayField(inner, "arguments");
      return innerArgs[0] !== undefined && isImportMetaUrl(innerArgs[0]);
    }
  }
  return false;
}

/**
 * Resolve a call argument that is a reference to the parameter of its own
 * LEXICALLY ENCLOSING same-file, non-exported function: trace to the union
 * of that parameter's own call-site arguments (one hop; each call-site
 * argument is resolved independently and all must agree on the same static
 * path for the parameter to be trusted — disagreement or any unresolvable
 * call site makes the parameter unresolvable, fail-closed).
 *
 * `enclosingFunctionName` MUST be the function that lexically contains
 * `expr` (computed once per call site by the caller via ancestor tracking),
 * not just any same-file function that happens to share a parameter name —
 * two unrelated functions in the same file coincidentally both naming a
 * parameter `file` must not cross-resolve one via the other's call sites.
 */
function resolveViaParameterIndirection(
  expr: Node,
  analysis: FileAnalysis,
  enclosingFunctionName: string | null,
  depth: number,
  visiting: Set<string>
): ResolvedPath | null {
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
    const r = resolveExpr(argNode, analysis, depth + 1, visiting);
    if (r.kind !== "static") {
      return { kind: "unresolvable" };
    }
    if (agreed === null) {
      agreed = r.relPath;
    } else if (agreed !== r.relPath) {
      return { kind: "unresolvable" };
    }
  }
  return agreed === null ? { kind: "unresolvable" } : { kind: "static", relPath: agreed };
}

function resolvePathArgument(expr: Node, analysis: FileAnalysis, enclosingFunctionName: string | null): ResolvedPath {
  const direct = resolveExpr(expr, analysis, 0, new Set());
  if (direct.kind === "static") {
    return direct;
  }
  const viaParam = resolveViaParameterIndirection(expr, analysis, enclosingFunctionName, 0, new Set());
  return viaParam ?? { kind: "unresolvable" };
}

/**
 * Collect every `const NAME = <init>` declarator anywhere in the file
 * (module-level or nested inside a function body — e.g. a local `const
 * moduleSpecifier = "./x.ts"` right above a dynamic `import()`), plus every
 * top-level function declaration (for parameter indirection).
 *
 * This is deliberately NOT real lexical scoping — it is a flat, whole-file
 * name table. Two DIFFERENT bindings that happen to share a name (e.g. the
 * same local variable name reused in two unrelated functions) are ambiguous
 * under a flat table; rather than guess which one a given reference means,
 * a name bound to more than one syntactically-distinct initializer anywhere
 * in the file is deliberately dropped from the table entirely, so any
 * reference to it resolves to "unresolvable" — fail-closed, matching this
 * module's stated residual, rather than silently picking the wrong binding.
 * `let`/`var` declarators are excluded outright: they can be reassigned
 * after declaration, so trusting their initializer would be unsound even
 * with no naming collision at all.
 */
function collectModuleConstsAndFunctions(program: Node): {
  moduleConsts: Map<string, Node>;
  localFunctions: Map<string, { params: string[]; exported: boolean }>;
} {
  const moduleConsts = new Map<string, Node>();
  const ambiguousNames = new Set<string>();
  const localFunctions = new Map<string, { params: string[]; exported: boolean }>();

  function paramNames(params: Node[]): string[] {
    return params.filter((p) => p.type === "Identifier").map((p) => p.name as string);
  }

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

/**
 * Scan one production file's AST for JSON/YAML-consuming data-load call
 * sites, independent of which JS syntax shape reaches the file.
 */
export function scanFileDataLoads(absPath: string, relPath: string, repoRoot: string): DataLoadViolation[] {
  const raw = readFileSync(absPath, "utf8");
  let ast: Node;
  try {
    ast = parse(raw, {
      errorRecovery: true,
      plugins: ["typescript", "importAttributes"],
      sourceType: "module",
    }) as unknown as Node;
  } catch {
    // A file that fails to parse is scanned by the literal-regex rules
    // elsewhere; this scanner reports nothing rather than crashing the
    // whole guard on one malformed file.
    return [];
  }

  const program = ast.program as Node;
  const { moduleConsts, localFunctions } = collectModuleConstsAndFunctions(program);
  const allCalls: Node[] = [];
  walk(program, (n) => {
    if (n.type === "CallExpression") {
      allCalls.push(n);
    }
  });

  const analysis: FileAnalysis = { allCalls, fileDir: dirname(relPath), localFunctions, moduleConsts, relPath };

  // Build declarator-init -> name map up front so flowsIntoJsonParse's
  // variable-binding branch can resolve `const raw = readFileSync(...)`.
  const declaratorNameByInit = new Map<Node, string>();
  walk(program, (n) => {
    const nId = n.id as Node | undefined;
    if (n.type === "VariableDeclarator" && nId?.type === "Identifier" && n.init) {
      declaratorNameByInit.set(n.init as Node, nId.name as string);
    }
  });
  function flowsIntoJsonParse(callNode: Node, parent: Node | null): boolean {
    if (
      parent?.type === "CallExpression" &&
      (parent.callee as Node)?.type === "MemberExpression" &&
      isIdentifier((parent.callee as Node).object as Node, "JSON") &&
      isIdentifier((parent.callee as Node).property as Node, "parse")
    ) {
      return true;
    }
    const initNode = parent?.type === "AwaitExpression" ? parent : callNode;
    const boundName = declaratorNameByInit.get(initNode);
    if (!boundName) {
      return false;
    }
    let found = false;
    walk(program, (n) => {
      if (found) {
        return;
      }
      if (
        n.type === "CallExpression" &&
        (n.callee as Node)?.type === "MemberExpression" &&
        isIdentifier((n.callee as Node).object as Node, "JSON") &&
        isIdentifier((n.callee as Node).property as Node, "parse")
      ) {
        const args = nodeArrayField(n, "arguments");
        const arg = args[0];
        if (arg && isIdentifier(arg, boundName)) {
          found = true;
        }
      }
    });
    return found;
  }

  const violations: DataLoadViolation[] = [];
  const reportedLines = new Set<number>();

  function report(node: Node, rule: string): void {
    const line = lineOf(node);
    const key = line;
    if (reportedLines.has(key)) {
      return;
    }
    reportedLines.add(key);
    const lineText = raw.split("\n")[line - 1]?.trim() ?? "";
    violations.push({ file: relPath, line, rule, snippet: lineText });
  }

  function classifyResolved(resolved: ResolvedPath, node: Node): void {
    if (resolved.kind === "unresolvable") {
      report(node, "unresolvable-data-resource-load");
      return;
    }
    const target = resolved.relPath;
    if (target.includes(PLACEHOLDER)) {
      // Dynamic (interpolated) path: only legitimate if the STATIC prefix
      // (everything before the first placeholder segment) already lands
      // inside a sanctioned manifest root — the normal "select a manifest by
      // connector id" shape. A placeholder can only narrow within whatever
      // directory the static prefix names; it can never escape upward past
      // it (no "../" can appear inside an interpolated segment's runtime
      // value in a way that changes the STATIC prefix's directory), so
      // checking the static prefix is sound.
      const staticPrefix = target.slice(0, target.indexOf(PLACEHOLDER));
      const staticDir = staticPrefix.endsWith("/") ? staticPrefix.slice(0, -1) : dirname(staticPrefix);
      if (isUnderSanctionedManifestRoot(staticDir) || MANIFEST_ROOTS.includes(staticPrefix)) {
        return;
      }
      report(node, "dynamic-connector-derived-resource-path");
      return;
    }
    if (isUnderSanctionedManifestRoot(target)) {
      if (manifestRootFileHasManifestProvenance(repoRoot, target)) {
        return;
      }
      report(node, "manifest-root-file-lacks-manifest-provenance");
      return;
    }
    if (SANCTIONED_POLICY_RESOURCES.get(relPath)?.has(target)) {
      return;
    }
    report(node, "unsanctioned-policy-resource-path");
  }

  walk(program, (node, parent, ancestors) => {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") {
      return;
    }
    const callee = node.callee as Node;
    const enclosingFunctionName = enclosingFunctionNameOf(ancestors);

    // require(...) / dynamic import(...)
    const isRequire = node.type === "CallExpression" && isIdentifier(callee, "require");
    const isDynamicImport = node.type === "CallExpression" && callee.type === "Import";
    if (isRequire || isDynamicImport) {
      const args = nodeArrayField(node, "arguments");
      const first = args[0];
      if (!first) {
        return;
      }
      const siteKey = `${relPath}:${lineOf(node)}`;
      if (SANCTIONED_GENERIC_DATA_READ_CALL_SITES.has(siteKey)) {
        return;
      }
      // A bare specifier (no leading "./" or "../") — an npm package name,
      // a node: builtin, or an absolute/scoped specifier — is ordinary code
      // loading, never a relative sibling data file. Checked against the
      // resolved LITERAL VALUE (following identifier/const indirection),
      // not just the syntactic shape of `first` itself — a local `const
      // webPushPackageName = "web-push"` is exactly as much a bare
      // specifier as writing `import("web-push")` directly, and must not
      // be misread as "./web-push" once anchored to the current file.
      const literalValue = resolveToLiteralStringValue(first, analysis);
      if (literalValue !== null && !isRelativeSpecifierLiteral(literalValue)) {
        return;
      }
      const resolved = resolvePathArgument(first, analysis, enclosingFunctionName);
      const ext =
        resolved.kind === "static" && !resolved.relPath.includes(PLACEHOLDER) ? extname(resolved.relPath) : "";
      if (resolved.kind === "static" && !isDataResourceExtension(ext)) {
        // A statically-resolved non-data extension (.ts/.js/.node, etc.) is
        // ordinary code loading, out of rule (5)'s scope.
        return;
      }
      classifyResolved(resolved, node);
      return;
    }

    // readFileSync(...) / readFile(...) (fs and fs/promises; data-only in
    // this codebase — verified no production `.ts` file uses either to load
    // executable code).
    const name = node.type === "CallExpression" ? calleeName(callee) : null;
    if (node.type === "CallExpression" && (name === "readFileSync" || name === "readFile")) {
      const args = nodeArrayField(node, "arguments");
      const first = args[0];
      if (!first) {
        return;
      }
      const siteKey = `${relPath}:${lineOf(node)}`;
      if (SANCTIONED_GENERIC_DATA_READ_CALL_SITES.has(siteKey)) {
        return;
      }
      const consumesJson = flowsIntoJsonParse(node, parent);
      const resolved = resolvePathArgument(first, analysis, enclosingFunctionName);
      const isFullyStatic = resolved.kind === "static" && !resolved.relPath.includes(PLACEHOLDER);
      // The "no extension might be a renamed .json" heuristic only makes
      // sense against a FULLY STATIC literal path (the finding-#4 evasion:
      // `new URL("./policy", import.meta.url)`). A dynamic/interpolated
      // path with no extension (e.g. `/proc/${pid}/status`) is a runtime OS
      // path, not a renamed data file, and is correctly out of scope unless
      // it is separately JSON.parse-consumed.
      const looksLikeDataPath = isFullyStatic && isDataResourceExtension(extname(resolved.relPath));
      if (!(consumesJson || looksLikeDataPath)) {
        // Neither JSON.parse-consumed nor resolved to a data-shaped
        // extension: out of rule (5)'s scope (e.g. a DDL .js-as-text read,
        // a .gitignore read, a /proc status read, a raw secret-key-file
        // read). If the path is unresolvable AND the read is never
        // JSON-parsed, it cannot be a JSON/YAML policy load either.
        return;
      }
      classifyResolved(resolved, node);
      return;
    }

    // new URL(<path>, import.meta.url) not already consumed by a
    // readFileSync/readFile/require/import call above (e.g. assigned to a
    // constant and passed elsewhere, or used directly as a fetch-able
    // resource reference) — still flagged if it resolves to a data-shaped
    // path outside the sanctioned set, since constructing the reference is
    // itself evidence of intent.
    if (node.type === "NewExpression" && isIdentifier(callee, "URL")) {
      // Skip if this NewExpression is directly the first argument of a
      // readFileSync/readFile/require/import call — already handled above
      // via resolvePathArgument's `new URL` branch reached from that call.
      if (
        parent?.type === "CallExpression" &&
        (calleeName(parent.callee as Node) === "readFileSync" ||
          calleeName(parent.callee as Node) === "readFile" ||
          isIdentifier(parent.callee as Node, "require") ||
          (parent.callee as Node)?.type === "Import")
      ) {
        return;
      }
      const args = nodeArrayField(node, "arguments");
      const first = args[0];
      const second = args[1];
      if (!(first && second && isImportMetaUrl(second))) {
        return;
      }
      const siteKey = `${relPath}:${lineOf(node)}`;
      if (SANCTIONED_GENERIC_DATA_READ_CALL_SITES.has(siteKey)) {
        return;
      }
      const resolved = resolvePathArgument(first, analysis, enclosingFunctionName);
      const ext =
        resolved.kind === "static" && !resolved.relPath.includes(PLACEHOLDER) ? extname(resolved.relPath) : "";
      if (resolved.kind === "static" && !isDataResourceExtension(ext)) {
        return;
      }
      classifyResolved(resolved, node);
    }
  });

  // Static `import x from "./y.json" with { type: "json" }` (or legacy
  // `assert`) import declarations.
  for (const stmt of nodeArrayField(program, "body")) {
    if (stmt.type !== "ImportDeclaration") {
      continue;
    }
    const attributesField = nodeArrayField(stmt, "attributes");
    const attributes = attributesField.length > 0 ? attributesField : nodeArrayField(stmt, "assertions");
    const hasJsonType = attributes.some((a) => {
      const key = nodeField(a, "key");
      const value = nodeField(a, "value");
      return (
        key !== undefined && isIdentifier(key, "type") && value?.type === "StringLiteral" && value.value === "json"
      );
    });
    if (!hasJsonType) {
      continue;
    }
    const source = nodeField(stmt, "source");
    if (source?.type !== "StringLiteral") {
      report(stmt, "unresolvable-data-resource-load");
      continue;
    }
    const siteKey = `${relPath}:${lineOf(stmt)}`;
    if (SANCTIONED_GENERIC_DATA_READ_CALL_SITES.has(siteKey)) {
      continue;
    }
    const resolved: ResolvedPath = { kind: "static", relPath: joinRelative(analysis.fileDir, source.value as string) };
    classifyResolved(resolved, stmt);
  }

  return violations;
}

/**
 * Scan-root-relative exempt-path check: only the intended directories at
 * their intended depth are exempt, not any nested directory sharing a name.
 * `relPathFromScanRoot` is the file path relative to its production scan
 * root (e.g. `server/`), NOT the repo root.
 */
export function isExemptDataLoadPath(relPathFromScanRoot: string): boolean {
  const segments = relPathFromScanRoot.split("/");
  // Only a same-directory-as-root segment named in EXEMPT_DIR_SEGMENTS
  // (i.e. the FIRST path segment under the scan root) is exempt — matches
  // the real layout (`server/connectors/`, `runtime/generated/`, etc. all
  // sit directly under their scan root; there is no legitimate nested
  // `foo/connectors/bar.ts` shape in this codebase).
  return segments.length > 1 && EXEMPT_DIR_SEGMENTS.has(segments[0] as string);
}

export function collectRepoRelativeManifestJsonFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const manifestRoot of MANIFEST_ROOTS) {
    const dir = join(repoRoot, manifestRoot);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      out.push(relative(repoRoot, join(dir, file)));
    }
  }
  return out;
}
