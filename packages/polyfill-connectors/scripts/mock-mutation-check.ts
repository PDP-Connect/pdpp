#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock mutation check — proves whether a connector's request-path mocks
 * would actually catch a wrong path, or just ratify whatever the
 * implementation happens to send.
 *
 * The failure mode this targets: Jellyfin shipped with every test green
 * while every request 404'd in production, because its test server
 * matched on the SAME `/api/...` literal the implementation used to build
 * the request. Mock and code shared an author and therefore shared the
 * mistake — no assertion in the suite could ever have failed. A mock that
 * still passes when its path literal is corrupted proves nothing; it is
 * worse than no mock, because it manufactures false confidence.
 *
 * Method: for each connector test file, statically find string literals
 * used as request-path matchers (`path === "/foo"`, `.startsWith("/foo")`,
 * `.includes("/foo")` — the shapes real fake-HTTP-server routing and
 * request-path assertions use in this repo). For each literal found,
 * write a scratch copy of the test file with that ONE literal corrupted
 * (a suffix appended, so it can never match a real request again), and
 * run the scratch file with `node --test`. If the suite still exits 0,
 * the literal was decorative — nothing in the suite actually depended on
 * it matching. If the suite fails, the literal is load-bearing.
 *
 * Honesty contract:
 *   - A connector with zero detected path-literal matchers reports
 *     UNKNOWN, never PASS. Most of this repo's 42 connectors have no
 *     HTTP-path-matching mock at all (some have no HTTP test coverage
 *     whatsoever) — that is a DIFFERENT, and often worse, gap than a weak
 *     mock, and this script must not blur the two by inventing a passing
 *     grade for "nothing to check."
 *   - A connector only reaches PASS when EVERY detected literal in EVERY
 *     one of its test files is load-bearing under mutation. One decorative
 *     literal among ten real ones still means the suite has a soft spot.
 *
 * REPORT-ONLY by design (see meta.reportOnly below): 34 of 42 connectors
 * are `unproven` and most have zero mutable mock surface, so a hard gate
 * here would fail CI for nearly the whole roster on day one. The ratchet
 * is manual — this script's test entry point
 * (`src/mock-mutation-check.test.ts`, following the
 * `check-no-await-in-loops-conformance.ts`/`src/*-self-check.test.ts`
 * precedent for scripts that need to import a helper `scripts/**` isn't
 * in the package's `test` glob) is where a future PR pins a known-good
 * connector set and turns individual connectors from advisory to blocking
 * as they're proven, the same shape as `no-await-in-loops-allowlist.ts`.
 *
 * Usage:
 *   node --import tsx scripts/mock-mutation-check.ts             # table
 *   node --import tsx scripts/mock-mutation-check.ts --json      # machine-readable
 *   node --import tsx scripts/mock-mutation-check.ts --connector=jellyfin
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/is-main-module.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONNECTORS_DIR = join(PACKAGE_ROOT, "connectors");
const TEST_TIMEOUT_MS = 20_000;

// Matches the request-path-matcher shapes actually used across this repo's
// connector tests: `identifier === "/foo"`, `identifier.startsWith("/foo")`,
// `identifier.includes("/foo")`. Deliberately narrow — a general string
// literal isn't a path matcher, and a false-positive match would waste a
// mutation run on a literal that was never load-bearing to begin with.
const PATH_MATCHER_RE = /(?:\.(?:startsWith|includes)\("(\/[^"]*)"\)|===\s*"(\/[^"]*)")/g;

export interface PathLiteralSite {
  readonly file: string;
  readonly literal: string;
  readonly line: number;
}

export interface ConnectorMutationResult {
  readonly connector: string;
  readonly verdict: "PASS" | "WEAK" | "UNKNOWN";
  readonly sites: readonly PathLiteralSite[];
  readonly loadBearing: number;
  readonly decorative: readonly PathLiteralSite[];
  readonly detail: string;
}

function listConnectors(): string[] {
  return readdirSync(CONNECTORS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const SCRATCH_PREFIX = "__mutation_scratch_";

function listTestFiles(connector: string): string[] {
  const dir = join(CONNECTORS_DIR, connector);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    // Scratch copies are written alongside the original (relative imports must
    // resolve) and therefore also end in `.test.ts`. Without this filter a
    // leftover scratch from an interrupted run is collected as a real test
    // file, and the next trial reads a path that its own `finally` already
    // deleted — the run dies with ENOENT on a filename it invented itself.
    .filter((f) => !f.startsWith(SCRATCH_PREFIX))
    .map((f) => join(dir, f))
    .sort();
}

/** Find every path-literal matcher site in a test file's source text. */
export function findPathLiteralSites(filePath: string, source: string): PathLiteralSite[] {
  const sites: PathLiteralSite[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip comment lines: a regression-guard comment quoting a path (jellyfin's
    // "Jellyfin serves its REST API at the root, NOT under /api/" style notes)
    // is documentation, not a matcher — mutating it would corrupt the scratch
    // file's prose without changing any executable behavior, producing a
    // meaningless mutation run.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
      continue;
    }
    PATH_MATCHER_RE.lastIndex = 0;
    let match = PATH_MATCHER_RE.exec(line);
    while (match) {
      const literal = match[1] ?? match[2];
      if (literal) {
        sites.push({ file: filePath, line: i + 1, literal });
      }
      match = PATH_MATCHER_RE.exec(line);
    }
  }
  return sites;
}

/**
 * Corrupt EVERY occurrence of `literal` in the source, not just the one at
 * the detected site. A path literal is one logical fact about the real
 * API; the same string routinely appears twice in one file — once where a
 * fake server (or request builder) matches on it, once where an assertion
 * counts/asserts against it (e.g. chatgpt's
 * `fetches.filter((p) => p === "/conversation/c-exhaust-2").length`
 * alongside the router branch that tests the same literal). Mutating only
 * the first occurrence left the second, unmutated occurrence free to keep
 * proving the ORIGINAL fact by coincidence — a real false "decorative"
 * verdict this fixed. Mutating every occurrence together tests whether the
 * fact is checked ANYWHERE, which is the actual question this gate exists
 * to answer.
 */
function mutateSource(source: string, literal: string): string {
  const quoted = `"${literal}"`;
  const mutated = `"${literal}__MUTATED__"`;
  if (!source.includes(quoted)) {
    throw new Error(`literal ${quoted} not found for mutation (source may have changed since detection)`);
  }
  return source.split(quoted).join(mutated);
}

function runTestFile(filePath: string): { passed: boolean; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      ["--test", "--import", "tsx", `--test-timeout=${TEST_TIMEOUT_MS}`, filePath],
      { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: "pipe", timeout: TEST_TIMEOUT_MS * 4 }
    );
    return { passed: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { passed: false, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

/**
 * Run one mutation trial: write a scratch copy of `originalFile` with
 * `site.literal` corrupted, run it, delete the scratch copy, and report
 * whether the mutation caused a failure (load-bearing) or not (decorative).
 * The scratch file is written ALONGSIDE the original (not in system tmp)
 * because the connector's relative imports (`../../src/...`) must resolve.
 */
function runMutationTrial(site: PathLiteralSite): { loadBearing: boolean; output: string } {
  const original = readFileSync(site.file, "utf8");
  const mutated = mutateSource(original, site.literal);
  const dir = dirname(site.file);
  const scratchPath = join(dir, `${SCRATCH_PREFIX}${process.pid}_${Date.now()}.test.ts`);
  writeFileSync(scratchPath, mutated);
  try {
    const result = runTestFile(scratchPath);
    return { loadBearing: !result.passed, output: result.output };
  } finally {
    rmSync(scratchPath, { force: true });
  }
}

function checkConnector(connector: string): ConnectorMutationResult {
  const testFiles = listTestFiles(connector);
  const sites: PathLiteralSite[] = [];
  for (const file of testFiles) {
    const source = readFileSync(file, "utf8");
    sites.push(...findPathLiteralSites(file, source));
  }

  // Dedupe identical (file, literal) pairs — the same route matcher can
  // legitimately appear more than once in one file (e.g. a shared fake
  // server class instantiated by several tests); mutating it once proves
  // the same fact every additional occurrence would.
  const seen = new Set<string>();
  const uniqueSites = sites.filter((s) => {
    const key = `${s.file}::${s.literal}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  if (uniqueSites.length === 0) {
    return {
      connector,
      verdict: "UNKNOWN",
      sites: [],
      loadBearing: 0,
      decorative: [],
      detail:
        testFiles.length === 0
          ? "no test files found"
          : "no request-path-matching literal detected in test source — this connector's HTTP surface (if any) is not covered by a path-asserting mock; cannot be checked, not the same as passing",
    };
  }

  const decorative: PathLiteralSite[] = [];
  let loadBearing = 0;
  for (const site of uniqueSites) {
    const { loadBearing: isLoadBearing } = runMutationTrial(site);
    if (isLoadBearing) {
      loadBearing++;
    } else {
      decorative.push(site);
    }
  }

  const verdict: ConnectorMutationResult["verdict"] = decorative.length === 0 ? "PASS" : "WEAK";
  const detail =
    verdict === "PASS"
      ? `${loadBearing}/${uniqueSites.length} path literal(s) are load-bearing — mutating any of them breaks the suite`
      : `${decorative.length}/${uniqueSites.length} path literal(s) are decorative — the suite still passes when they're corrupted, at ${decorative
          .map((d) => `${d.file.replace(`${PACKAGE_ROOT}/`, "")}:${d.line} "${d.literal}"`)
          .join("; ")}`;

  return { connector, verdict, sites: uniqueSites, loadBearing, decorative, detail };
}

export function runAllConnectors(only?: string): ConnectorMutationResult[] {
  const connectors = only ? [only] : listConnectors();
  return connectors.map(checkConnector);
}

function printTable(results: ConnectorMutationResult[]): void {
  const width = Math.max(...results.map((r) => r.connector.length));
  for (const r of results) {
    console.log(`${r.verdict.padEnd(8)} ${r.connector.padEnd(width)} ${r.detail}`);
  }
  const pass = results.filter((r) => r.verdict === "PASS").length;
  const weak = results.filter((r) => r.verdict === "WEAK").length;
  const unknown = results.filter((r) => r.verdict === "UNKNOWN").length;
  console.log(`\n${pass} PASS, ${weak} WEAK, ${unknown} UNKNOWN (of ${results.length} connectors)`);
  console.log("REPORT-ONLY: this gate does not fail CI. See src/mock-mutation-check.test.ts for the ratchet.");
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json");
  const connectorArg = args.find((a) => a.startsWith("--connector="))?.split("=")[1];

  const results = runAllConnectors(connectorArg);

  if (jsonOut) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printTable(results);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
