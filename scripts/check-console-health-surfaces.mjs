#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guard the connection-health owner surfaces against raw health re-derivation.
//
// The reference owns the raw evidence -> RenderedVerdict synthesis. Console
// owner attention surfaces must consume the rendered verdict; diagnostics may
// still show raw evidence under an explicit inspection layer.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

const ACTIVE_OWNER_SURFACE_PATHS = new Set([
  "apps/console/src/app/(console)/sources/page.tsx",
  "apps/console/src/app/(console)/sources/sources-view.tsx",
  "apps/console/src/app/(console)/sources/sources-view-model.ts",
  "apps/console/src/app/(console)/sources/[connector]/page.tsx",
]);

const LEGACY_RAW_HEALTH_PATHS = new Set(["apps/console/src/app/(console)/sources/connector-row.tsx"]);

const RULES = [
  {
    id: "raw-health-state",
    message: "owner surface must read rendered_verdict.pill/channel, not raw health.state",
    pattern: /\b(?:health|connectionHealth)\.state\b/,
  },
  {
    id: "legacy-next-action",
    message: "owner surface must derive CTAs from rendered_verdict.required_actions",
    pattern:
      /\b(?:formatNextAction\(|summary\.next_action|connection_health\?\.next_action|connectionHealth\?\.next_action)/,
  },
  {
    id: "legacy-failure-expander",
    message: "owner surface must route health explanation through RenderedVerdict/diagnostics",
    pattern: /\b(?:deriveFailureSummary|FailureExpander)\b/,
  },
  {
    id: "raw-primary-action-health",
    message: "owner surface must not derive primary action from raw health axes",
    pattern: /derivePrimaryRowAction\(\{[\s\S]{0,240}\bhealth:/,
  },
  {
    id: "inspection-field-on-dashboard",
    message: "mechanistic counts/timers belong in diagnostics, not the dashboard attention layer",
    pattern: /\b(?:detail_gap_backlog|collection_rate|next_attempt_at)\b/,
  },
];

function lineForOffset(src, offset) {
  return src.slice(0, offset).split("\n").length;
}

export function scanActiveOwnerSurface(relPath, src) {
  const findings = [];
  if (!ACTIVE_OWNER_SURFACE_PATHS.has(relPath)) {
    return findings;
  }
  for (const rule of RULES) {
    const match = rule.pattern.exec(src);
    if (match) {
      findings.push({
        line: lineForOffset(src, match.index),
        message: rule.message,
        path: relPath,
        ruleId: rule.id,
      });
    }
  }
  return findings;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") {
      continue;
    }
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (/\.(?:ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

export function findLegacyConnectorRowImports(files) {
  const findings = [];
  for (const [relPath, src] of files) {
    if (LEGACY_RAW_HEALTH_PATHS.has(relPath) || /\.test\.(?:ts|tsx)$/.test(relPath)) {
      continue;
    }
    if (/from ["'][^"']*connector-row(?:\.tsx)?["']|<ConnectorRow\b/.test(src)) {
      findings.push({
        line: lineForOffset(src, src.search(/connector-row|<ConnectorRow\b/)),
        message: "connector-row.tsx is a legacy raw-health surface; do not reintroduce it",
        path: relPath,
        ruleId: "legacy-connector-row-reactivated",
      });
    }
  }
  return findings;
}

export function checkRepository(root = REPO_ROOT) {
  const sourceRoot = path.join(root, "apps", "console", "src", "app");
  const files = new Map(
    walk(sourceRoot).map((fullPath) => {
      const relPath = path.relative(root, fullPath).replaceAll(path.sep, "/");
      return [relPath, readFileSync(fullPath, "utf8")];
    })
  );
  const findings = [];
  for (const [relPath, src] of files) {
    findings.push(...scanActiveOwnerSurface(relPath, src));
  }
  findings.push(...findLegacyConnectorRowImports(files));
  return findings;
}

function parseArgs(argv) {
  return { json: argv.includes("--json") };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const findings = checkRepository();
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ findings, ok: findings.length === 0 }, null, 2)}\n`);
  } else if (findings.length === 0) {
    process.stdout.write("console health-surface gate: PASS\n");
  } else {
    process.stdout.write(`console health-surface gate: FAIL (${findings.length} finding(s))\n`);
    for (const finding of findings) {
      process.stdout.write(`  ${finding.path}:${finding.line} [${finding.ruleId}] ${finding.message}\n`);
    }
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
