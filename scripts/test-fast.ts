// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Affected-only unit tests for the agent edit-test loop. Never a merge gate: the accounting
// authority stays the gate. Selection is conservative; anything it cannot classify runs every test.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { parse } from "@babel/parser";
import { applyLocalNodeTestConcurrency, suiteEnvironment } from "./test-accounting/authority.ts";
import { compareStrings, type Manifest, matchesGlob, readManifest, type Suite } from "./test-accounting/inventory.ts";
import { structuredNodeSummary } from "./test-accounting/receipt.ts";

export interface FastSelection {
  base: string;
  changed: string[];
  fallback: boolean;
  reason?: string;
  suites: { files: string[]; id: string; reasons: string[] }[];
}

const SOURCE = /\.[cm]?[jt]sx?$/;
const CONFIG =
  /^(?:package\.json|pnpm-lock\.yaml|test-accounting\.manifest\.json|tsconfig[^/]*|scripts\/(?:test-accounting|test-scratch|hermetic|test-sandbox)\/)|(?:^|\/)tsconfig[^/]*$|css-stub|^apps\/site\/(?:source\.config\.ts|scripts\/sync-spec-docs\.)/;
const SOURCE_ROOT = /^(?:scripts|packages\/[^/]+|apps\/site)\//;
const PACKAGE_JSON = /^packages\/([^/]+)\/package\.json$/;
const EMITTED_JS = /\.m?js$/;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  }
  return result.stdout;
}

export function changedFiles(root: string, baseRef = "origin/main"): { base: string; paths: string[] } {
  const base = git(root, ["merge-base", baseRef, "HEAD"]).trim();
  const changed = git(root, ["diff", "--name-only", "--no-renames", "-z", base, "--"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return { base, paths: [...new Set(`${changed}${untracked}`.split("\0").filter(Boolean))].sort(compareStrings) };
}

// `@pdpp/<name>[/sub]` -> workspace package directory and the source file its exports map names.
type Workspace = Map<string, { dir: string; exports: Map<string, string> }>;

function workspacePackages(root: string, files: Set<string>): Workspace {
  const packages: Workspace = new Map();
  for (const path of files) {
    if (!PACKAGE_JSON.test(path)) {
      continue;
    }
    const pkg = JSON.parse(readFileSync(join(root, path), "utf8")) as {
      name?: string;
      exports?: Record<string, string>;
    };
    const dir = dirname(path);
    const exports = new Map<string, string>();
    for (const [key, target] of Object.entries(pkg.exports ?? {})) {
      exports.set(key === "." ? "" : key.slice(2), posix.join(dir, target));
    }
    if (pkg.name) {
      packages.set(pkg.name, { dir, exports });
    }
  }
  return packages;
}

interface AstNode {
  arguments?: AstNode[];
  callee?: AstNode;
  expressions?: unknown[];
  name?: string;
  quasis?: { value: { cooked: string } }[];
  source?: AstNode;
  type?: string;
  value?: unknown;
}

// The specifier a node names when it is a plain string or an expression-free template.
function literalSpecifier(node: AstNode | undefined): string | undefined {
  if (node?.type === "StringLiteral") {
    return node.value as string;
  }
  return node?.type === "TemplateLiteral" && node.expressions?.length === 0
    ? node.quasis?.[0]?.value.cooked
    : undefined;
}

// What an import-like node names: undefined when it is not one, `{}` when its path is computed.
// Covers declarations and re-exports, `import(x)`, `require(x)` and `new URL(x, import.meta.url)`.
function importTarget(node: AstNode): { specifier: string | undefined } | undefined {
  if (typeof node.source?.value === "string") {
    return { specifier: node.source.value };
  }
  if (node.type === "ImportExpression") {
    return { specifier: literalSpecifier(node.source) };
  }
  if (node.type === "CallExpression" && (node.callee?.type === "Import" || node.callee?.name === "require")) {
    return { specifier: literalSpecifier(node.arguments?.[0]) };
  }
  if (
    node.type === "NewExpression" &&
    node.callee?.name === "URL" &&
    node.arguments?.[1]?.type === "MemberExpression"
  ) {
    return { specifier: literalSpecifier(node.arguments[0]) };
  }
  return undefined;
}

// Static specifiers of one module, and whether it also holds an import the scan cannot name (a
// computed path) or cannot parse. Parsing (not regex) keeps comments and quoted code from creating
// or hiding edges.
function scanImports(source: string): { specifiers: string[]; uncertain: boolean } {
  const specifiers: string[] = [];
  let uncertain = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === "object") {
      const target = importTarget(node as AstNode);
      if (target?.specifier !== undefined) {
        specifiers.push(target.specifier);
      }
      uncertain ||= target !== undefined && target.specifier === undefined;
      for (const [key, child] of Object.entries(node)) {
        if (key !== "loc" && !key.endsWith("Comments")) {
          visit(child);
        }
      }
    }
  };
  try {
    visit(parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] }).program);
  } catch {
    return { specifiers: [], uncertain: true };
  }
  return { specifiers, uncertain };
}

// `uncertain` holds modules with an import the scan cannot name (computed path) or cannot parse.
interface ImportGraph {
  importers: Map<string, Set<string>>;
  nodes: Set<string>;
  uncertain: Set<string>;
}

// Import graph over every file reachable from the tests through relative or `@pdpp/*` imports, with
// `<dir>/` markers for workspace imports that name no source file (css, unlisted subpaths).
function buildGraph(root: string, tests: string[], files: Set<string>, packages: Workspace): ImportGraph {
  const graph: ImportGraph = { importers: new Map(), nodes: new Set(), uncertain: new Set() };
  const resolveSpecifier = (from: string, specifier: string): string[] => {
    let target: string | undefined;
    if (specifier.startsWith(".")) {
      target = posix.normalize(posix.join(posix.dirname(from), specifier));
    } else if (specifier.startsWith("@pdpp/")) {
      const [scope, name, ...sub] = specifier.split("/");
      const pkg = packages.get(`${scope}/${name}`);
      target = pkg?.exports.get(sub.join("/"));
      if (!target) {
        return pkg ? [`${pkg.dir}/`] : [];
      }
    } else if (specifier.startsWith("@/") && from.startsWith("apps/site/")) {
      target = `apps/site/src/${specifier.slice(2)}`; // the site tsconfig's only tracked-source alias
    } else {
      return [];
    }
    const resolved = EXTENSIONS.map((extension) => `${target}${extension}`).find((candidate) => files.has(candidate));
    // tsx maps emitted .js specifiers back to TypeScript sources.
    const emitted = [".ts", ".tsx", ".mts"].map((ext) => target.replace(EMITTED_JS, ext)).find((c) => files.has(c));
    return [resolved ?? emitted].filter((path): path is string => path !== undefined);
  };
  const visit = (path: string): void => {
    if (graph.nodes.has(path)) {
      return;
    }
    graph.nodes.add(path);
    if (!SOURCE.test(path)) {
      return;
    }
    const { specifiers, uncertain } = scanImports(readFileSync(join(root, path), "utf8"));
    if (uncertain) {
      graph.uncertain.add(path);
    }
    for (const dep of specifiers.flatMap((specifier) => resolveSpecifier(path, specifier))) {
      graph.importers.set(dep, (graph.importers.get(dep) ?? new Set()).add(path));
      visit(dep);
    }
  };
  tests.forEach(visit);
  return graph;
}

// Every module that imports one of the seeds, transitively (seeds included).
function importersOf(graph: ImportGraph, seeds: Iterable<string>): Set<string> {
  const all = new Set(seeds);
  const queue = [...all];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const importer of graph.importers.get(next) ?? []) {
      if (!all.has(importer)) {
        all.add(importer);
        queue.push(importer);
      }
    }
  }
  return all;
}

// Why a changed path cannot be mapped to tests, or undefined when it is a test, package.json or source file.
function unknownChange(path: string, files: Set<string>): string | undefined {
  if (!files.has(path)) {
    return `deleted or missing file: ${path}`;
  }
  if (CONFIG.test(path)) {
    return `global input: ${path}`;
  }
  return PACKAGE_JSON.test(path) || (SOURCE.test(path) && SOURCE_ROOT.test(path))
    ? undefined
    : `unclassified file: ${path}`;
}

// Test -> reason for every test the changed sources can affect, or the reason mapping is unsafe.
// A test whose import closure holds an uncertain module could load any source at run time, so it is
// affected by every source change.
function mapSources(
  root: string,
  files: Set<string>,
  tests: Set<string>,
  sources: string[]
): Map<string, string> | string {
  const reasons = new Map<string, string>();
  if (sources.length === 0) {
    return reasons;
  }
  const graph = buildGraph(root, [...tests], files, workspacePackages(root, files));
  for (const test of importersOf(graph, graph.uncertain)) {
    if (tests.has(test)) {
      reasons.set(test, "imports a module with a computed or unparseable import");
    }
  }
  for (const path of sources) {
    const dir = PACKAGE_JSON.test(path) ? `${dirname(path)}/` : undefined;
    const hits = [...importersOf(graph, dir ? [...graph.nodes].filter((node) => node.startsWith(dir)) : [path])].filter(
      (node) => tests.has(node)
    );
    if (hits.length === 0) {
      return `no test reaches ${path}`;
    }
    for (const test of hits) {
      reasons.set(test, `${dir && test.startsWith(dir) ? "changed package" : "imports"} ${path}`);
    }
  }
  return reasons;
}

export function selectFastTests(
  root: string,
  manifest: Manifest,
  available: string[],
  changed: string[],
  base = "injected"
): FastSelection {
  const files = new Set(available);
  const excluded = new Set((manifest.exclusions ?? []).map((entry) => entry.path));
  const suites = manifest.suites.map((suite) => ({
    id: suite.id,
    files: available
      .filter((path) => !excluded.has(path) && suite.include.some((glob) => matchesGlob(path, glob)))
      .sort(compareStrings),
  }));
  const owner = new Map(suites.flatMap((suite) => suite.files.map((path) => [path, suite.id] as const)));
  const selection: FastSelection = { base, changed, fallback: false, suites: [] };
  const fallback = (reason: string): FastSelection => ({
    ...selection,
    fallback: true,
    reason,
    suites: suites.filter((suite) => suite.files.length).map((suite) => ({ ...suite, reasons: [reason] })),
  });

  const reasons = new Map<string, string>(); // test -> why it runs
  const sources: string[] = [];
  for (const path of changed.filter((changedPath) => !excluded.has(changedPath))) {
    const unknown = unknownChange(path, files);
    if (unknown) {
      return fallback(unknown);
    }
    if (owner.has(path)) {
      reasons.set(path, `changed test ${path}`);
    } else {
      sources.push(path);
    }
  }
  const mapped = mapSources(root, files, new Set(owner.keys()), sources);
  if (typeof mapped === "string") {
    return fallback(mapped);
  }
  for (const [test, reason] of mapped) {
    reasons.set(test, reasons.get(test) ?? reason);
  }
  selection.suites = suites
    .map((suite) => ({ id: suite.id, files: suite.files.filter((path) => reasons.has(path)) }))
    .filter((suite) => suite.files.length > 0)
    .map((suite) => ({ ...suite, reasons: [...new Set(suite.files.map((path) => reasons.get(path) ?? ""))] }));
  return selection;
}

// The argv the manifest's own command needs for the selected files (shell leaves take file paths too).
// Node suites print the spec reporter and write the authority's structured events to `eventsFile`.
export function suiteArgv(suite: Suite, files: string[], root: string, eventsFile: string): string[] {
  const command = [...(suite.command ?? [])];
  const reporter = command.indexOf("--test-reporter");
  if (reporter !== -1) {
    command.splice(
      reporter,
      2,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      `--test-reporter=${resolve(root, command[reporter + 1] ?? "")}`,
      `--test-reporter-destination=${eventsFile}`
    );
  }
  return [...applyLocalNodeTestConcurrency(command), ...files.map((path) => posix.relative(suite.cwd, path))];
}

// Tests that really ran, counted as the gate counts them: node suites from the structured reporter
// events (passed + failed, skips excluded); shell suites by the authority's contract of one per file.
// Node reports a file that defines no test as one passing event named after the file (relative or
// absolute, as passed on the command line), so those do not count.
export function executedTests(loader: string, events: string, files: string[]): number {
  if (loader === "shell") {
    return files.length;
  }
  const testEvents = events.split("\n").filter((line) => !files.some((file) => line.endsWith(`${file}"}}`)));
  try {
    const { passed, failed } = structuredNodeSummary(testEvents.join("\n"));
    return passed + failed;
  } catch {
    return 0;
  }
}

function execute(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number }> {
  return new Promise((done, fail) => {
    // `pnpm test:fast` already runs under the scratch owner, as the accounting authority does.
    const child = spawn(argv[0] ?? "", argv.slice(1), { cwd, env, stdio: "inherit" });
    child.on("error", fail);
    child.on("close", (code) => done({ status: code ?? 1 }));
  });
}

async function runSuite(
  root: string,
  suite: Suite,
  selected: FastSelection["suites"][number],
  scratch: string
): Promise<number> {
  const env = suiteEnvironment(process.env, "default", suite, root);
  const cwd = resolve(root, suite.cwd);
  if (suite.prepare) {
    const prepared = await execute(suite.prepare, cwd, env);
    if (prepared.status !== 0) {
      return prepared.status;
    }
  }
  const eventsFile = join(scratch, `${selected.id}.events`);
  const { status } = await execute(suiteArgv(suite, selected.files, root, eventsFile), cwd, env);
  const events = existsSync(eventsFile) ? readFileSync(eventsFile, "utf8") : "";
  if (status === 0 && executedTests(suite.loader, events, selected.files) === 0) {
    process.stderr.write(`test:fast: ${selected.id} selected ${selected.files.length} file(s) but ran zero tests\n`);
    return 1;
  }
  return status;
}

async function run(root: string, selection: FastSelection, manifest: Manifest): Promise<number> {
  if (selection.suites.length === 0) {
    process.stdout.write("test:fast: no changed unit tests or mapped sources\n");
    return 0;
  }
  let status = 0;
  const scratch = mkdtempSync(join(tmpdir(), "test-fast-"));
  for (const selected of selection.suites) {
    process.stdout.write(
      `test:fast ${selected.id}: ${selected.files.length} file(s) — ${selected.reasons.join("; ")}\n`
    );
    const suite = manifest.suites.find((entry) => entry.id === selected.id);
    if (!suite?.command) {
      throw new Error(`suite ${selected.id} has no command`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: suites run one after another to keep the host load bounded.
    status = (await runSuite(root, suite, selected, scratch)) || status;
  }
  rmSync(scratch, { recursive: true, force: true });
  return status;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const baseRef = baseIndex === -1 ? "origin/main" : args[baseIndex + 1];
  if (!baseRef || args.some((arg, i) => !["--dry-run", "--all", "--base"].includes(arg) && i !== baseIndex + 1)) {
    throw new Error("usage: pnpm test:fast [--dry-run] [--all] [--base <ref>]");
  }
  const manifest = await readManifest(join(root, "test-accounting.manifest.json"), { root });
  const available = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((path) => path && existsSync(join(root, path)));
  const { base, paths } = changedFiles(root, baseRef);
  const selection = selectFastTests(root, manifest, available, args.includes("--all") ? ["package.json"] : paths, base);
  if (args.includes("--all")) {
    selection.changed = paths;
    selection.reason = "--all";
  }
  if (args.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify(selection)}\n`);
  } else {
    process.exitCode = await run(root, selection, manifest);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error: unknown) => {
    process.stderr.write(`test:fast: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
