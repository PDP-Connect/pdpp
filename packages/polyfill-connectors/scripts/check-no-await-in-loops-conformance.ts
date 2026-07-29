#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Conformance gate for `lint/performance/noAwaitInLoops`.
 *
 * Two-layer design. biome.jsonc DELIBERATELY keeps a package-wide
 * `noAwaitInLoops: "off"` override in place (see its own comment for why:
 * the package's dominant loop shapes are genuinely sequential — ordered
 * protocol emission, one-shared-page browser interaction, dependent
 * pagination, retry/backoff, etc.) — that override is NOT removed or
 * bypassed by this script, and ordinary `pnpm check`/`biome check` runs
 * never re-enable the rule on their own.
 *
 * This script is the independent second layer: it re-runs Biome with the
 * rule forced back to "error" for its own invocation only (via a scratch
 * config that `extends` the real biome.jsonc, so every OTHER rule/override
 * stays exactly as configured), and diffs the resulting live findings
 * against the checked-in exact allowlist in
 * `scripts/no-await-in-loops-allowlist.ts` — the only sanctioned exception
 * mechanism. That allowlist diff, not the biome.jsonc override, is what
 * actually prevents an unreviewed new sequential await from landing. The
 * script fails the build on either divergence:
 *
 *   1. NEW/UNLISTED — a live finding whose (path, line, column) is not in
 *      the allowlist. This is the actual "did a new sequential await sneak
 *      in without review" check the policy exists for.
 *   2. STALE — an allowlist row whose location Biome no longer flags. The
 *      code at that spot moved, was rewritten, or was deleted; the old
 *      exception is no longer attached to real code and must be re-reviewed
 *      (re-added at its new location, or dropped) rather than silently kept
 *      forever.
 *
 * Deterministic: matches purely on (path, line, column) triples from
 * Biome's own JSON reporter — no fuzzy/text matching, no snapshot of
 * diagnostic message text (which could change between Biome versions).
 *
 * Fails CLOSED on duplicate location keys on either side, checked
 * explicitly rather than left to collapse silently inside a Set/Map:
 *   - a duplicate ALLOWLIST row (same path/line/column listed twice) is a
 *     structural defect in the allowlist itself — checked before Biome
 *     even runs, so it can never be masked by a live finding count that
 *     happens to line up.
 *   - Biome can and does emit the SAME location more than once for a
 *     single loop (observed for one real site in this package); live
 *     findings are normalized to unique locations with an explicit count
 *     per location before comparison, so a repeated emission can never be
 *     mistaken for two distinct findings or hide a real duplicate.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/is-main-module.ts";
import { NO_AWAIT_IN_LOOPS_ALLOWLIST } from "./no-await-in-loops-allowlist.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIOME_BIN = join(PACKAGE_ROOT, "node_modules", ".bin", "biome");
const RULE_CATEGORY = "lint/performance/noAwaitInLoops";

interface BiomeLocation {
  path: string;
  start: { line: number; column: number };
}

interface BiomeDiagnostic {
  category?: string;
  location?: BiomeLocation;
}

interface BiomeReport {
  diagnostics: BiomeDiagnostic[];
}

interface LiveFinding {
  column: number;
  line: number;
  path: string;
}

/** Exported for `src/no-await-in-loops-conformance-self-check.test.ts`. */
export function locationKey(entry: { path: string; line: number; column: number }): string {
  return `${entry.path}:${entry.line}:${entry.column}`;
}

/**
 * Count occurrences of each location key across a list. Used on BOTH sides
 * of the comparison — never fed straight into a Set/Map that would collapse
 * duplicates before they can be inspected.
 *
 * Exported for `src/no-await-in-loops-conformance-self-check.test.ts`.
 */
export function countByLocationKey<T extends { path: string; line: number; column: number }>(
  entries: readonly T[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = locationKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Run Biome with `noAwaitInLoops` forced to "error" for the same
 * `src/`, `bin/`, `bench/`, `connectors/` scope the package's other
 * overrides use, via a scratch config placed inside the package root
 * (Biome resolves `extends` relative to the config file's own directory,
 * so it must live alongside biome.jsonc, not in a system tmp dir).
 */
function collectLiveFindings(): LiveFinding[] {
  const scratchConfigPath = join(PACKAGE_ROOT, `.biome-noAwaitInLoops-conformance.${process.pid}.jsonc`);
  const reportPath = join(mkdtempSync(join(tmpdir(), "pdpp-noawait-conformance-")), "report.json");
  const scratchConfig = JSON.stringify({
    extends: ["./biome.jsonc"],
    overrides: [
      {
        includes: ["src/**/*.ts", "bin/**/*.ts", "bench/**/*.ts", "connectors/**/*.ts"],
        linter: {
          rules: {
            performance: {
              noAwaitInLoops: "error",
            },
          },
        },
      },
    ],
  });
  writeFileSync(scratchConfigPath, scratchConfig);
  try {
    try {
      execFileSync(
        BIOME_BIN,
        [
          "check",
          `--config-path=${scratchConfigPath}`,
          "--only=performance/noAwaitInLoops",
          "--max-diagnostics=2000",
          "--reporter=json",
          `--reporter-file=${reportPath}`,
          ".",
        ],
        { cwd: PACKAGE_ROOT, stdio: "pipe" }
      );
    } catch {
      // Biome exits non-zero whenever it reports ANY diagnostic (including
      // the scratch config's own formatting, which we don't care about) —
      // the report file is what matters, not the exit code.
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as BiomeReport;
    return report.diagnostics
      .filter((d) => d.category === RULE_CATEGORY && d.location)
      .map((d) => ({
        path: d.location?.path ?? "",
        line: d.location?.start.line ?? 0,
        column: d.location?.start.column ?? 0,
      }));
  } finally {
    rmSync(scratchConfigPath, { force: true });
    rmSync(dirname(reportPath), { recursive: true, force: true });
  }
}

function main(): void {
  // Structural check FIRST, before Biome even runs: a duplicate allowlist
  // row is a defect in the checked-in data itself, independent of whatever
  // Biome reports live. Checking this up front means it can never be
  // masked by a live finding count that happens to add up (which is
  // exactly how two identical `src/collector-runner.ts:1984:7` rows
  // previously went unnoticed — Biome emits that same location twice, so
  // the duplicate allowlist row's count also matched, and a naive
  // Set/Map-based comparison saw no discrepancy).
  const allowlistKeyCounts = countByLocationKey(NO_AWAIT_IN_LOOPS_ALLOWLIST);
  const duplicateAllowlistEntries = [...allowlistKeyCounts.entries()].filter(([, count]) => count > 1);
  if (duplicateAllowlistEntries.length > 0) {
    console.error(
      `\n[check-no-await-in-loops-conformance] ${duplicateAllowlistEntries.length} DUPLICATE allowlist location key(s) in scripts/no-await-in-loops-allowlist.ts:`
    );
    for (const [key, count] of duplicateAllowlistEntries) {
      console.error(`  ${key} — listed ${count} times`);
    }
    console.error(
      "\nEach (path, line, column) must appear at most once. Remove the redundant row(s) — a duplicate" +
        " silently defeats the exact-match guarantee this allowlist exists to provide."
    );
    process.exit(1);
  }

  const live = collectLiveFindings();

  // Normalize live findings to unique locations with an EXPLICIT per-location
  // count. Biome can and does emit the same (path, line, column) more than
  // once for a single loop; folding straight into a Set/Map without
  // recording the count would silently discard that fact rather than
  // reporting it. It is not itself a failure (it's an upstream Biome
  // idiosyncrasy, not a code defect), but it must be visible, not masked.
  const liveKeyCounts = countByLocationKey(live);
  const liveByKey = new Map<string, LiveFinding>();
  for (const finding of live) {
    liveByKey.set(locationKey(finding), finding);
  }
  const uniqueLiveLocations = [...liveByKey.keys()];
  const repeatedLiveLocations = [...liveKeyCounts.entries()].filter(([, count]) => count > 1);

  const allowedKeys = new Set(allowlistKeyCounts.keys());

  const unlisted = uniqueLiveLocations.filter((key) => !allowedKeys.has(key));
  const stale = NO_AWAIT_IN_LOOPS_ALLOWLIST.filter((entry) => !liveByKey.has(locationKey(entry)));

  if (unlisted.length === 0 && stale.length === 0) {
    const repeatNote =
      repeatedLiveLocations.length > 0
        ? ` (${repeatedLiveLocations.length} location(s) Biome reported more than once, normalized to 1 each: ${repeatedLiveLocations.map(([key, count]) => `${key}×${count}`).join(", ")})`
        : "";
    console.log(
      `[check-no-await-in-loops-conformance] ${uniqueLiveLocations.length} unique live noAwaitInLoops location(s) (${live.length} raw diagnostic(s)${repeatNote}) all match the checked-in allowlist (${NO_AWAIT_IN_LOOPS_ALLOWLIST.length} entries). No new, stale, or duplicate sequential awaits.`
    );
    return;
  }

  if (unlisted.length > 0) {
    console.error(
      `\n[check-no-await-in-loops-conformance] ${unlisted.length} NEW/UNLISTED noAwaitInLoops finding(s) — not in scripts/no-await-in-loops-allowlist.ts:`
    );
    for (const key of unlisted) {
      console.error(`  ${key}`);
    }
    console.error(
      "\nEither parallelize the loop (if the iterations are genuinely independent — e.g. with Promise.all)," +
        " or add a reviewed entry to scripts/no-await-in-loops-allowlist.ts with a specific, non-generic reason category."
    );
  }

  if (stale.length > 0) {
    console.error(
      `\n[check-no-await-in-loops-conformance] ${stale.length} STALE allowlist entr${stale.length === 1 ? "y" : "ies"} — Biome no longer flags this location:`
    );
    for (const entry of stale) {
      console.error(`  ${entry.path}:${entry.line}:${entry.column} (${entry.category}: ${entry.note})`);
    }
    console.error(
      "\nThe code at this location moved, changed shape, or was deleted. Re-review: if the same intentional" +
        " sequential await still exists, find its new (path, line, column) and update the entry; otherwise remove it."
    );
  }

  process.exit(1);
}

// Guarded so a test importing this module for its pure helpers (locationKey,
// countByLocationKey) doesn't also trigger a real Biome run as a side effect.
if (isMainModule(import.meta.url)) {
  main();
}
