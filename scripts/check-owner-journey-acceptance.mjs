#!/usr/bin/env node
// Owner-journey acceptance harness — CLI entry.
//
// Scans the normal owner setup surfaces for the failure classes that broke the
// owner setup walkthrough, and optionally probes a live origin with owner auth.
// Writes a timestamped report under `tmp/workstreams/` and exits non-zero on any
// violation, so it can gate CI or a manual owner acceptance run.
//
// Usage:
//   node scripts/check-owner-journey-acceptance.mjs
//   node scripts/check-owner-journey-acceptance.mjs --origin https://pdpp.example.com
//   node scripts/check-owner-journey-acceptance.mjs --json
//   node scripts/check-owner-journey-acceptance.mjs --no-report   # skip file write
//
// Live owner auth (never printed) is read from the environment:
//   PDPP_OWNER_SESSION_COOKIE   full Cookie header for an owner session, or
//   PDPP_OWNER_TOKEN            owner bearer token.
// An origin may also be supplied via PDPP_ACCEPTANCE_ORIGIN.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { checkCleanShellFreshness } from "./owner-journey-acceptance/clean-shell.mjs";
import { runLocalAcceptance, REPO_ROOT } from "./owner-journey-acceptance/harness.mjs";
import { runLiveAcceptance } from "./owner-journey-acceptance/live.mjs";
import { renderReport } from "./owner-journey-acceptance/report.mjs";
import { PUBLISHED_PACKAGES } from "./owner-journey-acceptance/surface-manifest.mjs";

function parseArgs(argv) {
  const args = { json: false, report: true, origin: null, cleanShell: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      args.json = true;
    } else if (a === "--no-report") {
      args.report = false;
    } else if (a === "--clean-shell") {
      args.cleanShell = true;
    } else if (a === "--origin") {
      args.origin = argv[++i] ?? null;
    } else if (a.startsWith("--origin=")) {
      args.origin = a.slice("--origin=".length);
    }
  }
  return args;
}

/** ISO-8601 timestamp safe for a filename (no colons). */
function fileStamp(iso) {
  return iso.replace(/[:.]/g, "-");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const origin = args.origin ?? process.env.PDPP_ACCEPTANCE_ORIGIN ?? null;
  // Timestamp is taken here (CLI edge), not in the pure modules.
  const timestamp = new Date().toISOString();

  const local = await runLocalAcceptance();
  let live = null;
  if (origin) {
    live = await runLiveAcceptance({ origin });
  }

  // Opt-in clean-shell freshness: actually resolve the published packages and
  // confirm rendered subcommands exist in their `--help`. Network + install, so
  // it only runs with --clean-shell. Findings fold into the local result.
  let cleanShell = null;
  if (args.cleanShell) {
    cleanShell = await checkCleanShellFreshness({
      renderedCommands: local.renderedCommands,
      publishedPackages: PUBLISHED_PACKAGES,
    });
    local.findings.push(...cleanShell.findings);
    local.ok = local.findings.length === 0;
  }

  const markdown = renderReport({ local, live, cleanShell, timestamp });
  const overallOk = local.ok && (live ? live.ok : true);

  let reportPath = null;
  if (args.report) {
    const dir = path.join(REPO_ROOT, "tmp", "workstreams");
    await mkdir(dir, { recursive: true });
    reportPath = path.join(dir, `owner-journey-acceptance-${fileStamp(timestamp)}.md`);
    await writeFile(reportPath, markdown, "utf8");
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: overallOk,
          findingCount: local.findings.length + (live ? live.findings.length : 0),
          reportPath: reportPath ? path.relative(REPO_ROOT, reportPath) : null,
          local: { ok: local.ok, findings: local.findings },
          live: live ? { ok: live.ok, authMode: live.authMode, findings: live.findings } : null,
        },
        null,
        2
      )}\n`
    );
  } else {
    const findingCount = local.findings.length + (live ? live.findings.length : 0);
    process.stdout.write(`owner-journey acceptance: ${overallOk ? "PASS" : "FAIL"} (${findingCount} finding(s))\n`);
    for (const f of [...local.findings, ...(live ? live.findings : [])]) {
      process.stdout.write(`  [${f.class}] ${f.ruleId} ${f.path}:${f.line ?? 0}\n`);
    }
    if (reportPath) {
      process.stdout.write(`report: ${path.relative(REPO_ROOT, reportPath)}\n`);
    }
  }

  process.exitCode = overallOk ? 0 : 1;
}

// Only run when invoked directly, so tests can import the modules without
// triggering a process exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
