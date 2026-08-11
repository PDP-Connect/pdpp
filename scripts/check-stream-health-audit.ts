#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Stream-health acceptance authority — executable, read-only owner-fleet gate.
//
// The score is intentionally derived from the exhaustive owner connection
// inventory crossed with production streams declared by connector manifests.
// It requires current successful runtime evidence plus committed coverage or
// explicit verified-empty proof. Counts, checkpoints, and rendered pills are
// supporting projections, never proof by themselves.
//
// Usage:
//   node scripts/check-stream-health-audit.ts --origin https://pdpp.example.com
//   node scripts/check-stream-health-audit.ts --json
//
// This CLI only runs the live probe — it requires an origin (via --origin
// or PDPP_ACCEPTANCE_ORIGIN). Seeded local authority regressions live in
// scripts/stream-health-audit/authority.test.ts.
//
// Live owner auth (never printed) is read from the environment. `/_ref/connectors`
// is cookie-gated, so this audit only ever sends a Cookie header — but the
// cookie can come from either variable below (first match wins):
//   PDPP_OWNER_SESSION_COOKIE   full Cookie header for an already-established
//                               owner session — used as-is, no network call.
//   PDPP_OWNER_PASSWORD         owner password; the audit logs in via
//                               /owner/login (scripts/lib/owner-session.ts)
//                               and uses the session cookie it issues.
//   PDPP_OWNER_TOKEN            owner bearer token (unsupported here — never
//                               sent as Authorization to this cookie-only
//                               route family).
// An origin may also be supplied via PDPP_ACCEPTANCE_ORIGIN.
//
// No record payloads are printed — only connection ids, stream names, classes,
// exact score fields, and the revision receipt.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { StreamHealthFinding } from "./stream-health-audit/authority.ts";
import { runLiveStreamHealthAuthority } from "./stream-health-audit/live.ts";

interface Args {
  expectedRevision: string | null;
  expectedSha: string | null;
  json: boolean;
  origin: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    expectedRevision: process.env.PDPP_EXPECTED_REFERENCE_REVISION?.trim() || null,
    expectedSha: process.env.PDPP_EXPECTED_SHA?.trim() || null,
    json: false,
    origin: null,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--json") {
      args.json = true;
    } else if (a === "--origin") {
      i += 1;
      args.origin = argv[i] ?? null;
    } else if (a?.startsWith("--origin=")) {
      args.origin = a.slice("--origin=".length);
    } else if (a === "--expected-revision") {
      i += 1;
      args.expectedRevision = argv[i] ?? null;
    } else if (a?.startsWith("--expected-revision=")) {
      args.expectedRevision = a.slice("--expected-revision=".length);
    } else if (a === "--expected-sha") {
      i += 1;
      args.expectedSha = argv[i] ?? null;
    } else if (a?.startsWith("--expected-sha=")) {
      args.expectedSha = a.slice("--expected-sha=".length);
    }
    i += 1;
  }
  return args;
}

function renderIssueTable(rows: readonly StreamHealthFinding[]): string {
  const lines = ["connection\tstream\tclass\tscored\treason"];
  for (const item of rows.filter((row) => row.class !== "green")) {
    lines.push(
      `${item.connection_id ?? "<audit>"}\t${item.stream}\t${item.class}\t${item.denominator ? "yes" : "no"}\t${item.reason}`
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const origin = args.origin ?? process.env.PDPP_ACCEPTANCE_ORIGIN ?? null;

  if (!origin) {
    process.stderr.write(
      "stream-health audit: no origin supplied. Pass --origin or set PDPP_ACCEPTANCE_ORIGIN.\n" +
        "For the seeded/local authority regressions, run: node --test --import tsx scripts/stream-health-audit/authority.test.ts\n"
    );
    process.exitCode = 1;
    return;
  }

  const result = await runLiveStreamHealthAuthority({
    expectedRevision: args.expectedRevision,
    expectedSha: args.expectedSha,
    origin,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.fetched) {
    const percentage = result.score.percentage === null ? "n/a" : `${result.score.percentage}%`;
    process.stdout.write(
      `stream-health audit: ${result.status.toUpperCase()} (${result.score.ratio} green production streams, ${percentage}; ${result.connectionCount} owner connection(s); revision ${result.gates.revision})\n`
    );
    if (result.status !== "pass") {
      process.stdout.write(`${renderIssueTable(result.findings)}\n`);
    }
  } else {
    process.stdout.write(
      `stream-health audit: ${result.status.toUpperCase()} — ${result.error ?? "live evidence was not fetched"}\n`
    );
    process.stdout.write(`${renderIssueTable(result.findings)}\n`);
  }

  process.exitCode = result.ok ? 0 : 1;
}

// Only run when invoked directly, so tests can import the modules without
// triggering a process exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
