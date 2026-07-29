// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI entrypoint for the T1 test-migration transform. This is the SCRIPT
 * the packet requires — T1/T2 must not devolve into file-by-file agent
 * authoring, so this is what an operator (or a batch runner) actually
 * invokes, not a library callers hand-assemble per file.
 *
 * Modes:
 *   --precheck <file...>   run Stage A's fail-closed preconditions only,
 *                          without mutating anything on disk.
 *   --stage-a <file...>    run Stage A (rename + catch-clause narrowing)
 *                          for real, after a clean precheck.
 *   --stage-b <file...>    detect (report-only; never mutates) Stage B
 *                          author-once/propagate-many clusters across a
 *                          set of ALREADY-.ts files, ranked by
 *                          potentialErrorMassReduction.
 *   --oracle --before <ref-or-dir> --after <dir> --renames <json>
 *                          run the equivalence oracle comparing a "before"
 *                          tracked-file listing to an "after" one, given a
 *                          recorded rename map (see rename-map.ts).
 *
 * All paths given to --stage-a/--precheck must be repository-relative
 * `.js`/`.mjs`/`.cjs` paths under a single repo root (the current git
 * root); this mirrors scripts/test-accounting's own path-handling
 * convention (repository-relative, normalized, never absolute).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitRoot, trackedFiles } from "../test-accounting/inventory.ts";
import { runEquivalenceOracle } from "./equivalence-oracle.ts";
import { buildRenameMap } from "./rename-map.ts";
import { runStageA, stageAPrecheck } from "./stage-a.ts";
import { detectStageBClusters } from "./stage-b.ts";

function fail(message: string): never {
  process.stderr.write(`test-migration: ${message}\n`);
  process.exit(1);
}

function parseFileList(args: string[]): string[] {
  if (args.length === 0) {
    fail("at least one file path is required");
  }
  return args;
}

function runPrecheck(files: string[], root: string): void {
  const report = stageAPrecheck(files, root);
  process.stdout.write(`${JSON.stringify(report, replacer, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function runStageACommand(files: string[], root: string): void {
  const result = runStageA(files, root);
  process.stdout.write(`${JSON.stringify(result, replacer, 2)}\n`);
}

function runStageBCommand(files: string[], root: string): void {
  const clusters = files.flatMap((file) => {
    const absolute = resolve(root, file);
    const sourceText = readFileSync(absolute, "utf8");
    return detectStageBClusters(sourceText, absolute).map((cluster) => ({ file, ...cluster }));
  });
  clusters.sort((a, b) => b.potentialErrorMassReduction - a.potentialErrorMassReduction);
  process.stdout.write(`${JSON.stringify(clusters, replacer, 2)}\n`);
}

function replacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? Object.fromEntries(value) : value;
}

interface OracleArgs {
  after?: string;
  before?: string;
  renames?: string;
}
function parseOracleArgs(args: string[]): OracleArgs {
  const result: OracleArgs = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--before" && value) {
      result.before = value;
      i += 1;
    } else if (flag === "--after" && value) {
      result.after = value;
      i += 1;
    } else if (flag === "--renames" && value) {
      result.renames = value;
      i += 1;
    } else {
      fail(`unknown --oracle argument: ${flag}`);
    }
  }
  return result;
}

/**
 * Runs the equivalence oracle comparing two on-disk directory snapshots
 * (--before and --after, each a repository-relative or absolute directory
 * whose tracked `reference-implementation/test/**` files are the input),
 * given a rename map JSON file (an array of repository-relative `.js`
 * source paths, RELATIVE TO the --before root).
 */
function runOracleCommand(args: string[], root: string): void {
  const parsed = parseOracleArgs(args);
  if (!(parsed.before && parsed.after && parsed.renames)) {
    fail("--oracle requires --before <dir> --after <dir> --renames <json file>");
  }
  const beforeRoot = resolve(root, parsed.before);
  const afterRoot = resolve(root, parsed.after);
  const renameFromPaths: string[] = JSON.parse(readFileSync(resolve(root, parsed.renames), "utf8"));
  const renameMap = buildRenameMap(renameFromPaths, beforeRoot);
  const beforeFiles = trackedFiles(beforeRoot);
  const afterFiles = trackedFiles(afterRoot);
  const report = runEquivalenceOracle(beforeFiles, afterFiles, renameMap, root, { beforeRoot, afterRoot });
  process.stdout.write(`${JSON.stringify(report, replacer, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function main(): void {
  const [mode, ...rest] = process.argv.slice(2);
  const root = gitRoot();
  if (mode === "--precheck") {
    runPrecheck(parseFileList(rest), root);
  } else if (mode === "--stage-a") {
    runStageACommand(parseFileList(rest), root);
  } else if (mode === "--stage-b") {
    runStageBCommand(parseFileList(rest), root);
  } else if (mode === "--oracle") {
    runOracleCommand(rest, root);
  } else {
    fail("choose exactly one of --precheck, --stage-a, --stage-b, --oracle");
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main();
}
