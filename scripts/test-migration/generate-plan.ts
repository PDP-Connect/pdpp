// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * T2-BATCH-PREP CLI entrypoint. Produces the batching plan artifact for
 * the full 741-file `reference-implementation/test/**\/*.js` tranche:
 *
 *   node --import tsx scripts/test-migration/generate-plan.ts [--validate N] [--out <file>]
 *
 * `--validate N` (default 0) additionally runs family-validate.ts's real
 * disposable-worktree measurement against the top N families by projected
 * clusterable mass — this is slow (each family costs 2 full
 * `git worktree add` + `pnpm install` + `tsc` cycles) and touches the real
 * filesystem/git/npm registry, so it defaults OFF; the plan itself
 * (mechanical grouping + projection) is always fast and side-effect-free.
 *
 * This script performs read-only analysis of `reference-implementation/test/**`
 * plus (only with --validate) disposable `git worktree` operations against
 * THIS repo's own HEAD — it never writes to `reference-implementation/**`
 * in the caller's own working tree.
 */

import { writeFileSync } from "node:fs";
import { gitRoot, trackedFiles } from "../test-accounting/inventory.ts";
import { buildBatchPlan, summarizePlan } from "./batch-plan.ts";
import { validateFamily } from "./family-validate.ts";
import { extractAllSurfaces, groupIntoFamilies } from "./helper-family.ts";

const TEST_JS_PREFIX = "reference-implementation/test/";
const TEST_JS_SUFFIX = ".js";

function parseArgs(argv: string[]): { outFile: string | null; validateTop: number } {
  let validateTop = 0;
  let outFile: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--validate" && argv[i + 1]) {
      validateTop = Number.parseInt(argv[i + 1] as string, 10);
      i += 1;
    } else if (argv[i] === "--out" && argv[i + 1]) {
      outFile = argv[i + 1] as string;
      i += 1;
    }
  }
  return { outFile, validateTop };
}

function main(): void {
  const { validateTop, outFile } = parseArgs(process.argv.slice(2));
  const root = gitRoot();
  const files = trackedFiles(root).filter((f) => f.startsWith(TEST_JS_PREFIX) && f.endsWith(TEST_JS_SUFFIX));
  process.stderr.write(`generate-plan: extracting helper surfaces for ${files.length} files...\n`);
  const surfaces = extractAllSurfaces(files, root);
  const unparseable = surfaces.filter((s) => s.unparseable);
  if (unparseable.length > 0) {
    process.stderr.write(
      `generate-plan: WARNING ${unparseable.length} files unparseable, excluded from clustering: ${unparseable.map((s) => s.file).join(", ")}\n`
    );
  }
  const families = groupIntoFamilies(surfaces);
  const measurements = new Map<string, Awaited<ReturnType<typeof validateFamily>>>();
  if (validateTop > 0) {
    const candidateFamilies = families
      .filter((f) => f.kind !== "ungrouped")
      .slice()
      .sort(
        (a, b) =>
          b.files.reduce((s, f) => s + f.localHelperClusterErrorMass, 0) -
          a.files.reduce((s, f) => s + f.localHelperClusterErrorMass, 0)
      )
      .slice(0, validateTop);
    for (const family of candidateFamilies) {
      process.stderr.write(
        `generate-plan: validating family "${family.name}" (${family.files.length} files) on disposable worktrees...\n`
      );
      const result = validateFamily(
        root,
        family.name,
        family.files.map((f) => f.file),
        {
          installCommand: ["pnpm", ["install", "--frozen-lockfile"]],
        }
      );
      measurements.set(family.name, result);
      process.stderr.write(
        `generate-plan: "${family.name}" -> attributable=${result.attributableErrorCount}, clusterable=${result.clusterableErrorMass} (${result.clusterableSharePercent.toFixed(1)}%)\n`
      );
    }
  }
  const plan = buildBatchPlan(families, measurements);
  const summary = summarizePlan(plan);
  const output = { summary, plan };
  const json = JSON.stringify(output, null, 2);
  if (outFile) {
    writeFileSync(outFile, json, "utf8");
    process.stderr.write(`generate-plan: wrote ${outFile}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

main();
