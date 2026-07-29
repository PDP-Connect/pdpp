#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// CLI wrapper around suite-completion.ts's runSuiteToCompletion(). Answers,
// mechanically, whether the reference-implementation test suite actually
// completed on the current worktree state -- see suite-completion.ts for the
// verdict contract this prints.
//
// Usage:
//   node --import tsx scripts/ri-suite/completion-oracle.ts
//   node --import tsx scripts/ri-suite/completion-oracle.ts --sha <commit>
//   node --import tsx scripts/ri-suite/completion-oracle.ts --timeout-ms 600000
//   node --import tsx scripts/ri-suite/completion-oracle.ts --json out.json
//
// --sha checks out the requested commit into a disposable git worktree
// (never touches the caller's working tree) so the same question -- "did
// the suite complete, and what was the outcome set" -- can be asked of an
// arbitrary commit, including a pristine base predating any fix this lane
// made. Omit --sha to run against the current worktree as-is.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { type CompletionVerdict, type RunSuiteOptions, runSuiteToCompletion } from "./suite-completion.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface CliArgs {
  extraArgs: string[];
  json?: string;
  sha?: string;
  timeoutMs?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { extraArgs: [] };
  const take = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sha") {
      result.sha = take(index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = take(index, arg);
      index += 1;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--timeout-ms requires a positive integer, got ${value}`);
      }
      result.timeoutMs = parsed;
    } else if (arg === "--json") {
      result.json = take(index, arg);
      index += 1;
    } else if (arg === "--") {
      result.extraArgs.push(...argv.slice(index + 1));
      break;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return result;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A `--sha` run clones a full worktree and runs `pnpm install` (native
 * builds included), which is a "build tree", not a scratch text fixture --
 * the wrong shape for a RAM-backed tmpfs (`os.tmpdir()` resolves to `/tmp`
 * on this host's default profile). Prefer a disk-backed scratch root
 * (`~/.tmp`, the convention this environment already uses for exactly this
 * purpose) when it exists, and only fall back to `os.tmpdir()` when it does
 * not -- e.g. a CI image without a seeded home directory.
 */
function scratchRoot(): string {
  const diskBacked = join(homedir(), ".tmp");
  return existsSync(diskBacked) ? diskBacked : tmpdir();
}

/**
 * Prepare a disposable git worktree pinned at `sha` and run `pnpm install`
 * in it, so the oracle can be pointed at any commit -- including one that
 * predates fixes this lane made -- without mutating the caller's own
 * worktree. Always cleaned up, even on failure.
 */
async function withCommitWorktree<T>(sha: string, fn: (riRoot: string) => Promise<T>): Promise<T> {
  const resolvedSha = git(["rev-parse", sha], REPO_ROOT);
  const worktreeDir = mkdtempSync(join(scratchRoot(), "pdpp-ri-suite-oracle-"));
  // mkdtemp'd dir already exists; `git worktree add` requires the target
  // not to exist, so nest one level.
  const target = join(worktreeDir, "wt");
  try {
    git(["worktree", "add", "--detach", target, resolvedSha], REPO_ROOT);
    try {
      execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: target, stdio: "inherit" });
      return await fn(join(target, "reference-implementation"));
    } finally {
      try {
        git(["worktree", "remove", "--force", target], REPO_ROOT);
      } catch (err) {
        process.stderr.write(
          `[completion-oracle] WARN: could not remove worktree ${target}: ${(err as Error).message}\n`
        );
      }
    }
  } finally {
    rmSync(worktreeDir, { recursive: true, force: true });
  }
}

function printVerdict(verdict: CompletionVerdict): void {
  const {
    status,
    durationMs,
    exitCode,
    signal,
    oracleTimedOut,
    runnerCrashed,
    missingFiles,
    unexpectedFiles,
    totals,
    completedFiles,
    malformedEventLines,
  } = verdict;
  const seconds = (durationMs / 1000).toFixed(1);
  process.stdout.write(`\nstatus: ${status}\n`);
  process.stdout.write(`duration: ${seconds}s\n`);
  process.stdout.write(`exit_code: ${exitCode ?? "(none -- process did not exit on its own)"}\n`);
  process.stdout.write(`signal: ${signal ?? "(none)"}\n`);
  process.stdout.write(`oracle_killed_child: ${oracleTimedOut}\n`);
  process.stdout.write(
    `runner_crashed: ${runnerCrashed}${runnerCrashed ? "  <- run-tests.js itself threw an uncaught exception; its own totals were never computed, this oracle's totals below are its own independent re-parse" : ""}\n`
  );
  process.stdout.write(`files_completed: ${completedFiles.length}\n`);
  process.stdout.write(
    `files_missing: ${missingFiles.length}${missingFiles.length ? ` -> ${missingFiles.join(", ")}` : ""}\n`
  );
  process.stdout.write(
    `files_unexpected: ${unexpectedFiles.length}${unexpectedFiles.length ? ` -> ${unexpectedFiles.join(", ")}` : ""}\n`
  );
  process.stdout.write(`malformed_event_lines: ${malformedEventLines}\n`);
  process.stdout.write(
    `assertions: ${totals.assertions}  passed: ${totals.passed}  failed: ${totals.failed}  skipped: ${totals.skipped}\n`
  );
  if (status !== "completed-all-green") {
    const failing = verdict.perFile.filter((f) => f.failed > 0);
    if (failing.length > 0) {
      process.stdout.write("\nfailing files:\n");
      for (const f of failing) {
        process.stdout.write(`  ${f.relPath}: ${f.failed} failed / ${f.passed} passed / ${f.skipped} skipped\n`);
      }
    }
  }
}

function optionsFor(riRoot: string, args: CliArgs): RunSuiteOptions {
  return {
    riRoot,
    extraArgs: args.extraArgs,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const verdict = args.sha
    ? await withCommitWorktree(args.sha, (riRoot) => runSuiteToCompletion(optionsFor(riRoot, args)))
    : await runSuiteToCompletion(optionsFor(join(REPO_ROOT, "reference-implementation"), args));

  printVerdict(verdict);
  if (args.json) {
    await writeFile(args.json, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
    process.stdout.write(`\nwrote ${args.json}\n`);
  }

  process.exit(verdict.status === "completed-all-green" ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
