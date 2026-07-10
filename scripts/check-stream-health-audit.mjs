#!/usr/bin/env node
// Stream-health machine audit — CLI entry.
//
// Fails when a required stream lacks a resolved coverage posture beneath a
// Healthy connection verdict: resting unknown/unmeasured coverage, or an
// accepted-absence condition on a required stream (contradictory manifest).
// There is no active-run exemption — under active bounded work the verdict
// contract renders Syncing/Checking, never Healthy, so Healthy + active
// work + required-unknown is an impossible snapshot and fails. See
// openspec/changes/define-stream-coverage-freshness-evidence tasks.md 9.1
// and specs/reference-connection-health/spec.md "A reproducible machine
// audit SHALL fail on unmeasured required streams beneath Healthy".
//
// Usage:
//   node scripts/check-stream-health-audit.mjs --origin https://pdpp.example.com
//   node scripts/check-stream-health-audit.mjs --json
//
// This CLI only runs the live probe — it requires an origin (via --origin
// or PDPP_ACCEPTANCE_ORIGIN). The seeded local audit lives in the unit
// test at reference-implementation/test/stream-health-audit.test.js
// (`node --test` target, wired into CI separately).
//
// Live owner auth (never printed) is read from the environment, matching
// scripts/owner-journey-acceptance/live.mjs:
//   PDPP_OWNER_SESSION_COOKIE   full Cookie header for an owner session
//   PDPP_OWNER_TOKEN            owner bearer token (fallback)
// An origin may also be supplied via PDPP_ACCEPTANCE_ORIGIN.
//
// No record payloads are printed — only connection labels/ids, stream
// names, and evidence classes (strategy_declaration_missing,
// runtime_evidence_missing, accepted_absence_on_required — see
// scripts/stream-health-audit/live.mjs for what each suggests
// investigating).

import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runLiveStreamHealthAudit } from "./stream-health-audit/live.mjs";

function parseArgs(argv) {
  const args = { json: false, origin: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      args.json = true;
    } else if (a === "--origin") {
      args.origin = argv[++i] ?? null;
    } else if (a.startsWith("--origin=")) {
      args.origin = a.slice("--origin=".length);
    }
  }
  return args;
}

function renderFailuresTable(failures) {
  const lines = ["connection\tstream\tevidence_class"];
  for (const failure of failures) {
    const label = failure.connection_label ?? failure.connection_id ?? "<unknown>";
    for (const stream of failure.streams) {
      lines.push(`${label}\t${stream.stream}\t${stream.class}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const origin = args.origin ?? process.env.PDPP_ACCEPTANCE_ORIGIN ?? null;

  if (!origin) {
    process.stderr.write(
      "stream-health audit: no origin supplied. Pass --origin or set PDPP_ACCEPTANCE_ORIGIN.\n" +
        "For the seeded/local audit, run: node --test reference-implementation/test/stream-health-audit.test.js\n"
    );
    process.exitCode = 1;
    return;
  }

  const result = await runLiveStreamHealthAudit({ origin });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.fetched) {
    process.stdout.write(`stream-health audit: INCONCLUSIVE — ${result.error}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `stream-health audit: PASS (${result.connectionCount} connection(s) checked, auth mode: ${result.authMode})\n`
    );
  } else {
    process.stdout.write(
      `stream-health audit: FAIL (${result.failures.length} connection(s) with masked required streams)\n`
    );
    process.stdout.write(`${renderFailuresTable(result.failures)}\n`);
  }

  process.exitCode = result.ok ? 0 : 1;
}

// Only run when invoked directly, so tests can import the modules without
// triggering a process exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
