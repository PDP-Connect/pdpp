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
 *   4. `SANCTIONED_POLICY_RESOURCES` CONTENT check (ri-zero-knowledge-
 *      terminal-revise-0810): a sanctioned RI-owned JSON registry's PATH
 *      being allowlisted proves nothing about its CONTENT. This module also
 *      parses each such file's actual JSON and walks it for any string
 *      (object key, object value, or array element, at any depth) equal to
 *      a manifest-derived connector key or validation kind — moving a
 *      connector-identity fact out of `.ts` source and into a sibling
 *      RI-owned JSON file is exactly as much self-attested connector
 *      knowledge as the literal it replaced, reached via a different seam.
 *      A real manifest-root file (rule 3 above) is NOT subject to this
 *      check — a manifest's connector_id/connector_key/kind fields are its
 *      entire declared purpose.
 *   5. Rule (6): `eval(...)` and `node:child_process`'s shell-string exec
 *      family (`exec`/`execSync`, bound via a real `node:child_process`
 *      import — not the argv-array `execFile`/`execFileSync`/`spawn`/
 *      `spawnSync` forms, and not an unrelated same-named local like this
 *      codebase's own SQL `exec(query, params)` helper) are prohibited
 *      outright, unconditionally on whether their argument looks path-shaped.
 *      Both accept an arbitrary interpreted string this scanner cannot
 *      soundly analyze — `eval("require")("./gmail-policy.json")` never
 *      surfaces a literal `require`/`Import` callee node, and
 *      `execSync("cat gmail-policy.json")` is an arbitrary shell command
 *      line, not a structured path argument — so closing them by *detecting*
 *      a data read would mean evaluating arbitrary shell semantics (unbounded
 *      scope); closing them by flat prohibition matches this scanner's
 *      existing "fails closed on what it cannot prove" posture instead.
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

export interface DataLoadViolation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

const MANIFEST_ROOTS = ["reference-implementation/fixtures/seed-manifests", "packages/polyfill-connectors/manifests"];

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
 *
 * Empty as of `ri-zero-knowledge-terminal-revise-0810`: the two production
 * files that used to load a sibling RI-owned JSON registry through this
 * allowlist no longer do. `compact-record-history.ts`'s per-connector
 * fingerprint-exclusion policy is read generically from each connector's own
 * manifest (`compaction_fingerprint`, a real manifest read already governed
 * by the manifest-provenance check above, not this allowlist).
 * `version-disposition.ts`'s two remaining reference-controlled signals
 * split the same way: the manifest-declared `compaction_class` (also a real
 * manifest read, governed above) for the connector-fact half, and OPERATOR
 * RUNTIME STATE at `PDPP_COMPACTION_RESIDUE_REVIEW_PATH` — genuinely
 * external state read at request time, never RI-committed source or
 * RI-committed JSON, so it was never a candidate for this allowlist either
 * (see `reference-implementation/server/version-disposition.ts`'s own module
 * doc comment). Left as an explicit empty Map (not deleted) so a future
 * legitimate RI-owned sibling registry has an obvious, documented place to
 * register — adding an entry here is a real security decision, same bar as
 * `SANCTIONED_GENERIC_DATA_READ_CALL_SITES` below.
 */
const SANCTIONED_POLICY_RESOURCES: ReadonlyMap<string, ReadonlySet<string>> = new Map([]);

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
  // cpu-quota.ts reads /proc/self/cgroup and /proc/self/mountinfo -- Linux
  // kernel process-introspection paths exposing THIS process's own cgroup
  // membership and mount table, to correctly resolve nested cgroup CPU/
  // memory quota (a process's cgroup is almost never the mount root; the
  // module walks /proc/self/cgroup's own path up through the real mount
  // hierarchy from /proc/self/mountinfo) for sizing embedding concurrency.
  // Extensionless absolute OS paths are conservatively treated as possible
  // renamed data files by this scanner's own isDataResourceExtension
  // heuristic (ext === "" counts as data-shaped) -- this is that heuristic's
  // documented /proc/${pid}/status false-positive class (see this file's own
  // checkReadFileCall comment), not a connector/provider identity read.
  // cgroupMounted()'s own presence probe:
  "reference-implementation/server/cpu-quota.ts:150",
  // resolveV2CgroupDir()'s mountinfo + cgroup reads:
  "reference-implementation/server/cpu-quota.ts:580",
  "reference-implementation/server/cpu-quota.ts:585",
  // resolveV1ControllerDir()'s mountinfo + cgroup reads:
  "reference-implementation/server/cpu-quota.ts:626",
  "reference-implementation/server/cpu-quota.ts:631",
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
  // Re-derived 2026-08-10 (manual-upload-large-artifact RI-owner ruling closure):
  // moved from line 96 to 103 after unrelated edits earlier in the file (a
  // multi-line import and a multi-line type alias) added 7 net lines above
  // this call site -- the function itself is unchanged. This entry is
  // line-pinned by design (see this array's own doc comment above); it must
  // be re-derived whenever an edit anywhere above the call site shifts it.
  "reference-implementation/server/polyfill-manifest-reconcile.ts:103",
  // readReviewedCompactionResidueMap() in version-disposition.ts:
  // readFileSync(path, "utf8") where `path` is compactionResidueReviewPath()
  // — process.env.PDPP_COMPACTION_RESIDUE_REVIEW_PATH, an OPERATOR-supplied
  // runtime-state file path (default /var/lib/pdpp/compaction-residue-
  // review.json), never a connector-identity path. This is the operator
  // reviewed-residue judgment call ri-zero-knowledge-terminal-revise-0810
  // moved OUT of RI-committed JSON into external runtime state precisely
  // because it must never be self-attested connector data; the path itself
  // is env-configured operator input, the same class of call this allowlist
  // already covers (cache.ts:125, common.ts:35 above). Verified by direct
  // inspection: `path` here is never derived from a connector_id/stream, only
  // from an env var with a fixed /var/lib/pdpp-relative default.
  "reference-implementation/server/version-disposition.ts:238",
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
 * Recursively walk a parsed JSON value for any string that equals a
 * manifest-derived connector key or validation kind, appearing anywhere —
 * an object key, an object value, or an array element, at any depth. This
 * closes the sibling-JSON evasion one level deeper than the load-SITE check
 * `classifyResolved` already does: proving a `.json` file's PATH is
 * sanctioned (a manifest root, or an explicitly reviewed
 * `SANCTIONED_POLICY_RESOURCES` entry) says nothing about its CONTENT — an
 * RI-owned policy registry sitting at a sanctioned path could still contain
 * `{ "connector": "codex", ... }` self-attested connector-identity data, the
 * exact fact rules (1)/(6) forbid in `.ts` source, reached by moving it into
 * the sibling JSON instead. `ri-zero-knowledge-terminal-revise-0810`:
 * connector facts belong to connector-owned manifests or an operator-
 * authorized runtime input, never RI-committed JSON, regardless of which
 * load-site syntax or which sanctioned path reaches it.
 */
function findConnectorLiteralsInJsonValue(
  value: unknown,
  connectorKeys: ReadonlySet<string>,
  validationKinds: ReadonlySet<string>,
  found: Set<string>
): void {
  if (typeof value === "string") {
    if (connectorKeys.has(value)) {
      found.add(`hardcoded-connector-identity-literal:${value}`);
    } else if (validationKinds.has(value)) {
      found.add(`hardcoded-validation-kind-literal:${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      findConnectorLiteralsInJsonValue(element, connectorKeys, validationKinds, found);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, propertyValue] of Object.entries(value as Record<string, unknown>)) {
      if (connectorKeys.has(key)) {
        found.add(`hardcoded-connector-identity-literal:${key}`);
      } else if (validationKinds.has(key)) {
        found.add(`hardcoded-validation-kind-literal:${key}`);
      }
      findConnectorLiteralsInJsonValue(propertyValue, connectorKeys, validationKinds, found);
    }
  }
}

/**
 * Every distinct `rule:value` connector/kind literal found anywhere in the
 * JSON file at `resolvedRelPath`, or an empty set if the file does not exist
 * or does not parse as JSON (a parse failure here is not this function's
 * concern — `classifyResolved`'s own path-based checks, or the manifest-
 * provenance check, already govern whether an unparseable/absent file at a
 * sanctioned path is itself a violation).
 */
function connectorLiteralsInJsonFile(
  repoRoot: string,
  resolvedRelPath: string,
  connectorKeys: ReadonlySet<string>,
  validationKinds: ReadonlySet<string>
): Set<string> {
  const found = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(repoRoot, resolvedRelPath), "utf8"));
  } catch {
    return found;
  }
  findConnectorLiteralsInJsonValue(parsed, connectorKeys, validationKinds, found);
  return found;
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

// A resolved fragment is either "already a full repo-root-relative path"
// (anchored: __dirname itself, a nested join/resolve/fileURLToPath chain,
// a new URL(...) reference) or "bare text that still needs anchoring to
// SOME base directory" (a plain string/template literal, which only means
// something once joined onto a base — either the current file's own
// directory, when it's the outermost expression, or whatever base an
// enclosing join/resolve call already established).
type SegmentResult = { kind: "anchored"; relPath: string } | { kind: "bare"; text: string } | { kind: "unresolvable" };

const UNRESOLVABLE: SegmentResult = { kind: "unresolvable" };

/** `new URL(<path>, import.meta.url)` as a nested segment (not the top-level call rule (5) scans for directly). */
function resolveNewUrlSegment(expr: Node, analysis: FileAnalysis, depth: number, visiting: Set<string>): SegmentResult {
  const [first, second] = nodeArrayField(expr, "arguments");
  if (!(first && second && isImportMetaUrl(second))) {
    return UNRESOLVABLE;
  }
  const anchored = resolveAnchoredExpr(first, analysis, depth + 1, visiting);
  return anchored.kind === "static" ? { kind: "anchored", relPath: anchored.relPath } : UNRESOLVABLE;
}

/** `join(...)`/`resolve(...)`/`fileURLToPath(...)` as a nested segment. */
function resolveCallExpressionSegment(
  expr: Node,
  analysis: FileAnalysis,
  depth: number,
  visiting: Set<string>
): SegmentResult {
  const name = calleeName(expr.callee as Node);
  if (name === "join" || name === "resolve") {
    const joined = resolveJoinOrResolveCall(expr, analysis, depth, visiting);
    return joined.kind === "static" ? { kind: "anchored", relPath: joined.relPath } : UNRESOLVABLE;
  }
  if (name === "fileURLToPath") {
    const [first] = nodeArrayField(expr, "arguments");
    if (first) {
      const anchored = resolveAnchoredExpr(first, analysis, depth + 1, visiting);
      return anchored.kind === "static" ? { kind: "anchored", relPath: anchored.relPath } : UNRESOLVABLE;
    }
  }
  return UNRESOLVABLE;
}

/** A module-level `const` identifier reference, followed one hop via `analysis.moduleConsts` (cycle-guarded by `visiting`). */
function resolveIdentifierSegment(
  expr: Node,
  analysis: FileAnalysis,
  depth: number,
  visiting: Set<string>
): SegmentResult {
  const name = expr.name as string;
  if (visiting.has(name)) {
    return UNRESOLVABLE;
  }
  const decl = analysis.moduleConsts.get(name);
  if (!decl) {
    return UNRESOLVABLE;
  }
  visiting.add(name);
  const result = resolveSegment(decl, analysis, depth + 1, visiting);
  visiting.delete(name);
  return result;
}

/**
 * `<expr>.href` / `<expr>.pathname` off a resolvable base (typically a `new
 * URL(...)`) denotes the same resolved fragment as the base itself — e.g.
 * `import(new URL("./auth.ts", import.meta.url).href)`. `import.meta.url` is
 * handled separately via `isImportMetaUrl`/`isDirnameLikeExpr`. Any other
 * member access (e.g. `local.entryName`, a runtime lookup) is not statically
 * resolvable.
 */
function resolveMemberExpressionSegment(
  expr: Node,
  analysis: FileAnalysis,
  depth: number,
  visiting: Set<string>
): SegmentResult {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `expr.property` is `unknown` on the loosely-typed Node interface's index signature; the `as Node` cast changes the STATIC type only, not runtime nullability. `tsc --strict` raises no error on this file.
  const propName = (expr.property as Node)?.type === "Identifier" ? ((expr.property as Node).name as string) : null;
  if (propName === "href" || propName === "pathname") {
    return resolveSegment(expr.object as Node, analysis, depth + 1, visiting);
  }
  return UNRESOLVABLE;
}

/**
 * Resolve one expression to a segment fragment. `depth` guards recursion;
 * `visiting` guards identifier cycles. Dispatches by AST node type to one
 * resolver per shape — each resolver owns exactly the recursion/fallback
 * logic for its own shape, so this function stays a flat dispatch table.
 */
function resolveSegment(expr: Node, analysis: FileAnalysis, depth: number, visiting: Set<string>): SegmentResult {
  if (depth > 12) {
    return UNRESOLVABLE;
  }
  if (expr.type === "StringLiteral") {
    return { kind: "bare", text: expr.value as string };
  }
  if (expr.type === "TemplateLiteral") {
    const quasis = expr.quasis as Node[];
    // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `q.value` is `unknown` on Node's index signature; the `as { raw: string }` cast changes the STATIC type only, a real Babel TemplateElement's `raw` field is not statically guaranteed present at this cast site. `tsc --strict` raises no error on this file.
    return { kind: "bare", text: quasis.map((q) => (q.value as { raw: string }).raw ?? "").join(PLACEHOLDER) };
  }
  if (isDirnameLikeExpr(expr)) {
    return { kind: "anchored", relPath: analysis.fileDir };
  }
  if (expr.type === "NewExpression" && isIdentifier(expr.callee as Node, "URL")) {
    return resolveNewUrlSegment(expr, analysis, depth, visiting);
  }
  if (expr.type === "CallExpression") {
    return resolveCallExpressionSegment(expr, analysis, depth, visiting);
  }
  if (expr.type === "Identifier") {
    return resolveIdentifierSegment(expr, analysis, depth, visiting);
  }
  if (expr.type === "MemberExpression") {
    return resolveMemberExpressionSegment(expr, analysis, depth, visiting);
  }
  return UNRESOLVABLE;
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
  for (let i = 1; i < args.length; i += 1) {
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
    // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `node.object`/`node.property` are `unknown` on Node's index signature; the `as Node` casts change the STATIC type only, not runtime nullability. `tsc --strict` raises no error on this file.
    (node.object as Node)?.type === "MetaProperty" &&
    // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- same as above, for `node.property`.
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
    const [inner] = args;
    if (inner?.type === "CallExpression" && calleeName(inner.callee as Node) === "fileURLToPath") {
      const [innerFirst] = nodeArrayField(inner, "arguments");
      return innerFirst !== undefined && isImportMetaUrl(innerFirst);
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
 * Local names bound to `node:child_process`'s shell-string exec family
 * (`exec`, `execSync` — NOT `execFile`/`execFileSync`/`spawn`/`spawnSync`,
 * which take an argv array and cannot run an arbitrary shell command like
 * `cat gmail-policy.json`) via a real `import ... from "node:child_process"`
 * declaration — either a named import (`import { execSync } from
 * "node:child_process"`) or a namespace import accessed as a member
 * (`import * as cp from "node:child_process"; cp.execSync(...)`). Keyed off
 * the actual import binding, not the bare identifier text, so this cannot
 * collide with an unrelated same-named local (e.g. this codebase's own
 * `exec(query, params)` SQL helper in `lib/db.ts`).
 */
const SHELL_EXEC_EXPORTS = new Set(["exec", "execSync"]);

/** `import * as NAME from "node:child_process"` — NAME.exec/execSync is a namespaced shell-exec call. */
function namespaceSpecifierLocalName(specifier: Node): string | null {
  const local = nodeField(specifier, "local");
  return local?.type === "Identifier" ? (local.name as string) : null;
}

/** `import { exec as NAME } from "node:child_process"` (or unaliased) — NAME(...) is a direct shell-exec call. */
function shellExecImportSpecifierLocalName(specifier: Node): string | null {
  const imported = nodeField(specifier, "imported");
  const local = nodeField(specifier, "local");
  const importedName = imported?.type === "Identifier" ? (imported.name as string) : null;
  if (!(importedName && SHELL_EXEC_EXPORTS.has(importedName) && local?.type === "Identifier")) {
    return null;
  }
  return local.name as string;
}

function isChildProcessImportSource(stmt: Node): boolean {
  const source = nodeField(stmt, "source");
  return source?.type === "StringLiteral" && source.value === "node:child_process";
}

function collectChildProcessShellExecBindings(program: Node): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const stmt of nodeArrayField(program, "body")) {
    if (stmt.type !== "ImportDeclaration" || !isChildProcessImportSource(stmt)) {
      continue;
    }
    for (const specifier of nodeArrayField(stmt, "specifiers")) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        const namespaceName = namespaceSpecifierLocalName(specifier);
        if (namespaceName) {
          namespaces.add(namespaceName);
        }
      } else if (specifier.type === "ImportSpecifier") {
        const localName = shellExecImportSpecifierLocalName(specifier);
        if (localName) {
          names.add(localName);
        }
      }
    }
  }
  return { names, namespaces };
}

const SHELL_EXEC_MEMBER_NAMES = new Set(["exec", "execSync"]);

/** Rule (6) predicate: is `callee` an eval(...) call, or a direct/namespaced call to node:child_process's shell-string exec family? */
function isProhibitedEvasionMechanismCall(
  callee: Node,
  bindings: { names: Set<string>; namespaces: Set<string> }
): boolean {
  if (isIdentifier(callee, "eval")) {
    return true;
  }
  if (callee.type === "Identifier") {
    return bindings.names.has(callee.name as string);
  }
  if (callee.type === "MemberExpression") {
    const object = callee.object as Node;
    const property = callee.property as Node;
    return (
      // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `callee.object`/`callee.property` are `unknown` on Node's index signature; the `as Node` casts change the STATIC type only, not runtime nullability. `tsc --strict` raises no error on this file.
      object?.type === "Identifier" &&
      bindings.namespaces.has(object.name as string) &&
      // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- same as above, for `property`.
      property?.type === "Identifier" &&
      SHELL_EXEC_MEMBER_NAMES.has(property.name as string)
    );
  }
  return false;
}

/**
 * Scan one production file's AST for JSON/YAML-consuming data-load call
 * sites, independent of which JS syntax shape reaches the file.
 */
export function scanFileDataLoads(
  absPath: string,
  relPath: string,
  repoRoot: string,
  connectorKeys: ReadonlySet<string> = new Set(),
  validationKinds: ReadonlySet<string> = new Set()
): DataLoadViolation[] {
  const raw = readFileSync(absPath, "utf8");
  let program: Node;
  try {
    // `parseSource` selects the `.tsx`/`.jsx`-vs-plain-`.ts` plugin set by
    // extension (the `typescript` and `jsx` Babel parser plugins are
    // mutually exclusive for `.ts` sources — enabling both misparses a
    // type-cast or generic like `<T>` as a JSX element), so `.tsx`/`.jsx`
    // files (in scope since the P2/extension-scope fix) parse correctly
    // instead of silently falling into the catch-and-report-nothing branch
    // below on every real .tsx/.jsx production file.
    program = parseSource(raw, absPath);
  } catch (error) {
    // A file this scanner cannot parse is a file it cannot prove makes no
    // sibling-JSON/YAML data load carrying connector knowledge (rule 5) —
    // reporting nothing here would silently certify unsupported or
    // malformed production source as clean, the same fail-open gap already
    // closed on the identity scanner's side. Fail closed via the shared
    // typed contract (see that function's doc comment): a parse failure is
    // itself a violation, not a skip. `scanFile` collapses this against the
    // identity scanner's own parse-failure report for the same file into
    // one actionable violation.
    return [parseFailureViolation(relPath, error)];
  }

  const { moduleConsts, localFunctions } = collectConstsAndFunctions(program);
  const allCalls: Node[] = [];
  walk(program, (n) => {
    if (n.type === "CallExpression") {
      allCalls.push(n);
    }
  });

  const analysis: FileAnalysis = { allCalls, fileDir: dirname(relPath), localFunctions, moduleConsts, relPath };
  const childProcessShellExecBindings = collectChildProcessShellExecBindings(program);

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
      // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `parent.callee` is `unknown` on Node's index signature; the `as Node` cast changes the STATIC type only, not runtime nullability. `tsc --strict` raises no error on this file.
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
        // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `n.callee` is `unknown` on Node's index signature; the `as Node` cast changes the STATIC type only, not runtime nullability. `tsc --strict` raises no error on this file.
        (n.callee as Node)?.type === "MemberExpression" &&
        isIdentifier((n.callee as Node).object as Node, "JSON") &&
        isIdentifier((n.callee as Node).property as Node, "parse")
      ) {
        const [arg] = nodeArrayField(n, "arguments");
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

  /** `SANCTIONED_POLICY_RESOURCES` branch of {@link classifyResolved}: a
   * path-sanctioned RI-owned registry must ALSO carry no connector-literal
   * CONTENT (ri-zero-knowledge-terminal-revise-0810) — path allowlisting
   * alone is not trust. Returns true iff `target` matched this allowlist
   * (handled either way, clean or flagged); false means the caller must
   * fall through to the unsanctioned-path report. Split out purely to keep
   * `classifyResolved` itself under the cognitive-complexity budget. */
  function classifySanctionedPolicyResource(target: string, node: Node): boolean {
    if (!SANCTIONED_POLICY_RESOURCES.get(relPath)?.has(target)) {
      return false;
    }
    const literalsFound = connectorLiteralsInJsonFile(repoRoot, target, connectorKeys, validationKinds);
    if (literalsFound.size > 0) {
      report(node, "hardcoded-connector-literal-in-ri-owned-json");
    }
    return true;
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
      // A manifest-root file's own connector_id/connector_key/kind fields
      // are its ENTIRE declared purpose (that is what manifest provenance
      // MEANS) -- the content-literal check below applies to
      // SANCTIONED_POLICY_RESOURCES (RI-owned registries, which must carry
      // NO connector facts at all), not to a real manifest.
      if (manifestRootFileHasManifestProvenance(repoRoot, target)) {
        return;
      }
      report(node, "manifest-root-file-lacks-manifest-provenance");
      return;
    }
    if (classifySanctionedPolicyResource(target, node)) {
      return;
    }
    report(node, "unsanctioned-policy-resource-path");
  }

  /** Rule (6): eval(...) and child_process shell-exec calls, prohibited outright. Returns true if this call site was handled (report or no-op). */
  function checkProhibitedEvasionMechanism(node: Node, callee: Node): boolean {
    if (node.type !== "CallExpression" || !isProhibitedEvasionMechanismCall(callee, childProcessShellExecBindings)) {
      return false;
    }
    const siteKey = `${relPath}:${lineOf(node)}`;
    if (!SANCTIONED_GENERIC_DATA_READ_CALL_SITES.has(siteKey)) {
      report(node, "prohibited-data-load-evasion-mechanism");
    }
    return true;
  }

  /** require(...) reaching a sibling JSON/YAML resource. Returns true if this call site was handled. */
  function checkRequireCall(node: Node, callee: Node, enclosingFunctionName: string | null): boolean {
    if (!(node.type === "CallExpression" && isIdentifier(callee, "require"))) {
      return false;
    }
    const [first] = nodeArrayField(node, "arguments");
    if (!first) {
      return true;
    }
    return checkResolvedImportLikeSource(node, first, enclosingFunctionName);
  }

  /** Dynamic `import(...)` (a Babel `ImportExpression` node, not a `CallExpression` —
   * unlike `require(...)`, `@babel/parser` has never modeled dynamic import as a call
   * with an `Import` pseudo-callee; that legacy shape belongs to older non-Babel
   * parsers) reaching a sibling JSON/YAML resource. Returns true if this call site
   * was handled. */
  function checkDynamicImportExpression(node: Node, enclosingFunctionName: string | null): boolean {
    if (node.type !== "ImportExpression") {
      return false;
    }
    const source = nodeField(node, "source");
    if (!source) {
      return true;
    }
    return checkResolvedImportLikeSource(node, source, enclosingFunctionName);
  }

  /** Shared resolution/classification tail for `require(...)`'s and dynamic
   * `import(...)`'s first argument/`source`. Always returns true (the call site was
   * handled) — callers only reach this once they've confirmed the node shape matches. */
  function checkResolvedImportLikeSource(node: Node, first: Node, enclosingFunctionName: string | null): boolean {
    const siteKey = `${relPath}:${lineOf(node)}`;
    if (SANCTIONED_GENERIC_DATA_READ_CALL_SITES.has(siteKey)) {
      return true;
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
      return true;
    }
    const resolved = resolvePathArgument(first, analysis, enclosingFunctionName);
    const ext = resolved.kind === "static" && !resolved.relPath.includes(PLACEHOLDER) ? extname(resolved.relPath) : "";
    if (resolved.kind === "static" && !isDataResourceExtension(ext)) {
      // A statically-resolved non-data extension (.ts/.js/.node, etc.) is
      // ordinary code loading, out of rule (5)'s scope.
      return true;
    }
    classifyResolved(resolved, node);
    return true;
  }

  /** readFileSync(...) / readFile(...) (fs and fs/promises; data-only in this codebase). Returns true if this call site was handled. */
  function checkReadFileCall(
    node: Node,
    callee: Node,
    parent: Node | null,
    enclosingFunctionName: string | null
  ): boolean {
    const name = node.type === "CallExpression" ? calleeName(callee) : null;
    if (!(node.type === "CallExpression" && (name === "readFileSync" || name === "readFile"))) {
      return false;
    }
    const [first] = nodeArrayField(node, "arguments");
    if (!first) {
      return true;
    }
    const siteKey = `${relPath}:${lineOf(node)}`;
    if (SANCTIONED_GENERIC_DATA_READ_CALL_SITES.has(siteKey)) {
      return true;
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
      return true;
    }
    classifyResolved(resolved, node);
    return true;
  }

  function isDirectlyConsumedByReadOrImportCall(parent: Node | null): boolean {
    return (
      parent?.type === "CallExpression" &&
      (calleeName(parent.callee as Node) === "readFileSync" ||
        calleeName(parent.callee as Node) === "readFile" ||
        isIdentifier(parent.callee as Node, "require") ||
        // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `parent.callee` is `unknown` on Node's index signature; the `as Node` cast changes the STATIC type only, not runtime nullability. `tsc --strict` raises no error on this file.
        (parent.callee as Node)?.type === "Import")
    );
  }

  // new URL(<path>, import.meta.url) not already consumed by a
  // readFileSync/readFile/require/import call above (e.g. assigned to a
  // constant and passed elsewhere, or used directly as a fetch-able
  // resource reference) — still flagged if it resolves to a data-shaped
  // path outside the sanctioned set, since constructing the reference is
  // itself evidence of intent.
  function checkStandaloneNewUrl(
    node: Node,
    callee: Node,
    parent: Node | null,
    enclosingFunctionName: string | null
  ): void {
    if (!(node.type === "NewExpression" && isIdentifier(callee, "URL"))) {
      return;
    }
    // Skip if this NewExpression is directly the first argument of a
    // readFileSync/readFile/require/import call — already handled above
    // via resolvePathArgument's `new URL` branch reached from that call.
    if (isDirectlyConsumedByReadOrImportCall(parent)) {
      return;
    }
    const [first, second] = nodeArrayField(node, "arguments");
    if (!(first && second && isImportMetaUrl(second))) {
      return;
    }
    const siteKey = `${relPath}:${lineOf(node)}`;
    if (SANCTIONED_GENERIC_DATA_READ_CALL_SITES.has(siteKey)) {
      return;
    }
    const resolved = resolvePathArgument(first, analysis, enclosingFunctionName);
    const ext = resolved.kind === "static" && !resolved.relPath.includes(PLACEHOLDER) ? extname(resolved.relPath) : "";
    if (resolved.kind === "static" && !isDataResourceExtension(ext)) {
      return;
    }
    classifyResolved(resolved, node);
  }

  walk(program, (node, parent, ancestors) => {
    const enclosingFunctionName = enclosingFunctionNameOf(ancestors);

    if (node.type === "ImportExpression") {
      checkDynamicImportExpression(node, enclosingFunctionName);
      return;
    }
    if (node.type !== "CallExpression" && node.type !== "NewExpression") {
      return;
    }
    const callee = node.callee as Node;

    if (checkProhibitedEvasionMechanism(node, callee)) {
      return;
    }
    if (checkRequireCall(node, callee, enclosingFunctionName)) {
      return;
    }
    if (checkReadFileCall(node, callee, parent, enclosingFunctionName)) {
      return;
    }
    checkStandaloneNewUrl(node, callee, parent, enclosingFunctionName);
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
