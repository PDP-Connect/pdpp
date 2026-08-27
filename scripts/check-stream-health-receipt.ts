#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Exact-revision stream-health acceptance receipt — executable, read-only.
//
// One command, one receipt: exhaustive owner connection summaries, resolved
// authenticated `/sources` DOM, strict per-stream facts (scripts/stream-health-audit/authority.ts),
// pagination completeness, the exact revision receipt, the global fleet-banner
// verdict (GET /_ref/fleet-health), and per-connection projection settlement —
// composed in scripts/stream-health-audit/receipt.ts. This is the acceptance
// command BANNER-ZERO-PLAN.md's workstream B scope calls for; it does not
// redefine any row's health classification, it only reports what the running
// instance already serves.
//
// Usage:
//   node scripts/check-stream-health-receipt.ts --origin https://pdpp.example.com
//   node scripts/check-stream-health-receipt.ts --json
//   node scripts/check-stream-health-receipt.ts --expected-revision <rev> --expected-sha <sha>
//
// Live owner auth (never printed) is read from the environment, same as
// scripts/check-stream-health-audit.ts:
//   PDPP_OWNER_SESSION_COOKIE   full Cookie header for an already-established
//                               owner session — used as-is, no network call.
//   PDPP_OWNER_PASSWORD         owner password; logs in via /owner/login.
//   PDPP_OWNER_TOKEN            owner bearer token (unsupported here — never
//                               sent as Authorization to a cookie-only route).
// An origin may also be supplied via PDPP_ACCEPTANCE_ORIGIN.
//
// No record payloads are printed — only connection ids, stream names,
// classes, exact score fields, the fleet-banner state, and the revision
// receipt.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runStreamHealthReceipt, type StreamHealthReceipt } from "./stream-health-audit/receipt.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
  expectedRevision: string | null;
  expectedSha: string | null;
  json: boolean;
  origin: string | null;
  report: boolean;
}

const VALUE_FLAGS: ReadonlyArray<{ flag: string; key: "expectedRevision" | "expectedSha" | "origin" }> = [
  { flag: "--origin", key: "origin" },
  { flag: "--expected-revision", key: "expectedRevision" },
  { flag: "--expected-sha", key: "expectedSha" },
];

function applyValueFlag(args: Args, argv: string[], index: number, arg: string): number {
  for (const { flag, key } of VALUE_FLAGS) {
    if (arg === flag) {
      args[key] = argv[index + 1] ?? null;
      return index + 2;
    }
    if (arg.startsWith(`${flag}=`)) {
      args[key] = arg.slice(flag.length + 1);
      return index + 1;
    }
  }
  return -1;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    expectedRevision: process.env.PDPP_EXPECTED_REFERENCE_REVISION?.trim() || null,
    expectedSha: process.env.PDPP_EXPECTED_SHA?.trim() || null,
    json: false,
    origin: null,
    report: true,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] ?? "";
    if (a === "--json") {
      args.json = true;
      i += 1;
      continue;
    }
    if (a === "--no-report") {
      args.report = false;
      i += 1;
      continue;
    }
    const next = applyValueFlag(args, argv, i, a);
    i = next === -1 ? i + 1 : next;
  }
  return args;
}

/** ISO-8601 timestamp safe for a filename (no colons). */
function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function renderMarkdown(receipt: StreamHealthReceipt): string {
  const { authority, fleetHealth, projectionSettlement: settlement } = receipt;
  const lines: string[] = [
    "# Stream-health acceptance receipt",
    "",
    `Generated: ${receipt.generatedAt}`,
    `Origin: ${receipt.origin}`,
    `Overall: ${receipt.ok ? "PASS" : "FAIL"}`,
    "",
    "## Revision receipt",
    "",
    `- exact: ${authority.revisionReceipt.exact}`,
    `- sha: ${authority.revisionReceipt.sha ?? "<none>"}`,
    `- observed (summaries): ${authority.revisionReceipt.observedSummaries ?? "<none>"}`,
    `- observed (DOM): ${authority.revisionReceipt.observedDom ?? "<none>"}`,
    "",
    "## Strict stream authority",
    "",
    `- status: ${authority.status}`,
    `- score: ${authority.score.ratio} (${authority.score.percentage === null ? "n/a" : `${authority.score.percentage}%`})`,
    `- connections: ${authority.connectionCount} (active: ${authority.activeConnectionCount})`,
    `- gates: auth=${authority.gates.auth} dom=${authority.gates.dom} pagination=${authority.gates.pagination} revision=${authority.gates.revision} vocabulary=${authority.gates.vocabulary}`,
    `- DOM agreement: ${authority.domAgreement.status}`,
    "",
    "## Global fleet banner",
    "",
    `- fetched: ${fleetHealth.fetched}`,
    `- state: ${fleetHealth.state ?? "<unresolved>"}`,
    `- fully_healthy: ${fleetHealth.fullyHealthy ?? "<unresolved>"}`,
    `- quiet (banner absent): ${fleetHealth.ok}`,
    ...(fleetHealth.error ? [`- error: ${fleetHealth.error}`] : []),
    "",
    "## Projection settlement",
    "",
    `- evaluated: ${settlement.evaluated}`,
    `- settled: ${settlement.settled}`,
    `- unsettled rows: ${settlement.unsettledCount}`,
  ];
  for (const row of settlement.rows.filter((r) => !r.settled)) {
    lines.push(
      `  - ${row.connectionId ?? "<unknown>"} (${row.connectorId ?? "<unknown>"}): ${row.reason ?? "<unknown>"}`
    );
  }
  if (authority.status !== "pass") {
    lines.push("", "## Non-green findings", "", "connection\tstream\tclass\tscored\treason");
    for (const item of authority.findings.filter((f) => f.class !== "green")) {
      lines.push(
        `${item.connection_id ?? "<audit>"}\t${item.stream}\t${item.class}\t${item.denominator ? "yes" : "no"}\t${item.reason}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const origin = args.origin ?? process.env.PDPP_ACCEPTANCE_ORIGIN ?? null;

  if (!origin) {
    process.stderr.write("stream-health receipt: no origin supplied. Pass --origin or set PDPP_ACCEPTANCE_ORIGIN.\n");
    process.exitCode = 1;
    return;
  }

  const receipt = await runStreamHealthReceipt({
    expectedRevision: args.expectedRevision,
    expectedSha: args.expectedSha,
    origin,
  });

  let reportPath: string | null = null;
  if (args.report) {
    const dir = path.join(REPO_ROOT, "tmp", "workstreams");
    await mkdir(dir, { recursive: true });
    reportPath = path.join(dir, `stream-health-receipt-${fileStamp(receipt.generatedAt)}.md`);
    await writeFile(reportPath, renderMarkdown(receipt), "utf8");
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    process.stdout.write(`stream-health receipt: ${receipt.ok ? "PASS" : "FAIL"}\n`);
    process.stdout.write(
      `  authority: ${receipt.authority.status} (${receipt.authority.score.ratio}, revision ${receipt.authority.gates.revision})\n`
    );
    process.stdout.write(
      `  fleet banner: ${receipt.fleetHealth.state ?? "<unresolved>"} (quiet=${receipt.fleetHealth.ok})\n`
    );
    process.stdout.write(
      `  projection settlement: ${receipt.projectionSettlement.settled ? "settled" : `${receipt.projectionSettlement.unsettledCount} unsettled`}\n`
    );
    if (reportPath) {
      process.stdout.write(`report: ${path.relative(REPO_ROOT, reportPath)}\n`);
    }
  }

  process.exitCode = receipt.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
