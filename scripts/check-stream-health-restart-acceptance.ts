#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Controlled-restart acceptance for the stream-health receipt
// (BANNER-ZERO-PLAN.md workstream B: "add a controlled-restart acceptance
// scenario").
//
// This harness does NOT own restart mechanics for any deployment target — it
// takes the restart as an operator-supplied shell command (docker compose
// restart, a Railway CLI restart, a Fly.io machine restart, whatever the
// actual deploy owner already uses) and treats it as an opaque, external step.
// This script is read-only with respect to the retained instance itself: it
// runs the SAME acceptance receipt (scripts/check-stream-health-receipt.ts)
// before and after that one restart, waits for the origin to become reachable
// again, and asserts the result is the same acceptance outcome — not a
// weaker one. It does not restart anything unless a command was
// explicitly supplied by the invoker.
//
// Usage:
//   node scripts/check-stream-health-restart-acceptance.ts \
//     --origin https://pdpp.example.com \
//     --restart-command "docker compose restart reference"
//
// Exit code is non-zero if either receipt fails to pass, or if the
// post-restart receipt regresses relative to the pre-restart receipt (fewer
// green streams, a banner that was quiet before and is not quiet after, or
// newly unsettled projections that were settled before).
//
// Live owner auth is read from the environment exactly as
// check-stream-health-receipt.ts documents.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  checkRestartForRegression,
  type RestartRegressionCheck,
  runStreamHealthReceipt,
  type StreamHealthReceipt,
} from "./stream-health-audit/receipt.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WAIT_TIMEOUT_MS = 120_000;
const WAIT_POLL_MS = 1000;

interface Args {
  expectedRevision: string | null;
  expectedSha: string | null;
  json: boolean;
  origin: string | null;
  report: boolean;
  restartCommand: string | null;
}

const VALUE_FLAGS: ReadonlyArray<{
  flag: string;
  key: "expectedRevision" | "expectedSha" | "origin" | "restartCommand";
}> = [
  { flag: "--origin", key: "origin" },
  { flag: "--restart-command", key: "restartCommand" },
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
    restartCommand: process.env.PDPP_RESTART_COMMAND?.trim() || null,
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

function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/** Run the operator-supplied restart command to completion. Rejects on non-zero exit. */
function runRestartCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`restart command exited with code ${code}`));
      }
    });
  });
}

/** Poll the origin until it answers, or throw after WAIT_TIMEOUT_MS. */
async function waitForOrigin(origin: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: this is a bounded readiness poll after a restart; each check must wait for the previous one to resolve before deciding whether to poll again.
      const res = await fetch(origin, { redirect: "manual" });
      if (res.status < 500) {
        return;
      }
    } catch {
      // The process may still be restarting; keep polling until the deadline.
    }
    if (Date.now() >= deadline) {
      throw new Error(`origin did not become reachable within ${WAIT_TIMEOUT_MS}ms after restart`);
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}

function renderMarkdown(
  before: StreamHealthReceipt,
  after: StreamHealthReceipt,
  regressions: readonly RestartRegressionCheck[]
): string {
  const lines: string[] = [
    "# Controlled-restart acceptance",
    "",
    `Origin: ${before.origin}`,
    `Pre-restart:  ${before.generatedAt} — ${before.ok ? "PASS" : "FAIL"} (${before.authority.score.ratio}, banner=${before.fleetHealth.state ?? "<unresolved>"})`,
    `Post-restart: ${after.generatedAt} — ${after.ok ? "PASS" : "FAIL"} (${after.authority.score.ratio}, banner=${after.fleetHealth.state ?? "<unresolved>"})`,
    "",
    "## Regression checks",
    "",
  ];
  for (const check of regressions) {
    lines.push(`- ${check.regressed ? "REGRESSED" : "ok"}: ${check.rule} (${check.detail})`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const origin = args.origin ?? process.env.PDPP_ACCEPTANCE_ORIGIN ?? null;

  if (!origin) {
    process.stderr.write(
      "controlled-restart acceptance: no origin supplied. Pass --origin or set PDPP_ACCEPTANCE_ORIGIN.\n"
    );
    process.exitCode = 1;
    return;
  }
  if (!args.restartCommand) {
    process.stderr.write(
      "controlled-restart acceptance: no restart command supplied. Pass --restart-command or set PDPP_RESTART_COMMAND.\n" +
        "This harness never restarts anything on its own — the restart mechanism belongs to the deploy owner (docker compose, Railway CLI, etc.).\n"
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`[1/4] pre-restart receipt against ${origin} ...\n`);
  const before = await runStreamHealthReceipt({
    expectedRevision: args.expectedRevision,
    expectedSha: args.expectedSha,
    origin,
  });
  process.stdout.write(
    `      ${before.ok ? "PASS" : "FAIL"} (${before.authority.score.ratio}, banner=${before.fleetHealth.state ?? "<unresolved>"})\n`
  );

  process.stdout.write("[2/4] running restart command ...\n");
  await runRestartCommand(args.restartCommand);

  process.stdout.write("[3/4] waiting for origin to become reachable ...\n");
  await waitForOrigin(origin);

  process.stdout.write(`[4/4] post-restart receipt against ${origin} ...\n`);
  const after = await runStreamHealthReceipt({
    expectedRevision: args.expectedRevision,
    expectedSha: args.expectedSha,
    origin,
  });
  process.stdout.write(
    `      ${after.ok ? "PASS" : "FAIL"} (${after.authority.score.ratio}, banner=${after.fleetHealth.state ?? "<unresolved>"})\n`
  );

  const regressions = checkRestartForRegression(before, after);
  const hasRegression = regressions.some((check) => check.regressed);
  const ok = after.ok && !hasRegression;

  let reportPath: string | null = null;
  if (args.report) {
    const dir = path.join(REPO_ROOT, "tmp", "workstreams");
    await mkdir(dir, { recursive: true });
    reportPath = path.join(dir, `stream-health-restart-acceptance-${fileStamp(after.generatedAt)}.md`);
    await writeFile(reportPath, renderMarkdown(before, after, regressions), "utf8");
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok, before, after, regressions }, null, 2)}\n`);
  } else {
    process.stdout.write(`\ncontrolled-restart acceptance: ${ok ? "PASS" : "FAIL"}\n`);
    for (const check of regressions.filter((c) => c.regressed)) {
      process.stdout.write(`  REGRESSED: ${check.rule} (${check.detail})\n`);
    }
    if (reportPath) {
      process.stdout.write(`report: ${path.relative(REPO_ROOT, reportPath)}\n`);
    }
  }

  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
