#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Generated stream-evidence inventory (task 9.2).
//
// Walks packages/polyfill-connectors/manifests/*.json and
// reference-implementation/manifests/*.json and emits a deterministic
// markdown table of every declared stream's coverage/freshness evidence
// posture: docs/reference/stream-evidence-inventory.md.
//
// Modes:
//   node scripts/stream-evidence-inventory.mjs           writes the file
//   node scripts/stream-evidence-inventory.mjs --check    regenerates to a
//     buffer and exits 1 with a diff hint if the committed file is stale,
//     OR if any stream is missing a coverage_strategy/freshness_strategy,
//     OR if any stream combines required:true/default-required with an
//     accepted-absence coverage policy (deferred, inventory_only,
//     unavailable, unsupported). New debt fails the check even if the file
//     itself is fresh.
//
// This is a developer/CI audit, not a runtime module: it reads manifests
// from disk and writes a docs artifact. See
// openspec/changes/define-stream-coverage-freshness-evidence tasks.md 9.2.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_PATH = join(REPO_ROOT, "docs", "reference", "stream-evidence-inventory.md");

const MANIFEST_DIRS = [
  { label: "polyfill", path: join(REPO_ROOT, "packages", "polyfill-connectors", "manifests") },
  { label: "reference", path: join(REPO_ROOT, "reference-implementation", "manifests") },
];

/**
 * @returns {Array<{ manifestSet: string, connectorId: string, manifest: object }>}
 */
export function readManifests() {
  const manifests = [];
  for (const dir of MANIFEST_DIRS) {
    if (!existsSync(dir.path)) {
      continue;
    }
    for (const filename of readdirSync(dir.path).sort()) {
      if (!filename.endsWith(".json")) {
        continue;
      }
      const manifestPath = join(dir.path, filename);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifests.push({
        manifestSet: dir.label,
        connectorId: manifest.connector_key ?? manifest.connector_id ?? filename.replace(/\.json$/, ""),
        manifest,
      });
    }
  }
  return manifests;
}

function cell(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return String(value).replace(/\|/g, "\\|");
}

const ACCEPTED_ABSENCE_POLICIES = new Set(["deferred", "inventory_only", "unavailable", "unsupported"]);

function isAcceptedAbsencePolicy(policy) {
  return ACCEPTED_ABSENCE_POLICIES.has(policy);
}

/**
 * @param {Array<{ manifestSet: string, connectorId: string, manifest: object }>} manifests
 * @returns {{ markdown: string, missingStrategyCount: number, requiredAcceptedAbsenceCount: number }}
 */
export function renderInventory(manifests) {
  const lines = [];
  lines.push("# Stream evidence inventory");
  lines.push("");
  lines.push(
    "Generated artifact. Do not hand-edit — run `pnpm stream-evidence:inventory` to regenerate, " +
      "and `pnpm stream-evidence:check` to verify it is current."
  );
  lines.push("");
  lines.push(
    "One row per declared manifest stream, across `packages/polyfill-connectors/manifests/*.json` and " +
      "`reference-implementation/manifests/*.json`. `required` defaults to `true` when the manifest does not " +
      "declare it. This inventory records declared strategy, not observed runtime proof — see " +
      "`openspec/changes/define-stream-coverage-freshness-evidence/specs/reference-connection-health/spec.md` " +
      "for how the runtime derives per-stream coverage from these strategies plus observed collection facts."
  );
  lines.push("");

  let missingStrategyCount = 0;
  let requiredAcceptedAbsenceCount = 0;

  for (const { manifestSet, connectorId, manifest } of manifests) {
    lines.push(`## ${manifestSet}/${connectorId}`);
    lines.push("");
    lines.push(
      "| stream | coverage_strategy | freshness_strategy | coverage_policy | required | state_stream | availability.state |"
    );
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");

    const streams = Array.isArray(manifest.streams) ? manifest.streams : [];
    for (const stream of streams) {
      const coverageStrategy = stream?.coverage_strategy ?? null;
      const freshnessStrategy = stream?.freshness_strategy ?? null;
      if (coverageStrategy == null || freshnessStrategy == null) {
        missingStrategyCount += 1;
      }
      const required = stream?.required === false ? "false" : "true";
      if (stream?.required !== false && isAcceptedAbsencePolicy(stream?.coverage_policy)) {
        requiredAcceptedAbsenceCount += 1;
      }
      lines.push(
        `| ${cell(stream?.name)} | ${cell(coverageStrategy)} | ${cell(freshnessStrategy)} | ` +
          `${cell(stream?.coverage_policy)} | ${cell(required)} | ${cell(stream?.state_stream)} | ` +
          `${cell(stream?.availability?.state)} |`
      );
    }
    lines.push("");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(`${missingStrategyCount} stream(s) missing a coverage_strategy or freshness_strategy declaration (debt).`);
  lines.push(
    `${requiredAcceptedAbsenceCount} stream(s) combine required=true/default-required with an accepted-absence coverage_policy (debt).`
  );

  return { markdown: `${lines.join("\n")}\n`, missingStrategyCount, requiredAcceptedAbsenceCount };
}

function parseArgs(argv) {
  return { check: argv.includes("--check") };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifests = readManifests();
  const { markdown, missingStrategyCount, requiredAcceptedAbsenceCount } = renderInventory(manifests);

  if (!args.check) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, markdown, "utf8");
    process.stdout.write(`Wrote ${OUTPUT_PATH.replace(`${REPO_ROOT}/`, "")}\n`);
    if (missingStrategyCount > 0) {
      process.stdout.write(`Note: ${missingStrategyCount} stream(s) still missing a strategy declaration.\n`);
    }
    if (requiredAcceptedAbsenceCount > 0) {
      process.stdout.write(
        `Note: ${requiredAcceptedAbsenceCount} stream(s) still combine required=true/default-required with an accepted-absence coverage_policy.\n`
      );
    }
    return;
  }

  const existing = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, "utf8") : null;
  const stale = existing !== markdown;
  const hasNewDebt = missingStrategyCount > 0 || requiredAcceptedAbsenceCount > 0;

  if (!stale && !hasNewDebt) {
    process.stdout.write(
      "stream-evidence inventory: PASS (artifact current, no missing strategies, no required+accepted-absence contradictions)\n"
    );
    process.exitCode = 0;
    return;
  }

  if (stale) {
    process.stdout.write(
      "stream-evidence inventory: FAIL — docs/reference/stream-evidence-inventory.md is stale.\n" +
        "Run `pnpm stream-evidence:inventory` and commit the result.\n"
    );
  }
  if (hasNewDebt) {
    if (missingStrategyCount > 0) {
      process.stdout.write(
        `stream-evidence inventory: FAIL — ${missingStrategyCount} stream(s) are missing a coverage_strategy or ` +
          "freshness_strategy declaration. Every new or touched stream must declare both.\n"
      );
    }
    if (requiredAcceptedAbsenceCount > 0) {
      process.stdout.write(
        `stream-evidence inventory: FAIL — ${requiredAcceptedAbsenceCount} stream(s) combine required=true/default-required with an accepted-absence coverage_policy. Such manifests are contradictory and must opt out of requiredness.\n`
      );
    }
  }
  process.exitCode = 1;
}

// Only run when invoked directly, so tests can import the render function
// without triggering a process exit or filesystem write.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
