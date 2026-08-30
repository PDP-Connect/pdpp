// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shadow-only incremental test selection.
 *
 * This module deliberately does not call runAuthority, change a workflow, or
 * decide CI status. It produces comparable evidence so a later rollout can be
 * checked against the existing full authority run.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
// biome-ignore lint/correctness/noUnresolvedImports: @babel/parser is resolved through the workspace's pinned pnpm dependency; Biome does not follow this package's export directory.
import { parse, parseExpression } from "@babel/parser";
import { walkBabelAst } from "../test-migration/babel-ast-walk.ts";
import {
  assertCleanSourceTree,
  checkInventory,
  classifyTrackedPath,
  contentDigest,
  gitHead,
  type Manifest,
  normalizePath,
  planFor,
  readManifest,
  sourceTreeDigest,
  stable,
  trackedFiles,
} from "./inventory.ts";
import { type RuntimeEdge, sourceResolvesEdge } from "./packet.ts";

export const INCREMENTAL_SELECTOR_SCHEMA = "pdpp.test-accounting.incremental-selector/v1";
export const INCREMENTAL_GRAPH_SCHEMA = "pdpp.test-accounting.incremental-graph/v1";
export const SHADOW_RECEIPT_SCHEMA = "pdpp.test-accounting.shadow-receipt/v1";
export const AUTHORITY_REPORT_SCHEMA = "pdpp.test-accounting.authority-report/v1";
export const SELECTOR_VERSION = "incremental-selector-1";
export const MAX_REVERSE_TEST_FILES = 20;
export const MAX_REVERSE_SUITE_FRACTION = 0.25;
export const MAX_REVERSE_PRODUCTION_FAN_IN = 20;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const CODE_PATTERN = /\.(?:[cm]?js|tsx?|mts|cts)$/;
const EXECUTABLE_GRAPH_PATTERN = /\.(?:[cm]?js|tsx?|mts|cts|sh|py)$/;
const SHELL_OR_PYTHON_PATTERN = /\.(?:sh|py)$/;
const COMMAND_ARGUMENT_PATTERN = /\s+/;
const STATUS_PATTERN = /^[ACDMRTUXB][0-9]*$/;
const SPEC_FILE_PATTERN = /^spec-[^/]+\.md$/;
const GENERATOR_PATH_PATTERN = /\/generate(?:[-.]|\/)|\/sync-spec-docs\./;
const NOOP_PATHS = new Set(["README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "LICENSE", "LICENSE-docs"]);
const PROTECTED_CONFIG_NAMES = new Set([
  "biome.json",
  "biome.jsonc",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Dockerfile",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "postcss.config.js",
  "postcss.config.mjs",
  "postcss.config.ts",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  "webpack.config.js",
  "webpack.config.ts",
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.runner.json",
  "tsconfig.scripts.json",
  "vite.config.ts",
  "vite.config.js",
  "rollup.config.ts",
  "rollup.config.js",
]);

export type ShadowMode = "incremental" | "full-fallback";
export type FallbackReason =
  | "accounting-ownership"
  | "base-head-mismatch"
  | "closure-budget"
  | "deleted-or-renamed-path"
  | "diff-unavailable"
  | "empty-diff"
  | "graph-budget"
  | "graph-incomplete"
  | "high-fan-in"
  | "malformed-diff"
  | "multi-suite"
  | "no-test-closure"
  | "protected-build-input"
  | "protected-ci"
  | "protected-contract"
  | "protected-schema-or-sql"
  | "protected-selector-or-authority"
  | "profile-family"
  | "unsupported-diff-status"
  | "unmapped-path";

export interface DiffEntry {
  old_path?: string;
  path: string;
  status: string;
}

export interface FallbackClassification {
  detail: string;
  path: string;
  reason: FallbackReason;
}

export interface GraphLimits {
  max_depth: number;
  max_edges: number;
  max_millis: number;
  max_nodes: number;
}

export interface GraphNode {
  kind: "executable" | "helper-or-fixture" | "other";
  path: string;
}

export interface GraphEdge {
  declaration: string | null;
  from: string;
  kind: "literal" | "dynamic" | "spawn";
  target: string;
}

export interface GraphIssue {
  detail: string;
  from: string;
  kind: "parse" | "unresolved-literal" | "unknown-dynamic" | "unknown-subprocess";
}

export interface IncrementalGraph {
  complete: boolean;
  digest: string;
  edges: GraphEdge[];
  head_sha: string;
  issues: GraphIssue[];
  limits: GraphLimits;
  nodes: GraphNode[];
  schema: typeof INCREMENTAL_GRAPH_SCHEMA;
  selector_version: typeof SELECTOR_VERSION;
  source_tree_sha256: string;
}

export interface SelectedRun {
  files: string[];
  profile: string;
  suite: string;
}

export interface ShadowSelection {
  advertised_files: string[];
  base_sha: string;
  changed_paths: string[];
  diff: DiffEntry[];
  fallback_detail: string | null;
  fallback_reason: FallbackReason | null;
  graph: IncrementalGraph | null;
  head_sha: string;
  mode: ShadowMode;
  observed_head_sha: string;
  overhead_ms: number;
  protected_paths: FallbackClassification[];
  raw_diff_sha256: string;
  selected_runs: SelectedRun[];
  selector_schema: typeof INCREMENTAL_SELECTOR_SCHEMA;
  selector_version: typeof SELECTOR_VERSION;
}

export interface ShadowReceipt extends ShadowSelection {
  authority_report_identity: string | null;
  binding_sha256: string;
  ci_green: boolean;
  created_at: string;
  honored_files: string[];
  schema: typeof SHADOW_RECEIPT_SCHEMA;
  shadow_only: boolean;
  terminal_status: "shadow-only" | "full-fallback";
}

export interface AuthorityReport {
  head_sha: string;
  schema: typeof AUTHORITY_REPORT_SCHEMA;
  status: "green";
}

export interface UnknownShadowReport {
  ci_green: false;
  head_sha: string | null;
  reason: "receipt-missing" | "receipt-invalid";
  schema: typeof SHADOW_RECEIPT_SCHEMA;
  shadow_only: true;
  terminal_status: "unknown";
}

export const DEFAULT_GRAPH_LIMITS: GraphLimits = {
  max_nodes: 10_000,
  max_edges: 50_000,
  max_depth: 100,
  max_millis: 10_000,
};

function fail(message: string): never {
  throw new Error(`incremental selector: ${message}`);
}

function validateGraphLimits(limits: GraphLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(`graph limit ${name} must be a positive integer`);
    }
  }
}

function compare(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function sortedUnique(paths: Iterable<string>): string[] {
  return [...new Set([...paths].map(normalizePath))].sort(compare);
}

function packageRoot(path: string): string | null {
  const parts = path.split("/");
  if (parts[0] === "packages" && parts[1]) {
    return parts.slice(0, 2).join("/");
  }
  if (parts[0] === "apps" && parts[1]) {
    return parts.slice(0, 2).join("/");
  }
  if (parts[0] === "reference-implementation") {
    return parts[0];
  }
  if (parts[0] === "scripts" || parts[0] === "deploy") {
    return parts[0];
  }
  return null;
}

function isGenerated(path: string): boolean {
  return (
    path.split("/").some((part) => part === ".next" || part === "dist" || part === "build" || part === "generated") ||
    basename(path).includes("generated")
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this ordered predicate is the protected-surface policy; splitting it would hide precedence between contract, schema, and build reasons.
export function classifyProtectedPath(pathValue: string): FallbackClassification | null {
  const path = normalizePath(pathValue);
  const parts = path.split("/");
  const name = basename(path);
  if (path.startsWith(".github/workflows/") || path.startsWith(".github/actions/")) {
    return { path, reason: "protected-ci", detail: "CI workflow/action input changes the gate itself" };
  }
  if (path.startsWith(".github/")) {
    return { path, reason: "protected-ci", detail: "CI configuration changes the gate itself" };
  }
  if (
    path.startsWith("scripts/test-accounting/") ||
    path.startsWith("scripts/stream-health-audit/") ||
    path === "scripts/ci-mode.ts" ||
    path === "reference-implementation/scripts/run-tests.ts" ||
    path.endsWith("/authority.ts") ||
    path.endsWith("/authority.test.ts")
  ) {
    return {
      path,
      reason: "protected-selector-or-authority",
      detail: "selector, accounting, or authority code is protected",
    };
  }
  if (name.includes("selector")) {
    return { path, reason: "protected-selector-or-authority", detail: "selector input is not a leaf" };
  }
  if (
    parts.includes("contract") ||
    parts.includes("contracts") ||
    path.startsWith("packages/list-envelope/") ||
    path.includes("/ref/list-envelope.")
  ) {
    return { path, reason: "protected-contract", detail: "shared contract input is not a leaf" };
  }
  if (path.startsWith("scripts/build") || path.startsWith("scripts/check-generated")) {
    return { path, reason: "protected-build-input", detail: "build or generated-artifact producer is shared" };
  }
  if (path.startsWith("packages/reference-contract/") || path.startsWith("openspec/") || SPEC_FILE_PATTERN.test(path)) {
    return { path, reason: "protected-contract", detail: "contract, protocol, or OpenSpec input is shared" };
  }
  if (
    parts.includes("schema") ||
    parts.includes("schemas") ||
    parts.includes("sql") ||
    parts.includes("migrations") ||
    name.endsWith(".sql") ||
    name.includes("schema") ||
    name.includes("manifest") ||
    name === "pnpm-lock.yaml" ||
    name === "package-lock.json" ||
    name === "yarn.lock" ||
    name === "bun.lockb" ||
    name === "pnpm-workspace.yaml"
  ) {
    return {
      path,
      reason: "protected-schema-or-sql",
      detail: "schema, SQL, migration, manifest, or workspace input is shared",
    };
  }
  if (isGenerated(path)) {
    return { path, reason: "protected-build-input", detail: "generated output or its path is not a leaf input" };
  }
  if (GENERATOR_PATH_PATTERN.test(`/${path}`)) {
    return { path, reason: "protected-build-input", detail: "generator or generated-artifact producer is shared" };
  }
  if (name.endsWith("package.json") || PROTECTED_CONFIG_NAMES.has(name) || name === "package.json") {
    return { path, reason: "protected-build-input", detail: "package or build configuration changes resolution" };
  }
  if (
    path.startsWith("deploy/") ||
    path.startsWith("vendor/") ||
    path.includes("/vendor/") ||
    path.startsWith("docker/")
  ) {
    return { path, reason: "protected-build-input", detail: "deployment, vendor, or Docker input is shared" };
  }
  if (path.includes("release-policy") || path.startsWith(".changeset/")) {
    return { path, reason: "protected-build-input", detail: "release policy input is shared" };
  }
  return null;
}

function isApprovedPath(pathValue: string): boolean {
  const path = normalizePath(pathValue);
  if (NOOP_PATHS.has(path)) {
    return true;
  }
  const root = packageRoot(path);
  if (!root) {
    return false;
  }
  if (root === "scripts" || root === "deploy") {
    return CODE_PATTERN.test(path) && !path.startsWith("scripts/test-accounting/");
  }
  return CODE_PATTERN.test(path);
}

export function classifyChangedPath(pathValue: string): FallbackClassification | null {
  const protectedPath = classifyProtectedPath(pathValue);
  if (protectedPath) {
    return protectedPath;
  }
  return isApprovedPath(pathValue)
    ? null
    : {
        path: normalizePath(pathValue),
        reason: "unmapped-path",
        detail: "path is not in the versioned approved source/test mapping",
      };
}

/** Parse `git diff --no-renames --name-status -z` without newline or shell parsing. */
export function parseNulDiff(input: Buffer | string): DiffEntry[] {
  const raw = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (raw.length === 0) {
    return [];
  }
  if (raw.at(-1) !== 0) {
    fail("NUL diff is missing its terminal NUL record delimiter");
  }
  const fields = raw.toString("utf8").split("\0");
  fields.pop();
  const entries: DiffEntry[] = [];
  const originalByNormalizedPath = new Map<string, string>();
  const normalizeDiffPath = (path: string): string => {
    const normalized = normalizePath(path);
    const original = originalByNormalizedPath.get(normalized);
    if (original !== undefined && original !== path) {
      fail(`Unicode normalization collision: ${JSON.stringify(original)} and ${JSON.stringify(path)}`);
    }
    originalByNormalizedPath.set(normalized, path);
    return normalized;
  };
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    if (!(status && STATUS_PATTERN.test(status))) {
      fail(`malformed NUL diff status at record ${index}`);
    }
    const first = fields[index + 1];
    if (!first) {
      fail(`malformed NUL diff path for status ${status}`);
    }
    if (status[0] === "R" || status[0] === "C") {
      const second = fields[index + 2];
      if (!second) {
        fail(`malformed NUL diff pair for status ${status}`);
      }
      entries.push({ status, old_path: normalizeDiffPath(first), path: normalizeDiffPath(second) });
      index += 3;
    } else {
      entries.push({ status, path: normalizeDiffPath(first) });
      index += 2;
    }
  }
  return entries;
}

function exactDiff(root: string, baseSha: string, headSha: string): Buffer {
  try {
    return execFileSync("git", ["diff", "--no-renames", "--name-status", "-z", `${baseSha}..${headSha}`, "--"], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`diff-unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function assertExactHead(root: string, requestedHead: string): string {
  const observed = gitHead(root);
  if (observed !== requestedHead) {
    throw new Error(`base-head-mismatch: requested ${requestedHead}, observed ${observed}`);
  }
  if (!SHA_PATTERN.test(requestedHead)) {
    throw new Error("base-head-mismatch: head must be a full commit SHA");
  }
  return observed;
}

function assertBase(root: string, baseSha: string, headSha: string): void {
  if (!(SHA_PATTERN.test(baseSha) && SHA_PATTERN.test(headSha))) {
    throw new Error("base-head-mismatch: base and head must be full commit SHAs");
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", baseSha, headSha], { cwd: root, stdio: "ignore" });
  } catch (error) {
    throw new Error("base-head-mismatch: base is not an ancestor of head", { cause: error });
  }
}

interface ImportOccurrence {
  computed: boolean;
  kind: "literal" | "dynamic";
  line: number;
  source: "filesystem" | "module";
  specifier: string;
}

interface SpawnOccurrence {
  computed: boolean;
  line: number;
  specifier: string | null;
}

function shellOrPythonIssue(from: string): GraphIssue {
  return {
    from,
    kind: "unknown-subprocess",
    detail: "shell and Python executable syntax is not statically modeled",
  };
}

function staticTemplate(node: Record<string, unknown> | undefined): { value: string; computed: boolean } | undefined {
  if (!node) {
    return;
  }
  if (node.type === "StringLiteral" && typeof node.value === "string") {
    return { value: node.value, computed: false };
  }
  if (node.type === "TemplateLiteral") {
    const expressions = Array.isArray(node.expressions) ? node.expressions : [];
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    const value = quasis
      .map((item) => {
        const q = item as { value?: { cooked?: unknown } };
        return typeof q.value?.cooked === "string" ? q.value.cooked : "";
      })
      .join("");
    return { value, computed: expressions.length > 0 };
  }
  // biome-ignore lint/complexity/noUselessUndefined: the explicit absent-result return is required by noImplicitReturns.
  return undefined;
}

function staticArray(node: Record<string, unknown> | undefined): string[] | undefined {
  if (node?.type !== "ArrayExpression" || !Array.isArray(node.elements)) {
    return;
  }
  const values = node.elements.map((element) => staticTemplate(element as Record<string, unknown> | undefined));
  return values.every((value): value is { value: string; computed: boolean } => value !== undefined)
    ? values.map((value) => value.value)
    : undefined;
}

function collectOccurrences(source: string, file: string): { imports: ImportOccurrence[]; spawns: SpawnOccurrence[] } {
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx", "decorators-legacy", "importAttributes"],
    sourceFilename: file,
    errorRecovery: false,
  });
  const imports: ImportOccurrence[] = [];
  const spawns: SpawnOccurrence[] = [];
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each syntax form is checked in one visitor so the graph sees no parser-only shadow path.
  walkBabelAst(ast.program, (node) => {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(String(node.type))) {
      const sourceNode = node.source as Record<string, unknown> | undefined;
      const literal = staticTemplate(sourceNode);
      if (literal) {
        imports.push({
          kind: "literal",
          specifier: literal.value,
          line: Number((node.loc as { start: { line: number } }).start.line),
          computed: false,
          source: "module",
        });
      }
    }
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = node.callee as Record<string, unknown> | undefined;
    const args = Array.isArray(node.arguments) ? (node.arguments as Record<string, unknown>[]) : [];
    const line = Number((node.loc as { start: { line: number } }).start.line);
    if (callee?.type === "Import" || (callee?.type === "Identifier" && callee.name === "require")) {
      const literal = staticTemplate(args[0]);
      imports.push({
        kind: callee.type === "Import" ? "dynamic" : "literal",
        specifier: literal ? literal.value : "<computed>",
        line,
        computed: literal ? literal.computed : true,
        source: "module",
      });
    }
    const memberProperty =
      callee?.type === "MemberExpression" && !callee.computed
        ? (callee.property as Record<string, unknown> | undefined)?.name
        : undefined;
    const callName = callee?.type === "Identifier" ? callee.name : memberProperty;
    const filesystemRead = [
      "access",
      "createReadStream",
      "exists",
      "lstat",
      "readFile",
      "readFileSync",
      "readdir",
      "readdirSync",
      "stat",
      "statSync",
    ].includes(String(callName ?? ""));
    if (filesystemRead) {
      const literal = staticTemplate(args[0]);
      imports.push({
        kind: "literal",
        specifier: literal ? literal.value : "<computed>",
        line,
        computed: literal ? literal.computed : true,
        source: "filesystem",
      });
    }
    if (
      ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"].includes(String(callName ?? ""))
    ) {
      const first = staticTemplate(args[0]);
      spawns.push({ specifier: first ? first.value : null, line, computed: first ? first.computed : true });
      if (["exec", "execSync"].includes(String(callName ?? "")) && first && !first.computed) {
        const commandPath = first.value
          .trim()
          .split(COMMAND_ARGUMENT_PATTERN)
          .find((part) => part.startsWith("."));
        if (commandPath) {
          spawns.push({ specifier: commandPath, line, computed: false });
        }
      }
      for (const arg of args.slice(1)) {
        const literal = staticTemplate(arg);
        if (literal !== undefined) {
          if (literal.value.startsWith(".")) {
            spawns.push({ specifier: literal.value, line, computed: literal.computed });
          }
          continue;
        }
        const values = staticArray(arg);
        if (values) {
          for (const value of values.filter((item) => item.startsWith("."))) {
            spawns.push({ specifier: value, line, computed: false });
          }
        } else if (arg.type !== "ObjectExpression") {
          spawns.push({ specifier: null, line, computed: true });
        }
      }
    }
  });
  walkBabelAst(ast.program, (node) => {
    if (node.type !== "NewExpression") {
      return;
    }
    const callee = node.callee as Record<string, unknown> | undefined;
    if (callee?.type !== "Identifier" || callee.name !== "URL") {
      return;
    }
    const args = Array.isArray(node.arguments) ? (node.arguments as Record<string, unknown>[]) : [];
    const literal = staticTemplate(args[0]);
    imports.push({
      kind: "literal",
      specifier: literal ? literal.value : "<computed>",
      line: Number((node.loc as { start: { line: number } }).start.line),
      computed: !literal || literal.computed,
      source: "filesystem",
    });
  });
  return { imports, spawns };
}

interface ResolverConfig {
  baseUrl: string;
  paths: Record<string, string[]>;
}

function nearestResolverConfig(root: string, file: string): ResolverConfig {
  let dir = dirname(file);
  const rootAbsolute = resolve(root);
  while (dir.startsWith(rootAbsolute)) {
    const configPath = join(dir, "tsconfig.json");
    if (existsSync(configPath)) {
      try {
        const config = parseExpression(readFileSync(configPath, "utf8"), { plugins: ["typescript"] }) as unknown as {
          properties?: { key?: { name?: string; value?: string }; value?: unknown }[];
        };
        const compilerOptionsProperty = config.properties?.find((property) => property.key?.name === "compilerOptions");
        const compilerOptions = compilerOptionsProperty?.value as
          | {
              properties?: { key?: { name?: string; value?: string }; value?: unknown }[];
            }
          | undefined;
        const propertyValue = (name: string): unknown =>
          compilerOptions?.properties?.find((property) => property.key?.name === name)?.value;
        const stringValue = (value: unknown): string | undefined =>
          (value as { type?: string; value?: unknown } | undefined)?.type === "StringLiteral"
            ? String((value as { value: unknown }).value)
            : undefined;
        const pathsValue = propertyValue("paths") as
          | {
              properties?: { key?: { name?: string; value?: string; type?: string }; value?: unknown }[];
            }
          | undefined;
        const baseUrlValue = stringValue(propertyValue("baseUrl"));
        const paths = Object.fromEntries(
          (pathsValue?.properties ?? []).flatMap((property) => {
            const key = property.key?.name ?? property.key?.value;
            const values = (property.value as { elements?: unknown[] } | undefined)?.elements ?? [];
            return key ? [[key, values.map(stringValue).filter((value): value is string => value !== undefined)]] : [];
          })
        );
        return { baseUrl: baseUrlValue ? resolve(dir, baseUrlValue) : dir, paths };
      } catch (error) {
        throw new Error(`resolver config is not valid JSONC: ${configPath}`, { cause: error });
      }
    }
    if (dir === rootAbsolute) {
      break;
    }
    dir = dirname(dir);
  }
  return { baseUrl: rootAbsolute, paths: {} };
}

function insideRoot(root: string, absolute: string): string | null {
  const path = relative(resolve(root), resolve(absolute)).replaceAll("\\", "/");
  if (!path || path === ".." || path.startsWith("../")) {
    return null;
  }
  return normalizePath(path);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this resolver keeps relative, alias, package-export, extension, and index resolution in one auditable fail-closed path.
function resolveOccurrence(root: string, from: string, specifier: string): string | null {
  const absoluteFrom = resolve(root, from);
  const config = nearestResolverConfig(root, absoluteFrom);
  const candidates: string[] = [];
  if (specifier.startsWith(".")) {
    const absolute = resolve(dirname(absoluteFrom), specifier);
    candidates.push(absolute);
  } else {
    for (const [pattern, targets] of Object.entries(config.paths)) {
      const marker = pattern.indexOf("*");
      const prefix = marker < 0 ? pattern : pattern.slice(0, marker);
      const suffix = marker < 0 ? "" : pattern.slice(marker + 1);
      if (!(specifier.startsWith(prefix) && specifier.endsWith(suffix))) {
        continue;
      }
      const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
      for (const target of targets) {
        candidates.push(resolve(config.baseUrl, target.replace("*", wildcard)));
      }
    }
    if (candidates.length === 0) {
      try {
        const resolved = createRequire(resolve(root, "package.json")).resolve(specifier);
        candidates.push(resolved);
      } catch {
        return null;
      }
    }
  }
  const expanded: string[] = [];
  for (const candidate of candidates) {
    expanded.push(candidate);
    if (!extname(candidate)) {
      for (const extension of [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]) {
        expanded.push(`${candidate}${extension}`);
      }
      for (const extension of [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]) {
        expanded.push(join(candidate, `index${extension}`));
      }
    } else if (candidate.endsWith(".js") || candidate.endsWith(".mjs") || candidate.endsWith(".cjs")) {
      expanded.push(`${candidate.slice(0, candidate.lastIndexOf("."))}.ts`);
    }
  }
  return (
    expanded
      .filter((candidate) => {
        try {
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      })
      .map((candidate) => insideRoot(root, candidate))
      .find((candidate): candidate is string => candidate !== null) ?? null
  );
}

function graphEdgeFromOccurrence(
  root: string,
  from: string,
  occurrence: ImportOccurrence
): { target: string | null; issue?: GraphIssue } {
  if (occurrence.computed) {
    return {
      target: null,
      issue: { from, kind: "unknown-dynamic", detail: `computed ${occurrence.kind} at line ${occurrence.line}` },
    };
  }
  const specifier =
    occurrence.source === "filesystem" && !occurrence.specifier.startsWith(".")
      ? `./${occurrence.specifier}`
      : occurrence.specifier;
  const resolveChecked = (): string | null => resolveOccurrence(root, from, specifier);
  if (occurrence.source === "module" && specifier.startsWith("node:")) {
    return { target: null };
  }
  if (occurrence.source === "module" && !(specifier.startsWith(".") || specifier.startsWith("/"))) {
    let target: string | null;
    try {
      target = resolveChecked();
    } catch (error) {
      return {
        target: null,
        issue: { from, kind: "unresolved-literal", detail: error instanceof Error ? error.message : String(error) },
      };
    }
    return target
      ? { target }
      : {
          target: null,
          issue: {
            from,
            kind: "unresolved-literal",
            detail: `${occurrence.kind} ${JSON.stringify(specifier)} at line ${occurrence.line}`,
          },
        };
  }
  let target: string | null;
  try {
    target = resolveChecked();
  } catch (error) {
    return {
      target: null,
      issue: { from, kind: "unresolved-literal", detail: error instanceof Error ? error.message : String(error) },
    };
  }
  if (!target) {
    return {
      target: null,
      issue: {
        from,
        kind: "unresolved-literal",
        detail: `${occurrence.kind} ${JSON.stringify(specifier)} at line ${occurrence.line}`,
      },
    };
  }
  return { target };
}

function changedScopes(changed: string[]): string[] {
  return sortedUnique(changed.map(packageRoot).filter((value): value is string => value !== null));
}

function graphPaths(files: string[]): string[] {
  // Build the complete tracked source graph, including cross-package importers.
  // A changed-directory-only scan can miss an importer in a sibling directory
  // and would turn an incomplete graph into an apparently safe mini-run.
  return files
    .filter((path) => {
      if (!EXECUTABLE_GRAPH_PATTERN.test(path)) {
        return false;
      }
      return true;
    })
    .sort(compare);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: graph construction is the single fail-closed chain for parser, resolver, packet-edge, and finite-budget evidence.
export function buildIncrementalGraph(
  root: string,
  headSha: string,
  limits: GraphLimits = DEFAULT_GRAPH_LIMITS
): IncrementalGraph {
  validateGraphLimits(limits);
  const started = performance.now();
  const files = trackedFiles(root);
  const paths = graphPaths(files);
  const nodes: GraphNode[] = files.map((path) => ({ path, kind: classifyTrackedPath(path).kind }));
  const edges: GraphEdge[] = [];
  const issues: GraphIssue[] = [];
  let complete = true;
  for (const from of paths) {
    if (nodes.length > limits.max_nodes || performance.now() - started > limits.max_millis) {
      complete = false;
      issues.push({ from, kind: "parse", detail: "graph construction budget exceeded" });
      break;
    }
    if (SHELL_OR_PYTHON_PATTERN.test(from)) {
      complete = false;
      issues.push(shellOrPythonIssue(from));
      continue;
    }
    let occurrences: { imports: ImportOccurrence[]; spawns: SpawnOccurrence[] };
    try {
      occurrences = collectOccurrences(readFileSync(resolve(root, from), "utf8"), from);
    } catch (error) {
      complete = false;
      issues.push({ from, kind: "parse", detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const occurrence of occurrences.imports) {
      const resolved = graphEdgeFromOccurrence(root, from, occurrence);
      if (resolved.issue) {
        complete = false;
        issues.push(resolved.issue);
      }
      if (!resolved.target) {
        continue;
      }
      const edge: RuntimeEdge = { from, target: resolved.target, kind: occurrence.kind, declaration: null };
      try {
        // The packet resolver remains the authority for literal import syntax
        // whenever its exact path spelling is available. TypeScript resolution
        // supplies the extension/package-export mapping around that primitive.
        if (
          occurrence.source === "module" &&
          resolved.target === normalizePath(join(dirname(from), occurrence.specifier))
        ) {
          sourceResolvesEdge(root, edge);
        }
      } catch (error) {
        complete = false;
        issues.push({
          from,
          kind: "unresolved-literal",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (edges.length >= limits.max_edges) {
        complete = false;
        issues.push({ from, kind: "parse", detail: "graph edge budget exceeded" });
        break;
      }
      edges.push({ from, target: resolved.target, kind: occurrence.kind, declaration: null });
    }
    for (const occurrence of occurrences.spawns) {
      if (occurrence.computed) {
        complete = false;
        issues.push({
          from,
          kind: "unknown-subprocess",
          detail: `computed subprocess target at line ${occurrence.line}`,
        });
        continue;
      }
      if (!occurrence.specifier?.startsWith(".")) {
        continue;
      }
      let target: string | null;
      try {
        target = resolveOccurrence(root, from, occurrence.specifier);
      } catch (error) {
        complete = false;
        issues.push({
          from,
          kind: "unresolved-literal",
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!target) {
        complete = false;
        issues.push({
          from,
          kind: "unresolved-literal",
          detail: `spawn ${JSON.stringify(occurrence.specifier)} at line ${occurrence.line}`,
        });
        continue;
      }
      try {
        sourceResolvesEdge(root, { from, target, kind: "spawn", declaration: null });
      } catch (error) {
        complete = false;
        issues.push({
          from,
          kind: "unresolved-literal",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (edges.length >= limits.max_edges) {
        complete = false;
        issues.push({ from, kind: "parse", detail: "graph edge budget exceeded" });
        break;
      }
      edges.push({ from, target, kind: "spawn", declaration: null });
    }
  }
  const canonical = {
    schema: INCREMENTAL_GRAPH_SCHEMA,
    selector_version: SELECTOR_VERSION,
    head_sha: headSha,
    source_tree_sha256: sourceTreeDigest(root, headSha),
    nodes: nodes.sort((a, b) => compare(a.path, b.path)),
    edges: edges.sort((a, b) => stable(a).localeCompare(stable(b))),
    issues: issues.sort((a, b) => stable(a).localeCompare(stable(b))),
    limits,
    complete,
  } as const;
  return { ...canonical, digest: contentDigest(stable(canonical)) };
}

export interface ClosureResult {
  complete: boolean;
  detail: string | null;
  files: string[];
  reason: "closure-budget" | null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the closure loop keeps every time, depth, node, and reverse-edge bound in one auditable fail-closed path.
export function boundedReverseClosure(
  graph: IncrementalGraph,
  seeds: string[],
  limits: GraphLimits = graph.limits
): ClosureResult {
  validateGraphLimits(limits);
  const started = performance.now();
  const reverse = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (reverse.size >= limits.max_edges && !reverse.has(edge.target)) {
      return {
        files: sortedUnique(seeds),
        complete: false,
        reason: "closure-budget",
        detail: "reverse closure edge budget exceeded",
      };
    }
    const importers = reverse.get(edge.target) ?? [];
    if (importers.length >= limits.max_edges) {
      return {
        files: sortedUnique(seeds),
        complete: false,
        reason: "closure-budget",
        detail: "reverse closure importer budget exceeded",
      };
    }
    importers.push(edge.from);
    reverse.set(edge.target, importers);
  }
  const visited = new Set(sortedUnique(seeds));
  const queue = [...visited].map((path) => ({ path, depth: 0 }));
  while (queue.length > 0) {
    if (performance.now() - started > limits.max_millis) {
      return {
        files: sortedUnique(visited),
        complete: false,
        reason: "closure-budget",
        detail: "reverse closure time budget exceeded",
      };
    }
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (current.depth > limits.max_depth) {
      return {
        files: sortedUnique(visited),
        complete: false,
        reason: "closure-budget",
        detail: "reverse closure depth exceeded",
      };
    }
    for (const importer of reverse.get(current.path) ?? []) {
      if (visited.has(importer)) {
        continue;
      }
      if (visited.size >= limits.max_nodes) {
        return {
          files: sortedUnique(visited),
          complete: false,
          reason: "closure-budget",
          detail: "reverse closure node budget exceeded",
        };
      }
      visited.add(importer);
      queue.push({ path: importer, depth: current.depth + 1 });
    }
  }
  return { files: sortedUnique(visited), complete: true, reason: null, detail: null };
}

export function verifyIncrementalGraph(graph: IncrementalGraph): void {
  verifyGraphDigest(graph);
  if (!graph.complete || graph.issues.length > 0) {
    fail("graph is incomplete");
  }
}

function verifyGraphDigest(graph: IncrementalGraph): void {
  validateGraphLimits(graph.limits);
  const canonical = {
    schema: graph.schema,
    selector_version: graph.selector_version,
    head_sha: graph.head_sha,
    source_tree_sha256: graph.source_tree_sha256,
    nodes: [...graph.nodes].sort((a, b) => compare(a.path, b.path)),
    edges: [...graph.edges].sort((a, b) => stable(a).localeCompare(stable(b))),
    issues: [...graph.issues].sort((a, b) => stable(a).localeCompare(stable(b))),
    limits: graph.limits,
    complete: graph.complete,
  };
  if (
    graph.schema !== INCREMENTAL_GRAPH_SCHEMA ||
    graph.selector_version !== SELECTOR_VERSION ||
    graph.digest !== contentDigest(stable(canonical))
  ) {
    fail("graph schema or digest is stale");
  }
}

function changedPathsOf(diff: DiffEntry[]): string[] {
  return sortedUnique(diff.flatMap((entry) => [entry.path, ...(entry.old_path ? [entry.old_path] : [])]));
}

function protectedForDiff(diff: DiffEntry[]): FallbackClassification[] {
  return diff
    .flatMap((entry) => [entry.path, ...(entry.old_path ? [entry.old_path] : [])])
    .map(classifyProtectedPath)
    .filter((value): value is FallbackClassification => value !== null);
}

function firstClassification(
  diff: DiffEntry[],
  predicate: (path: string) => FallbackClassification | null
): FallbackClassification | null {
  for (const path of changedPathsOf(diff)) {
    const classification = predicate(path);
    if (classification) {
      return classification;
    }
  }
  return null;
}

function runProfiles(manifest: Manifest, suite: string): string[] {
  const selected = manifest.suites.find((entry) => entry.id === suite);
  if (!selected) {
    return [];
  }
  return selected.profiles.map((profile) => (typeof profile === "string" ? profile : (profile.id ?? "")));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: selection is the audited order of exact-head, protected-surface, accounting, graph, closure, and profile checks.
export async function selectIncrementalShadow({
  root,
  baseSha,
  headSha,
  graphLimits = DEFAULT_GRAPH_LIMITS,
}: {
  root: string;
  baseSha: string;
  headSha: string;
  graphLimits?: GraphLimits;
}): Promise<ShadowSelection> {
  const started = performance.now();
  const observedHead = assertExactHead(root, headSha);
  assertBase(root, baseSha, headSha);
  assertCleanSourceTree(root);
  const raw = exactDiff(root, baseSha, headSha);
  const rawDiffSha256 = contentDigest(raw);
  let diff: DiffEntry[];
  try {
    diff = parseNulDiff(raw);
  } catch (error) {
    throw new Error(`malformed-diff: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const changedPaths = changedPathsOf(diff);
  const protectedPaths = protectedForDiff(diff);
  const base: Pick<
    ShadowSelection,
    | "selector_schema"
    | "selector_version"
    | "base_sha"
    | "head_sha"
    | "observed_head_sha"
    | "raw_diff_sha256"
    | "changed_paths"
    | "diff"
    | "protected_paths"
    | "graph"
    | "overhead_ms"
  > = {
    selector_schema: INCREMENTAL_SELECTOR_SCHEMA,
    selector_version: SELECTOR_VERSION,
    base_sha: baseSha,
    head_sha: headSha,
    observed_head_sha: observedHead,
    raw_diff_sha256: rawDiffSha256,
    changed_paths: changedPaths,
    diff,
    protected_paths: protectedPaths,
    graph: null,
    overhead_ms: 0,
  };
  if (diff.length === 0) {
    return {
      ...base,
      mode: "full-fallback",
      fallback_reason: "empty-diff",
      fallback_detail: "empty diff is not a test selection",
      advertised_files: [],
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  const protectedClassification = protectedPaths[0] ?? firstClassification(diff, classifyChangedPath);
  if (protectedClassification) {
    return {
      ...base,
      mode: "full-fallback",
      fallback_reason: protectedClassification.reason,
      fallback_detail: protectedClassification.detail,
      advertised_files: [],
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  const changedSet = new Set(changedPaths);
  if (
    diff.some(
      (entry) => entry.old_path || entry.status[0] === "D" || entry.status[0] === "R" || entry.status[0] === "C"
    )
  ) {
    return {
      ...base,
      mode: "full-fallback",
      fallback_reason: "deleted-or-renamed-path",
      fallback_detail: "deleted, copied, or renamed paths require the full gate",
      advertised_files: [],
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  const unsupportedStatus = diff.find((entry) => !["A", "M"].includes(entry.status[0] ?? ""));
  if (unsupportedStatus) {
    return {
      ...base,
      mode: "full-fallback",
      fallback_reason: "unsupported-diff-status",
      fallback_detail: `${unsupportedStatus.status} changes require the full gate`,
      advertised_files: [],
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  if (changedScopes(changedPaths).length > 1) {
    return {
      ...base,
      mode: "full-fallback",
      fallback_reason: "multi-suite",
      fallback_detail: "changed paths cross workspace package boundaries",
      advertised_files: [],
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  const manifest = await readManifest(resolve(root, "test-accounting.manifest.json"), { root });
  const files = trackedFiles(root);
  try {
    checkInventory(manifest, files, [], { failOnUnknown: true, failOnEmpty: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      mode: "full-fallback",
      fallback_reason: "accounting-ownership",
      fallback_detail: detail,
      advertised_files: [],
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  const graph = buildIncrementalGraph(root, headSha, graphLimits);
  if (!graph.complete) {
    return {
      ...base,
      graph,
      mode: "full-fallback",
      fallback_reason: graph.issues.some((issue) => issue.kind === "parse") ? "graph-budget" : "graph-incomplete",
      fallback_detail: graph.issues.at(0)?.detail ?? "graph is incomplete",
      advertised_files: [],
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  const plans = planFor(manifest, files, []);
  const closure = boundedReverseClosure(graph, changedPaths, graphLimits);
  if (!closure.complete) {
    return {
      ...base,
      graph,
      mode: "full-fallback",
      fallback_reason: closure.reason,
      fallback_detail: closure.detail,
      advertised_files: [],
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  const selectedFiles = closure.files.filter((path) => classifyTrackedPath(path).kind === "executable");
  const ownerEntries = manifest.suites.filter((candidateSuite) =>
    (plans.plans.get(candidateSuite.id) ?? []).some((path) => selectedFiles.includes(path))
  );
  if (selectedFiles.length === 0) {
    const onlyNoop = [...changedSet].every((path) => NOOP_PATHS.has(path));
    return {
      ...base,
      graph,
      mode: onlyNoop ? "incremental" : "full-fallback",
      fallback_reason: onlyNoop ? null : "no-test-closure",
      fallback_detail: onlyNoop ? null : "changed source has no reverse test closure",
      advertised_files: [],
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  if (ownerEntries.length !== 1) {
    return {
      ...base,
      graph,
      mode: "full-fallback",
      fallback_reason: "multi-suite",
      fallback_detail: "reverse closure crosses accounting suites",
      advertised_files: selectedFiles,
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  const [suite] = ownerEntries;
  if (!suite) {
    fail("owner suite disappeared during selection");
  }
  const suitePlan = plans.plans.get(suite.id) ?? [];
  if (
    selectedFiles.length > MAX_REVERSE_TEST_FILES ||
    selectedFiles.length > suitePlan.length * MAX_REVERSE_SUITE_FRACTION
  ) {
    return {
      ...base,
      graph,
      mode: "full-fallback",
      fallback_reason: "closure-budget",
      fallback_detail: `selected ${selectedFiles.length} of ${suitePlan.length} suite tests`,
      advertised_files: selectedFiles,
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  if (runProfiles(manifest, suite.id).length !== 1) {
    return {
      ...base,
      graph,
      mode: "full-fallback",
      fallback_reason: "profile-family",
      fallback_detail: `${suite.id} has multiple profiles`,
      advertised_files: selectedFiles,
      selected_runs: [],
      overhead_ms: performance.now() - started,
    };
  }
  for (const changed of changedPaths) {
    const consumers = graph.edges.filter(
      (edge) => edge.target === changed && classifyTrackedPath(edge.from).kind !== "executable"
    );
    if (consumers.length > MAX_REVERSE_PRODUCTION_FAN_IN) {
      return {
        ...base,
        graph,
        mode: "full-fallback",
        fallback_reason: "high-fan-in",
        fallback_detail: `${changed} has ${consumers.length} reverse production consumers`,
        advertised_files: selectedFiles,
        selected_runs: [],
        overhead_ms: performance.now() - started,
      };
    }
  }
  const profile = runProfiles(manifest, suite.id)[0] ?? "";
  const selectedRuns: SelectedRun[] = [{ suite: suite.id, profile, files: selectedFiles }];
  return {
    ...base,
    graph,
    mode: "incremental",
    fallback_reason: null,
    fallback_detail: null,
    advertised_files: selectedFiles,
    selected_runs: selectedRuns,
    overhead_ms: performance.now() - started,
  };
}

function shadowBinding(receipt: Omit<ShadowReceipt, "binding_sha256">): string {
  return contentDigest(
    stable({
      schema: receipt.schema,
      selector_schema: receipt.selector_schema,
      selector_version: receipt.selector_version,
      base_sha: receipt.base_sha,
      head_sha: receipt.head_sha,
      observed_head_sha: receipt.observed_head_sha,
      raw_diff_sha256: receipt.raw_diff_sha256,
      changed_paths: receipt.changed_paths,
      diff: receipt.diff,
      protected_paths: receipt.protected_paths,
      advertised_files: receipt.advertised_files,
      honored_files: receipt.honored_files,
      selected_runs: receipt.selected_runs,
      mode: receipt.mode,
      fallback_reason: receipt.fallback_reason,
      fallback_detail: receipt.fallback_detail,
      graph_sha256: receipt.graph?.digest ?? null,
      overhead_ms: receipt.overhead_ms,
      authority_report_identity: receipt.authority_report_identity,
    })
  );
}

export function makeShadowReceipt(
  selection: ShadowSelection,
  authorityReportIdentity: string | null = null
): ShadowReceipt {
  const receipt: Omit<ShadowReceipt, "binding_sha256"> = {
    ...selection,
    schema: SHADOW_RECEIPT_SCHEMA,
    shadow_only: true,
    ci_green: false,
    terminal_status: selection.mode === "incremental" ? "shadow-only" : "full-fallback",
    honored_files: [...selection.advertised_files],
    authority_report_identity: authorityReportIdentity,
    created_at: new Date().toISOString(),
  };
  return { ...receipt, binding_sha256: shadowBinding(receipt) };
}

export function assertAdvertisedFilesHonored(advertised: string[], honored: string[]): void {
  const canonical = (paths: string[], label: string): string[] => {
    const normalized = paths.map(normalizePath).sort(compare);
    if (new Set(normalized).size !== normalized.length) {
      fail(`${label} file list contains duplicates`);
    }
    if (stable(paths.map(normalizePath)) !== stable(normalized)) {
      fail(`${label} file list is not canonically sorted`);
    }
    return normalized;
  };
  const left = stable(canonical(advertised, "advertised"));
  const right = stable(canonical(honored, "honored"));
  if (left !== right) {
    fail(`advertised/honored file lists differ: ${left} / ${right}`);
  }
}

export function verifyShadowReceipt(
  receipt: ShadowReceipt,
  {
    root,
    expectedHead,
    authorityReportIdentity,
  }: { root: string; expectedHead: string; authorityReportIdentity?: string | null }
): void {
  if (
    receipt.schema !== SHADOW_RECEIPT_SCHEMA ||
    receipt.selector_schema !== INCREMENTAL_SELECTOR_SCHEMA ||
    receipt.selector_version !== SELECTOR_VERSION
  ) {
    fail("shadow receipt schema is invalid");
  }
  if (
    !receipt.shadow_only ||
    receipt.ci_green ||
    (receipt.terminal_status === "shadow-only" && receipt.mode !== "incremental") ||
    (receipt.terminal_status === "full-fallback" && receipt.mode !== "full-fallback")
  ) {
    fail("shadow receipt is not non-authoritative");
  }
  if (
    receipt.head_sha !== expectedHead ||
    gitHead(root) !== expectedHead ||
    receipt.observed_head_sha !== expectedHead
  ) {
    fail("shadow receipt head is stale");
  }
  assertAdvertisedFilesHonored(receipt.advertised_files, receipt.honored_files);
  if (receipt.mode === "full-fallback" && receipt.selected_runs.length !== 0) {
    fail("full-fallback receipt cannot contain selected runs");
  }
  if (receipt.mode === "incremental") {
    const selected = receipt.selected_runs.flatMap((run) => run.files);
    assertAdvertisedFilesHonored(receipt.advertised_files, selected);
    if (receipt.graph) {
      verifyIncrementalGraph(receipt.graph);
    }
  } else if (receipt.graph) {
    verifyGraphDigest(receipt.graph);
  }
  if (receipt.graph && receipt.graph.head_sha !== receipt.head_sha) {
    fail("shadow receipt graph head is stale");
  }
  if (!receipt.authority_report_identity) {
    fail("authority/full-gate report identity is missing");
  }
  if (authorityReportIdentity === undefined || receipt.authority_report_identity !== authorityReportIdentity) {
    fail("authority/full-gate report identity does not match");
  }
  if (receipt.binding_sha256 !== shadowBinding(receipt)) {
    fail("shadow receipt binding is stale");
  }
}

export function parseAuthorityReport(input: string, expectedHead: string): AuthorityReport {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    fail(`authority/full-gate report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = value as Partial<AuthorityReport>;
  if (
    report.schema !== AUTHORITY_REPORT_SCHEMA ||
    report.status !== "green" ||
    report.head_sha !== expectedHead ||
    !SHA_PATTERN.test(report.head_sha)
  ) {
    fail("authority/full-gate report schema, green status, or exact head is invalid");
  }
  return report as AuthorityReport;
}

export function renderShadowReport(receipt: ShadowReceipt | UnknownShadowReport): string {
  const lines = [
    "# Incremental gate shadow report",
    "",
    `schema: ${receipt.schema}`,
    `status: ${receipt.terminal_status}`,
    `shadow_only: ${receipt.shadow_only}`,
    `ci_green: ${receipt.ci_green}`,
  ];
  if ("mode" in receipt) {
    lines.push(
      `mode: ${receipt.mode}`,
      `base_sha: ${receipt.base_sha}`,
      `head_sha: ${receipt.head_sha}`,
      `observed_head_sha: ${receipt.observed_head_sha}`,
      `raw_diff_sha256: ${receipt.raw_diff_sha256}`,
      `changed_paths: ${receipt.changed_paths.length}`,
      `advertised_files: ${receipt.advertised_files.length}`,
      `honored_files: ${receipt.honored_files.length}`,
      `fallback_reason: ${receipt.fallback_reason ?? "none"}`,
      `overhead_ms: ${receipt.overhead_ms.toFixed(2)}`,
      `authority_report_identity: ${receipt.authority_report_identity ?? "none"}`
    );
  } else {
    lines.push(`reason: ${receipt.reason}`, `head_sha: ${receipt.head_sha ?? "unknown"}`);
  }
  lines.push(
    "",
    "This artifact is shadow-only. It cannot mark CI green, replace acceptance, or skip the full gate.",
    ""
  );
  return `${lines.join("\n")}\n`;
}

export async function writeShadowReceipt(path: string, receipt: ShadowReceipt): Promise<void> {
  const directory = dirname(resolve(path));
  await mkdir(directory, { recursive: true });
  const temporary = `${resolve(path)}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, resolve(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function writeUnknownShadowReceipt(
  path: string,
  reason: "receipt-missing" | "receipt-invalid" = "receipt-missing"
): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  await unlink(destination).catch(() => undefined);
  const temporary = `${destination}.${process.pid}.unknown.tmp`;
  const unknown: UnknownShadowReport = {
    schema: SHADOW_RECEIPT_SCHEMA,
    terminal_status: "unknown",
    shadow_only: true,
    ci_green: false,
    reason,
    head_sha: null,
  };
  try {
    await writeFile(temporary, `${JSON.stringify(unknown, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readShadowReceiptOrUnknown(path: string): Promise<ShadowReceipt | UnknownShadowReport> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ShadowReceipt>;
    const structurallyValid =
      value.schema === SHADOW_RECEIPT_SCHEMA &&
      value.shadow_only === true &&
      value.ci_green === false &&
      (value.mode === "incremental" || value.mode === "full-fallback") &&
      (value.terminal_status === "shadow-only" || value.terminal_status === "full-fallback") &&
      typeof value.authority_report_identity === "string" &&
      value.authority_report_identity.length > 0 &&
      typeof value.binding_sha256 === "string" &&
      Array.isArray(value.advertised_files) &&
      Array.isArray(value.honored_files) &&
      Array.isArray(value.selected_runs) &&
      Array.isArray(value.changed_paths) &&
      Array.isArray(value.diff) &&
      Array.isArray(value.protected_paths);
    if (!structurallyValid) {
      return {
        schema: SHADOW_RECEIPT_SCHEMA,
        terminal_status: "unknown",
        shadow_only: true,
        ci_green: false,
        reason: "receipt-invalid",
        head_sha: null,
      };
    }
    const receipt = value as ShadowReceipt;
    if (
      (receipt.terminal_status === "shadow-only" && receipt.mode !== "incremental") ||
      (receipt.terminal_status === "full-fallback" && receipt.mode !== "full-fallback") ||
      receipt.binding_sha256 !== shadowBinding(receipt)
    ) {
      throw new Error("receipt binding or terminal status is invalid");
    }
    assertAdvertisedFilesHonored(receipt.advertised_files, receipt.honored_files);
    if (receipt.mode === "incremental") {
      assertAdvertisedFilesHonored(
        receipt.advertised_files,
        receipt.selected_runs.flatMap((run) => run.files)
      );
      if (receipt.graph) {
        verifyIncrementalGraph(receipt.graph);
      }
    } else if (receipt.graph) {
      verifyGraphDigest(receipt.graph);
    }
    return receipt;
  } catch {
    return {
      schema: SHADOW_RECEIPT_SCHEMA,
      terminal_status: "unknown",
      shadow_only: true,
      ci_green: false,
      reason: "receipt-missing",
      head_sha: null,
    };
  }
}
