#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `related-tests <base-ref>` — a fast LOCAL probe that narrows `node --test`
 * to the test files related to what changed since `<base-ref>`, or prints
 * the full-suite sentinel when it cannot trust a narrower answer.
 *
 * This is additive tooling layered on top of the existing accounted suite
 * (`test-accounting.manifest.json`'s `polyfill-connectors` entry), not a
 * replacement for it. Per docs/reference/testing-policy.md: "An
 * affected-test selector may become the fast PR lane only after it runs in
 * shadow against complete suites and demonstrates an acceptable miss rate."
 * This script has not run that shadow period — it is for local iteration
 * only. The accounted full suite remains the merge-required gate.
 *
 * Usage:
 *   node --import tsx scripts/related-tests/cli.ts <base-ref> [--json]
 *
 * Exit code is always 0 on a successful classification (including
 * FULL_SUITE) — FULL_SUITE is not a script failure, it is the honest
 * fail-closed answer. Exit code 1 means the script itself could not
 * complete (git failure, graph build failure surfaced as an error the
 * caller must notice, etc.) — callers MUST treat exit 1 the same as
 * FULL_SUITE (run everything), never as "skip tests".
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "@pdpp/connector-protocol";
import { buildDependencyGraph, UntrustworthyGraphError } from "./graph.ts";
import { FULL_SUITE, selectRelatedTests } from "./select.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_ROOTS = ["bin", "connectors", "src"];

function listAllTsFiles(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") {
      continue;
    }
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      listAllTsFiles(root, fullPath, out);
    } else if (entry.endsWith(".ts")) {
      out.push(relative(root, fullPath));
    }
  }
}

function getChangedFiles(baseRef: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMRT", `${baseRef}...HEAD`], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  const packagePrefix = relative(gitRoot(), PACKAGE_ROOT);
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => line.startsWith(`${packagePrefix}/`))
    .map((line) => relative(packagePrefix, line));
}

function gitRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function main(): void {
  const [baseRef, ...rest] = process.argv.slice(2);
  const asJson = rest.includes("--json");

  if (!baseRef) {
    console.error("usage: node --import tsx scripts/related-tests/cli.ts <base-ref> [--json]");
    process.exit(1);
  }

  let changedRelativePaths: string[];
  try {
    changedRelativePaths = getChangedFiles(baseRef);
  } catch (error) {
    console.error(`[related-tests] failed to compute changed files via git: ${(error as Error).message}`);
    console.error("[related-tests] treat this as FULL_SUITE — do not skip tests.");
    process.exit(1);
  }

  const allRelativePaths: string[] = [];
  for (const root of SOURCE_ROOTS) {
    listAllTsFiles(PACKAGE_ROOT, join(PACKAGE_ROOT, root), allRelativePaths);
  }

  buildDependencyGraph(PACKAGE_ROOT)
    .then((graph) => {
      const result = selectRelatedTests({
        packageRoot: PACKAGE_ROOT,
        graph,
        allRelativePaths,
        changedRelativePaths,
      });
      emit(result, asJson);
    })
    .catch((error: unknown) => {
      if (error instanceof UntrustworthyGraphError) {
        emit({ kind: FULL_SUITE, reason: error.message }, asJson);
        return;
      }
      console.error(`[related-tests] unexpected failure building the dependency graph: ${(error as Error).message}`);
      console.error("[related-tests] treat this as FULL_SUITE — do not skip tests.");
      process.exit(1);
    });
}

function emit(result: { kind: string; testFiles?: readonly string[]; reason: string }, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.kind === FULL_SUITE) {
    console.error(`[related-tests] FULL_SUITE: ${result.reason}`);
    console.log(FULL_SUITE);
    return;
  }
  console.error(`[related-tests] related: ${result.reason}`);
  for (const testFile of result.testFiles ?? []) {
    console.log(testFile);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
