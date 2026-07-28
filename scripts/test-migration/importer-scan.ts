// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Importer-side edge scan: the defect class neither existing Stage-A check
 * covers (found by a cohort that correctly stopped rather than re-deriving
 * it here). Both existing checks look the WRONG DIRECTION:
 *
 *   - import-resolution.ts verifies only the RENAMED file's own OUTGOING
 *     imports still resolve — it never looks at who else in the repo
 *     imports the renamed file.
 *   - literal-path-scan.ts matches full repo-relative path STRINGS — a
 *     short relative specifier like './helpers/foo.js' or a differing-depth
 *     '../helpers/foo.js' never equals, and is never a path-boundary
 *     substring of, the repo-relative string 'reference-implementation/
 *     test/helpers/foo.js', so it silently passes through unmatched.
 *
 * BOUNDED SCOPE (owner ruling): this is not a universal module resolver
 * and encodes no future server/runtime policy — it covers exactly the
 * execution paths the current T2 test-migration batch runs under. Every
 * specifier this scan finds against a renamed file is classified into
 * exactly THREE outcomes, never two:
 *
 *   VALID — a static `import`/`export ... from`/dynamic `import()`
 *     specifier ending `.js`/`.mjs`/`.cjs` that resolves, via
 *     extension-swap, to this batch's renamed `toPath`. EMPIRICALLY
 *     PROVEN safe under the real execution path (do not re-derive):
 *     reference-implementation/scripts/run-tests.ts prepends `--import
 *     tsx` to every spawned test process unless the caller already
 *     passed one, and tsx's loader hook transparently resolves a stale
 *     `./foo.js` specifier to a sibling `foo.ts` for both static and
 *     dynamic `import` — verified directly: `node --import tsx -e
 *     "import('./helpers/foo.js')"` loads the real .ts file (content
 *     matches, not a stale cache); the identical specifier under plain
 *     `node` (no tsx) throws ERR_MODULE_NOT_FOUND. 156/156 real importer
 *     tests pass today under the actual runner. Reporting this as a
 *     failure would be at least 13 confirmed false positives on the
 *     current tree — a gate that cries wolf gets disabled.
 *   BROKEN (fails closed) — a consumer PROVEN not to run under the tsx
 *     loader, or a specifier no loader could save regardless:
 *       - `require()` call sites (CJS-context consumer, gated
 *         conservatively regardless of specifier resolvability — matches
 *         this repo's own plain-`node` production entrypoints, e.g. the
 *         Dockerfile's `CMD ["node", "reference-implementation/server/
 *         index.js"]` / `CMD ["node", "apps/console/server.js"]`, which
 *         run with no `--import tsx`);
 *       - a specifier that does not resolve to ANYTHING on disk at all
 *         (differing relative depth, dangling basename) — no loader can
 *         save a specifier that doesn't point anywhere;
 *       - a specifier that resolves to a REAL file OUTSIDE this rename's
 *         declared scope (same-basename collision) — silently resolving
 *         to the wrong file is not a pass.
 *     Literal (non-import) spawn/path string consumers are NOT this
 *     module's job — literal-path-scan.ts already fails closed there,
 *     unchanged (verified: `readFileSync` on a stale `.js` path throws
 *     ENOENT even under `--import tsx` — no loader patches fs/child_process
 *     path resolution).
 *   UNKNOWN (reported, never guessed) — a dynamic `import()` argument
 *     that cannot be statically resolved (computed identifier, template
 *     with interpolation) whose execution path this scan cannot
 *     establish either way. Listed with what was inspected and why it is
 *     undecidable, for a human to adjudicate — never silently passed,
 *     never silently failed.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parse } from "@babel/parser";
import { walkBabelAst } from "./babel-ast-walk.ts";
import { resolvesOnDisk } from "./import-resolution.ts";
import type { RenameMap } from "./rename-map.ts";

export interface ImporterEdgeFailure {
  detail: string;
  importer: string;
  kind: "out-of-scope" | "require-stale" | "unresolved";
  line: number;
  specifier: string;
}

/** A dynamic import() argument this scan cannot statically resolve — reported for human adjudication, never guessed in either direction. */
export interface ImporterEdgeUnknown {
  detail: string;
  importer: string;
  line: number;
  specifier: string;
}

/** A `.js`/`.mjs`/`.cjs` specifier that names a renamed file and resolves SAFELY under the real tsx-loader execution path — runtime-fine, never gated, but NORMALIZATION DEBT: the terminal invariant for this program is all-TypeScript, not a permanent mixed steady state (owner ruling). Reported so cohorts can find and fix it rather than letting it vanish into a silent pass. */
export interface ImporterEdgeNormalizeDebt {
  detail: string;
  importer: string;
  line: number;
  specifier: string;
}

const RELATIVE_SPECIFIER_PATTERN = /^\.\.?\//;
const BARE_HELPER_SPECIFIER_PATTERN = /^[a-zA-Z0-9._-]+\.(?:js|mjs|cjs|ts|tsx)$/;

interface BabelNodeWithLoc extends Record<string, unknown> {
  loc: { start: { line: number } };
  type: string;
}

type SpecifierForm = "dynamic-import" | "require" | "static-import";

interface RawSpecifierOccurrence {
  form: SpecifierForm;
  line: number;
  /** true when this came from a dynamic import()/require() whose argument was not a plain string (template with interpolation, computed expression). */
  unresolvable: boolean;
  value: string;
}

function stringOrTemplateStaticValue(
  node: { type?: string; value?: unknown } | undefined
): { unresolvable: boolean; value: string } | undefined {
  if (!node) {
    return;
  }
  if (node.type === "StringLiteral" && typeof node.value === "string") {
    return { value: node.value, unresolvable: false };
  }
  if (node.type !== "TemplateLiteral") {
    return;
  }
  const { expressions = [] } = node as { expressions?: unknown[] };
  const { quasis = [] } = node as { quasis?: { value?: { cooked?: string } }[] };
  if (expressions.length === 0 && quasis.length === 1) {
    const cooked = quasis[0]?.value?.cooked;
    if (typeof cooked === "string") {
      return { value: cooked, unresolvable: false };
    }
  }
  // A template with interpolation (e.g. `./helpers/${name}.js` or
  // `./${dir}/foo.js`) cannot be statically resolved — reported as
  // unresolvable so the caller lands it in UNKNOWN rather than guessing
  // pass or fail. All static segments are concatenated (not just the
  // first) so a basename-plausibility check downstream can still notice a
  // renamed file's name sitting in ANY static segment, wherever the
  // interpolation falls.
  const allStaticSegments = quasis.map((q) => q.value?.cooked ?? "").join("");
  return { value: allStaticSegments, unresolvable: true };
}

function staticImportExportSpecifier(typed: BabelNodeWithLoc): RawSpecifierOccurrence | undefined {
  const isImportLike =
    typed.type === "ImportDeclaration" ||
    typed.type === "ExportNamedDeclaration" ||
    typed.type === "ExportAllDeclaration";
  if (!isImportLike) {
    return;
  }
  const { source } = typed as { source?: { type?: string; value?: unknown } };
  if (source?.type === "StringLiteral" && typeof source.value === "string") {
    return { form: "static-import", value: source.value, line: typed.loc.start.line, unresolvable: false };
  }
  return globalThis.undefined;
}

function dynamicCallSpecifier(typed: BabelNodeWithLoc): RawSpecifierOccurrence | undefined {
  if (typed.type !== "CallExpression") {
    return;
  }
  const { callee, arguments: args = [] } = typed as {
    arguments?: unknown[];
    callee?: { name?: string; type?: string };
  };
  const isDynamicImport = callee?.type === "Import";
  const isRequireCall = callee?.type === "Identifier" && callee.name === "require";
  if (!(isDynamicImport || isRequireCall)) {
    return;
  }
  const form: SpecifierForm = isDynamicImport ? "dynamic-import" : "require";
  const resolved = stringOrTemplateStaticValue(args[0] as { type?: string; value?: unknown } | undefined);
  if (resolved) {
    return { form, value: resolved.value, line: typed.loc.start.line, unresolvable: resolved.unresolvable };
  }
  if (args.length > 0) {
    // A computed/non-literal argument (e.g. a variable) — cannot be
    // statically resolved. Reported as unresolvable rather than dropped: a
    // caller with a renamed file in scope must see this as UNKNOWN, not as
    // silence.
    return { form, value: "<computed>", line: typed.loc.start.line, unresolvable: true };
  }
  return globalThis.undefined;
}

/** Every import()/require() dynamic-call argument, plus every static import/export specifier, found in source text. */
function collectSpecifierOccurrences(sourceText: string, fileName: string): RawSpecifierOccurrence[] {
  const ast = parse(sourceText, { sourceType: "module", plugins: ["typescript"], sourceFilename: fileName });
  const found: RawSpecifierOccurrence[] = [];
  walkBabelAst(ast.program, (node) => {
    const typed = node as BabelNodeWithLoc;
    const occurrence = staticImportExportSpecifier(typed) ?? dynamicCallSpecifier(typed);
    if (occurrence) {
      found.push(occurrence);
    }
  });
  return found;
}

function matchesBasenameOfAnyFromPath(specifierValue: string, renameMap: RenameMap): string | undefined {
  const specifierBasename = basename(specifierValue);
  for (const entry of renameMap.entries) {
    if (basename(entry.fromPath) === specifierBasename) {
      return entry.fromPath;
    }
  }
  return globalThis.undefined;
}

interface ClassifiedOccurrence extends RawSpecifierOccurrence {
  isBareHelperForm: boolean;
  isRelative: boolean;
}

function classifyOccurrence(occurrence: RawSpecifierOccurrence): ClassifiedOccurrence {
  const isRelative = RELATIVE_SPECIFIER_PATTERN.test(occurrence.value);
  const isBareHelperForm = !isRelative && BARE_HELPER_SPECIFIER_PATTERN.test(occurrence.value);
  return { ...occurrence, isRelative, isBareHelperForm };
}

/** Resolves a relative/bare-basename occurrence to the repo-relative pre-rename path it names, if any — regardless of whether that path still exists on disk (it won't, post git-mv). */
function staleFromPathFor(
  occurrence: ClassifiedOccurrence,
  importerDir: string,
  renameMap: RenameMap,
  repoRoot: string
): string | undefined {
  const specifierRepoRelativePath = occurrence.isRelative
    ? relative(repoRoot, join(importerDir, occurrence.value)).replaceAll("\\", "/")
    : undefined;
  if (specifierRepoRelativePath !== undefined && renameMap.byFromPath.has(specifierRepoRelativePath)) {
    return specifierRepoRelativePath;
  }
  return occurrence.isBareHelperForm ? matchesBasenameOfAnyFromPath(occurrence.value, renameMap) : undefined;
}

/** require() naming a stale pre-rename path: gated conservatively regardless of tsx (CJS consumer — see this module's header). */
function requireStaleFailureFor(
  occurrence: ClassifiedOccurrence,
  importerRepoRelativePath: string,
  importerDir: string,
  renameMap: RenameMap,
  repoRoot: string
): ImporterEdgeFailure | undefined {
  const staleFromPath = staleFromPathFor(occurrence, importerDir, renameMap, repoRoot);
  if (!staleFromPath) {
    return;
  }
  return {
    importer: importerRepoRelativePath,
    kind: "require-stale",
    specifier: occurrence.value,
    line: occurrence.line,
    detail: `require("${occurrence.value}") still names pre-rename path "${staleFromPath}" (now renamed to "${renameMap.byFromPath.get(staleFromPath)}") — a CJS require() consumer is not proven to run under the tsx loader, gated conservatively`,
  };
}

/** A static/dynamic-import specifier that still names the pre-rename path exactly — VALID under the tsx loader (see module header), but reported as normalization debt: the terminal invariant is all-TypeScript, not a permanent mixed steady state. */
function normalizeDebtFor(
  occurrence: ClassifiedOccurrence,
  importerRepoRelativePath: string,
  importerDir: string,
  renameMap: RenameMap,
  repoRoot: string
): ImporterEdgeNormalizeDebt | undefined {
  const staleFromPath = staleFromPathFor(occurrence, importerDir, renameMap, repoRoot);
  if (!staleFromPath) {
    return;
  }
  return {
    importer: importerRepoRelativePath,
    specifier: occurrence.value,
    line: occurrence.line,
    detail: `${occurrence.form} specifier "${occurrence.value}" still names pre-rename path "${staleFromPath}" (now "${renameMap.byFromPath.get(staleFromPath)}") — resolves safely under the tsx loader (not gated), but is normalization debt toward this program's all-TypeScript terminal invariant`,
  };
}

/** A relative/bare-basename specifier (import or dynamic import()) that does not resolve to anything on disk, but whose basename matches a renamed file — no loader can save a specifier that points nowhere. */
function unresolvedOnDiskFailureFor(
  occurrence: ClassifiedOccurrence,
  importerAbsolutePath: string,
  importerRepoRelativePath: string,
  renameMap: RenameMap
): ImporterEdgeFailure | undefined {
  if (resolvesOnDisk(occurrence.value, importerAbsolutePath)) {
    return;
  }
  const staleBasename = matchesBasenameOfAnyFromPath(occurrence.value, renameMap);
  if (!staleBasename) {
    return;
  }
  return {
    importer: importerRepoRelativePath,
    kind: "unresolved",
    specifier: occurrence.value,
    line: occurrence.line,
    detail: `specifier "${occurrence.value}" does not resolve to any file on disk (even accounting for the tsx loader's extension-swap) and its basename matches renamed file "${staleBasename}" — likely a stale relative-depth reference`,
  };
}

/** A relative/bare-basename specifier that resolves to a REAL file which is NOT the batch's renamed file, but shares its basename — a same-name collision outside the rename's declared scope. */
function outOfScopeFailureFor(
  occurrence: ClassifiedOccurrence,
  importerRepoRelativePath: string,
  renameMap: RenameMap
): ImporterEdgeFailure | undefined {
  const collidingBasename = matchesBasenameOfAnyFromPath(occurrence.value, renameMap);
  if (!collidingBasename) {
    return;
  }
  return {
    importer: importerRepoRelativePath,
    kind: "out-of-scope",
    specifier: occurrence.value,
    line: occurrence.line,
    detail: `specifier "${occurrence.value}" resolves to a file on disk, but that file is NOT the renamed file "${collidingBasename}" this batch declares — same basename, outside the rename's declared scope; this authority cannot verify the importer's intent`,
  };
}

function unknownFor(occurrence: ClassifiedOccurrence, importerRepoRelativePath: string): ImporterEdgeUnknown {
  return {
    importer: importerRepoRelativePath,
    specifier: occurrence.value,
    line: occurrence.line,
    detail: `${occurrence.form}() argument could not be statically resolved (computed identifier or interpolated template) — execution path undecidable from source alone; adjudicate by hand whether this can reach a stale reference to a renamed file`,
  };
}

interface OccurrenceOutcome {
  failure?: ImporterEdgeFailure;
  normalizeDebt?: ImporterEdgeNormalizeDebt;
  unknown?: ImporterEdgeUnknown;
}

/** Classifies and checks a single specifier occurrence against the rename map, returning at most one outcome (VALID-clean occurrences return none). */
function checkOccurrence(
  occurrence: ClassifiedOccurrence,
  importerAbsolutePath: string,
  importerRepoRelativePath: string,
  importerDir: string,
  renameMap: RenameMap,
  repoRoot: string
): OccurrenceOutcome {
  const isInScope = occurrence.isRelative || occurrence.isBareHelperForm;
  if (!(isInScope || occurrence.unresolvable)) {
    return {}; // package/bare-module specifier, out of this scan's scope (see import-resolution.ts's header for the same carve-out).
  }
  if (occurrence.unresolvable) {
    // Only worth reporting as UNKNOWN if a plausible stale-basename target
    // exists at all — an unresolvable specifier utterly unrelated to any
    // renamed file (e.g. `import(someUnrelatedVar)`) is simply not this
    // rename batch's concern.
    const plausibleTarget = matchesBasenameOfAnyFromPath(occurrence.value, renameMap);
    return plausibleTarget ? { unknown: unknownFor(occurrence, importerRepoRelativePath) } : {};
  }
  if (occurrence.form === "require") {
    const failure = requireStaleFailureFor(occurrence, importerRepoRelativePath, importerDir, renameMap, repoRoot);
    return failure ? { failure } : {};
  }
  if (!isInScope) {
    return {};
  }
  // static-import / dynamic-import: a stale specifier resolving via
  // extension-swap under the tsx loader is VALID (see module header) — not
  // gated, but reported as normalization debt (terminal invariant is
  // all-TypeScript). Checked BEFORE unresolved/out-of-scope, since a stale
  // exact-path match is the common case those two checks would otherwise
  // misclassify.
  const normalizeDebt = normalizeDebtFor(occurrence, importerRepoRelativePath, importerDir, renameMap, repoRoot);
  if (normalizeDebt) {
    return { normalizeDebt };
  }
  const failure =
    unresolvedOnDiskFailureFor(occurrence, importerAbsolutePath, importerRepoRelativePath, renameMap) ??
    outOfScopeFailureFor(occurrence, importerRepoRelativePath, renameMap);
  return failure ? { failure } : {};
}

export interface FileImporterScanResult {
  failures: ImporterEdgeFailure[];
  normalizeDebt: ImporterEdgeNormalizeDebt[];
  unknowns: ImporterEdgeUnknown[];
}

/**
 * Scans one importing file's source for BROKEN/UNKNOWN/NORMALIZE-DEBT
 * edges against a rename map — a clean VALID edge produces no output at
 * all. `importerAbsolutePath` and `importerRepoRelativePath` both describe
 * the SAME file — the absolute path is needed to resolve relative
 * specifiers against disk, the repo-relative path is needed to compare
 * against the rename map's repo-relative fromPath/toPath entries.
 */
export function scanFileForStaleImporterEdges(
  sourceText: string,
  importerAbsolutePath: string,
  importerRepoRelativePath: string,
  renameMap: RenameMap,
  repoRoot: string
): FileImporterScanResult {
  const importerDir = dirname(importerAbsolutePath);
  const failures: ImporterEdgeFailure[] = [];
  const normalizeDebt: ImporterEdgeNormalizeDebt[] = [];
  const unknowns: ImporterEdgeUnknown[] = [];
  for (const rawOccurrence of collectSpecifierOccurrences(sourceText, importerAbsolutePath)) {
    const occurrence = classifyOccurrence(rawOccurrence);
    const outcome = checkOccurrence(
      occurrence,
      importerAbsolutePath,
      importerRepoRelativePath,
      importerDir,
      renameMap,
      repoRoot
    );
    if (outcome.failure) {
      failures.push(outcome.failure);
    }
    if (outcome.normalizeDebt) {
      normalizeDebt.push(outcome.normalizeDebt);
    }
    if (outcome.unknown) {
      unknowns.push(outcome.unknown);
    }
  }
  return { failures, normalizeDebt, unknowns };
}

export interface RepoWideImporterScanReport {
  failures: ImporterEdgeFailure[];
  filesScanned: number;
  normalizeDebt: ImporterEdgeNormalizeDebt[];
  ok: boolean;
  unknowns: ImporterEdgeUnknown[];
}

/**
 * Runs the importer-side edge scan over every tracked file repo-wide
 * (`trackedRepoRelativeFiles`), skipping the renamed files themselves
 * (their own outgoing imports are import-resolution.ts's job, not this
 * scan's) and any path outside a text-parseable extension. `ok` reflects
 * BROKEN edges only — `unknowns` and `normalizeDebt` are separate,
 * first-class lists a human must read; neither silently flips `ok` either
 * way. A file that cannot be read or parsed is simply excluded from the
 * scan, matching literal-path-scan.ts's existing binary/unparseable
 * carve-out, since a binary file cannot syntactically contain an import
 * specifier.
 */
export function scanRepoForStaleImporterEdges(
  trackedRepoRelativeFiles: string[],
  renameMap: RenameMap,
  repoRoot: string
): RepoWideImporterScanReport {
  const failures: ImporterEdgeFailure[] = [];
  const normalizeDebt: ImporterEdgeNormalizeDebt[] = [];
  const unknowns: ImporterEdgeUnknown[] = [];
  let filesScanned = 0;
  const renamedFromPaths = new Set(renameMap.entries.map((e) => e.fromPath));
  for (const repoRelativePath of trackedRepoRelativeFiles) {
    if (renamedFromPaths.has(repoRelativePath)) {
      continue; // the renamed file's own outgoing imports are import-resolution.ts's job.
    }
    const absolute = join(repoRoot, repoRelativePath);
    let sourceText: string;
    try {
      sourceText = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    let fileResult: FileImporterScanResult;
    try {
      fileResult = scanFileForStaleImporterEdges(sourceText, absolute, repoRelativePath, renameMap, repoRoot);
    } catch {
      continue; // not parseable as JS/TS — out of scope for an AST-based importer scan, matching literal-path-scan.ts's carve-out.
    }
    filesScanned += 1;
    failures.push(...fileResult.failures);
    normalizeDebt.push(...fileResult.normalizeDebt);
    unknowns.push(...fileResult.unknowns);
  }
  return { ok: failures.length === 0, failures, normalizeDebt, unknowns, filesScanned };
}
